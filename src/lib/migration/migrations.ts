/**
 * migrations 定義 (Nemly)
 *
 * 複製元: microwin-app src/lib/migration/migrations.ts（検証済み framework・2026-10-27）
 * 責務:
 * - user_version + schema_migrations テーブル機構（MicroWin Sprint A Day 4 方式を継承）
 * - v1: sleep_sessions（1晩の記録・スコア・比率）+ sleep_stages（統合ラベル時系列）
 *
 * 設計判断:
 * - 各 migration は { version, name, up, down?, checksum } のオブジェクト
 * - 冪等性のため全 CREATE TABLE は IF NOT EXISTS
 * - sleep_stages.phase は統合ラベル（'DEEP' | 'LIGHT' | 'REM' | 'AWAKE' | 'BROKEN'）:
 *   インポート時の1回判定結果を表示用に格納する（生判定の再計算要件は将来 version で対応）
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
`.trim();

export const V1_DDL = `
CREATE TABLE IF NOT EXISTS sleep_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  deep_ratio REAL NOT NULL,
  light_ratio REAL NOT NULL,
  rem_ratio REAL NOT NULL,
  awake_ratio REAL NOT NULL,
  score INTEGER,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sleep_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sleep_sessions(id),
  ts_ms INTEGER NOT NULL,
  phase TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_start ON sleep_sessions(start_ms);
-- UNIQUE: 重複防御を SQLite 側でも担保（InMemory と等価契約・再 import で stages 重複を防ぐ）
CREATE UNIQUE INDEX IF NOT EXISTS idx_stages_session_ts ON sleep_stages(session_id, ts_ms);
`.trim();

export const v1: Migration = {
  version: 1,
  name: "v1: initial schema (sleep_sessions + sleep_stages + indices)",
  up: V1_DDL,
};

/**
 * v2: センサー計測（Phase 2）
 * - amplitude_samples: センサーの10秒振幅系列（session_id+ts_ms で UNIQUE・再取り込みは INSERT OR IGNORE 正常系）
 * - sleep_sessions へのメタ列追加: センサーリンクッションの有効率・欠損区間数・終了理由（spec §4.2・nullable）
 */
export const V2_DDL = `
CREATE TABLE IF NOT EXISTS amplitude_samples (
  session_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  amplitude REAL NOT NULL,
  quality INTEGER NOT NULL,
  PRIMARY KEY (session_id, ts_ms)
);

ALTER TABLE sleep_sessions ADD COLUMN valid_ratio REAL;
ALTER TABLE sleep_sessions ADD COLUMN gap_count INTEGER;
ALTER TABLE sleep_sessions ADD COLUMN end_reason TEXT;
`.trim();

export const v2: Migration = {
  version: 2,
  name: "v2: amplitude_samples + sensor session meta columns",
  up: V2_DDL,
};

export const ALL_MIGRATIONS: Migration[] = [v1, v2];
