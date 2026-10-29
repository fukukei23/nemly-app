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
import { ScoreGauge } from '@/components/ui/ScoreGauge';
import { HypnogramBar } from '@/components/ui/HypnogramBar';
import { theme } from '@/constants/theme';

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

function RatioRow({ phase, ratio }: { phase: StagePhase; ratio: number }) {
  return (
    <View style={styles.ratioRow}>
      <View style={[styles.ratioSwatch, { backgroundColor: theme.colors.phase[phase] }]} />
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
        <View style={styles.scoreRow}>
          <ScoreGauge score={session.score} />
          <View style={styles.scoreMeta}>
            <Text style={styles.scoreLabel}>スコア</Text>
            <Text style={styles.durationText}>
              {formatClock(session.startMs)} 〜 {formatClock(session.endMs)}
            </Text>
            <Text style={styles.durationText}>{h}時間{m}分</Text>
          </View>
        </View>

        {session.source === 'sensor' && (
          <Text style={styles.sensorMetaText}>
            計測: {session.endReason === 'user_stop' ? '手動停止' : (session.endReason ?? '—')}
            {'\n'}有効率: {session.validRatio != null ? `${Math.round(session.validRatio * 100)}%` : '—'}
            {'\n'}欠損区間: {session.gapCount ?? 0}件
          </Text>
        )}

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
  safeArea: { flex: 1, backgroundColor: theme.colors.bg },
  container: { flex: 1, padding: theme.spacing.lg },
  loading: { textAlign: 'center', marginTop: 48, color: theme.colors.textSub },
  dateText: { ...theme.typography.sub, color: theme.colors.textSub },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.card,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  scoreMeta: { flex: 1 },
  scoreLabel: { ...theme.typography.sub, color: theme.colors.textSub, marginBottom: 4 },
  durationText: { ...theme.typography.body, color: theme.colors.text },
  sensorMetaText: { ...theme.typography.sub, color: theme.colors.textSub, marginBottom: theme.spacing.card, lineHeight: 20 },
  sectionTitle: { ...theme.typography.section, color: theme.colors.text, marginBottom: theme.spacing.sm, marginTop: theme.spacing.sm },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeText: { ...theme.typography.sub, color: theme.colors.textSub },
  ratioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  ratioSwatch: { width: 12, height: 12, borderRadius: 3, marginRight: theme.spacing.sm },
  ratioLabel: { flex: 1, fontSize: 14, color: theme.colors.text },
  ratioValue: { fontSize: 14, fontWeight: '600', color: theme.colors.text },
});
