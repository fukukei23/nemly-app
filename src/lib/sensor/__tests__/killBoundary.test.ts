/**
 * kill 4境界のユニットテスト（spec §7「kill シミュレーション4境界」）
 *
 * spec: docs/superpowers/specs/2026-11-03-nemly-stop-latency-design.md §2/§6/§7
 *
 * kill の模倣方式: プロセス死は throw と異なり catch で拾われないため、
 * 「境界Nまで実行した**永続状態**」を NativeDbSimulator + repository で作り、
 * そこから「次回起動の importSensorSession 呼び出し」を実行して回収結果を検証する。
 *
 * NativeDbSimulator は Kotlin SensorDbHelper の契約をミラーする（§2 status 遷移表）:
 * - markImporting:      WHERE status IN ('finished','importing') → importing
 * - confirmImported:    WHERE status IN ('finished','importing') → imported + samples delete（CAS）
 * - markImportFailed:   WHERE status IN ('importing','finished') → import_failed
 */
import {
  importSensorSession,
  type SensorSeriesSource,
} from "../sensorImport";
import { generateSyntheticSeries } from "../fakeSensor";
import { SensorSample, SeriesMeta } from "../types";
import {
  _resetRepositoryForTest,
  _setRepositoryForTest,
  getSessionByNativeId,
  insertSession,
  listSessions,
} from "@/lib/repository";

const START = 1_700_000_000_000;
const SID = "s-kill-1";

/** Kotlin SensorDbHelper の status 遷移契約をミラーするモック */
class NativeDbSimulator implements SensorSeriesSource {
  status: "recording" | "finished" | "importing" | "imported" | "import_failed" =
    "finished";
  samples: SensorSample[];
  markImportingCalls = 0;
  confirmImportedCalls = 0;
  markImportFailedCalls = 0;

  constructor(sampleCount: number) {
    const r = generateSyntheticSeries({ startMs: START, windows: sampleCount });
    this.samples = r.samples;
  }

  async pullSeries() {
    const meta: SeriesMeta = {
      sessionId: SID,
      startedAtMs: START,
      endedAtMs: START + 600_000,
      endReason: "user_stop",
      status: this.status,
    };
    return { samples: this.samples, meta };
  }

  async markImporting(sessionId: string): Promise<boolean> {
    this.markImportingCalls++;
    if (this.status === "finished" || this.status === "importing") {
      this.status = "importing";
      return true;
    }
    return false;
  }

  async confirmImported(sessionId: string): Promise<boolean> {
    this.confirmImportedCalls++;
    if (this.status === "finished" || this.status === "importing") {
      this.status = "imported";
      this.samples = [];
      return true;
    }
    return false;
  }

  async markImportFailed(sessionId: string): Promise<boolean> {
    this.markImportFailedCalls++;
    if (this.status === "importing" || this.status === "finished") {
      this.status = "import_failed";
      return true;
    }
    return false;
  }
}

function makeSessionRecord() {
  return {
    startMs: START,
    endMs: START + 600_000,
    sampleCount: 60,
    deepRatio: 0.2,
    lightRatio: 0.5,
    remRatio: 0.2,
    awakeRatio: 0.1,
    score: 80,
    source: "sensor" as const,
    createdAt: "2026-11-15T23:00:00.000Z",
    validRatio: 1,
    gapCount: 0,
    endReason: "user_stop",
    nativeSessionId: SID,
  };
}

describe("kill 4境界（spec §7）", () => {
  beforeEach(() => {
    _resetRepositoryForTest();
  });

  it("claim前kill（import前/pull後）→ 次回回収で1セッション・二重登録0", async () => {
    // kill直後の永続状態: native status=finished・samples残存・UI DB空
    //（import前とpull後はプロセス死後の永続状態として同一・claim/insertとも未実施）
    const db = new NativeDbSimulator(60);
    expect(db.status).toBe("finished");

    const res = await importSensorSession(db);

    expect(res.verdict).toBe("pass");
    expect(res.sessionId).toBeGreaterThan(0);
    expect(await listSessions()).toHaveLength(1);
    expect(db.status).toBe("imported");
    expect(db.confirmImportedCalls).toBe(1);
    const existing = await getSessionByNativeId(SID);
    expect(existing).toBe(res.sessionId);
  });

  it("insert後kill → 次回回収で事前照合が拾い・二重登録0・既存sessionId返却", async () => {
    // kill直後の永続状態: claim済み（status=importing）・samples残存・UI DBに1行
    const db = new NativeDbSimulator(60);
    await db.markImporting(SID);
    const insertedId = await insertSession(makeSessionRecord(), []);
    expect(await listSessions()).toHaveLength(1);

    const res = await importSensorSession(db);

    expect(res.verdict).toBe("pass");
    expect(res.reasons).toEqual(["already-imported"]);
    expect(res.sessionId).toBe(insertedId);
    // 二重登録なし
    expect(await listSessions()).toHaveLength(1);
    // native 側は importing 残留→imported に遷移（CAS purge）
    expect(db.status).toBe("imported");
    expect(db.confirmImportedCalls).toBe(1);
    // 重い解析（insertSession 再実行）を経ていない: セッション数が増えていないことで担保
  });

  it("confirm後kill → claim（WHERE finished/importing）が弾き・二重登録0", async () => {
    // kill直後の永続状態: status=imported・samples空・UI DB 1行
    // getPendingSessionId（WHERE finished/importing）では検知されない=本来回収対象外。
    // 誤って importSensorSession が呼ばれても claim が弾く=安全側
    const db = new NativeDbSimulator(60);
    await db.markImporting(SID);
    await db.confirmImported(SID);
    await insertSession(makeSessionRecord(), []);

    const res = await importSensorSession(db);

    expect(res.reasons).toEqual(["claimed-by-other"]);
    expect(res.sessionId).toBeNull();
    expect(await listSessions()).toHaveLength(1);
    expect(db.confirmImportedCalls).toBe(1); // 再confirmされていない
  });

  it("同一 native_session_id 2回 import → UNIQUE冪等・sleep_sessions 1行（spec §7）", async () => {
    const db = new NativeDbSimulator(60);

    const res1 = await importSensorSession(db);
    expect(res1.verdict).toBe("pass");
    // 2回目: status=imported なので claim が弾く=回収対象にならない（正常系の冪等）
    const res2 = await importSensorSession(db);
    expect(res2.reasons).toEqual(["claimed-by-other"]);
    expect(await listSessions()).toHaveLength(1);
  });

  it("fail 判定 → markImportFailed 呼び（confirmImported は呼ばない）・UI DB 0行・samples保持", async () => {
    // 欠損大量（20分超）で fail 判定させる
    const db = new NativeDbSimulator(300);
    const r = generateSyntheticSeries({
      startMs: START,
      windows: 300,
      gapWindows: Array.from({ length: 125 }, (_, i) => i + 50),
    });
    db.samples = r.samples;

    const res = await importSensorSession(db);

    expect(res.verdict).toBe("fail");
    expect(res.sessionId).toBeNull();
    expect(await listSessions()).toHaveLength(0);
    expect(db.markImportFailedCalls).toBe(1);
    expect(db.confirmImportedCalls).toBe(0);
    expect(db.status).toBe("import_failed");
  });

  it("insertSession が非 UNIQUE 例外 → catch全体で markImportFailed + 再throw", async () => {
    const db = new NativeDbSimulator(60);
    // insertSession のみ失敗する repository に差し替え（事前照合は正常動作・null を返す）
    //→ 事前照合を通過した後の非 UNIQUE 例外が catch 全体経路を通る
    _setRepositoryForTest({
      async insertSession() {
        throw new Error("simulated db failure");
      },
      async listSessions() {
        return [];
      },
      async getSessionStages() {
        return [];
      },
      async deleteSession() {},
      async countSessions() {
        return 0;
      },
      async getSessionIdByNativeId() {
        return null;
      },
      async saveImportArtifacts() {},
      async getVerdictByNativeId() {
        return null;
      },
      async countAmplitudeSamples() {
        return 0;
      },
    });

    await expect(importSensorSession(db)).rejects.toThrow(
      "simulated db failure"
    );
    // catch 全体で markImportFailed が呼ばれる（回収対象外へ明示遷移）
    expect(db.markImportFailedCalls).toBe(1);
    expect(db.confirmImportedCalls).toBe(0);
    expect(db.status).toBe("import_failed");
  });
});
