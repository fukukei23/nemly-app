import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { listSessions } from '@/lib/repository';
import { formatSleepDuration } from '@/lib/metrics';
import { summarizeSessions, type StatsPeriod, type StatsSummary } from '@/lib/stats';
import { initializeSqliteRepositoryAsync } from '@/lib/sqliteRepository';
import { theme } from '@/constants/theme';

const BAR_MAX_HEIGHT = 96;

/** 日別スコアの簡易棒グラフ（ライブラリ不使用・score null の日は欠損線） */
function ScoreBars({ summary }: { summary: StatsSummary }) {
  return (
    <View style={styles.barsRow} testID="score-bars">
      {summary.dailyScores.map((d, i) => (
        <View key={`${d.day}-${i}`} style={styles.barSlot}>
          <View
            style={[
              styles.bar,
              d.score == null
                ? styles.barMissing
                : { height: Math.max(8, (d.score / 100) * BAR_MAX_HEIGHT) },
            ]}
          />
        </View>
      ))}
    </View>
  );
}

export default function StatsScreen() {
  const [period, setPeriod] = useState<StatsPeriod>('week');
  const [summary, setSummary] = useState<StatsSummary | null>(null);

  useEffect(() => {
    (async () => {
      await initializeSqliteRepositoryAsync();
      const sessions = await listSessions();
      setSummary(summarizeSessions(sessions, period, Date.now()));
    })();
  }, [period]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>統計</Text>

        <View style={styles.periodRow}>
          <Pressable
            style={[styles.periodButton, period === 'week' && styles.periodButtonActive]}
            onPress={() => setPeriod('week')}
            testID="period-week"
          >
            <Text style={[styles.periodText, period === 'week' && styles.periodTextActive]}>
              週
            </Text>
          </Pressable>
          <Pressable
            style={[styles.periodButton, period === 'month' && styles.periodButtonActive]}
            onPress={() => setPeriod('month')}
            testID="period-month"
          >
            <Text style={[styles.periodText, period === 'month' && styles.periodTextActive]}>
              月
            </Text>
          </Pressable>
        </View>

        {summary && (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryValue}>{summary.count}</Text>
                <Text style={styles.summaryLabel}>記録数</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryValue}>{summary.avgScore ?? '--'}</Text>
                <Text style={styles.summaryLabel}>平均スコア</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryValue}>
                  {summary.avgDurationMinutes == null
                    ? '--'
                    : formatSleepDuration(summary.avgDurationMinutes)}
                </Text>
                <Text style={styles.summaryLabel}>平均睡眠時間</Text>
              </View>
            </View>

            <Text style={styles.sectionTitle}>日別スコア</Text>
            <ScoreBars summary={summary} />
          </>
        )}

        <Pressable style={styles.backButton} onPress={() => router.back()} testID="stats-back">
          <Text style={styles.backText}>戻る</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.bg },
  container: { padding: theme.spacing.lg },
  title: {
    ...theme.typography.title,
    color: theme.colors.text,
    marginBottom: theme.spacing.md,
  },
  periodRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  periodButton: {
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: 'transparent',
  },
  periodButtonActive: { backgroundColor: theme.colors.accent },
  periodText: { ...theme.typography.section, color: theme.colors.accent },
  periodTextActive: { color: theme.colors.text },
  summaryCard: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    marginBottom: theme.spacing.md,
  },
  summaryItem: { alignItems: 'center' },
  summaryValue: { fontSize: 24, fontWeight: '700', color: theme.colors.text },
  summaryLabel: { ...theme.typography.sub, color: theme.colors.textSub, marginTop: theme.spacing.xs },
  sectionTitle: {
    ...theme.typography.section,
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: BAR_MAX_HEIGHT + 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.lg,
  },
  barSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' },
  bar: {
    width: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
  barMissing: { height: 2, backgroundColor: theme.colors.textSub },
  backButton: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    padding: theme.spacing.card,
    alignItems: 'center',
  },
  backText: { ...theme.typography.section, color: theme.colors.accent },
});
