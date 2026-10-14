/**
 * Subtitles for an uploaded video: the Kurdish line, how to say it, and what
 * it means, in a rounded box laid over the speaker.
 *
 * Unlike the other kinds, nothing here is a whole frame. Each cue is drawn on
 * a transparent canvas, saved as a PNG and laid over the real video by ffmpeg
 * (server/routes/media.ts), and the preview draws the very same cue over a
 * <video> element. One drawing function serves both, so the preview cannot
 * drift from the MP4.
 *
 *   cueTimings     — when each line's subtitle is on screen (pure)
 *   subtitleTint   — the box colour for an output's languages (pure)
 *   cueIndexAt     — which cue is showing at a moment (pure)
 *   prepareSubtitles — measures every cue once and returns the drawing
 *                      functions, the band all cues fit in, and the logo
 *   cuePng / overlayPng — the PNGs the server wants
 */

import type { LessonLine } from "../types";
import { FONTS } from "./themes";
import { REEL_SAFE, fitTextStack, safeTextWidth, type PlacedBlock, type StackBlock } from "./safeArea";
import { drawWrappedText, layoutText } from "./textLayout";
import { BASE, familyFor, loadImage } from "./frameKit";
import { ensureAllFontsLoaded } from "../utils/fontLoader";

/* ------------------------------------------------------------------ */
/* Timing                                                               */
/* ------------------------------------------------------------------ */

/**
 * A pause shorter than this between two lines is not worth blanking the
 * screen for: the subtitle stays up until the next one replaces it, which
 * reads as one continuous conversation instead of a flicker.
 */
export const JOIN_GAP = 1.2;
/** After a longer pause, the subtitle lingers this long past the last word. */
export const HOLD_AFTER = 0.4;
/** Nobody can read a subtitle that flashes past; a very short line is held at least this long when there is room. */
export const MIN_ON_SCREEN = 0.8;

export interface CueTiming {
  /** Index into the project's lines. */
  index: number;
  lineId: string;
  start: number;
  end: number;
}

/**
 * When each line's subtitle shows. Uses the line's place in the recording —
 * a video project's recording is the video's own sound and is never cut, so
 * those times are the video's times. Skipped and empty lines get no cue.
 */
export function cueTimings(lines: LessonLine[], durationSeconds?: number): CueTiming[] {
  const limit = durationSeconds && durationSeconds > 0 ? durationSeconds : Infinity;
  const usable = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        !line.skip &&
        line.kurdish.trim() &&
        Number.isFinite(line.start) &&
        Number.isFinite(line.end) &&
        line.end > line.start &&
        line.start < limit
    )
    .sort((a, b) => a.line.start - b.line.start);

  const out: CueTiming[] = [];
  usable.forEach(({ line, index }, i) => {
    const start = Math.max(0, line.start);
    const next = usable[i + 1]?.line;
    const ceiling = Math.min(limit, next ? next.start : Infinity);
    let end = next && next.start - line.end < JOIN_GAP ? next.start : line.end + HOLD_AFTER;
    end = Math.max(end, start + MIN_ON_SCREEN);
    end = Math.min(end, ceiling);
    if (end - start > 0.01) out.push({ index, lineId: line.id, start, end });
  });
  return out;
}

/** The cue on screen at `time`, or -1. Cues are sorted and never overlap. */
export function cueIndexAt(cues: Array<{ start: number; end: number }>, time: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && time < cues[found].end ? found : -1;
}

/* ------------------------------------------------------------------ */
/* Colour                                                               */
/* ------------------------------------------------------------------ */

/** The same greens and purples as the Emerald and Amethyst lesson themes. */
const GREEN = { box: "#0B3B2A", edge: "#2FBF71", text: "#9BE8B9" };
const PURPLE = { box: "#2E1650", edge: "#A86BF0", text: "#D9C2FF" };
const NEUTRAL = { box: "#0A1422", edge: "#FFFFFF", text: "#BFE3FF" };

export type TintKind = "green" | "purple" | "twilight" | "neutral";

export interface SubtitleTint {
  kind: TintKind;
  /** Box fill: one colour, or two for a diagonal gradient. */
  fill: string[];
  edge: string;
  /** Colour for each output language's translation, in order. */
  translations: string[];
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The box follows the colour each audience already knows from the lessons:
 * Arabic videos are dark green, English ones dark purple, and a video with
 * both melts from one into the other. Anything else gets a neutral dark box.
 */
export function subtitleTint(languages: string[]): SubtitleTint {
  const hasAr = languages.includes("ar");
  const hasEn = languages.includes("en");
  const kind: TintKind = hasAr && hasEn ? "twilight" : hasAr ? "green" : hasEn ? "purple" : "neutral";
  const fill =
    kind === "twilight"
      ? [GREEN.box, PURPLE.box]
      : [kind === "green" ? GREEN.box : kind === "purple" ? PURPLE.box : NEUTRAL.box];
  const edge = kind === "green" ? GREEN.edge : kind === "purple" || kind === "twilight" ? PURPLE.edge : NEUTRAL.edge;
  const others = [NEUTRAL.text, "#FFE1A8"];
  let other = 0;
  const translations = languages.map((id) =>
    id === "ar" ? GREEN.text : id === "en" ? PURPLE.text : others[other++ % others.length]
  );
  return { kind, fill: fill.map((c) => hexToRgba(c, 0.86)), edge: hexToRgba(edge, kind === "neutral" ? 0.14 : 0.4), translations };
}

/* ------------------------------------------------------------------ */
/* Layout and drawing                                                   */
/* ------------------------------------------------------------------ */

export type SubtitlePosition = "lower" | "middle";

export interface SubtitleOptions {
  /** Output width in pixels; the height is 16:9 of it, as for every reel. */
  width: number;
  languages: string[];
  showTransliteration: boolean;
  position: SubtitlePosition;
  /** "" for no logo. */
  logoSrc: string;
  /** Cues past the end of the video are dropped. */
  durationSeconds?: number;
}

export interface SubtitleCue extends CueTiming {
  kurdish: string;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreparedSubtitles {
  width: number;
  height: number;
  cues: SubtitleCue[];
  /**
   * The full-width strip every cue's box (and its shadow) falls inside, in
   * output pixels, on even numbers so ffmpeg can place it exactly. Each cue
   * PNG is this strip, not the whole frame — far less to upload and blend.
   */
  band: PixelRect;
  /** Where the logo sits, or null when there is none. */
  overlay: PixelRect | null;
  /** Draws cue `index` with the frame's origin moved to (0, -offsetY). */
  drawCue: (ctx: CanvasRenderingContext2D, index: number, offsetY?: number) => void;
  /** Draws the logo with the frame's origin moved to (-offsetX, -offsetY). */
  drawOverlay: (ctx: CanvasRenderingContext2D, offsetX?: number, offsetY?: number) => void;
}

/** Type sizes in 720-wide design units; smaller than a lesson card's, because the picture is the point. */
const TYPE = {
  kurdish: { size: 42, min: 24, lineHeight: 1.36 },
  translit: { size: 21, min: 14, lineHeight: 1.35, gap: 6 },
  first: { size: 29, min: 18, lineHeight: 1.4, gap: 12 },
  second: { size: 25, min: 16, lineHeight: 1.4, gap: 8 },
};
const PAD_X = 26;
const PAD_Y = 18;
const MIN_BOX_W = 220;
const RADIUS = 24;
const SHADOW = 22;
/** How tall the text may grow before it shrinks: low on the screen it must stay clear of the face. */
const MAX_TEXT_H: Record<SubtitlePosition, number> = { lower: 340, middle: 560 };
/** Where the logo sits, in design units: small, centred, inside the top safe edge. */
const LOGO = { maxW: 150, maxH: 46 };

const even = (n: number) => Math.round(n / 2) * 2;
const evenDown = (n: number) => Math.floor(n / 2) * 2;
const evenUp = (n: number) => Math.ceil(n / 2) * 2;

interface CueLayout {
  blocks: PlacedBlock[];
  colors: string[];
  box: PixelRect;
  /** Added to each block's centreY to put it in the box. */
  shift: number;
}

export async function prepareSubtitles(lines: LessonLine[], options: SubtitleOptions): Promise<PreparedSubtitles> {
  await ensureAllFontsLoaded();
  const width = even(options.width);
  const height = even((width * BASE.h) / BASE.w);
  const s = width / BASE.w;
  const cX = width / 2;
  const tint = subtitleTint(options.languages);

  const boxMaxW = safeTextWidth(BASE.w, REEL_SAFE) * s;
  const textMaxW = boxMaxW - 2 * PAD_X * s;
  const maxTextH = MAX_TEXT_H[options.position] * s;
  // Lower: the box's bottom edge sits just above the captions and buttons
  // the platforms draw along the bottom.
  const lowerBottom = (BASE.h - REEL_SAFE.bottom - 12) * s;

  const measure = document.createElement("canvas").getContext("2d")!;
  const timings = cueTimings(lines, options.durationSeconds);

  const layouts: CueLayout[] = timings.map(({ index }) => {
    const line = lines[index];
    const translations = options.languages.map((id) => (line.translations[id] || "").trim());
    const blocks: StackBlock[] = [
      {
        text: line.kurdish.trim(),
        size: TYPE.kurdish.size,
        lineHeight: TYPE.kurdish.lineHeight,
        minSize: TYPE.kurdish.min,
        weight: "bold",
        family: FONTS.kurdish,
        gapBefore: 0,
        yieldOrder: 0,
      },
      {
        text: options.showTransliteration ? line.transliteration.trim() : "",
        size: TYPE.translit.size,
        lineHeight: TYPE.translit.lineHeight,
        minSize: TYPE.translit.min,
        weight: "italic",
        family: FONTS.latin,
        gapBefore: TYPE.translit.gap,
        yieldOrder: 10,
        droppable: true,
      },
      ...translations.map((text, i) => {
        const t = i === 0 ? TYPE.first : TYPE.second;
        return {
          text,
          size: t.size,
          lineHeight: t.lineHeight,
          minSize: t.min,
          weight: "600",
          family: familyFor(text),
          gapBefore: t.gap,
          yieldOrder: 1 + i,
        };
      }),
    ];
    const placed = fitTextStack(measure, blocks, { top: 0, bottom: maxTextH, maxWidth: textMaxW, scale: s });
    const visible = placed.filter((b) => b.visible);
    const top = Math.min(...visible.map((b) => b.centerY - (b.lines * b.lineHeight) / 2));
    const bottom = Math.max(...visible.map((b) => b.centerY + (b.lines * b.lineHeight) / 2));
    let widest = 0;
    for (const b of visible) {
      measure.font = b.font;
      for (const l of layoutText(measure, b.text, textMaxW).lines) widest = Math.max(widest, l.width);
    }
    const boxW = Math.min(boxMaxW, Math.max(MIN_BOX_W * s, widest + 2 * PAD_X * s));
    const boxH = bottom - top + 2 * PAD_Y * s;
    const boxY = options.position === "lower" ? lowerBottom - boxH : (height - boxH) / 2;
    return {
      blocks: placed,
      colors: ["#FFFFFF", "rgba(215, 225, 242, 0.78)", ...tint.translations],
      box: { x: cX - boxW / 2, y: boxY, width: boxW, height: boxH },
      shift: boxY + PAD_Y * s - top,
    };
  });

  // One strip that holds every cue, shadow included.
  const margin = SHADOW * s;
  const bandTop = layouts.length ? Math.min(...layouts.map((l) => l.box.y)) - margin : 0;
  const bandBottom = layouts.length ? Math.max(...layouts.map((l) => l.box.y + l.box.height)) + margin : 2;
  const bandY = Math.max(0, evenDown(bandTop));
  const band: PixelRect = { x: 0, y: bandY, width, height: Math.max(2, Math.min(height, evenUp(bandBottom)) - bandY) };

  const drawCue = (ctx: CanvasRenderingContext2D, index: number, offsetY = 0) => {
    const layout = layouts[index];
    if (!layout) return;
    const { box } = layout;
    ctx.save();
    ctx.translate(0, -offsetY);

    // The box, with a soft shadow so it holds against a bright picture.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = SHADOW * s * 0.8;
    ctx.shadowOffsetY = 4 * s;
    if (tint.fill.length > 1) {
      const grad = ctx.createLinearGradient(box.x, box.y, box.x + box.width, box.y + box.height);
      grad.addColorStop(0, tint.fill[0]);
      grad.addColorStop(1, tint.fill[1]);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = tint.fill[0];
    }
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, RADIUS * s);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = tint.edge;
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, RADIUS * s);
    ctx.stroke();

    // The words.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 3 * s;
    layout.blocks.forEach((block, i) => {
      if (!block.visible) return;
      ctx.font = block.font;
      ctx.fillStyle = layout.colors[i] ?? "#FFFFFF";
      drawWrappedText(ctx, block.text, cX, block.centerY + layout.shift, textMaxW, block.lineHeight);
    });
    ctx.restore();
  };

  // The logo: small, centred at the top, inside the platforms' top safe edge.
  const logo = options.logoSrc ? await loadImage(options.logoSrc) : null;
  let overlay: PixelRect | null = null;
  let logoRect: PixelRect | null = null;
  if (logo && logo.width && logo.height) {
    const scale = Math.min((LOGO.maxW * s) / logo.width, (LOGO.maxH * s) / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    logoRect = { x: cX - w / 2, y: REEL_SAFE.top * s, width: w, height: h };
    const pad = 12 * s;
    const x = evenDown(logoRect.x - pad);
    const y = evenDown(logoRect.y - pad);
    overlay = { x, y, width: evenUp(logoRect.x + w + pad) - x, height: evenUp(logoRect.y + h + pad) - y };
  }

  const drawOverlay = (ctx: CanvasRenderingContext2D, offsetX = 0, offsetY = 0) => {
    if (!logo || !logoRect) return;
    ctx.save();
    ctx.translate(-offsetX, -offsetY);
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 8 * s;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(logo, logoRect.x, logoRect.y, logoRect.width, logoRect.height);
    ctx.restore();
  };

  return {
    width,
    height,
    cues: timings.map((t) => ({ ...t, kurdish: lines[t.index].kurdish.trim() })),
    band,
    overlay,
    drawCue,
    drawOverlay,
  };
}

/* ------------------------------------------------------------------ */
/* PNGs for the server                                                  */
/* ------------------------------------------------------------------ */

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not draw a subtitle image."))), "image/png")
  );
}

/** One cue as a transparent PNG of the band. */
export function cuePng(prepared: PreparedSubtitles, index: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = prepared.band.width;
  canvas.height = prepared.band.height;
  prepared.drawCue(canvas.getContext("2d")!, index, prepared.band.y);
  return canvasPng(canvas);
}

/** The logo as a transparent PNG of its own small rectangle, or null. */
export async function overlayPng(prepared: PreparedSubtitles): Promise<Blob | null> {
  const rect = prepared.overlay;
  if (!rect) return null;
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  prepared.drawOverlay(canvas.getContext("2d")!, rect.x, rect.y);
  return canvasPng(canvas);
}
