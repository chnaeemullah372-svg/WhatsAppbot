/** Theme system. The app's default look (authentic WhatsApp white-green — the
 *  `:root` light palette) stays exactly as-is. Picking any other theme adds a
 *  matching class on <html> that swaps in a premium skin. The choice is
 *  remembered in localStorage and applies to BOTH the user panel and the admin
 *  dashboard. `isVip`/`setVip` are kept as thin wrappers for the admin VIP
 *  toggle so older callers keep working. */
const KEY = "wa_theme";
const LEGACY_VIP_KEY = "wa_theme_vip";

export type ThemeId = "default" | "vip" | "midnight" | "royal" | "rose" | "ocean";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  desc: string;
  /** Two swatch colours for the picker preview. */
  swatch: [string, string];
}

export const THEMES: ThemeOption[] = [
  { id: "default", label: "WhatsApp", desc: "Classic white & green", swatch: ["#25D366", "#ffffff"] },
  { id: "vip", label: "VIP Gold", desc: "Premium gold & emerald", swatch: ["#d4af37", "#0b3d2e"] },
  { id: "midnight", label: "Midnight", desc: "Dark slate & teal", swatch: ["#1f2937", "#2dd4bf"] },
  { id: "royal", label: "Royal", desc: "Deep purple & violet", swatch: ["#6d28d9", "#a78bfa"] },
  { id: "rose", label: "Rose", desc: "Soft rose & pink", swatch: ["#e11d48", "#fb7185"] },
  { id: "ocean", label: "Ocean", desc: "Cool blue & sky", swatch: ["#0369a1", "#38bdf8"] },
];

const THEME_IDS = THEMES.map((t) => t.id);
const THEME_CLASSES = THEMES.filter((t) => t.id !== "default").map((t) => t.id);

export function getTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY) as ThemeId | null;
    if (v && THEME_IDS.includes(v)) return v;
    // Migrate the old boolean VIP flag to the new named-theme storage.
    if (localStorage.getItem(LEGACY_VIP_KEY) === "1") return "vip";
  } catch {
    /* ignore storage errors (private mode) */
  }
  return "default";
}

export function applyTheme(): void {
  const el = document.documentElement;
  el.classList.remove(...THEME_CLASSES);
  const t = getTheme();
  if (t !== "default") el.classList.add(t);
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
    // Keep the legacy flag in sync so the admin VIP toggle reads correctly.
    localStorage.setItem(LEGACY_VIP_KEY, id === "vip" ? "1" : "0");
  } catch {
    /* ignore storage errors (private mode) */
  }
  applyTheme();
}

// ── Back-compat wrappers (admin VIP toggle) ───────────────────────
export function isVip(): boolean {
  return getTheme() === "vip";
}

export function setVip(on: boolean): void {
  setTheme(on ? "vip" : "default");
}

// ── Chat wallpaper ────────────────────────────────────────────────
/** The chat wallpaper sits BEHIND the message bubbles only (like WhatsApp's
 *  "Wallpaper" setting). It is independent of the theme — the bubbles keep their
 *  themed colours, so any wallpaper stays readable. The choice is a `wp-<id>`
 *  class on <html>; CSS overrides only the `.wa-chat-bg` surface. */
const WP_KEY = "wa_wallpaper";

export type WallpaperId = "doodle" | "plain" | "sand" | "mint" | "dusk" | "charcoal";

export interface WallpaperOption {
  id: WallpaperId;
  label: string;
  /** Preview colour for the picker swatch. */
  swatch: string;
}

export const WALLPAPERS: WallpaperOption[] = [
  { id: "doodle", label: "Default", swatch: "#e5ded8" },
  { id: "plain", label: "Plain", swatch: "#f0f2f5" },
  { id: "sand", label: "Sand", swatch: "#efeae2" },
  { id: "mint", label: "Mint", swatch: "#d9f2e6" },
  { id: "dusk", label: "Dusk", swatch: "#2b2440" },
  { id: "charcoal", label: "Charcoal", swatch: "#0b141a" },
];

const WP_IDS = WALLPAPERS.map((w) => w.id);
const WP_CLASSES = WALLPAPERS.map((w) => `wp-${w.id}`);

export function getWallpaper(): WallpaperId {
  try {
    const v = localStorage.getItem(WP_KEY) as WallpaperId | null;
    if (v && WP_IDS.includes(v)) return v;
  } catch {
    /* ignore storage errors (private mode) */
  }
  return "doodle";
}

export function applyWallpaper(): void {
  const el = document.documentElement;
  el.classList.remove(...WP_CLASSES);
  el.classList.add(`wp-${getWallpaper()}`);
}

export function setWallpaper(id: WallpaperId): void {
  try {
    localStorage.setItem(WP_KEY, id);
  } catch {
    /* ignore storage errors (private mode) */
  }
  applyWallpaper();
}
