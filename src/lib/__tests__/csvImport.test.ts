/**
 * csvImport テスト（Nemly Phase 1）
 *
 * 責務: Activity_*.txt 5列パース + sleep-algorithm 判定パイプラインの検証
 * 実データ経路の実績: sleep-algorithm validation/real_data.ts（L141 実機検証と同一経路）
 */

import { parseActivityTxt, analyzeSleep } from "../csvImport";
import { STAGE_PHASES } from "../repository";

const STEP_MS = 10_000;

/** 静かな系列（深眠想定・amp一定） */
function quietSamples(count: number, startTs = 1_792_867_680_000): { ts: number; amp: number }[] {
  return Array.from({ length: count }, (_, i) => ({ ts: startTs + i * STEP_MS, amp: 0.01 }));
}

/** 末尾に高活動ブロックを追加（覚醒想定） */
function withWakeBlock(
  samples: { ts: number; amp: number }[],
  blockCount: number,
): { ts: number; amp: number }[] {
  const last = samples[samples.length - 1]!;
  const block = Array.from({ length: blockCount }, (_, i) => ({
    ts: last.ts + (i + 1) * STEP_MS,
    amp: 50,
  }));
  return [...samples, ...block];
}

describe("parseActivityTxt", () => {
  test("5列形式（cols0=ts・cols2=amp）をパースする", () => {
    const content = "1792867680000,1.0,2.5,0,0\n1792867690000,1.0,3.5,1,0\n";
    expect(parseActivityTxt(content)).toEqual([
      { ts: 1792867680000, amp: 2.5 },
      { ts: 1792867690000, amp: 3.5 },
    ]);
  });

  test("非有限値の行をスキップする", () => {
    const content = "not_number,1,2.5,0,0\n1792867680000,1,2.5,0,0\n";
    expect(parseActivityTxt(content)).toEqual([{ ts: 1792867680000, amp: 2.5 }]);
  });

  test("空文字列で空配列を返す", () => {
    expect(parseActivityTxt("")).toEqual([]);
  });
});

describe("analyzeSleep", () => {
  test("正常系: stages が昇順で・phase は定義値のみ", () => {
    const samples = quietSamples(60);
    const result = analyzeSleep(samples);
    expect(result.stages).toHaveLength(60);
    const tsList = result.stages.map((s) => s.tsMs);
    const sorted = [...tsList].sort((a, b) => a - b);
    expect(tsList).toEqual(sorted);
    for (const stage of result.stages) {
      expect(STAGE_PHASES).toContain(stage.phase);
    }
  });

  test("startMs/endMs が先頭/末尾サンプル ts と一致", () => {
    const result = analyzeSleep(quietSamples(30));
    expect(result.startMs).toBe(1_792_867_680_000);
    expect(result.endMs).toBe(1_792_867_680_000 + 29 * STEP_MS);
  });

  test("比率の合計が 1（BROKEN 含む・浮動小数誤差許容）", () => {
    const result = analyzeSleep(withWakeBlock(quietSamples(120), 30));
    const sum =
      result.deepRatio + result.lightRatio + result.remRatio + result.awakeRatio;
    const brokenCount = result.stages.filter((s) => s.phase === "BROKEN").length;
    const brokenRatio = brokenCount / result.stages.length;
    expect(Math.abs(sum + brokenRatio - 1)).toBeLessThan(0.001);
  });

  test("高活動ブロックの後に AWAKE ステージが検出される", () => {
    const result = analyzeSleep(withWakeBlock(quietSamples(120), 40));
    const awake = result.stages.filter((s) => s.phase === "AWAKE");
    expect(awake.length).toBeGreaterThan(0);
    expect(result.awakeRatio).toBeGreaterThan(0);
  });

  test("全無活動系列でも大半は判定され・BROKEN は先頭の評価開始前のみ", () => {
    const result = analyzeSleep(quietSamples(60));
    const broken = result.stages.filter((s) => s.phase === "BROKEN");
    // 評価開始条件（高活動頻度検知の窓=30サンプル等・awakeDetectors.ts の windowSize 既定）で
    // 先頭に UNKNOWN=BROKEN が出うるが・全体の半分を超えないこと（原典準拠の保守的挙動）
    expect(broken.length).toBeLessThan(30);
    expect(result.stages.length).toBe(60);
  });

  test("スコアが 0-100 の整数で返る", () => {
    const result = analyzeSleep(withWakeBlock(quietSamples(120), 30));
    expect(result.score).not.toBeNull();
    expect(Number.isInteger(result.score)).toBe(true);
    expect(result.score! >= 0 && result.score! <= 100).toBe(true);
  });

  test("sampleCount が入力サンプル数と一致", () => {
    const result = analyzeSleep(quietSamples(45));
    expect(result.sampleCount).toBe(45);
  });

  test("異常系: 空サンプルで例外を投げる", () => {
    expect(() => analyzeSleep([])).toThrow(/空/);
  });

  test("異常系: 1サンプルでも例外を出さず最小の結果を返す", () => {
    const result = analyzeSleep([{ ts: 1_792_867_680_000, amp: 0.01 }]);
    expect(result.stages).toHaveLength(1);
    expect(result.sampleCount).toBe(1);
  });
});
