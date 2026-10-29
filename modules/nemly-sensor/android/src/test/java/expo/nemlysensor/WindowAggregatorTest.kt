package expo.nemlysensor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * golden parity（spec §9 第1-2層）: TS 参照実装（src/lib/sensor/windowAggregator.ts）と
 * 同一の golden vector を流し・同一の性質（窓数・event数・有限非負振幅）を検証する。
 * JVM unit test（エミュレータ不要）
 */
class WindowAggregatorTest {
  private data class VEvent(val epochMs: Long, val x: Double, val y: Double, val z: Double)

  /** org.json（android.jar stub 衝突回避のため手書きミニパーサ）で golden vector を読む */
  private fun loadGoldenEvents(): Pair<Int, List<VEvent>> {
    val stream = javaClass.getResourceAsStream("/goldenVector.json")
      ?: throw AssertionError("goldenVector.json が resources に無い")
    val text = stream.bufferedReader().readText()
    val hz = Regex("\"hz\":(\\d+)").find(text)!!.groupValues[1].toInt()
    val regex = Regex("\\{\"tSec\":([0-9.]+),\"x\":(-?[0-9.]+),\"y\":(-?[0-9.]+),\"z\":(-?[0-9.]+)\\}")
    val events = regex.findAll(text).map { m ->
      VEvent(
        Math.round(m.groupValues[1].toDouble() * 1000),
        m.groupValues[2].toDouble(),
        m.groupValues[3].toDouble(),
        m.groupValues[4].toDouble()
      )
    }.toList()
    return Pair(hz, events)
  }

  @Test
  fun goldenParityWithTsReference() {
    val (hz, events) = loadGoldenEvents()
    assertEquals(20, hz)
    assertEquals(600, events.size)

    val windows = WindowAggregator.computeWindows(
      events.map { RawEvent(it.epochMs, it.x, it.y, it.z) },
      startMs = 0,
      endMs = 30_000
    )
    // TS 側 jest の期待値と同一: 3窓・200イベント/窓・quality=0
    assertEquals(3, windows.size)
    assertEquals(0L, windows[0].tsMs)
    assertEquals(200, windows[0].eventCount)
    assertEquals(200, windows[1].eventCount)
    assertEquals(200, windows[2].eventCount)
    assertTrue(windows.all { it.amplitude.isFinite() && it.amplitude >= 0.0 })
    assertTrue(windows.all { it.quality == 0 })
  }

  @Test
  fun missingWindowProducesNoRow() {
    val events = listOf(
      RawEvent(0, 0.0, 0.0, 9.8),
      RawEvent(25_000, 0.0, 0.0, 9.8)
    )
    val windows = WindowAggregator.computeWindows(events, 0, 30_000)
    assertEquals(2, windows.size)
    assertEquals(0L, windows[0].tsMs)
    assertEquals(20_000L, windows[1].tsMs)
  }

  @Test
  fun invalidEventsAreSkipped() {
    val events = listOf(
      RawEvent(0, Double.NaN, 0.0, 9.8),
      RawEvent(500, 0.0, 0.0, 999.0),
      RawEvent(1000, 0.0, 0.0, 9.8)
    )
    val windows = WindowAggregator.computeWindows(events, 0, 10_000)
    assertEquals(1, windows.size)
    assertEquals(1, windows[0].eventCount)
  }

  @Test
  fun partitionAtBoundarySplitsAtExactBoundary() {
    // 境界ちょうどのイベントは「次窓側」に属する（窓は [start, start+STEP) 区間）
    val events = listOf(
      RawEvent(0, 0.0, 0.0, 9.8),
      RawEvent(5_000, 0.0, 0.0, 9.8),
      RawEvent(10_000, 0.0, 0.0, 9.8),
      RawEvent(15_000, 0.0, 0.0, 9.8)
    )
    val (done, rest) = WindowAggregator.partitionAtBoundary(events, 10_000)
    assertEquals(2, done.size)
    assertEquals(2, rest.size)
  }

  /**
   * 回帰テスト（2026-10-29 昼寝実測バグ）: 旧実装は窓確定時に events.clear() で
   * 次窓以降のイベントも消去するため、窓境界直後のイベントが失われ
   * 低レート時に窓内イベントが枯渇（ec=1 の窓が量産・欠損窓増加）した。
   * 窓0=3イベント・窓1=2イベントのストリームで、窓1が2イベントのまま書かれることを検証。
   */
  @Test
  fun boundaryCrossingEventsSurviveWindowFlush() {
    var windowStart = 0L
    val events = mutableListOf<RawEvent>()
    val written = mutableListOf<Pair<Long, Int>>()
    val stream = listOf(1_000L, 2_000L, 3_000L, 12_000L, 14_000L, 22_000L)
    for (t in stream) {
      events.add(RawEvent(t, 0.0, 0.0, 9.8))
      while (t >= windowStart + WindowAggregator.STEP_MS) {
        val boundary = windowStart + WindowAggregator.STEP_MS
        val (done, rest) = WindowAggregator.partitionAtBoundary(events, boundary)
        if (done.isNotEmpty()) {
          for (w in WindowAggregator.computeWindows(done, windowStart, boundary - 1)) {
            written.add(Pair(w.tsMs, w.eventCount))
          }
        }
        events.clear()
        events.addAll(rest)
        windowStart = boundary
      }
    }
    assertEquals(Pair(0L, 3), written[0])
    assertEquals(Pair(10_000L, 2), written[1])
  }
}
