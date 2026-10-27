/**
 * migrationRunner テスト (Sprint A Day 4)
 *
 * 責務:
 * - spec v2 #13/#18: user_version + schema_migrations テーブル機構
 * - 冪等性 3軸: 同 migration 二重実行 / 並行起動 / 部分適用状態からの再実行
 * - 4軸 describe 分割: 新規 DB / 既存 v1 DB / 既に current / checksum 破壊
 */

import { createFakeAdapter, type TestingSQLiteAdapter } from "../sqliteAdapter";
import { migrationRunner } from "../migrationRunner";
import { v1 } from "../migrations";
import type { Migration } from "../migrations";
import { createHash } from "crypto";

/** テスト専用同期 sha256 hex（jest=Node runtime のみ・注入値の期待値計算用） */
function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** テスト用 fake DB（SQLiteAdapter のプリミティブを直接操作できる最小限の状態） */
function makeFakeDb(userVersion: number = 0, options: { hasV1Table?: boolean } = {}): any {
  const tables: Record<string, any[]> = {};
  if (options.hasV1Table) {
    tables["sleep_sessions"] = [
      {
        id: 1,
        start_ms: 1792867680000,
        end_ms: 1792899480000,
        sample_count: 2880,
        deep_ratio: 0.2,
        light_ratio: 0.6,
        rem_ratio: 0.13,
        awake_ratio: 0.01,
        score: 82,
        source: "activity_txt",
        created_at: "2026-10-25T03:48:00.000Z",
      },
    ];
    tables["sleep_stages"] = [{ id: 1, session_id: 1, ts_ms: 1792867680000, phase: "LIGHT" }];
  }
  return {
    __user_version__: userVersion,
    __tables__: tables,
    __executed_sqls__: [] as string[],
  };
}

const adapter = createFakeAdapter();

describe("migrationRunner (Day 4)", () => {
  describe("軸 I: 新規 DB (user_version=0)", () => {
    test("v1 を適用し user_version=1 になる", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      expect(await adapter.getUserVersion(db)).toBe(1);
    });

    test("v1 適用後に schema_migrations に v1 が記録される", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      const rows = await adapter.getMigrations(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, name: v1.name });
      expect(rows[0].checksum).toBe(await adapter.checksumOfAsync(v1.up));
    });

    test("v1 適用後に v1 の DDL に必要な CREATE TABLE IF NOT EXISTS が実行されている", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      const sqls = adapter.getExecutedSqls(db);
      expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sleep_sessions"))).toBe(true);
      expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sleep_stages"))).toBe(true);
    });

    test("transaction: 1 件適用につき BEGIN/COMMIT が記録される", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      const sqls = adapter.getExecutedSqls(db);
      expect(sqls.filter((s) => s === "BEGIN;").length).toBe(1);
      expect(sqls.filter((s) => s === "COMMIT;").length).toBe(1);
    });

    test("MLR統合: 通常適用は DDL と記録が同一 transaction 内（up 後 record 前の欠落を排除）", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      const sqls = adapter.getExecutedSqls(db);
      // 期待順序: BEGIN → DDL(sleep_stages CREATE が最終) → INSERT INTO schema_migrations → PRAGMA user_version → COMMIT
      const beginIdx = sqls.indexOf("BEGIN;");
      const ddlIdx = sqls.findIndex((s) => s.includes("CREATE TABLE IF NOT EXISTS sleep_stages"));
      const insertIdx = sqls.findIndex((s) => s.startsWith("INSERT INTO schema_migrations"));
      const pragmaIdx = sqls.findIndex((s) => s === "PRAGMA user_version = 1;");
      const commitIdx = sqls.indexOf("COMMIT;");
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(ddlIdx).toBeGreaterThan(beginIdx);
      expect(insertIdx).toBeGreaterThan(ddlIdx);
      expect(pragmaIdx).toBeGreaterThan(insertIdx);
      expect(commitIdx).toBeGreaterThan(pragmaIdx);
    });
  });

  describe("軸 II: 既存 v1 DB (user_version=1, schema_migrations 無し)", () => {
    test("bootstrap path で schema_migrations を作成し v1 を適用済として記録", async () => {
      const db = makeFakeDb(1, { hasV1Table: true });
      await migrationRunner.run(db, [v1], adapter);
      const rows = await adapter.getMigrations(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(1);
      expect(await adapter.getUserVersion(db)).toBe(1);
    });

    test("既存 v1 DB で bootstrap 時に v1 の DDL（sleep_sessions/sleep_stages）が再実行されない", async () => {
      const db = makeFakeDb(1, { hasV1Table: true });
      const sqlsBefore = [...adapter.getExecutedSqls(db)];
      await migrationRunner.run(db, [v1], adapter);
      const newSqls = adapter.getExecutedSqls(db).slice(sqlsBefore.length);
      const v1DdlExec = newSqls.filter(
        (s) => s.includes("CREATE TABLE IF NOT EXISTS sleep_sessions") || s.includes("CREATE TABLE IF NOT EXISTS sleep_stages")
      );
      expect(v1DdlExec.length).toBe(0);
    });

    test("既存 DB だが物理テーブルが無い場合: MigrationError で停止（inconsistent DB）", async () => {
      const db = makeFakeDb(1);
      // hasV1Table=false（デフォルト）= 部分適用または破壊 DB
      await expect(migrationRunner.run(db, [v1], adapter)).rejects.toThrow(/inconsistent DB/);
    });

    test("既存 DB で片方のテーブルだけ存在: MigrationError で停止", async () => {
      const db = makeFakeDb(1);
      // 片方だけ存在（不完全 DDL）
      db.__tables__["sleep_sessions"] = [];
      // sleep_stages は無し
      await expect(migrationRunner.run(db, [v1], adapter)).rejects.toThrow(/inconsistent DB/);
    });
  });

  describe("軸 III: 既に current (user_version=max)", () => {
    test("user_version=1 で v1 配列を指定しても何も実行されない", async () => {
      const db = makeFakeDb(1, { hasV1Table: true });
      // 既存 v1 DB として一度 migration を走らせ current 状態に
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterFirst = adapter.getExecutedSqls(db).length;
      // 二度目は no-op
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterSecond = adapter.getExecutedSqls(db).length;
      expect(executedAfterSecond).toBe(executedAfterFirst);
    });
  });

  describe("軸 IV: schema_migrations の checksum 破壊", () => {
    test("checksum が破壊された migration が要求された時、例外をスローする", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      // schema_migrations の checksum を別物に書き換え
      const rows = await adapter.getMigrations(db);
      rows[0].checksum = "deadbeef".repeat(8);
      // 別 DB で再現（同じ adapter インスタンスを使う都合）
      const db2 = makeFakeDb(1);
      // schema_migrations を手動注入
      adapter.__injectMigrations(db2, [{ version: 1, name: v1.name, checksum: "deadbeef".repeat(8), applied_at: "2026-10-17" }]);
      await expect(migrationRunner.run(db2, [v1], adapter)).rejects.toThrow(/checksum/);
    });
  });

  describe("冪等性 3軸", () => {
    test("(i) 同 migration 二重実行: 結果が変わらない", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterFirst = adapter.getExecutedSqls(db).length;
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterSecond = adapter.getExecutedSqls(db).length;
      // IF NOT EXISTS + 適用済判定で DDL は再実行されない
      const ddlNew = adapter.getExecutedSqls(db).slice(executedAfterFirst).filter((s) => s.includes("CREATE TABLE"));
      expect(ddlNew.length).toBe(0);
      expect(await adapter.getUserVersion(db)).toBe(1);
    });

    test("(iii) 部分適用状態からの再実行: v1 の DDL 失敗を擬似再現→re-run で復旧", async () => {
      // 部分適用: user_version=1 + 物理テーブル存在 + schema_migrations が無い
      const db = makeFakeDb(1, { hasV1Table: true });
      // 初期状態: schema_migrations は空（= 部分適用）
      expect(await adapter.getMigrations(db)).toHaveLength(0);
      // re-run で復旧: bootstrap path が走り v1 を適用済として記録
      await migrationRunner.run(db, [v1], adapter);
      expect(await adapter.getUserVersion(db)).toBe(1);
      const rows = await adapter.getMigrations(db);
      expect(rows).toHaveLength(1);
    });
  });

  describe("v2 マイグレーション追加", () => {
    const v2: Migration = {
      version: 2,
      name: "v2: add streak column",
      up: "ALTER TABLE sleep_sessions ADD COLUMN streak_count INTEGER DEFAULT 0;",
    };

    test("user_version=1 → v2 適用で user_version=2 になる", async () => {
      const db = makeFakeDb(0);
      await migrationRunner.run(db, [v1, v2], adapter);
      expect(await adapter.getUserVersion(db)).toBe(2);
      const rows = await adapter.getMigrations(db);
      expect(rows.map((r) => r.version)).toEqual([1, 2]);
    });

    test("連続性チェック: v1 をスキップして v2 のみ指定すると例外", async () => {
      const db = makeFakeDb(0);
      await expect(migrationRunner.run(db, [v2], adapter)).rejects.toThrow(/連続|missing/i);
    });

    test("version 重複検出: v1 と v1 を2 回指定すると例外", async () => {
      const db = makeFakeDb(0);
      const v1Dup: Migration = { ...v1, name: "v1: duplicate" };
      // 連続性違反（index=1 だが version=1）が先に発火する
      await expect(migrationRunner.run(db, [v1, v1Dup], adapter)).rejects.toThrow(/連続|重複/);
    });

    test("連続性チェック: 飛び version (v1 + v3 で v2 欠け) で例外", async () => {
      const db = makeFakeDb(0);
      const v3: Migration = { version: 3, name: "v3", up: "ALTER TABLE sleep_sessions ADD COLUMN x INTEGER;" };
      await expect(migrationRunner.run(db, [v1, v3], adapter)).rejects.toThrow(/連続/i);
    });

    test("冪等性 (i) 二度目 run: schema_migrations に正しい checksum で v1 を注入済 = 行120 スキップ", async () => {
      const db = makeFakeDb(0);
      // 初回: schema_migrations に v1 を記録
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterFirst = adapter.getExecutedSqls(db).length;
      // 行120 (existingVersions.has skip) を踏むため、checksum 検証を通る形で v1 を注入
      await adapter.__injectMigrations(db, [{
        version: 1,
        name: "v1: pre-injected",
        applied_at: new Date().toISOString(),
        checksum: sha256hex(v1.up),
      }]);
      // 再度 run: m.version=1 <= currentVersion=1 でスキップ
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterSecond = adapter.getExecutedSqls(db).length;
      expect(executedAfterSecond).toBe(executedAfterFirst);
    });

    test("冪等性 (i) 二重実行: schema_migrations に version=1 が登録済みで再実行はスキップ", async () => {
      const db = makeFakeDb(0, { hasV1Table: true });
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterFirst = adapter.getExecutedSqls(db).length;
      // 二度目の run: m.version=1 <= currentVersion=1 でスキップされる
      await migrationRunner.run(db, [v1], adapter);
      const executedAfterSecond = adapter.getExecutedSqls(db).length;
      expect(executedAfterSecond).toBe(executedAfterFirst);
    });

    test("行120 fail-fast: schema_migrations 記録済 + user_version 未満 = inconsistent state で throw", async () => {
      // 不整合状態: schema_migrations に v1 記録済だが user_version=0 に戻されている
      // （atomicity 前提崩れを模擬 = Day 5+ で発生する可能性）
      const db = makeFakeDb(0);
      // 正しい checksum を投入（checksum 検証を通過させる）
      adapter.__injectMigrations(db, [{
        version: 1,
        name: "v1: pre-injected",
        applied_at: "2026-10-20T00:00:00Z",
        checksum: sha256hex(v1.up),
      }]);
      // getUserVersion を override して 0 を返す（atomicity 崩れ模擬）
      const origGetUserVersion = adapter.getUserVersion.bind(adapter);
      adapter.getUserVersion = async () => 0;
      try {
        // m.version=1 > currentVersion=0 で行117 を抜ける → 行120 に到達
        // existingVersions.has(1) = true で fail-fast throw
        await expect(migrationRunner.run(db, [v1], adapter)).rejects.toThrow(
          /inconsistent state.*atomicity 前提崩れ/
        );
      } finally {
        adapter.getUserVersion = origGetUserVersion;
      }
    });

    test("downgrade 防御: user_version > 定義最大なら例外", async () => {
      const db = makeFakeDb(5);
      await expect(migrationRunner.run(db, [v1, v2], adapter)).rejects.toThrow(/downgrade|max/i);
    });
  });

  describe("Day 5+: tx 必須契約（MLR r2・expo-sqlite SDK57 'Any queries inside the transaction must be executed on the txn object'）", () => {
    /**
     * tx を db と別オブジェクトにする runner が「db 直呼び」すると
     * 検出できる fake adapter（r2 で 4 機 3 件が独立指摘した欠陥の回帰テスト）。
     */
    function makeTxStrictAdapter() {
      const inner = createFakeAdapter() as TestingSQLiteAdapter;
      const TX_MARK = "__is_tx__";
      let inTx = false;
      let txUsageCount = 0;
      const strict = {
        ...inner,
        // SDK57 契約: transaction 内では tx オブジェクトでクエリを実行する。
        // transaction 内で db 直呼び（tx オブジェクト以外の識別子）が来たら拒否。
        execBatch: async (target: any, sqls: string[]) => {
          if (inTx && target?.[TX_MARK] !== true) {
            throw new Error("transaction 内では tx オブジェクトでクエリを実行必須（SDK57 仕様）");
          }
          return inner.execBatch(target, sqls);
        },
        recordMigrationApplied: async (target: any, row: any) => {
          if (inTx && target?.[TX_MARK] !== true) {
            throw new Error("transaction 内では tx オブジェクトで記録必須（SDK57 仕様）");
          }
          return inner.recordMigrationApplied(target, row);
        },
        runInTransaction: async (db: any, fn: (tx: any) => Promise<void>) => {
          return inner.runInTransaction(db, async () => {
            inTx = true;
            const txScope: any = { [TX_MARK]: true };
            try {
              await fn(txScope);
              if (txUsageCount === 0 && db.__txUsedMarker !== true) {
                db.__txUsedMarker = true;
              }
            } finally {
              inTx = false;
            }
          });
        },
        getExecutedSqls: (db: any) => inner.getExecutedSqls(db),
        __injectMigrations: (db: any, rows: any[]) => inner.__injectMigrations(db, rows),
        getUserVersion: (db: any) => inner.getUserVersion(db),
        setUserVersion: (db: any, v: number) => inner.setUserVersion(db, v),
        getMigrations: (db: any) => inner.getMigrations(db),
        tableExists: (db: any, n: string) => inner.tableExists(db, n),
        parseRowSet: (r: any) => inner.parseRowSet(r),
        checksumOfAsync: (s: string) => inner.checksumOfAsync(s),
      };
      return strict as any;
    }

    test("通常適用は tx 経由で DDL と記録を実行する（db 直呼びは strict adapter が拒否）", async () => {
      const db = makeFakeDb(0);
      const strict = makeTxStrictAdapter();
      // strict は「transaction 内で db 直呼び」場合に throw する。
      // throw せず完了すること = runner が tx を使うことの証明。
      await expect(migrationRunner.run(db, [v1], strict)).resolves.toBeUndefined();
    });

    test("bootstrap も tx 経由で記録する（db 直呼びは strict adapter が拒否）", async () => {
      const db = makeFakeDb(1, { hasV1Table: true });
      const strict = makeTxStrictAdapter();
      await expect(migrationRunner.run(db, [v1], strict)).resolves.toBeUndefined();
    });
  });

  describe("Day 5+: bootstrap path atomicity (L1166)", () => {
    test("bootstrap 記録中に recordMigrationApplied が失敗すると ROLLBACK が発行され例外が伝播する", async () => {
      // bootstrap path 条件: user_version>=1 + schema_migrations 空 + v1 物理テーブル有り
      const db = makeFakeDb(1, { hasV1Table: true });
      const failing = createFakeAdapter() as TestingSQLiteAdapter;
      let calls = 0;
      const orig = failing.recordMigrationApplied.bind(failing);
      failing.recordMigrationApplied = async (d: any, row: any) => {
        calls++;
        if (calls === 1) throw new Error("record 失敗");
        return orig(d, row);
      };
      await expect(migrationRunner.run(db, [v1], failing)).rejects.toThrow("record 失敗");
      const sqls = failing.getExecutedSqls(db);
      expect(sqls).toContain("BEGIN;");
      expect(sqls).toContain("ROLLBACK;");
      expect(sqls).not.toContain("COMMIT;");
    });
  });
});