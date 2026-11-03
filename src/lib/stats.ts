/**
 * 統計集計純関数（Sleep as Android 機能パリティ 第一群 機能B）
 * spec: docs/superpowers/specs/2026-11-03-nemly-parity1-design.md
 *
 * - 期間は「直近 dayCount 日」（当日を含む・境界は startOfDay(now) - (dayCount-1) 日の 00:00 以降）
 * - avgScore は score != null のみの平均（csv fail 等の未判定セッションを含まない）
 * - avgDurationMinutes は全対象セッションの睡眠時間（分）平均
 * - dailyScores は日ごとの score 平均（その日 score ありセッションが無ければ null・グラフの欠損用）
 */
import type { SessionRecord } from "./repository";

export type StatsPeriod = "week" | "month";

export interface DailyScore {
  /** ローカルTZの YYYY-MM-DD */
  day: string;
  score: number | null;
}

export interface StatsSummary {
  count: number;
  avgScore: number | null;
  avgDurationMinutes: number | null;
  dailyScores: DailyScore[];
}

const DAY_MS = 86400000;

export function dayCountOf(period: StatsPeriod): number {
  return period === "week" ? 7 : 30;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function summarizeSessions(
  sessions: SessionRecord[],
  period: StatsPeriod,
  now: number
): StatsSummary {
  const days = dayCountOf(period);
  // MLR 2026-11-03 GLM#3: DAY_MS 固定減算は DST 切替週でローカル日付境界からずれるため
  // setDate ベースで算出する（日本は DST 無いが実装の一般性として・テストは非DST環境で同値）
  const baseDay = new Date(startOfDay(now));
  baseDay.setDate(baseDay.getDate() - (days - 1));
  const firstDayStart = baseDay.getTime();
  const inPeriod = sessions.filter((s) => s.startMs >= firstDayStart && s.startMs <= now);

  const avgScore = mean(
    inPeriod.filter((s) => s.score != null).map((s) => s.score as number)
  );
  const avgDurationMinutes = mean(
    inPeriod.map((s) => Math.round((s.endMs - s.startMs) / 60000))
  );

  const dailyScores: DailyScore[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(startOfDay(now));
    day.setDate(day.getDate() - (days - 1 - i));
    const dayStart = day.getTime();
    const dayEnd = startOfDay(dayStart + 36 * 3600000) - 1;
    const daySessions = inPeriod.filter(
      (s) => s.startMs >= dayStart && s.startMs <= dayEnd
    );
    const scored = daySessions.filter((s) => s.score != null);
    dailyScores.push({
      day: dayKey(dayStart),
      score: scored.length === 0 ? null : mean(scored.map((s) => s.score as number)),
    });
  }

  return { count: inPeriod.length, avgScore, avgDurationMinutes, dailyScores };
}
