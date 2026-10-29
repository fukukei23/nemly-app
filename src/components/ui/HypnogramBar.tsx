import React from "react";
import { StyleSheet, View } from "react-native";

import type { SleepStageRow } from "@/lib/repository";
import { theme } from "@/constants/theme";

/** ヒプノグラム横バー（phase色分け・時系列・高さはheightで指定） */
export function HypnogramBar({ stages, height = 36 }: { stages: SleepStageRow[]; height?: number }) {
  return (
    <View style={styles.row}>
      {stages.map((stage) => (
        <View
          key={stage.tsMs}
          style={{ flex: 1, backgroundColor: theme.colors.phase[stage.phase], height }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    overflow: "hidden",
    borderRadius: theme.radius.chip,
  },
});
