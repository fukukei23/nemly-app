# nemly-app UI/UX 仕上げ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1の最小構成画面を「深夜パレット」テーマで仕上げる（挙動不変・テスト161緑維持）

**Architecture:** `theme.ts`に色を一元定義 → 共通コンポーネント（ScoreGauge/HypnogramBar/SessionCard）を`components/ui/`に新設 → 3画面をテーマ適用で書換。既存ロジック（repository/sleepAlgorithm/sensor）は触らない。

**Tech Stack:** React Native（Expo SDK 58）・expo-router・react-test-renderer（スナップショット新規導入）

**spec:** `docs/superpowers/specs/2026-10-30-nemly-uiux-design.md`（ふくけいOK済み）

---

### Task 1: theme.ts 新設 + 一貫性テスト

**Files:**
- Create: `src/constants/theme.ts`
- Test: `src/constants/theme.test.ts`

- [ ] **Step 1: 失敗テストを書く**

```ts
// src/constants/theme.test.ts
import { theme } from "./theme";

describe("theme", () => {
  it("深夜パレットの基調色が定義されている", () => {
    expect(theme.colors.bg).toBe("#0F1420");
    expect(theme.colors.surface).toBe("#1A2233");
    expect(theme.colors.text).toBe("#E8ECF4");
    expect(theme.colors.textSub).toBe("#8A94AC");
    expect(theme.colors.accent).toBe("#7C6FF0");
    expect(theme.colors.gold).toBe("#F0D080");
  });

  it("睡眠段階の4色+BROKENが定義されている", () => {
    expect(theme.colors.phase).toEqual({
      DEEP: "#3B4FA0",
      LIGHT: "#4A5A78",
      REM: "#8B5FC7",
      AWAKE: "#E08A4A",
      BROKEN: "#6B7280",
    });
  });

  it("すべての色は有効なhex形式", () => {
    const flat = [
      theme.colors.bg,
      theme.colors.surface,
      theme.colors.text,
      theme.colors.textSub,
      theme.colors.accent,
      theme.colors.gold,
      ...Object.values(theme.colors.phase),
    ];
    for (const c of flat) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("スペーシングと角丸が定義されている", () => {
    expect(theme.spacing.card).toBe(16);
    expect(theme.radius.card).toBe(12);
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest src/constants/theme.test.ts`
Expected: FAIL（theme not found）

- [ ] **Step 3: theme.tsを実装**

```ts
// src/constants/theme.ts
/** 深夜パレット — 色は本ファイルで一元管理（spec: docs/superpowers/specs/2026-10-30-nemly-uiux-design.md） */
export const theme = {
  colors: {
    bg: "#0F1420",
    surface: "#1A2233",
    text: "#E8ECF4",
    textSub: "#8A94AC",
    accent: "#7C6FF0",
    gold: "#F0D080",
    phase: {
      DEEP: "#3B4FA0",
      LIGHT: "#4A5A78",
      REM: "#8B5FC7",
      AWAKE: "#E08A4A",
      BROKEN: "#6B7280",
    },
  },
  typography: {
    title: { fontSize: 26, fontWeight: "700" },
    section: { fontSize: 18, fontWeight: "700" },
    body: { fontSize: 16 },
    sub: { fontSize: 13 },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    card: 16,
    lg: 24,
  },
  radius: {
    chip: 11,
    card: 12,
    gauge: 24,
  },
} as const;
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx jest src/constants/theme.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/constants/theme.ts src/constants/theme.test.ts
git commit -m "feat(uiux): theme.ts新設（深夜パレット一元定義・一貫性テスト）"
```

---

### Task 2: react-test-renderer 導入

**Files:**
- Modify: `package.json`（expo install経由）

- [ ] **Step 1: expo install（SDK互換バージョン解決）**

Run: `npx expo install react-test-renderer @types/react-test-renderer`
Expected: package.jsonに追記される

- [ ] **Step 2: 動作確認（既存テストが壊れないこと）**

Run: `npx jest --silent` （全テスト）
Expected: 既存161件 PASS（新規依存で壊れない）

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(uiux): react-test-renderer導入（スナップショットテスト用）"
```

---

### Task 3: ScoreGauge コンポーネント

**Files:**
- Create: `src/components/ui/ScoreGauge.tsx`
- Test: `src/components/ui/__tests__/ScoreGauge.test.tsx`

- [ ] **Step 1: 失敗テストを書く**

```tsx
// src/components/ui/__tests__/ScoreGauge.test.tsx
import React from "react";
import TestRenderer from "react-test-renderer";
import { ScoreGauge } from "../ScoreGauge";

describe("ScoreGauge", () => {
  it("スコア数字とゴールド輪の円形を描画する", () => {
    const tree = TestRenderer.create(<ScoreGauge score={67} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- を表示する", () => {
    const tree = TestRenderer.create(<ScoreGauge score={null} />).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest src/components/ui/__tests__/ScoreGauge.test.tsx`
Expected: FAIL（ScoreGauge not found）

- [ ] **Step 3: 実装**

```tsx
// src/components/ui/ScoreGauge.tsx
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { theme } from "@/constants/theme";

/** スコア円形ゲージ（ゴールド輪・中央に数字） */
export function ScoreGauge({ score, size = 96 }: { score: number | null; size?: number }) {
  return (
    <View
      style={[
        styles.gauge,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={styles.score}>{score ?? "--"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gauge: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 6,
    borderColor: theme.colors.gold,
    backgroundColor: "transparent",
  },
  score: {
    fontSize: size => size / 2.4, // NOTE: StyleSheetでは関数不可のため実装は下の書換参照
  },
});
```

**⚠️ 書換（StyleSheetは関数不可のため、数値直書きに修正）:** 上記`score`スタイルを`{ fontSize: 40, fontWeight: "700", color: theme.colors.gold }`に置き換える（sizeはデフォルト96固定・可変が必要になった時のみ引数化する）。

- [ ] **Step 4: テスト通過を確認**

Run: `npx jest src/components/ui/__tests__/ScoreGauge.test.tsx`
Expected: PASS（2 tests・スナップショット2件生成）

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/ScoreGauge.tsx src/components/ui/__tests__/ScoreGauge.test.tsx src/components/ui/__tests__/__snapshots__/
git commit -m "feat(uiux): ScoreGaugeコンポーネント（ゴールド円形ゲージ・スナップショットテスト）"
```

---

### Task 4: HypnogramBar 共通化（session/[id].tsxから抽出）

**Files:**
- Create: `src/components/ui/HypnogramBar.tsx`
- Test: `src/components/ui/__tests__/HypnogramBar.test.tsx`
- Modify: `src/app/session/[id].tsx`（PHASE_COLORS定義を削除しimportへ切替 — 詳細はTask 7）

- [ ] **Step 1: 失敗テストを書く**

```tsx
// src/components/ui/__tests__/HypnogramBar.test.tsx
import React from "react";
import TestRenderer from "react-test-renderer";
import { HypnogramBar } from "../HypnogramBar";
import type { SleepStageRow } from "@/lib/repository";

function row(phase: "DEEP" | "LIGHT" | "REM" | "AWAKE" | "BROKEN", tsMs: number): SleepStageRow {
  return { tsMs, phase } as SleepStageRow;
}

describe("HypnogramBar", () => {
  it("stage配列をphase色の横バー列で描画する", () => {
    const stages = [row("DEEP", 1), row("LIGHT", 2), row("REM", 3), row("AWAKE", 4)];
    const tree = TestRenderer.create(<HypnogramBar stages={stages} height={36} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("空配列でもクラッシュしない", () => {
    const tree = TestRenderer.create(<HypnogramBar stages={[]} height={36} />).toJSON();
    expect(tree).not.toBeNull();
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest src/components/ui/__tests__/HypnogramBar.test.tsx`
Expected: FAIL（HypnogramBar not found）

- [ ] **Step 3: 実装**

```tsx
// src/components/ui/HypnogramBar.tsx
import React from "react";
import { StyleSheet, View } from "react-native";

import type { SleepStageRow } from "@/lib/repository";
import { theme } from "@/constants/theme";

/** ヒプノグラム横バー（phase色分け・時系列・高さはheightで指定） */
export function HypnogramBar({ stages, height = 36 }: { stages: SleepStageRow[]; height?: number }) {
  return (
    <View style={styles.row}>
      {stages.map((stage) => (
        <View
          key={stage.tsMs}
          style={{ flex: 1, backgroundColor: theme.colors.phase[stage.phase], height }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    overflow: "hidden",
    borderRadius: theme.radius.chip,
  },
});
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx jest src/components/ui/__tests__/HypnogramBar.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/HypnogramBar.tsx src/components/ui/__tests__/HypnogramBar.test.tsx src/components/ui/__tests__/__snapshots__/
git commit -m "feat(uiux): HypnogramBar共通化（theme色分け・空配列安全）"
```

---

### Task 5: SessionCard コンポーネント

**Files:**
- Create: `src/components/ui/SessionCard.tsx`
- Test: `src/components/ui/__tests__/SessionCard.test.tsx`

- [ ] **Step 1: 失敗テストを書く**

```tsx
// src/components/ui/__tests__/SessionCard.test.tsx
import React from "react";
import TestRenderer from "react-test-renderer";
import { SessionCard } from "../SessionCard";

const base = {
  id: 1,
  startMs: 1_792_867_680_000,
  endMs: 1_792_895_480_000,
  sampleCount: 1342,
  deepRatio: 0.22,
  lightRatio: 0.64,
  remRatio: 0.13,
  awakeRatio: 0.01,
  score: 67,
};

describe("SessionCard", () => {
  it("日付・時間・スコア・ミニヒプノグラムを描画する", () => {
    const tree = TestRenderer.create(
      <SessionCard session={{ ...base, source: "sensor" as const }} onPress={jest.fn()} />,
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("score=null のとき -- 表示", () => {
    const tree = TestRenderer.create(
      <SessionCard session={{ ...base, score: null, source: "import" as const }} onPress={jest.fn()} />,
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });
});
```

**⚠️ 注: `base`のフィールドは`SessionRecord`の実型に合わせて調整すること（Task開始時に`src/lib/repository.ts:27`を確認・sourceフィールドが無い場合は削る）。**

- [ ] **Step 2: テスト失敗を確認**

Run: `npx jest src/components/ui/__tests__/SessionCard.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装**

```tsx
// src/components/ui/SessionCard.tsx
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SessionRecord } from "@/lib/repository";
import { theme } from "@/constants/theme";

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDuration(startMs: number, endMs: number): string {
  const minutes = Math.round((endMs - startMs) / 60000);
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** セッション一覧カード（日付・時間・スコア・ミニヒプノグラム帯） */
export function SessionCard({ session, onPress }: { session: SessionRecord; onPress: (id: number) => void }) {
  return (
    <Pressable style={styles.card} onPress={() => onPress(session.id)}>
      <View style={styles.header}>
        <Text style={styles.day}>{formatDay(session.startMs)}</Text>
        <Text style={styles.score}>{session.score ?? "--"}</Text>
      </View>
      <Text style={styles.duration}>{formatDuration(session.startMs, session.endMs)}</Text>
      <View style={styles.bar}>
        <View style={[styles.seg, { flex: session.deepRatio, backgroundColor: theme.colors.phase.DEEP }]} />
        <View style={[styles.seg, { flex: session.remRatio, backgroundColor: theme.colors.phase.REM }]} />
        <View style={[styles.seg, { flex: session.awakeRatio, backgroundColor: theme.colors.phase.AWAKE }]} />
        <View style={[styles.seg, { flex: session.lightRatio, backgroundColor: theme.colors.phase.LIGHT }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    marginBottom: theme.spacing.md,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  day: { fontSize: 13, color: theme.colors.textSub },
  score: { fontSize: 40, fontWeight: "700", color: theme.colors.gold },
  duration: { fontSize: 16, color: theme.colors.text, marginTop: 4 },
  bar: { flexDirection: "row", height: 14, marginTop: 12, borderRadius: theme.radius.chip, overflow: "hidden" },
  seg: { height: 14 },
});
```

**⚠️ 注: `SessionRecord`に`awakeRatio`が無い場合は既存フィールドから算出（`1 - deep - light - rem`）に修正。Task開始時に型を確認。**

- [ ] **Step 4: テスト通過を確認**

Run: `npx jest src/components/ui/__tests__/SessionCard.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/SessionCard.tsx src/components/ui/__tests__/SessionCard.test.tsx src/components/ui/__tests__/__snapshots__/
git commit -m "feat(uiux): SessionCardコンポーネント（スコアゴールド・比率バー）"
```

---

### Task 6: Home（index.tsx）テーマ適用

**Files:**
- Modify: `src/app/index.tsx`（全画面・StyleSheet書換）

- [ ] **Step 1: index.tsxをテーマ適用に書換**

要点（構造は既存のまま・見た目のみ変更）:
- `SafeAreaView`の背景を`theme.colors.bg`に
- 計測カード: `surface`背景+角丸12+「▶ 開始/■ 停止」を`accent`色・計測中はアクセントドット表示
- セッション一覧: `SessionCard`コンポーネントに置換（FlatList renderItem）
- CSVインポート導線ボタン: `surface`背景+`accent`枠線
- `StyleSheet`の色リテラルを全て`theme.*`参照に置換

完全コードは実装時に index.tsx の現行構造（state/handlerはそのまま）へ上のスタイル規則を適用して書く。**ロジック（waitForServiceStop/handleToggleRecording/refreshSessions）は1行も変更しない。**

- [ ] **Step 2: 既存テスト+新規テスト全通過を確認**

Run: `npx jest --silent`
Expected: 全PASS（161維持+新規）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 3: Commit**

```bash
git add src/app/index.tsx
git commit -m "feat(uiux): Home画面を深夜パレットに適用（挙動不変）"
```

---

### Task 7: セッション詳細（session/[id].tsx）テーマ適用

**Files:**
- Modify: `src/app/session/[id].tsx`

- [ ] **Step 1: 書換**

- 既存`PHASE_COLORS`定義（L14-20）を削除 → `theme.colors.phase`参照へ
- 既存`HypnogramBar`（L35-46）を削除 → `components/ui/HypnogramBar` importへ
- スコア表示を`ScoreGauge`（`session.score`渡し）へ変更
- 統計チップ（RatioRow）の色を`theme.colors.phase`へ
- `StyleSheet`の色リテラルを`theme.*`へ置換

**挙動不変の制約**: データ取得（listSessions/getSessionStages）とphase比率計算は変更しない。

- [ ] **Step 2: 全テスト+tsc確認**

Run: `npx jest --silent && npx tsc --noEmit`
Expected: 全PASS・エラー0

- [ ] **Step 3: Commit**

```bash
git add src/app/session/[id].tsx
git commit -m "feat(uiux): セッション詳細を深夜パレット適用（ScoreGauge/theme色分け）"
```

---

### Task 8: import画面+_layout ダーク固定

**Files:**
- Modify: `src/app/import.tsx`
- Modify: `src/app/_layout.tsx`

- [ ] **Step 1: import.tsx テーマ適用**（背景/カード/ボタンを`theme.*`へ・ロジック不変）
- [ ] **Step 2: _layout.tsx をダーク固定に変更**

```tsx
// _layout.tsx の書換（Theme固定）
import { DarkTheme, ThemeProvider, Stack } from 'expo-router';
import { theme } from '@/constants/theme';

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.colors.bg,
    card: theme.colors.surface,
    text: theme.colors.text,
    primary: theme.colors.accent,
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navTheme}>
      <Stack>...</Stack>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: 全検証**

Run: `npx jest --silent && npx tsc --noEmit && npx expo lint`
Expected: 全PASS・エラー0・lintエラー0

- [ ] **Step 4: Commit**

```bash
git add src/app/import.tsx src/app/_layout.tsx
git commit -m "feat(uiux): import画面テーマ適用+ナビゲーションダーク固定"
```

---

### Task 9: エミュレータ起動 + スクショ目視

- [ ] **Step 1: エミュレータ起動**

Run: `ANDROID_AVD_HOME=$HOME/.android/avd $HOME/android-sdk/emulator/emulator -avd microwin-test -no-window -no-audio -no-boot-anim &` → `adb wait-for-device` → boot完了待ち（`sys.boot_completed=1`確認）

- [ ] **Step 2: リリースビルド or dev client でインストール・起動**

（debugビルド: `npx expo run:android`・Metro必要に注意 — Metro 8081はMicroWin占有のため nemly側は `--port 8082`）

- [ ] **Step 3: スクショ取得 → CCがReadで目視**

Run: `adb exec-out screencap -p > /tmp/nemly-ui-home.png` → Read で視認（配色・レイアウト・ゴールドスコアを確認）
Expected: 深夜パレットが適用された画面・既存機能が動作

- [ ] **Step 4: 問題なければ完了報告（問題があれば修正→再撮）**
