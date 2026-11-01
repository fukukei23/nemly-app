/**
 * SleepScoreCalculator セッション種別対応テスト（2026-11-01・スコア67固定対策）
 *
 * 背景: DURATION 合格帯 410-540分が「夜寝7時間超」前提で・ふくけいの実睡眠
 * （4-5時間が通常）と昼寝（約100分）に届かずスコアが常に 2/3=67 固定になった
 * （Phase2正典進捗追記7実測）。ふくけい指示「昼寝は昼寝基準で評価する」の実装。
 */

import {
  MEASURE_SPECS,
  SleepScoreCalculator,
  type SessionType,
} from "../sleepAlgorithm/sleepScore";

/** 実データ相当で score を計算するヘルパー（analyzeSleep と同一の3測定投入順） */
function scoreOf(
  sessionType: SessionType,
  durationMin: number,
  deepRatio: number,
  awakeRatio: number,
): number {
  const calc = new SleepScoreCalculator();
  if (sessionType === "nap") calc.setSessionType("nap");
  calc.updateMeasure("DURATION", durationMin);
  calc.updateMeasure("DEEP_SLEEP", deepRatio);
  calc.updateMeasure("EFFICIENCY", 1 - awakeRatio);
  return calc.getScorePercentage();
}

describe("MEASURE_SPECS セッション種別しきい値", () => {
  test("夜寝の DURATION は 180-480分（3〜8時間・ふくけい指示『3-4時間はあり得る・8時間まで幅広く』2026-11-01）", () => {
    expect(MEASURE_SPECS.DURATION).toEqual({
      type: "RANGE",
      limitPositive: 180,
      limitNegative: 480,
    });
  });

  test("昼寝の DURATION_NAP は 20-120分（パワーナップ〜1.5サイクル）", () => {
    expect(MEASURE_SPECS.DURATION_NAP).toEqual({
      type: "RANGE",
      limitPositive: 20,
      limitNegative: 120,
    });
  });
});

describe("SleepScoreCalculator.setSessionType", () => {
  test("デフォルト（night）は夜寝基準で評価する", () => {
    // 300分（5時間）= ふくけいの「いつも」の中心 → 合格
    expect(scoreOf("night", 300, 0.9, 0)).toBe(100);
  });

  test("night で昼寝相当の短時間（100分）は DURATION 不合格", () => {
    expect(scoreOf("night", 100, 0.9, 0)).toBe(67);
  });

  test("nap を設定すると 20-120分が DURATION 合格になる", () => {
    // 昼寝3実データ相当（100.8分・deep 65.3%・覚醒0%）→ 3/3
    expect(scoreOf("nap", 100.8, 0.6529, 0)).toBe(100);
  });

  test("nap でも 120分超の長昼寝は DURATION 不合格", () => {
    expect(scoreOf("nap", 180, 0.9, 0)).toBe(67);
  });

  test("nap でも 20分未満の微昼寝は DURATION 不合格", () => {
    expect(scoreOf("nap", 15, 0.9, 0)).toBe(67);
  });

  test("nap は年齢しきい値を適用しない（setAge 後に setSessionType で上書き）", () => {
    // 6-13歳のしきい値（540-720分）を setAge で適用後も・nap は 20-120分基準を保つ
    const calc = new SleepScoreCalculator();
    calc.setAge(10);
    calc.setSessionType("nap");
    calc.updateMeasure("DURATION", 100);
    calc.updateMeasure("DEEP_SLEEP", 0.9);
    calc.updateMeasure("EFFICIENCY", 1);
    expect(calc.getScorePercentage()).toBe(100);
  });

  test("既存2夜寝実データが新夜寝基準で DURATION 合格になる（回帰防止）", () => {
    // 1夜目: 3時間41分（221分）・2夜目: 5時間38分（337.8分）
    expect(scoreOf("night", 221, 0.867, 0)).toBe(100);
    expect(scoreOf("night", 337.8, 0.9423, 0.0138)).toBe(100);
  });

  test("幅広化の境界: 7時間（420分）は合格・3時間（180分）は合格・9時間（540分）は不合格", () => {
    // 一般人の6-8時間睡眠も合格帯に入る（ふくけい指示・2026-11-01）
    expect(scoreOf("night", 420, 0.9, 0)).toBe(100);
    expect(scoreOf("night", 180, 0.9, 0)).toBe(100);
    expect(scoreOf("night", 540, 0.9, 0)).toBe(67);
  });
});
