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

function formatDay(startMs: number): string {
  const d = new Date(startMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDuration(startMs: number, endMs: number): string {
  const minutes = Math.round((endMs - startMs) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}時間${m}分`;
}

/** FGS の終了書込完了を待つ（finished: 接頭辞 or 15秒タイムアウト） */
async function waitForServiceStop(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (nativeGetStatus().startsWith('finished:')) return true;
  }
  return false;
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
          <Text style={styles.recordButtonText}>
            {busy ? '処理中…' : recording ? '計測を停止' : '計測を開始'}
          </Text>
          {recording && <Text style={styles.recordingHint}>画面を閉じても計測は続きます</Text>}
        </Pressable>
        <FlatList
          data={sessions}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => router.push(`/session/${item.id}`)}
            >
              <View style={styles.cardLeft}>
                <Text style={styles.dateText}>{formatDay(item.startMs)}</Text>
                <Text style={styles.durationText}>
                  {formatDuration(item.startMs, item.endMs)}
                </Text>
              </View>
              <Text style={styles.scoreText}>{item.score ?? '—'}</Text>
            </Pressable>
          )}
        />
        <Pressable
          style={styles.importButton}
          onPress={() => router.push('/import')}
          testID="import-button"
        >
          <Text style={styles.importButtonText}>インポート</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8fafc' },
  container: { flex: 1, padding: 16 },
  emptyText: {
    textAlign: 'center',
    color: '#64748b',
    marginTop: 48,
    lineHeight: 22,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  cardLeft: { flex: 1 },
  dateText: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  durationText: { fontSize: 13, color: '#64748b', marginTop: 4 },
  scoreText: { fontSize: 24, fontWeight: '700', color: '#4f46e5' },
  importButton: {
    backgroundColor: '#4f46e5',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  importButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 16 },
  recordButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  recordButtonActive: { backgroundColor: '#f43f5e' },
  recordButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  recordingHint: { color: '#ffffff', fontSize: 12, marginTop: 4 },
});
