/**
 * Nemly SQLiteRepository
 *
 * 複製元: microwin-app src/lib/sqliteRepository.ts（構造継承・2026-10-27）
 *
 * 責務:
 * - expo-sqlite (async API) を使った実データ永続化
 * - 初期化は migration framework（migrationRunner + SQLiteAdapter）経由
 * - 並行実行防御: initializeSqliteRepositoryAsync は singleton promise で
 *   複数回呼んでも open は 1 回（複製元 MLR r3 GLM-1 指摘の対策を踏襲）
 *
 * 注意:
 * - jest 環境では expo-sqlite の native module が読めないため、
 *   initializeSqliteRepositoryAsync は遅延 require を使用する
 *   （SQLiteRepository クラス自体は db/adapter 注入で jest テスト可能）
 * - insertSession は session と stages を同一トランザクションで保存
 *   （部分保存 = stages 無しの孤立 session を防ぐ・migrationRunner と同一契約）
 */

import type { Repository, SessionRecord, SleepStageRow } from "./repository";
import { _setRepositoryForTest } from "./repository";
import { ALL_MIGRATIONS } from "./migration/migrations";
import { migrationRunner } from "./migration/migrationRunner";
import { createExpoSqliteAdapter, type SQLiteAdapter } from "./migration/sqliteAdapter";

const SESSION_COLS = "id, start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at";

function rowToSession(row: any): SessionRecord {
  return {
    id: row.id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    sampleCount: row.sample_count,
    deepRatio: row.deep_ratio,
    lightRatio: row.light_ratio,
    remRatio: row.rem_ratio,
    awakeRatio: row.awake_ratio,
    score: row.score,
    source: row.source,
    createdAt: row.created_at,
  };
}

export class SQLiteRepository implements Repository {
  private db: any; // SQLiteDatabase (expo-sqlite) — 型は native module
  private ready: Promise<void>;

  constructor(database: any, adapter: SQLiteAdapter = createExpoSqliteAdapter()) {
    this.db = database;
    this.ready = migrationRunner.run(database, ALL_MIGRATIONS, adapter);
  }

  async insertSession(session: SessionRecord, stages: SleepStageRow[]): Promise<number> {
    await this.ready;
    // session と stages を同一トランザクションで保存（stages INSERT 失敗で
    // 孤立 session が残る部分保存を防ぐ・migrationRunner と同一契約）。
    // SDK57 契約: tx 内のクエリは txn オブジェクトで実行必須。
    return this.db.withExclusiveTransactionAsync(async (tx: any) => {
      const result = await tx.runAsync(
        "INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          session.startMs,
          session.endMs,
          session.sampleCount,
          session.deepRatio,
          session.lightRatio,
          session.remRatio,
          session.awakeRatio,
          session.score,
          session.source,
          session.createdAt,
        ]
      );
      const insertedId = result.lastInsertRowId as number;
      for (const stage of stages) {
        await tx.runAsync(
          "INSERT INTO sleep_stages (session_id, ts_ms, phase) VALUES (?, ?, ?)",
          [insertedId, stage.tsMs, stage.phase]
        );
      }
      return insertedId;
    });
  }

  async listSessions(): Promise<SessionRecord[]> {
    await this.ready;
    const rows = await this.db.getAllAsync(
      `SELECT ${SESSION_COLS} FROM sleep_sessions ORDER BY start_ms DESC`
    );
    return (rows as any[]).map(rowToSession);
  }

  async getSessionStages(sessionId: number): Promise<SleepStageRow[]> {
    await this.ready;
    const rows = await this.db.getAllAsync(
      "SELECT ts_ms, phase FROM sleep_stages WHERE session_id = ? ORDER BY ts_ms",
      [sessionId]
    );
    return (rows as { ts_ms: number; phase: SleepStageRow["phase"] }[]).map((r) => ({
      tsMs: r.ts_ms,
      phase: r.phase,
    }));
  }

  async deleteSession(sessionId: number): Promise<void> {
    await this.ready;
    await this.db.withExclusiveTransactionAsync(async (tx: any) => {
      await tx.runAsync("DELETE FROM sleep_stages WHERE session_id = ?", [sessionId]);
      await tx.runAsync("DELETE FROM sleep_sessions WHERE id = ?", [sessionId]);
    });
  }

  async countSessions(): Promise<number> {
    await this.ready;
    const result = await this.db.getFirstAsync(
      "SELECT COUNT(*) AS n FROM sleep_sessions"
    );
    const r = result as { n: number } | null;
    return r?.n ?? 0;
  }
}

// ============================================================
// 並行実行防御付き初期化（実機用・複製元 MLR r3 GLM-1 を踏襲）
// ============================================================

let sqliteInitPromise: Promise<void> | null = null;

/**
 * 実機用初期化: openDatabaseAsync → SQLiteRepository（migration framework 経由）
 * → repository.ts の activeRepository へ設定。
 * singleton promise のため React StrictMode の二重実行でも open は 1 回。
 */
export function initializeSqliteRepositoryAsync(
  dbName: string = "nemly.db",
  adapter?: SQLiteAdapter
): Promise<void> {
  if (sqliteInitPromise) return sqliteInitPromise;
  sqliteInitPromise = (async () => {
    // 遅延 require: モジュール top-level import すると jest 環境で expo-sqlite 解決に失敗する
    const SQLite = require("expo-sqlite") as typeof import("expo-sqlite");
    const db = await SQLite.openDatabaseAsync(dbName);
    _setRepositoryForTest(new SQLiteRepository(db, adapter));
  })();
  return sqliteInitPromise;
}

/** テスト用: singleton promise のリセット */
export function _resetSqliteInitForTest(): void {
  sqliteInitPromise = null;
}
