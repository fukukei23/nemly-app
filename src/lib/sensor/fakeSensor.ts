/**
 * FakeSensor: 合成振幅系列の生成器（A′ 二段構えの第1段）
 *
 * 責務: 正常/欠損/DEGRADED/定常の系列を作り・JS 側パイプライン
 * （pull→検証→判定→解析）をネイティブ無しで TDD できるようにする。
 * 検証範囲は保存/解析/表示のみ（FGS lifecycle は実機統合テストの管轄・spec §10）
 */
import type { SensorSample, GapInterval } from "./types";

const STEP_MS = 10_000;

export interface FakeSeriesOptions {
  startMs: number;
  windows: number;
  pattern?: "normal" | "stationary";
  gapWindows?: number[]; // 行を作らない窓index
  degradedWindows?: number[]; // quality=1 の窓index
}

export interface FakeSeriesResult {
  samples: SensorSample[];
  gaps: GapInterval[];
  validRatio: number;
}

export function generateSyntheticSeries(opts: FakeSeriesOptions): FakeSeriesResult {
  const gaps = new Set(opts.gapWindows ?? []);
  const degraded = new Set(opts.degradedWindows ?? []);
  const samples: SensorSample[] = [];
  // 隣接する欠損窓は1区間へマージする（実経路 summarizeQuality がサンプル差分から
  // 連続欠損を1区間として列挙するのと同一挙動・そうしないと failCheck の
  // long_gap（20分連続）判定が隣接欠損で発火しない）
  const gapIntervals: GapInterval[] = [];
  let openGap: GapInterval | null = null;
  for (let i = 0; i < opts.windows; i++) {
    const tsMs = opts.startMs + i * STEP_MS;
    if (gaps.has(i)) {
      if (openGap) {
        openGap.end = tsMs + STEP_MS;
      } else {
        openGap = { start: tsMs, end: tsMs + STEP_MS };
        gapIntervals.push(openGap);
      }
      continue;
    }
    openGap = null;
    const amplitude =
      opts.pattern === "stationary"
        ? 0.001 + (i % 3) * 0.001
        : 0.08 + ((i * 37) % 100) / 1000;
    samples.push({
      tsMs,
      amplitude,
      quality: degraded.has(i) ? 1 : 0,
      eventCount: 500,
    });
  }
  const validRatio = opts.windows === 0 ? 1 : samples.length / opts.windows;
  return { samples, gaps: gapIntervals, validRatio };
}
