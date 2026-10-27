import { generateSyntheticSeries } from "../fakeSensor";

const START = 1_700_000_000_000; // 10秒境界に調整された値を使う

describe("generateSyntheticSeries", () => {
  it("normal: 60窓の連続系列（ts=窓開始・10秒刻み・quality=0）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 60 });
    expect(r.samples).toHaveLength(60);
    expect(r.samples[0]!.tsMs).toBe(START);
    expect(r.samples[1]!.tsMs - r.samples[0]!.tsMs).toBe(10_000);
    expect(r.samples.every((s) => s.quality === 0)).toBe(true);
    expect(r.gaps).toHaveLength(0);
    expect(r.validRatio).toBeCloseTo(1);
  });

  it("gaps 指定窓は行が無く gap として列挙される", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 10, gapWindows: [3, 4] });
    expect(r.samples).toHaveLength(8);
    expect(r.gaps).toEqual([{ start: START + 30_000, end: START + 50_000 }]);
    expect(r.validRatio).toBeCloseTo(0.8);
  });

  it("degraded: quality=1 の窓を作れる", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 5, degradedWindows: [1] });
    expect(r.samples[1]!.quality).toBe(1);
    expect(r.samples.filter((s) => s.quality === 0)).toHaveLength(4);
  });

  it("stationary: ほぼゼロ振幅（品質ゲートの定常検知テスト用）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 5, pattern: "stationary" });
    expect(r.samples.every((s) => s.amplitude < 0.05)).toBe(true);
  });
});
