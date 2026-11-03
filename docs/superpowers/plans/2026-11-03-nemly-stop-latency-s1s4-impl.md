# nemly 停止処理高速化 §1/§3/§4/§5 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 停止 tap 後の UI 復帰を 15秒→≤5秒 にする。DB 接続 singleton 化（§1）+finishSession 堅牢化（§3）+import 非同期化（§4）+waitForServiceStop の sessionId 照合（§5）を実装する。

**Architecture:** Kotlin 側（SensorDbHelper singleton・lease 排他 API・Service 堅牢化）と JS 側（fire-and-forget import・importing ガード2層・UI 表示）を分けて実装する。Kotlin は Android framework 依存のため JVM ユニットテスト不可（実機 §7 で担保）→コンパイルゲート。JS は waitForStop を lib 化して TDD。

**Tech Stack:** Expo SDK 58 / React Native / Kotlin（expo-modules・jvmTarget 17）/ jest-expo / bun test（**分割実行必須・一括 bun test は9時間ハングの実測**）

**設計書（正典）:** `docs/superpowers/specs/2026-11-03-nemly-stop-latency-design.md`（MLR 4ラウンド・181指摘統合済み）

---

## スコープ（実測確定・2026-11-03 13:2x CC照合）

| 設計書セクション | 現状 | 本計画 |
|---|---|---|
| §1 singleton化+busy_timeout | 未実装（Module L41/50/67・Service L81 で新規生成） | **Task 1** |
| §3 finishSession 堅牢化 | 未実装（try/finally 無し・AtomicBoolean 無し） | **Task 2** |
| §4 非同期化+importing ガード | 未実装（stop 分岐が同期 await） | **Task 3（native lease）+ Task 5（JS）** |
| §5 waitForServiceStop sessionId 照合 | 未実装（isFinishedStatus のみで照合無し） | **Task 4** |
| §2 status 遷移拡張（importing/imported/import_failed・expo-sqlite migration） | 部分実装（finished のみ・回収は getPendingSessionId 簡易方式） | **スコープ外**（既存簡易実装で同根解消済み・handoff `2026-11-03_1302` 方針。§7 実機検証で問題確認時に起票） |
| §7/§8 定量検証 | — | **Task 7（ビルド+配布まで）→実機検証は続行タスク** |

**⚠️ nemly-app テストは分割実行が必須**（一括 `bun test` は9時間ハング実測・`00_SYSTEM/テスト実行ガイド.md`）:

```bash
cd ~/projects/nemly-app
bun test src/lib/__tests__/sqliteRepository.test.ts src/lib/migration/__tests__/migrationRunner.test.ts   # 37件
bun test src/constants src/lib/__tests__/repository.test.ts src/lib/sensor                                # 43件+新規
bun test src/lib/__tests__/csvImport.test.ts src/lib/__tests__/sleepScore.test.ts                         # 26件
```

---

### Task 1: §1 SensorDbHelper singleton 化+busy_timeout

**Files:**
- Modify: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/SensorDbHelper.kt`（全体再構成・現行123行）
- Modify: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorModule.kt:41,50,67`（新規生成→get()）
- Modify: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorService.kt:81`（新規生成→get()）

- [ ] **Step 1: SensorDbHelper.kt を singleton 化**

クラス宣言（現行 L13-14）を置換:

```kotlin
class SensorDbHelper private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "amplitude.db", null, 1) {

  companion object {
    private const val TAG = "SensorDbHelper"
    private const val BUSY_TIMEOUT_MS = 1000L
    @Volatile
    private var instance: SensorDbHelper? = null

    /** プロセス内単一接続（設計書 §1・呼び出しごとの新規生成が journal mode 変更待ち15秒の根因） */
    fun get(context: Context): SensorDbHelper =
      instance ?: synchronized(this) {
        instance ?: SensorDbHelper(context.applicationContext).also { instance = it }
      }
  }
```

import に追加（現行 L3-6 の import ブロック）:

```kotlin
import android.database.sqlite.SQLiteDatabaseLockedException
import android.util.Log
```

onConfigure（現行 L30-33）を置換:

```kotlin
  /** WAL+busy_timeout（設計書 §1・ロック競合時は1秒待つ→例外で fail-fast） */
  override fun onConfigure(db: SQLiteDatabase) {
    db.enableWriteAheadLogging()
    db.execSQL("PRAGMA busy_timeout = $BUSY_TIMEOUT_MS")
  }
```

リトライ helper をクラス内に追加（onUpgrade の後ろ・insertSample の前）:

```kotlin
  /**
   * 設計書 §1: busy_timeout 満了時は SQLiteDatabaseLockedException で fail-fast。
   * 明示リトライ1回（再度失敗時は呼び出し側へ例外伝播・黙り込まない）
   */
  private fun <T> withLockRetry(block: () -> T): T =
    try {
      block()
    } catch (e: SQLiteDatabaseLockedException) {
      Log.w(TAG, "db locked (busy_timeout ${BUSY_TIMEOUT_MS}ms), retrying once: ${e.message}")
      block()
    }
```

全 DB 操作メソッド（insertSample / startSession / finishSession / markFailed / pullSeries / purgeSession / getPendingSessionId）の本体を `withLockRetry { ... }` で包む。例（insertSample・現行 L37-47）:

```kotlin
  /** UNIQUE(session_id, ts_ms) 衝突は CONFLICT_IGNORE（再取り込み=正常系・first-wins） */
  fun insertSample(sessionId: String, tsMs: Long, amplitude: Double, quality: Int, eventCount: Int) =
    withLockRetry {
      val cv = ContentValues().apply {
        put("session_id", sessionId)
        put("ts_ms", tsMs)
        put("amplitude", amplitude)
        put("quality", quality)
        put("event_count", eventCount)
      }
      writableDatabase.insertWithOnConflict("samples", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
    }
```

同様に startSession / finishSession / markFailed / purgeSession / getPendingSessionId は `= withLockRetry { ... }`（Unit でも返値でも動く）。pullSeries は `fun pullSeries(sessionId: String): Pair<String, String> = withLockRetry { ...現行本体... }`。

- [ ] **Step 2: Module/Service の呼び出し箇所を get() 経由に統一**

NemlySensorModule.kt（3箇所）:

- L41: `val db = SensorDbHelper(appContext.reactContext!!)` → `val db = SensorDbHelper.get(appContext.reactContext!!)`
- L50: `SensorDbHelper(appContext.reactContext!!).purgeSession(sessionId)` → `SensorDbHelper.get(appContext.reactContext!!).purgeSession(sessionId)`
- L67: `SensorDbHelper(appContext.reactContext!!).getPendingSessionId() ?: ""` → `SensorDbHelper.get(appContext.reactContext!!).getPendingSessionId() ?: ""`

NemlySensorService.kt L81:

- `dbHelper = SensorDbHelper(this)` → `dbHelper = SensorDbHelper.get(this)`

- [ ] **Step 3: コンパイル確認**

```bash
cd ~/projects/nemly-app/android && ./gradlew nemly-sensor:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`（exit 0）

- [ ] **Step 4: Commit**

```bash
cd ~/projects/nemly-app && git commit-scoped -m "feat(sensor): §1 SensorDbHelper singleton化+busy_timeout（呼び出しごとの新規生成がjournal mode変更待ち15秒の根因・設計書§1）" -- modules/nemly-sensor/android/src/main/java/expo/nemlysensor/SensorDbHelper.kt modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorModule.kt modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorService.kt
```

---

### Task 2: §3 finishSession 堅牢化（try/finally+AtomicBoolean）

**Files:**
- Modify: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorService.kt:31,81,154,187-211,218`

- [ ] **Step 1: finishing AtomicBoolean を追加し startSession でリセット**

import 追加（現行 import ブロック末尾 L19 付近）:

```kotlin
import java.util.concurrent.atomic.AtomicBoolean
```

フィールド（現行 L31 `private var dbHelper: SensorDbHelper? = null` を削除し、以下に置換）:

```kotlin
  private val finishing = AtomicBoolean(false)
```

startSession 直前（Task 1 で `dbHelper = SensorDbHelper.get(this)` に変更済みの行を削除し、`finishing.set(false)` に置換）:

```kotlin
    // Task 2: 前回停止で true のまま残った CAS を解除しないと2回目の計測が停止できなくなる
    finishing.set(false)
    sessionId = "s-" + System.currentTimeMillis()
```

**⚠️ この1行が無いと2回目の計測開始→停止が効かなくなる（実バグ）。**

- [ ] **Step 2: onSensorChanged を get(this) 直呼びに変更**

現行 L154 `val db = dbHelper ?: return` を置換:

```kotlin
    val db = SensorDbHelper.get(this)
```

- [ ] **Step 3: finishSession を try/finally+CAS 構造化**

現行 L187-211 を置換:

```kotlin
  private fun finishSession(reason: String) {
    if (!finishing.compareAndSet(false, true)) return
    try {
      val db = SensorDbHelper.get(this)
      synchronized(events) {
        if (events.isNotEmpty()) {
          val win = WindowAggregator.computeWindows(
            events.toList(),
            windowStartEpochMs,
            windowStartEpochMs + WindowAggregator.STEP_MS - 1
          )
          for (w in win) {
            db.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
          }
          events.clear()
        }
        db.finishSession(sessionId, System.currentTimeMillis(), reason)
      }
    } finally {
      // 設計書 §3: 途中で例外が起きても後片付け（unregister/release/status更新/stopSelf）を必ず実行
      sensorManager.unregisterListener(this)
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
      isRunning = false
      lastStatus = "finished:$sessionId"
      Log.i(TAG, "recording finished: $sessionId reason=$reason")
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }
```

- [ ] **Step 4: onDestroy の dbHelper 参照を置換**

現行 L218 `val db = dbHelper` を置換:

```kotlin
      val db = if (isRunning) SensorDbHelper.get(this) else null
```

（現行の `db?.markFailed(sessionId, "retry_exhausted")` はそのまま動く）

- [ ] **Step 5: コンパイル確認**

```bash
cd ~/projects/nemly-app/android && ./gradlew nemly-sensor:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`（exit 0）

- [ ] **Step 6: Commit**

```bash
cd ~/projects/nemly-app && git commit-scoped -m "feat(sensor): §3 finishSession堅牢化（try/finally+AtomicBoolean CAS・dbHelper singleton直参照・設計書§3）" -- modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorService.kt
```

---

### Task 3: §4 native lease API（importing 排他判定の正）

**Files:**
- Modify: `modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorModule.kt`
- Modify: `modules/nemly-sensor/index.ts`
- Modify: `src/lib/sensor/nativeSource.ts`

- [ ] **Step 1: Module に lease companion+3関数を追加**

NemlySensorModule.kt — companion object をクラス先頭（`override fun definition()` の前）に追加:

```kotlin
  companion object {
    private const val IMPORT_LEASE_MS = 30_000L
    @Volatile
    private var importLeaseUntilMs: Long = 0L

    /** 設計書 §4: 排他判定の正（JS state は表示制御のみ）。lease 形式で fire-and-forget 死亡時も30秒で自動解放 */
    fun isImporting(): Boolean = System.currentTimeMillis() < importLeaseUntilMs
  }
```

startRecording（現行 L15-28）の冒頭にガード追加:

```kotlin
    Function("startRecording") { durationMinutes: Double? ->
      // 設計書 §4: importing 中は startRecording のみ拒否（stopRecording は許可）
      if (isImporting()) return@Function "error:importing"
      val ctx = appContext.reactContext
        ?: return@Function "error:no_context"
      // （以下現行のまま・retryCount=0 から ctx.startForegroundService(intent) まで）
```

定義末尾（`Function("getPendingSessionId")` の後）に3関数追加:

```kotlin
    // 設計書 §4: import 排他 lease（JS から import 開始/終了時に呼ぶ・30秒自動期限切れ）
    Function("startImportLease") {
      importLeaseUntilMs = System.currentTimeMillis() + IMPORT_LEASE_MS
      "ok"
    }
    Function("endImportLease") {
      importLeaseUntilMs = 0L
      "ok"
    }
    Function("isImporting") { isImporting() }
```

- [ ] **Step 2: bridge interface に型定義追加**

modules/nemly-sensor/index.ts の `NemlySensorModuleType` interface（現行 L6-17）に追加（`getPendingSessionId` の後）:

```typescript
  /** import 排他 lease（設計書 §4・30秒自動期限切れ・fire-and-forget 死亡時の flag 残留を防ぐ） */
  startImportLease(): string;
  endImportLease(): string;
  isImporting(): boolean;
```

- [ ] **Step 3: nativeSource.ts にラッパー追加**

`NativeModule` type（現行 L6-14）に追加:

```typescript
  startImportLease(): string;
  endImportLease(): string;
  isImporting(): boolean;
```

ファイル末尾にラッパー関数追加:

```typescript
export function nativeStartImportLease(): string {
  return loadNative().startImportLease();
}

export function nativeEndImportLease(): string {
  return loadNative().endImportLease();
}

export function nativeIsImporting(): boolean {
  return loadNative().isImporting();
}
```

- [ ] **Step 4: typecheck 確認**

```bash
cd ~/projects/nemly-app && bunx tsc --noEmit
```

Expected: exit 0（エラー0件）

- [ ] **Step 5: Kotlin コンパイル確認**

```bash
cd ~/projects/nemly-app/android && ./gradlew nemly-sensor:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`（exit 0）

- [ ] **Step 6: Commit**

```bash
cd ~/projects/nemly-app && git commit-scoped -m "feat(sensor): §4 native import lease API（30秒自動期限切れ・startRecordingのみ拒否・設計書§4）" -- modules/nemly-sensor/android/src/main/java/expo/nemlysensor/NemlySensorModule.kt modules/nemly-sensor/index.ts src/lib/sensor/nativeSource.ts
```

---

### Task 4: §5 waitForServiceStop の sessionId 照合（lib化・TDD）

**Files:**
- Create: `src/lib/sensor/waitForStop.ts`
- Create: `src/lib/sensor/__tests__/waitForStop.test.ts`
- Modify: `src/app/index.tsx`（ローカル waitForServiceStop 削除・Task 5 で使用に切替）

- [ ] **Step 1: 失敗するテストを書く**

src/lib/sensor/__tests__/waitForStop.test.ts を新規作成:

```typescript
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
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
cd ~/projects/nemly-app && bun test src/lib/sensor/__tests__/waitForStop.test.ts; echo "EXIT=$?"
```

Expected: FAIL（`Cannot find module '../waitForStop'`・exit 非ゼロ）

- [ ] **Step 3: waitForStop.ts を実装**

src/lib/sensor/waitForStop.ts を新規作成:

```typescript
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
```

- [ ] **Step 4: テストが通ることを確認**

```bash
cd ~/projects/nemly-app && bun test src/lib/sensor/__tests__/waitForStop.test.ts; echo "EXIT=$?"
```

Expected: 5 tests PASS・exit 0

- [ ] **Step 5: mutation check（テスト実行ガイド原則・新規テストファイルに必須）**

実装の照合条件を壊して FAIL 検知を確認する。waitForStop.ts の照合行を一時変更:

```typescript
    if (isFinishedStatus(readStatus())) return true;
```

（import も `isFinishedStatus` に変更・sessionId 照合を any-finished に弱体化させる=前回残留バグの再現）

```bash
cd ~/projects/nemly-app && bun test src/lib/sensor/__tests__/waitForStop.test.ts; echo "EXIT=$?"
```

Expected: **「前回残留」テストが FAIL**（exit 非ゼロ・FAIL 1件以上）

壊しを戻す（照合条件を `=== target` に復元）:

```bash
cd ~/projects/nemly-app && bun test src/lib/sensor/__tests__/waitForStop.test.ts; echo "EXIT=$?"
```

Expected: 5 tests PASS・exit 0

- [ ] **Step 6: Commit**

```bash
cd ~/projects/nemly-app && git commit-scoped -m "feat(sensor): §5 waitForServiceStop lib化+sessionId照合（前回残留finishedで即trueになる実バグの一次修正・poll 200ms・設計書§5）+TDD+mutation check" -- src/lib/sensor/waitForStop.ts src/lib/sensor/__tests__/waitForStop.test.ts
```

---

### Task 5: §4 JS 非同期化（fire-and-forget+importing ガード+UI 表示）

**Files:**
- Modify: `src/app/index.tsx`

- [ ] **Step 1: import と state を整理**

index.tsx 冒頭 import 変更:

- `import { importSensorSession } from '@/lib/sensor/sensorImport';` は現行維持
- `import { isFinishedStatus, parseNativeStatus } from '@/lib/sensor/autoImport';` は現行維持
- nativeSource の import（現行 L10-16）に追加:

```typescript
import {
  createNativeSensorSource,
  nativeGetLastSessionId,
  nativeGetPendingSessionId,
  nativeGetStatus,
  nativeStartImportLease,
  nativeStartRecording,
  nativeStopRecording,
  nativeEndImportLease,
  nativeIsImporting,
} from '@/lib/sensor/nativeSource';
```

waitForStop を新規 import:

```typescript
import { waitForServiceStop } from '@/lib/sensor/waitForStop';
```

state（現行 L48-52）に追加・waitForServiceStop ローカル関数（現行 L30-37）を削除:

```typescript
  const [importPhase, setImportPhase] = useState<'idle' | 'stopping' | 'recovering'>('idle');
```

**busy state の役割変更**: 現行 busy は「全 UI 操作ブロック+同時 callback ガード」。本変更後は **busy=開始操作の短時間ブロック専用**・「取り込み中」の排他は native lease が正・表示は importPhase が担う。

タイムアウト helper をコンポーネント外に追加（formatToday の後）:

```typescript
/** 回収1件10秒タイムアウト（設計書 §4） */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
```

- [ ] **Step 2: syncFromNativeStatus を lease+タイムアウト付き recovering に変更**

現行 L66-110 を置換:

```typescript
  const syncFromNativeStatus = async (rawStatus: string) => {
    // MLR r2 MiniMax#6: 同時 callback で取り込みが並走するのを防ぐ（busy 中の復帰イベントはスキップ）
    if (busy || importPhase !== 'idle') return;
    const status = parseNativeStatus(rawStatus);
    if (status.startsWith('recording:')) {
      setRecording(true);
      return;
    }
    if (isFinishedStatus(status)) setRecording(false);
    if (!isFinishedStatus(status)) return;
    const sid = status.replace('finished:', '');
    if (sid === lastImportedRef.current) return;
    setImportPhase('recovering');
    try {
      nativeStartImportLease();
      try {
        const res = await withTimeout(importSensorSession(createNativeSensorSource()), 10_000);
        await refreshSessions();
        lastImportedRef.current = sid;
        if (res.sessionId === null && res.verdict === 'pass') {
          // 空系列（既に取り込み済みの pending 掃除）はダイアログを出さない
          return;
        }
        if (res.verdict === 'fail') {
          setDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
        } else if (res.verdict === 'degraded_pass') {
          setDialog({ title: '昼寝を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
        } else {
          setDialog({ title: '昼寝を取り込みました', message: '一覧に表示されています', tone: 'ok' });
        }
      } catch (e) {
        // 設計書 §4: 例外時は importing 解除（lease は30秒自動期限切れもあり）+次回起動の自動回収を案内
        lastImportedRef.current = '';
        setDialog({
          title: '取り込みに失敗しました',
          message: `${e instanceof Error ? e.message : String(e)}\n次回アプリ起動時に自動回収します。`,
          tone: 'fail',
        });
      } finally {
        nativeEndImportLease();
      }
    } finally {
      setImportPhase('idle');
    }
  };
```

- [ ] **Step 3: runStopImport（fire-and-forget）を新設し stop 分岐を非同期化**

handleToggleRecording（現行 L150-192）を置換:

```typescript
  /** 停止後の取り込みを裏で走らせる（設計書 §4・fire-and-forget・UI は即復帰する） */
  const runStopImport = async (sid: string) => {
    setImportPhase('stopping');
    try {
      const ok = await waitForServiceStop(sid, () => nativeGetStatus());
      if (!ok) {
        // MLR GLM#5 対応を維持: タイムアウト時は recording 中系列の誤取り込みを避ける
        setDialog({
          title: '計測の停止を確認できませんでした',
          message: '少し待ってから画面を開き直してください。取り込みは自動で行われます。',
          tone: 'warn',
        });
        return;
      }
      nativeStartImportLease();
      try {
        const res = await importSensorSession(createNativeSensorSource());
        await refreshSessions();
        lastImportedRef.current = sid;
        if (res.verdict === 'fail') {
          setDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
        } else if (res.verdict === 'degraded_pass') {
          setDialog({ title: '計測を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
        } else {
          setDialog({ title: '計測を取り込みました', message: '一覧に表示されています', tone: 'ok' });
        }
      } catch (e) {
        // 設計書 §4: 失敗ダイアログは fail と区別して「次回起動時に自動回収」を案内する
        setDialog({
          title: '取り込みに失敗しました',
          message: `${e instanceof Error ? e.message : String(e)}\n次回アプリ起動時に自動回収します。`,
          tone: 'fail',
        });
      } finally {
        nativeEndImportLease();
      }
    } finally {
      setImportPhase('idle');
    }
  };

  const handleToggleRecording = async () => {
    if (recording) {
      // 設計書 §4: stopRecording は importing 中でも許可（start のみ拒否）
      const sid = parseNativeStatus(nativeGetStatus()).replace('recording:', '') || nativeGetLastSessionId();
      nativeStopRecording();
      setRecording(false);
      void runStopImport(sid);
      return;
    }
    if (busy || nativeIsImporting()) return;
    setBusy(true);
    try {
      const result = nativeStartRecording();
      if (result === 'error:importing') {
        setDialog({
          title: '取り込み中です',
          message: '前回の計測を取り込み中のため開始できません。終わるまでお待ちください。',
          tone: 'warn',
        });
        return;
      }
      if (result.startsWith('error:')) {
        setDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
        return;
      }
      setRecording(true);
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 4: handleShortcutStart に importing ダイアログを追加**

現行 L139-148 を置換:

```typescript
  /** ショートカット開始（minutes指定=タイマー自動停止・省略=夜寝） */
  const handleShortcutStart = (minutes?: number) => {
    if (busy || recording) return;
    // MLR r2 GLM#3: ネイティブ起動失敗（error:no_context 等）時にUIだけ計測中表示になるのを防ぐ
    const result = nativeStartRecording(minutes);
    if (result === 'error:importing') {
      setDialog({
        title: '取り込み中です',
        message: '前回の計測を取り込み中のため開始できません。終わるまでお待ちください。',
        tone: 'warn',
      });
      return;
    }
    if (result.startsWith('error:')) {
      setDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
      return;
    }
    setRecording(true);
  };
```

- [ ] **Step 5: UI に「取り込み中」行を追加**

一覧上部（`{loaded && sessions.length === 0 && ...}` の直前・現行 L199 付近）に挿入:

```tsx
        {importPhase !== 'idle' && (
          <View style={styles.importingRow} testID="importing-row">
            <Text style={styles.importingText}>
              {importPhase === 'stopping' ? '取り込み中…' : '前回の計測を取り込み中'}
            </Text>
          </View>
        )}
```

styles（ファイル末尾 StyleSheet.create 内）に追加:

```typescript
  importingRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  importingText: {
    ...theme.typography.sub,
    color: theme.colors.accent,
    textAlign: 'center',
  },
```

また recordButton / shortcut chips の disabled 条件は現行 `disabled={busy}` のまま（importing 中は native ガード+ダイアログで案内する・設計書 §4 の「ガードは startRecording のみ拒否」に一致）。

- [ ] **Step 6: typecheck+lint**

```bash
cd ~/projects/nemly-app && bunx tsc --noEmit; echo "TSC_EXIT=$?"
bunx expo lint; echo "LINT_EXIT=$?"
```

Expected: 両方 exit 0

- [ ] **Step 7: Commit**

```bash
cd ~/projects/nemly-app && git commit-scoped -m "feat(ui): §4 stop後importをfire-and-forget化（UI即復帰）+importingガード2層+取り込み中表示+回収10秒タイムアウト（設計書§4）" -- src/app/index.tsx
```

---

### Task 6: 回帰確認（分割テスト+typecheck+lint）

- [ ] **Step 1: 分割テスト実行（一括 bun test 禁止）**

```bash
cd ~/projects/nemly-app && bun test src/lib/__tests__/sqliteRepository.test.ts src/lib/migration/__tests__/migrationRunner.test.ts; echo "EXIT1=$?"
bun test src/constants src/lib/__tests__/repository.test.ts src/lib/sensor; echo "EXIT2=$?"
bun test src/lib/__tests__/csvImport.test.ts src/lib/__tests__/sleepScore.test.ts; echo "EXIT3=$?"
```

Expected: 3回とも exit 0・既存37+43+26件 GREEN+waitForStop 5件

- [ ] **Step 2: typecheck+lint 再確認**

```bash
cd ~/projects/nemly-app && bunx tsc --noEmit; echo "TSC_EXIT=$?"
bunx expo lint; echo "LINT_EXIT=$?"
```

Expected: exit 0

- [ ] **Step 3: 問題なければ修正コミット（ある場合のみ）**

---

### Task 7: Kotlin ビルド+実機配布準備

- [ ] **Step 1: release APK ビルド（debuggable true 同梱・2026-11-03 訂正・assembleDebug は JS バンドル未同梱で実機単体起動不可の実測あり）**

```bash
cd ~/projects/nemly-app/android && ./gradlew assembleRelease; echo "EXIT=$?"
```

Expected: `BUILD SUCCESSFUL`・exit 0・`assets/index.android.bundle` 同梱（unzip -l で確認）

- [ ] **Step 2: Pixel 9a に配布**

```bash
adb -s $(adb devices | grep -E "^.\w+\s+device$" | head -1 | cut -f1) install -r ~/projects/nemly-app/android/app/build/outputs/apk/release/app-release.apk; echo "EXIT=$?"
```

- [ ] **Step 2-b: 起動確認（install Success だけでは不十分・2026-11-03 実測教訓）**

```bash
adb -s <serial> shell "monkey -p com.anonymous.nemlyapp -c android.intent.category.LAUNCHER 1" > /dev/null
sleep 8 && adb -s <serial> exec-out screencap -p > /tmp/nemly_check.png
```

Expected: スクショに「Nemly」タイトル+計測ボタンが描画される（全面単色=バンドル未同梱のサイン）

Expected: `Success`・exit 0

- [ ] **Step 3: §7 定量検証の実施（続行タスク・本計画のスコープ外）**

設計書 §7/§8 の定量検証（3回反実≤5秒・SQLite ロック0件・busy_timeout 発火0件・欠損0件・kill 4境界・8時間計測+WAL 10MB 未満）は Pixel 9a 実機で実施する。完了後、バックログ L193（停止処理インクリメンタル化タスク）の実装完了部分を進捗追記し、ふくけい承認後に `[x]` 化する。

---

## Self-Review 結果

1. **Spec coverage**: §1→Task 1 / §3→Task 2 / §4（native lease→Task 3・JS 非同期化+UI→Task 5・poll 200ms→Task 4） / §5→Task 4。§7 ユニットテストのうち「waitForServiceStop sessionId 照合」は Task 4 で完遂・「importing ガード両層」「kill 4境界」「fail ダイアログ区別」は framework 依存のため実機 §7 に委譲（設計書も実機検証を指定）。§2 の status 拡張と expo-sqlite migration はスコープ外（既存簡易実装 getPendingSessionId+lastImportedRef で同根解消済み・handoff 方針）。
2. **Placeholder scan**: 全ステップに実コード記載済み。
3. **Type consistency**: lease API の関数名は Kotlin（startImportLease/endImportLease/isImporting）=bridge interface=nativeSource ラッパー（nativeStartImportLease/nativeEndImportLease/nativeIsImporting）で一貫。waitForServiceStop のシグネチャ（sessionId・readStatus・sleep）は Task 5 の呼び出しと一致。
