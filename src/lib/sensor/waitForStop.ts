import { parseNativeStatus } from "./autoImport";

export const STOP_POLL_INTERVAL_MS = 200;
export const STOP_MAX_POLLS = 75; // 200ms × 75 = 15秒上限（旧 500ms×30 と同等）

export type StatusReader = () => string;
export type SleepFn = (ms: number) => Promise<void>;

/**
 * 指定セッションの FGS 停止完了を待つ（設計書 §5 必須修正）。
 * 前回セッションの finished:<oldId> 残留で即 true にならないよう
 * 対象 sessionId との一致を条件にする。poll 200ms・15秒タイムアウト。
 */
export async function waitForServiceStop(
  sessionId: string,
  readStatus: StatusReader,
  sleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const target = `finished:${sessionId}`;
  for (let i = 0; i < STOP_MAX_POLLS; i++) {
    await sleep(STOP_POLL_INTERVAL_MS);
    if (parseNativeStatus(readStatus()) === target) return true;
  }
  return false;
}
