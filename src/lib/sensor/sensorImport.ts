/**
 * sensorImport: センサー系列の取り込みパイプライン（spec §10 段階1 + §2/§6 kill復旧）
 *
 * pull → claim（markImporting・CAS）→ 連続性検証 → fail判定（§8）→ pass/degraded のみ
 * 解析+保存 → ネイティブ側 CAS purge（成功確認後）。fail は markImportFailed で
 * status=import_failed に遷移し回収対象外になる（session は immutable failed・自動再試行なし）。
 *
 * kill 復旧（spec §6 重複防止3層）:
 * - claim（markImporting・WHERE status IN ('finished','importing')）が import 前後の
 *   二重実行を弾き・kill で importing 残留しても次回起動の回収で claim が拾う
 * - insert 後 kill（UI DB に入ったが native 未 purge）は native_session_id 事前照合で
 *   already-imported 判定し二重登録を防ぐ（①）
 * - UNIQUE index は schema 防御層（③・race 時は repository が DuplicateNativeSessionError に正規化）
 */
import { analyzeSleep } from "@/lib/csvImport";
import {
  DuplicateNativeSessionError,
  getSessionByNativeId,
  insertSession,
} from "@/lib/repository";
import { summarizeQuality } from "./windowAggregator";
import { validateAndJudge } from "./failCheck";
import type { SensorSample, SeriesMeta } from "./types";

/** ネイティブ bridge の契約（nemly-sensor モジュールがこの形を返す） */
export interface SensorSeriesSource {
  pullSeries(): Promise<{ samples: SensorSample[]; meta: SeriesMeta }>;
  /** claim（CAS）: WHERE status IN ('finished','importing') の UPDATE 行数 1 で true */
  markImporting(sessionId: string): Promise<boolean>;
  /** import 完了（CAS）: WHERE status IN ('finished','importing') → imported + samples delete */
  confirmImported(sessionId: string): Promise<boolean>;
  /** import 失敗（CAS）: WHERE status IN ('importing','finished') → import_failed */
  markImportFailed(sessionId: string): Promise<boolean>;
}

export interface SensorImportResult {
  verdict: "pass" | "degraded_pass" | "fail";
  reasons: string[];
  sessionId: number | null;
}

export async function importSensorSession(
  source: SensorSeriesSource
): Promise<SensorImportResult> {
  const { samples, meta } = await source.pullSeries();

  // claim（spec §6 回収の claim transaction 排他を兼ねる）。
  // 失敗=他が担当中 or 既に imported/import_failed = 回収不要
  const claimed = await source.markImporting(meta.sessionId);
  if (!claimed) {
    return { verdict: "pass", reasons: ["claimed-by-other"], sessionId: null };
  }

  try {
    // 空系列=既に取り込み済み（samples purge 済みで finished/importing 行だけ残存するケース・
    // 2026-11-03）。pending 掃除だけして沈黙終了（ダイアログを出さない・sessionId=null 判定で
    // 呼び出し側が区別する）
    if (samples.length === 0) {
      await source.confirmImported(meta.sessionId);
      return { verdict: "pass", reasons: ["empty"], sessionId: null };
    }

    // spec §6①事前照合: insert 後 kill（UI DB に保存済み・native 未 purge）の次回回収で
    // 解析+insert をやり直さず既存行を採用する（二重登録防止の一次層）
    const existingId = await getSessionByNativeId(meta.sessionId);
    if (existingId !== null) {
      await source.confirmImported(meta.sessionId);
      return {
        verdict: "pass",
        reasons: ["already-imported"],
        sessionId: existingId,
      };
    }

    const expectedWindows = Math.max(
      0,
      Math.round((meta.endedAtMs - meta.startedAtMs) / 10_000)
    );
    const summary = summarizeQuality(samples, expectedWindows);
    const verdict = validateAndJudge(
      { samples, gaps: summary.gaps, validRatio: summary.validRatio },
      expectedWindows,
      {
        nanRate: summary.nanRate,
        stationaryRate: summary.stationaryRate,
        windows: samples.map((s) => ({ tsMs: s.tsMs, amplitude: s.amplitude })),
      }
    );

    if (verdict.verdict === "fail") {
      // spec §2: fail は markImportFailed（status=import_failed・回収対象外・samples 保持）。
      // 起動時取り込みの無限 pending は status 遷移で防止（import_failed は claim 対象外）。
      // fail セッションの samples purge ポリシーは L175 論点（別途判断）
      await source.markImportFailed(meta.sessionId);
      return { verdict: "fail", reasons: verdict.reasons, sessionId: null };
    }

    const analysis = analyzeSleep(
      samples.map((s) => ({ ts: s.tsMs, amp: s.amplitude }))
    );
    let sessionId: number;
    try {
      sessionId = await insertSession(
        {
          startMs: analysis.startMs,
          endMs: analysis.endMs,
          sampleCount: analysis.sampleCount,
          deepRatio: analysis.deepRatio,
          lightRatio: analysis.lightRatio,
          remRatio: analysis.remRatio,
          awakeRatio: analysis.awakeRatio,
          score: analysis.score,
          source: "sensor",
          createdAt: new Date().toISOString(),
          validRatio: summary.validRatio,
          gapCount: summary.gaps.length,
          endReason: meta.endReason,
          nativeSessionId: meta.sessionId,
        },
        analysis.stages
      );
    } catch (e) {
      if (e instanceof DuplicateNativeSessionError) {
        // spec §6③UNIQUE 防御層: race 時は already-imported 判定で冪等回収
        await source.confirmImported(meta.sessionId);
        const racedId = await getSessionByNativeId(meta.sessionId);
        return {
          verdict: "pass",
          reasons: ["already-imported"],
          sessionId: racedId,
        };
      }
      throw e;
    }
    await source.confirmImported(meta.sessionId);
    return {
      verdict: verdict.verdict,
      reasons: verdict.verdict === "degraded_pass" ? verdict.reasons : [],
      sessionId,
    };
  } catch (e) {
    // spec §2: import 処理の catch 全体で markImportFailed（status=import_failed・
    // 回収対象外へ明示遷移）。kill で catch も通らず死んだ場合は importing 残留→
    // 次回起動の回収（claim の WHERE finished/importing）が拾う
    await source.markImportFailed(meta.sessionId);
    throw e;
  }
}
