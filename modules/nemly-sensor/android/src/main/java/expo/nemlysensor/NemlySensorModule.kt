package expo.nemlysensor

import android.content.Intent
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * NemlySensor bridge（spec §3・4メソッド）
 * start / stop / pullSeries / confirmImported / getStatus
 */
class NemlySensorModule : Module() {
  companion object {
    private const val TAG = "NemlySensorModule"
    private const val IMPORT_LEASE_MS = 30_000L
    @Volatile
    private var importLeaseUntilMs: Long = 0L
    @Volatile
    private var leaseTokenSeq: Long = 0L

    /** 設計書 §4: 排他判定の正（JS state は表示制御のみ）。lease 形式で fire-and-forget 死亡時も30秒で自動解放 */
    fun isImporting(): Boolean = System.currentTimeMillis() < importLeaseUntilMs

    /**
     * MLR指摘（GLM#5・MiniMax#4）: lease を token 形式に（後勝ち上書きや他経路の
     * endImportLease が他方の実行中 lease を誤解放するのを防ぐ）。token 不一致の解放は無視する。
     */
    fun acquireLease(): Long {
      val token = ++leaseTokenSeq
      importLeaseUntilMs = System.currentTimeMillis() + IMPORT_LEASE_MS
      Log.i(TAG, "import lease acquired: token=$token until=$importLeaseUntilMs")
      return token
    }

    fun releaseLease(token: Long): Boolean {
      if (token != leaseTokenSeq) {
        Log.i(TAG, "import lease release ignored (token mismatch): got=$token current=$leaseTokenSeq")
        return false
      }
      importLeaseUntilMs = 0L
      Log.i(TAG, "import lease released: token=$token")
      return true
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NemlySensor")

    Function("startRecording") { durationMinutes: Double? ->
      // 設計書 §4: importing 中は startRecording のみ拒否（stopRecording は許可）
      if (isImporting()) return@Function "error:importing"
      val ctx = appContext.reactContext
        ?: return@Function "error:no_context"
      // MLR r3 GLM#3: 新規セッション開始時は retryCount をリセット（companion 静的化の副作用・
      // プロセス生存中の計測開始/停止繰り返しで上限に達してしまうのを防ぐ）
      NemlySensorService.retryCount = 0
      val intent = Intent(ctx, NemlySensorService::class.java)
      if (durationMinutes != null && durationMinutes > 0) {
        intent.setAction(NemlySensorService.ACTION_START_WITH_TIMER)
        intent.putExtra(NemlySensorService.EXTRA_DURATION_MINUTES, durationMinutes.toLong())
      }
      ctx.startForegroundService(intent)
      "started"
    }

    Function("stopRecording") {
      val ctx = appContext.reactContext
        ?: return@Function "error:no_context"
      ctx.startService(
        Intent(ctx, NemlySensorService::class.java).setAction(NemlySensorService.ACTION_STOP)
      )
      NemlySensorService.lastStatus
    }

    AsyncFunction("pullSeries") { sessionId: String, promise: expo.modules.kotlin.Promise ->
      try {
        val db = SensorDbHelper.get(appContext.reactContext!!)
        val (samplesJson, metaJson) = db.pullSeries(sessionId)
        promise.resolve("{\"samples\":$samplesJson,\"meta\":$metaJson}")
      } catch (e: Exception) {
        promise.reject("PULL_ERROR", e.message, e)
      }
    }

    Function("confirmImported") { sessionId: String ->
      SensorDbHelper.get(appContext.reactContext!!).purgeSession(sessionId)
      "ok"
    }

    Function("getStatus") {
      "{\"status\":\"${NemlySensorService.lastStatus}\",\"sessionId\":\"${NemlySensorService.lastSessionId}\"}"
    }

    // golden parity 検証用（Task 7 Step 2 の JVM test と同一式の実機確認・debug 用途のみ）
    Function("computeWindowsDebug") { payload: String ->
      WindowAggregator.computeWindows(parseEvents(payload), 0).toString()
    }

    Function("getLastSessionId") { NemlySensorService.lastSessionId }

    // 起動時取り込み用（2026-11-03・force-stop後のidle問題で静的ステータスからは検知できないためDB直接問い合わせ）
    Function("getPendingSessionId") {
      SensorDbHelper.get(appContext.reactContext!!).getPendingSessionId() ?: ""
    }

    // 設計書 §4+MLR指摘: import 排他 lease（token 形式・30秒自動期限切れ・不一致解放は無視）
    Function("acquireLease") { acquireLease() }
    Function("releaseLease") { token: Double -> releaseLease(token.toLong()) }
    Function("isImporting") { isImporting() }
  }

  private fun parseEvents(json: String): List<RawEvent> {
    val arr = org.json.JSONArray(json)
    return (0 until arr.length()).map { i ->
      val e = arr.getJSONObject(i)
      RawEvent(
        e.getLong("epochMs"),
        e.getDouble("x"),
        e.getDouble("y"),
        e.getDouble("z")
      )
    }
  }
}
