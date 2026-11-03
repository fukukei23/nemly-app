import { isFinishedStatus } from "../autoImport";

describe("isFinishedStatus", () => {
  it("finished:s-123 → true（タイマー自動停止後に取り込みを起こす）", () => {
    expect(isFinishedStatus("finished:s-123")).toBe(true);
  });

  it("recording:s-1 → false（計測中は取り込まない）", () => {
    expect(isFinishedStatus("recording:s-1")).toBe(false);
  });

  it("idle → false", () => {
    expect(isFinishedStatus("idle")).toBe(false);
  });

  it("failed_retry_exhausted:s-1 → false（fail セッションは UI フロー外・L185 保持ポリシーに委ねる）", () => {
    expect(isFinishedStatus("failed_retry_exhausted:s-1")).toBe(false);
  });

  it("空文字 → false", () => {
    expect(isFinishedStatus("")).toBe(false);
  });
});
