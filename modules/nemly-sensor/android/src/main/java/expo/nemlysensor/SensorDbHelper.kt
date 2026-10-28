package expo.nemlysensor

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * ネイティブ専用DB（amplitude.db・spec §4.1）
 * 契約: このファイルに書き込むのは本ヘルパーのみ（expo-sqlite は触らない）
 * WAL + 単一connection・migration 不要（新規ファイル・v1 固定）
 */
class SensorDbHelper(context: Context) :
  SQLiteOpenHelper(context, "amplitude.db", null, 1) {

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

  /** WAL 有効化（spec §4.1・専用ファイル内で完結するため他プロセス共有はしない） */
  override fun onConfigure(db: SQLiteDatabase) {
    db.enableWriteAheadLogging()
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

  /** UNIQUE(session_id, ts_ms) 衝突は CONFLICT_IGNORE（再取り込み=正常系・first-wins） */
  fun insertSample(sessionId: String, tsMs: Long, amplitude: Double, quality: Int, eventCount: Int) {
    val cv = ContentValues().apply {
      put("session_id", sessionId)
      put("ts_ms", tsMs)
      put("amplitude", amplitude)
      put("quality", quality)
      put("event_count", eventCount)
    }
    writableDatabase.insertWithOnConflict("samples", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
  }

  fun startSession(sessionId: String, startedAtMs: Long) {
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

  fun finishSession(sessionId: String, endedAtMs: Long, reason: String) {
    val cv = ContentValues().apply {
      put("ended_at_ms", endedAtMs)
      put("end_reason", reason)
      put("status", "finished")
    }
    writableDatabase.update("native_sessions", cv, "session_id = ?", arrayOf(sessionId))
  }

  fun markFailed(sessionId: String, reason: String) {
    val cv = ContentValues().apply {
      put("end_reason", reason)
      put("status", "failed")
    }
    writableDatabase.update("native_sessions", cv, "session_id = ?", arrayOf(sessionId))
  }

  /** 系列とメタを JSON で返す（pullSeries bridge の実体） */
  fun pullSeries(sessionId: String): Pair<String, String> {
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
    return Pair(sb.toString(), meta)
  }

  fun purgeSession(sessionId: String) {
    writableDatabase.delete("samples", "session_id = ?", arrayOf(sessionId))
  }
}
