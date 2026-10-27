/**
 * SQLiteRepository テスト（Nemly）
 *
 * 複製元構造: microwin-app src/lib/__tests__/sqliteRepository.test.ts（構造継承）
 * 責務:
 * - SQLiteRepository が migration framework 経由で初期化されること
 * - insertSession の単一 tx 契約（stages 失敗で session も rollback）
 * - 並行実行防御: initializeSqliteRepositoryAsync を複数回呼んでも open は 1 回
 *
 * jest 環境では expo-sqlite native module が動かないため、
 * db は FakeAdapter 契約を満たす in-memory db、adapter は createFakeAdapter を注入する。
 */

import {
  SQLiteRepository,
  initializeSqliteRepositoryAsync,
  _resetSqliteInitForTest,
} from "../sqliteRepository";
import { createFakeAdapter } from "../migration/sqliteAdapter";
import { _setRepositoryForTest, _resetRepositoryForTest, insertSession } from "../repository";
import type { SessionRecord, SleepStageRow } from "../repository";

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(),
}));

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    startMs: 1792867680000,
    endMs: 1792899480000,
    sampleCount: 4,
    deepRatio: 0.25,
    lightRatio: 0.5,
    remRatio: 0.25,
    awakeRatio: 0,
    score: 67,
    source: "activity_txt",
    createdAt: "2026-10-25T03:48:00.000Z",
    ...overrides,
  };
}

function makeStages(): SleepStageRow[] {
  return [
    { tsMs: 1792867680000, phase: "DEEP" },
    { tsMs: 1792867690000, phase: "LIGHT" },
    { tsMs: 1792867700000, phase: "REM" },
    { tsMs: 1792867710000, phase: "AWAKE" },
  ];
}

/** FakeAdapter 契約 + expo-sqlite CRUD API 表面を満たす in-memory db */
function makeFakeDb(userVersion = 0): any {
  const tables: Record<string, any[]> = {};
  let nextSessionId = 1;
  const txStats = { beginCalls: 0, committed: 0 };
  const db: any = {
    __user_version__: userVersion,
    __tables__: tables,
    __executed_sqls__: [] as string[],
    txStats,
    async runAsync(sql: string, params: any[] = []) {
      if (sql.includes("INSERT INTO sleep_sessions")) {
        if (!tables["sleep_sessions"]) tables["sleep_sessions"] = [];
        const id = nextSessionId++;
        tables["sleep_sessions"].push({
          id,
          start_ms: params[0],
          end_ms: params[1],
          sample_count: params[2],
          deep_ratio: params[3],
          light_ratio: params[4],
          rem_ratio: params[5],
          awake_ratio: params[6],
          score: params[7],
          source: params[8],
          created_at: params[9],
        });
        return { lastInsertRowId: id };
      }
      if (sql.includes("INSERT INTO sleep_stages")) {
        if (!tables["sleep_stages"]) tables["sleep_stages"] = [];
        const [sessionId, tsMs, phase] = params;
        tables["sleep_stages"].push({ session_id: sessionId, ts_ms: tsMs, phase });
        return {};
      }
      if (sql.includes("DELETE FROM sleep_stages")) {
        const sessionId = params[0];
        tables["sleep_stages"] = (tables["sleep_stages"] ?? []).filter(
          (r: any) => r.session_id !== sessionId
        );
        return {};
      }
      if (sql.includes("DELETE FROM sleep_sessions")) {
        const sessionId = params[0];
        tables["sleep_sessions"] = (tables["sleep_sessions"] ?? []).filter(
          (r: any) => r.id !== sessionId
        );
        return {};
      }
      return {};
    },
    async getAllAsync(sql: string, params: any[] = []) {
      if (sql.includes("FROM sleep_sessions ORDER BY start_ms DESC")) {
        return [...(tables["sleep_sessions"] ?? [])].sort(
          (a: any, b: any) => b.start_ms - a.start_ms
        );
      }
      if (sql.includes("FROM sleep_stages WHERE session_id")) {
        const sessionId = params[0];
        return (tables["sleep_stages"] ?? [])
          .filter((r: any) => r.session_id === sessionId)
          .sort((a: any, b: any) => a.ts_ms - b.ts_ms)
          .map((r: any) => ({ ts_ms: r.ts_ms, phase: r.phase }));
      }
      return [];
    },
    async getFirstAsync(sql: string) {
      if (sql.includes("COUNT(*)")) {
        return { n: (tables["sleep_sessions"] ?? []).length };
      }
      return null;
    },
    async withExclusiveTransactionAsync(fn: (tx: any) => Promise<any>) {
      txStats.beginCalls++;
      const txProxy = {
        runAsync: (...args: any[]) => {
          txStats.committed++;
          return db.runAsync(...args);
        },
      };
      return fn(txProxy);
    },
  };
  return db;
}

describe("SQLiteRepository (migration framework 経由)", () => {
  test("constructor で migrationRunner が走り v1 が適用される（新規 DB）", async () => {
    const db = makeFakeDb(0);
    const adapter = createFakeAdapter();
    const repo = new SQLiteRepository(db, adapter);
    await repo.countSessions(); // ready 待ちを兼ねる
    expect(await adapter.getUserVersion(db)).toBe(1);
    const rows = await adapter.getMigrations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
  });

  test("insertSession → listSessions → getSessionStages → deleteSession が一連で動く", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    const id = await repo.insertSession(makeSession(), makeStages());
    expect(id).toBe(1);

    const sessions = await repo.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].score).toBe(67);

    const stages = await repo.getSessionStages(id);
    expect(stages).toHaveLength(4);
    expect(stages.map((s) => s.phase)).toEqual(["DEEP", "LIGHT", "REM", "AWAKE"]);

    expect(await repo.countSessions()).toBe(1);
    await repo.deleteSession(id);
    expect(await repo.countSessions()).toBe(0);
    expect(await repo.getSessionStages(id)).toEqual([]);
  });

  test("insertSession は単一 tx 内で session+stages を保存する", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    await repo.insertSession(makeSession(), makeStages());
    // session INSERT + 4 stages INSERT が同一 tx 契約（withExclusiveTransactionAsync 1回）内
    expect(db.txStats.beginCalls).toBe(1);
    expect(db.txStats.committed).toBe(5); // 1 session + 4 stages
  });

  test("stages INSERT 失敗時は tx 契約により例外が伝播する（部分保存検知の基礎）", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    const origRunAsync = db.runAsync.bind(db);
    db.runAsync = async (sql: string, params: any[]) => {
      if (sql.includes("INSERT INTO sleep_stages")) {
        throw new Error("stages INSERT 失敗");
      }
      return origRunAsync(sql, params);
    };
    // fake は rollback をシミュレートしないが・tx 内 throw で例外伝播することを確認
    await expect(repo.insertSession(makeSession(), makeStages())).rejects.toThrow(
      "stages INSERT 失敗"
    );
  });
});

describe("並行実行防御 (複製元 MLR r3 GLM-1 を踏襲)", () => {
  beforeEach(() => {
    _resetSqliteInitForTest();
    _resetRepositoryForTest();
  });

  test("initializeSqliteRepositoryAsync を 2 回呼んでも openDatabaseAsync は 1 回", async () => {
    const { openDatabaseAsync } = require("expo-sqlite");
    (openDatabaseAsync as jest.Mock).mockReset();
    (openDatabaseAsync as jest.Mock).mockImplementation(async () => makeFakeDb(0));
    const fake = createFakeAdapter();
    await Promise.all([
      initializeSqliteRepositoryAsync("nemly.db", fake),
      initializeSqliteRepositoryAsync("nemly.db", fake),
    ]);
    await initializeSqliteRepositoryAsync("nemly.db", fake);
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  test("初期化後、repository.ts の activeRepository が SQLiteRepository に差し替わる", async () => {
    const { openDatabaseAsync } = require("expo-sqlite");
    (openDatabaseAsync as jest.Mock).mockReset();
    (openDatabaseAsync as jest.Mock).mockImplementation(async () => makeFakeDb(0));
    await initializeSqliteRepositoryAsync("nemly.db", createFakeAdapter());
    // 差し替え後の repository が動くこと（InMemory でなく SQLite 側の処理が走る）
    const id = await insertSession(makeSession(), []);
    expect(id).toBe(1);
  });
});
