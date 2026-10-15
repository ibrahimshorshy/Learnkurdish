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
