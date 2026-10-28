package expo.nemlysensor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.IBinder
import android.os.SystemClock
import android.util.Log

/**
 * センサー計測の ForegroundService（spec §3・§6・health型）
 *
 * 契約:
 * - 10秒窓の振幅をネイティブ専用DBへ逐次書込（JS は計測中に触らない）
 * - START_STICKY + retry 上限（3回超過で failed・immutable・自動再試行なし）
 * - センサー無し・startForeground 失敗は非サポート状態として明示（握り潰さない）
 */
class NemlySensorService : Service(), SensorEventListener {
  private lateinit var sensorManager: SensorManager
  private var dbHelper: SensorDbHelper? = null
  private var sessionId: String = ""
  private var windowStartEpochMs: Long = 0
  private val lpf = DoubleArray(3)
  private var lpfInit = false
  private val events = mutableListOf<RawEvent>()
  private var retryCount = 0

  companion object {
    const val CHANNEL_ID = "nemly_recording"
    const val NOTIFICATION_ID = 1
    const val MAX_RETRIES = 3
    const val ACTION_STOP = "expo.nemlysensor.ACTION_STOP"
    var isRunning = false
      private set
    var lastStatus = "idle"
      private set
    var lastSessionId = ""
      private set
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      finishSession("user_stop")
      return START_NOT_STICKY
    }
    if (isRunning) return START_STICKY

    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    if (sensor == null) {
      // 非サポート状態として明示（spec §6・握り潰さない）
      lastStatus = "failed_no_sensor"
      startForegroundCompat("Nemly 計測不可（加速度センサー無し）")
      stopSelf()
      return START_NOT_STICKY
    }

    dbHelper = SensorDbHelper(this)
    sessionId = "s-" + System.currentTimeMillis()
    lastSessionId = sessionId
    windowStartEpochMs = System.currentTimeMillis()
    lpfInit = false
    dbHelper!!.startSession(sessionId, windowStartEpochMs)

    startForegroundCompat("Nemly 計測中")
    sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
    isRunning = true
    lastStatus = "recording:$sessionId"
    Log.i(TAG, "recording started: $sessionId")
    return START_STICKY
  }

  private fun startForegroundCompat(text: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "計測", NotificationManager.IMPORTANCE_LOW)
    )
    val n: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Nemly")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setOngoing(true)
      .build()
    // health型（spec §6 Go/No-Go 確定）・OS バージョンで分岐（29未満は型指定不要）
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    // spec §5: elapsedRealtimeNanos 基準 → 現在オフセット方式で epoch へ変換
    val offsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtimeNanos() / 1_000_000
    val epochMs = offsetMs + event.timestamp / 1_000_000
    val db = dbHelper ?: return
    synchronized(events) {
      events.add(
        RawEvent(
          epochMs,
          event.values[0].toDouble(),
          event.values[1].toDouble(),
          event.values[2].toDouble()
        )
      )
      if (epochMs >= windowStartEpochMs + WindowAggregator.STEP_MS) {
        val win = WindowAggregator.computeWindows(
          events.toList(),
          windowStartEpochMs,
          epochMs
        )
        for (w in win) {
          db.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
        }
        events.clear()
        val elapsed = (epochMs - windowStartEpochMs) / WindowAggregator.STEP_MS
        windowStartEpochMs += WindowAggregator.STEP_MS * elapsed
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private fun finishSession(reason: String) {
    val db = dbHelper ?: return
    synchronized(events) {
      if (events.isNotEmpty()) {
        val win = WindowAggregator.computeWindows(
          events.toList(),
          windowStartEpochMs,
          windowStartEpochMs + WindowAggregator.STEP_MS - 1
        )
        for (w in win) {
          db.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
        }
        events.clear()
      }
      db.finishSession(sessionId, System.currentTimeMillis(), reason)
    }
    sensorManager.unregisterListener(this)
    isRunning = false
    lastStatus = "finished:$sessionId"
    Log.i(TAG, "recording finished: $sessionId reason=$reason")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    // START_STICKY が再配信しない kill を retry 上限で防御（spec §8・crash-loop 防御）
    if (isRunning) {
      retryCount++
      val db = dbHelper
      if (retryCount > MAX_RETRIES) {
        lastStatus = "failed_retry_exhausted:$sessionId"
        isRunning = false
        db?.markFailed(sessionId, "retry_exhausted")
        Log.e(TAG, "retry exhausted: $sessionId")
      }
      // 上限内は START_STICKY による再配信を待つ（ret 向けの明示再起動はしない）
    }
    super.onDestroy()
  }

  private val TAG = "NemlySensorService"
}
