/**
 * import ガードの純関数層（設計書 §4・MLR実装レビューで「未テスト領域」とされた
 * 判断ロジックをネイティブ非依存で検証可能にする）
 *
 * ネイティブ lease・React state に依存せず「与えられた状態から次にどうするべきか」を
 * 純粋関数として返す。UI 層の index.tsx はこの結果に従う。
 */

/** 取り込みの状態（UI state と ref の両方で使う） */
export type ImportPhase = 'idle' | 'stopping' | 'recovering';

/** 停止対象のセッションID */
export type StopDecision =
  | { kind: 'stop'; sessionId: string }
  | { kind: 'stop-unknown-session' }
  | { kind: 'ignore' };

/**
 * 停止ボタン押下時の分岐決定（設計書 §4 + MLR指摘 MiniMax#5/OR1#5）。
 * recording が false なら何もしない。
 * recording が true なのに対象セッションIDが特定できない場合は
 * 「不正な sid で 15秒待ち続ける」のではなく「停止だけして回収に委譲」する。
 */
export function decideStop(
  isRecording: boolean,
  status: string,
  lastSessionId: string,
): StopDecision {
  if (!isRecording) return { kind: 'ignore' };
  const normalized = normalizeStatus(status);
  const sid = normalized.startsWith('recording:')
    ? normalized.slice('recording:'.length)
    : '';
  const resolved = sid || lastSessionId;
  if (!resolved) return { kind: 'stop-unknown-session' };
  return { kind: 'stop', sessionId: resolved };
}

/**
 * 計測開始の可否（設計書 §4 の importing ガード2層）。
 * native lease（排他判定の正）が true の場合は開始しない。
 * 返り値の reason は UI ダイアログの分岐に使う。
 */
export function decideStart(
  isBusy: boolean,
  importPhase: ImportPhase,
  nativeIsImporting: boolean,
): { allowed: true } | { allowed: false; reason: 'busy' | 'importing' } {
  if (nativeIsImporting) return { allowed: false, reason: 'importing' };
  if (importPhase !== 'idle') return { allowed: false, reason: 'importing' };
  if (isBusy) return { allowed: false, reason: 'busy' };
  return { allowed: true };
}

/**
 * ネイティブの getStatus 応答を正規化する（JSON 形式 or プレーン）。
 * nativeSource.ts の parseNativeStatus と同等の責務だが、
 * この層はネイティブ非依存でテスト可能にするため自前に持つ。
 */
export function normalizeStatus(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { status?: string };
    if (typeof parsed?.status === 'string') return parsed.status;
  } catch {
    // JSON でなければプレーン形式
  }
  return raw;
}

/**
 * 停止完了の確認結果を判定する（設計書 §5・§8）。
 * - confirmed: 対象 sessionId の finished 到達（取り込みに進む）
 * - failed:    ネイティブが failed:<sid> を返した（DB書込失敗・回収対象外）
 * - timeout:   上限内に到達せず（AppState復帰時の回収に委譲）
 */
export type StopOutcome =
  | { kind: 'confirmed' }
  | { kind: 'failed' }
  | { kind: 'timeout' };

export function decideStopOutcome(
  reachedFinished: boolean,
  currentStatus: string,
  sessionId: string,
): StopOutcome {
  if (reachedFinished) return { kind: 'confirmed' };
  const normalized = normalizeStatus(currentStatus);
  if (normalized === `failed:${sessionId}`) return { kind: 'failed' };
  return { kind: 'timeout' };
}
