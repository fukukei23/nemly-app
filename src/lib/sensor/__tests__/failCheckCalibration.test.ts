import { validateAndJudge } from "../failCheck";
import { summarizeQuality } from "../windowAggregator";
import calib from "../calibration20261028.json";

/**
 * 校正 fixture 回帰（2026-10-28/29 実機 DB・MLR r1 2026-10-29 で追加）
 *
 * 机 = must-fail（机検出ゲート）/ ベッド = must-pass（正常睡眠・寝返り28窓）。
 * 閾値改訂（STATIONARY_THRESHOLD 0.01・MAX_STATIONARY_RATE 0.90）がこの判別を
 * 維持することを恒久検証する。閾値変更時は fixture の期待 verdict を再校正する。
 */

interface CalibSession {
  label: string;
  expectedVerdict: string;
  windows: number[];
}

function judgeSession(s: CalibSession) {
  const windows = s.windows.map((amplitude, i) => ({
    tsMs: i * 10_000,
    amplitude,
    quality: 0 as const,
    eventCount: 35,
  }));
  const q = summarizeQuality(windows, windows.length);
  return validateAndJudge({ samples: windows, gaps: q.gaps, validRatio: 1 }, windows.length, q);
}

describe("校正 fixture 回帰（2026-10-28 実機 DB・机=fail/ベッド=pass）", () => {
  it("机セッション（Stage 3・450窓）→ fail（机検出ゲート）", () => {
    const v = judgeSession(calib.desk as unknown as CalibSession);
    expect(v.verdict).toBe("fail");
  });

  it("ベッドセッション（Stage 4・2766窓・正常睡眠）→ pass", () => {
    const v = judgeSession(calib.bed as unknown as CalibSession);
    expect(v.verdict).toBe("pass");
  });
});
