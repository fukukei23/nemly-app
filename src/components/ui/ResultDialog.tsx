import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/constants/theme";

export type ResultTone = "fail" | "warn" | "ok";

/** 計測結果ダイアログ（深夜パレット統一・標準Alertの配色制御不可を置換） */
export function ResultDialog({
  visible,
  title,
  message,
  tone,
  onClose,
}: {
  visible: boolean;
  title: string;
  message: string;
  tone: ResultTone;
  onClose: () => void;
}) {
  if (!visible) return null;
  const toneColor = tone === "ok" ? theme.colors.accent : theme.colors.phase.AWAKE;
  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={[styles.accentBar, { backgroundColor: toneColor }]} />
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <Pressable style={styles.okButton} onPress={onClose} testID="result-dialog-ok">
            <Text style={styles.okText}>OK</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 20, 32, 0.8)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.card,
    width: "100%",
    maxWidth: 360,
  },
  accentBar: {
    height: 4,
    borderRadius: theme.radius.chip,
    marginBottom: theme.spacing.md,
  },
  title: {
    ...theme.typography.section,
    color: theme.colors.text,
  },
  message: {
    ...theme.typography.body,
    color: theme.colors.text,
    marginTop: theme.spacing.sm,
  },
  okButton: {
    backgroundColor: theme.colors.bg,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    alignItems: "center",
    padding: theme.spacing.md,
    marginTop: theme.spacing.lg,
  },
  okText: {
    ...theme.typography.section,
    color: theme.colors.accent,
  },
});
