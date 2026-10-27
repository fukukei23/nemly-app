const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Node "crypto" は migration/sqliteAdapter.ts の FakeAdapter（jest 専用）で
// require されるが、本番（RN）は ExpoSqliteAdapter が expo-crypto を使用する。
// release バンドル時に Metro が静的解決して失敗するため、空モジュールへ差し替える
// （nemly-app release ビルド実測・2026-10-27・jest は Metro を経由しないため影響なし）。
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto') {
    return { type: 'empty' };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
