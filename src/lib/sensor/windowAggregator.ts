/**
 * 振幅集約の TS 参照実装（spec §5 の数式）
 *
 * 契約: 同一 event 列から既存パイプラインと native（WindowAggregator.kt）が
 * 同一結果を出す（golden parity・Kotlin 側は JVM unit test で同一 vector を検証）。
 * このファイルが数式の正典・Kotlin 変更時は本実装と diff レビューすること。
 */
import type { SensorSample } from "./types";

const STEP_MS = 10_000;
const ALPHA = 0.8; // 低pass 係数（重力除去・spec §5 固定）
const MAX_VALID_NORM = 100; // m/s²（これ超は無効イベント）
const MIN_DELAY_MS = -5_000; // 遅延受信の許容（過去5秒まで・超過は無視）

export interface RawEvent {
  epochMs: number;
  x: number;
  y: number;
  z: number;
}

export interface QualitySummary {
  nanRate: number;
  stationaryRate: number;
  validRatio: number;
  gaps: { start: number; end: number }[];
}

export function computeWindows(
  events: RawEvent[],
  startMs: number,
  endMs?: number
): SensorSample[] {
  const sorted = [...events]
    .filter((e) => Number.isFinite(e.epochMs))
    .sort((a, b) => a.epochMs - b.epochMs);
  if (sorted.length === 0) return [];

  const lastMs = endMs ?? sorted[sorted.length - 1]!.epochMs;
  const winCount = Math.ceil((lastMs - startMs) / STEP_MS);
  const buckets: RawEvent[][] = Array.from({ length: winCount }, () => []);

  const base = startMs;
  for (const e of sorted) {
    if (e.epochMs < base + MIN_DELAY_MS) continue; // 5秒超の遅延は無視
    let idx = Math.floor((e.epochMs - base) / STEP_MS);
    if (idx < 0) idx = 0;
    if (idx >= winCount) idx = winCount - 1;
    buckets[idx]!.push(e);
  }

  let lpf: { x: number; y: number; z: number } | null = null;
  const out: SensorSample[] = [];
  for (let w = 0; w < winCount; w++) {
    const evs = buckets[w]!;
    // lowpass は窓を跨いで連続（時系列順に処理されるため buckets 順で OK）
    const mags: number[] = [];
    for (const e of evs) {
      const norm = Math.hypot(e.x, e.y, e.z);
      if (!Number.isFinite(norm) || norm > MAX_VALID_NORM) continue;
      if (!lpf) {
        lpf = { x: e.x, y: e.y, z: e.z };
      } else {
        lpf.x = ALPHA * lpf.x + (1 - ALPHA) * e.x;
        lpf.y = ALPHA * lpf.y + (1 - ALPHA) * e.y;
        lpf.z = ALPHA * lpf.z + (1 - ALPHA) * e.z;
      }
      mags.push(Math.hypot(e.x - lpf.x, e.y - lpf.y, e.z - lpf.z));
    }
    if (mags.length === 0) continue; // 欠損窓=行なし
    const amplitude = mags.reduce((s, m) => s + m, 0) / mags.length;
    out.push({
      tsMs: startMs + w * STEP_MS,
      amplitude,
      quality: mags.length < 200 ? 1 : 0, // 実効レート実測前の暫定閾値・1時間段で校正
      eventCount: mags.length,
    });
  }
  return out;
}

const STATIONARY_THRESHOLD = 0.01; // 2026-10-29 校正: 昨夜DB実測（机p50=0.0043・ベッド>=0.01=15.15%非定常）に基づく・0.05はp99.1相当で微細体動を全て定常と数えていた

export function summarizeQuality(
  windows: SensorSample[],
  expectedWindowCount: number
): QualitySummary {
  const n = windows.length || 1;
  const stationary = windows.filter((w) => w.amplitude < STATIONARY_THRESHOLD).length;
  const invalid = windows.filter(
    (w) => !Number.isFinite(w.amplitude) || w.amplitude < 0
  ).length;
  const gaps: { start: number; end: number }[] = [];
  if (windows.length > 0) {
    const sorted = [...windows].sort((a, b) => a.tsMs - b.tsMs);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1]!.tsMs + STEP_MS;
      if (sorted[i]!.tsMs > prevEnd) {
        gaps.push({ start: prevEnd, end: sorted[i]!.tsMs });
      }
    }
  }
  return {
    nanRate: invalid / n,
    stationaryRate: stationary / n,
    validRatio: expectedWindowCount === 0 ? 1 : windows.length / expectedWindowCount,
    gaps,
  };
}
