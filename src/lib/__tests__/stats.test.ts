import { summarizeSessions } from "../stats";
import type { SessionRecord } from "../repository";

/** TZ 非依存テスト: now は実行時刻から動的生成（テスト実行ガイド §TZ env 非依存） */
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const NOW_MS = NOW.getTime();
const DAY = 86400000;

function makeSession(overrides: Partial<SessionRecord> & { startMs: number }): SessionRecord {
  return {
    endMs: overrides.startMs + 6 * 3600000, // 6時間の睡眠
    sampleCount: 360,
    deepRatio: 0.2,
    lightRatio: 0.6,
    remRatio: 0.15,
    awakeRatio: 0.05,
    score: 67,
    source: "sensor",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("summarizeSessions", () => {
  /** 今日の00:00（ローカルTZ・TZ非依存テストのためnowから導出） */
  const TODAY_START = new Date(NOW_MS);
  TODAY_START.setHours(0, 0, 0, 0);
  const TODAY_START_MS = TODAY_START.getTime();

  it("週: 直近7日窓の始まり（6日前00:00）ちょうどのセッションが含まれる（境界）", () => {
    const sessions = [makeSession({ startMs: TODAY_START_MS - 6 * DAY })];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.count).toBe(1);
  });

  it("週: 窓の始まりより1ms前のセッションは含まれない", () => {
    const sessions = [makeSession({ startMs: TODAY_START_MS - 6 * DAY - 1 })];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.count).toBe(0);
  });

  it("月: 直近30日窓の始まり（29日前00:00）ちょうどは含まれ・1ms前は含まれない", () => {
    const sessions = [
      makeSession({ startMs: TODAY_START_MS - 29 * DAY }),
      makeSession({ startMs: TODAY_START_MS - 29 * DAY - 1 }),
    ];
    const s = summarizeSessions(sessions, "month", NOW_MS);
    expect(s.count).toBe(1);
  });

  it("平均スコア: score=null のセッションは平均から除外される", () => {
    const sessions = [
      makeSession({ startMs: NOW_MS - DAY, score: 67 }),
      makeSession({ startMs: NOW_MS - 2 * DAY, score: null }),
    ];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.count).toBe(2);
    expect(s.avgScore).toBe(67);
  });

  it("平均スコア: score=null のみなら avgScore=null", () => {
    const sessions = [makeSession({ startMs: NOW_MS - DAY, score: null })];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.avgScore).toBeNull();
  });

  it("平均睡眠時間: 6時間と5時間の平均は 5:30（330分）", () => {
    const sessions = [
      makeSession({ startMs: NOW_MS - DAY }), // endMs=startMs+6h → 360分
      makeSession({ startMs: NOW_MS - 2 * DAY, endMs: NOW_MS - 2 * DAY + 5 * 3600000 }),
    ];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.avgDurationMinutes).toBe(330);
  });

  it("対象0件: count=0・avgScore=null・avgDurationMinutes=null・dailyScoresは7日分のnull", () => {
    const s = summarizeSessions([], "week", NOW_MS);
    expect(s.count).toBe(0);
    expect(s.avgScore).toBeNull();
    expect(s.avgDurationMinutes).toBeNull();
    expect(s.dailyScores).toHaveLength(7);
    expect(s.dailyScores.every((d) => d.score === null)).toBe(true);
  });

  it("月: dailyScoresは30日分", () => {
    const s = summarizeSessions([], "month", NOW_MS);
    expect(s.dailyScores).toHaveLength(30);
  });

  it("同日2セッションのスコアは日ごとに平均される（67と73→70）", () => {
    const sessions = [
      makeSession({ startMs: NOW_MS - 3600000, score: 67 }), // 当日午前
      makeSession({ startMs: NOW_MS - 7200000, score: 73 }),
    ];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    const today = s.dailyScores[s.dailyScores.length - 1];
    expect(today.score).toBe(70);
  });

  it("dailyScores は古い日が先頭・当日が末尾", () => {
    const sessions = [makeSession({ startMs: NOW_MS - DAY, score: 67 })];
    const s = summarizeSessions(sessions, "week", NOW_MS);
    expect(s.dailyScores).toHaveLength(7);
    expect(s.dailyScores[6].score).toBeNull(); // 当日は計測なし
    expect(s.dailyScores[5].score).toBe(67); // 昨日
  });
});
