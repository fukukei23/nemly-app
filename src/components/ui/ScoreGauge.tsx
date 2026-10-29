import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { theme } from "@/constants/theme";

/** スコア円形ゲージ（ゴールド輪・中央に数字） */
export function ScoreGauge({ score }: { score: number | null }) {
  return (
    <View style={styles.gauge}>
      <Text style={styles.score}>{score ?? "--"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gauge: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 6,
    borderColor: theme.colors.gold,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  score: {
    fontSize: 40,
    fontWeight: "700",
    color: theme.colors.gold,
  },
});
