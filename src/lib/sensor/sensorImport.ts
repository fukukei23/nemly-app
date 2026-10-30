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
