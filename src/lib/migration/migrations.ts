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
CREATE INDEX IF NOT EXISTS idx_stages_session ON sleep_stages(session_id, ts_ms);
`.trim();

export const v1: Migration = {
  version: 1,
  name: "v1: initial schema (sleep_sessions + sleep_stages + indices)",
  up: V1_DDL,
};

export const ALL_MIGRATIONS: Migration[] = [v1];
