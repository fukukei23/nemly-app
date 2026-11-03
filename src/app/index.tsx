import { useEffect, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { listSessions, type SessionRecord } from '@/lib/repository';
import { initializeSqliteRepositoryAsync } from '@/lib/sqliteRepository';
import { importSensorSession } from '@/lib/sensor/sensorImport';
import { isFinishedStatus, parseNativeStatus } from '@/lib/sensor/autoImport';
import {
  createNativeSensorSource,
  nativeGetPendingSessionId,
  nativeGetStatus,
  nativeStartRecording,
  nativeStopRecording,
} from '@/lib/sensor/nativeSource';
import { SessionCard } from '@/components/ui/SessionCard';
import { ResultDialog, type ResultTone } from '@/components/ui/ResultDialog';
import { theme } from '@/constants/theme';

/** 昼寝ショートカットのタイマー（分・機能C） */
const NAP_MINUTES = [30, 60, 90] as const;

type ResultDialogState = {
  title: string;
  message: string;
  tone: ResultTone;
} | null;

/** FGS の終了書込完了を待つ（finished: 接頭辞 or 15秒タイムアウト） */
async function waitForServiceStop(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (isFinishedStatus(nativeGetStatus())) return true;
  }
  return false;
}

function formatToday(): string {
  const d = new Date();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${weekdays[d.getDay()]}`;
}

export default function SessionListScreen() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ResultDialogState>(null);
  /** 自動取り込み済みのネイティブセッションID（AppState復帰時の二重取り込み防止） */
  const lastImportedRef = useRef('');

  const refreshSessions = async () => {
    const rows = await listSessions();
    setSessions(rows);
    setLoaded(true);
  };

  /**
   * 機能C: ネイティブに未取り込みの finished セッションがあれば取り込む。
   * 起動時（force-stop/クラッシュ後の漏れ防止）と AppState 復帰時（タイマー自動停止後）の
   * 両方から呼ぶ（11-03 実機観察: アプリ起動時は change イベントが来ず取り込み漏れになる実測）。
   * finished 検知時は recording 表示も解除する（ネイティブは停止済みのため）。
   */
  const syncFromNativeStatus = async (rawStatus: string) => {
    // MLR r2 MiniMax#6: 同時 callback で取り込みが並走するのを防ぐ（busy 中の復帰イベントはスキップ・
    // ガードクリア後に次のイベントで再試行される）
    if (busy) return;
    // MLR 2026-11-03 GLM#1: 呼び出し側が生の getStatus() JSON を渡すケースがあるため
    // ここで必ず正規化する（recording 検知が JSON 形式だと常に失敗する実バグ）
    const status = parseNativeStatus(rawStatus);
    if (status.startsWith('recording:')) {
      setRecording(true);
      return;
    }
    if (isFinishedStatus(status)) setRecording(false);
    if (!isFinishedStatus(status)) return;
    const sid = status.replace('finished:', '');
    if (sid === lastImportedRef.current) return;
    setBusy(true);
    try {
      const res = await importSensorSession(createNativeSensorSource());
      await refreshSessions();
      // MLR 2026-11-03 GLM#2: 取り込み成功後のみガード設定（例外時の再試行永久ブロック防止）
      lastImportedRef.current = sid;
      if (res.sessionId === null && res.verdict === 'pass') {
        // 空系列（既に取り込み済みの pending 掃除）はダイアログを出さない
        return;
      }
      if (res.verdict === 'fail') {
        setDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
      } else if (res.verdict === 'degraded_pass') {
        setDialog({ title: '昼寝を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
      } else {
        setDialog({ title: '昼寝を取り込みました', message: '一覧に表示されています', tone: 'ok' });
      }
    } catch (e) {
      // 例外を握らない（2026-11-03 実機デバッグ: 無音失敗で起動時取り込みが止まっていた）
      // MLR GLM#2: 失敗時はガードをクリアして次回 AppState 復帰時に再試行可能にする
      lastImportedRef.current = '';
      setDialog({
        title: '取り込みに失敗しました',
        message: e instanceof Error ? e.message : String(e),
        tone: 'fail',
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    (async () => {
      await initializeSqliteRepositoryAsync();
      await refreshSessions();
      try {
        // 起動時取り込み: 未取り込み（finished）セッションはネイティブDBを直接見る
        //（force-stop後は静的ステータスがidleに戻るためgetStatusでは検知できない・2026-11-03実測）
        const pending = nativeGetPendingSessionId();
        await syncFromNativeStatus(pending ? `finished:${pending}` : nativeGetStatus());
      } catch {
        // 起動時取り込みはダイアログ内で例外を表示する・ここでは握らないため再throwしない（sync内で処理済み）
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 機能C: AppState復帰時も同チェック（タイマー自動停止はJSをトリガーにしないため）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void syncFromNativeStatus(nativeGetStatus());
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ショートカット開始（minutes指定=タイマー自動停止・省略=夜寝） */
  const handleShortcutStart = (minutes?: number) => {
    if (busy || recording) return;
    // MLR r2 GLM#3: ネイティブ起動失敗（error:no_context 等）時にUIだけ計測中表示になるのを防ぐ
    const result = nativeStartRecording(minutes);
    if (result.startsWith('error:')) {
      setDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
      return;
    }
    setRecording(true);
  };

  const handleToggleRecording = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!recording) {
        const result = nativeStartRecording();
        if (result.startsWith('error:')) {
          setDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
          return;
        }
        setRecording(true);
      } else {
        nativeStopRecording();
        setRecording(false);
        const stopped = await waitForServiceStop();
        if (!stopped) {
          // MLR 2026-11-03 GLM#5: タイムアウト時は recording 中系列の誤取り込みを避ける
          //（AppState 復帰時の finished 検知に取り込みを委ねる）
          setDialog({
            title: '計測の停止を確認できませんでした',
            message: '少し待ってから画面を開き直してください。取り込みは自動で行われます。',
            tone: 'warn',
          });
          return;
        }
        const res = await importSensorSession(createNativeSensorSource());
        await refreshSessions();
        if (res.verdict === 'fail') {
          setDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
        } else if (res.verdict === 'degraded_pass') {
          setDialog({ title: '計測を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
        } else {
          setDialog({ title: '計測を取り込みました', message: '一覧に表示されています', tone: 'ok' });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>Nemly</Text>
        <Text style={styles.today}>{formatToday()}</Text>
        {loaded && sessions.length === 0 && (
          <Text style={styles.emptyText}>
            記録がありません。{'\n'}「計測を開始」でセンサー計測、{'\n'}「インポート」でCSVデータを取り込めます。
          </Text>
        )}
        <Pressable
          style={[styles.recordButton, recording && styles.recordButtonActive]}
          onPress={handleToggleRecording}
          disabled={busy}
          testID="record-toggle"
        >
          <View style={styles.recordHeader}>
            <View style={[styles.pulseDot, recording && styles.pulseDotActive]} />
            <Text style={styles.recordTitle}>
              {busy ? '処理中…' : recording ? '計測を停止' : '睡眠計測'}
            </Text>
          </View>
          <Text style={styles.recordAction}>
            {busy ? '' : recording ? '■ 停止' : '▶ 開始'}
          </Text>
          {recording && <Text style={styles.recordingHint}>画面を閉じても計測は続きます</Text>}
        </Pressable>
        {!recording && (
          <View style={styles.shortcutRow} testID="shortcut-row">
            {NAP_MINUTES.map((min) => (
              <Pressable
                key={min}
                style={styles.shortcutChip}
                onPress={() => handleShortcutStart(min)}
                disabled={busy}
                testID={`nap-${min}`}
              >
                <Text style={styles.shortcutText}>昼寝{min}分</Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.shortcutChip}
              onPress={() => handleShortcutStart()}
              disabled={busy}
              testID="start-night"
            >
              <Text style={styles.shortcutText}>夜寝</Text>
            </Pressable>
          </View>
        )}
        <FlatList
          data={sessions}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <SessionCard
              session={item}
              onPress={(id) => router.push(`/session/${id}`)}
            />
          )}
        />
        <View style={styles.bottomButtons}>
          <Pressable
            style={styles.importButton}
            onPress={() => router.push('/import')}
            testID="import-button"
          >
            <Text style={styles.importButtonText}>CSVインポート</Text>
          </Pressable>
          <Pressable
            style={styles.importButton}
            onPress={() => router.push('/stats')}
            testID="stats-button"
          >
            <Text style={styles.importButtonText}>統計</Text>
          </Pressable>
        </View>
        <ResultDialog
          visible={dialog !== null}
          title={dialog?.title ?? ''}
          message={dialog?.message ?? ''}
          tone={dialog?.tone ?? 'ok'}
          onClose={() => setDialog(null)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.bg },
  container: { flex: 1, padding: theme.spacing.card },
  title: {
    ...theme.typography.title,
    color: theme.colors.text,
  },
  today: {
    ...theme.typography.sub,
    color: theme.colors.textSub,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.md,
  },
  emptyText: {
    ...theme.typography.body,
    color: theme.colors.textSub,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  },
  recordButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
  },
  recordButtonActive: {
    borderColor: theme.colors.accent,
    borderWidth: 2,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  pulseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.textSub,
  },
  pulseDotActive: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.accent,
  },
  recordTitle: {
    ...theme.typography.section,
    color: theme.colors.text,
  },
  recordAction: {
    fontSize: 30,
    fontWeight: '700',
    color: theme.colors.accent,
    marginTop: theme.spacing.sm,
  },
  recordingHint: {
    ...theme.typography.sub,
    color: theme.colors.textSub,
    marginTop: theme.spacing.sm,
  },
  shortcutRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  shortcutChip: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  },
  shortcutText: {
    ...theme.typography.sub,
    color: theme.colors.accent,
  },
  bottomButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  importButton: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    alignItems: 'center',
  },
  importButtonText: {
    ...theme.typography.section,
    color: theme.colors.accent,
  },
});
