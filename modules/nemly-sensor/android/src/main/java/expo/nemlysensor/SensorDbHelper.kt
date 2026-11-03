package expo.nemlysensor

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log

/**
 * ネイティブ専用DB（amplitude.db・spec §4.1）
 * 契約: このファイルに書き込むのは本ヘルパーのみ（expo-sqlite は触らない）
 * WAL + プロセス内単一connection（設計書 §1 singleton）・migration 不要（新規ファイル・v1 固定）
 */
class SensorDbHelper private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "amplitude.db", null, 1) {

  companion object {
    private const val TAG = "SensorDbHelper"
    private const val BUSY_TIMEOUT_MS = 1000L
    @Volatile
    private var instance: SensorDbHelper? = null

    /** プロセス内単一接続（設計書 §1・呼び出しごとの新規生成が journal mode 変更待ち15秒の根因） */
    fun get(context: Context): SensorDbHelper =
      instance ?: synchronized(this) {
        instance ?: SensorDbHelper(context.applicationContext).also { instance = it }
      }
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS samples (" +
        "session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, amplitude REAL NOT NULL, " +
        "quality INTEGER NOT NULL, event_count INTEGER NOT NULL, " +
        "PRIMARY KEY (session_id, ts_ms))"
    )
    db.execSQL(
      "CREATE TABLE IF NOT EXISTS native_sessions (" +
        "session_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, " +
        "end_reason TEXT, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0)"
    )
  }

  /** WAL+busy_timeout（設計書 §1・ロック競合時は1秒待つ→例外で fail-fast） */
  override fun onConfigure(db: SQLiteDatabase) {
    db.enableWriteAheadLogging()
    db.execSQL("PRAGMA busy_timeout = $BUSY_TIMEOUT_MS")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

  /**
   * 設計書 §1: busy_timeout 満了時は SQLiteDatabaseLockedException で fail-fast。
   * 明示リトライ1回（再度失敗時は呼び出し側へ例外伝播・黙り込まない）
   */
  private fun <T> withLockRetry(block: () -> T): T =
    try {
      block()
    } catch (e: SQLiteDatabaseLockedException) {
      Log.w(TAG, "db locked (busy_timeout ${BUSY_TIMEOUT_MS}ms), retrying once: ${e.message}")
      block()
    }

  /** UNIQUE(session_id, ts_ms) 衝突は CONFLICT_IGNORE（再取り込み=正常系・first-wins） */
  fun insertSample(sessionId: String, tsMs: Long, amplitude: Double, quality: Int, eventCount: Int) =
    withLockRetry {
      val cv = ContentValues().apply {
        put("session_id", sessionId)
        put("ts_ms", tsMs)
        put("amplitude", amplitude)
        put("quality", quality)
        put("event_count", eventCount)
      }
      writableDatabase.insertWithOnConflict("samples", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
    }

  fun startSession(sessionId: String, startedAtMs: Long) = withLockRetry {
    val cv = ContentValues().apply {
      put("session_id", sessionId)
      put("started_at_ms", startedAtMs)
      putNull("ended_at_ms")
      putNull("end_reason")
      put("status", "recording")
      put("retry_count", 0)
    }
    writableDatabase.insertWithOnConflict("native_sessions", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
  }

  fun finishSession(sessionId: String, endedAtMs: Long, reason: String) = withLockRetry {
    val cv = ContentValues().apply {
      put("ended_at_ms", endedAtMs)
      put("end_reason", reason)
      put("status", "finished")
    }
    writableDatabase.update("native_sessions", cv, "session_id = ?", arrayOf(sessionId))
  }

  fun markFailed(sessionId: String, reason: String) = withLockRetry {
    val cv = ContentValues().apply {
      put("end_reason", reason)
      put("status", "failed")
    }
    writableDatabase.update("native_sessions", cv, "session_id = ?", arrayOf(sessionId))
  }

  /** 系列とメタを JSON で返す（pullSeries bridge の実体） */
  fun pullSeries(sessionId: String): Pair<String, String> = withLockRetry {
    val db = readableDatabase
    val sb = StringBuilder("[")
    var first = true
    db.rawQuery(
      "SELECT ts_ms, amplitude, quality, event_count FROM samples WHERE session_id = ? ORDER BY ts_ms",
      arrayOf(sessionId)
    ).use { c ->
      while (c.moveToNext()) {
        if (!first) sb.append(",")
        first = false
        sb.append("{\"tsMs\":${c.getLong(0)},\"amplitude\":${c.getDouble(1)},\"quality\":${c.getInt(2)},\"eventCount\":${c.getInt(3)}}")
      }
    }
    sb.append("]")
    val meta = db.rawQuery(
      "SELECT started_at_ms, ended_at_ms, end_reason, status FROM native_sessions WHERE session_id = ?",
      arrayOf(sessionId)
    ).use { c ->
      if (c.moveToFirst()) {
        val ended = if (c.isNull(1)) "null" else c.getLong(1).toString()
        val reason = c.getString(2) ?: "null"
        "{\"sessionId\":\"$sessionId\",\"startedAtMs\":${c.getLong(0)},\"endedAtMs\":$ended,\"endReason\":\"$reason\",\"status\":\"${c.getString(3)}\"}"
      } else "{}"
    }
    Pair(sb.toString(), meta)
  }

  /** 取り込み完了後の削除（samples+native_sessions・finished 行が残ると起動時 pending 検知が無限ヒットするため・2026-11-03） */
  fun purgeSession(sessionId: String) = withLockRetry {
    writableDatabase.delete("samples", "session_id = ?", arrayOf(sessionId))
    writableDatabase.delete("native_sessions", "session_id = ?", arrayOf(sessionId))
  }

  /** 未取り込み（status='finished'）の最新セッションID（起動時取り込み用・2026-11-03・force-stop後は静的ステータスがidleに戻るためDBを見る） */
  fun getPendingSessionId(): String? = withLockRetry {
    readableDatabase.rawQuery(
      "SELECT session_id FROM native_sessions WHERE status='finished' ORDER BY ended_at_ms DESC LIMIT 1",
      null
    ).use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  }
}
