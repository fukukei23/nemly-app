import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';

import {
  listSessions,
  getSessionStages,
  type SessionRecord,
  type SleepStageRow,
  type StagePhase,
} from '@/lib/repository';

const PHASE_COLORS: Record<StagePhase, string> = {
  DEEP: '#4f46e5',
  LIGHT: '#38bdf8',
  REM: '#f59e0b',
  AWAKE: '#f43f5e',
  BROKEN: '#cbd5e1',
};

const PHASE_LABELS: Record<StagePhase, string> = {
  DEEP: '深い睡眠',
  LIGHT: '浅い睡眠',
  REM: 'レム',
  AWAKE: '覚醒',
  BROKEN: '判定不能',
};

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function HypnogramBar({ stages }: { stages: SleepStageRow[] }) {
  return (
    <View style={styles.hypnogramRow}>
      {stages.map((stage) => (
        <View
          key={stage.tsMs}
          style={{ flex: 1, backgroundColor: PHASE_COLORS[stage.phase], height: 36 }}
        />
      ))}
    </View>
  );
}

function RatioRow({ phase, ratio }: { phase: StagePhase; ratio: number }) {
  return (
    <View style={styles.ratioRow}>
      <View style={[styles.ratioSwatch, { backgroundColor: PHASE_COLORS[phase] }]} />
      <Text style={styles.ratioLabel}>{PHASE_LABELS[phase]}</Text>
      <Text style={styles.ratioValue}>{Math.round(ratio * 100)}%</Text>
    </View>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [stages, setStages] = useState<SleepStageRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!id) return;
    const sessionId = Number(id);
    (async () => {
      const sessions = await listSessions();
      const found = sessions.find((s) => s.id === sessionId) ?? null;
      setSession(found);
      setStages(await getSessionStages(sessionId));
      setLoaded(true);
    })();
  }, [id]);

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Text style={styles.loading}>読み込み中…</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Text style={styles.loading}>セッションが見つかりません</Text>
      </SafeAreaView>
    );
  }

  const minutes = Math.round((session.endMs - session.startMs) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.dateText}>
          {new Date(session.startMs).toLocaleDateString('ja-JP')}
        </Text>
        <Text style={styles.scoreText}>{session.score ?? '—'}</Text>
        <Text style={styles.scoreLabel}>スコア</Text>
        <Text style={styles.durationText}>
          {formatClock(session.startMs)} 〜 {formatClock(session.endMs)}（{h}時間{m}分）
        </Text>

        <Text style={styles.sectionTitle}>ヒプノグラム</Text>
        <HypnogramBar stages={stages} />
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>{formatClock(session.startMs)}</Text>
          <Text style={styles.timeText}>{formatClock(session.endMs)}</Text>
        </View>

        <Text style={styles.sectionTitle}>内訳</Text>
        <RatioRow phase="DEEP" ratio={session.deepRatio} />
        <RatioRow phase="LIGHT" ratio={session.lightRatio} />
        <RatioRow phase="REM" ratio={session.remRatio} />
        <RatioRow phase="AWAKE" ratio={session.awakeRatio} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8fafc' },
  container: { flex: 1, padding: 24 },
  loading: { textAlign: 'center', marginTop: 48, color: '#64748b' },
  dateText: { fontSize: 16, color: '#64748b' },
  scoreText: { fontSize: 56, fontWeight: '700', color: '#4f46e5', marginTop: 8 },
  scoreLabel: { fontSize: 13, color: '#94a3b8', marginBottom: 12 },
  durationText: { fontSize: 15, color: '#334155', marginBottom: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#0f172a', marginBottom: 8, marginTop: 8 },
  hypnogramRow: {
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeText: { fontSize: 12, color: '#94a3b8' },
  ratioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  ratioSwatch: { width: 12, height: 12, borderRadius: 3, marginRight: 8 },
  ratioLabel: { flex: 1, fontSize: 14, color: '#334155' },
  ratioValue: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
});
