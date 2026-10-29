import { theme } from "../theme";

describe("theme", () => {
  it("深夜パレットの基調色が定義されている", () => {
    expect(theme.colors.bg).toBe("#0F1420");
    expect(theme.colors.surface).toBe("#1A2233");
    expect(theme.colors.text).toBe("#E8ECF4");
    expect(theme.colors.textSub).toBe("#8A94AC");
    expect(theme.colors.accent).toBe("#7C6FF0");
    expect(theme.colors.gold).toBe("#F0D080");
  });

  it("睡眠段階の4色+BROKENが定義されている", () => {
    expect(theme.colors.phase).toEqual({
      DEEP: "#3B4FA0",
      LIGHT: "#4A5A78",
      REM: "#8B5FC7",
      AWAKE: "#E08A4A",
      BROKEN: "#6B7280",
    });
  });

  it("すべての色は有効なhex形式", () => {
    const flat = [
      theme.colors.bg,
      theme.colors.surface,
      theme.colors.text,
      theme.colors.textSub,
      theme.colors.accent,
      theme.colors.gold,
      ...Object.values(theme.colors.phase),
    ];
    for (const c of flat) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("スペーシングと角丸が定義されている", () => {
    expect(theme.spacing.card).toBe(16);
    expect(theme.radius.card).toBe(12);
  });

  it("タイポグラフィが定義されている", () => {
    expect(theme.typography.title).toEqual({ fontSize: 26, fontWeight: "700" });
    expect(theme.typography.section).toEqual({ fontSize: 18, fontWeight: "700" });
    expect(theme.typography.body).toEqual({ fontSize: 16 });
    expect(theme.typography.sub).toEqual({ fontSize: 13 });
  });
});
