import { isFinishedStatus, parseNativeStatus } from "../autoImport";

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

  // 2026-11-03 実機観察の修正: Kotlin getStatus() は JSON 形式を返す（プレーン判定だと永遠にマッチしない）
  describe("parseNativeStatus（Kotlin の JSON 戻りを正規化）", () => {
    it("JSON形式のfinished → 抽出される（起動時取り込みが発火する形）", () => {
      expect(
        parseNativeStatus('{"status":"finished:s-1793670171510","sessionId":"s-1793670171510"}')
      ).toBe("finished:s-1793670171510");
    });

    it("JSON形式のrecording → 抽出される", () => {
      expect(parseNativeStatus('{"status":"recording:s-1","sessionId":"s-1"}')).toBe("recording:s-1");
    });

    it("プレーン形式はそのまま返す（後方互換）", () => {
      expect(parseNativeStatus("finished:s-1")).toBe("finished:s-1");
    });

    it("JSON形式でもisFinishedStatusがtrueになる（修正前はfalseだった不具合）", () => {
      expect(isFinishedStatus('{"status":"finished:s-1","sessionId":"s-1"}')).toBe(true);
    });

    it("statusキー無しのJSON → 元文字列を返す（isFinishedStatus=false・autoImport.ts L25分岐）", () => {
      expect(parseNativeStatus('{"sessionId":"s-1"}')).toBe('{"sessionId":"s-1"}');
      expect(isFinishedStatus('{"sessionId":"s-1"}')).toBe(false);
    });
  });
});
