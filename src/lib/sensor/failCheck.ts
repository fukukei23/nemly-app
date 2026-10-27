/**
 * spec §8 の fail判定（事前固定）
 *
 * 判定はこの関数のみで行う（実装者の裁量裁定を禁止するため）。
 * fail 確定後は session を immutable failed として扱い・自動再試行はしない。
 */
import type { FailVerdict, GapInterval } from "./types";

const MIN_VALID_RATIO = 0.9; // r3 glm#7 で 60%→90%（実機1時間段で校正）
const LONG_GAP_MS = 20 * 60_000; // 20分超の連続欠損
const MAX_STATIONARY_RATE = 0.1;
const MAX_NAN_RATE = 0.01;

export function validateAndJudge(
  series: { samples: unknown[]; gaps: GapInterval[]; validRatio: number },
  expectedWindows: number,
  quality: { nanRate: number; stationaryRate: number }
): FailVerdict {
  const reasons: string[] = [];
  if (series.samples.length === 0) {
    return {
      verdict: "fail",
      reasons: ["zero_samples: 記録が1件も無い（r3 mm#1）"],
    };
  }
  if (series.validRatio < MIN_VALID_RATIO) {
    reasons.push(
      `valid_ratio: ${(series.validRatio * 100).toFixed(1)}% < ${MIN_VALID_RATIO * 100}%`
    );
  }
  for (const g of series.gaps) {
    const durMs = g.end - g.start;
    if (durMs > LONG_GAP_MS) {
      reasons.push(
        `long_gap: ${Math.round(durMs / 60_000)}分の連続欠損（recovery記録なし）`
      );
    } else if (durMs > 0) {
      reasons.push(`short_gap: ${Math.round(durMs / 60_000)}分（条件付き許容・rubric）`);
    }
  }
  if (quality.stationaryRate > MAX_STATIONARY_RATE) {
    reasons.push(
      `stationary_rate: ${(quality.stationaryRate * 100).toFixed(1)}% > ${MAX_STATIONARY_RATE * 100}%`
    );
  }
  if (quality.nanRate > MAX_NAN_RATE) {
    reasons.push(`nan_rate: ${(quality.nanRate * 100).toFixed(2)}% > ${MAX_NAN_RATE * 100}%`);
  }

  if (reasons.length === 0) return { verdict: "pass" };
  const hardFail = reasons.some((r) => r.startsWith("long_gap"));
  if (hardFail) return { verdict: "fail", reasons };
  // valid_ratio / short_gap / 品質ゲートのみの違反は fail（short_gap 単独なら degraded）
  const onlyShortGap = reasons.every((r) => r.startsWith("short_gap"));
  if (onlyShortGap) return { verdict: "degraded_pass", reasons };
  return { verdict: "fail", reasons };
}
