import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { listSessions, type SessionRecord } from '@/lib/repository';
import { initializeSqliteRepositoryAsync } from '@/lib/sqliteRepository';
import { importSensorSession } from '@/lib/sensor/sensorImport';
import {
  createNativeSensorSource,
  nativeGetStatus,
  nativeStartRecording,
  nativeStopRecording,
} from '@/lib/sensor/nativeSource';
import { SessionCard } from '@/components/ui/SessionCard';
import { theme } from '@/constants/theme';

/** FGS の終了書込完了を待つ（finished: 接頭辞 or 15秒タイムアウト） */
async function waitForServiceStop(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (nativeGetStatus().startsWith('finished:')) return true;
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

  const refreshSessions = async () => {
    const rows = await listSessions();
    setSessions(rows);
    setLoaded(true);
  };

  useEffect(() => {
    (async () => {
      await initializeSqliteRepositoryAsync();
      await refreshSessions();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleRecording = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!recording) {
        nativeStartRecording();
        setRecording(true);
      } else {
        nativeStopRecording();
        setRecording(false);
        await waitForServiceStop();
        const res = await importSensorSession(createNativeSensorSource());
        await refreshSessions();
        if (res.verdict === 'fail') {
          Alert.alert('計測の判定: fail', res.reasons.join('\n'));
        } else if (res.verdict === 'degraded_pass') {
          Alert.alert('計測を取り込みました（条件付き許容）', res.reasons.join('\n'));
        } else {
          Alert.alert('計測を取り込みました', '一覧に表示されています');
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
        <Pressable
          style={styles.importButton}
          onPress={() => router.push('/import')}
          testID="import-button"
        >
          <Text style={styles.importButtonText}>CSVインポート</Text>
        </Pressable>
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
  importButton: {
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
