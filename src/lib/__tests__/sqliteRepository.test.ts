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
import {
  _setRepositoryForTest,
  _resetRepositoryForTest,
  insertSession,
  DuplicateNativeSessionError,
  type VerdictRecord,
} from "../repository";
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
      if (sql.includes("INSERT OR IGNORE INTO sensor_verdicts")) {
        if (!tables["sensor_verdicts"]) tables["sensor_verdicts"] = [];
        const [nativeSessionId] = params;
        // PRIMARY KEY(native_session_id) の模擬: 既存行は INSERT OR IGNORE 契約で無視
        // （CHECK 違反含め INSERT OR IGNORE は制約違反行を黙ってスキップする SQLite 契約・
        //  2 値化テストの失敗注入は db.runAsync モックで行う）
        if (tables["sensor_verdicts"].some((r: any) => r.native_session_id === nativeSessionId)) {
          return {};
        }
        tables["sensor_verdicts"].push({
          native_session_id: params[0],
          started_at_ms: params[1],
          ended_at_ms: params[2],
          end_reason: params[3],
          verdict: params[4],
          reasons_json: params[5],
          stationary_rate: params[6],
          sleep_window_stationary_rate: params[7],
          stationary_gate_active: params[8],
          nan_rate: params[9],
          valid_ratio: params[10],
          expected_windows: params[11],
          actual_windows: params[12],
          judged_at: params[13],
        });
        return {};
      }
      if (sql.includes("INSERT OR IGNORE INTO amplitude_samples")) {
        if (!tables["amplitude_samples"]) tables["amplitude_samples"] = [];
        const [sessionId, tsMs, amplitude, quality] = params;
        // PRIMARY KEY(session_id, ts_ms) の模擬: 重複は INSERT OR IGNORE 契約で無視
        if (
          tables["amplitude_samples"].some(
            (r: any) => r.session_id === sessionId && r.ts_ms === tsMs
          )
        ) {
          return {};
        }
        tables["amplitude_samples"].push({ session_id: sessionId, ts_ms: tsMs, amplitude, quality });
        return {};
      }
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
          valid_ratio: params[10],
          gap_count: params[11],
          end_reason: params[12],
          native_session_id: params[13],
        });
        return { lastInsertRowId: id };
      }
      if (sql.includes("INSERT OR IGNORE INTO sleep_stages")) {
        if (!tables["sleep_stages"]) tables["sleep_stages"] = [];
        const [sessionId, tsMs, phase] = params;
        // UNIQUE(session_id, ts_ms) の模擬: 重複 ts は INSERT を無視（OR IGNORE 契約）
        if (
          tables["sleep_stages"].some(
            (r: any) => r.session_id === sessionId && r.ts_ms === tsMs
          )
        ) {
          return {};
        }
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
      if (sql.includes("FROM sensor_verdicts WHERE native_session_id = ?")) {
        return (tables["sensor_verdicts"] ?? []).filter(
          (r: any) => r.native_session_id === params[0]
        );
      }
      if (sql.includes("WHERE native_session_id = ?")) {
        return (tables["sleep_sessions"] ?? []).filter(
          (r: any) => r.native_session_id === params[0]
        );
      }
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
    async getFirstAsync(sql: string, params: any[] = []) {
      if (sql.includes("SELECT * FROM sensor_verdicts")) {
        const sessionId = params[0];
        return (
          (tables["sensor_verdicts"] ?? []).find(
            (r: any) => r.native_session_id === sessionId
          ) ?? null
        );
      }
      if (sql.includes("COUNT(*) AS n FROM amplitude_samples")) {
        const sessionId = params[0];
        return {
          n: (tables["amplitude_samples"] ?? []).filter(
            (r: any) => r.session_id === sessionId
          ).length,
        };
      }
      if (sql.includes("COUNT(*)")) {
        return { n: (tables["sleep_sessions"] ?? []).length };
      }
      return null;
    },
    async withExclusiveTransactionAsync(fn: (tx: any) => Promise<any>) {
      txStats.beginCalls++;
      // rollback 模擬: tx 内で throw したら、tx 開始前の全テーブル状態に巻き戻す
      // （実機 expo-sqlite の withExclusiveTransactionAsync は例外時に自動 rollback する契約）
      const snapshot = JSON.parse(JSON.stringify(tables));
      const txProxy = {
        runAsync: (...args: any[]) => {
          txStats.committed++;
          return db.runAsync(...args);
        },
        getFirstAsync: (...args: any[]) => db.getFirstAsync(...args),
      };
      let committed = false;
      try {
        const result = await fn(txProxy);
        committed = true;
        return result;
      } finally {
        if (!committed) {
          for (const k of Object.keys(tables)) delete tables[k];
          Object.assign(tables, snapshot);
        }
      }
    },
  };
  return db;
}

describe("SQLiteRepository (migration framework 経由)", () => {
  test("constructor で migrationRunner が走り v1+v2+v3+v4 が適用される（新規 DB）", async () => {
    const db = makeFakeDb(0);
    const adapter = createFakeAdapter();
    const repo = new SQLiteRepository(db, adapter);
    await repo.countSessions(); // ready 待ちを兼ねる
    expect(await adapter.getUserVersion(db)).toBe(4);
    const rows = await adapter.getMigrations(db);
    expect(rows).toHaveLength(4);
    expect(rows[0].version).toBe(1);
    expect(rows[1].version).toBe(2);
    expect(rows[2].version).toBe(3);
    expect(rows[3].version).toBe(4);
  });

  test("同一 native_session_id の再 insert は DuplicateNativeSessionError（spec §6①③・UNIQUE 冪等）", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    const session = makeSession({ nativeSessionId: "s-dup-1" });
    const id = await repo.insertSession(session, []);
    expect(id).toBeGreaterThan(0);
    await expect(repo.insertSession(session, [])).rejects.toThrow(
      DuplicateNativeSessionError
    );
    // 事前照合: 既存行が返る
    expect(await repo.getSessionIdByNativeId("s-dup-1")).toBe(id);
    expect(await repo.getSessionIdByNativeId("s-not-exist")).toBeNull();
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

  test("同一 ts の stages 重複は UNIQUE INDEX 契約で INSERT OR IGNORE される（MLR r1 GLM 指摘）", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    const id = await repo.insertSession(makeSession(), [
      { tsMs: 1792867680000, phase: "DEEP" },
      { tsMs: 1792867680000, phase: "LIGHT" },
      { tsMs: 1792867690000, phase: "REM" },
    ]);
    const stages = await repo.getSessionStages(id);
    expect(stages).toHaveLength(2);
  });

  test("deleteSession 内で stages DELETE が失敗すると例外が伝播する（tx 契約・MLR r2 MiniMax 指摘）", async () => {
    const db = makeFakeDb(0);
    const repo = new SQLiteRepository(db, createFakeAdapter());
    const id = await repo.insertSession(makeSession(), makeStages());
    const origRunAsync = db.runAsync.bind(db);
    db.runAsync = async (sql: string, params: any[]) => {
      if (sql.includes("DELETE FROM sleep_stages")) {
        throw new Error("stages DELETE 失敗");
      }
      return origRunAsync(sql, params);
    };
    // tx 内 throw で例外伝播（fake は rollback をシミュレートしない・実機 rollback 実測は起票済みタスク）
    await expect(repo.deleteSession(id)).rejects.toThrow("stages DELETE 失敗");
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
      if (sql.includes("INSERT OR IGNORE INTO sleep_stages")) {
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

  test("初期化失敗時も singleton が解除され再試行される（MLR r1 glm#2）", async () => {
    const { openDatabaseAsync } = require("expo-sqlite");
    (openDatabaseAsync as jest.Mock).mockReset();
    (openDatabaseAsync as jest.Mock).mockRejectedValueOnce(new Error("一時的失敗"));
    (openDatabaseAsync as jest.Mock).mockImplementation(async () => makeFakeDb(0));
    const fake = createFakeAdapter();
    await expect(initializeSqliteRepositoryAsync("nemly.db", fake)).rejects.toThrow(
      "一時的失敗"
    );
    // 失敗がキャッシュされていないことの証明: 2回目の呼出で openDatabaseAsync が再実行される
    await initializeSqliteRepositoryAsync("nemly.db", fake);
    expect(openDatabaseAsync).toHaveBeenCalledTimes(2);
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

function makeVerdict(overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return {
    nativeSessionId: "s-v4",
    startedAtMs: 1_795_542_057_315,
    endedAtMs: 1_795_574_777_315,
    endReason: "user_stop",
    verdict: "pass",
    reasons: [],
    stationaryRate: 0.738,
    sleepWindowStationaryRate: 0.738,
    stationaryGateActive: true,
    nanRate: 0,
    validRatio: 1,
    expectedWindows: 3272,
    actualWindows: 3272,
    judgedAt: "2026-11-25T02:46:19.140Z",
    ...overrides,
  };
}

describe("saveImportArtifacts（v4）", () => {
  it("単一トランザクションで sensor_verdicts 1 行・amplitude_samples 窓数行が書かれる", async () => {
    const db = makeFakeDb(0);
    const sqliteRepo = new SQLiteRepository(db, createFakeAdapter());
    const v = makeVerdict();
    await sqliteRepo.saveImportArtifacts(v, [
      { tsMs: 1000, amplitude: 0.005, quality: 0 },
      { tsMs: 11000, amplitude: 0.5, quality: 1 },
    ]);
    const vRow = await sqliteRepo.getVerdictByNativeId(v.nativeSessionId);
    expect(vRow?.verdict).toBe("pass");
    expect(await sqliteRepo.countAmplitudeSamples(v.nativeSessionId)).toBe(2);
    // 単一 tx 契約: withExclusiveTransactionAsync 1 回で全部書かれる
    expect(db.txStats.beginCalls).toBe(1);
  });

  it("再保存で judged_at を含む全カラムが不変（INSERT OR IGNORE・r2 glm#1）", async () => {
    const db = makeFakeDb(0);
    const sqliteRepo = new SQLiteRepository(db, createFakeAdapter());
    const v = makeVerdict();
    await sqliteRepo.saveImportArtifacts(v, [{ tsMs: 1000, amplitude: 0.005, quality: 0 }]);
    const first = await sqliteRepo.getVerdictByNativeId(v.nativeSessionId);
    await sqliteRepo.saveImportArtifacts(
      { ...v, judgedAt: "2026-11-26T00:00:00.000Z" },
      [{ tsMs: 1000, amplitude: 0.005, quality: 0 }]
    );
    const second = await sqliteRepo.getVerdictByNativeId(v.nativeSessionId);
    expect(second).toEqual(first);
  });

  it("トランザクション 2 値化: verdicts 書込失敗を注入した場合 amplitudes も rollback される", async () => {
    // sensor_verdicts INSERT で例外を注入して SQL 失敗を起こす（既存 tx 契約テストと同一パターン・
    // ※ INSERT OR IGNORE は CHECK 違反を黙ってスキップするため CHECK 注入は失敗にならない）
    const db = makeFakeDb(0);
    const sqliteRepo = new SQLiteRepository(db, createFakeAdapter());
    const origRunAsync = db.runAsync.bind(db);
    db.runAsync = async (sql: string, params: any[]) => {
      if (sql.includes("INSERT OR IGNORE INTO sensor_verdicts")) {
        throw new Error("sensor_verdicts INSERT 失敗");
      }
      return origRunAsync(sql, params);
    };
    const bad = makeVerdict();
    await expect(
      sqliteRepo.saveImportArtifacts(bad, [{ tsMs: 1000, amplitude: 0.005, quality: 0 }])
    ).rejects.toThrow("sensor_verdicts INSERT 失敗");
    // rollback 検証: amplitudes も 0 行であること（部分書込ゼロ）
    expect(await sqliteRepo.countAmplitudeSamples(makeVerdict().nativeSessionId)).toBe(0);
    expect(await sqliteRepo.getVerdictByNativeId(makeVerdict().nativeSessionId)).toBeNull();
  });
});
