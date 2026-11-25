# nemly-app 統計永続化 設計書（pass→purge で校正データが消える構造問題の解消）

- 作成: 2026-11-25
- 起点タスク: obsidian-ssot バックログ L247（P2・0be2起票・type:verification）
- 関連正典: `01_DECISIONS/nemly-app/2026-10-29_Phase2実機検証とfailCheck校正.md`（進捗追記6/11/12）
- 関連タスク: バックログ L175（fail セッション保持ポリシー・本設計は統計層のみで purge ポリシーは変更しない）/ L226（恒久閾値確定・本設計完了後の後続）
- レビュー: 設計はふくけい承認済み（2026-11-25 brainstorming・生値保存+全判定書込の2点を承認）。実装後に MLR-lite 推奨・恒久閾値更新（L226）時に本 MLR

## 1. 当初目的と fail条件

- **目的**: stop時の failCheck 判定統計（stationaryRate・validRatio・expectedWindows 等）と 10秒窓の生 amplitude を UI DB に永続化し、pass→purge しても校正データ（恒久閾値 0.90 の校正に必要な夜別 stationary 分布・STATIONARY_THRESHOLD 0.01 の再校正に必要な振幅分布）が失われないようにする
- **fail条件（事前固定・L247より）**: 統計永続化後も 3 有効夜の stationary 分布が取れなかった時
- **実測根拠（問題の実発）**:
  - pass 夜の生 samples は `confirmImported` で native purge される（実測 2026-11-25: s-1795542057315 = pass 後 `SELECT COUNT(*)` 0 件・GROUP BY 5 セッション不在で裏取り・総数 10,472 整合）
  - `validateAndJudge` 内で計算される睡眠帯限定 stationaryRate（ゲート値）はローカル変数で捨てられている（failCheck.ts:59-69）
  - 3有効夜のうち精密 stationary 率は 74.1%（10-31・9a 1夜目実パイプライン）と 73.8%（11-22 区間・簡易計算）の 2 点のみ・3夜目（11-25 pass）は判定値ごと消滅
  - **既存資産の発見**: UI DB の `amplitude_samples` テーブルは v2 マイグレーションで「再取り込みは INSERT OR IGNORE 正常系」の設計意図付きで既に作成済み（migrations.ts:74-84）が、書き込み経路が未実装で 0 行のまま

## 2. 目標・非目標

**目標**:
1. 全判定（pass/degraded_pass/fail）の判定統計スナップショットを UI DB に 1 行ずつ記録する
2. 全判定の 10秒窓生 amplitude を UI DB（`amplitude_samples`）に記録する
3. kill がどの地点で発生しても、次回回収の冪等復旧で生値と統計が失われないこと（既存 §6 重複防止3層と整合）

**非目標（スコープ外）**:
- fail 判定ロジック・閾値の変更（恒久閾値更新は L226 の後続タスク）
- native 側の purge ポリシー変更（L175 の管轄・fail samples の native 残存は現状維持）
- UI 表示の追加（蓄積のみ・統計画面への表示は将来課題）
- fail セッションの再 import / 再判定機能の実装（本設計はその土台＝生値保存まで）

## 3. 現状構造（変更対象）

- **import 経路**（`src/lib/sensor/sensorImport.ts`）: `pullSeries` → claim（`markImporting` CAS）→ 空系列チェック → 事前照合（`getSessionByNativeId`・already-imported 判定）→ `summarizeQuality` → `validateAndJudge` → fail は `markImportFailed`・pass/degraded は `analyzeSleep` + `insertSession` → `confirmImported`（native purge）
- **判定**（`src/lib/sensor/failCheck.ts`）: `validateAndJudge` が verdict（pass/degraded_pass/fail）と reasons を返す。睡眠帯限定 stationaryRate は `quality.windows` 提供時に再計算されるがローカル変数止まり
- **UI DB スキーマ**（`src/lib/migration/migrations.ts`）: v1（sleep_sessions + sleep_stages）・v2（amplitude_samples + sleep_sessions メタ列 valid_ratio/gap_count/end_reason）・v3（native_session_id + UNIQUE index）。**書き込み未実装の amplitude_samples は 0 行**
- **repository**: `repository.ts`（interface + InMemory テスト実装）+ `sqliteRepository.ts`（実機 SQLite 実装）
- **kill 復旧**（既存 spec §6 3層）: claim CAS → 事前照合（insert 後 kill の already-imported 判定）→ UNIQUE index 防御層

## 4. 設計 §1: v4 マイグレーション（sensor_verdicts 新設）

```sql
CREATE TABLE IF NOT EXISTS sensor_verdicts (
  native_session_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  end_reason TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','degraded_pass','fail')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  stationary_rate REAL NOT NULL,
  sleep_window_stationary_rate REAL,
  stationary_gate_active INTEGER NOT NULL,
  nan_rate REAL NOT NULL,
  valid_ratio REAL NOT NULL,
  expected_windows INTEGER NOT NULL,
  actual_windows INTEGER NOT NULL,
  judged_at TEXT NOT NULL
);
```

- **PRIMARY KEY = native_session_id**: 1 セッション 1 行・再判定時は INSERT OR REPLACE で冪等 upsert
- **sleep_window_stationary_rate は nullable**: 時間帯制限（`18b9270`）でゲート未実施（睡眠帯窓ゼロ=昼だけセッション）の場合は NULL を許し、`stationary_gate_active=0` と組み合わせて「ゲートスキップ」と「0%」を区別する
- sleep_sessions へのカラム追加は**しない**（fail は sleep_sessions に行が生まれないため全判定記録の要件②を満たせない・verdicts テーブルに集約）
- reasons は JSON 配列文字列（`reasons_json`）・pass/degraded_pass は空配列 `[]`

## 5. 設計 §2: validateAndJudge の API 拡張

`FailVerdict` 型に 2 フィールドを追加する（**判定ロジック・reasons・verdict 規則は一切変更しない**）:

```ts
export interface FailVerdict {
  verdict: "pass" | "degraded_pass" | "fail";
  reasons: string[];
  // 統計永続化（v4）用に露出するゲート計算値
  sleepWindowStationaryRate: number | null; // 睡眠帯窓限定の再計算値・gate 未実施時 null
  stationaryGateActive: boolean;            // 睡眠帯窓が存在したか（windows 未指定時 false）
}
```

- `quality.windows` が指定され睡眠帯窓が 1 件以上 → `stationaryGateActive=true`・`sleepWindowStationaryRate` に睡眠帯窓限定の stationaryRate
- `quality.windows` が指定され睡眠帯窓が 0 件（昼だけセッション）→ `stationaryGateActive=false`・`sleepWindowStationaryRate=null`（ゲートスキップ・既存挙動どおり fail しない）
- `quality.windows` が未指定（CSV 等の既存経路）→ `stationaryGateActive=false`・`sleepWindowStationaryRate=null`（従来動作: quality.stationaryRate を全窓で判定）
- 全窓の `stationaryRate`（`summarizeQuality` 返却値）は呼び出し側で既に保持されているため、FailVerdict には含めない
- 既存テストの期待値比較（toEqual 完全一致）がある場合は拡張フィールド分を更新する（判定結果自体の期待値は不変）

## 6. 設計 §3: sensorImport の書き込み順序契約（kill 耐性）

判定完了後、次の順で書き込む:

```
5. summarizeQuality + validateAndJudge          （既存）
5a. saveAmplitudeSamples(nativeSessionId, samples)   → INSERT OR IGNORE（全判定）
5b. saveVerdict({...統計スナップショット...})            → INSERT OR REPLACE（全判定）
6.  fail  → markImportFailed → return            （既存・位置不変）
7.  analyzeSleep + insertSession                 （既存）
8.  confirmImported                              （既存）
```

**順序の根拠（kill 耐性分析）** — 生値を**最初に**書くのが核心:

| kill 地点 | 次回回収の挙動 | 生値・統計 |
|---|---|---|
| amplitudes 書込後・verdicts 前 | claim 成功 → 再判定 → verdicts upsert（同値上書き）→ 通常継続 | 保たれる |
| verdicts 後・fail 経路の markImportFailed 前 | claim 成功 → 再判定 → verdicts upsert → markImportFailed | 保たれる |
| insertSession 後・confirmImported 前 | claim 成功 → 事前照合 already-imported → confirmImported（native purge） | **UI DB に既に保存済み=保たれる（本設計の主効果）** |
| confirmImported 後 | 冪等完了 | 保たれる |

- 逆順（insertSession 後に amplitudes 書込）だと「insertSession 後 kill」で already-imported ショートカットが走り、native が purge された後に生値を永久に書く機会が消える。これが既存 §6① 経路と本設計の干渉点であり、順序契約で回避する
- **already-imported / empty ショートカット経路では書き込まない**（書くべきデータは初回 import で書かれている・生値が既に UI DB にあるため purge されても失われない）
- **catch 経路（処理エラー→markImportFailed）では verdicts を書かない**: catch は「判定」でなく「処理エラー」であり、verdicts テーブルは判定統計の記録に限定する（処理エラーは native status=import_failed とログで区別・reasons_json に偽の判定理由を入れない）。5a まで書けた後に catch に落ちた場合は amplitudes のみ残存するが、これは fail 生値保存ポリシーと整合する

## 7. 設計 §4: repository API 拡張

```ts
export interface VerdictRecord {
  nativeSessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  endReason: string | null;
  verdict: "pass" | "degraded_pass" | "fail";
  reasons: string[];
  stationaryRate: number;
  sleepWindowStationaryRate: number | null;
  stationaryGateActive: boolean;
  nanRate: number;
  validRatio: number;
  expectedWindows: number;
  actualWindows: number;
  judgedAt: string; // ISO
}

interface Repository {
  // ...既存メソッド...
  /** 判定統計スナップショットの upsert（INSERT OR REPLACE・native_session_id 冪等キー） */
  saveVerdict(record: VerdictRecord): Promise<void>;
  /** 10秒窓生値の保存（INSERT OR IGNORE・(session_id, ts_ms) UNIQUE で再実行冪等） */
  saveAmplitudeSamples(
    nativeSessionId: string,
    samples: { tsMs: number; amplitude: number; quality: number }[]
  ): Promise<void>;
}
```

- `repository.ts`: interface + InMemory 実装（テスト用）を追加
- `sqliteRepository.ts`: SQLite 実装を追加（既存の実装パターンに従う）
- 実装計画で既存 sqliteRepository のトランザクション/エラー扱いパターンを踏襲する

## 8. テスト計画

- **failCheck.test.ts**: ①`quality.windows` 提供時・睡眠帯窓限定値が `sleepWindowStationaryRate` に入る ②昼だけセッション（窓全部が睡眠帯外）で `stationaryGateActive=false`・`sleepWindowStationaryRate=null`・verdict は従来どおり fail しない ③windows 未指定で従来動作不変 ④拡張フィールド追加で既存期待値比較が壊れる場合は更新（判定結果自体の期待値は不変）
- **sensorImport.test.ts**: ①pass/degraded/fail 各経路で amplitudes+verdicts が書かれる ②already-imported・empty ショートカットでは書かれない ③catch 経路では verdicts が書かれない ④kill 地点シミュレーション 3 種（amplitudes 後 kill・verdicts 後 kill・insertSession 後 kill）で生値が UI DB に残る ⑤ INSERT OR IGNORE/REPLACE の冪等性（同一セッション再 import で行数不変）
- **migrationRunner.test.ts**: v4 DDL 適用の検証（既存 v2/v3 テストのパターン踏襲）
- **fixture 回帰**: `calibration20261028.json` は不変（判定ロジックを変更しないため）
- **品質ゲート**: jest 全緑 + `tsc --noEmit` 0 + `expo lint` 0 errors（既存基準維持）

## 9. 配布と実機検証（完了条件）

1. `assembleRelease` でビルド（assembleDebug は禁止・既存規律）
2. Pixel 9a に `install -r` 配布（Success・EXIT=0 実測）+ 配布後スクショで UI 描画確認
3. **完了条件**: 次の計測セッション（昼寝 or 夜寝の開始→停止）で、① `sensor_verdicts` に 1 行追加 ② `amplitude_samples` に該当セッションの窓数行追加 ③ `sleep_window_stationary_rate` に睡眠帯限定値が入っていることを adb 経由 DB 照合で実測する
4. fail条件（L247 事前固定）: 統計永続化後も 3 有効夜の stationary 分布が取れなかった時（= 9 の照合で値が取れない時）

## 10. 影響しないもの

- fail 判定ロジック・閾値（`MIN_VALID_RATIO 0.9` / `MAX_STATIONARY_RATE 0.90` / `STATIONARY_THRESHOLD 0.01` / 時間帯制限）は 1 行も変更しない
- native 側（Kotlin）は変更しない（v4 は UI DB 側のみ・purge ポリシーは L175 の管轄で現状維持）
- UI 表示は変更しない
- 既存の kill 復旧 3 層（claim CAS・事前照合・UNIQUE index）は変更しない
