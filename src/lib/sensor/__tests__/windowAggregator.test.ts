import { computeWindows, summarizeQuality } from "../windowAggregator";
import vector from "../goldenVector.json";

describe("computeWindows（spec §5 数式の参照実装）", () => {
  it("20Hz・30秒の合成列 → 3窓（ts=窓開始・eventCount=200）", () => {
    const events = (vector as any).events.map((e: any) => ({
      epochMs: Math.round(e.tSec * 1000),
      x: e.x,
      y: e.y,
      z: e.z,
    }));
    const r = computeWindows(events, 0);
    expect(r).toHaveLength(3);
    expect(r[0]!.tsMs).toBe(0);
    expect(r[0]!.eventCount).toBe(200);
    expect(r.every((w) => w.quality === 0)).toBe(true);
    // 振幅は正の有限値（重力が除かれた運動成分の平均）
    expect(r.every((w) => Number.isFinite(w.amplitude) && w.amplitude >= 0)).toBe(true);
  });

  it("イベント0個の窓は行を作らない（欠損窓）", () => {
    const events = [
      { epochMs: 0, x: 0, y: 0, z: 9.8 },
      { epochMs: 25_000, x: 0, y: 0, z: 9.8 },
    ];
    const r = computeWindows(events, 0, 30_000);
    expect(r).toHaveLength(2); // 窓0と窓2・窓1は欠損
    expect(r[0]!.tsMs).toBe(0);
    expect(r[1]!.tsMs).toBe(20_000);
  });

  it("無効値（NaN・‖a‖>100）は窓に数えない", () => {
    const events = [
      { epochMs: 0, x: NaN, y: 0, z: 9.8 },
      { epochMs: 500, x: 0, y: 0, z: 999 },
      { epochMs: 1000, x: 0, y: 0, z: 9.8 },
    ];
    const r = computeWindows(events, 0, 10_000);
    expect(r[0]!.eventCount).toBe(1);
  });

  it("summarizeQuality: 定常率と有効窓率を数える", () => {
    const windows = [
      { tsMs: 0, amplitude: 0.001, quality: 0 as const, eventCount: 500 },
      { tsMs: 10_000, amplitude: 0.5, quality: 0 as const, eventCount: 500 },
    ];
    const q = summarizeQuality(windows, 2);
    expect(q.stationaryRate).toBeCloseTo(0.5);
    expect(q.validRatio).toBeCloseTo(1);
    expect(q.nanRate).toBe(0);
    expect(q.gaps).toHaveLength(0);
  });

  it("summarizeQuality: 欠損区間を1区間として列挙（隣接マージ）", () => {
    const windows = [
      { tsMs: 0, amplitude: 0.5, quality: 0 as const, eventCount: 500 },
      { tsMs: 30_000, amplitude: 0.5, quality: 0 as const, eventCount: 500 },
    ];
    const q = summarizeQuality(windows, 3);
    expect(q.gaps).toEqual([{ start: 10_000, end: 30_000 }]);
    expect(q.validRatio).toBeCloseTo(2 / 3);
  });
});
