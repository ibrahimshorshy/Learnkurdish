/**
 * Platform safe areas, and a text stacker that respects them.
 *
 * Instagram and TikTok both paint their own interface over a vertical video —
 * the caption and handle along the bottom, the like/comment/share rail down the
 * right, tabs and a search control across the top. Anything drawn underneath
 * that is simply not readable, and you only find out after publishing.
 *
 * Published figures for a 1080x1920 frame, as of September 2026:
 *
 *                      top    bottom   left   right
 *   Instagram Reels    108      320      60     120
 *   TikTok            ~150      334      60     140
 *
 * The numbers below are the union — the deeper of the two on every edge — so
 * one layout is safe on both. They are expressed in the renderer's 720x1280
 * design units, which is the 1080x1920 figure divided by 1.5.
 *
 * Sources:
 *   https://kreatli.com/guides/instagram-reels-safe-zone
 *   https://kreatli.com/guides/tiktok-safe-zone
 *   https://www.lucidmedia.co.nz/blog/instagram-facebook-ad-safe-zones-2026/
 *   https://zeely.ai/blog/tiktok-safe-zones/
 */

import { layoutText } from "./textLayout";

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Vertical reels, in 720x1280 design units. */
export const REEL_SAFE: SafeArea = { top: 100, bottom: 230, left: 40, right: 100 };

/** Horizontal YouTube output has no overlaid chrome; this is just tidy margin. */
export const YOUTUBE_SAFE: SafeArea = { top: 40, bottom: 60, left: 40, right: 40 };

/**
 * Widest a centred block may be without straying under either platform's
 * chrome.
 *
 * Centred text has the same margin on both sides, so the margin has to satisfy
 * the hungrier edge — the right-hand action rail. Being strict on the left too
 * costs about 3% of the width, which is not visible, and it keeps the
 * composition centred, which very much is.
 */
export function safeTextWidth(baseWidth: number, safe: SafeArea): number {
  return baseWidth - 2 * Math.max(safe.left, safe.right);
}

/* ------------------------------------------------------------------ */

export interface StackBlock {
  text: string;
  /** Type size in design units, before any shrinking to fit. */
  size: number;
  /** Line height as a multiple of the type size. */
  lineHeight: number;
  /** Smallest size worth rendering. A block that cannot reach this is dropped. */
  minSize: number;
  /** Everything after the size in a CSS font string, e.g. `bold` / `italic`. */
  weight: string;
  family: string;
  /** Space above this block, in design units. */
  gapBefore: number;
  /**
   * Order in which blocks give up space: the highest number shrinks first and
   * is dropped first. The learner's own language is the point of the video, so
   * it is the last thing to give.
   */
  yieldOrder: number;
  /** Whether this block may be dropped outright when nothing else is left. */
  droppable?: boolean;
}

export interface PlacedBlock {
  text: string;
  /** Ready to assign to ctx.font — already scaled to the output resolution. */
  font: string;
  /** In output pixels. */
  lineHeight: number;
  /** Vertical centre of the block, in output pixels. */
  centerY: number;
  lines: number;
  visible: boolean;
}

/**
 * Lays blocks out one above another, centred in a band, shrinking them until
 * they fit.
 *
 * The reason this exists: the blocks used to sit at fixed vertical positions,
 * which is fine until a sentence is long enough to wrap onto a fourth line and
 * grow straight through the translation underneath it. Measuring first and
 * placing afterwards makes an overlap impossible by construction.
 *
 * Call this once per sentence, never per frame. Recomputing every frame is what
 * makes text visibly twitch while a webfont is still settling.
 */
export function fitTextStack(
  ctx: CanvasRenderingContext2D,
  blocks: StackBlock[],
  options: {
    /** Top of the band, in output pixels. */
    top: number;
    /** Bottom of the band, in output pixels. */
    bottom: number;
    maxWidth: number;
    /** Output pixels per design unit. */
    scale: number;
  }
): PlacedBlock[] {
  const { top, bottom, maxWidth, scale } = options;
  const available = Math.max(0, bottom - top);

  const state = blocks.map((block) => ({
    block,
    size: block.size,
    dropped: !block.text.trim(),
  }));

  const fontOf = (b: StackBlock, size: number) =>
    `${b.weight} ${Math.round(size * scale)}px ${b.family}`;

  const measure = () =>
    state.map((entry) => {
      if (entry.dropped) return { lines: 0, height: 0 };
      ctx.font = fontOf(entry.block, entry.size);
      const lines = layoutText(ctx, entry.block.text, maxWidth).lines.length;
      return { lines, height: lines * entry.size * entry.block.lineHeight * scale };
    });

  const totalHeight = (sizes: Array<{ height: number }>) =>
    sizes.reduce((sum, m, i) => {
      if (!m.height) return sum;
      const isFirstVisible = sizes.slice(0, i).every((p) => !p.height);
      return sum + m.height + (isFirstVisible ? 0 : state[i].block.gapBefore * scale);
    }, 0);

  let measured = measure();

  // Shrink the least important block that still has room to give, one step at
  // a time, so the type stays as large as the space genuinely allows.
  const STEP = 0.94;
  for (let guard = 0; guard < 200 && totalHeight(measured) > available; guard++) {
    const candidate = state
      .filter((e) => !e.dropped && e.size * STEP >= e.block.minSize)
      .sort((a, b) => b.block.yieldOrder - a.block.yieldOrder)[0];

    if (candidate) {
      candidate.size *= STEP;
    } else {
      // Nothing can shrink further. Drop the least important droppable block —
      // the pronunciation line is the one the viewer can most afford to lose.
      const expendable = state
        .filter((e) => !e.dropped && e.block.droppable)
        .sort((a, b) => b.block.yieldOrder - a.block.yieldOrder)[0];
      if (!expendable) break;
      expendable.dropped = true;
    }
    measured = measure();
  }

  // Place what survived, as one group centred in the band.
  const height = totalHeight(measured);
  let cursor = top + Math.max(0, (available - height) / 2);
  let seenVisible = false;

  return state.map((entry, i) => {
    const m = measured[i];
    if (entry.dropped || !m.lines) {
      return {
        text: entry.block.text,
        font: fontOf(entry.block, entry.size),
        lineHeight: entry.size * entry.block.lineHeight * scale,
        centerY: cursor,
        lines: 0,
        visible: false,
      };
    }

    if (seenVisible) cursor += entry.block.gapBefore * scale;
    seenVisible = true;

    const centerY = cursor + m.height / 2;
    cursor += m.height;

    return {
      text: entry.block.text,
      font: fontOf(entry.block, entry.size),
      lineHeight: entry.size * entry.block.lineHeight * scale,
      centerY,
      lines: m.lines,
      visible: true,
    };
  });
}
