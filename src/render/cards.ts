/**
 * Title and closing cards, added around any kind of video.
 *
 * A card shows text over the video's own background and can carry sound: an AI
 * voice reading the text, a clip you recorded or uploaded, or nothing. The
 * card lasts as long as its sound needs, and never less than a short minimum,
 * so a silent card is still readable.
 *
 * Wrapping shifts the inner video along by the intro's length; everything that
 * works on a PreparedLesson (preview, export, thumbnails) works on the result.
 */

import type { CardSettings, Project } from "../types";
import type { ScheduledClip } from "./audioMixdown";
import type { PreparedLesson } from "./renderLesson";
import { drawWrappedText, easeOutCubic, isRtlText } from "./textLayout";
import { BASE, familyFor } from "./frameKit";
import { REEL_SAFE, safeTextWidth } from "./safeArea";
import { eventAt, type Timeline, type TimelineEvent } from "./timeline";
import { loadRecordingAudio } from "../audio/useRecordingAudio";

export interface CardInput {
  enabled: boolean;
  /** Custom text per shown language, primary first; empty entries use the default wording. */
  texts: string[];
  /** Sound for this card, played one after another. */
  clips: AudioBuffer[];
}

export interface CardsInput {
  intro: CardInput;
  outro: CardInput;
}

export const NO_CARDS: CardsInput = {
  intro: { enabled: false, texts: [], clips: [] },
  outro: { enabled: false, texts: [], clips: [] },
};

const INTRO_MIN = 2.6;
const OUTRO_MIN = 3.2;
/** Sound starts a beat after the card appears. */
const LEAD_IN = 0.3;
const BETWEEN_CLIPS = 0.35;
const TAIL = 0.6;

function cardLength(card: CardInput, minimum: number): number {
  if (!card.enabled) return 0;
  const sound = card.clips.reduce((sum, c) => sum + c.duration, 0) + Math.max(0, card.clips.length - 1) * BETWEEN_CLIPS;
  return card.clips.length ? Math.max(minimum, LEAD_IN + sound + TAIL) : minimum;
}

function cardClips(card: CardInput, at: number): ScheduledClip[] {
  const out: ScheduledClip[] = [];
  let t = at + LEAD_IN;
  for (const clip of card.clips) {
    out.push({ buffer: clip, at: t });
    t += clip.duration + BETWEEN_CLIPS;
  }
  return out;
}

/**
 * Decodes the card sound a project has for these languages. "silent" cards and
 * languages without a clip contribute nothing; a clip that fails to decode is
 * skipped rather than failing the video.
 */
export async function loadCardsInput(project: Project, languages: string[]): Promise<CardsInput> {
  const one = async (card: CardSettings): Promise<CardInput> => {
    const clips: AudioBuffer[] = [];
    if (card.enabled && card.audio !== "silent") {
      for (const id of languages) {
        const clip = card.clips[id];
        if (!clip) continue;
        try {
          const decoded = await loadRecordingAudio(clip.blob);
          clips.push(decoded.buffer);
        } catch {
          /* skipped */
        }
      }
    }
    return { enabled: card.enabled, texts: languages.map((id) => card.text[id] || ""), clips };
  };
  return { intro: await one(project.intro), outro: await one(project.outro) };
}

export function wrapWithCards(inner: PreparedLesson, cards: CardsInput): PreparedLesson {
  const introLength = cardLength(cards.intro, INTRO_MIN);
  const outroLength = cardLength(cards.outro, OUTRO_MIN);
  if (!introLength && !outroLength) return inner;

  const innerTotal = inner.timeline.total;
  const outroStart = introLength + innerTotal;
  const total = outroStart + outroLength;

  const events: TimelineEvent[] = [];
  if (introLength) events.push({ type: "intro", start: 0, end: introLength });
  for (const e of inner.timeline.events) events.push({ ...e, start: e.start + introLength, end: e.end + introLength });
  if (outroLength) events.push({ type: "outro", start: outroStart, end: total });
  const timeline: Timeline = { events, total };

  const clips: ScheduledClip[] = [
    ...cardClips(cards.intro, 0),
    ...inner.clips.map((c) => ({ ...c, at: c.at + introLength })),
    ...(outroLength ? cardClips(cards.outro, outroStart) : []),
  ];

  const { width, theme, strings, titles, languages } = inner;
  const palette = theme.palette;
  const s = width / BASE.w;
  const cX = width / 2;
  const maxTextW = safeTextWidth(BASE.w, REEL_SAFE) * s;
  const centerY = (BASE.h - REEL_SAFE.bottom + REEL_SAFE.top) * 0.5 * s;

  const font = (ctx: CanvasRenderingContext2D, weight: string, size: number, text: string) => {
    ctx.font = `${weight} ${Math.round(size * s)}px ${familyFor(text)}`;
    ctx.direction = isRtlText(text) ? "rtl" : "ltr";
  };

  /** Lines of one card, stacked from the centre. Each language gets its own line. */
  const drawStack = (
    ctx: CanvasRenderingContext2D,
    items: { text: string; size: number; weight: string; color: string; glow?: boolean }[]
  ) => {
    const measured = items
      .filter((i) => i.text.trim())
      .map((item) => {
        font(ctx, item.weight, item.size, item.text);
        const lineHeight = item.size * 1.3 * s;
        const lines = Math.max(1, Math.ceil(ctx.measureText(item.text).width / maxTextW));
        return { ...item, lineHeight, height: lines * lineHeight };
      });
    const gap = 22 * s;
    const height = measured.reduce((sum, m) => sum + m.height, 0) + gap * Math.max(0, measured.length - 1);
    let y = centerY - height / 2;
    for (const m of measured) {
      ctx.save();
      ctx.fillStyle = m.color;
      font(ctx, m.weight, m.size, m.text);
      if (m.glow && palette.textGlow) {
        ctx.shadowColor = palette.textGlow;
        ctx.shadowBlur = 12 * s;
      }
      drawWrappedText(ctx, m.text, cX, y + m.height / 2, maxTextW, m.lineHeight);
      ctx.restore();
      y += m.height + gap;
    }
  };

  const drawIntro = (ctx: CanvasRenderingContext2D, local: number, length: number) => {
    const rise = easeOutCubic(local / 0.5);
    const fadeOut = Math.min(1, Math.max(0, (length - local) / 0.25));
    ctx.save();
    ctx.globalAlpha = (0.1 + rise * 0.9) * fadeOut;
    ctx.translate(0, (1 - rise) * 18 * s);
    ctx.textAlign = "center";
    const heading = (titles[languages[0]] || strings[0].tagline).trim();
    const items: Parameters<typeof drawStack>[1] = [
      { text: heading, size: isRtlText(heading) ? 50 : 44, weight: "bold", color: palette.text, glow: true },
    ];
    if (languages.length > 1 && titles[languages[1]]?.trim()) {
      items.push({ text: titles[languages[1]].trim(), size: 28, weight: "600", color: palette.translationAlt });
    }
    const custom = cards.intro.texts.map((t) => t.trim());
    if (custom.some(Boolean)) {
      custom.forEach((text, i) =>
        items.push({ text, size: i === 0 ? 26 : 22, weight: "600", color: i === 0 ? palette.accent : palette.translationAlt })
      );
    } else {
      strings.forEach((x, i) =>
        items.push({ text: i === 0 ? `🎧 ${x.getReady}` : x.getReady, size: i === 0 ? 20 : 17, weight: "600", color: palette.accent })
      );
    }
    drawStack(ctx, items);
    ctx.restore();
  };

  const drawOutro = (ctx: CanvasRenderingContext2D, local: number) => {
    const rise = easeOutCubic(local / 0.5);
    ctx.save();
    ctx.globalAlpha = 0.1 + rise * 0.9;
    ctx.textAlign = "center";
    const custom = cards.outro.texts.map((t) => t.trim());
    const items: Parameters<typeof drawStack>[1] = [
      { text: `${strings[0].wellDone} 🎉`, size: 54, weight: "bold", color: palette.text, glow: true },
    ];
    strings.slice(1).forEach((x) => items.push({ text: x.wellDone, size: 32, weight: "bold", color: palette.translationAlt }));
    strings.forEach((x, i) =>
      items.push({
        text: custom[i] || x.follow,
        size: 25,
        weight: "600",
        color: i === 0 ? palette.accentAlt : palette.translationAlt,
      })
    );
    drawStack(ctx, items);
    ctx.restore();
  };

  return {
    ...inner,
    timeline,
    clips,
    draw(ctx, elapsed, voice) {
      if (introLength && elapsed < introLength) {
        inner.drawBackdrop(ctx, elapsed, voice);
        drawIntro(ctx, elapsed, introLength);
        return;
      }
      if (outroLength && elapsed >= outroStart) {
        inner.drawBackdrop(ctx, elapsed, voice);
        drawOutro(ctx, elapsed - outroStart);
        return;
      }
      inner.draw(ctx, elapsed - introLength, voice);
    },
  };
}

/** The event under a moment, for callers that want to know whether a card is showing. */
export function cardAt(prepared: PreparedLesson, t: number): "intro" | "outro" | null {
  const e = eventAt(prepared.timeline, t);
  return e?.type === "intro" || e?.type === "outro" ? e.type : null;
}
