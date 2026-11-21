package expo.nemlysensor

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SensorDbHelper の kill 復旧機構（§7-8）の実機 Instrumented テスト（L1413）。
 * JVM Unit test 不可（SQLiteOpenHelper=Context 依存）のため実機で実行する。
 * 実DB（amplitude.db）は触らず・テストDB（amplitude_test.db）に隔離する。
 */
@RunWith(AndroidJUnit4::class)
class SensorDbHelperInstrumentedTest {

  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private lateinit var helper: SensorDbHelper

  @Before
  fun setUp() {
    context.deleteDatabase(TEST_DB)
    helper = SensorDbHelper.createForTest(context, TEST_DB)
  }

  @After
  fun tearDown() {
    context.deleteDatabase(TEST_DB)
  }

  private fun insertFinishedSession(id: String) {
    helper.startSession(id, 1000L)
    helper.finishSession(id, 2000L, "manual")
  }

  // --- markImporting（claim CAS・spec §6） ---

  @Test
  fun markImporting_claimFinished_returnsTrueAndTransitions() {
    insertFinishedSession("s1")
    assertTrue(helper.markImporting("s1"))
    val (_, meta) = helper.pullSeries("s1")
    assertTrue(meta.contains("\"status\":\"importing\""))
  }

  @Test
  fun markImporting_alreadyImported_returnsFalse() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    helper.purgeSession("s1")
    assertFalse(helper.markImporting("s1"))
  }

  @Test
  fun markImporting_importFailed_returnsFalse() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    helper.markImportFailed("s1")
    assertFalse(helper.markImporting("s1"))
  }

  @Test
  fun markImporting_importingResidue_isIdempotentReclaim() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    // kill で catch を通らず死んだ場合の importing 残留=次回起動の再 claim は成功（冪等）
    assertTrue(helper.markImporting("s1"))
  }

  // --- markImportFailed（回収対象外へ明示遷移） ---

  @Test
  fun markImportFailed_fromImporting_returnsTrue() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    assertTrue(helper.markImportFailed("s1"))
  }

  @Test
  fun markImportFailed_fromImported_returnsFalse() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    helper.purgeSession("s1")
    assertFalse(helper.markImportFailed("s1"))
  }

  // --- purgeSession（CAS purge・transaction 内） ---

  @Test
  fun purgeSession_importing_transitionsImportedAndDeletesSamples() {
    insertFinishedSession("s1")
    helper.insertSample("s1", 1100L, 0.5, 1, 0)
    helper.markImporting("s1")
    assertTrue(helper.purgeSession("s1"))
    val (series, meta) = helper.pullSeries("s1")
    assertEquals("[]", series)
    assertTrue(meta.contains("\"status\":\"imported\""))
  }

  @Test
  fun purgeSession_alreadyImported_returnsFalse() {
    insertFinishedSession("s1")
    helper.insertSample("s1", 1100L, 0.5, 1, 0)
    helper.markImporting("s1")
    helper.purgeSession("s1")
    // 既に imported=CAS 失敗で二重 purge しない（confirm 後 kill 防御の一次層）
    assertFalse(helper.purgeSession("s1"))
  }

  // --- getPendingSessionId（回収対象化・WHERE IN ('finished','importing')） ---

  @Test
  fun getPendingSessionId_finished_returnsSessionId() {
    insertFinishedSession("s1")
    assertEquals("s1", helper.getPendingSessionId())
  }

  @Test
  fun getPendingSessionId_importingResidue_returnsSessionId() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    // kill で catch を通らず死んだ場合: importing 残留も回収対象として拾う（§7-8拡張）
    assertEquals("s1", helper.getPendingSessionId())
  }

  @Test
  fun getPendingSessionId_imported_returnsNull() {
    insertFinishedSession("s1")
    helper.markImporting("s1")
    helper.purgeSession("s1")
    // confirm 後 kill: imported 永続=検知しない（回収不要=完了・二重登録防止の一次層）
    assertNull(helper.getPendingSessionId())
  }

  @Test
  fun getPendingSessionId_importFailed_returnsNull() {
    insertFinishedSession("s1")
    helper.markImportFailed("s1")
    assertNull(helper.getPendingSessionId())
  }

  companion object {
    private const val TEST_DB = "amplitude_test.db"
  }
}
