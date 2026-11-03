import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { theme } from "@/constants/theme";

/** 3指標の小円ゲージ（accent 輪・中央に値・下にラベル） */
export function MetricGauge({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.gauge}>
        <Text style={styles.value}>{value}</Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  gauge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  value: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.text,
  },
  label: {
    ...theme.typography.sub,
    color: theme.colors.textSub,
    marginTop: theme.spacing.xs,
  },
});
