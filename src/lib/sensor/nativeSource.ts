/**
 * ネイティブモジュールを SensorSeriesSource 契約へ適合させるアダプタ
 * （spec §3・遅延 require のため jest からは呼ばない・FakeSensor が jest 用の実装）
 */
import type { SensorSeriesSource } from "./sensorImport";

type NativeModule = {
  startRecording(durationMinutes?: number): string;
  stopRecording(): string;
  pullSeries(sessionId: string): Promise<string>;
  confirmImported(sessionId: string): string;
  getStatus(): string;
  getLastSessionId(): string;
  getPendingSessionId(): string;
};

function loadNative(): NativeModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../../modules/nemly-sensor/index") as {
    default: NativeModule;
  };
  return mod.default;
}

export function createNativeSensorSource(): SensorSeriesSource {
  const native = loadNative();
  return {
    async pullSeries() {
      // 未取り込み（finished）セッションを優先（起動時取り込み・2026-11-03）・なければ直近セッション
      const sessionId = native.getPendingSessionId() || native.getLastSessionId();
      const json = await native.pullSeries(sessionId);
      const parsed = JSON.parse(json) as {
        samples: import("./types").SensorSample[];
        meta: import("./types").SeriesMeta;
      };
      return { samples: parsed.samples, meta: parsed.meta };
    },
    async confirmImported(sessionId: string) {
      native.confirmImported(sessionId);
    },
  };
}

export function nativeGetPendingSessionId(): string {
  return loadNative().getPendingSessionId();
}

export function nativeStartRecording(durationMinutes?: number): string {
  return loadNative().startRecording(durationMinutes);
}

export function nativeStopRecording(): string {
  return loadNative().stopRecording();
}

export function nativeGetStatus(): string {
  return loadNative().getStatus();
}
