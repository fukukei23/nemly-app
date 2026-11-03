# nemly 機能パリティ 第一群 設計（Sleep as Android 対応・3機能）

- status: confirmed（ふくけい承認「これで進めて」2026-11-03・選定は第一群3機能で確定）
- 起票: バックログ「nemly-app: Sleep as Android機能パリティ」（2026-11-03・c0e8）
- 正典: `30_RESEARCH/アプリ解析/2026-10-24_Sleep-as-Android仕様メモ_睡眠スコアと起床判定.md`

## 背景

原典の未実装10項目のうち・ふくけい実運用の痛み（毎晩の手動開始・3夜目の開始忘れ実測）×実現性×工数で選んだ3機能を先に実装する。着手順序は「表示系→動作系」（ネイティブ変更は最後・リビルド/配布が1回で済む）。

## 機能A: スコア3指標円表示（セッション詳細）

- 新コンポーネント `MetricGauge`（小円輪・値+ラベル・`ScoreGauge` 同系だがサイズ差を props 化しない—別コンポーネントとする）
- 値:
  - 睡眠時間 = `(endMs - startMs) / 60000` 分 → `h:mm` 表記（例: 219分 → `3:39`）
  - 深い睡眠 = `deepRatio` → `%` 表記（例: 0.29 → `29%`）
  - 効率 = `validRatio`（sensor セッションの v2 列）→ `%` 表記。**csv セッションは undefined → `--`**（表示のみ・スコア集計には影響しない）
- 色は theme 一元（circle 輪 = `theme.colors.accent`・値 = `theme.colors.text`・ラベル = `textSub`）・深夜パレット準拠
- 配置: セッション詳細 `session/[id].tsx` の scoreRow 直下に3円を横並び
- AC: ①3指標が詳細画面に表示される ②csv セッションは効率が `--` になる ③既存スナップショット（ScoreGauge 等）が不変

## 機能B: 統計・履歴画面

- ルート `src/app/stats.tsx` 新設（Expo Router）・Home に「統計」ボタン追加
- 期間切替: 週（直近7日）/ 月（直近30日）の2択
- 集計（純関数 `src/lib/stats.ts`・TDD 対象）:
  - 対象 = `listSessions()` のうち `startMs >= 現在 - 期間`
  - 記録数 = 対象件数
  - 平均スコア = `score != null` のみの平均（四捨五入整数）・**null は除外**（csv fail 等を含まない）
  - 平均睡眠時間 = 全対象の `(endMs - startMs) / 60000` 平均 → `h:mm`
- グラフ: 日別スコアの簡易棒グラフ（View 高さ比率・ライブラリ不使用・score null の日は欠損）
- AC: ①週/月切替で集計値が変わる ②score null セッションが平均から除外される ③境界（7日前ちょうどのセッション）が週に含まれる

## 機能C: ショートカット1タップ開始 + タイマー自動停止

- ネイティブ（Kotlin）:
  - `NemlySensorModule.startRecording(durationMinutes: Double?)` — 引数追加（省略時=従来動作）
  - `NemlySensorService` に `ACTION_START_WITH_TIMER` + extra `duration_minutes` を追加・`Handler.postDelayed` で経過後 `ACTION_STOP` を自己送出（FGS 生存中のみ有効=計測中は FGS 常駐前提なので十分・AlarmManager は不使用）
- JS: `index.ts` 型 `startRecording(durationMinutes?: number)`・`nativeSource.ts` 経由で透過
- UI: Home の計測カード下に4チップ（昼寝 30分/60分/90分 = タイマー付き開始・夜寝 = タイマーなし開始）
- 自動停止後の取り込み: JS がトリガーでないため・`AppState` が active に復帰した時に `nativeGetStatus()` が `finished:` なら既存 import フロー（`waitForServiceStop` → `importSensorSession`）を実行
- AC: ①昼寝60分タップ→計測開始・60分後に自動停止で記録が取り込まれる ②夜寝タップ→従来どおり手動停止 ③既存の計測トグル動作が不変 ④jest 全数維持（106+新規）

## fail 条件（バックログから引き継ぎ）

- 実装した機能で既存計測品質（スコア・ハイポノグラム・CSVインポート・SQLite契約・failゲート）を壊した時（テスト維持前提・リバートで判定）

## 非対象（第二群以降・このspecではやらない）

アラーム+smart wake発火・手動履歴追加・いびき録音・CAPTCHA・実績バッジ・BGM・クラウドバックアップ・心拍/HRV/RDI/SpO2（ウェアラブル必須）

## テスト実行規定

一括実行禁止・分割3グループ（テスト実行ガイド §nemly-app 準拠）+ 新規テストは属するグループに追加。
