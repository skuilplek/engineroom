import type { ThemePreference } from "@engineroom/protocol";

export const THEME_STORAGE_KEY = "engineroom-theme";

export function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme;
}

export function rememberTheme(theme: ThemePreference) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage can be blocked */
  }
}

export function cssColor(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function terminalColors() {
  return {
    background: cssColor("--bg", "#101010"),
    foreground: cssColor("--ink", "#f3f3f3"),
    cursor: cssColor("--ink", "#f3f3f3"),
  };
}
