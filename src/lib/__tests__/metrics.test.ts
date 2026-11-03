import { formatSleepDuration, formatRatioPercent } from "../metrics";

describe("formatSleepDuration", () => {
  it("219分 → 3:39（実販の睡眠時間表示と同形式）", () => {
    expect(formatSleepDuration(219)).toBe("3:39");
  });

  it("0分 → 0:00", () => {
    expect(formatSleepDuration(0)).toBe("0:00");
  });

  it("60分 → 1:00", () => {
    expect(formatSleepDuration(60)).toBe("1:00");
  });

  it("481分 → 8:01（1時間超の繰り上がり）", () => {
    expect(formatSleepDuration(481)).toBe("8:01");
  });
});

describe("formatRatioPercent", () => {
  it("0.29 → 29%（四捨五入）", () => {
    expect(formatRatioPercent(0.29)).toBe("29%");
  });

  it("undefined → --（csv セッションの効率など欠損値）", () => {
    expect(formatRatioPercent(undefined)).toBe("--");
  });

  it("0 → 0%（0は欠損でなく実測0・-- にしない）", () => {
    expect(formatRatioPercent(0)).toBe("0%");
  });

  it("2/7 → 29%（実データは n/N の割合・28.57% は四捨五入で 29）", () => {
    expect(formatRatioPercent(2 / 7)).toBe("29%");
  });

  it("1.05 → 100%（極短セッションの実測 105% を 0-100% にクリップ・2026-11-03 実機発見）", () => {
    expect(formatRatioPercent(1.05)).toBe("100%");
  });

  it("-0.1 → 0%（負値もクリップ）", () => {
    expect(formatRatioPercent(-0.1)).toBe("0%");
  });
});
