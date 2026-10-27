// Jest setup — Expo SDK 57 / React 19.2 / RN 0.86 互換
jest.mock("expo-router", () => ({
  Tabs: ({ children }) => children,
  Stack: ({ children }) => children,
  Link: () => null,
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

// expo-crypto はネイティブモジュールのため jest 環境で動かない。
// digestStringAsync を Node crypto の SHA-256 hex（本物と同一値）で置換。
jest.mock("expo-crypto", () => {
  const nodeCrypto = require("crypto");
  const sha256hex = (s) =>
    nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
  return {
    CryptoDigestAlgorithm: { SHA256: "SHA-256", SHA512: "SHA-512", SHA1: "SHA-1", MD5: "MD5" },
    CryptoEncoding: { HEX: "hex", BASE64: "base64" },
    digestStringAsync: jest.fn(async (_algorithm, data) => sha256hex(data)),
  };
});
