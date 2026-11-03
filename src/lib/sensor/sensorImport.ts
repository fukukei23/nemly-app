/**
 * sensorImport: センサー系列の取り込みパイプライン（spec §10 段階1）
 *
 * pull → 連続性検証 → fail判定（§8）→ pass/degraded のみ解析+保存
 * → ネイティブ側 purge（成功確認後）。fail は保存せず verdict を返す
 * （session を immutable failed として扱う・自動再試行なし）。
 */
import { analyzeSleep } from "@/lib/csvImport";
import { insertSession } from "@/lib/repository";
import { summarizeQuality } from "./windowAggregator";
import { validateAndJudge } from "./failCheck";
import type { SensorSample, SeriesMeta } from "./types";

/** ネイティブ bridge の契約（nemly-sensor モジュールがこの形を返す） */
export interface SensorSeriesSource {
  pullSeries(): Promise<{ samples: SensorSample[]; meta: SeriesMeta }>;
  confirmImported(sessionId: string): Promise<void>;
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

  // 空系列=既に取り込み済み（samples purge 済みで finished 行だけ残存するケース・2026-11-03）。
  // pending 掃除だけして沈黙終了（ダイアログを出さない・sessionId=null 判定で呼び出し側が区別する）
  if (samples.length === 0) {
    await source.confirmImported(meta.sessionId);
    return { verdict: "pass", reasons: ["empty"], sessionId: null };
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
    // 2026-11-03 変更: fail でもネイティブからは purge する（起動時取り込みが
    // pending を毎回検知してダイアログが無限表示になるのを防ぐ・purgeSession は
    // samples+native_sessions の両方を消す）。fail セッションの保持ポリシー
    //（fail 一覧可視化・再 import）はバックログ d0e3 で別途設計する
    await source.confirmImported(meta.sessionId);
    return { verdict: "fail", reasons: verdict.reasons, sessionId: null };
  }

  const analysis = analyzeSleep(
    samples.map((s) => ({ ts: s.tsMs, amp: s.amplitude }))
  );
  const sessionId = await insertSession(
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
    },
    analysis.stages
  );
  await source.confirmImported(meta.sessionId);
  return {
    verdict: verdict.verdict,
    reasons: verdict.verdict === "degraded_pass" ? verdict.reasons : [],
    sessionId,
  };
}
