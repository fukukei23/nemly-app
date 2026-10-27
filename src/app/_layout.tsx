import { DarkTheme, DefaultTheme, ThemeProvider, Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Nemly' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'セッション詳細' }} />
        <Stack.Screen name="import" options={{ title: 'CSVインポート' }} />
      </Stack>
    </ThemeProvider>
  );
}
