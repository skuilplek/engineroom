import { isTheme, type ThemePreference } from "@engineroom/protocol";

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
  {
    id: "nes",
    name: "NES",
    tagline: "8-bit menus, coin yellow, and hard shadows",
    tier: "elaborate",
    swatches: {
      bg: "#000000",
      sidebar: "#000000",
      panel: "#fcfcfc",
      accent: "#f83800",
      ink: "#fcfcfc",
      border: "#f8d800",
    },
  },
  {
    id: "psone",
    name: "PS1",
    tagline: "Boot-screen blue and gray plastic",
    tier: "elaborate",
    swatches: {
      bg: "#0a1c4a",
      sidebar: "#071433",
      panel: "#c6c6c6",
      accent: "#e10600",
      ink: "#f2f2f2",
      border: "#8a8a8a",
    },
  },
  {
    id: "win98",
    name: "Windows 98",
    tagline: "Teal desktop and beveled gray windows",
    tier: "elaborate",
    swatches: {
      bg: "#008080",
      sidebar: "#c0c0c0",
      panel: "#c0c0c0",
      accent: "#000080",
      ink: "#000000",
      border: "#000000",
    },
  },
  {
    id: "winxp",
    name: "Windows XP",
    tagline: "Luna blue title bar and olive windows",
    tier: "elaborate",
    swatches: {
      bg: "#3a6ea5",
      sidebar: "#ece9d8",
      panel: "#ffffff",
      accent: "#0054e3",
      ink: "#1a1a1a",
      border: "#0054e3",
    },
  },
  {
    id: "win7",
    name: "Windows 7",
    tagline: "Aero glass and caption blue",
    tier: "elaborate",
    swatches: {
      bg: "#d7e4f2",
      sidebar: "#eef6fc",
      panel: "#ffffff",
      accent: "#3399ff",
      ink: "#1b1b1b",
      border: "#9ec3e0",
    },
  },
  {
    id: "dos",
    name: "DOS",
    tagline: "Amber phosphor on a black VGA screen",
    tier: "elaborate",
    swatches: {
      bg: "#000000",
      sidebar: "#000000",
      panel: "#000000",
      accent: "#ffb000",
      ink: "#ffb000",
      border: "#ffb000",
    },
  },
  {
    id: "dawn",
    name: "New Dawn",
    tagline: "After Dark sky and toaster-orange windows",
    tier: "elaborate",
    swatches: {
      bg: "#070b18",
      sidebar: "#f6e7c1",
      panel: "#fff6e4",
      accent: "#e07a3d",
      ink: "#1c140e",
      border: "#111111",
    },
  },
  {
    id: "system",
    name: "System",
    tagline: "Platinum desktop and striped title bars",
    tier: "elaborate",
    swatches: {
      bg: "#aaaaaa",
      sidebar: "#ffffff",
      panel: "#ffffff",
      accent: "#000000",
      ink: "#000000",
      border: "#000000",
    },
  },
  {
    id: "sims",
    name: "The Sims",
    tagline: "Sky, grass, and a plumbob green accent",
    tier: "elaborate",
    swatches: {
      bg: "#7ec8e3",
      sidebar: "#3d8c40",
      panel: "#f3e6c8",
      accent: "#7ac943",
      ink: "#2c2416",
      border: "#6b3e26",
    },
  },
];

export function normalizeTheme(value: unknown): ThemePreference {
  return isTheme(value) ? value : "dark";
}

export function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}

export function rememberTheme(theme: ThemePreference) {
  const normalized = normalizeTheme(theme);
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
