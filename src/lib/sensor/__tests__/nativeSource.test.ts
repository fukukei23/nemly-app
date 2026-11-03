import {
  createNativeSensorSource,
  nativeAcquireLease,
  nativeGetLastSessionId,
  nativeGetPendingSessionId,
  nativeGetStatus,
  nativeIsImporting,
  nativeReleaseLease,
  nativeStartRecording,
  nativeStopRecording,
  type NativeModule,
} from "../nativeSource";

function fakeNative(overrides: Partial<NativeModule> = {}): NativeModule {
  return {
    startRecording: () => "started",
    stopRecording: () => "idle",
    pullSeries: async () =>
      JSON.stringify({
        samples: [{ tsMs: 1000, amplitude: 0.1, quality: 1, eventCount: 60 }],
        meta: {
          sessionId: "s-1",
          startedAtMs: 900,
          endedAtMs: 2000,
          endReason: "user_stop",
          status: "finished",
        },
      }),
    confirmImported: () => "ok",
    getStatus: () => '{"status":"finished:s-1"}',
    getLastSessionId: () => "s-last",
    getPendingSessionId: () => "s-pending",
    acquireLease: () => 1,
    releaseLease: () => true,
    isImporting: () => false,
    ...overrides,
  };
}

test("pullSeries は pending セッションを優先して取得する", async () => {
  const pulled: string[] = [];
  const native = fakeNative({
    pullSeries: async (sid: string) => {
      pulled.push(sid);
      return JSON.stringify({
        samples: [],
        meta: { sessionId: sid, startedAtMs: 0, endedAtMs: 1, endReason: "x", status: "finished" },
      });
    },
  });
  const source = createNativeSensorSource(native);
  await source.pullSeries();
  expect(pulled).toEqual(["s-pending"]);
});

test("pending が無ければ lastSessionId にフォールバックする", async () => {
  const pulled: string[] = [];
  const native = fakeNative({
    getPendingSessionId: () => "",
    pullSeries: async (sid: string) => {
      pulled.push(sid);
      return JSON.stringify({
        samples: [],
        meta: { sessionId: sid, startedAtMs: 0, endedAtMs: 1, endReason: "x", status: "finished" },
      });
    },
  });
  const source = createNativeSensorSource(native);
  await source.pullSeries();
  expect(pulled).toEqual(["s-last"]);
});

test("meta.sessionId が無い応答は明示例外になる（purgeSession(undefined) 崩れ防止）", async () => {
  const native = fakeNative({
    pullSeries: async () => JSON.stringify({ samples: [], meta: {} }),
  });
  const source = createNativeSensorSource(native);
  await expect(source.pullSeries()).rejects.toThrow(/no meta.sessionId/);
});

test("confirmImported はネイティブの confirmImported を呼ぶ", async () => {
  const confirmed: string[] = [];
  const native = fakeNative({
    confirmImported: (sid: string) => {
      confirmed.push(sid);
      return "ok";
    },
  });
  const source = createNativeSensorSource(native);
  await source.confirmImported("s-9");
  expect(confirmed).toEqual(["s-9"]);
});

test("samples と meta がそのまま返る（変換なし）", async () => {
  const native = fakeNative();
  const source = createNativeSensorSource(native);
  const res = await source.pullSeries();
  expect(res.samples).toHaveLength(1);
  expect(res.meta.sessionId).toBe("s-1");
  expect(res.meta.status).toBe("finished");
});

test("各 parking wrapper はネイティブの該当メソッドへ委譲する", () => {
  const calls: string[] = [];
  const native = fakeNative({
    startRecording: (m?: number) => {
      calls.push(`start:${m}`);
      return "started";
    },
    stopRecording: () => {
      calls.push("stop");
      return "idle";
    },
    getStatus: () => {
      calls.push("status");
      return '{"status":"idle"}';
    },
    getLastSessionId: () => {
      calls.push("last");
      return "s-last";
    },
    getPendingSessionId: () => {
      calls.push("pending");
      return "s-pending";
    },
    acquireLease: () => {
      calls.push("acquire");
      return 7;
    },
    releaseLease: (t: number) => {
      calls.push(`release:${t}`);
      return true;
    },
    isImporting: () => {
      calls.push("isImporting");
      return true;
    },
  });
  expect(nativeStartRecording(30, native)).toBe("started");
  expect(nativeStopRecording(native)).toBe("idle");
  expect(nativeGetStatus(native)).toBe('{"status":"idle"}');
  expect(nativeGetLastSessionId(native)).toBe("s-last");
  expect(nativeGetPendingSessionId(native)).toBe("s-pending");
  expect(nativeAcquireLease(native)).toBe(7);
  expect(nativeReleaseLease(7, native)).toBe(true);
  expect(nativeIsImporting(native)).toBe(true);
  expect(calls).toEqual([
    "start:30",
    "stop",
    "status",
    "last",
    "pending",
    "acquire",
    "release:7",
    "isImporting",
  ]);
});
