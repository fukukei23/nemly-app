/**
 * migrationRunner (Sprint A Day 4)
 *
 * 責務:
 * - spec v2 #13/#18: user_version + schema_migrations テーブル機構
 * - bootstrap path: 既存 user_version=1 DB への対応（AND 条件: user_version>=1 && 物理テーブル存在）
 * - 1 migration = 1 transaction 単位の適用（adapter.runInTransaction 経由）
 * - 連続性チェック（飛び version 検出）
 * - downgrade 防御（user_version > 定義最大 → 例外）
 * - checksum 検証（schema_migrations の各 row.checksum が現在の migration と一致）
 *
 * 設計判断:
 * - 冪等性 3軸のうち Day 4 は (i)(iii) を fake でカバー、(ii) 並行は Day 5+
 * - bootstrap: AND 条件で既存 DB 判定・誤注入防止
 */

import type { Migration, MigrationRow } from "./migrations";
import { SCHEMA_MIGRATIONS_DDL } from "./migrations";
import type { SQLiteAdapter } from "./sqliteAdapter";

const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export interface MigrationRunner {
  run(db: any, migrations: Migration[], adapter: SQLiteAdapter): Promise<void>;
}

class MigrationError extends Error {
  constructor(message: string) {
    super(`[migrationRunner] ${message}`);
    this.name = "MigrationError";
  }
}

export const migrationRunner: MigrationRunner = {
  async run(db: any, migrations: Migration[], adapter: SQLiteAdapter): Promise<void> {
    if (migrations.length === 0) return;

    // 1. 連続性チェック: version が 1 から連番であること + 重複検出
    for (let i = 0; i < migrations.length; i++) {
      const expected = i + 1;
      if (migrations[i].version !== expected) {
        throw new MigrationError(
          `migration 連続性違反: index=${i} は version=${expected} 必須だが version=${migrations[i].version}`
        );
      }
    }
    const versions = migrations.map((m) => m.version);
    // TODO Day5+ spec v2 #13 改訂時に再評価: 連続性検証を緩和する場合の保険として残置。
    //      到達不能だが、version 配列の cardinality 保証として機能。
    //      削除判断はバックログ L1142 を参照。
    if (new Set(versions).size !== versions.length) {
      throw new MigrationError(`migration version 重複: ${versions.join(",")}`);
    }

    // 2. user_version を取得
    const currentVersion = await adapter.getUserVersion(db);

    // 3. downgrade 防御
    const maxVersion = migrations.length;
    if (currentVersion > maxVersion) {
      throw new MigrationError(
        `downgrade 検出: user_version=${currentVersion} が定義最大=${maxVersion} を超えています`
      );
    }

    // 4. schema_migrations テーブルが無ければ作成（bootstrap）
    const existingMigrations = await adapter.getMigrations(db);
    const hasSchemaMigrationsTable =
      existingMigrations.length > 0 || (await adapter.tableExists(db, SCHEMA_MIGRATIONS_TABLE));

    if (!hasSchemaMigrationsTable) {
      await adapter.execBatch(db, [SCHEMA_MIGRATIONS_DDL]);
    }

    // 5. bootstrap path: user_version >= 1 かつ schema_migrations 行数 == 0 かつ
    //    物理テーブル（v1 DDL が作った両方のテーブル）が存在する場合のみ、既存 DB からの移行と判定
    //    ※ 片方だけ存在時は「壊れた DB」とみなして例外（silent pass 防止）
    const hasSleepSessionsTable = await adapter.tableExists(db, "sleep_sessions");
    const hasSleepStagesTable = await adapter.tableExists(db, "sleep_stages");
    const hasV1Table = hasSleepSessionsTable && hasSleepStagesTable;

    const existingRows = await adapter.getMigrations(db);
    const existingVersions = new Set(existingRows.map((r) => r.version));

    if (existingRows.length === 0 && currentVersion >= 1) {
      if (!hasV1Table) {
        // user_version >= 1 だが v1 物理テーブル無し = 部分適用または破壊 DB
        // → silent pass せず MigrationError で停止（手動介入を要求）
        throw new MigrationError(
          `inconsistent DB 状態: user_version=${currentVersion} だが v1 物理テーブル不在・DDL から再実行が必要です`
        );
      }
      // bootstrap 記録全体を 1 transaction で包囲（バックログ L1166・MLR r4 GLM 指摘）。
      // 包囲なしでは recordMigrationApplied の途中失敗で部分 bootstrap が残り、
      // 次回 run が bootstrap path に入らず inconsistent state が silent 化する。
      // checksum は transaction 外で事前計算（MLR r2・MiniMax-3/GLM 指摘）し、
      // bootstrap の各 migration について記録値を用意してから tx 内でまとめて適用する。
      const bootstrapRecords: MigrationRow[] = [];
      for (let v = 1; v <= currentVersion; v++) {
        const m = migrations[v - 1];
        // break での silent 継続は部分 bootstrap を固定化する（MLR 2026-10-23 MiniMax-10/or1-11 採用）。
        // downgrade 防御と連続性検証が通っていれば到達しないが、silent より fail-fast。
        if (!m) {
          throw new MigrationError(
            `inconsistent state: bootstrap 中に version=${v} の migration 定義が見つかりません（定義数=${migrations.length}）`
          );
        }
        bootstrapRecords.push({
          version: m.version,
          name: m.name,
          applied_at: new Date().toISOString(),
          checksum: await adapter.checksumOfAsync(m.up),
        });
      }
      await adapter.runInTransaction(db, async (tx) => {
        for (const row of bootstrapRecords) {
          await adapter.recordMigrationApplied(tx, row);
        }
      });
    }

    // 6. checksum 検証
    const rowsAfterBootstrap = await adapter.getMigrations(db);
    for (const row of rowsAfterBootstrap) {
      const m = migrations.find((x) => x.version === row.version);
      // 未知 version（DB のみに存在する記録）は silent 継続せず fail-closed
      // （MLR r3 MiniMax-28 critical 採用: downgrade 縮小・定義削除時に
      //   記録だけ残る状態を黙って通すと以降の適用判断が壊れる）
      if (!m) {
        throw new MigrationError(
          `unknown migration version: schema_migrations に version=${row.version} の記録があるが現在の定義に存在しません（定義最大=${migrations.length}）`
        );
      }
      const expectedChecksum = await adapter.checksumOfAsync(m.up);
      if (row.checksum !== expectedChecksum) {
        throw new MigrationError(
          `checksum 不一致: version=${row.version} の schema_migrations.checksum=${row.checksum} が期待値=${expectedChecksum} と一致しません`
        );
      }
    }

    // 7. 未適用の migration を順次適用
    for (const m of migrations) {
      if (m.version <= currentVersion) continue;

      if (existingVersions.has(m.version)) {
        // Day 5+ で atomicity 前提が崩れた場合の保険:
        // schema_migrations に記録済だが user_version 未満 = inconsistent state。
        // 従来は continue（silent skip）だったが、fail-fast で明示エラー化。
        throw new MigrationError(
          `inconsistent state: version=${m.version} は schema_migrations 記録済だが user_version=${currentVersion} 未満・atomicity 前提崩れの可能性`
        );
      }

      // 1 migration = 1 transaction (adapter.runInTransaction 経由)
      // DDL と記録を同一 transaction に含める（MLR 2026-10-23 MiniMax-2/GLM-2/or1-1 採用:
      // up commit 後 record 前の失敗で部分適用残り経路を構造的に排除）
      // tx を使う理由（MLR r2・4機3件独立指摘）: expo-sqlite SDK57 の仕様は
      // 「Any queries inside the transaction must be executed on the txn object」。
      // db 直呼びは transaction 外に飛び、atomicity 契約が成立しない。
      // checksum は transaction 外で事前計算（MLR r2 MiniMax-3/GLM 指摘:
      // transaction 保持中の Promise 解決・Hermes scheduling 依存を排除）
      const checksum = await adapter.checksumOfAsync(m.up);
      const appliedAt = new Date().toISOString();
      await adapter.runInTransaction(db, async (tx) => {
        await adapter.execBatch(tx, [m.up]);
        await adapter.recordMigrationApplied(tx, {
          version: m.version,
          name: m.name,
          applied_at: appliedAt,
          checksum: checksum,
        });
      });
    }
  },
};