import {
  decideStart,
  decideStop,
  decideStopOutcome,
  normalizeStatus,
} from "../importGuard";

describe("normalizeStatus", () => {
  test("JSON 形式から status を抽出する", () => {
    expect(normalizeStatus('{"status":"finished:s-1","sessionId":"s-1"}')).toBe("finished:s-1");
  });

  test("プレーン形式はそのまま返す", () => {
    expect(normalizeStatus("recording:s-1")).toBe("recording:s-1");
  });

  test("壊れた JSON はプレーンとして扱う（握り潰さない・解析不能はそのまま）", () => {
    expect(normalizeStatus("{broken")).toBe("{broken");
  });

  test("status キーが無い JSON はプレーンとして扱う", () => {
    expect(normalizeStatus('{"sessionId":"s-1"}')).toBe('{"sessionId":"s-1"}');
  });
});

describe("decideStop", () => {
  test("非計測中は何もしない", () => {
    expect(decideStop(false, "idle", "s-9")).toEqual({ kind: "ignore" });
  });

  test("recording:<sid> から sid を抽出する", () => {
    expect(decideStop(true, "recording:s-1", "s-9")).toEqual({ kind: "stop", sessionId: "s-1" });
  });

  test("JSON 形式でも sid を抽出する", () => {
    expect(decideStop(true, '{"status":"recording:s-2"}', "s-9")).toEqual({
      kind: "stop",
      sessionId: "s-2",
    });
  });

  test("status に sid が無ければ lastSessionId にフォールバックする", () => {
    expect(decideStop(true, "recording:", "s-9")).toEqual({ kind: "stop", sessionId: "s-9" });
  });

  test("sid が特定できない場合は stop-unknown-session（不正 sid で15秒待たない）", () => {
    expect(decideStop(true, "recording:", "")).toEqual({ kind: "stop-unknown-session" });
  });

  test("status が想定外の形式でも lastSessionId にフォールバックする", () => {
    expect(decideStop(true, "weird", "s-9")).toEqual({ kind: "stop", sessionId: "s-9" });
  });
});

describe("decideStart", () => {
  test("全部クリアなら開始できる", () => {
    expect(decideStart(false, "idle", false)).toEqual({ allowed: true });
  });

  test("native lease が有効なら importing として拒否（排他判定の正は native）", () => {
    expect(decideStart(false, "idle", true)).toEqual({ allowed: false, reason: "importing" });
  });

  test("importPhase が stopping なら拒否", () => {
    expect(decideStart(false, "stopping", false)).toEqual({ allowed: false, reason: "importing" });
  });

  test("importPhase が recovering なら拒否", () => {
    expect(decideStart(false, "recovering", false)).toEqual({ allowed: false, reason: "importing" });
  });

  test("busy 中は busy として拒否", () => {
    expect(decideStart(true, "idle", false)).toEqual({ allowed: false, reason: "busy" });
  });

  test("native lease は importPhase より優先（reason は importing）", () => {
    expect(decideStart(true, "recovering", true)).toEqual({ allowed: false, reason: "importing" });
  });
});

describe("decideStopOutcome", () => {
  test("finished 到達なら confirmed", () => {
    expect(decideStopOutcome(true, "finished:s-1", "s-1")).toEqual({ kind: "confirmed" });
  });

  test("failed:<sid> なら failed（回収対象外・明示エラー表示）", () => {
    expect(decideStopOutcome(false, "failed:s-1", "s-1")).toEqual({ kind: "failed" });
  });

  test("failed:<他sid> は failed と判定しない", () => {
    expect(decideStopOutcome(false, "failed:s-other", "s-1")).toEqual({ kind: "timeout" });
  });

  test("上限到達も failed もなければ timeout", () => {
    expect(decideStopOutcome(false, "recording:s-1", "s-1")).toEqual({ kind: "timeout" });
  });
});
