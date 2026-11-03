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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

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
  private val finishing = AtomicBoolean(false)
  private var sessionId: String = ""
  private var windowStartEpochMs: Long = 0
  private val lpf = DoubleArray(3)
  private var lpfInit = false
  private val events = mutableListOf<RawEvent>()
  private var wakeLock: PowerManager.WakeLock? = null
  private val timerHandler = Handler(Looper.getMainLooper())
  private var autoStopRunnable: Runnable? = null

  companion object {
    const val CHANNEL_ID = "nemly_recording"
    const val NOTIFICATION_ID = 1
    const val MAX_RETRIES = 3
    const val ACTION_STOP = "expo.nemlysensor.ACTION_STOP"
    const val ACTION_START_WITH_TIMER = "expo.nemlysensor.ACTION_START_WITH_TIMER"
    const val EXTRA_DURATION_MINUTES = "duration_minutes"
    const val EXTRA_STOP_REASON = "stop_reason"
    // MLR r2 GLM#1: インスタンスフィールドだと START_STICKY 再生成で上限が無効になるため静的にする
    //（プロセス死亡時はリセット=新規計測扱いが妥当・プロセス生存中の再生成では上限を維持）
    // MLR r3 GLM#3: Module の startRecording で新規セッション開始時にリセットするため外部代入を許可
    var retryCount = 0
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
      cancelAutoStopTimer()
      finishSession(intent.getStringExtra(EXTRA_STOP_REASON) ?: "user_stop")
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

    // 設計書 §3: 前回停止で true のまま残った CAS を解除しないと2回目の計測が停止できなくなる
    finishing.set(false)
    sessionId = "s-" + System.currentTimeMillis()
    lastSessionId = sessionId
    windowStartEpochMs = System.currentTimeMillis()
    lpfInit = false
    SensorDbHelper.get(this).startSession(sessionId, windowStartEpochMs)

    startForegroundCompat("Nemly 計測中")
    // CPU suspend 防止（2026-10-29 昼寝実測: 画面OFFでセンサー配信が停止し欠損窓383/901）
    // Sleep as Android 等の定番手法・上限10時間の安全弁つき
    wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nemly:sensorRecording")
    wakeLock?.acquire(10 * 60 * 60 * 1000L)
    // 2026-10-29 校正: GAME実効3.5Hz→UI（公称60Hz）で実測確認・FASTESTはMLR r1でバッテリー/JS飽和指摘により不採用
    sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI)
    isRunning = true
    lastStatus = "recording:$sessionId"
    Log.i(TAG, "recording started: $sessionId")

    // 機能C: タイマー付き開始（昼寝ショートカット）・FGS 生存中のみ有効（計測中は FGS 常駐前提）
    if (intent?.action == ACTION_START_WITH_TIMER) {
      val minutes = intent.getLongExtra(EXTRA_DURATION_MINUTES, 0L)
      if (minutes > 0) {
        scheduleAutoStop(minutes * 60_000L)
      }
    }
    return START_STICKY
  }

  /** durationMs 経過後に ACTION_STOP を自己送出（自動停止 reason=auto_timer） */
  private fun scheduleAutoStop(durationMs: Long) {
    cancelAutoStopTimer()
    val runnable = Runnable {
      if (!isRunning) return@Runnable
      Log.i(TAG, "auto stop timer fired")
      startService(
        Intent(this, NemlySensorService::class.java)
          .setAction(ACTION_STOP)
          .putExtra(EXTRA_STOP_REASON, "auto_timer")
      )
    }
    autoStopRunnable = runnable
    timerHandler.postDelayed(runnable, durationMs)
  }

  private fun cancelAutoStopTimer() {
    autoStopRunnable?.let { timerHandler.removeCallbacks(it) }
    autoStopRunnable = null
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
    val db = SensorDbHelper.get(this)
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
        // 確定済み窓（境界未満）だけを処理し・次窓以降のイベントは保持する
        //（旧実装は events.clear() で次窓以降も消去 → 低レート時に窓内イベントが
        //  枯渇し ec=1 の窓が量産されるバグ・2026-10-29 昼寝実測で発見・修正）
        while (epochMs >= windowStartEpochMs + WindowAggregator.STEP_MS) {
          val boundary = windowStartEpochMs + WindowAggregator.STEP_MS
          val (done, rest) = WindowAggregator.partitionAtBoundary(events, boundary)
          if (done.isNotEmpty()) {
            val win = WindowAggregator.computeWindows(done, windowStartEpochMs, boundary - 1)
            for (w in win) {
              db.insertSample(sessionId, w.tsMs, w.amplitude, w.quality, w.eventCount)
            }
          }
          events.clear()
          events.addAll(rest)
          windowStartEpochMs = boundary
        }
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private fun finishSession(reason: String) {
    if (!finishing.compareAndSet(false, true)) return
    try {
      val db = SensorDbHelper.get(this)
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
      // MLR指摘（MiniMax#10）: DB 書込が成功したときだけ finished にする（失敗時も finished だと
      // 空系列の import が走り・回収も status='finished' を待つため取り込み不能が黙る）
      lastStatus = "finished:$sessionId"
      Log.i(TAG, "recording finished: $sessionId reason=$reason")
    } catch (e: Exception) {
      lastStatus = "failed:$sessionId"
      Log.e(TAG, "finishSession failed: $sessionId reason=$reason", e)
    } finally {
      // 設計書 §3: 途中で例外が起きても後片付け（unregister/release/stopSelf）を必ず実行
      sensorManager.unregisterListener(this)
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
      isRunning = false
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  override fun onDestroy() {
    cancelAutoStopTimer()
    // START_STICKY が再配信しない kill を retry 上限で防御（spec §8・crash-loop 防御）
    if (isRunning) {
      retryCount++
      // MLR指摘（GLM#4）: 外側の if (isRunning) と同一条件の冗長判定を簡約
      val db = SensorDbHelper.get(this)
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
