import { importSensorSession, type SensorSeriesSource } from "../sensorImport";
import { generateSyntheticSeries } from "../fakeSensor";
import {
  _resetRepositoryForTest,
  listSessions,
  getVerdictByNativeId,
  countAmplitudeSamples,
} from "@/lib/repository";

const START = 1_700_000_000_000;

function fakeSource(
  windows: number,
  gapWindows?: number[],
  confirmed: string[] = [],
  failMarked: string[] = []
): SensorSeriesSource {
  const r = generateSyntheticSeries({ startMs: START, windows, gapWindows });
  return {
    async pullSeries() {
      return {
        samples: r.samples,
        meta: {
          sessionId: "s-test-1",
          startedAtMs: START,
          endedAtMs: START + windows * 10_000,
          endReason: "user_stop",
          status: "finished" as const,
        },
      };
    },
    async markImporting() {
      return true;
    },
    async confirmImported() {
      confirmed.push("s-test-1");
      return true;
    },
    async markImportFailed() {
      failMarked.push("s-test-1");
      return true;
    },
  };
}

describe("importSensorSession", () => {
  beforeEach(() => {
    _resetRepositoryForTest();
  });

  it("pass 系列 → 解析+保存（source=sensor・60窓）", async () => {
    const res = await importSensorSession(fakeSource(60));
    expect(res.verdict).toBe("pass");
    expect(res.sessionId).toBeGreaterThan(0);
    const all = await listSessions();
    expect(all[0]!.source).toBe("sensor");
    expect(all[0]!.sampleCount).toBe(60);
    expect(all[0]!.endReason).toBe("user_stop");
  });

  it("fail 系列（20分超欠損）→ 保存せず verdict を返す・markImportFailed を呼ぶ（spec §2・status=import_failed で回収対象外へ）", async () => {
    const confirmed: string[] = [];
    const failMarked: string[] = [];
    const res = await importSensorSession(
      fakeSource(
        300,
        Array.from({ length: 125 }, (_, i) => i + 50),
        confirmed,
        failMarked
      )
    );
    expect(res.verdict).toBe("fail");
    expect(res.sessionId).toBeNull();
    expect(await listSessions()).toHaveLength(0);
    expect(failMarked).toEqual(["s-test-1"]);
    expect(confirmed).toEqual([]);
  });

  it("degraded 系列（30分以内の短欠損）→ 保存する（verdict=degraded_pass）", async () => {
    const res = await importSensorSession(fakeSource(100, [40, 41, 42]));
    expect(res.verdict).toBe("degraded_pass");
    expect(res.sessionId).toBeGreaterThan(0);
    expect(res.reasons.some((s) => s.includes("short_gap"))).toBe(true);
  });

  it("空系列 → 沈黙掃除（confirmImported 呼び・sessionId=null・2026-11-03 起動時 pending 掃除用）", async () => {
    const confirmed: string[] = [];
    const source: SensorSeriesSource = {
      async pullSeries() {
        return {
          samples: [],
          meta: {
            sessionId: "s-empty",
            startedAtMs: START,
            endedAtMs: START + 600_000,
            endReason: "auto_timer",
            status: "finished" as const,
          },
        };
      },
      async markImporting() {
        return true;
      },
      async confirmImported() {
        confirmed.push("s-empty");
        return true;
      },
      async markImportFailed() {
        return true;
      },
    };
    const res = await importSensorSession(source);
    expect(res.verdict).toBe("pass");
    expect(res.sessionId).toBeNull();
    expect(res.reasons).toEqual(["empty"]);
    expect(confirmed).toEqual(["s-empty"]);
    expect(await listSessions()).toHaveLength(0);
  });
});

function makeSourceFor(
  sessionId: string,
  windows: number,
  gapWindows?: number[]
): SensorSeriesSource {
  const r = generateSyntheticSeries({ startMs: START, windows, gapWindows });
  return {
    async pullSeries() {
      return {
        samples: r.samples,
        meta: {
          sessionId,
          startedAtMs: START,
          endedAtMs: START + windows * 10_000,
          endReason: "user_stop",
          status: "finished" as const,
        },
      };
    },
    async markImporting() {
      return true;
    },
    async confirmImported() {
      return true;
    },
    async markImportFailed() {
      return true;
    },
  };
}

function makePassSource(sessionId: string): SensorSeriesSource {
  return makeSourceFor(sessionId, 60); // 欠損なし・validRatio=1
}

function makeFailSource(sessionId: string): SensorSeriesSource {
  return makeSourceFor(sessionId, 300, Array.from({ length: 125 }, (_, i) => i + 50)); // 20分超欠損=long_gap fail
}

describe("v4 統計永続化（順序契約 5a・設計 §3）", () => {
  beforeEach(() => {
    _resetRepositoryForTest();
  });

  it("pass 経路で insertSession 前に amplitudes+verdicts が書かれる〔順序契約〕", async () => {
    const source = makePassSource("s-2000");
    await importSensorSession(source);
    expect(await getVerdictByNativeId("s-2000")).not.toBeNull();
    expect(await countAmplitudeSamples("s-2000")).toBeGreaterThan(0);
    // native purge 後も UI DB に生値が残る（本設計の主効果）
  });

  it("fail 経路でも amplitudes+verdicts が書かれる（全判定保存・markImportFailed 前）", async () => {
    const source = makeFailSource("s-2001"); // 20 分超欠損で fail になる系列
    const r = await importSensorSession(source);
    expect(r.verdict).toBe("fail");
    expect((await getVerdictByNativeId("s-2001"))?.verdict).toBe("fail");
    expect(await countAmplitudeSamples("s-2001")).toBeGreaterThan(0);
  });

  it("already-imported / empty ショートカットでは書かれない", async () => {
    // 先に 1 回 import しておく
    await importSensorSession(makePassSource("s-2002"));
    const rowsBefore = await countAmplitudeSamples("s-2002");
    // pullSeries が空を返すケース（既に purge 済み）→ empty ショートカット
    const emptySource = makePassSource("s-2002");
    emptySource.pullSeries = async () => ({
      samples: [],
      meta: { sessionId: "s-2002", startedAtMs: 1, endedAtMs: 2, endReason: "user_stop", status: "finished" },
    });
    await importSensorSession(emptySource);
    expect(await countAmplitudeSamples("s-2002")).toBe(rowsBefore); // 増えない
  });

  it("catch 経路では amplitudes も verdicts も書かれない（2 値化）", async () => {
    const source = makePassSource("s-2003");
    source.markImporting = async () => {
      throw new Error("kill before artifacts"); // 5a 前に中断
    };
    await expect(importSensorSession(source)).rejects.toThrow();
    expect(await getVerdictByNativeId("s-2003")).toBeNull();
    expect(await countAmplitudeSamples("s-2003")).toBe(0);
  });

  it("kill 経路④: insertSession 後 kill → 再回収で already-imported・生値は初回に保存済み", async () => {
    const source = makePassSource("s-2004");
    // 初回: confirmImported で kill 相当（throw）→ insertSession は成功済み・artifacts も 5a で書かれている
    const originalConfirm = source.confirmImported;
    source.confirmImported = async () => {
      throw new Error("kill after insertSession");
    };
    await expect(importSensorSession(source)).rejects.toThrow();
    expect(await countAmplitudeSamples("s-2004")).toBeGreaterThan(0); // 生値は既に UI DB
    // 再回収（confirmImported を正常に戻す）→ already-imported ショートカットが走る
    source.confirmImported = originalConfirm;
    const r = await importSensorSession(source);
    expect(r.reasons).toContain("already-imported");
    // 生値は初回のまま（増えない）・verdict も初回のまま
    const n = await countAmplitudeSamples("s-2004");
    const v = await getVerdictByNativeId("s-2004");
    await importSensorSession(source);
    expect(await countAmplitudeSamples("s-2004")).toBe(n);
    expect(await getVerdictByNativeId("s-2004")).toEqual(v);
  });

  it("冪等性: 同一セッション再 import で verdicts 全カラム不変（judged_at 含む・r2 glm#1）", async () => {
    const source = makePassSource("s-2005");
    await importSensorSession(source);
    const v1 = await getVerdictByNativeId("s-2005");
    // native purge 後の再回収をシミュレート（pullSeries を空にする=already-imported 経路）
    const src2 = makePassSource("s-2005");
    src2.pullSeries = async () => ({
      samples: [],
      meta: { sessionId: "s-2005", startedAtMs: 1, endedAtMs: 2, endReason: "user_stop", status: "finished" },
    });
    await importSensorSession(src2);
    expect(await getVerdictByNativeId("s-2005")).toEqual(v1);
  });

  it("値不一致検知: 既存 verdict と異なる判定の再 import で上書きせず警告を出す〔RM-2〕", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // 初回: fail 系列で import（fail は sleep_sessions に insert されないため
    // native samples 残存=再回収可能な状態・spec §2）
    await importSensorSession(makeFailSource("s-2006"));
    const v1 = await getVerdictByNativeId("s-2006");
    // 再回収で判定が変わるケースを模擬（実機では閾値変更後の再判定等・RM-2）:
    // 同一 sessionId で pass 判定になる別系列を import する
    //（already-imported ショートカットは sleep_sessions 行がある場合のみ走るため通過）
    const betterSource = makePassSource("s-2006");
    await importSensorSession(betterSource);
    const v2 = await getVerdictByNativeId("s-2006");
    expect(v2).toEqual(v1); // 上書きされない
    expect(warnSpy).toHaveBeenCalled(); // 警告ログ
    warnSpy.mockRestore();
  });
});
