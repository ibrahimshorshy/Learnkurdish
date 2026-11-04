/**
 * What every video kind's frame has in common: the background, the logo and
 * tagline, the title pill, the footer with its progress bar and counter, and a
 * few drawing helpers. The lesson, dialogue and story renderers each draw
 * their own middle on top of this, so they all read as one family.
 */

import { findAudienceLanguage, type VideoStrings } from "../config/languages";
import { FONTS, resolveTheme, type ThemeId, type ThemeInfo } from "./themes";
import { isRtlText } from "./textLayout";
import { REEL_SAFE, safeTextWidth, type SafeArea } from "./safeArea";

/** Design units; every position is multiplied by `s`. */
export const BASE = { w: 720, h: 1280 };
export const FPS = 30;

export function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** On-video words for each language shown, primary first. Never empty. */
export function stringsFor(ids: string[]): VideoStrings[] {
  const found = ids.map((id) => findAudienceLanguage(id)?.strings).filter(Boolean) as VideoStrings[];
  return found.length ? found : [findAudienceLanguage("en")!.strings];
}

export function familyFor(text: string): string {
  return isRtlText(text) ? FONTS.arabicScript : FONTS.latin;
}

export interface FrameKit {
  theme: ThemeInfo;
  strings: VideoStrings[];
  width: number;
  height: number;
  /** Output pixels per design unit. */
  s: number;
  cX: number;
  safe: SafeArea;
  maxTextW: number;
  /** The painted background, logo, tagline and title pill. Blit once per frame. */
  staticLayer: HTMLCanvasElement;
  /** Bottom of the header block, in pixels: content goes below this. */
  headerBottom: number;
  /** Footer geometry, in pixels. */
  hudY: number;
  progress: { x: number; y: number; w: number; h: number };
  /** Paints the progress track, with a tick at each of `markers` (seconds). */
  paintTrack: (markers: number[], total: number) => void;
  drawBackdrop: (ctx: CanvasRenderingContext2D, elapsed: number, voice: number) => void;
  drawProgress: (ctx: CanvasRenderingContext2D, fraction: number) => void;
  drawCounter: (ctx: CanvasRenderingContext2D, current: number, count: number) => void;
  setFont: (ctx: CanvasRenderingContext2D, weight: string, size: number, text: string) => void;
  centeredText: (ctx: CanvasRenderingContext2D, text: string, y: number, x?: number) => void;
  voiceBars: (ctx: CanvasRenderingContext2D, x: number, y: number, voice: number, elapsed: number) => void;
}

export interface FrameKitOptions {
  width: number;
  theme: ThemeId;
  languages: string[];
  titles: Record<string, string>;
  logo: HTMLImageElement | null;
  /** Leave the title pill out (e.g. when the kind draws its own heading). */
  noTitle?: boolean;
}

export function makeFrameKit(options: FrameKitOptions): FrameKit {
  const theme = resolveTheme(options.theme);
  const palette = theme.palette;
  const strings = stringsFor(options.languages);
  const primary = strings[0];

  const width = Math.round(options.width / 2) * 2;
  const height = Math.round((width * BASE.h) / BASE.w / 2) * 2;
  const s = width / BASE.w;
  const cX = width / 2;
  const safe = REEL_SAFE;
  const maxTextW = safeTextWidth(BASE.w, safe) * s;

  const staticLayer = document.createElement("canvas");
  staticLayer.width = width;
  staticLayer.height = height;
  const sctx = staticLayer.getContext("2d")!;
  theme.paintStatic(sctx, width, height, s);

  let cursor = safe.top * s;
  const logo = options.logo;
  if (logo) {
    const scale = Math.min((220 * s) / logo.width, (88 * s) / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    sctx.drawImage(logo, cX - w / 2, cursor, w, h);
    cursor += h + 26 * s;
  } else {
    cursor += 30 * s;
  }

  // Tagline: "Learn Kurdish Sorani" in the viewer's language.
  sctx.textAlign = "center";
  sctx.textBaseline = "alphabetic";
  sctx.fillStyle = palette.accent;
  sctx.direction = isRtlText(primary.tagline) ? "rtl" : "ltr";
  sctx.font = `bold ${Math.round(23 * s)}px ${familyFor(primary.tagline)}`;
  sctx.fillText(primary.tagline, cX, cursor);
  sctx.direction = "ltr";
  cursor += 24 * s;

  // Title pill.
  const title = options.noTitle ? "" : (options.titles[options.languages[0]] || "").trim();
  let headerBottom = cursor;
  if (title) {
    const pillY = cursor + 30 * s;
    sctx.font = `600 ${Math.round(19 * s)}px ${familyFor(title)}`;
    const textW = Math.min(sctx.measureText(title).width, maxTextW - 40 * s);
    const pillW = textW + 40 * s;
    const pillH = 40 * s;
    sctx.fillStyle = palette.pillFill;
    sctx.strokeStyle = palette.pillStroke;
    sctx.lineWidth = 1 * s;
    sctx.beginPath();
    sctx.roundRect(cX - pillW / 2, pillY - pillH / 2, pillW, pillH, 20 * s);
    sctx.fill();
    sctx.stroke();
    sctx.fillStyle = palette.pillText;
    sctx.textBaseline = "middle";
    sctx.direction = isRtlText(title) ? "rtl" : "ltr";
    sctx.fillText(title, cX, pillY, maxTextW - 40 * s);
    sctx.direction = "ltr";
    sctx.textBaseline = "alphabetic";
    headerBottom = pillY + pillH / 2;
  }

  // Footer: HUD above the progress bar, both clear of the platforms' captions.
  const hudY = (BASE.h - safe.bottom - 62) * s;
  const progress = {
    x: cX - maxTextW / 2,
    y: (BASE.h - safe.bottom - 22) * s,
    w: maxTextW,
    h: 8 * s,
  };

  const paintTrack = (markers: number[], total: number) => {
    sctx.fillStyle = palette.progressTrack;
    sctx.beginPath();
    sctx.roundRect(progress.x, progress.y, progress.w, progress.h, 4 * s);
    sctx.fill();
    sctx.fillStyle = palette.isLight ? "rgba(4, 23, 48, 0.3)" : "rgba(255, 255, 255, 0.35)";
    for (const at of markers) {
      if (at > 0 && at < total) {
        const x = progress.x + (at / total) * progress.w;
        sctx.fillRect(x - 1 * s, progress.y - 2 * s, 2 * s, progress.h + 4 * s);
      }
    }
  };

  const drawBackdrop = (ctx: CanvasRenderingContext2D, elapsed: number, voice: number) => {
    ctx.drawImage(staticLayer, 0, 0);
    theme.paintDynamic?.(ctx, width, height, s, elapsed, voice);
  };

  const drawProgress = (ctx: CanvasRenderingContext2D, fraction: number) => {
    const fillW = progress.w * Math.max(0, Math.min(1, fraction));
    if (fillW <= 0) return;
    const grad = ctx.createLinearGradient(progress.x, 0, progress.x + progress.w, 0);
    grad.addColorStop(0, palette.progressStops[0]);
    grad.addColorStop(0.5, palette.progressStops[1]);
    grad.addColorStop(1, palette.progressStops[2]);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(progress.x, progress.y, fillW, progress.h, 4 * s);
    ctx.fill();
  };

  const drawCounter = (ctx: CanvasRenderingContext2D, current: number, count: number) => {
    if (!count) return;
    ctx.save();
    ctx.textAlign = "right";
    ctx.fillStyle = palette.meta;
    ctx.font = `600 ${Math.round(21 * s)}px ${FONTS.latin}`;
    // Right-aligned to the safe edge: the frame edge is under the action rail.
    ctx.fillText(`${Math.min(current, count)} / ${count}`, width - safe.right * s, progress.y - 18 * s);
    ctx.restore();
  };

  const setFont = (ctx: CanvasRenderingContext2D, weight: string, size: number, text: string) => {
    ctx.font = `${weight} ${Math.round(size * s)}px ${familyFor(text)}`;
  };

  const centeredText = (ctx: CanvasRenderingContext2D, text: string, y: number, x = cX) => {
    ctx.direction = isRtlText(text) ? "rtl" : "ltr";
    ctx.fillText(text, x, y);
    ctx.direction = "ltr";
  };

  /** Five little bars that move with the voice. */
  const voiceBars = (ctx: CanvasRenderingContext2D, x: number, y: number, voice: number, elapsed: number) => {
    const barW = 4 * s;
    const gap = 4 * s;
    for (let i = 0; i < 5; i++) {
      const wobble = 0.55 + 0.45 * Math.sin(elapsed * 9 + i * 1.7);
      const h = (4 + 18 * Math.min(1, voice * 1.4) * wobble) * s;
      ctx.beginPath();
      ctx.roundRect(x + i * (barW + gap), y - h / 2, barW, h, 2 * s);
      ctx.fill();
    }
  };

  return {
    theme,
    strings,
    width,
    height,
    s,
    cX,
    safe,
    maxTextW,
    staticLayer,
    headerBottom,
    hudY,
    progress,
    paintTrack,
    drawBackdrop,
    drawProgress,
    drawCounter,
    setFont,
    centeredText,
    voiceBars,
  };
}
