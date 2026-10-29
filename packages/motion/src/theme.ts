export interface Theme {
  font: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
}

// System fonts for now; bundled fonts (for identical output on every machine) need a licence review.
const SANS = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

export const THEMES = {
  "dark-tech": {
    font: SANS,
    background: "#0B0F17",
    surface: "#151C2B",
    text: "#F2F5FA",
    muted: "#8A96AD",
    accent: "#38E1FF",
    accent2: "#8B5CFF",
  },
  "clean-pro": {
    font: SANS,
    background: "#F6F4EF",
    surface: "#FFFFFF",
    text: "#14161A",
    muted: "#6B7280",
    accent: "#FF5A36",
    accent2: "#1F6FEB",
  },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

export function getTheme(name: string | undefined): Theme {
  if (!name) return THEMES["dark-tech"];
  if (!(name in THEMES)) throw new Error(`unknown theme "${name}"; available: ${Object.keys(THEMES).join(", ")}`);
  return THEMES[name as ThemeName];
}
