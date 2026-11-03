/**
 * 表示用フォーマット純関数（Sleep as Android 機能パリティ 第一群 機能A）
 * spec: docs/superpowers/specs/2026-11-03-nemly-parity1-design.md
 */

/** 分 → `h:mm` 表記（219分 → "3:39"） */
export function formatSleepDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** 比率（0-1）→ `%` 表記（0.29 → "29%"）・欠損は "--"（0は実測0として表示） */
export function formatRatioPercent(ratio: number | undefined): string {
  if (ratio === undefined) return "--";
  // 極短セッションで validRatio が 1 超（105% 等）になる実測があるため表示は 0-100% にクリップ
  //（データ側の値は変更しない・failCheck/sensorImport の計算は既存のまま）
  const clipped = Math.min(1, Math.max(0, ratio));
  return `${Math.round(clipped * 100)}%`;
}
