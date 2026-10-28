import { importSensorSession, type SensorSeriesSource } from "../sensorImport";
import { generateSyntheticSeries } from "../fakeSensor";
import {
  _resetRepositoryForTest,
  listSessions,
} from "@/lib/repository";

const START = 1_700_000_000_000;

function fakeSource(windows: number, gapWindows?: number[]): SensorSeriesSource {
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
    async confirmImported() {
      /* purge 呼び出しのスタブ */
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

  it("fail 系列（20分超欠損）→ 保存せず verdict を返す（immutable failed）", async () => {
    const res = await importSensorSession(
      fakeSource(300, Array.from({ length: 125 }, (_, i) => i + 50))
    );
    expect(res.verdict).toBe("fail");
    expect(res.sessionId).toBeNull();
    expect(await listSessions()).toHaveLength(0);
  });

  it("degraded 系列（30分以内の短欠損）→ 保存する（verdict=degraded_pass）", async () => {
    const res = await importSensorSession(fakeSource(100, [40, 41, 42]));
    expect(res.verdict).toBe("degraded_pass");
    expect(res.sessionId).toBeGreaterThan(0);
    expect(res.reasons.some((s) => s.includes("short_gap"))).toBe(true);
  });
});
