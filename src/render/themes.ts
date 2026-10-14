/**
 * Visual themes for the lesson video.
 *
 * Each theme paints its background in two passes, as in Reels Creator:
 *   paintStatic  — once, into an offscreen layer that is blitted every frame
 *   paintDynamic — per frame, on top; kept cheap, and given the voice level so
 *                  a theme can breathe with the speaker
 *
 * Built from the Leen brand palette. "Sun" is the one that departs from it: it
 * borrows the colours of the Kurdistan flag for lessons that should look
 * unmistakably Kurdish.
 */

import { BRAND, BRAND_PROGRESS, BRAND_PROGRESS_LIGHT, rgba, mix } from "../config/brand";

export type ThemeId =
  | "emerald"
  | "amethyst"
  | "twilight"
  | "midnight"
  | "aurora"
  | "studio"
  | "sun"
  | "cinematic"
  | "daylight";

export interface ThemePalette {
  /** The Kurdish line. */
  text: string;
  /** First translation. */
  translation: string;
  /** Second translation, in a bilingual video. */
  translationAlt: string;
  /** Latin pronunciation helper. */
  translit: string;
  /** Tagline, LISTEN cue, karaoke highlight. */
  accent: string;
  /** YOUR TURN cue, closing card. */
  accentAlt: string;
  pillFill: string;
  pillStroke: string;
  pillText: string;
  progressTrack: string;
  progressStops: [string, string, string];
  meta: string;
  /** Glow behind the Kurdish line; empty disables it. */
  textGlow: string;
  isLight: boolean;
}

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  blurb: string;
  /** CSS background for the picker swatch. */
  swatch: string;
  palette: ThemePalette;
  paintStatic: (ctx: CanvasRenderingContext2D, w: number, h: number, s: number) => void;
  paintDynamic?: (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    s: number,
    elapsed: number,
    voiceLevel: number
  ) => void;
}

/**
 * UniSIRWAN Dubai covers Sorani's own letters (ڕ ڵ ۆ ێ ە), Arabic and
 * Persian, and ships with the app. Latin stays on Inter, which has the italic
 * the pronunciation line uses.
 */
export const FONTS = {
  kurdish: "'UniSIRWAN Dubai', 'Noto Naskh Arabic', sans-serif",
  arabicScript: "'UniSIRWAN Dubai', 'Noto Naskh Arabic', sans-serif",
  latin: "'Inter', 'UniSIRWAN Dubai', sans-serif",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function verticalFill(ctx: CanvasRenderingContext2D, w: number, h: number, stops: Array<[number, string]>) {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function radialGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  stops: Array<[number, string]>
) {
  const grad = ctx.createRadialGradient(x, y, radius * 0.02, x, y, radius);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function ambientBorder(ctx: CanvasRenderingContext2D, w: number, h: number, s: number, color: string, inset = 22) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * s;
  ctx.strokeRect(inset * s, inset * s, w - inset * 2 * s, h - inset * 2 * s);
}

let grainPattern: CanvasPattern | null = null;
let grainKey = "";

function grain(ctx: CanvasRenderingContext2D, opacity: number): CanvasPattern | null {
  const key = opacity.toFixed(3);
  if (grainPattern && grainKey === key) return grainPattern;
  const size = 128;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const img = tctx.createImageData(size, size);
  const rand = seededRandom(20261014);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand() * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = Math.floor(opacity * 255);
  }
  tctx.putImageData(img, 0, 0);
  grainPattern = ctx.createPattern(tile, "repeat");
  grainKey = key;
  return grainPattern;
}

/** Soft blobs are baked once into sprites; a fresh radial gradient per frame is expensive. */
const sprites = new Map<string, HTMLCanvasElement>();
function blobSprite(color: string, size: number, alpha: number): HTMLCanvasElement {
  const key = `${color}|${size}|${alpha}`;
  const hit = sprites.get(key);
  if (hit) return hit;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext("2d");
  if (sctx) {
    const r = size / 2;
    const grad = sctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(color, alpha));
    grad.addColorStop(1, rgba(color, 0));
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, size, size);
  }
  sprites.set(key, sprite);
  return sprite;
}

/* ------------------------------------------------------------------ */
/* Palettes                                                             */
/* ------------------------------------------------------------------ */

const dark: ThemePalette = {
  text: BRAND.white,
  translation: BRAND.green,
  translationAlt: BRAND.blue,
  translit: rgba(BRAND.paper, 0.66),
  accent: BRAND.blue,
  accentAlt: BRAND.green,
  pillFill: "rgba(255, 255, 255, 0.08)",
  pillStroke: "rgba(255, 255, 255, 0.16)",
  pillText: rgba(BRAND.paper, 0.88),
  progressTrack: "rgba(255, 255, 255, 0.12)",
  progressStops: BRAND_PROGRESS,
  meta: rgba(BRAND.paper, 0.7),
  textGlow: rgba(BRAND.blue, 0.24),
  isLight: false,
};

const onLightBlue = mix(BRAND.blue, BRAND.ink, 0.46);
const onLightGreen = mix(BRAND.green, BRAND.ink, 0.52);

const light: ThemePalette = {
  text: BRAND.onLight,
  translation: onLightGreen,
  translationAlt: onLightBlue,
  translit: rgba(BRAND.onLight, 0.55),
  accent: onLightBlue,
  accentAlt: onLightGreen,
  pillFill: rgba(BRAND.onLight, 0.05),
  pillStroke: rgba(BRAND.onLight, 0.14),
  pillText: rgba(BRAND.onLight, 0.75),
  progressTrack: rgba(BRAND.onLight, 0.12),
  progressStops: BRAND_PROGRESS_LIGHT,
  meta: rgba(BRAND.onLight, 0.55),
  textGlow: "",
  isLight: true,
};

/** Kurdistan flag colours, toned for a screen. */
const KURD = {
  red: "#E0313A",
  green: "#2BA34A",
  sun: "#FDC82F",
  night: "#0B0F0D",
};

/* ------------------------------------------------------------------ */
/* Themes                                                               */
/* ------------------------------------------------------------------ */

/** Deep green for Arabic videos. */
const EMERALD = { top: "#0B3B2A", mid: "#06291D", bottom: "#021610", glow: "#2FBF71", soft: "#9BE8B9" };
/** Deep purple for English videos. */
const AMETHYST = { top: "#2E1650", mid: "#1D0D38", bottom: "#0D0620", glow: "#A86BF0", soft: "#D9C2FF" };

/**
 * A dark gradient theme built from one hue: a soft glow behind the words, a
 * slow drifting light, and the palette's text colours derived from the hue so
 * the translations stay readable on it.
 */
function gradientTheme(
  id: ThemeId,
  label: string,
  blurb: string,
  c: { top: string; mid: string; bottom: string; glow: string; soft: string },
  accentAlt: string
): ThemeInfo {
  return {
    id,
    label,
    blurb,
    swatch: `linear-gradient(160deg, ${c.top} 0%, ${c.mid} 55%, ${c.bottom} 100%)`,
    palette: {
      ...dark,
      translation: c.soft,
      translationAlt: BRAND.paper,
      accent: c.soft,
      accentAlt,
      pillFill: rgba(c.glow, 0.12),
      pillStroke: rgba(c.glow, 0.35),
      progressStops: [mix(c.glow, c.bottom, 0.4), c.glow, c.soft],
      textGlow: rgba(c.glow, 0.28),
    },
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, c.top],
        [0.55, c.mid],
        [1, c.bottom],
      ]);
      radialGlow(ctx, w / 2, h * 0.47, 430 * s, [
        [0, rgba(c.glow, 0.22)],
        [0.6, rgba(c.glow, 0.07)],
        [1, rgba(c.glow, 0)],
      ]);
      const pattern = grain(ctx, 0.025);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
      ambientBorder(ctx, w, h, s, rgba(c.glow, 0.22));
    },
    paintDynamic(ctx, w, h, s, elapsed, voice) {
      const size = Math.round(520 * s);
      const sprite = blobSprite(c.glow, size, 0.22 + voice * 0.12);
      const x = w / 2 + Math.sin(elapsed * 0.45) * 90 * s - size / 2;
      const y = h * 0.3 + Math.cos(elapsed * 0.35) * 60 * s - size / 2;
      ctx.drawImage(sprite, x, y);
    },
  };
}

export const THEMES: Record<ThemeId, ThemeInfo> = {
  emerald: gradientTheme(
    "emerald",
    "Emerald",
    "Dark green gradient. The default for Arabic videos.",
    EMERALD,
    "#F3D27A"
  ),

  amethyst: gradientTheme(
    "amethyst",
    "Amethyst",
    "Dark purple gradient. The default for English videos.",
    AMETHYST,
    "#7FE0C8"
  ),

  twilight: {
    id: "twilight",
    label: "Twilight",
    blurb: "Green melting into purple. The default when Arabic and English share a video.",
    swatch: `linear-gradient(160deg, ${EMERALD.top} 0%, ${EMERALD.bottom} 45%, ${AMETHYST.mid} 70%, ${AMETHYST.top} 100%)`,
    palette: {
      ...dark,
      translation: EMERALD.soft,
      translationAlt: AMETHYST.soft,
      accent: EMERALD.soft,
      accentAlt: AMETHYST.soft,
      pillFill: "rgba(255, 255, 255, 0.08)",
      pillStroke: rgba(AMETHYST.glow, 0.35),
      progressStops: [EMERALD.glow, mix(EMERALD.glow, AMETHYST.glow, 0.5), AMETHYST.glow],
      textGlow: rgba(AMETHYST.glow, 0.22),
    },
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, EMERALD.top],
        [0.45, "#071A1F"],
        [1, AMETHYST.mid],
      ]);
      radialGlow(ctx, w * 0.25, h * 0.2, 420 * s, [
        [0, rgba(EMERALD.glow, 0.2)],
        [1, rgba(EMERALD.glow, 0)],
      ]);
      radialGlow(ctx, w * 0.8, h * 0.82, 460 * s, [
        [0, rgba(AMETHYST.glow, 0.24)],
        [1, rgba(AMETHYST.glow, 0)],
      ]);
      const pattern = grain(ctx, 0.025);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
      ambientBorder(ctx, w, h, s, "rgba(255, 255, 255, 0.12)");
    },
  },

  midnight: {
    id: "midnight",
    label: "Midnight",
    blurb: "Deep navy with a slow starfield.",
    swatch: `linear-gradient(135deg, ${BRAND.ink} 0%, ${BRAND.inkSoft} 60%, ${BRAND.navy} 100%)`,
    palette: dark,
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, BRAND.ink],
        [1, BRAND.inkSoft],
      ]);
      ambientBorder(ctx, w, h, s, rgba(BRAND.blue, 0.2), 24);
    },
    paintDynamic(ctx, w, h, s, elapsed) {
      const rand = seededRandom(1337);
      for (let i = 0; i < 60; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const radius = (rand() * 2 + 1) * s;
        const speed = rand() * 1.5 + 0.4;
        const phase = rand() * Math.PI * 2;
        const opacity = ((Math.sin(elapsed * speed + phase) + 1) / 2) * 0.45 + 0.15;
        ctx.fillStyle = rgba(BRAND.green, opacity * 0.5);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },

  aurora: {
    id: "aurora",
    label: "Aurora",
    blurb: "Blue and green light that breathes with your voice.",
    swatch: `linear-gradient(135deg, ${BRAND.ink} 0%, ${BRAND.blue} 50%, ${BRAND.green} 100%)`,
    palette: dark,
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, BRAND.ink],
        [1, BRAND.inkSoft],
      ]);
      ambientBorder(ctx, w, h, s, rgba(BRAND.blue, 0.28));
    },
    paintDynamic(ctx, w, h, s, elapsed, voice) {
      const cx = w / 2;
      const blueSize = Math.round(660 * s);
      const greenSize = Math.round(620 * s);
      const swell = 1 + voice * 0.12;
      const blue = blobSprite(BRAND.blue, blueSize, 0.4);
      const green = blobSprite(BRAND.green, greenSize, 0.36);
      const d1 = Math.sin(elapsed * 1.1) * 35 * s;
      const d2 = Math.cos(elapsed * 0.8) * 30 * s;
      const bw = blueSize * swell;
      const gw = greenSize * swell;
      ctx.drawImage(blue, cx - 140 * s + d1 - bw / 2, h * 0.4 - bw / 2, bw, bw);
      ctx.drawImage(green, cx + 140 * s + d2 - gw / 2, h * 0.6 - gw / 2, gw, gw);
    },
  },

  studio: {
    id: "studio",
    label: "Studio",
    blurb: "One calm spotlight. Nothing competes with the words.",
    swatch: `linear-gradient(135deg, ${BRAND.ink} 0%, ${BRAND.teal} 55%, ${BRAND.green} 100%)`,
    palette: dark,
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, BRAND.ink],
        [1, BRAND.inkSoft],
      ]);
      radialGlow(ctx, w / 2, h * 0.48, 380 * s, [
        [0, rgba(BRAND.blue, 0.3)],
        [0.55, rgba(BRAND.green, 0.18)],
        [1, rgba(BRAND.green, 0)],
      ]);
      ambientBorder(ctx, w, h, s, rgba(BRAND.green, 0.3));
    },
  },

  sun: {
    id: "sun",
    label: "Kurdistan Sun",
    blurb: "A golden sun rising behind the words, in the flag's colours.",
    swatch: `linear-gradient(180deg, ${KURD.red} 0%, ${KURD.red} 18%, #ffffff 18%, #ffffff 22%, ${KURD.night} 22%, ${KURD.night} 78%, ${KURD.sun} 86%, ${KURD.green} 100%)`,
    palette: {
      ...dark,
      translation: KURD.sun,
      translationAlt: "#9FE3AF",
      accent: KURD.sun,
      accentAlt: "#6FD38A",
      pillStroke: rgba(KURD.sun, 0.35),
      progressStops: [KURD.red, KURD.sun, KURD.green],
      textGlow: rgba(KURD.sun, 0.22),
    },
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, "#141612"],
        [1, KURD.night],
      ]);
      // A faint 21-ray sun centred behind the text.
      const cx = w / 2;
      const cy = h * 0.47;
      radialGlow(ctx, cx, cy, 420 * s, [
        [0, rgba(KURD.sun, 0.2)],
        [0.5, rgba(KURD.sun, 0.07)],
        [1, rgba(KURD.sun, 0)],
      ]);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = rgba(KURD.sun, 0.07);
      for (let i = 0; i < 21; i++) {
        ctx.rotate((Math.PI * 2) / 21);
        ctx.beginPath();
        ctx.moveTo(-14 * s, 0);
        ctx.lineTo(0, -470 * s);
        ctx.lineTo(14 * s, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      // Flag bands along the very top and bottom, outside every safe area.
      const band = 10 * s;
      ctx.fillStyle = KURD.red;
      ctx.fillRect(0, 0, w, band);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, band, w, band * 0.5);
      ctx.fillStyle = KURD.green;
      ctx.fillRect(0, h - band, w, band);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, h - band * 1.5, w, band * 0.5);
    },
    paintDynamic(ctx, w, h, s, elapsed, voice) {
      radialGlow(ctx, w / 2, h * 0.47, (120 + voice * 140) * s, [
        [0, rgba(KURD.sun, 0.1 + voice * 0.16)],
        [1, rgba(KURD.sun, 0)],
      ]);
    },
  },

  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    blurb: "Near-black, a warm key light and film grain.",
    swatch: `linear-gradient(135deg, #030509 0%, ${mix(BRAND.gold, "#030509", 0.45)} 55%, ${BRAND.gold} 100%)`,
    palette: {
      ...dark,
      translation: BRAND.gold,
      translationAlt: BRAND.paper,
      accent: BRAND.gold,
      accentAlt: mix(BRAND.gold, BRAND.white, 0.35),
      progressStops: [mix(BRAND.gold, "#030509", 0.5), BRAND.gold, mix(BRAND.gold, BRAND.white, 0.4)],
      textGlow: rgba(BRAND.gold, 0.25),
    },
    paintStatic(ctx, w, h, s) {
      verticalFill(ctx, w, h, [
        [0, "#030509"],
        [1, "#0B0E14"],
      ]);
      radialGlow(ctx, w / 2, h / 2, 380 * s, [
        [0, rgba(BRAND.gold, 0.16)],
        [1, rgba(BRAND.gold, 0)],
      ]);
      const pattern = grain(ctx, 0.035);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
      }
      ambientBorder(ctx, w, h, s, rgba(BRAND.gold, 0.25));
    },
  },

  daylight: {
    id: "daylight",
    label: "Daylight",
    blurb: "Clean white with soft brand light in the corners.",
    swatch: `linear-gradient(160deg, ${BRAND.white} 0%, ${BRAND.white} 55%, ${BRAND.blue} 85%, ${BRAND.green} 100%)`,
    palette: light,
    paintStatic(ctx, w, h, s) {
      ctx.fillStyle = BRAND.white;
      ctx.fillRect(0, 0, w, h);
      radialGlow(ctx, w * 0.1, h * 0.04, Math.min(w, h) * 0.78, [
        [0, rgba(BRAND.blue, 0.5)],
        [1, rgba(BRAND.blue, 0)],
      ]);
      radialGlow(ctx, w * 0.94, h * 0.99, Math.min(w, h) * 0.82, [
        [0, rgba(BRAND.green, 0.55)],
        [1, rgba(BRAND.green, 0)],
      ]);
      const clear = ctx.createRadialGradient(w / 2, h * 0.5, 30 * s, w / 2, h * 0.5, Math.max(w, h) * 0.36);
      clear.addColorStop(0, rgba(BRAND.white, 0.97));
      clear.addColorStop(0.7, rgba(BRAND.white, 0.8));
      clear.addColorStop(1, rgba(BRAND.white, 0));
      ctx.fillStyle = clear;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = BRAND.blue;
      ctx.fillRect(0, h - 14 * s, w * 0.55, 14 * s);
      ctx.fillStyle = BRAND.green;
      ctx.fillRect(w * 0.55, h - 14 * s, w * 0.45, 14 * s);
    },
  },
};

export const THEME_ORDER: ThemeId[] = [
  "emerald",
  "amethyst",
  "twilight",
  "sun",
  "aurora",
  "midnight",
  "studio",
  "cinematic",
  "daylight",
];
export const DEFAULT_THEME: ThemeId = "emerald";

/** The look a video in these languages starts with: green for Arabic, purple for English. */
const LANGUAGE_THEMES: Record<string, ThemeId> = {
  ar: "emerald",
  en: "amethyst",
  fa: "midnight",
  tr: "studio",
};

export function defaultThemeFor(languages: string[]): ThemeId {
  if (languages.length > 1) return "twilight";
  return LANGUAGE_THEMES[languages[0]] ?? DEFAULT_THEME;
}

/** The theme for one output: what was picked for it, else the language default. */
export function themeFor(themes: Record<string, ThemeId> | undefined, languages: string[]): ThemeId {
  const picked = themes?.[languages.join("+")];
  return picked && THEMES[picked] ? picked : defaultThemeFor(languages);
}

export function resolveTheme(id: string | undefined): ThemeInfo {
  return THEMES[id as ThemeId] ?? THEMES[DEFAULT_THEME];
}

/** Drops cached sprites and textures; call when the output size changes. */
export function clearThemeCaches() {
  sprites.clear();
  grainPattern = null;
  grainKey = "";
}
