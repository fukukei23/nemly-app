import { STOP_MAX_POLLS, STOP_POLL_INTERVAL_MS, waitForServiceStop } from "../waitForStop";

const immediateSleep = async () => {};

test("一致する finished:<sid> で true を返す", async () => {
  let n = 0;
  const ok = await waitForServiceStop(
    "s-1",
    () => (n++ >= 2 ? "finished:s-1" : "recording:s-1"),
    immediateSleep,
  );
  expect(ok).toBe(true);
});

test("前回残留の finished:<oldId> では即 true にならずタイムアウトまで false 継続（設計書 §5 必須修正）", async () => {
  const ok = await waitForServiceStop("s-new", () => "finished:s-old", immediateSleep);
  expect(ok).toBe(false);
});

test("JSON 形式の getStatus でも正規化して照合する", async () => {
  let n = 0;
  const ok = await waitForServiceStop(
    "s-1",
    () =>
      n++ >= 1
        ? '{"status":"finished:s-1","sessionId":"s-1"}'
        : '{"status":"recording:s-1","sessionId":"s-1"}',
    immediateSleep,
  );
  expect(ok).toBe(true);
});

test("poll 間隔 200ms×75回=15秒上限（旧 500ms×30 と同等・設計書 §4）", () => {
  expect(STOP_POLL_INTERVAL_MS).toBe(200);
  expect(STOP_MAX_POLLS).toBe(75);
  expect(STOP_MAX_POLLS * STOP_POLL_INTERVAL_MS).toBe(15000);
});

test("sleep は poll ごとに 200ms で呼ばれる", async () => {
  const sleeps: number[] = [];
  await waitForServiceStop(
    "s-1",
    () => "finished:s-1",
    async (ms) => {
      sleeps.push(ms);
    },
  );
  expect(sleeps.length).toBe(1);
  expect(sleeps[0]).toBe(200);
});
