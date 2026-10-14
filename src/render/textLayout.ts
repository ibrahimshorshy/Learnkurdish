/**
 * Cached canvas text layout.
 *
 * Line breaking used to run on every frame, which meant one measureText call
 * per word per frame — at 30fps with several text blocks on screen that was
 * thousands of measurements a second for text that never changes. Layout is
 * now computed once per (text, font, width) and replayed from cache.
 */

const RTL_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function isRtlText(text: string): boolean {
  return RTL_RANGE.test(text || "");
}

export interface LaidOutWord {
  text: string;
  /** Offset from the line's start edge, in the line's reading direction. */
  offset: number;
  width: number;
}

export interface LaidOutLine {
  text: string;
  width: number;
  words: LaidOutWord[];
}

export interface TextLayout {
  lines: LaidOutLine[];
  isRtl: boolean;
  /** Running index of the first word of each line, for karaoke highlighting. */
  lineWordStart: number[];
  totalWords: number;
}

const cache = new Map<string, TextLayout>();
const MAX_ENTRIES = 400;

/**
 * Wraps `text` to `maxWidth` under the ctx's current font and caches the result.
 * The caller must set ctx.font before calling — it is part of the cache key.
 */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  withWords = false
): TextLayout {
  const safe = (text || "").toString().trim();
  const key = `${ctx.font}|${Math.round(maxWidth)}|${withWords ? "w" : "l"}|${safe}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const isRtl = isRtlText(safe);
  const lines: LaidOutLine[] = [];
  const lineWordStart: number[] = [];

  if (safe) {
    const previousDirection = ctx.direction;
    ctx.direction = isRtl ? "rtl" : "ltr";

    const words = safe.split(/\s+/);
    let current: string[] = [];
    let wordCursor = 0;

    const flush = () => {
      if (!current.length) return;
      const lineText = current.join(" ");
      const line: LaidOutLine = {
        text: lineText,
        width: ctx.measureText(lineText).width,
        words: [],
      };
      if (withWords) {
        let offset = 0;
        const spaceWidth = ctx.measureText(" ").width;
        for (const word of current) {
          const width = ctx.measureText(word).width;
          line.words.push({ text: word, offset, width });
          offset += width + spaceWidth;
        }
      }
      lineWordStart.push(wordCursor);
      wordCursor += current.length;
      lines.push(line);
      current = [];
    };

    for (const word of words) {
      const candidate = current.length ? `${current.join(" ")} ${word}` : word;
      if (current.length && ctx.measureText(candidate).width > maxWidth) {
        flush();
        current = [word];
      } else {
        current.push(word);
      }
    }
    flush();

    ctx.direction = previousDirection;
  }

  const layout: TextLayout = {
    lines,
    isRtl,
    lineWordStart,
    totalWords: lines.reduce((sum, l) => sum + (l.words.length || l.text.split(/\s+/).length), 0),
  };

  if (cache.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, layout);
  return layout;
}

export interface DrawTextOptions {
  /** Highlight color applied to words before `highlightUpTo`. Enables karaoke. */
  highlightColor?: string;
  /** Number of words already spoken. Words at index < this are highlighted. */
  highlightUpTo?: number;
}

/**
 * Draws wrapped text centered on (x, y). Returns the number of lines drawn.
 * `y` is the vertical center of the block, matching the previous renderer.
 */
export function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  options: DrawTextOptions = {}
): number {
  const karaoke = options.highlightColor !== undefined && options.highlightUpTo !== undefined;
  const layout = layoutText(ctx, text, maxWidth, karaoke);
  if (!layout.lines.length) return 0;

  const previousDirection = ctx.direction;
  const previousAlign = ctx.textAlign;
  ctx.direction = layout.isRtl ? "rtl" : "ltr";

  let cursorY = y - ((layout.lines.length - 1) * lineHeight) / 2;

  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];

    if (!karaoke) {
      ctx.textAlign = "center";
      ctx.fillText(line.text, x, cursorY);
      cursorY += lineHeight;
      continue;
    }

    // Karaoke needs per-word placement, so draw from the line's start edge.
    const baseColor = ctx.fillStyle;
    const startX = layout.isRtl ? x + line.width / 2 : x - line.width / 2;
    ctx.textAlign = layout.isRtl ? "right" : "left";

    for (let w = 0; w < line.words.length; w++) {
      const word = line.words[w];
      const globalIndex = layout.lineWordStart[i] + w;
      ctx.fillStyle =
        globalIndex < (options.highlightUpTo ?? 0) ? options.highlightColor! : baseColor;
      const wordX = layout.isRtl ? startX - word.offset : startX + word.offset;
      ctx.fillText(word.text, wordX, cursorY);
    }

    ctx.fillStyle = baseColor;
    cursorY += lineHeight;
  }

  ctx.direction = previousDirection;
  ctx.textAlign = previousAlign;
  return layout.lines.length;
}

/** Drops every cached layout. Call when the output resolution changes. */
export function clearTextLayoutCache() {
  cache.clear();
}

/* ---------------- easing ---------------- */

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

export function easeOutBack(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  const s = 1.70158;
  return 1 + (s + 1) * Math.pow(c - 1, 3) + s * Math.pow(c - 1, 2);
}

/** Ramps 0→1 over `fade` seconds at the start and back to 0 at the end. */
export function envelope(local: number, duration: number, fade: number): number {
  if (duration <= 0) return 0;
  if (local < fade) return Math.min(1, Math.max(0, local / fade));
  if (local > duration - fade) return Math.min(1, Math.max(0, (duration - local) / fade));
  return 1;
}
