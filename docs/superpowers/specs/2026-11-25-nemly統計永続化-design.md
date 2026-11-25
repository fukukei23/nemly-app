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
- **amplitude_samples 実DDL（v2 正本・migrations.ts:78-84 転記・MLR glm#1/mm#5 対応）**:
  ```sql
  CREATE TABLE IF NOT EXISTS amplitude_samples (
    session_id TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    amplitude REAL NOT NULL,
    quality INTEGER NOT NULL,
    PRIMARY KEY (session_id, ts_ms)
  );
  ```
  — **session_id は TEXT 型・FK 制約なし**（sleep_sessions.id INTEGER を参照しない）ため、**fail セッション（sleep_sessions 行なし）も native_session_id 文字列をそのまま保存できる**。v4 はこのテーブルをそのまま利用し、**DDL 変更は行わず書き込み経路のみ追加する**。**session_id に格納する値は全判定（pass/degraded/fail とも）で native_session_id 文字列に統一する**（pass セッションで sleep_sessions.id 整数を混在させない・MLR r2 glm#5 採用）
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

- **PRIMARY KEY = native_session_id**: 1 セッション 1 行・**書き込みは INSERT OR IGNORE（初回判定のみ記録・r2 採用で REPLACE から反転）**
- **INSERT OR IGNORE の根拠（MLR r2 3機一致採用・r1 の REPLACE から反転）**: ①`judged_at` は判定実行時刻で非決定的 — REPLACE で upsert すると再 import 時に必ず値が変わり、r1 冪等性主張（全カラム値不変）と自己矛盾していた（glm#1 が指摘・設計バグとして認定）②kill 復旧の再判定は同 samples→同 verdict なので既存行を保持するだけで正しい ③将来 L226 で閾値・判定ロジックが変更された後の再判定でも、旧閾値時代の初回スナップショットが破壊されない（校正履歴の保護）④再 import 時に既存 verdict と**値が不一致になった場合は INSERT せずログ警告**（RM-2・異常サインの検知=fail 条件追加 5）。schema_version / input_hash 等の世代管理列は IGNORE 化で初回判定が immutable に残るため不要（必要になった時点で L226/L175 と一体で追加）
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
5a. saveImportArtifacts(verdict, samples)       → amplitudes（INSERT OR IGNORE）+ verdicts
                                                  （INSERT OR IGNORE・初回のみ記録・既存行は上書きせず
                                                   値不一致ならログ警告=MLR r2 採用）を同一トランザクションで
                                                  一括コミット（全判定・バッチINSERT・MLR mm#2/glm#5対応）
6.  fail  → markImportFailed → return            （既存・位置不変）
7.  analyzeSleep + insertSession                 （既存）
8.  confirmImported                              （既存）
```

**トランザクション契約（MLR mm#2 + glm#5 採用）**: amplitudes と verdicts は単一 SQLite トランザクションで commit し、**両方成功か両方失敗かの2値化**とする（「生値のみ・統計なし」の部分書込状態を構造的に排除・InMemory 実装でも partial commit 不在をテストする〔§8〕）。**トランザクション内で外部 I/O（native bridge 呼出等）は行わない**。後段の markImportFailed / insertSession / confirmImported は別トランザクション（既存経路の変更なし）。

**性能契約（MLR glm#3 + gem#1/#6 採用）**: saveImportArtifacts は窓数分（実測 3,272 行/9時間晩）のバッチ INSERT を単一トランザクションで実行する。**書込時間は §9 の完了条件で実機実測する**（fail条件として書込実測 1 秒超で再設計 — **1 秒の根拠〔MLR r2 glm#6 採用〕**: 既存停止処理の UI 復帰実測 2.13〜2.82 秒〔L228 完遂時実測〕に対し、書込追加による遅延をその半分程度に抑える目安）。保持期間/purge ポリシー（DB 肥大化対策）は非目標（L175 と一体で将来判断・容量試算は約 46MB/年=3,272 行×40B 概算×365 日〔self-inspect V7 実算〕・**fail 連続シナリオ追試算〔MLR r2 glm#3/gem#1 採用〕**: 30 日連続 fail でも fail 生値分は約 4MB で問題にならない規模）。**実機 kill は意図的注入をせず、自然発生時（停止忘れ・電池切れ等）の再回収を観測する**（計測中の kill は測定データ自体を破壊するため・MLR r2 mm#6 部分採用）。

**順序の根拠（kill 耐性分析）** — 生値+統計を**最初に**書くのが核心:

| kill 地点 | 次回回収の挙動 | 生値・統計 |
|---|---|---|
| saveImportArtifacts 前（5a 未実施） | claim 成功 → 再判定 → 5a やり直し（既存行は IGNORE で保持・初回未書込なら書込）→ 通常継続 | 保たれる（まだ書いていないだけ） |
| saveImportArtifacts 後・markImportFailed 前（fail 経路） | claim 成功 → 再判定 → 5a 既存行保持（IGNORE・値不一致ならログ警告）→ markImportFailed | 保たれる |
| insertSession 後・confirmImported 前 | claim 成功 → 事前照合 already-imported → confirmImported（native purge） | **UI DB に既に保存済み=保たれる（本設計の主効果）** |
| confirmImported 後 | 冪等完了 | 保たれる |

- 逆順（insertSession 後に saveImportArtifacts 書込）だと「insertSession 後 kill」で already-imported ショートカットが走り、native が purge された後に生値を永久に書く機会が消える。これが既存 §6① 経路と本設計の干渉点であり、順序契約で回避する。**補足（MLR glm#2 経路整理）**: already-imported が走るのは「insertSession 成功済み」の場合のみであり、insertSession 前の kill は再判定経路で回復するため、上記 4 経路の表で全 kill 地点を網羅する
- **already-imported / empty ショートカット経路では書き込まない**（書くべきデータは初回 import で書かれている・生値が既に UI DB にあるため purge されても失われない）
- **catch 経路（処理エラー→markImportFailed）では verdicts を書かない**: catch は「判定」でなく「処理エラー」であり、verdicts テーブルは判定統計の記録に限定する（処理エラーは native status=import_failed とログで区別・reasons_json に偽の判定理由を入れない）。トランザクション2値化により「生値のみ・統計なし」の部分書込も発生しない（5a 前に catch に落ちた場合は UI DB 書込なし・native status=import_failed で一貫）

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
  /**
   * 判定統計スナップショット + 10秒窓生値のアトミック保存
   * （単一トランザクション・バッチINSERT・amplitudes=INSERT OR IGNORE /
   *   verdicts=INSERT OR IGNORE〔初回のみ記録・既存行は上書きしない〕・
   *   既存 verdict と値不一致時はログ警告〔上書きはしない〕・MLR mm#2/glm#5 の2値化契約+r2 採用）
   */
  saveImportArtifacts(
    verdict: VerdictRecord,
    samples: { tsMs: number; amplitude: number; quality: number }[]
  ): Promise<void>;
}
```

- `repository.ts`: interface + InMemory 実装（テスト用）を追加
- `sqliteRepository.ts`: SQLite 実装を追加（既存の実装パターンに従う）
- 実装計画で既存 sqliteRepository のトランザクション/エラー扱いパターンを踏襲する

## 8. テスト計画

- **failCheck.test.ts**: ①`quality.windows` 提供時・睡眠帯窓限定値が `sleepWindowStationaryRate` に入る ②昼だけセッション（窓全部が睡眠帯外）で `stationaryGateActive=false`・`sleepWindowStationaryRate=null`・verdict は従来どおり fail しない ③windows 未指定で従来動作不変 ④拡張フィールド追加で既存期待値比較が壊れる場合は更新（判定結果自体の期待値は不変）
- **sensorImport.test.ts**: ①pass/degraded/fail 各経路で amplitudes+verdicts が書かれる ②already-imported・empty ショートカットでは書かれない ③catch 経路では amplitudes も verdicts も書かれない（トランザクション2値化） ④kill 経路シミュレーション 4 種（§6 表の 4 地点・saveImportArtifacts 前/後・insertSession 後・confirmImported 後）で生値と統計が UI DB に残る ⑤ 冪等性（同一セッション再 import で行数不変**かつ sensor_verdicts 全カラム値が不変〔INSERT OR IGNORE 化により judged_at を含めて初回値が保持される・MLR r2 glm#1 矛盾の解消をテストで検証〕**） ⑥ **トランザクション2値化**（verdicts 書込失敗を注入した場合 amplitudes も rollback される=部分書込ゼロ・InMemory 実装で partial commit 不在を検証） ⑦ **値不一致検知**（既存 verdict 行があり・再 import の新 verdict と値が不一致な場合に上書きせずログ警告を出す〔MLR r2 採用 RM-2〕）
- **migrationRunner.test.ts**: v4 DDL 適用の検証（既存 v2/v3 テストのパターン踏襲）
- **fixture 回帰**: `calibration20261028.json` は不変（判定ロジックを変更しないため）
- **品質ゲート**: jest 全緑 + `tsc --noEmit` 0 + `expo lint` 0 errors（既存基準維持）

## 9. 配布と実機検証（完了条件・MLR mm#4 採用で 3 層に分離）

### 実装完了条件（コード品質・配布）

1. jest 全緑 + `tsc --noEmit` 0 + `expo lint` 0 errors（既存基準維持）
2. `assembleRelease` でビルド（assembleDebug は禁止・既存規律）
3. Pixel 9a に `install -r` 配布（Success・EXIT=0 実測）+ 配布後スクショで UI 描画確認

### 実機完了条件（1 セッション検証・次の計測で実測）

4. 次の計測セッション（昼寝 or 夜寝）の停止→import で、adb 経由 DB 照合により:
   - ① `sensor_verdicts` に 1 行追加（verdict・統計入り）
   - ② `amplitude_samples` に該当セッションの窓数行追加（行数 = 窓数の整合）
   - ③ `sleep_window_stationary_rate` に睡眠帯限定値が入っている（夜寝時）
   - ④ **saveImportArtifacts の書込時間実測**（logcat または import 前後タイムスタンプ・**1 秒超なら再設計=fail条件**・MLR glm#3 対応）
   - ⑤ **Kotlin 側 purgeSession 呼び出し位置の確認**（confirmImported 経由のみで purge が走ることをコード追跡で確認・pullSeries/markImporting 段階で purge しない・MLR gem#5 対応）

### L247 達成条件（3 有効夜の分布取得）

5. **有効夜の定義（MLR mm#1/#7 採用）**: `sensor_verdicts` 行のうち `stationary_gate_active=1` かつ `sleep_window_stationary_rate IS NOT NULL` かつ睡眠帯窓数 ≥ **360 窓（1 時間分・暫定値・恒久化時に再校正）** を満たすもの
6. 有効夜が **3 夜分**揃った時点で、`sleep_window_stationary_rate` の値一覧を抽出して L226（恒久閾値確定）の校正材料とする
7. **検出手段（MLR glm#4 対応・fail条件の形骸化防止）**: 計測実施日の翌朝回収時に adb 照合で上記を確認する（朝回収フローに統合・別 cron は新設しない）

### fail条件（事前固定・すべて観測可能な具体指標）

- **元（L247）**: 統計永続化後も 3 有効夜の stationary 分布が取れなかった時
- **追加 1（MLR glm#5 対応）**: amplitudes 行あり・verdicts 行なしの native_session_id が 1 件でも観測された時（部分書込の検知）
- **追加 2（MLR glm#1 対応）**: fail 判定セッションの amplitude 行数が 0 のまま次回計測を迎えた時（fail 生値保存の欠落検知）
- **追加 3（MLR glm#4 反証対応）**: 有効夜 3 行のうち `sleep_window_stationary_rate` が NULL のものが混在し分布が組めない時（昼だけ pass が続く形態の検知）
- **追加 4（MLR r2 glm#4 採用）**: 同一 native_session_id で `import_failed` が **2 回連続**発生した時（saveImportArtifacts の永続的書込失敗〔ストレージ満杯・DB 破損等〕の検知・status 遷移履歴または retry_count で観測）
- **追加 5（MLR r2 採用 RM-2）**: 再 import 時に既存 verdict 行と新判定値が不一致になった時（判定ロジック非決定性・閾値変更後の再判定混入の検知シグナル・上書きはしない・ログ警告で観測）

## 10. 影響しないもの

- fail 判定ロジック・閾値（`MIN_VALID_RATIO 0.9` / `MAX_STATIONARY_RATE 0.90` / `STATIONARY_THRESHOLD 0.01` / 時間帯制限）は 1 行も変更しない
- native 側（Kotlin）は変更しない（v4 は UI DB 側のみ・purge ポリシーは L175 の管轄で現状維持）
- UI 表示は変更しない
- 既存の kill 復旧 3 層（claim CAS・事前照合・UNIQUE index）は変更しない
