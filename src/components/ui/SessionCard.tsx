import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SessionRecord } from "@/lib/repository";
import { theme } from "@/constants/theme";

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDuration(startMs: number, endMs: number): string {
  const minutes = Math.round((endMs - startMs) / 60000);
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** セッション一覧カード（日付・時間・スコア・比率バー） */
export function SessionCard({ session, onPress }: { session: SessionRecord; onPress: (id: number) => void }) {
  return (
    <Pressable style={styles.card} onPress={() => onPress(session.id ?? 0)}>
      <View style={styles.header}>
        <Text style={styles.day}>{formatDay(session.startMs)}</Text>
        <Text style={styles.score}>{session.score ?? "--"}</Text>
      </View>
      <Text style={styles.duration}>{formatDuration(session.startMs, session.endMs)}</Text>
      <View style={styles.bar}>
        <View style={[styles.seg, { flex: session.deepRatio, backgroundColor: theme.colors.phase.DEEP }]} />
        <View style={[styles.seg, { flex: session.remRatio, backgroundColor: theme.colors.phase.REM }]} />
        <View style={[styles.seg, { flex: session.awakeRatio, backgroundColor: theme.colors.phase.AWAKE }]} />
        <View style={[styles.seg, { flex: session.lightRatio, backgroundColor: theme.colors.phase.LIGHT }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    marginBottom: theme.spacing.md,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  day: { fontSize: 13, color: theme.colors.textSub },
  score: { fontSize: 40, fontWeight: "700", color: theme.colors.gold },
  duration: { fontSize: 16, color: theme.colors.text, marginTop: 4 },
  bar: {
    flexDirection: "row",
    height: 14,
    marginTop: 12,
    borderRadius: theme.radius.chip,
    overflow: "hidden",
  },
  seg: { height: 14 },
});
