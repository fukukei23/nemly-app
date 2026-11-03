/**
 * タイマー自動停止後の自動取り込み判定（機能パリティ 第一群 機能C）
 * spec: docs/superpowers/specs/2026-11-03-nemly-parity1-design.md
 *
 * ショートカット（昼寝N分）で開始した計測はネイティブ側で自動停止するため・
 * JS が停止をトリガーしない。AppState が active に復帰した時に
 * ネイティブのステータスが finished: なら取り込みフローを起こす。
 */

/** ネイティブのステータスが「完了済み（取り込み待ち/取り込み済み）」か */
export function isFinishedStatus(status: string): boolean {
  return status.startsWith("finished:");
}
