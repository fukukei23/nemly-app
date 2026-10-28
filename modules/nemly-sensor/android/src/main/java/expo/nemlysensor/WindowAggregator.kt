package expo.nemlysensor

import kotlin.math.hypot

/**
 * 振幅集約（spec §5 の数式・TS 参照実装 src/lib/sensor/windowAggregator.ts と同一式）
 * 契約: 同一 event 列から TS 参照実装と同一結果（golden parity・JVM unit test で検証）
 */
data class RawEvent(val epochMs: Long, val x: Double, val y: Double, val z: Double)
data class WindowSample(val tsMs: Long, val amplitude: Double, val quality: Int, val eventCount: Int)

object WindowAggregator {
  const val STEP_MS = 10_000L
  private const val ALPHA = 0.8
  private const val MAX_VALID_NORM = 100.0
  private const val MIN_DELAY_MS = -5_000L
  const val MIN_EVENTS_FOR_OK = 200 // 実効レート実測前の暫定閾値・1時間段で校正

  fun computeWindows(events: List<RawEvent>, startMs: Long, endMs: Long? = null): List<WindowSample> {
    val sorted = events.sortedBy { it.epochMs }
    if (sorted.isEmpty()) return emptyList()
    val last = endMs ?: sorted.last().epochMs
    val winCount = Math.ceil((last - startMs).toDouble() / STEP_MS).toInt()
    if (winCount <= 0) return emptyList()
    val buckets: Array<MutableList<RawEvent>> = Array(winCount) { mutableListOf() }
    val base = startMs
    for (e in sorted) {
      if (e.epochMs < base + MIN_DELAY_MS) continue // 5秒超の遅延は無視
      var idx = ((e.epochMs - base) / STEP_MS).toInt()
      idx = idx.coerceIn(0, winCount - 1)
      buckets[idx].add(e)
    }
    var lpfX = 0.0; var lpfY = 0.0; var lpfZ = 0.0
    var lpfInit = false
    val out = mutableListOf<WindowSample>()
    for (w in 0 until winCount) {
      val mags = mutableListOf<Double>()
      for (e in buckets[w]) {
        val norm = hypot(hypot(e.x, e.y), e.z)
        if (!norm.isFinite() || norm > MAX_VALID_NORM) continue
        if (!lpfInit) {
          lpfX = e.x; lpfY = e.y; lpfZ = e.z; lpfInit = true
        } else {
          lpfX = ALPHA * lpfX + (1 - ALPHA) * e.x
          lpfY = ALPHA * lpfY + (1 - ALPHA) * e.y
          lpfZ = ALPHA * lpfZ + (1 - ALPHA) * e.z
        }
        mags.add(hypot(hypot(e.x - lpfX, e.y - lpfY), e.z - lpfZ))
      }
      if (mags.isEmpty()) continue // 欠損窓=行なし
      val amp = mags.average()
      out.add(WindowSample(startMs + w * STEP_MS, amp, if (mags.size < MIN_EVENTS_FOR_OK) 1 else 0, mags.size))
    }
    return out
  }
}
