/** 深夜パレット — 色は本ファイルで一元管理（spec: docs/superpowers/specs/2026-10-30-nemly-uiux-design.md） */
export const theme = {
  colors: {
    bg: "#0F1420",
    surface: "#1A2233",
    text: "#E8ECF4",
    textSub: "#8A94AC",
    accent: "#7C6FF0",
    gold: "#F0D080",
    phase: {
      DEEP: "#3B4FA0",
      LIGHT: "#4A5A78",
      REM: "#8B5FC7",
      AWAKE: "#E08A4A",
      BROKEN: "#6B7280",
    },
  },
  typography: {
    title: { fontSize: 26, fontWeight: "700" },
    section: { fontSize: 18, fontWeight: "700" },
    body: { fontSize: 16 },
    sub: { fontSize: 13 },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    card: 16,
    lg: 24,
  },
  radius: {
    chip: 11,
    card: 12,
    gauge: 24,
  },
} as const;
