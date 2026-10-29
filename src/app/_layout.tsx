import { DarkTheme, ThemeProvider, Stack } from 'expo-router';

import { theme } from '@/constants/theme';

/** 深夜パレット固定（睡眠時間帯使用想定・spec: docs/superpowers/specs/2026-10-30-nemly-uiux-design.md） */
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.colors.bg,
    card: theme.colors.surface,
    text: theme.colors.text,
    primary: theme.colors.accent,
    border: '#2A3350',
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          contentStyle: { backgroundColor: theme.colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Nemly' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'セッション詳細' }} />
        <Stack.Screen name="import" options={{ title: 'CSVインポート' }} />
      </Stack>
    </ThemeProvider>
  );
}
