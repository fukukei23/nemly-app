/**
 * SQLiteAdapter (Sprint A Day 4)
 *
 * 責務:
 * - PRAGMA user_version の取得/設定を抽象化
 * - expo-sqlite の戻り値型差異を吸収
 * - 実行 SQL 文字列の記録（テスト用）
 *
 * 設計判断:
 * - PRAGMA アクセスを adapter に閉じ込めて、SDK 差し替え時に 1 ファイルで吸収
 * - ExpoSqliteAdapter は Day 5+ で実装（Day 4 は FakeAdapter のみ）
 * - checksum は sha256 of DDL 文字列で最小実装
 */

import type { MigrationRow } from "./migrations";

export interface SQLiteAdapter {
  getUserVersion(db: any): Promise<number>;
  setUserVersion(db: any, version: number): Promise<void>;
  execBatch(db: any, sqls: string[]): Promise<void>;
  /** 1 migration = 1 transaction 契約（Expo は withExclusiveTransactionAsync・Fake は BEGIN/COMMIT ログ） */
  runInTransaction(db: any, fn: (tx: any) => Promise<void>): Promise<void>;
  getMigrations(db: any): Promise<MigrationRow[]>;
  tableExists(db: any, name: string): Promise<boolean>;
  parseRowSet<T = any>(result: any): T[];
  /**
   * DDL 等の checksum（SHA-256 hex）を返す。
   * RN runtime では expo-crypto（digestStringAsync）が非同期 API のため非同期。
   * Fake は Node crypto、Expo は expo-crypto を使用（同一アルゴリズムで同値）。
   */
  checksumOfAsync(input: string): Promise<string>;
  /** migration 完了の永続記録（DDL + 記録 + user_version を atomic に進める） */
  recordMigrationApplied(db: any, row: MigrationRow): Promise<void>;
}

/** テスト専用拡張（Day 5+ で Expo 実装が誤参照しないよう分離） */
export interface TestingSQLiteAdapter extends SQLiteAdapter {
  getExecutedSqls(db: any): string[];
  __injectMigrations(db: any, rows: MigrationRow[]): void;
}

const FAKE_DB_VERSION_KEY = "__user_version__";
const FAKE_DB_TABLES_KEY = "__tables__";
const FAKE_DB_EXECUTED_KEY = "__executed_sqls__";

function ensureFakeDbShape(db: any): asserts db is {
  [FAKE_DB_VERSION_KEY]: number;
  [FAKE_DB_TABLES_KEY]: Record<string, any[]>;
  [FAKE_DB_EXECUTED_KEY]: string[];
} {
  if (!(FAKE_DB_VERSION_KEY in db)) db[FAKE_DB_VERSION_KEY] = 0;
  if (!(FAKE_DB_TABLES_KEY in db)) db[FAKE_DB_TABLES_KEY] = {};
  if (!(FAKE_DB_EXECUTED_KEY in db)) db[FAKE_DB_EXECUTED_KEY] = [];
}

/**
 * sha256 計算（FakeAdapter 専用・jest=Node runtime）。本番（RN）は
 * ExpoSqliteAdapter.checksumOfAsync が expo-crypto digestStringAsync を使用する
 * （同一アルゴリズム SHA-256・同一 hex 値）。
 *
 * なぜ pure-JS を採用しないか: pure-JS SHA-256 を自前で書くには FIPS 180-4 完全実装 +
 * UTF-8 エンコード境界処理が必要で監査リスクが高い。テスト環境では Node crypto、
 * 本番では expo-crypto という「両端で安全」を採用し、pure-JS は依存追加時のみ検討。
 */
function sha256(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto") as typeof import("crypto");
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function createFakeAdapter(): TestingSQLiteAdapter {
  return {
    async getUserVersion(db: any): Promise<number> {
      ensureFakeDbShape(db);
      return db[FAKE_DB_VERSION_KEY] ?? 0;
    },

    async setUserVersion(db: any, version: number): Promise<void> {
      ensureFakeDbShape(db);
      db[FAKE_DB_VERSION_KEY] = version;
      db[FAKE_DB_EXECUTED_KEY].push(`PRAGMA user_version = ${version};`);
    },

    async execBatch(db: any, sqls: string[]): Promise<void> {
      ensureFakeDbShape(db);
      for (const sql of sqls) {
        db[FAKE_DB_EXECUTED_KEY].push(sql);
        // CREATE TABLE IF NOT EXISTS を擬似実行: tables に空配列を生成
        const m = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
        if (m && !(m[1] in db[FAKE_DB_TABLES_KEY])) {
          db[FAKE_DB_TABLES_KEY][m[1]] = [];
        }
      }
    },

    async runInTransaction(db: any, fn: (tx: any) => Promise<void>): Promise<void> {
      ensureFakeDbShape(db);
      db[FAKE_DB_EXECUTED_KEY].push("BEGIN;");
      try {
        await fn(db);
        db[FAKE_DB_EXECUTED_KEY].push("COMMIT;");
      } catch (err) {
        db[FAKE_DB_EXECUTED_KEY].push("ROLLBACK;");
        throw err;
      }
    },

    async getMigrations(db: any): Promise<MigrationRow[]> {
      ensureFakeDbShape(db);
      return db[FAKE_DB_TABLES_KEY]["schema_migrations"] ?? [];
    },

    async tableExists(db: any, name: string): Promise<boolean> {
      ensureFakeDbShape(db);
      if (db[FAKE_DB_TABLES_KEY][name]) return true;
      // 実行 SQL ログから CREATE TABLE IF NOT EXISTS <name> ( を厳密一致で検出
      // 部分文字列誤検出防止（例: completions vs completions_archive）
      const re = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\b\\s*\\(`, "i");
      return db[FAKE_DB_EXECUTED_KEY].some((s) => re.test(s));
    },

    async recordMigrationApplied(db: any, row: MigrationRow): Promise<void> {
      ensureFakeDbShape(db);
      if (!db[FAKE_DB_TABLES_KEY]["schema_migrations"]) db[FAKE_DB_TABLES_KEY]["schema_migrations"] = [];
      db[FAKE_DB_TABLES_KEY]["schema_migrations"].push(row);
      db[FAKE_DB_VERSION_KEY] = row.version;
      db[FAKE_DB_EXECUTED_KEY].push(
        `INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (${row.version}, '${row.name}', '${row.applied_at}', '${row.checksum}');`
      );
      db[FAKE_DB_EXECUTED_KEY].push(`PRAGMA user_version = ${row.version};`);
    },

    parseRowSet<T = any>(result: any): T[] {
      if (Array.isArray(result)) return result;
      if (result?.rows?._array) return result.rows._array;
      if (result?.rows && Array.isArray(result.rows)) return result.rows;
      if (result === null || result === undefined) return [];
      if (typeof result === "object" && "user_version" in result) return [] as T[];
      return [];
    },

    async checksumOfAsync(input: string): Promise<string> {
      return sha256(input);
    },

    getExecutedSqls(db: any): string[] {
      ensureFakeDbShape(db);
      return [...db[FAKE_DB_EXECUTED_KEY]];
    },

    __injectMigrations(db: any, rows: MigrationRow[]): void {
      ensureFakeDbShape(db);
      db[FAKE_DB_TABLES_KEY]["schema_migrations"] = [...rows];
    },
  };
}

/**
 * expo-sqlite 実機用アダプタ (Sprint A Day 5+)。
 * db は SQLite.openDatabaseAsync() の戻り値（SQLiteDatabase）を渡す。
 *
 * 設計判断:
 * - トランザクションは withExclusiveTransactionAsync（scope 内のクエリのみが
 *   トランザクションに含まれる・withTransactionAsync は scope 外のクエリも
 *   巻き込む挙動が公式 docs に明記のため不採用）
 * - checksum は expo-crypto digestStringAsync（RN/Hermes 安全・デフォルト HEX）
 * - tableExists/getMigrations は sqlite_master をパラメータバインドで照会
 *   （テーブル名を文字列補間しない）
 */
export function createExpoSqliteAdapter(): SQLiteAdapter {
  return {
    async getUserVersion(db: any): Promise<number> {
      const row = await db.getFirstAsync("PRAGMA user_version");
      return row?.user_version ?? 0;
    },

    async setUserVersion(db: any, version: number): Promise<void> {
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(`[ExpoSqliteAdapter] setUserVersion: 不正な version=${version}`);
      }
      await db.execAsync(`PRAGMA user_version = ${version}`);
    },

    async execBatch(db: any, sqls: string[]): Promise<void> {
      if (sqls.length === 0) return;
      await db.execAsync(sqls.join("\n"));
    },

    async runInTransaction(db: any, fn: (tx: any) => Promise<void>): Promise<void> {
      await db.withExclusiveTransactionAsync(async (tx: any) => {
        await fn(tx);
      });
    },

    async getMigrations(db: any): Promise<MigrationRow[]> {
      const exists = await db.getFirstAsync(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        ["schema_migrations"]
      );
      if (!exists) return [];
      return (await db.getAllAsync(
        "SELECT * FROM schema_migrations ORDER BY version"
      )) as MigrationRow[];
    },

    async tableExists(db: any, name: string): Promise<boolean> {
      const row = await db.getFirstAsync(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        [name]
      );
      return row != null;
    },

    async recordMigrationApplied(db: any, row: MigrationRow): Promise<void> {
      // version は内部計算値だが、PRAGMA 文字列補間に直行するため防御的に検証する
      // （MLR r2 MiniMax-9/GLM-3: setUserVersion と同じ setter 経路を統一）
      if (!Number.isInteger(row.version) || row.version < 0) {
        throw new Error(`[ExpoSqliteAdapter] recordMigrationApplied: 不正な version=${row.version}`);
      }
      await db.runAsync(
        "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        [row.version, row.name, row.applied_at, row.checksum]
      );
      await db.execAsync(`PRAGMA user_version = ${row.version}`);
    },

    parseRowSet<T = any>(result: any): T[] {
      if (Array.isArray(result)) return result;
      if (result?.rows?._array) return result.rows._array;
      if (result?.rows && Array.isArray(result.rows)) return result.rows;
      return [];
    },

    async checksumOfAsync(input: string): Promise<string> {
      // 遅延 require: FakeAdapter のみを使う環境で expo-crypto を解決しない
      // （jest.setup.js で Node crypto 同値モックに差し替え済み）
      const Crypto = require("expo-crypto") as typeof import("expo-crypto");
      return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
    },
  };
}