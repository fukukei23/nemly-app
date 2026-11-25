/**
 * Nemly Repository テスト
 *
 * 複製元構造: microwin-app src/lib/__tests__/repository.test.ts（構造継承）
 * 責務: Nemly ドメイン CRUD の InMemory 実装検証
 */

import {
  insertSession,
  listSessions,
  getSessionStages,
  deleteSession,
  countSessions,
  _resetRepositoryForTest,
  _setRepositoryForTest,
  saveImportArtifacts,
  getVerdictByNativeId,
  countAmplitudeSamples,
  InMemoryRepository,
  type SessionRecord,
  type SleepStageRow,
  type Repository,
  type VerdictRecord,
} from "../repository";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    startMs: 1792867680000,
    endMs: 1792899480000,
    sampleCount: 2880,
    deepRatio: 0.2,
    lightRatio: 0.6,
    remRatio: 0.13,
    awakeRatio: 0.01,
    score: 82,
    source: "activity_txt",
    createdAt: "2026-10-25T03:48:00.000Z",
    ...overrides,
  };
}

function makeStages(count: number, startMs = 1792867680000, stepMs = 10_000): SleepStageRow[] {
  const phases: SleepStageRow["phase"][] = ["LIGHT", "DEEP", "REM", "AWAKE"];
  return Array.from({ length: count }, (_, i) => ({
    tsMs: startMs + i * stepMs,
    phase: phases[i % phases.length],
  }));
}

describe("Nemly Repository (InMemory)", () => {
  beforeEach(() => {
    _resetRepositoryForTest();
  });

  test("insertSession が採番 id を返し countSessions が 1 になる", async () => {
    const id = await insertSession(makeSession(), makeStages(4));
    expect(id).toBe(1);
    expect(await countSessions()).toBe(1);
  });

  test("連続 insert で id が重複しない", async () => {
    const id1 = await insertSession(makeSession(), makeStages(2));
    const id2 = await insertSession(makeSession(), makeStages(2));
    expect(id1).not.toBe(id2);
    expect(await countSessions()).toBe(2);
  });

  test("listSessions は開始時刻の降順（新しい晩が先頭）", async () => {
    const earlier = 1792867680000;
    const later = earlier + 86_400_000;
    await insertSession(makeSession({ startMs: earlier }), []);
    await insertSession(makeSession({ startMs: later }), []);
    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].startMs).toBe(later);
    expect(sessions[1].startMs).toBe(earlier);
  });

  test("listSessions の結果に id が付与される", async () => {
    await insertSession(makeSession(), []);
    const sessions = await listSessions();
    expect(sessions[0].id).toBe(1);
  });

  test("getSessionStages は ts 昇順で返す", async () => {
    const stages = [
      { tsMs: 3000, phase: "LIGHT" as const },
      { tsMs: 1000, phase: "DEEP" as const },
      { tsMs: 2000, phase: "REM" as const },
    ];
    const id = await insertSession(makeSession(), stages);
    const loaded = await getSessionStages(id);
    expect(loaded.map((s) => s.tsMs)).toEqual([1000, 2000, 3000]);
  });

  test("getSessionStages は同一 ts の重複を排除する（UNIQUE INDEX 相当）", async () => {
    const id = await insertSession(makeSession(), [
      { tsMs: 1000, phase: "DEEP" },
      { tsMs: 1000, phase: "LIGHT" },
      { tsMs: 2000, phase: "REM" },
    ]);
    const loaded = await getSessionStages(id);
    expect(loaded).toHaveLength(2);
  });

  test("getSessionStages は存在しない id で空配列を返す", async () => {
    expect(await getSessionStages(999)).toEqual([]);
  });

  test("deleteSession は session と stages の両方を消す", async () => {
    const id = await insertSession(makeSession(), makeStages(4));
    expect(await countSessions()).toBe(1);
    expect((await getSessionStages(id)).length).toBe(4);
    await deleteSession(id);
    expect(await countSessions()).toBe(0);
    expect(await getSessionStages(id)).toEqual([]);
  });

  test("deleteSession は存在しない id でも例外を出さない（冪等）", async () => {
    await expect(deleteSession(999)).resolves.toBeUndefined();
  });

  test("stages 空配列の insertSession が許容される（メタデータのみ保存）", async () => {
    const id = await insertSession(makeSession(), []);
    expect(await getSessionStages(id)).toEqual([]);
    expect(await countSessions()).toBe(1);
  });

  test("_setRepositoryForTest で差し替えた実装が使われる", async () => {
    const calls: string[] = [];
    const spyRepo: Repository = {
      insertSession: async (s, stages) => {
        calls.push("insert");
        return 42;
      },
      listSessions: async () => {
        calls.push("list");
        return [];
      },
      getSessionStages: async () => [],
      deleteSession: async () => {
        calls.push("delete");
      },
      countSessions: async () => {
        calls.push("count");
        return 7;
      },
      getSessionIdByNativeId: async () => null,
      saveImportArtifacts: async () => {},
      getVerdictByNativeId: async () => null,
      countAmplitudeSamples: async () => 0,
    };
    _setRepositoryForTest(spyRepo);
    const id = await insertSession(makeSession(), []);
    expect(id).toBe(42);
    expect(await countSessions()).toBe(7);
    expect(calls).toEqual(["insert", "count"]);
  });
});

function makeVerdict(overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  return {
    nativeSessionId: "s-1000",
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

describe("saveImportArtifacts（v4・InMemory）", () => {
  beforeEach(() => {
    _resetRepositoryForTest();
    _setRepositoryForTest(new InMemoryRepository());
  });

  it("初回保存で verdict 1 行・amplitude 窓数行が書かれる", async () => {
    const samples = [
      { tsMs: 1000, amplitude: 0.005, quality: 0 as const },
      { tsMs: 11000, amplitude: 0.5, quality: 1 as const },
    ];
    await saveImportArtifacts(makeVerdict(), samples);
    expect(await getVerdictByNativeId("s-1000")).toEqual(makeVerdict());
    expect(await countAmplitudeSamples("s-1000")).toBe(2);
  });

  it("再保存（同一内容）で行数不変・全カラム値不変〔judged_at を含む＝IGNORE 化の検証・MLR r2 glm#1〕", async () => {
    const v1 = makeVerdict();
    const samples = [{ tsMs: 1000, amplitude: 0.005, quality: 0 as const }];
    await saveImportArtifacts(v1, samples);
    const afterFirst = await getVerdictByNativeId("s-1000");
    // 再 import（judged_at が変わる＝非決定カラム）
    await saveImportArtifacts(makeVerdict({ judgedAt: "2026-11-25T12:00:00.000Z" }), samples);
    const afterSecond = await getVerdictByNativeId("s-1000");
    expect(afterSecond).toEqual(afterFirst); // judged_at 含め全カラム不変
    expect(await countAmplitudeSamples("s-1000")).toBe(1); // INSERT OR IGNORE で増えない
  });

  it("値不一致の再保存（verdict 値が違う）で上書きせず既存を保持する〔RM-2〕", async () => {
    await saveImportArtifacts(makeVerdict({ verdict: "pass" }), [
      { tsMs: 1000, amplitude: 0.005, quality: 0 as const },
    ]);
    await saveImportArtifacts(makeVerdict({ verdict: "fail", reasons: ["x"] }), [
      { tsMs: 1000, amplitude: 0.005, quality: 0 as const },
    ]);
    const v = await getVerdictByNativeId("s-1000");
    expect(v?.verdict).toBe("pass"); // 初回が保持される
  });

  it("部分保存が起こらない（トランザクション 2 値化の契約・InMemory では単一操作）", async () => {
    // InMemory 実装は単一の同期的操作のため partial commit は構造的に発生しない。
    // このテストは「saveImportArtifacts 1 呼び出しで両方が書かれるか・両方書かれないか」を検証する。
    await saveImportArtifacts(makeVerdict(), []);
    expect(await getVerdictByNativeId("s-1000")).not.toBeNull();
    expect(await countAmplitudeSamples("s-1000")).toBe(0); // samples 空でも verdict は書かれる
  });
});
