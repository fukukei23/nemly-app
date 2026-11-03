# nemly-app 停止処理の高速化 設計書（DB接続singleton化+import非同期化+孤立セッション回収）

- 作成: 2026-11-03
- 起点タスク: バックログ L186（P2・0be2起票）
- レビュー: multi-llm-review 4ラウンド（5機・181指摘・統合正典 `obsidian-ssot/60_MLR_LOGS/2026-11-03_nemly停止処理高速化設計レビュー/`）
- MLR参与機: MiniMax-M3 / gemini-2.5-flash（r1のみ・r2以降 quota 欠員）/ GLM-5.3 / dots-3-note-preview:free / north-mini-code:free（r1のみ・r2以降 length 欠員）

## 1. 当初目的と fail条件

- **目的**: nemly-app（睡眠計測Androidアプリ）の停止処理の高速化
- **fail条件（事前固定・バックログL186より）**: インクリメンタル化後も停止→UI 復帰が 5秒超の実測が残る時、または記録中の統計計算がセンサー記録に落ち込み（サンプル欠損増加）を生んだ時
- **実測根拠（2026-11-03 Pixel 9a・3分34秒計測→停止・logcat+DB照合）**:
  - 停止tap → FGS finished = 3.1秒
  - FGS finished → UI DB created_at = 15.5秒（`database is locked; [PRAGMA journal_mode=TRUNCATE]` ログが finished から約15秒後に発行）
  - 2,027サンプル（5.6h）=17秒・605サンプル（1.7h）=16秒・18サンプル（3.5分）=18.6秒 = サンプル数非依存の固定時間。**ボトルネックは計算でなく新規DB接続のロック競合**
- **設計判断の転換点**: ふくけい提案「処理しながら記録していく」（振幅の段階計算）は **native FGS で既に実装済み**（10秒窓ごとに逐次計算・DB書込）であり、新規のインクリメンタル集計実装は不要と判明（r1 実測確認）。本設計は「停止後の処理」の高速化に焦点を当てる

## 2. 変更対象アーキテクチャ（現状）

- `NemlySensorService`（FGS）: 記録中に10秒窓の振幅を amplitude.db（WAL・`SensorDbHelper`）へ逐次書込
- 停止フロー（JS `index.tsx`）: `nativeStopRecording()` → `waitForServiceStop()`（500ms poll×最大30回）→ `importSensorSession()`（pullSeries → summarizeQuality → validateAndJudge → analyzeSleep → insertSession → confirmImported/purge）を await し UI が busy ブロック
- `NemlySensorModule`: pullSeries/confirmImported が呼び出しごとに `SensorDbHelper(...)` 新規生成（**15秒ロック競合の根因**）

## 3. 設計（8セクション）

### §1 native: SensorDbHelper の singleton 化

- companion object に Kotlin `by lazy` で applicationContext を保持する singleton（コンストラクタ private 化・新規生成をコンパイル時に禁止）
- FGS・Module の全経路で `get(context)` 経由に統一し、`pullSeries`/`confirmImported` の呼び出しごとの新規生成を廃止
- dbHelper フィールドは singleton 参照のみ（null 再代入経路を排除）
- FGS は finishSession 後も close しない（同一プロセス・WAL 保持コストは軽微）
- singleton は「通常経路での毎回 open の廃止」でありプロセス再起動後の初回 open は残る（設計書のこの行が警告・実装者が「完全解決」と過信しないこと）
- **`PRAGMA busy_timeout` を初期実装に含める（1000ms）**: timeout 時は明示エラー+リトライ1回（fail-fast）
- journal mode 要求は singleton 化により初回 open のみに限定される

### §2 native: native_sessions の status 遷移+ UI DB 冪等キー

status 定義表:

| status | 意味 | 遷移 |
|---|---|---|
| recording | 計測中 | startSession で設定 |
| finished | 計測終了・未import | finishSession で設定 |
| importing | import処理中 | markImporting（JSから） |
| imported | import完了・purge済み | purgeSession（CAS） |
| import_failed | 判定fail・回収対象外 | markImportFailed |
| failed | センサー失敗 | markFailed（既存） |

- `purgeSession` 実装拡張: 現行は samples の delete のみ・transaction 未使用。新設は **transaction 内で delete+status='imported' UPDATE+WHERE status IN ('finished','importing') の CAS**（UPDATE 成功時のみ delete する順序）
- markImporting / markImported / markImportFailed 新設。markImportFailed は verdict=fail のみでなく **import処理の catch 全体**で呼ぶ。kill で catch も通らず死んだ場合は importing 残留→回収対象
- **孤立 recording の ended 補正**: status='recording' で ended_at_ms=null の場合、回収時に「最終 sample ts + STEP_MS」を ended として扱う（expectedWindows の NaN 防止）
- expo-sqlite 側 migration（MLR r2 で方向転換・r1 の見送りを撤回）: `sleep_sessions.native_session_id TEXT` カラム+UNIQUE index。**native 側 amplitude.db の schema 変更はなし**
- fail 判定セッションの samples 残留（DB 肥大化→checkpoint 伸長→停止処理の再劣化という本目的への自己矛盾リスク）は既存仕様（L175 保持ポリシー）のスコープ外——**L175 に「fail セッション purge ポリシー」論点を連携起票する**

### §3 native: finishSession の堅牢化

- try/finally 構造化: unregister/release/status 更新/stopForeground/stopSelf を finally で必ず実行（現行の `dbHelper ?: return` は JS を15秒待たせる）
- dbHelper null 時の lastStatus は `finished:<sessionId>` で継続（DB への status 更新は走らない→孤立 recording として回収される）
- finishSession 複数回実行のガード（AtomicBoolean finishing・入口で CAS）
- `appContext.reactContext` の null 安全化（pullSeries/confirmImported の `!!` 解消）

### §4 JS: import処理の非同期化+importing ガード（UI即復帰）

- stop 分岐を fire-and-forget 化: busy 解除で UI 即復帰・waitForServiceStop+import は非同期継続
- importing ガード2層: ①JS state（表示制御）②native Module isImporting flag（**排他判定の正**）
- **ガードは startRecording のみ拒否（stopRecording は許可）**
- **isImporting は lease 形式**（timestamp 付き・30秒で自動解放・fire-and-forget 死亡時も flag が永久に残らない）
- UI 表示: 一覧上部「取り込み中…」行+回収中「前回の計測を取り込み中」+回収1件10秒タイムアウト
- try/catch/finally: 例外時は importing 解除+「取り込みに失敗しました・次回アプリ起動時に自動回収します」ダイアログ
- waitForServiceStop false（タイムアウト）は明示エラー表示
- **waitForServiceStop の poll 間隔 500ms→200ms**（tap→finished 3.1秒の予算計算に対応）
- トレードオフ明記: fire-and-forget 化で import 中の kill 露出が現行より増える→§6 回収で救済

### §5 JS: waitForServiceStop の sessionId 照合（必須修正）

- **現行実装の実バグ対応**: lastStatus は前回セッションの `finished:<oldId>` が残留し、次の停止時の初回 poll で `startsWith('finished:')` が即 true になり、停止完了を待たずに import が開始する
- 対象 sessionId を渡し、`getStatus()` の lastSessionId と一致することを条件に追加（**二重防御でなく一次修正・必須**）

### §6 JS: 起動時回収処理

- index mount 時に listFinishedPending()（finished / importing / 孤立recording）を順次 import（1件10秒タイムアウト）
- **回収は claim transaction で排他**: 各セッションの status='importing' への UPDATE（WHERE status='finished'）の結果1件で claim 成功・失敗なら他が担当とみなして skip
- 重複防止3層: ①事前に native_session_id で既存照合（あれば skip+native purge へ）②通常 INSERT（**INSERT OR IGNORE は不使用**——conflict が成功として返り already-imported 判定ができないため）③UNIQUE index は防御層（race 時は例外 catch で already-imported 判定）
- 回収失敗時は status 据え置き+エラー可視化
- AppState（フォアグラウンド復帰）での回収は見送り（起動時のみ・YAGNI）

### §7 検証

**ユニットテスト**（分割実行・一括 `bun test` 禁止）:
- status 遷移表の主要遷移（finished→importing→imported/import_failed・孤立recording→回収）
- UNIQUE冪等 import（同一 native_session_id 2回で1行・事前照合版）
- importing ガード両層（JS state+native flag・lease 解放）
- waitForServiceStop sessionId 照合（残留 finished で即 true にならない）
- kill シミュレーション4境界（import前/pull後/insert後/confirm後）+タスクkill
- fail ダイアログ区別

**実機再実測**（修正ビルドを Pixel 9a 配布）:
1. 同一手順（開始→数分→停止）3回反復・「停止tap→確定的な完了表示」を各回計測
2. ロック検証は logcat **SQLite 全般フィルタ**（`grep -E "SQLite|database is locked"`）でエラー0件
3. finished→pullSeries 応答 <1秒 + **pullSeries の native 入口/出口に Log.d を追加して直接計測**
4. expectedWindows と samples の ts集合一致+event_count 合計一致+sensor 側窓数との突合
5. 停止→即再開始5回連続で lock・欠損0件
6. Flip7 でも1回実測
7. 本番相当の8時間計測を最低1回（今夜のふくけい実計測がこれに相当）+WAL サイズ確認（**閾値: amplitude.db-wal が本計測終了時に 10MB 未満**）
8. kill シミュレーション4境界+タスクkill で resume 検証
9. busy_timeout 該当時は **リトライ成功した場合も発火としてカウント**し fail 扱い
10. pullSeries がプロセス起動後初回 open になる場合の WAL recovery checkpoint 遅延を観測

### §8 fail条件の定量定義

- 性能: 3回反復全てで「停止tap→**確定的な完了表示**（成功/失敗ダイアログまたは一覧反映）」≤5秒
- ロック: SQLite 全般フィルタのロック/timeout エラー0件・**busy_timeout 発火回数0件**（リトライ成功もカウント）
- センサー記録: ts集合・event_count 一致率100%（欠損窓0件）
- 整合: 停止→即再開始5回連続で欠損0件・二重登録0件
- kill 復旧: 4境界+タスクkill すべてで次回起動の回収完了≤10秒・二重登録0件
- 8時間計測: 欠損0件+WAL サイズ 10MB 未満
- **fail時の第二手**: busy_timeout 設定の見直し（短縮/延長）→ journal mode 要求元の特定（Log.d で open 時 PRAGMA の発行者を確認）→ FGS close+lazy reopen 設計への転換を再検討

## 4. スコープ外

- L175 保持ポリシー（fail セッションの samples 残留ポリシー・recording 残存の全解消）— 連携起票のみ
- 3夜分布（L172・恒久閾値確定）— 今夜の計測待ち
- 記録中のセンサー処理（computeWindows のスレッド化等）— 欠損増加の実測なし
- WorkManager 委譲（kill 後の import 継続）— 起動時回収で緩和

## 5. 代替案の検討履歴（却下・MLR 4ラウンド経過）

| 代替案 | 却下理由 |
|---|---|
| FGS close を onDestroy で | process kill 前に呼ばれない・close 後の再 open が新競合源 |
| WorkManager 委譲 | expo で大工程・起動時回収で緩和済み |
| computeWindows 別スレッド化・バッファリング | 記録中はスコープ外・欠損増加の実測なし |
| FGS が pullSeries を native 実行 | 既に native で pullSeries（前提不一致） |
| INSERT OR IGNORE | conflict が成功として返り already-imported 判定不能（r3 で撤回） |
| インクリメンタル集計の新規実装（元タスク方針） | native で既に実装済み・停止後の計算は<1秒（r1 実測） |

## 6. 成功判定

§8 の定量 fail条件をすべて満たし、Pixel 9a 実測 3回反復で「停止tap→確定的な完了表示」≤5秒を達成すること。達成後、バックログ L186 を [x] 化し、ふくけいの実機視認を経て Pixel 9a+Flip7 へ配布する。
