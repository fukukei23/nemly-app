/**
 * センサー計測（Phase 2）の型定義
 *
 * 契約: ネイティブ専用DBの1行 = SensorSample・pullSeries がこれを返す
 * 設計正典: docs/superpowers/specs/2026-10-28_nemly-app-Phase2センサー計測-design.md（SSOT）
 */

/** ネイティブ専用DBの1行（pullSeries の要素） */
export interface SensorSample {
  tsMs: number; // 窓開始・epoch ms（spec §5）
  amplitude: number; // m/s² 窓内平均（spec §5 数式）
  quality: 0 | 1; // 0=OK 1=DEGRADED(event少)
  eventCount: number;
}

export interface GapInterval {
  start: number;
  end: number;
}

export interface SeriesQuality {
  nanRate: number;
  stationaryRate: number; // 振幅<0.05 の窓率
  validRatio: number; // 有効窓/期待窓
  gaps: GapInterval[];
}

export interface SeriesMeta {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  endReason: string; // user_stop | system
  status: "recording" | "finished" | "failed";
}

/** fail判定の結果（spec §8 rubric・判定は failCheck.ts のみで行う） */
export type FailVerdict =
  | { verdict: "pass" }
  | { verdict: "degraded_pass"; reasons: string[] }
  | { verdict: "fail"; reasons: string[] };
