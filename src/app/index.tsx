import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { listSessions, type SessionRecord } from '@/lib/repository';
import { initializeSqliteRepositoryAsync } from '@/lib/sqliteRepository';

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

export default function SessionListScreen() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      await initializeSqliteRepositoryAsync();
      const rows = await listSessions();
      setSessions(rows);
      setLoaded(true);
    })();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {loaded && sessions.length === 0 && (
          <Text style={styles.emptyText}>
            記録がありません。{'\n'}右上の「インポート」から睡眠データを取り込めます。
          </Text>
        )}
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
});
