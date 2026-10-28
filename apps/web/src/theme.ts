import { isTheme, isThemeId, resolveTheme, type ThemePreference } from "@engineroom/protocol";

export const THEME_STORAGE_KEY = "engineroom-theme";

export interface ThemeDescriptor {
  id: ThemePreference;
  name: string;
  tagline: string;
  tier: "simple" | "elaborate";
  default?: boolean;
  swatches: {
    bg: string;
    sidebar: string;
    panel: string;
    accent: string;
    ink: string;
    border: string;
  };
}

export const THEME_CATALOG: readonly ThemeDescriptor[] = [
  {
    id: "dark",
    name: "Dark",
    tagline: "Charcoal monochrome surfaces",
    tier: "simple",
    default: true,
    swatches: {
      bg: "#101010",
      sidebar: "#161616",
      panel: "#1b1b1b",
      accent: "#3ddc84",
      ink: "#f3f3f3",
      border: "#2c2c2c",
    },
  },
  {
    id: "light",
    name: "Light",
    tagline: "Warm paper and ink surfaces",
    tier: "simple",
    swatches: {
      bg: "#f4f3ef",
      sidebar: "#ebeae4",
      panel: "#fffcf7",
      accent: "#1c7a45",
      ink: "#1a1916",
      border: "#cfcbc0",
    },
  },
  {
    id: "haxor",
    name: "Haxor",
    tagline: "Matrix phosphor green & CRT scanlines",
    tier: "elaborate",
    swatches: {
      bg: "#030804",
      sidebar: "#050e07",
      panel: "#08150b",
      accent: "#00ff41",
      ink: "#4dff79",
      border: "#1e6430",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    tagline: "Neon violet & synthwave glow",
    tier: "elaborate",
    swatches: {
      bg: "#080412",
      sidebar: "#0e0720",
      panel: "#150b2e",
      accent: "#d946ef",
      ink: "#f3e8ff",
      border: "#6d28d9",
    },
  },
  {
    id: "engine",
    name: "Engine",
    tagline: "Cybernetic HUD & luminous cyan bezels",
    tier: "elaborate",
    swatches: {
      bg: "#050b0e",
      sidebar: "#081318",
      panel: "#0b1a21",
      accent: "#00f2ff",
      ink: "#d8fbff",
      border: "#00d1e0",
    },
  },
  {
    id: "pi",
    name: "Pi",
    tagline: "Moonstone serif, Departure Mono, tidal blue",
    tier: "elaborate",
    swatches: {
      bg: "#0d1116",
      sidebar: "#161d27",
      panel: "#212730",
      accent: "#6a9fcc",
      ink: "#ebe7e4",
      border: "#495059",
    },
  },
];

export function normalizeTheme(value: unknown, installed: readonly string[] = []): string {
  return resolveTheme(value, installed);
}

export function applyTheme(theme: ThemePreference) {
  const id = isThemeId(theme) ? theme : "dark";
  document.documentElement.dataset.theme = id;
  const current = document.getElementById("extension-theme");
  if (isTheme(id)) {
    current?.remove();
    return;
  }
  const link = current instanceof HTMLLinkElement ? current : document.createElement("link");
  link.id = "extension-theme";
  link.rel = "stylesheet";
  link.href = `/api/extensions/themes/${id}.css`;
  if (!current) document.head.append(link);
}

export function rememberTheme(theme: ThemePreference) {
  const normalized = isThemeId(theme) ? theme : "dark";
  applyTheme(normalized);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
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
    background: cssColor("--term-bg", cssColor("--bg", "#101010")),
    foreground: cssColor("--ink", "#f3f3f3"),
    cursor: cssColor("--green", cssColor("--ink", "#f3f3f3")),
    selectionBackground: cssColor("--active", "#2c2c2c"),
  };
}
