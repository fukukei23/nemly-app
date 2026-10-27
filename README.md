# Nemly（ネムリー）

睡眠記録アプリの Phase 1 土台。Sleep as Android をクリーンルーム解析して作った [sleep-algorithm](https://github.com/fukukei23/sleep-algorithm)（pure-logic ライブラリ）を Expo/React Native アプリに組み込み、アクティグラフ CSV から睡眠スコアと3値ヒプノグラムを生成・保存する。

## 現在のスコープ（Phase 1）

- **CSV インポート**: Sleep as Android のアクティグラフ（Activity_*.txt・5列形式・10秒粒度・epoch ms）を読み込み
- **睡眠スコア**: DURATION / DEEP_SLEEP / EFFICIENCY の3測定合否比率（§4 仕様準拠・欠損測定は分母から除外）
- **3値ヒプノグラム**: DEEP / LIGHT / REM / AWAKE / BROKEN の統合ラベル時系列表示
- **ローカル SQLite**: 検証済み migration framework（checksum + fail-closed + 1 migration = 1 transaction）

センサーでの直接計測は Phase 2（未実装）。

## 使い方

```bash
npm install
npm test            # 58 tests
npm run typecheck
npm run lint
npm start           # expo start
```

アプリ内: 「インポート」→ Activity_*.txt を選択 → スコア/ヒプノグラム生成 → 一覧に保存。

## アーキテクチャ

```
Activity_*.txt (5列・10秒粒度)
  → src/lib/csvImport.ts        パース + 判定パイプライン（sleepAlgorithm）
      ActivityClassifier → SleepPhaseDetector → detectAwakeIntervals → detectREM → SleepScoreCalculator
      → 統合ラベル時系列 (AWAKE > REM > DEEP > LIGHT > BROKEN)
  → src/lib/repository.ts       Interface + InMemory（テスト）
  → src/lib/sqliteRepository.ts SQLite 実装（単一 tx 契約・並行実行防御）
      → src/lib/migration/      検証済み framework（MicroWin から複製・checksum + fail-closed）
  → src/app/                    Expo Router（一覧 / 詳細 / インポート）
```

sleep-algorithm は別リポジトリ（実機比較検証で列粒度一致率 93.6% 実測）の pure TS コードを複製して使用。

## 検証

- テスト 58（migration 24 + repository 11 + csvImport 14 + sqliteRepository 9）・tsc 0 エラー・eslint 0 errors
- 決定論プレフィルタ: gitleaks no leaks
- MLR（4機複数LLMレビュー）r1/r2 計49指摘を消化（r2 は blind 再レビュー）

## ライセンス

MIT
