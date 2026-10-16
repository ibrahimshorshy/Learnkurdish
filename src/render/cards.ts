/**
 * Title and closing cards, added around any kind of video.
 *
 * A card shows text over the video's own background and can carry sound: an AI
 * voice reading the text, a clip you recorded or uploaded, or nothing. The
 * card lasts as long as its sound needs, and never less than a short minimum,
 * so a silent card is still readable. A bilingual video plays each language's
 * clip in turn, and the card lights up the language being spoken.
 *
 * What a card says and what it shows are the same words. The text per language
 * is yours if you wrote one; otherwise it is the default wording below, which
 * is also what the AI voice reads when you leave the text empty. An AI clip
 * made from words you have since changed is left out rather than played over
 * text that no longer matches it.
 *
 * Wrapping shifts the inner video along by the intro's length; everything that
 * works on a PreparedLesson (preview, export, thumbnails) works on the result.
 */

import type { CardSettings, Project } from "../types";
import type { ScheduledClip } from "./audioMixdown";
import type { PreparedLesson } from "./renderLesson";
import { findAudienceLanguage, type VideoStrings } from "../config/languages";
import { drawWrappedText, easeOutCubic, isRtlText } from "./textLayout";
import { BASE, familyFor, loadImage, makeFrameKit } from "./frameKit";
import type { ThemeId } from "./themes";
import { ensureAllFontsLoaded } from "../utils/fontLoader";
import { REEL_SAFE, fitTextStack, safeTextWidth, type PlacedBlock, type StackBlock } from "./safeArea";
import { eventAt, type Timeline, type TimelineEvent } from "./timeline";
import { loadRecordingAudio } from "../audio/useRecordingAudio";
import { sliceClip } from "../audio/audioTools";

export type CardWhich = "intro" | "outro";

export interface CardInput {
  enabled: boolean;
  /** Custom text per shown language, primary first; empty entries use the default wording. */
  texts: string[];
  /** Sound for this card, played one after another. */
  clips: AudioBuffer[];
  /**
   * Which shown language each clip speaks, as an index into the languages, so
   * the card can light up the line being read. Optional: without it nothing is
   * highlighted.
   */
  clipLanguages?: number[];
}

export interface CardsInput {
  intro: CardInput;
  outro: CardInput;
}

export const NO_CARDS: CardsInput = {
  intro: { enabled: false, texts: [], clips: [] },
  outro: { enabled: false, texts: [], clips: [] },
};

/** Card timing, in seconds. */
export const CARD_TIMING = {
  introMin: 2.6,
  outroMin: 3.2,
  /** Sound starts a beat after the card appears. */
  leadIn: 0.3,
  betweenClips: 0.35,
  tail: 0.6,
};

/* ------------------------------------------------------------------ */
/* Words: what a card says, and what it was made from                   */
/* ------------------------------------------------------------------ */

function stringsOf(languageId: string): VideoStrings {
  return (findAudienceLanguage(languageId) ?? findAudienceLanguage("en")!).strings;
}

/**
 * Some on-video labels are set in capitals ("GET READY TO LISTEN"). A voice
 * reads capitals oddly — shouted, or letter by letter — so the spoken version
 * is in sentence case. Scripts without case (Arabic, Persian) pass through.
 */
export function spokenCase(text: string, languageId: string): string {
  const upper = text.toLocaleUpperCase(languageId);
  const lower = text.toLocaleLowerCase(languageId);
  if (text !== upper || upper === lower) return text;
  return lower.charAt(0).toLocaleUpperCase(languageId) + lower.slice(1);
}

/**
 * The words a card uses when you have not written your own: the lesson title
 * (or "get ready to listen") to open, "well done — follow for more" to close.
 * Both are already on the card, so a voice reading them says what is shown.
 */
export function defaultCardText(which: CardWhich, languageId: string, titles: Record<string, string>): string {
  const strings = stringsOf(languageId);
  if (which === "intro") return titles[languageId]?.trim() || spokenCase(strings.getReady, languageId);
  return `${strings.wellDone} ${strings.follow}`;
}

/** What the card says in one language: your text, or the default wording. */
export function cardSpokenText(
  card: Pick<CardSettings, "text">,
  which: CardWhich,
  languageId: string,
  titles: Record<string, string>
): string {
  return card.text[languageId]?.trim() || defaultCardText(which, languageId, titles);
}

/** Stored on an AI clip, so a later change of words or voice shows it is out of date. */
export function clipMadeFrom(voice: string, text: string): string {
  return `${voice}|${text.trim()}`;
}

/** The voice and words an AI clip was made from. Voice names never contain "|". */
export function madeFromParts(madeFrom: string | undefined): { voice: string; text: string } | null {
  if (!madeFrom) return null;
  const bar = madeFrom.indexOf("|");
  if (bar < 0) return null;
  return { voice: madeFrom.slice(0, bar), text: madeFrom.slice(bar + 1) };
}

/**
 * Where one language's clip stands:
 *   missing      — nothing yet
 *   other-source — a clip from the other sound mode (an AI clip while "My voice" is chosen)
 *   ready        — good to use
 *   new-voice    — AI clip, same words, but another voice is picked now; still used
 *   new-words    — AI clip of words that have since changed; left out of the video
 */
export type ClipStatus = "missing" | "other-source" | "ready" | "new-voice" | "new-words";

export function clipStatus(
  card: Pick<CardSettings, "audio" | "text" | "clips" | "voice">,
  which: CardWhich,
  languageId: string,
  titles: Record<string, string>
): ClipStatus {
  const clip = card.clips[languageId];
  if (!clip) return "missing";
  const wanted = card.audio === "recorded" ? "recorded" : "ai";
  if (clip.source !== wanted) return "other-source";
  if (clip.source === "recorded") return "ready";
  const made = madeFromParts(clip.madeFrom);
  // A clip that does not say what it was made from cannot be judged; trust it.
  if (!made) return "ready";
  if (made.text !== cardSpokenText(card, which, languageId, titles)) return "new-words";
  if (made.voice !== card.voice) return "new-voice";
  return "ready";
}

/** Whether a clip in this state goes into the video. */
export function clipIsUsable(status: ClipStatus): boolean {
  return status === "ready" || status === "new-voice";
}

/* ------------------------------------------------------------------ */
/* Timing                                                               */
/* ------------------------------------------------------------------ */

/** How long a card stays up: its clips back to back with a breath around them, or the minimum. */
export function cardLength(card: { enabled: boolean; clips: { duration: number }[] }, minimum: number): number {
  if (!card.enabled) return 0;
  const { leadIn, betweenClips, tail } = CARD_TIMING;
  const sound = card.clips.reduce((sum, c) => sum + c.duration, 0) + Math.max(0, card.clips.length - 1) * betweenClips;
  return card.clips.length ? Math.max(minimum, leadIn + sound + tail) : minimum;
}

/** When each clip starts and ends, from the card's own start. */
export function clipSpans(card: { clips: { duration: number }[] }): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let t = CARD_TIMING.leadIn;
  for (const clip of card.clips) {
    out.push({ start: t, end: t + clip.duration });
    t += clip.duration + CARD_TIMING.betweenClips;
  }
  return out;
}

function cardClips(card: CardInput, at: number): ScheduledClip[] {
  return clipSpans(card).map((span, i) => ({ buffer: card.clips[i], at: at + span.start }));
}

/**
 * The language being spoken at `local` seconds into the card, or null when the
 * whole card should be lit: before the first clip, after the last, or when only
 * one language speaks. A language stays lit through the breath before the next.
 */
export function speakingLanguage(card: CardInput, local: number): number | null {
  const languages = card.clipLanguages;
  if (!languages || languages.length !== card.clips.length) return null;
  if (new Set(languages).size < 2) return null;
  const spans = clipSpans(card);
  const last = spans[spans.length - 1];
  if (!last || local < spans[0].start || local > last.end + 0.2) return null;
  let current = 0;
  for (let i = 0; i < spans.length; i++) if (local >= spans[i].start) current = i;
  return languages[current];
}

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

/**
 * Decodes the card sound a project has for these languages, in their order.
 * "Silent" cards and languages without a usable clip contribute nothing; a clip
 * that fails to decode is skipped rather than failing the video. Each clip is
 * levelled the way the lesson lines are, so the card is as loud as the voice
 * that follows it.
 */
export async function loadCardsInput(project: Project, languages: string[]): Promise<CardsInput> {
  const one = async (card: CardSettings, which: CardWhich): Promise<CardInput> => {
    const clips: AudioBuffer[] = [];
    const clipLanguages: number[] = [];
    if (card.enabled && card.audio !== "silent") {
      for (let index = 0; index < languages.length; index++) {
        const id = languages[index];
        if (!clipIsUsable(clipStatus(card, which, id, project.titles))) continue;
        try {
          const decoded = await loadRecordingAudio(card.clips[id].blob);
          clips.push(sliceClip(decoded.buffer, 0, decoded.buffer.duration, decoded.gain, 0.01));
          clipLanguages.push(index);
        } catch {
          /* skipped */
        }
      }
    }
    return {
      enabled: card.enabled,
      texts: languages.map((id) => card.text[id]?.trim() || ""),
      clips,
      clipLanguages,
    };
  };
  return { intro: await one(project.intro, "intro"), outro: await one(project.outro, "outro") };
}

/* ------------------------------------------------------------------ */
/* Drawing                                                              */
/* ------------------------------------------------------------------ */

interface CardItem {
  text: string;
  size: number;
  weight: string;
  color: string;
  glow?: boolean;
  /** Which shown language this line belongs to, for the speaking highlight. */
  language: number;
  /** Lower gives up space last. */
  yieldOrder: number;
}

/** The band a card's text is centred in, in design units: under the header, over the footer. */
const BAND = { top: 300, bottom: BASE.h - REEL_SAFE.bottom - 120 };
const GAP = 22;
/** How far a language not being spoken fades back. */
const DIMMED = 0.5;

export function wrapWithCards(inner: PreparedLesson, cards: CardsInput): PreparedLesson {
  const introLength = cardLength(cards.intro, CARD_TIMING.introMin);
  const outroLength = cardLength(cards.outro, CARD_TIMING.outroMin);
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
    ...(introLength ? cardClips(cards.intro, 0) : []),
    ...inner.clips.map((c) => ({ ...c, at: c.at + introLength })),
    ...(outroLength ? cardClips(cards.outro, outroStart) : []),
  ];

  const { width, theme, strings, titles, languages } = inner;
  const palette = theme.palette;
  const s = width / BASE.w;
  const cX = width / 2;
  const maxTextW = safeTextWidth(BASE.w, REEL_SAFE) * s;

  /* ---------- what each card shows ---------- */

  const introItems = (): CardItem[] => {
    const items: CardItem[] = [];
    const heading = (titles[languages[0]] || strings[0].tagline).trim();
    items.push({ text: heading, size: isRtlText(heading) ? 50 : 44, weight: "bold", color: palette.text, glow: true, language: 0, yieldOrder: 1 });
    for (let i = 1; i < languages.length; i++) {
      const title = titles[languages[i]]?.trim();
      if (title) items.push({ text: title, size: 28, weight: "600", color: palette.translationAlt, language: i, yieldOrder: 3 });
    }
    strings.forEach((x, i) => {
      const custom = cards.intro.texts[i]?.trim();
      items.push(
        custom
          ? { text: custom, size: i === 0 ? 28 : 24, weight: "600", color: i === 0 ? palette.accent : palette.translationAlt, language: i, yieldOrder: 2 }
          : { text: i === 0 ? `🎧 ${x.getReady}` : x.getReady, size: i === 0 ? 20 : 17, weight: "600", color: palette.accent, language: i, yieldOrder: 4 }
      );
    });
    return items;
  };

  const outroItems = (): CardItem[] => {
    const custom = strings.map((_, i) => cards.outro.texts[i]?.trim() || "");
    const items: CardItem[] = [];
    if (custom.every(Boolean)) {
      // All your own words: they are the headline.
      custom.forEach((text, i) =>
        items.push({ text, size: i === 0 ? 40 : 30, weight: "bold", color: i === 0 ? palette.text : palette.translationAlt, glow: i === 0, language: i, yieldOrder: i === 0 ? 1 : 2 })
      );
      return items;
    }
    // "Well done" for each language that uses the default wording, then each language's line.
    let first = true;
    strings.forEach((x, i) => {
      if (custom[i]) return;
      items.push(
        first
          ? { text: `${x.wellDone} 🎉`, size: 54, weight: "bold", color: palette.text, glow: true, language: i, yieldOrder: 1 }
          : { text: x.wellDone, size: 32, weight: "bold", color: palette.translationAlt, language: i, yieldOrder: 3 }
      );
      first = false;
    });
    strings.forEach((x, i) =>
      items.push({
        text: custom[i] || x.follow,
        size: custom[i] ? 28 : 25,
        weight: "600",
        color: i === 0 ? palette.accentAlt : palette.translationAlt,
        language: i,
        yieldOrder: 2,
      })
    );
    return items;
  };

  /**
   * Places a card's lines once, shrinking them if a long custom text would not
   * fit, and replays that placement every frame — measuring per frame is what
   * makes text twitch.
   */
  const placeOnce = (build: () => CardItem[]) => {
    let placed: { item: CardItem; block: PlacedBlock }[] | null = null;
    return (ctx: CanvasRenderingContext2D) => {
      if (placed) return placed;
      const items = build().filter((item) => item.text.trim());
      const blocks: StackBlock[] = items.map((item, i) => ({
        text: item.text,
        size: item.size,
        lineHeight: 1.3,
        minSize: Math.max(14, item.size * 0.6),
        weight: item.weight,
        family: familyFor(item.text),
        gapBefore: i === 0 ? 0 : GAP,
        yieldOrder: item.yieldOrder,
      }));
      ctx.save();
      const result = fitTextStack(ctx, blocks, { top: BAND.top * s, bottom: BAND.bottom * s, maxWidth: maxTextW, scale: s });
      ctx.restore();
      placed = items.map((item, i) => ({ item, block: result[i] }));
      return placed;
    };
  };

  const introLayout = placeOnce(introItems);
  const outroLayout = placeOnce(outroItems);

  const drawCard = (
    ctx: CanvasRenderingContext2D,
    layout: { item: CardItem; block: PlacedBlock }[],
    alpha: number,
    speaking: number | null
  ) => {
    for (const { item, block } of layout) {
      if (!block.visible) continue;
      ctx.save();
      ctx.globalAlpha = alpha * (speaking === null || speaking === item.language ? 1 : DIMMED);
      ctx.fillStyle = item.color;
      ctx.font = block.font;
      ctx.direction = isRtlText(item.text) ? "rtl" : "ltr";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (item.glow && palette.textGlow) {
        ctx.shadowColor = palette.textGlow;
        ctx.shadowBlur = 12 * s;
      }
      drawWrappedText(ctx, item.text, cX, block.centerY, maxTextW, block.lineHeight);
      ctx.restore();
    }
  };

  const drawIntro = (ctx: CanvasRenderingContext2D, local: number, length: number) => {
    const rise = easeOutCubic(local / 0.5);
    const fadeOut = Math.min(1, Math.max(0, (length - local) / 0.25));
    const layout = introLayout(ctx);
    ctx.save();
    ctx.translate(0, (1 - rise) * 18 * s);
    drawCard(ctx, layout, (0.1 + rise * 0.9) * fadeOut, speakingLanguage(cards.intro, local));
    ctx.restore();
  };

  const drawOutro = (ctx: CanvasRenderingContext2D, local: number) => {
    const rise = easeOutCubic(local / 0.5);
    drawCard(ctx, outroLayout(ctx), 0.1 + rise * 0.9, speakingLanguage(cards.outro, local));
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

/**
 * One card on its own — the title card or the closing card with nothing
 * inside it — for a video project, where the middle is the uploaded video
 * and the card clips are joined on either side of it. Drawn on the theme's
 * background with the logo, tagline and title, exactly like the cards of the
 * other kinds. Null when that card is switched off.
 */
export async function prepareCardOnly(
  which: "intro" | "outro",
  options: { width: number; languages: string[]; titles: Record<string, string>; theme: ThemeId; logoSrc: string },
  cards: CardsInput
): Promise<PreparedLesson | null> {
  const card = cards[which];
  if (!card.enabled) return null;
  await ensureAllFontsLoaded();
  const kit = makeFrameKit({
    width: options.width,
    theme: options.theme,
    languages: options.languages,
    titles: options.titles,
    logo: await loadImage(options.logoSrc),
  });
  const empty: PreparedLesson = {
    width: kit.width,
    height: kit.height,
    timeline: { events: [], total: 0 },
    clips: [],
    theme: kit.theme,
    languages: options.languages,
    titles: options.titles,
    strings: kit.strings,
    draw: kit.drawBackdrop,
    drawBackdrop: kit.drawBackdrop,
  };
  const off: CardInput = { enabled: false, texts: [], clips: [] };
  return wrapWithCards(empty, which === "intro" ? { intro: card, outro: off } : { intro: off, outro: card });
}

