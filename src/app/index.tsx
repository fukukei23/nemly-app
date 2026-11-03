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
  nativeAcquireLease,
  nativeGetLastSessionId,
  nativeGetPendingSessionId,
  nativeGetStatus,
  nativeStartRecording,
  nativeStopRecording,
  nativeReleaseLease,
  nativeIsImporting,
} from '@/lib/sensor/nativeSource';
import { waitForServiceStop } from '@/lib/sensor/waitForStop';
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

function formatToday(): string {
  const d = new Date();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${weekdays[d.getDay()]}`;
}

/** 回収1件10秒タイムアウト（設計書 §4） */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

export default function SessionListScreen() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 設計書 §4: idle=処理なし / stopping=停止後の取り込み / recovering=起動時・復帰時の回収 */
  const [importPhase, setImportPhase] = useState<'idle' | 'stopping' | 'recovering'>('idle');
  const [dialog, setDialog] = useState<ResultDialogState>(null);
  /** 自動取り込み済みのネイティブセッションID（AppState復帰時の二重取り込み防止） */
  const lastImportedRef = useRef('');
  /**
   * MLR指摘（GLM#7・GLM#2）: fire-and-forget 完了後の setState 喪失防止と二重起動ガード。
   * state は再render後しか反映されないため同時実行判定は ref を正にする。
   */
  const importPhaseRef = useRef<'idle' | 'stopping' | 'recovering'>('idle');
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const setPhase = (p: 'idle' | 'stopping' | 'recovering') => {
    importPhaseRef.current = p;
    if (mountedRef.current) setImportPhase(p);
  };
  const safeSetDialog = (d: ResultDialogState) => {
    if (mountedRef.current) setDialog(d);
  };

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
    if (busy || importPhaseRef.current !== 'idle') return;
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
    setPhase('recovering');
    const leaseToken = nativeAcquireLease();
    let timedOut = false;
    try {
      const res = await withTimeout(importSensorSession(createNativeSensorSource()), 10_000);
      await refreshSessions();
      // MLR 2026-11-03 GLM#2: 取り込み成功後のみガード設定（例外時の再試行永久ブロック防止）
      lastImportedRef.current = sid;
      if (res.sessionId === null && res.verdict === 'pass') {
        // 空系列（既に取り込み済みの pending 掃除）はダイアログを出さない
        return;
      }
      if (res.verdict === 'fail') {
        safeSetDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
      } else if (res.verdict === 'degraded_pass') {
        safeSetDialog({ title: '昼寝を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
      } else {
        safeSetDialog({ title: '昼寝を取り込みました', message: '一覧に表示されています', tone: 'ok' });
      }
    } catch (e) {
      // MLR指摘（GLM#3・MiniMax#7）: withTimeout は裏の import を止められないため、
      // タイムアウト時は lease を解放せず30秒自然期限に委ねる（解放すると裏の import が裸になる）
      timedOut = e instanceof Error && e.message.startsWith('timeout');
      lastImportedRef.current = '';
      safeSetDialog({
        title: '取り込みに失敗しました',
        message: `${e instanceof Error ? e.message : String(e)}\n次回アプリ起動時に自動回収します。`,
        tone: 'fail',
      });
    } finally {
      if (!timedOut) nativeReleaseLease(leaseToken);
      setPhase('idle');
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
    if (result === 'error:importing') {
      // 設計書 §4: importing 中の開始は native lease ガードが拒否する
      safeSetDialog({
        title: '取り込み中です',
        message: '前回の計測を取り込み中のため開始できません。終わるまでお待ちください。',
        tone: 'warn',
      });
      return;
    }
    if (result.startsWith('error:')) {
      safeSetDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
      return;
    }
    setRecording(true);
  };

  /** 停止後の取り込みを裏で走らせる（設計書 §4・fire-and-forget・UI は即復帰する） */
  const runStopImport = async (sid: string) => {
    // MLR指摘（MiniMax#11・OR1#7）: 二重起動ガード（state は非同期のため ref で判定）
    if (importPhaseRef.current !== 'idle') return;
    setPhase('stopping');
    // MLR指摘（GLM#2・MiniMax#1）: waitForServiceStop の前から lease を取得する
    //（取得までのウィンドウで start が通ると sessionId 逆転取り込みが起きる）
    const leaseToken = nativeAcquireLease();
    try {
      const ok = await waitForServiceStop(sid, () => nativeGetStatus());
      if (!ok) {
        const st = parseNativeStatus(nativeGetStatus());
        if (st === `failed:${sid}`) {
          // MLR指摘（MiniMax#10 対応）: ネイティブ側の failed:<sid> は回収対象外のため明示エラーで確定的に表示する
          safeSetDialog({
            title: '計測の取り込みに失敗しました',
            message: '停止処理でエラーが発生しました（セッションが取り込み済みになっていません）。',
            tone: 'fail',
          });
          return;
        }
        // GLM#5 対応を維持: タイムアウト時は recording 中系列の誤取り込みを避ける
        //（AppState 復帰時の finished 検知に取り込みを委ねる）
        safeSetDialog({
          title: '計測の停止を確認できませんでした',
          message: '少し待ってから画面を開き直してください。取り込みは自動で行われます。',
          tone: 'warn',
        });
        return;
      }
      try {
        const res = await importSensorSession(createNativeSensorSource());
        await refreshSessions();
        lastImportedRef.current = sid;
        if (res.verdict === 'fail') {
          safeSetDialog({ title: '計測の判定: fail', message: res.reasons.join('\n'), tone: 'fail' });
        } else if (res.verdict === 'degraded_pass') {
          safeSetDialog({ title: '計測を取り込みました（条件付き許容）', message: res.reasons.join('\n'), tone: 'warn' });
        } else {
          safeSetDialog({ title: '計測を取り込みました', message: '一覧に表示されています', tone: 'ok' });
        }
      } catch (e) {
        // 設計書 §4: 失敗ダイアログは fail と区別して「次回起動時に自動回収」を案内する
        safeSetDialog({
          title: '取り込みに失敗しました',
          message: `${e instanceof Error ? e.message : String(e)}\n次回アプリ起動時に自動回収します。`,
          tone: 'fail',
        });
      }
    } finally {
      // import は await 完了 or 例外済みのため解放は安全（裏継続は withTimeout 経路=recovering のみ）
      nativeReleaseLease(leaseToken);
      setPhase('idle');
    }
  };

  const handleToggleRecording = async () => {
    if (recording) {
      // 設計書 §4: stopRecording は importing 中でも許可（start のみ拒否）
      const sid = parseNativeStatus(nativeGetStatus()).replace('recording:', '') || nativeGetLastSessionId();
      if (!sid) {
        // MLR指摘（MiniMax#5・OR1#5）: 対象 sid が不明なら停止のみして回収に委譲
        //（不正な sid で import を試みて15秒待つより安全）
        nativeStopRecording();
        setRecording(false);
        safeSetDialog({
          title: '計測を停止しました',
          message: '停止対象の計測IDが確認できなかったため、取り込みは次回アプリ起動時に自動回収します。',
          tone: 'warn',
        });
        return;
      }
      nativeStopRecording();
      setRecording(false);
      void runStopImport(sid);
      return;
    }
    // MLR指摘（GLM#2）: 開始パスにも importPhase ガードを追加（stopping/recovering 中の開始をブロック）
    if (busy || importPhaseRef.current !== 'idle' || nativeIsImporting()) return;
    setBusy(true);
    try {
      const result = nativeStartRecording();
      if (result === 'error:importing') {
        safeSetDialog({
          title: '取り込み中です',
          message: '前回の計測を取り込み中のため開始できません。終わるまでお待ちください。',
          tone: 'warn',
        });
        return;
      }
      if (result.startsWith('error:')) {
        safeSetDialog({ title: '計測を開始できませんでした', message: result, tone: 'fail' });
        return;
      }
      setRecording(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>Nemly</Text>
        <Text style={styles.today}>{formatToday()}</Text>
        {importPhase !== 'idle' && (
          <View style={styles.importingRow} testID="importing-row">
            <Text style={styles.importingText}>
              {importPhase === 'stopping' ? '取り込み中…' : '前回の計測を取り込み中'}
            </Text>
          </View>
        )}
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
  importingRow: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  importingText: {
    ...theme.typography.sub,
    color: theme.colors.accent,
    textAlign: 'center',
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
