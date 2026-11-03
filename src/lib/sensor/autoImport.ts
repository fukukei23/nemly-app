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
  return parseNativeStatus(status).startsWith("finished:");
}

/**
 * ネイティブ getStatus() の戻りを正規化する。
 * Kotlin は `{"status":"finished:s-...","sessionId":"..."}` 形式の JSON を返すが・
 * JS 側は従来プレーン文字列（`finished:s-...`）を想定していたため
 * 2026-11-03 実機観察（タイマー自動停止後の起動時取り込みが発火しない）で判明。
 * JSON 形式なら status フィールドを抽出・プレーン形式はそのまま返す（後方互換）。
 */
export function parseNativeStatus(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { status?: string };
    if (typeof parsed?.status === "string") return parsed.status;
  } catch {
    // JSON でなければプレーン形式
  }
  return raw;
}
