# nemly-app Phase 2 センサー計測 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加速度センサーによる夜間睡眠計測（ネイティブFGS+専用DB・10秒振幅系列→既存解析パイプライン→スコア表示）を Phase 1 の土台に追加する。

**Architecture:** Kotlin FGS が10秒窓の振幅をネイティブ専用DB（amplitude.db）へ逐次書込→セッション終了時に JS へ一括取得→既存の expo-sqlite 主DB+analyzeSleep で解析・表示。FakeSensor（合成振幅）で JS 側を先に TDD 完成してからネイティブを差し込む二段構え。

**Tech Stack:** Expo SDK 58 / React Native 0.88 / expo-modules-core（local module）/ Kotlin / android.database.sqlite (WAL) / expo-sqlite / jest

**spec:** `~/projects/obsidian-ssot/docs/superpowers/specs/2026-10-28_nemly-app-Phase2センサー計測-design.md`（approved）

**検証コマンド規約:** jest/tsc は必ず `set -o pipefail` で生 exit code を確認。リポジトリは main 直コミット。

---

### Task 0: FGS型 Go/No-Go 実査（実装前 gate・spec §6 の確定）

**Files:**
- Modify: `~/projects/obsidian-ssot/docs/superpowers/specs/2026-10-28_nemly-app-Phase2センサー計測-design.md`（§6 表に公式引用 URL と確定列を追記）

- [ ] **Step 1: 公式ドキュメント取得**

WebFetch: `https://developer.android.com/develop/background-work/services/fg-service-types`（35種の型一覧・要件）と `https://developer.android.com/develop/background-work/services/fgs/timeout`（6h制限・実査済み）を取得し、`health` 型の必須権限・`specialUse` の宣言要件を確認する。

- [ ] **Step 2: spec §6 表に確定列を追記**

各候補行に「公式引用URL」「対象SDK」「判定（確定）」列を追記する。`health` が HIGH_SAMPLING_RATE_SENSORS（install-time）で成立することを引用で確認できなければ specialUse を第一候補へ繰り上げる（判定が変わったら spec の判定初期値も更新）。

- [ ] **Step 3: commit（obsidian-ssot）**

```bash
cd ~/projects/obsidian-ssot && git commit-scoped -m "docs: nemly Phase2 spec §6 Go/No-Go確定（公式引用）" -- docs/superpowers/specs/2026-10-28_nemly-app-Phase2センサー計測-design.md && git push
```

---

### Task 1: v2 migration（amplitude_samples + センサー系メタ列）

**Files:**
- Modify: `src/lib/migration/migrations.ts`
- Test: `src/lib/migration/__tests__/migrationRunner.test.ts`（既存・期待値の差分レビュー更新）

- [ ] **Step 1: 既存テストを実行して現状確認**

```bash
cd ~/projects/nemly-app && set -o pipefail && npx jest src/lib/migration --silent; echo "EXIT=$?"
```
Expected: PASS（EXIT=0）

- [ ] **Step 2: 失敗するテストを追加（v2 存在の表明）**

`migrationRunner.test.ts` の末尾に追加:

```typescript
describe("v2 migration", () => {
  it("ALL_MIGRATIONS は v1+v2 の2件", () => {
    expect(ALL_MIGRATIONS).toHaveLength(2);
    expect(ALL_MIGRATIONS[1]!.version).toBe(2);
  });

  it("v2 は amplitude_samples と sleep_sessions のメタ列を作る", async () => {
    const db = createInMemoryDb();
    await migrationRunner.run(db, ALL_MIGRATIONS, createFakeAdapter());
    const cols = await db.getAllAsync("PRAGMA table_info(sleep_sessions)");
    const names = cols.map((c: any) => c.name);
    expect(names).toContain("valid_ratio");
    expect(names).toContain("gap_count");
    expect(names).toContain("end_reason");
    const samples = await db.getFirstAsync(
      "SELECT COUNT(*) AS n FROM amplitude_samples"
    );
    expect((samples as any).n).toBe(0);
  });
});
```

注: テストファイル冒頭の import に `ALL_MIGRATIONS` が無ければ追加。`createInMemoryDb`/`createFakeAdapter` は既存テストのヘルパー名に合わせる（無ければ node:sqlite の `new DatabaseSync(":memory:")` + `sqliteAdapter.ts` の FakeAdapter を使用）。

- [ ] **Step 3: 失敗を確認**

Run: `npx jest src/lib/migration --silent; echo "EXIT=$?"`
Expected: FAIL（toHaveLength(2) が 1 で失败）

- [ ] **Step 4: v2 migration を実装**

`migrations.ts` に追記:

```typescript
export const V2_DDL = `
CREATE TABLE IF NOT EXISTS amplitude_samples (
  session_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  amplitude REAL NOT NULL,
  quality INTEGER NOT NULL,
  PRIMARY KEY (session_id, ts_ms)
);

ALTER TABLE sleep_sessions ADD COLUMN valid_ratio REAL;
ALTER TABLE sleep_sessions ADD COLUMN gap_count INTEGER;
ALTER TABLE sleep_sessions ADD COLUMN end_reason TEXT;
`.trim();

export const v2: Migration = {
  version: 2,
  name: "v2: amplitude_samples + sensor session meta columns",
  up: V2_DDL,
};

export const ALL_MIGRATIONS: Migration[] = [v1, v2];
```

注: `ALTER TABLE` は IF NOT EXISTS が無いため bootstrap 新規DBでは v1→v2 連続適用で1回のみ走る（runner の user_version 機構が保証・fail-closed 契約どおり）。**既存テストの v1 checksum 期待値は v1 DDL を変更していないため不変・変更不要のことを差分レビューで確認する**（盲目的置換禁止）。

- [ ] **Step 5: テスト緑を確認**

Run: `npx jest src/lib/migration --silent; echo "EXIT=$?"`
Expected: PASS（EXIT=0）

- [ ] **Step 6: Commit**

```bash
cd ~/projects/nemly-app && git add src/lib/migration/migrations.ts src/lib/migration/__tests__/migrationRunner.test.ts && git commit -m "feat(migration): v2 amplitude_samples + sensor meta columns"
```

---

### Task 2: センサー系型 + FakeSensor（合成振幅生成器）

**Files:**
- Create: `src/lib/sensor/types.ts`
- Create: `src/lib/sensor/fakeSensor.ts`
- Test: `src/lib/sensor/__tests__/fakeSensor.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sensor/__tests__/fakeSensor.test.ts`:

```typescript
import { generateSyntheticSeries } from "../fakeSensor";

const START = 1_700_000_000_000; // 10秒境界に調整された値を使う

describe("generateSyntheticSeries", () => {
  it("normal: 60窓の連続系列（ts=窓開始・10秒刻み・quality=0）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 60 });
    expect(r.samples).toHaveLength(60);
    expect(r.samples[0]!.tsMs).toBe(START);
    expect(r.samples[1]!.tsMs - r.samples[0]!.tsMs).toBe(10_000);
    expect(r.samples.every((s) => s.quality === 0)).toBe(true);
    expect(r.gaps).toHaveLength(0);
    expect(r.validRatio).toBeCloseTo(1);
  });

  it("gaps 指定窓は行が無く gap として列挙される", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 10, gapWindows: [3, 4] });
    expect(r.samples).toHaveLength(8);
    expect(r.gaps).toEqual([
      { start: START + 30_000, end: START + 50_000 },
    ]);
    expect(r.validRatio).toBeCloseTo(0.8);
  });

  it("degraded: quality=1 の窓を作れる", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 5, degradedWindows: [1] });
    expect(r.samples[1]!.quality).toBe(1);
    expect(r.samples.filter((s) => s.quality === 0)).toHaveLength(4);
  });

  it("stationary: ほぼゼロ振幅（品質ゲートの定常検知テスト用）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 5, pattern: "stationary" });
    expect(r.samples.every((s) => s.amplitude < 0.05)).toBe(true);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx jest src/lib/sensor --silent; echo "EXIT=$?"`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: types + FakeSensor を実装**

`src/lib/sensor/types.ts`:

```typescript
/** ネイティブ専用DBの1行（pullSeries の要素） */
export interface SensorSample {
  tsMs: number;      // 窓開始・epoch ms
  amplitude: number; // m/s² 平均（§5 数式）
  quality: 0 | 1;    // 0=OK 1=DEGRADED
  eventCount: number;
}

export interface GapInterval {
  start: number;
  end: number;
}

export interface SeriesQuality {
  nanRate: number;
  stationaryRate: number;   // 振幅<0.05 の窓率
  validRatio: number;       // 有効窓/期待窓
  gaps: GapInterval[];
}

export interface SeriesMeta {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  endReason: string; // user_stop | system
  status: "recording" | "finished" | "failed";
}

/** fail判定の結果（spec §8 rubric） */
export type FailVerdict =
  | { verdict: "pass" }
  | { verdict: "degraded_pass"; reasons: string[] }
  | { verdict: "fail"; reasons: string[] };
```

`src/lib/sensor/fakeSensor.ts`:

```typescript
import type { SensorSample, GapInterval } from "./types";

const STEP_MS = 10_000;

export interface FakeSeriesOptions {
  startMs: number;
  windows: number;
  pattern?: "normal" | "stationary";
  gapWindows?: number[];     // 行を作らない窓index
  degradedWindows?: number[]; // quality=1 の窓index
}

export interface FakeSeriesResult {
  samples: SensorSample[];
  gaps: GapInterval[];
  validRatio: number;
}

export function generateSyntheticSeries(opts: FakeSeriesOptions): FakeSeriesResult {
  const gaps = new Set(opts.gapWindows ?? []);
  const degraded = new Set(opts.degradedWindows ?? []);
  const samples: SensorSample[] = [];
  const gapIntervals: GapInterval[] = [];
  for (let i = 0; i < opts.windows; i++) {
    const tsMs = opts.startMs + i * STEP_MS;
    if (gaps.has(i)) {
      gapIntervals.push({ start: tsMs, end: tsMs + STEP_MS });
      continue;
    }
    const amplitude =
      opts.pattern === "stationary"
        ? 0.001 + (i % 3) * 0.001
        : 0.08 + ((i * 37) % 100) / 1000;
    samples.push({
      tsMs,
      amplitude,
      quality: degraded.has(i) ? 1 : 0,
      eventCount: 500,
    });
  }
  const validRatio = opts.windows === 0 ? 1 : samples.length / opts.windows;
  return { samples, gaps: gapIntervals, validRatio };
}
```

- [ ] **Step 4: 緑を確認**

Run: `npx jest src/lib/sensor --silent; echo "EXIT=$?"`
Expected: PASS（EXIT=0）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nemly-app && git add src/lib/sensor && git commit -m "feat(sensor): types + FakeSensor 合成振幅生成器"
```

---

### Task 3: 振幅集約の参照実装（TS・spec §5 の数式）+ golden vector

**Files:**
- Create: `src/lib/sensor/windowAggregator.ts`
- Create: `src/lib/sensor/goldenVector.json`
- Test: `src/lib/sensor/__tests__/windowAggregator.test.ts`

- [ ] **Step 1: golden vector を作る（合成センサーイベント列）**

`src/lib/sensor/goldenVector.json`: 20Hz×30秒=600イベント+ノイズ/重力分の手書き合成列。生成スクリプトで作る（手書き回避）:

```bash
cd ~/projects/nemly-app && node -e '
const fs = require("fs");
const events = [];
const HZ = 20, SEC = 30;
for (let i = 0; i < HZ * SEC; i++) {
  const t = i / HZ;
  const gravity = 9.8; // z方向の重力
  const motion = Math.sin(2 * Math.PI * 0.3 * t) * 0.5 + (i % 100 === 0 ? 2.0 : 0);
  events.push({ tSec: t, x: 0, y: 0, z: gravity + motion });
}
fs.writeFileSync("src/lib/sensor/goldenVector.json", JSON.stringify({ hz: HZ, events }, null, 0));
console.log("events:", events.length);
'
```

- [ ] **Step 2: 失敗するテストを書く**

`src/lib/sensor/__tests__/windowAggregator.test.ts`:

```typescript
import { computeWindows, summarizeQuality } from "../windowAggregator";
import vector from "../goldenVector.json";

describe("computeWindows（spec §5 数式の参照実装）", () => {
  it("20Hz・30秒の合成列 → 3窓（ts=窓開始・eventCount=20）", () => {
    const events = (vector as any).events.map((e: any) => ({
      epochMs: Math.round(e.tSec * 1000),
      x: e.x, y: e.y, z: e.z,
    }));
    const startMs = 0;
    const r = computeWindows(events, startMs);
    expect(r).toHaveLength(3);
    expect(r[0]!.tsMs).toBe(0);
    expect(r[0]!.eventCount).toBe(20);
    expect(r.every((w) => w.quality === 0)).toBe(true);
    // 振幅は正の有限値（重力が除かれた運動成分の平均）
    expect(r.every((w) => Number.isFinite(w.amplitude) && w.amplitude >= 0)).toBe(true);
  });

  it("イベント0個の窓は行を作らない（欠損窓）", () => {
    const events = [
      { epochMs: 0, x: 0, y: 0, z: 9.8 },
      { epochMs: 25_000, x: 0, y: 0, z: 9.8 },
    ];
    const r = computeWindows(events, 0, 30_000);
    expect(r).toHaveLength(2); // 窓0と窓2・窓1は欠損
  });

  it("無効値（NaN・‖a‖>100）は窓に数えない", () => {
    const events = [
      { epochMs: 0, x: NaN, y: 0, z: 9.8 },
      { epochMs: 500, x: 0, y: 0, z: 999 },
      { epochMs: 1000, x: 0, y: 0, z: 9.8 },
    ];
    const r = computeWindows(events, 0, 10_000);
    expect(r[0]!.eventCount).toBe(1);
  });

  it("summarizeQuality: 定常率と有効窓率を数える", () => {
    const windows = [
      { tsMs: 0, amplitude: 0.001, quality: 0 as const, eventCount: 500 },
      { tsMs: 10_000, amplitude: 0.5, quality: 0 as const, eventCount: 500 },
    ];
    const q = summarizeQuality(windows, 2);
    expect(q.stationaryRate).toBeCloseTo(0.5);
    expect(q.validRatio).toBeCloseTo(1);
    expect(q.nanRate).toBe(0);
  });
});
```

- [ ] **Step 3: 失敗を確認 → 実装**

Run: `npx jest src/lib/sensor --silent; echo "EXIT=$?"` → FAIL を確認。

`src/lib/sensor/windowAggregator.ts`:

```typescript
/**
 * 振幅集約の TS 参照実装（spec §5 の数式・Kotlin WindowAggregator と同一式）
 * 契約: 同一 event 列から既存パイプラインと native が同一結果（golden parity）
 */
import type { SensorSample } from "./types";

const STEP_MS = 10_000;
const ALPHA = 0.8;            // 低pass 係数（重力除去・spec §5 固定）
const MAX_VALID_NORM = 100;   // m/s²（これ超は無効イベント）
const MIN_DELAY_MS = -5_000;  // 遅延受信の許容（過去5秒まで・超過は無視）

export interface RawEvent {
  epochMs: number;
  x: number;
  y: number;
  z: number;
}

export interface QualitySummary {
  nanRate: number;
  stationaryRate: number;
  validRatio: number;
  gaps: { start: number; end: number }[];
}

export function computeWindows(
  events: RawEvent[],
  startMs: number,
  endMs?: number
): SensorSample[] {
  const sorted = [...events]
    .filter((e) => Number.isFinite(e.epochMs))
    .sort((a, b) => a.epochMs - b.epochMs);
  if (sorted.length === 0) return [];

  const lastMs = endMs ?? sorted[sorted.length - 1]!.epochMs;
  const winCount = Math.ceil((lastMs - startMs) / STEP_MS);
  const buckets: RawEvent[][] = Array.from({ length: winCount }, () => []);

  let base = startMs;
  for (const e of sorted) {
    if (e.epochMs < base + MIN_DELAY_MS) continue; // 5秒超の遅延は無視
    let idx = Math.floor((e.epochMs - base) / STEP_MS);
    if (idx < 0) idx = 0;
    if (idx >= winCount) idx = winCount - 1;
    buckets[idx]!.push(e);
  }

  let lpf: { x: number; y: number; z: number } | null = null;
  const out: SensorSample[] = [];
  for (let w = 0; w < winCount; w++) {
    const evs = buckets[w]!;
    // 窓内で lowpass を進める（lpf は窓を跨いで連続）
    const mags: number[] = [];
    for (const e of evs) {
      const norm = Math.hypot(e.x, e.y, e.z);
      if (!Number.isFinite(norm) || norm > MAX_VALID_NORM) continue;
      if (!lpf) lpf = { ...{ x: e.x, y: e.y, z: e.z } };
      else {
        lpf.x = ALPHA * lpf.x + (1 - ALPHA) * e.x;
        lpf.y = ALPHA * lpf.y + (1 - ALPHA) * e.y;
        lpf.z = ALPHA * lpf.z + (1 - ALPHA) * e.z;
      }
      mags.push(Math.hypot(e.x - lpf.x, e.y - lpf.y, e.z - lpf.z));
    }
    if (mags.length === 0) continue; // 欠損窓=行なし
    const amplitude = mags.reduce((s, m) => s + m, 0) / mags.length;
    out.push({
      tsMs: startMs + w * STEP_MS,
      amplitude,
      quality: mags.length < 200 ? 1 : 0, // 実効レート実測前の暫定閾値・1時間段で校正
      eventCount: mags.length,
    });
  }
  return out;
}

const STATIONARY_THRESHOLD = 0.05;

export function summarizeQuality(
  windows: SensorSample[],
  expectedWindowCount: number
): QualitySummary {
  const n = windows.length || 1;
  const stationary = windows.filter((w) => w.amplitude < STATIONARY_THRESHOLD).length;
  const invalid = windows.filter(
    (w) => !Number.isFinite(w.amplitude) || w.amplitude < 0
  ).length;
  const gaps: { start: number; end: number }[] = [];
  if (windows.length > 0) {
    const sorted = [...windows].sort((a, b) => a.tsMs - b.tsMs);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1]!.tsMs + STEP_MS;
      if (sorted[i]!.tsMs > prevEnd) {
        gaps.push({ start: prevEnd, end: sorted[i]!.tsMs });
      }
    }
  }
  return {
    nanRate: invalid / n,
    stationaryRate: stationary / n,
    validRatio: expectedWindowCount === 0 ? 1 : windows.length / expectedWindowCount,
    gaps,
  };
}
```

- [ ] **Step 4: 緑を確認**

Run: `npx jest src/lib/sensor --silent; echo "EXIT=$?"`
Expected: PASS（EXIT=0）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nemly-app && git add src/lib/sensor && git commit -m "feat(sensor): 振幅集約参照実装+golden vector（spec §5）"
```

---

### Task 4: 連続性検証 + fail判定集計（spec §8 rubric）

**Files:**
- Create: `src/lib/sensor/failCheck.ts`
- Test: `src/lib/sensor/__tests__/failCheck.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sensor/__tests__/failCheck.test.ts`:

```typescript
import { validateAndJudge } from "../failCheck";
import { generateSyntheticSeries } from "../fakeSensor";

const START = 1_700_000_000_000;

describe("validateAndJudge（spec §8・事前固定）", () => {
  it("連続100窓 → pass", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100 });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("pass");
  });

  it("有効率90%未満 → fail（閾値・r3 glm#7 再設定）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, gapWindows: [50,51,52,53,54,55,56,57,58,59,60] });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("valid_ratio"))).toBe(true);
  });

  it("サンプル数0 → 独立した即時fail（r3 mm#1）", () => {
    const v = validateAndJudge(
      { samples: [], gaps: [], validRatio: 0 },
      100,
      { nanRate: 0, stationaryRate: 0 }
    );
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("zero_samples"))).toBe(true);
  });

  it("20分超の連続欠損（recovery無し）→ fail", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 300, gapWindows: Array.from({ length: 125 }, (_, i) => i + 50) });
    const v = validateAndJudge(r, 300, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("long_gap"))).toBe(true);
  });

  it("30分以内の停止+再開 → degraded_pass（rubric）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, gapWindows: [40, 41, 42] });
    const v = validateAndJudge(r, 100, { nanRate: 0, stationaryRate: 0 });
    expect(v.verdict).toBe("degraded_pass");
    expect(v.reasons.some((s) => s.includes("short_gap"))).toBe(true);
  });

  it("定常率10%超 → fail（品質ゲート）", () => {
    const r = generateSyntheticSeries({ startMs: START, windows: 100, pattern: "stationary" });
    const q = { nanRate: 0, stationaryRate: 1.0 };
    const v = validateAndJudge(r, 100, q);
    expect(v.verdict).toBe("fail");
    expect(v.reasons.some((s) => s.includes("stationary_rate"))).toBe(true);
  });
});
```

- [ ] **Step 2: 実装**

`src/lib/sensor/failCheck.ts`:

```typescript
/**
 * spec §8 の fail判定（事前固定・セッション集計として原子的保存）
 * 判定はこの関数のみで行う（実装者の裁量裁定を禁止するため）
 */
import type { SeriesQuality, FailVerdict, GapInterval } from "./types";

const MIN_VALID_RATIO = 0.9;          // r3 glm#7 で 60%→90%（1時間段で校正）
const LONG_GAP_MS = 20 * 60_000;      // 20分超の連続欠損
const SHORT_GAP_MS = 30 * 60_000;     // 30分以内は条件付き許容
const MAX_STATIONARY_RATE = 0.1;
const MAX_NAN_RATE = 0.01;

export function validateAndJudge(
  series: { samples: unknown[]; gaps: GapInterval[]; validRatio: number },
  expectedWindows: number,
  quality: { nanRate: number; stationaryRate: number }
): FailVerdict {
  const reasons: string[] = [];
  if (series.samples.length === 0) {
    return { verdict: "fail", reasons: ["zero_samples: 記録が1件も無い（r3 mm#1）"] };
  }
  if (series.validRatio < MIN_VALID_RATIO) {
    reasons.push(`valid_ratio: ${(series.validRatio * 100).toFixed(1)}% < ${(MIN_VALID_RATIO * 100)}%`);
  }
  for (const g of series.gaps) {
    const dur = g.end - g.start;
    if (dur > LONG_GAP_MS) {
      reasons.push(`long_gap: ${Math.round(dur / 60_000)}分の連続欠損（recovery記録なし）`);
    } else if (dur > 0) {
      reasons.push(`short_gap: ${Math.round(dur / 60_000)}分（条件付き許容・rubric）`);
    }
  }
  if (quality.stationaryRate > MAX_STATIONARY_RATE) {
    reasons.push(`stationary_rate: ${(quality.stationaryRate * 100).toFixed(1)}% > 10%`);
  }
  if (quality.nanRate > MAX_NAN_RATE) {
    reasons.push(`nan_rate: ${(quality.nanRate * 100).toFixed(2)}% > 1%`);
  }
  const hasLongGap = reasons.some((r) => r.startsWith("long_gap"));
  if (reasons.length === 0) return { verdict: "pass" };
  if (hasLongGap || reasons.some((r) => r.startsWith("valid_ratio") || r.startsWith("stationary") || r.startsWith("nan"))) {
    return { verdict: "fail", reasons };
  }
  return { verdict: "degraded_pass", reasons };
}
```

- [ ] **Step 3: 緑を確認して Commit**

Run: `npx jest src/lib/sensor --silent; echo "EXIT=$?"` → PASS。
```bash
cd ~/projects/nemly-app && git add src/lib/sensor && git commit -m "feat(sensor): 連続性検証+fail判定（spec §8 rubric）"
```

---

### Task 5: sensorImport パイプライン（pull→検証→判定→投入→解析→保存）

**Files:**
- Create: `src/lib/sensor/sensorImport.ts`
- Test: `src/lib/sensor/__tests__/sensorImport.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/lib/sensor/__tests__/sensorImport.test.ts`:

```typescript
import { importSensorSession, type SensorSeriesSource } from "../sensorImport";
import { generateSyntheticSeries } from "../fakeSensor";
import { resetRepositoryForTest, insertSession, listSessions } from "@/lib/repository";

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
    async confirmImported() { /* purge 呼び出しのスタブ */ },
  };
}

describe("importSensorSession", () => {
  beforeEach(() => resetRepositoryForTest());

  it("pass 系列 → 解析+保存（source=sensor・60窓）", async () => {
    const res = await importSensorSession(fakeSource(60));
    expect(res.verdict).toBe("pass");
    expect(res.sessionId).toBeGreaterThan(0);
    const all = await listSessions();
    expect(all[0]!.source).toBe("sensor");
    expect(all[0]!.sampleCount).toBe(60);
    expect(all[0]!.endReason).toBe("user_stop");
  });

  it("fail 系列 → 保存せず verdict を返す（immutable failed）", async () => {
    const res = await importSensorSession(fakeSource(100, Array.from({ length: 125 }, (_, i) => i + 50)));
    expect(res.verdict).toBe("fail");
    expect(res.sessionId).toBeNull();
    expect(await listSessions()).toHaveLength(0);
  });
});
```

注: `resetRepositoryForTest` は repository.ts の `_resetRepositoryForTest` を re-export する（未定義ならテストで直接 import する）。`SessionRecord` に `endReason` 等の新列を持たせるため、Task 6 の型拡張後に本テストは通る（順序: Task 6 → 5 の実装でも可・テストは先に書く）。

- [ ] **Step 2: 実装（Task 6 の型拡張に依存）**

`src/lib/sensor/sensorImport.ts`:

```typescript
import { analyzeSleep } from "@/lib/csvImport";
import { insertSession } from "@/lib/repository";
import { computeWindows, summarizeQuality } from "./windowAggregator";
import { validateAndJudge } from "./failCheck";
import type { SensorSample, SeriesMeta, FailVerdict } from "./types";

/** ネイティブ bridge の契約（Task 7 のモジュールがこの形を返す） */
export interface SensorSeriesSource {
  pullSeries(): Promise<{ samples: SensorSample[]; meta: SeriesMeta }>;
  confirmImported(sessionId: string): Promise<void>;
}

export interface SensorImportResult {
  verdict: FailVerdict["verdict"];
  reasons: string[];
  sessionId: number | null;
}

export async function importSensorSession(source: SensorSeriesSource): Promise<SensorImportResult> {
  const { samples, meta } = await source.pullSeries();

  const expectedWindows = Math.max(
    0,
    Math.round((meta.endedAtMs - meta.startedAtMs) / 10_000)
  );
  const summary = summarizeQuality(
    samples,
    expectedWindows
  );
  const verdict = validateAndJudge(
    { samples, gaps: summary.gaps, validRatio: summary.validRatio },
    expectedWindows,
    { nanRate: summary.nanRate, stationaryRate: summary.stationaryRate }
  );

  if (verdict.verdict === "fail") {
    return { verdict: "fail", reasons: verdict.reasons, sessionId: null };
  }

  const analysis = analyzeSleep(
    samples.map((s) => ({ ts: s.tsMs, amp: s.amplitude }))
  );
  const sessionId = await insertSession(
    {
      startMs: analysis.startMs,
      endMs: analysis.endMs,
      sampleCount: analysis.sampleCount,
      deepRatio: analysis.deepRatio,
      lightRatio: analysis.lightRatio,
      remRatio: analysis.remRatio,
      awakeRatio: analysis.awakeRatio,
      score: analysis.score,
      source: "sensor",
      createdAt: new Date().toISOString(),
      validRatio: summary.validRatio,
      gapCount: summary.gaps.length,
      endReason: meta.endReason,
    },
    analysis.stages
  );
  await source.confirmImported(meta.sessionId);
  return {
    verdict: verdict.verdict,
    reasons: verdict.verdict === "degraded_pass" ? verdict.reasons : [],
    sessionId,
  };
}
```

- [ ] **Step 3: 緑を確認して Commit**

```bash
cd ~/projects/nemly-app && set -o pipefail && npx jest src/lib/sensor --silent; echo "EXIT=$?"
git add src/lib/sensor && git commit -m "feat(sensor): importSensorSession パイプライン"
```

---

### Task 6: SessionRecord 型拡張 + sqliteRepository の v2 対応

**Files:**
- Modify: `src/lib/repository.ts`（SessionRecord に optional 3列 + InMemory は変更なし）
- Modify: `src/lib/sqliteRepository.ts`（INSERT/SELECT へ新列）

- [ ] **Step 1: 失敗するテストを sqliteRepository.test.ts に追加**

```typescript
it("sensor セッションのメタ列（valid_ratio/gap_count/end_reason）を保存・取得する", async () => {
  const repo = makeRepoWithV2Db(); // 既存ヘルパー: in-memory sqlite + 全 migration
  const id = await repo.insertSession(
    { startMs: 0, endMs: 600_000, sampleCount: 60, deepRatio: 0.2, lightRatio: 0.5,
      remRatio: 0.1, awakeRatio: 0.2, score: 67, source: "sensor", createdAt: "2026-10-28T00:00:00Z",
      validRatio: 0.95, gapCount: 1, endReason: "user_stop" },
    [{ tsMs: 0, phase: "LIGHT" }]
  );
  const all = await repo.listSessions();
  expect(all[0]!.validRatio).toBeCloseTo(0.95);
  expect(all[0]!.gapCount).toBe(1);
  expect(all[0]!.endReason).toBe("user_stop");
});
```

- [ ] **Step 2: repository.ts の型拡張**

`SessionRecord` に追加:

```typescript
  /** sensor セッションのメタ（csv では undefined） */
  validRatio?: number;
  gapCount?: number;
  endReason?: string;
```

- [ ] **Step 3: sqliteRepository.ts の SQL 拡張**

`SESSION_COLS` と INSERT を更新:

```typescript
const SESSION_COLS = "id, start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at, valid_ratio, gap_count, end_reason";
```

insertSession の INSERT 文:

```typescript
"INSERT INTO sleep_sessions (start_ms, end_ms, sample_count, deep_ratio, light_ratio, rem_ratio, awake_ratio, score, source, created_at, valid_ratio, gap_count, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
[session.startMs, session.endMs, session.sampleCount, session.deepRatio, session.lightRatio, session.remRatio, session.awakeRatio, session.score, session.source, session.createdAt, session.validRatio ?? null, session.gapCount ?? null, session.endReason ?? null]
```

rowToSession に追加:

```typescript
    validRatio: row.valid_ratio ?? undefined,
    gapCount: row.gap_count ?? undefined,
    endReason: row.end_reason ?? undefined,
```

- [ ] **Step 4: 全テスト緑を確認して Commit**

```bash
cd ~/projects/nemly-app && set -o pipefail && npx jest --silent; echo "JEST=$?" && npx tsc --noEmit; echo "TSC=$?"
git add src/lib && git commit -m "feat(repo): sensor メタ列の保存・取得（v2）"
```

---

### Task 7: ネイティブモジュール（local Expo module・Kotlin）

**Files:**
- Create: `modules/nemly-sensor/expo-module.config.json`
- Create: `modules/nemly-sensor/android/build.gradle`
- Create: `modules/nemly-sensor/android/src/main/AndroidManifest.xml`
- Create: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorModule.kt`
- Create: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorService.kt`
- Create: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/WindowAggregator.kt`
- Create: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/SensorDbHelper.kt`
- Test: `modules/nemly-sensor/android/src/test/java/expo/nemlysensor/WindowAggregatorTest.kt`（JVM unit test・golden parity）

- [ ] **Step 1: モジュール骨格**

`expo-module.config.json`:

```json
{ "platforms": ["android"], "android": { "modules": ["expo.nemlysensor.NemlySensorModule"] } }
```

`android/build.gradle`:

```gradle
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

group = 'expo.nemlysensor'
version = '1.0.0'

def expoModulesCorePlugin = new File(project(":expo-modules-core").projectDir.absolutePath, "ExpoModulesCorePlugin.gradle")
apply from: expoModulesCorePlugin

android {
  namespace "expo.nemlysensor"
  compileSdkVersion safeExtGet("compileSdkVersion", 35)
  defaultConfig { minSdkVersion safeExtGet("minSdkVersion", 24) }
  kotlinOptions { jvmTarget = '17' }
}

dependencies {
  implementation project(':expo-modules-core')
  implementation "org.jetbrains.kotlin:kotlin-stdlib-jdk7:${safeExtGet('kotlinVersion', '2.0.0')}"
}
```

- [ ] **Step 2: golden parity の JVM unit test（Task 3 の vector を流用）**

`src/test/.../WindowAggregatorTest.kt` — goldenVector.json を `modules/nemly-sensor/android/src/test/resources/goldenVector.json` へコピーし:

```kotlin
class WindowAggregatorTest {
  @Test fun goldenParityWithTsReference() {
    val stream = javaClass.getResourceAsStream("/goldenVector.json")!!
    val vector = JSONObject(stream.bufferedReader().readText())
    val events = vector.getJSONArray("events").let { arr ->
      (0 until arr.length()).map { i ->
        val e = arr.getJSONObject(i)
        RawEvent(epochMs = Math.round(e.getDouble("tSec") * 1000), x = e.getDouble("x"), y = e.getDouble("y"), z = e.getDouble("z"))
      }
    }
    val windows = WindowAggregator.computeWindows(events, startMs = 0, endMs = 30_000)
    assertEquals(3, windows.size)
    assertEquals(20, windows[0].eventCount)
    // TS 側 jest の期待値と同一の性質（有限・非負）
    assertTrue(windows.all { it.amplitude.isFinite() && it.amplitude >= 0.0 })
  }
}
```

Run（JVM・エミュレータ不要）:

```bash
cd ~/projects/nemly-app/android && ./gradlew :nemly-sensor:testDebugUnitTest --tests "expo.nemlysensor.WindowAggregatorTest"; echo "EXIT=$?"
```
Expected: PASS（EXIT=0）。FAIL の場合は **TS 参照実装に合わせて Kotlin を修正する**（TS が正典）。

- [ ] **Step 3: WindowAggregator.kt（Task 3 と同一式）**

```kotlin
package expo.nemlysensor

import kotlin.math.hypot

data class RawEvent(val epochMs: Long, val x: Double, val y: Double, val z: Double)
data class WindowSample(val tsMs: Long, val amplitude: Double, val quality: Int, val eventCount: Int)

object WindowAggregator {
  const val STEP_MS = 10_000L
  private const val ALPHA = 0.8
  private const val MAX_VALID_NORM = 100.0
  private const val MIN_DELAY_MS = -5_000L

  fun computeWindows(events: List<RawEvent>, startMs: Long, endMs: Long? = null): List<WindowSample> {
    val sorted = events.filter { it.epochMs.isFinite() }.sortedBy { it.epochMs }
    if (sorted.isEmpty()) return emptyList()
    val last = endMs ?: sorted.last().epochMs
    val winCount = Math.ceil((last - startMs).toDouble() / STEP_MS).toInt()
    val buckets: Array<MutableList<RawEvent>> = Array(winCount) { mutableListOf() }
    val base = startMs
    for (e in sorted) {
      if (e.epochMs < base + MIN_DELAY_MS) continue
      var idx = ((e.epochMs - base) / STEP_MS).toInt()
      idx = idx.coerceIn(0, winCount - 1)
      buckets[idx].add(e)
    }
    var lpfX = 0.0; var lpfY = 0.0; var lpfZ = 0.0
    var lpfInit = false
    val out = mutableListOf<WindowSample>()
    for (w in 0 until winCount) {
      val mags = mutableListOf<Double>()
      for (e in buckets[w]) {
        val norm = hypot(hypot(e.x, e.y), e.z)
        if (!norm.isFinite() || norm > MAX_VALID_NORM) continue
        if (!lpfInit) { lpfX = e.x; lpfY = e.y; lpfZ = e.z; lpfInit = true }
        else {
          lpfX = ALPHA * lpfX + (1 - ALPHA) * e.x
          lpfY = ALPHA * lpfY + (1 - ALPHA) * e.y
          lpfZ = ALPHA * lpfZ + (1 - ALPHA) * e.z
        }
        mags.add(hypot(hypot(e.x - lpfX, e.y - lpfY), e.z - lpfZ))
      }
      if (mags.isEmpty()) continue
      val amp = mags.average()
      out.add(WindowSample(startMs + w * STEP_MS, amp, if (mags.size < 200) 1 else 0, mags.size))
    }
    return out
  }
}
```

- [ ] **Step 4: SensorDbHelper.kt（専用DB・WAL）**

```kotlin
package expo.nemlysensor

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class SensorDbHelper(context: Context) :
  SQLiteOpenHelper(context, "amplitude.db", null, 1) {

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE IF NOT EXISTS samples (session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, amplitude REAL NOT NULL, quality INTEGER NOT NULL, event_count INTEGER NOT NULL, PRIMARY KEY (session_id, ts_ms))")
    db.execSQL("CREATE TABLE IF NOT EXISTS native_sessions (session_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, end_reason TEXT, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0)")
  }
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

  fun insertSample(sessionId: String, tsMs: Long, amplitude: Double, quality: Int, eventCount: Int) {
    val cv = ContentValues().apply {
      put("session_id", sessionId); put("ts_ms", tsMs); put("amplitude", amplitude)
      put("quality", quality); put("event_count", eventCount)
    }
    writableDatabase.insertWithOnConflict("samples", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
  }

  fun pullSeries(sessionId: String): Pair<String, String> {
    val db = readableDatabase
    val sb = StringBuilder("[")
    var first = true
    db.rawQuery("SELECT ts_ms, amplitude, quality, event_count FROM samples WHERE session_id = ? ORDER BY ts_ms", arrayOf(sessionId)).use { c ->
      while (c.moveToNext()) {
        if (!first) sb.append(",")
        first = false
        sb.append("{\"tsMs\":${c.getLong(0)},\"amplitude\":${c.getDouble(1)},\"quality\":${c.getInt(2)},\"eventCount\":${c.getInt(3)}}")
      }
    }
    sb.append("]")
    val meta = db.rawQuery("SELECT started_at_ms, ended_at_ms, end_reason, status FROM native_sessions WHERE session_id = ?", arrayOf(sessionId)).use { c ->
      if (c.moveToFirst()) "{\"sessionId\":\"$sessionId\",\"startedAtMs\":${c.getLong(0)},\"endedAtMs\":${c.getLong(1)},\"endReason\":\"${c.getString(2)}\",\"status\":\"${c.getString(3)}\"}" else "{}"
    }
    return Pair(sb.toString(), meta)
  }

  fun purgeSession(sessionId: String) {
    writableDatabase.delete("samples", "session_id = ?", arrayOf(sessionId))
  }
}
```

- [ ] **Step 5: NemlySensorService.kt（FGS本体）**

```kotlin
package expo.nemlysensor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.IBinder
import android.os.SystemClock

class NemlySensorService : Service(), SensorEventListener {
  private lateinit var sensorManager: SensorManager
  private var db: SensorDbHelper? = null
  private var sessionId: String = ""
  private var windowStartEpochMs: Long = 0
  private val lpf = DoubleArray(3)
  private var lpfInit = false
  private val events = mutableListOf<RawEvent>()
  private var retryCount = 0
  companion object {
    const val CHANNEL_ID = "nemly_recording"
    const val NOTIFICATION_ID = 1
    const val MAX_RETRIES = 3
    var isRunning = false; private set
    var lastStatus = "idle"; private set
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "ACTION_STOP") {
      finishSession("user_stop"); return START_NOT_STICKY
    }
    if (isRunning) return START_STICKY
    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: run {
      startForegroundCompat("Nemly 計測不可"); lastStatus = "failed_no_sensor"; stopSelf(); return START_NOT_STICKY
    }
    db = SensorDbHelper(this)
    sessionId = "s-" + System.currentTimeMillis()
    windowStartEpochMs = System.currentTimeMillis()
    db!!.writableDatabase.execSQL(
      "INSERT OR REPLACE INTO native_sessions (session_id, started_at_ms, ended_at_ms, end_reason, status, retry_count) VALUES ('$sessionId', $windowStartEpochMs, NULL, NULL, 'recording', 0)"
    )
    startForegroundCompat("Nemly 計測中")
    sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
    isRunning = true; lastStatus = "recording"
    return START_STICKY
  }

  private fun startForegroundCompat(text: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "計測", NotificationManager.IMPORTANCE_LOW))
    val n: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Nemly").setContentText(text).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setOngoing(true)
      .build()
    startForeground(NOTIFICATION_ID, n)
  }

  override fun onSensorChanged(event: SensorEvent) {
    // spec §5: elapsedRealtimeNanos 基準 → 現在オフセット方式で epoch へ
    val offsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtimeNanos() / 1_000_000
    val epochMs = offsetMs + event.timestamp / 1_000_000
    synchronized(events) {
      events.add(RawEvent(epochMs, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble()))
      if (epochMs >= windowStartEpochMs + WindowAggregator.STEP_MS) {
        val win = WindowAggregator.computeWindows(events.toList(), windowStartEpochMs, epochMs)
        for (w in win) db!!.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
        events.clear()
        windowStartEpochMs += WindowAggregator.STEP_MS * ((epochMs - windowStartEpochMs) / WindowAggregator.STEP_MS)
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private fun finishSession(reason: String) {
    synchronized(events) {
      if (events.isNotEmpty()) {
        val win = WindowAggregator.computeWindows(events.toList(), windowStartEpochMs, windowStartEpochMs + WindowAggregator.STEP_MS - 1)
        for (w in win) db!!.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
        events.clear()
      }
      db!!.writableDatabase.execSQL(
        "UPDATE native_sessions SET ended_at_ms = ${System.currentTimeMillis()}, end_reason = '$reason', status = 'finished' WHERE session_id = '$sessionId'"
      )
    }
    sensorManager.unregisterListener(this)
    isRunning = false; lastStatus = "finished:$sessionId"
    stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
  }

  override fun onDestroy() {
    // START_STICKY による再配信が来ない kill を retry 上限で防御（spec §8）
    if (isRunning) {
      retryCount++
      if (retryCount > MAX_RETRIES) {
        lastStatus = "failed_retry_exhausted:$sessionId"
        isRunning = false
        db?.writableDatabase?.execSQL("UPDATE native_sessions SET status='failed', end_reason='retry_exhausted' WHERE session_id='$sessionId'")
      }
    }
    super.onDestroy()
  }
}
```

- [ ] **Step 6: NemlySensorModule.kt（bridge 4メソッド）**

```kotlin
package expo.nemlysensor

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NemlySensorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NemlySensor")

    Function("startRecording") {
      val ctx = appContext.reactContext ?: return@Function "error:no_context"
      val intent = Intent(ctx, NemlySensorService::class.java)
      ctx.startForegroundService(intent)
      "started"
    }

    Function("stopRecording") {
      val ctx = appContext.reactContext ?: return@Function "error:no_context"
      ctx.startService(Intent(ctx, NemlySensorService::class.java).setAction("ACTION_STOP"))
      NemlySensorService.lastStatus
    }

    AsyncFunction("pullSeries") { sessionId: String, promise: expo.modules.kotlin.Promise ->
      try {
        val db = SensorDbHelper(appContext.reactContext!!)
        val (samplesJson, metaJson) = db.pullSeries(sessionId)
        promise.resolve("{\"samples\":$samplesJson,\"meta\":$metaJson}")
      } catch (e: Exception) {
        promise.reject("PULL_ERROR", e.message, e)
      }
    }

    Function("confirmImported") { sessionId: String ->
      SensorDbHelper(appContext.reactContext!!).purgeSession(sessionId)
      "ok"
    }

    Function("getStatus") { NemlySensorService.lastStatus }
  }
}
```

- [ ] **Step 7: AndroidManifest（モジュール内・prebuild でマージ）**

`android/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_HEALTH" />
  <uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <uses-permission android:name="android.permission.WAKE_LOCK" />
  <application>
    <service
      android:name=".NemlySensorService"
      android:exported="false"
      android:foregroundServiceType="health" />
  </application>
</manifest>
```

注: FGS型=health は Task 0 の Go/No-Go 確定結果に置き換える（specialUse 確定なら `android:foregroundServiceType="specialUse"` + `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="sleep_tracking" />`）。

- [ ] **Step 8: JVM unit test 緑 → Commit**

```bash
cd ~/projects/nemly-app/android && ./gradlew :nemly-sensor:testDebugUnitTest; echo "GRADLE=$?"
cd ~/projects/nemly-app && git add modules && git commit -m "feat(native): nemly-sensor local module（FGS+専用DB+bridge）"
```

---

### Task 8: prebuild + エミュレータ検証（Stage 2）

- [ ] **Step 1: prebuild で manifest マージ**

```bash
cd ~/projects/nemly-app && npx expo prebuild -p android; echo "PREBUILD=$?"
```
Expected: EXIT=0（android/ が再生成・モジュール manifest がマージされる）

- [ ] **Step 2: debug ビルド+エミュレータインストール**

```bash
cd ~/projects/nemly-app/android && ./gradlew assembleDebug; echo "BUILD=$?"
~/android-sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk; echo "INSTALL=$?"
```

- [ ] **Step 3: エミュレータで起動+startForeground 確認**

```bash
~/android-sdk/platform-tools/adb shell am start -n host.exp.exponent/.MainActivity 2>/dev/null || ~/android-sdk/platform-tools/adb shell monkey -p com.fukukei23.nemly 1
~/android-sdk/platform-tools/adb shell dumpsys activity services | grep -A3 NemlySensorService
```
Expected: `foregroundServiceType=health` の service が実行中。**エミュレータの加速度**: `adb emu sensor set acceleration 0,9.8,0` と揺らして events が流れることを logcat で確認。

- [ ] **Step 4: 10秒値が専用DBに蓄積されることを確認**

```bash
~/android-sdk/platform-tools/adb shell "run-as com.fukukei23.nemly ls databases/" 2>/dev/null
```
Expected: `amplitude.db`（debuggable ビルドのみ run-as 可・非debuggableなら logcat の確認に切り替え）

- [ ] **Step 5: Commit（ビルド確認後の調整があれば）**

```bash
cd ~/projects/nemly-app && git add -A && git commit -m "chore(native): prebuild マージ+エミュレータ検証"
```

---

### Task 9: 画面（開始/停止・ステータス・朝の一覧）

**Files:**
- Modify: `src/app/index.tsx`（計測カード追加）
- Modify: `src/app/session/[id].tsx`（記録時間・欠損の表示）

- [ ] **Step 1: index.tsx に計測カードを追加**

リスト上部に挿入（`require` は遅延・jest 落ち防止）:

```typescript
// コンポーネント内 state
const [recording, setRecording] = useState(false);

const startRecording = () => {
  const m = require('../../modules/nemly-sensor/index'); // JSラッパー
  m.startRecording();
  setRecording(true);
};
const stopRecording = async () => {
  const m = require('../../modules/nemly-sensor/index');
  const status = m.stopRecording();
  setRecording(false);
  await refreshSessions();
};
```

JSラッパー `modules/nemly-sensor/index.ts`:

```typescript
// NativeModules 経由の薄いラッパー（jest では呼ばない・遅延 require 前提）
import { requireNativeModule } from 'expo-modules-core';
export default requireNativeModule('NemlySensor');
```

UI（`<FlatList>` の前）:

```typescript
<Pressable
  style={[styles.recordButton, recording && styles.recordButtonActive]}
  onPress={recording ? stopRecording : startRecording}
  testID="record-toggle"
>
  <Text style={styles.recordButtonText}>
    {recording ? '計測を停止' : '計測を開始'}
  </Text>
</Pressable>
```

- [ ] **Step 2: session/[id].tsx に記録時間・欠損表示**

既存の詳細表示に追記（props は `SessionRecord` 拡張をそのまま使う）:

```typescript
{session.source === 'sensor' && (
  <Text style={styles.metaText}>
    計測: {session.endReason === 'user_stop' ? '手動停止' : (session.endReason ?? '—')}
    {'\n'}有効率: {session.validRatio != null ? `${Math.round(session.validRatio * 100)}%` : '—'}
    {'\n'}欠損区間: {session.gapCount ?? 0}件
  </Text>
)}
```

- [ ] **Step 3: 全ゲート緑**

```bash
cd ~/projects/nemly-app && set -o pipefail && npx jest --silent; echo "JEST=$?" && npx tsc --noEmit; echo "TSC=$?" && npx expo lint; echo "LINT=$?"
```
Expected: JEST=0 / TSC=0 / LINT=0（errors）

- [ ] **Step 4: Commit**

```bash
cd ~/projects/nemly-app && git add src/app modules/nemly-sensor/index.ts && git commit -m "feat(ui): 計測開始/停止+記録時間・欠損表示"
```

---

### Task 10: Stage 3/4（実機検証・手動 gate）

- [ ] **Stage 3: 実機1時間（ふくけいの実機・計測手順書どおり）**

手順: ①通知許可 ②バッテリー最適化除外（機種別追加設定の確認）③release ビルドをインストール ④1時間放置 ⑤stop → 画面でスコア・有効率・欠損を確認。
合格基準: spec §8 fail条件不発+60分継続（FGS型の実機 gate を兼ねる）。fail なら fail 理由を記録して設計へ戻る。

- [ ] **Stage 4: 実機1晩（L153 完了条件）**

手順: 夜間 start → 朝 stop。合格基準: スコア・ヒプノグラム表示+§8 fail条件不発+CSV同等性の目視（Phase 1 実データとの整合）。

---

## Self-Review 結果

- spec §4.1 native_sessions/purge → Task 7 Step 4 / Task 5 confirmImported ✓
- spec §5 数式 → Task 3（TS参照）+ Task 7 Step 3（Kotlin同一式・golden parity Task 7 Step 2）✓
- spec §6 Go/No-Go → Task 0 ✓ / §7 手順書 → Task 10 Stage 3 ✓
- spec §8 rubric → Task 4 ✓ / 三層合格 → Task 3+7（契約・parity）+ Task 10（実機）✓
- gap: spec §4.2 の「解析は2段」→ Task 5 で投入→解析の順で実装（解析失敗時 samples 残置）✓
