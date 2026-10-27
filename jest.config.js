module.exports = {
  preset: "jest-expo",
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))",
  ],
  setupFiles: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}"],
  collectCoverageFrom: [
    "src/lib/**/*.ts",
    "src/types/**/*.ts",
    "!src/**/__tests__/**",
  ],
  moduleNameMapper: {
    "^react-native/setup-env$": "<rootDir>/jest.setup.js",
  },
};

