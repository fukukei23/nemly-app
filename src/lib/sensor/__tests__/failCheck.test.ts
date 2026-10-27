import { validateAndJudge } from "../failCheck";
import { generateSyntheticSeries } from "../fakeSensor";

const START = 1_700_000_000_000;

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
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("valid_ratio"))).toBe(true);
  });

  it("サンプル数0 → 独立した即時fail（r3 mm#1）", () => {
    const v = validateAndJudge(
      { samples: [], gaps: [], validRatio: 0 },
      100,
      { nanRate: 0, stationaryRate: 0 }
    );
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("zero_samples"))).toBe(true);
  });

  it("20分超の連続欠損（recovery無し）→ fail", () => {
    const r = generateSyntheticSeries({
      startMs: START,
      windows: 300,
      gapWindows: Array.from({ length: 125 }, (_, i) => i + 50),
    });
    const v = validateAndJudge(r, 300, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("long_gap"))).toBe(true);
  });

  it("30分以内の停止+再開 → degraded_pass（rubric）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, gapWindows: [40, 41, 42] });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("degraded_pass");
    expect(v.reasons.some((s) => s.includes("short_gap"))).toBe(true);
  });

  it("定常率10%超 → fail（品質ゲート）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, pattern: "stationary" });
    const q = { nanRate: 0, stationaryRate: 1.0 };
    const v = validateAndJudge(r, 100, q);
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });
});
