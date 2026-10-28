package expo.nemlysensor

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * NemlySensor bridge（spec §3・4メソッド）
 * start / stop / pullSeries / confirmImported / getStatus
 */
class NemlySensorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NemlySensor")

    Function("startRecording") {
      val ctx = appContext.reactContext
        ?: return@Function "error:no_context"
      val intent = Intent(ctx, NemlySensorService::class.java)
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
        val db = SensorDbHelper(appContext.reactContext!!)
        val (samplesJson, metaJson) = db.pullSeries(sessionId)
        promise.resolve("{\"samples\":$samplesJson,\"meta\":$metaJson}")
      } catch (e: Exception) {
        promise.reject("PULL_ERROR", e.message, e)
      }
    }

    Function("confirmImported") { sessionId: String ->
      SensorDbHelper(appContext.reactContext!!).purgeSession(sessionId)
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
