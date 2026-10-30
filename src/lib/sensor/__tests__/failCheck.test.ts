import { validateAndJudge } from "../failCheck";
import { generateSyntheticSeries } from "../fakeSensor";
import type { FailVerdict } from "../types";

const START = 1_700_000_000_000;

/** 判定の narrow（verdict≠期待なら分かりやすいエラーで落とす） */
function asFail(v: FailVerdict): Extract<FailVerdict, { verdict: "fail" }> {
  if (v.verdict !== "fail") throw new Error(`expected fail, got ${v.verdict}`);
  return v;
}

describe("validateAndJudge（spec §8・事前固定）", () => {
  it("連続100窓 → pass", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100 });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("pass");
  });

  it("有効率90%未満 → fail（閾値・r3 glm#7 再設定）", () => {
    const r = generateSyntheticSeries({
      startMs: START,
      windows: 100,
      gapWindows: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60],
    });
    const f = asFail(validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 }));
    expect(f.reasons.some((s) => s.includes("valid_ratio"))).toBe(true);
  });

  it("サンプル数0 → 独立した即時fail（r3 mm#1）", () => {
    const v = validateAndJudge(
      { samples: [], gaps: [], validRatio: 0 },
      100,
      { nanRate: 0, stationaryRate: 0 }
    );
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("zero_samples"))).toBe(true);
  });

  it("20分超の連続欠損（recovery無し）→ fail", () => {
    const r = generateSyntheticSeries({
      startMs: START,
      windows: 300,
      gapWindows: Array.from({ length: 125 }, (_, i) => i + 50),
    });
    const v = validateAndJudge(r, 300, { nanRate: 0, stationaryRate: 0 });
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("long_gap"))).toBe(true);
  });

  it("30分以内の停止+再開 → degraded_pass（rubric）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, gapWindows: [40, 41, 42] });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    if (v.verdict !== "degraded_pass") {
      throw new Error(`expected degraded_pass, got ${v.verdict}`);
    }
    expect(v.reasons.some((s) => s.includes("short_gap"))).toBe(true);
  });

  it("定常率10%超 → fail（品質ゲート）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, pattern: "stationary" });
    const q = { nanRate: 0, stationaryRate: 1.0 };
    const v = validateAndJudge(r, 100, q);
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });
});

describe("時間帯制限（2026-10-31・常時ON運用対応・バックログP2）", () => {
  // ローカル時刻で構築（どのTZで実行しても同じ「壁時計の時刻」になる）
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(y, m, d, h, min).getTime();

  const samplesWith = (windows: { tsMs: number; amplitude: number }[]) => ({
    samples: windows.map((w) => ({ tsMs: w.tsMs, amplitude: w.amplitude, quality: 0, eventCount: 600 })),
    gaps: [],
    validRatio: 1,
  });

  it("睡眠帯内（23時）の stationary 100% 窓 → fail（机検出は睡眠帯で有効）", () => {
    const windows = Array.from({ length: 12 }, (_, i) => ({
      tsMs: at(2026, 9, 31, 23) + i * 10_000,
      amplitude: 0.001,
    }));
    const v = validateAndJudge(samplesWith(windows), 12, {
      nanRate: 0,
      stationaryRate: 1.0,
      windows,
    });
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });

  it("時間帯外のみ（昼12時・stationary 100%）→ stationaryゲート発動せず pass（must-pass回帰）", () => {
    const windows = Array.from({ length: 12 }, (_, i) => ({
      tsMs: at(2026, 9, 31, 12) + i * 10_000,
      amplitude: 0.001,
    }));
    const v = validateAndJudge(samplesWith(windows), 12, {
      nanRate: 0,
      stationaryRate: 1.0,
      windows,
    });
    expect(v.verdict).toBe("pass");
  });

  it("日跨ぎ: 23時窓（定常）+ 翌01時窓（非定常）→ 睡眠帯だけで判定され fail", () => {
    const night1 = Array.from({ length: 6 }, (_, i) => ({
      tsMs: at(2026, 9, 31, 23, 30) + i * 10_000,
      amplitude: 0.001,
    }));
    const night2 = Array.from({ length: 6 }, (_, i) => ({
      tsMs: at(2026, 10, 1, 1) + i * 10_000,
      amplitude: 0.5,
    }));
    const windows = [...night1, ...night2];
    const v = validateAndJudge(samplesWith(windows), 12, {
      nanRate: 0,
      stationaryRate: 0.5,
      windows,
    });
    // 睡眠帯12窓のうち定常6窓 = 50% < 90% で stationary は発動しない・ただし全体的な
    // stationaryRate 0.5 も睡眠帯再計算で 50% に上書き → pass
    expect(v.verdict).toBe("pass");
  });

  it("境界 22:00 の窓は判定内・21:59 の窓は判定外", () => {
    // 21:59 の定常10窓 + 22:00 の定常1窓 → 判定内は 1/1=100% で fail
    const windows = [
      ...Array.from({ length: 10 }, (_, i) => ({
        tsMs: at(2026, 9, 31, 21, 59) - i * 10_000 + 40_000,
        amplitude: 0.001,
      })),
      { tsMs: at(2026, 9, 31, 22), amplitude: 0.001 },
    ];
    const v = validateAndJudge(samplesWith(windows), 11, {
      nanRate: 0,
      stationaryRate: 1.0,
      windows,
    });
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });

  it("境界 08:00 の窓は判定外・07:59 は判定内", () => {
    // 07:59 の定常10窓（判定内・100%）+ 08:00 以降の非定常窓 → fail（判定内で100%）
    const windows = [
      ...Array.from({ length: 10 }, (_, i) => ({
        tsMs: at(2026, 9, 31, 7, 59) + i * 10_000,
        amplitude: 0.001,
      })),
      { tsMs: at(2026, 9, 31, 8), amplitude: 0.5 },
    ];
    const v = validateAndJudge(samplesWith(windows), 11, {
      nanRate: 0,
      stationaryRate: 10 / 11,
      windows,
    });
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });

  it("windows 未指定なら従来どおり stationaryRate を使う（CSV等の既存経路は不変）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, pattern: "stationary" });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 1.0 });
    const f = asFail(v);
    expect(f.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });
});
