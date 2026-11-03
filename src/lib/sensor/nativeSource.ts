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
  acquireLease(): number;
  releaseLease(token: number): boolean;
  isImporting(): boolean;
};

export type { NativeModule };

function loadNative(): NativeModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../../modules/nemly-sensor/index") as {
    default: NativeModule;
  };
  return mod.default;
}

export function createNativeSensorSource(
  native: NativeModule = loadNative(),
): SensorSeriesSource {
  return {
    async pullSeries() {
      // 未取り込み（finished）セッションを優先（起動時取り込み・2026-11-03）・なければ直近セッション
      const sessionId = native.getPendingSessionId() || native.getLastSessionId();
      const json = await native.pullSeries(sessionId);
      const parsed = JSON.parse(json) as {
        samples: import("./types").SensorSample[];
        meta: import("./types").SeriesMeta;
      };
      // MLR 2026-11-03 GLM#4/OR1#2: ネイティブ側で行不在時に meta が "{}" になる契約のため
      // sessionId 不在は明示例外にする（以降の purgeSession(undefined) 崩れ防止）
      if (!parsed.meta?.sessionId) {
        throw new Error(
          `pullSeries returned no meta.sessionId (sessionId="${sessionId}")`
        );
      }
      return { samples: parsed.samples, meta: parsed.meta };
    },
    async confirmImported(sessionId: string) {
      native.confirmImported(sessionId);
    },
  };
}

export function nativeGetPendingSessionId(native: NativeModule = loadNative()): string {
  return native.getPendingSessionId();
}

export function nativeStartRecording(
  durationMinutes?: number,
  native: NativeModule = loadNative(),
): string {
  return native.startRecording(durationMinutes);
}

export function nativeStopRecording(native: NativeModule = loadNative()): string {
  return native.stopRecording();
}

export function nativeGetStatus(native: NativeModule = loadNative()): string {
  return native.getStatus();
}

export function nativeGetLastSessionId(native: NativeModule = loadNative()): string {
  return native.getLastSessionId();
}

export function nativeAcquireLease(native: NativeModule = loadNative()): number {
  return native.acquireLease();
}

export function nativeReleaseLease(token: number, native: NativeModule = loadNative()): boolean {
  return native.releaseLease(token);
}

export function nativeIsImporting(native: NativeModule = loadNative()): boolean {
  return native.isImporting();
}
