import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';

import { parseActivityTxt, analyzeSleep } from '@/lib/csvImport';
import { insertSession } from '@/lib/repository';
import { initializeSqliteRepositoryAsync } from '@/lib/sqliteRepository';
import { theme } from '@/constants/theme';

export default function ImportScreen() {
  const [busy, setBusy] = useState(false);

  const pickAndImport = async () => {
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'text/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      if (!file) return;
      await initializeSqliteRepositoryAsync();
      const content = await new File(file.uri).text();
      const samples = parseActivityTxt(content);
      if (samples.length === 0) {
        Alert.alert('読み込み失敗', '有効なサンプル行がありません（5列形式・ts,_,amp,... を確認してください）');
        return;
      }
      const analysis = analyzeSleep(samples);
      await insertSession(
        {
          startMs: analysis.startMs,
          endMs: analysis.endMs,
          sampleCount: analysis.sampleCount,
          deepRatio: analysis.deepRatio,
          lightRatio: analysis.lightRatio,
          remRatio: analysis.remRatio,
          awakeRatio: analysis.awakeRatio,
          score: analysis.score,
          source: 'activity_txt',
          createdAt: new Date().toISOString(),
        },
        analysis.stages,
      );
      Alert.alert(
        'インポート完了',
        `${samples.length} サンプルを判定しました（スコア ${analysis.score ?? '—'}）`,
        [{ text: 'OK', onPress: () => router.replace('/') }],
      );
    } catch (err) {
      Alert.alert('エラー', String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.heading}>睡眠データのインポート</Text>
        <Text style={styles.body}>
          Sleep as Android のアクティグラフ（Activity_*.txt・5列形式）を選択して{'\n'}
          睡眠スコアとヒプノグラムを生成します。
        </Text>
        <Text style={styles.note}>
          対応形式: ヘッダなし・カンマ区切り5列・10秒粒度{'\n'}
          （列1=タイムスタンプ・列3=活動振幅）
        </Text>
        {busy ? (
          <ActivityIndicator size="large" style={styles.spinner} />
        ) : (
          <Text style={styles.pickButton} onPress={pickAndImport} testID="pick-file-button">
            ファイルを選択
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.bg },
  container: { flex: 1, padding: theme.spacing.lg },
  heading: { ...theme.typography.section, fontSize: 20, color: theme.colors.text, marginBottom: theme.spacing.md },
  body: { fontSize: 15, color: theme.colors.text, lineHeight: 24 },
  note: { ...theme.typography.sub, color: theme.colors.textSub, marginTop: theme.spacing.md, lineHeight: 20 },
  pickButton: {
    marginTop: 32,
    backgroundColor: theme.colors.surface,
    color: theme.colors.accent,
    fontWeight: '600',
    fontSize: 16,
    textAlign: 'center',
    padding: theme.spacing.card,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    overflow: 'hidden',
  },
  spinner: { marginTop: 32 },
});
