/**
 * The arithmetic of the dialogue chat thread, kept apart from the drawing so
 * the tests can check it without a canvas.
 *
 * The thread is a column of bubbles that only ever grows. A bubble appears when
 * its line is first played, and the column moves so the newest bubble is in
 * view:
 *
 *   - While everything said so far fits, the group sits in the middle of the
 *     space between the header and the footer. The first line of a dialogue is
 *     then in the centre of the frame, where a viewer is already looking,
 *     instead of stranded at the top or bottom of an empty screen.
 *   - Once it no longer fits, the newest bubble rests at the bottom and the
 *     older ones scroll up and fade out under the header, like a chat app.
 *
 * Every move is eased, starting from wherever the previous move had got to, so
 * a line shorter than the animation never makes the thread jump.
 *
 * All lengths are in output pixels and all times in seconds.
 */

import type { ThemePalette } from "./themes";

export interface ThreadGeometry {
  /** Height of the visible thread, from its top edge to its bottom edge. */
  viewHeight: number;
  /** Depth of the soft fade at the top; resting bubbles stay below it. */
  fadeTop: number;
  /** Space kept clear under the newest bubble, for its glow. */
  padBottom: number;
}

/** How long the thread takes to settle after a new bubble appears. */
export const SCROLL_SECONDS = 0.55;
/** How long a new bubble takes to slide and fade in. */
export const APPEAR_SECONDS = 0.32;
/** Opacity of bubbles already said, so the one being said stands out. */
export const DIMMED_ALPHA = 0.6;

/** 0 for the first speaker, 1 for the second; anything else is the first. */
export function speakerIndex(speaker: number | undefined): 0 | 1 {
  return speaker === 1 ? 1 : 0;
}

/**
 * Which side each speaker's bubbles hug. The first speaker starts on the side
 * the viewer starts reading from: the right for an Arabic or Persian video,
 * the left for an English or Turkish one.
 */
export function speakerSide(speaker: number | undefined, firstOnRight: boolean): "left" | "right" {
  const second = speakerIndex(speaker) === 1;
  return second !== firstOnRight ? "right" : "left";
}

/**
 * The top of each bubble within the thread, from 0. Bubbles from the same
 * speaker in a row sit closer together, as in a chat app, so a change of
 * speaker reads as a change of turn.
 */
export function stackBubbles(heights: number[], speakers: number[], gap: number, sameSpeakerGap: number): number[] {
  const tops: number[] = [];
  let y = 0;
  heights.forEach((h, i) => {
    if (i > 0) y += speakerIndex(speakers[i]) === speakerIndex(speakers[i - 1]) ? sameSpeakerGap : gap;
    tops.push(y);
    y += Math.max(0, h);
  });
  return tops;
}

/**
 * Where the thread rests once `contentBottom` pixels of it are showing: the
 * offset to add to a bubble's top to get its place in the visible thread.
 */
export function restShift(contentBottom: number, geo: ThreadGeometry): number {
  const room = geo.viewHeight - geo.fadeTop - geo.padBottom;
  if (contentBottom <= room) return geo.fadeTop + (room - contentBottom) / 2;
  return geo.viewHeight - geo.padBottom - contentBottom;
}

/** Smooth start and stop, for a scroll that should not lurch. */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export interface ScrollPlan {
  /** When each bubble appears. */
  appear: number[];
  /** Where each move starts from and settles at. */
  from: number[];
  to: number[];
}

/**
 * One move per bubble, each starting from wherever the previous one had got to
 * by the time the bubble appears.
 */
export function planScroll(
  tops: number[],
  heights: number[],
  appear: number[],
  geo: ThreadGeometry,
  seconds = SCROLL_SECONDS
): ScrollPlan {
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < tops.length; i++) {
    to.push(restShift(tops[i] + heights[i], geo));
    if (i === 0) {
      from.push(to[0]);
      continue;
    }
    const progress = easeInOutCubic((appear[i] - appear[i - 1]) / seconds);
    from.push(from[i - 1] + (to[i - 1] - from[i - 1]) * progress);
  }
  return { appear, from, to };
}

/** The newest bubble on screen at `t`: the last one to have appeared. -1 before the first. */
export function currentBubble(appear: number[], t: number): number {
  let lo = 0;
  let hi = appear.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (appear[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The thread's offset at `t`. */
export function shiftAt(plan: ScrollPlan, t: number, seconds = SCROLL_SECONDS): number {
  if (!plan.to.length) return 0;
  const current = currentBubble(plan.appear, t);
  if (current < 0) return plan.to[0];
  const progress = easeInOutCubic((t - plan.appear[current]) / seconds);
  return plan.from[current] + (plan.to[current] - plan.from[current]) * progress;
}

/**
 * How visible bubble `index` is at `t`: 0 before it appears, fading in as it
 * does, full while it is the newest, and dimmed once the next one arrives.
 */
export function bubbleAlpha(index: number, appear: number[], t: number): number {
  const at = appear[index];
  if (at === undefined || t < at) return 0;
  const fadeIn = Math.min(1, (t - at) / APPEAR_SECONDS);
  const next = appear[index + 1];
  if (next === undefined || t < next) return fadeIn;
  const dim = Math.min(1, (t - next) / APPEAR_SECONDS);
  return fadeIn * (1 - (1 - DIMMED_ALPHA) * dim);
}

/**
 * The bubbles worth drawing at this offset, oldest first. Walks back from the
 * newest and stops at the first one wholly above the top, so a long dialogue
 * costs no more per frame than a short one.
 */
export function visibleRange(
  tops: number[],
  heights: number[],
  current: number,
  shift: number,
  viewHeight: number,
  margin: number
): number[] {
  const out: number[] = [];
  for (let i = current; i >= 0; i--) {
    const y = tops[i] + shift;
    if (y + heights[i] < -margin) break;
    if (y > viewHeight + margin) continue;
    out.push(i);
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* The speakers' colours                                                */
/* ------------------------------------------------------------------ */

/** [r, g, b] from "#rgb", "#rrggbb" or "rgb(a)(…)"; null when unreadable. */
export function parseColor(color: string): [number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (fn) {
    const [r, g, b] = fn[1].split(",").map((v) => Number(v.trim()));
    if ([r, g, b].every((v) => Number.isFinite(v))) return [r, g, b];
  }
  return null;
}

/** The same colour at another opacity; a colour it cannot read is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : color;
}

/** Hue in degrees, saturation and lightness 0..1. */
function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, sat, l];
}

/**
 * Whether two colours read as two different colours at a glance. Distance in
 * RGB is a poor judge of that — two golds of different brightness can be
 * further apart than a blue and a green — so this asks what a viewer sees: a
 * clearly different hue, or a clearly different lightness.
 */
export function colorsDistinct(a: string, b: string): boolean {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a.trim().toLowerCase() !== b.trim().toLowerCase();
  const [h1, s1, l1] = hsl(x);
  const [h2, s2, l2] = hsl(y);
  if (Math.abs(l1 - l2) >= 0.3) return true;
  // A grey has no hue to tell it apart by.
  if (s1 < 0.15 || s2 < 0.15) return false;
  const dh = Math.abs(h1 - h2);
  return Math.min(dh, 360 - dh) >= 35;
}

/**
 * The two speakers' colours, from the theme's own palette so every theme keeps
 * its character: the accent for the first speaker, the second accent for the
 * other. Where a theme's two accents are too alike to tell the speakers apart
 * (Cinematic's are both gold), the second speaker takes the next palette
 * colour that is clearly different.
 */
export function speakerColors(palette: ThemePalette): [string, string] {
  const first = palette.accent;
  const second =
    [palette.accentAlt, palette.translationAlt, palette.translation, palette.text].find((c) =>
      colorsDistinct(c, first)
    ) ?? palette.accentAlt;
  return [first, second];
}

/* ------------------------------------------------------------------ */
/* The speakers' names                                                 */
/* ------------------------------------------------------------------ */

/** What an unnamed speaker is called on screen, in the video's language. */
const DEFAULT_SPEAKER_NAMES: Record<string, [string, string]> = {
  ar: ["المتحدث الأول", "المتحدث الثاني"],
  en: ["Speaker 1", "Speaker 2"],
  fa: ["گوینده‌ی اول", "گوینده‌ی دوم"],
  tr: ["Konuşmacı 1", "Konuşmacı 2"],
};

/**
 * The name on a speaker's bubbles. A name the teacher typed is used as is;
 * none, or the app's English placeholder ("Speaker 1"), becomes the
 * placeholder in the video's own language, so an Arabic video never says
 * "Speaker 1".
 */
export function dialogueSpeakerName(raw: string | undefined, index: 0 | 1, languageId: string): string {
  const name = (raw ?? "").trim();
  if (name && !/^speaker\s*\d+$/i.test(name)) return name;
  return (DEFAULT_SPEAKER_NAMES[languageId] ?? DEFAULT_SPEAKER_NAMES.en)[index];
}
