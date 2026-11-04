/**
 * The lesson video: your voice, line by line, with the Kurdish on screen, how
 * to pronounce it, and what it means in the viewer's language — played once to
 * three times with a pause after each for the viewer to repeat.
 *
 * This file also defines the shape every kind of video is prepared into
 * (PreparedLesson), which the preview, the exporter and the intro/outro cards
 * all work with. Title and closing cards are added around it by ./cards.
 */

import { ensureAllFontsLoaded } from "../utils/fontLoader";
import type { VideoStrings } from "../config/languages";
import { FONTS, type ThemeId, type ThemeInfo } from "./themes";
import { drawWrappedText, easeOutCubic, envelope, isRtlText } from "./textLayout";
import { fitTextStack, type PlacedBlock } from "./safeArea";
import type { ScheduledClip } from "./audioMixdown";
import { analyzeSpeech, alignWordsToAudio, splitWords } from "./audioAlign";
import { buildTimeline, eventAt, type RepeatGapMode, type Timeline } from "./timeline";
import { toMono } from "../audio/audioTools";
import { familyFor, loadImage, makeFrameKit } from "./frameKit";

export { drawStill, stillMoment, startPreview, renderVideo } from "./videoOutput";
export type { PreviewHandle, RenderResult } from "./videoOutput";

export type ResolutionId = "720p" | "1080p" | "1440p";

export const RESOLUTIONS: Record<ResolutionId, { label: string; width: number; blurb: string }> = {
  "720p": { label: "720p", width: 720, blurb: "Quickest to make. Fine for a draft." },
  "1080p": { label: "1080p", width: 1080, blurb: "What Instagram and TikTok actually serve." },
  "1440p": { label: "1440p", width: 1440, blurb: "Sharper on desktop, about twice as slow." },
};

export const DEFAULT_RESOLUTION: ResolutionId = "1080p";

export interface VideoLine {
  id: string;
  kurdish: string;
  transliteration: string;
  translations: Record<string, string>;
  /** The finished clip of your voice for this line. */
  clip: AudioBuffer;
  /** Dialogue: 0 or 1. */
  speaker: number;
  /** Story: which paragraph the line belongs to, from 0. */
  paragraph: number;
}

export interface LessonLook {
  theme: ThemeId;
  plays: number;
  repeatGapMode: RepeatGapMode;
  repeatGapSeconds: number;
  gapBetweenLines: number;
  showTransliteration: boolean;
  karaoke: boolean;
  /** Story: translate the sentence being read, or the whole paragraph. */
  storyTranslation: "sentence" | "paragraph";
}

export interface PrepareOptions {
  /** Output width in pixels; the height is 16:9 of it. */
  width: number;
  lines: VideoLine[];
  /** Audience languages shown, in order. The first one labels the video. */
  languages: string[];
  titles: Record<string, string>;
  look: LessonLook;
  logoSrc: string;
  /** Dialogue: speaker names, in order. */
  speakers?: string[];
}

/** Any kind of video, ready to draw and to play. */
export interface PreparedLesson {
  width: number;
  height: number;
  timeline: Timeline;
  clips: ScheduledClip[];
  theme: ThemeInfo;
  languages: string[];
  titles: Record<string, string>;
  strings: VideoStrings[];
  /** Paints the frame at `elapsed` seconds. `voice` is the current level, 0..1. */
  draw: (ctx: CanvasRenderingContext2D, elapsed: number, voice: number) => void;
  /** The background and header only — what a title or closing card sits on. */
  drawBackdrop: (ctx: CanvasRenderingContext2D, elapsed: number, voice: number) => void;
}

/** Karaoke word timings for each line, measured from its clip rather than guessed. */
export function wordTimings(lines: VideoLine[], enabled: boolean): (number[] | null)[] {
  return lines.map((line) => {
    if (!enabled) return null;
    const words = splitWords(line.kurdish);
    if (!words.length) return null;
    return alignWordsToAudio(words, analyzeSpeech(toMono(line.clip), line.clip.sampleRate));
  });
}

/* ------------------------------------------------------------------ */

export async function prepareLesson(options: PrepareOptions): Promise<PreparedLesson> {
  const { lines, languages, titles, look } = options;

  await ensureAllFontsLoaded();
  const kit = makeFrameKit({
    width: options.width,
    theme: look.theme,
    languages,
    titles,
    logo: await loadImage(options.logoSrc),
  });
  const { theme, strings, width, height, s, cX, maxTextW, hudY } = kit;
  const palette = theme.palette;
  const primary = strings[0];

  const timeline = buildTimeline({
    clipDurations: lines.map((l) => l.clip.duration),
    plays: look.plays,
    repeatGapMode: look.repeatGapMode,
    repeatGapSeconds: look.repeatGapSeconds,
    gapBetweenLines: look.gapBetweenLines,
    intro: false,
    outro: false,
  });
  const total = timeline.total;

  const clips: ScheduledClip[] = timeline.events
    .filter((e) => e.type === "play" && e.line !== undefined)
    .map((e) => ({ buffer: lines[e.line!].clip, at: e.start }));

  // Where each line's block of events begins and ends, for the fades.
  const lineSpan = lines.map((_, i) => {
    const own = timeline.events.filter((e) => e.line === i);
    return { start: own[0]?.start ?? 0, end: own[own.length - 1]?.end ?? 0 };
  });
  kit.paintTrack(
    lineSpan.map((span) => span.start),
    total
  );

  /* ---------- text, measured once per line ---------- */

  const bandTop = kit.headerBottom + 40 * s;
  const bandBottom = hudY - 50 * s;
  const measure = kit.staticLayer.getContext("2d")!;

  const stacks: PlacedBlock[][] = lines.map((line) => {
    const translationBlocks = languages.map((id, i) => {
      const text = line.translations[id] || "";
      return {
        text,
        size: i === 0 ? 32 : 27,
        lineHeight: 1.45,
        minSize: i === 0 ? 19 : 17,
        weight: i === 0 ? "bold" : "600",
        family: familyFor(text),
        gapBefore: i === 0 ? 30 : 18,
        yieldOrder: 1 + i,
      };
    });
    return fitTextStack(
      measure,
      [
        {
          text: line.kurdish,
          size: 60,
          lineHeight: 1.3,
          minSize: 30,
          weight: "bold",
          family: FONTS.kurdish,
          gapBefore: 0,
          yieldOrder: 0,
        },
        {
          text: look.showTransliteration ? line.transliteration : "",
          size: 23,
          lineHeight: 1.4,
          minSize: 15,
          weight: "italic",
          family: FONTS.latin,
          gapBefore: 16,
          yieldOrder: 10,
          droppable: true,
        },
        ...translationBlocks,
      ],
      { top: bandTop, bottom: bandBottom, maxWidth: maxTextW, scale: s }
    );
  });

  const wordStarts = wordTimings(lines, look.karaoke);
  const translationColors = [palette.translation, palette.translationAlt, palette.translit];

  /* ---------- the frame ---------- */

  function draw(ctx: CanvasRenderingContext2D, elapsed: number, voice: number) {
    kit.drawBackdrop(ctx, elapsed, voice);

    const event = eventAt(timeline, elapsed);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    if (event && event.line !== undefined && lines[event.line]) {
      const index = event.line;
      const span = lineSpan[index];
      const blockLocal = elapsed - span.start;
      const blockLength = span.end - span.start;
      let alpha = 1;
      if (blockLocal < 0.2) alpha = easeOutCubic(blockLocal / 0.2);
      else if (blockLength - blockLocal < 0.12) alpha = Math.max(0, (blockLength - blockLocal) / 0.12);

      const [kurdish, translit, ...translations] = stacks[index];

      // Kurdish, highlighted word by word while it plays if karaoke is on.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = palette.text;
      ctx.font = kurdish.font;
      if (palette.textGlow) {
        ctx.shadowColor = palette.textGlow;
        ctx.shadowBlur = 12 * s;
      }
      let highlight: number | undefined;
      const starts = wordStarts[index];
      if (starts) {
        if (event.type === "play") {
          const local = elapsed - event.start;
          let count = 0;
          while (count < starts.length && starts[count] <= local) count++;
          highlight = count;
        } else if (event.type === "turn" || event.type === "gap") {
          highlight = starts.length;
        }
      }
      drawWrappedText(
        ctx,
        kurdish.text,
        cX,
        kurdish.centerY,
        maxTextW,
        kurdish.lineHeight,
        highlight !== undefined ? { highlightColor: palette.accent, highlightUpTo: highlight } : {}
      );
      ctx.restore();

      if (translit.visible) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.translit;
        ctx.font = translit.font;
        drawWrappedText(ctx, translit.text, cX, translit.centerY, maxTextW, translit.lineHeight);
        ctx.restore();
      }

      translations.forEach((block, i) => {
        if (!block.visible) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = translationColors[i] ?? palette.translation;
        ctx.font = block.font;
        drawWrappedText(ctx, block.text, cX, block.centerY, maxTextW, block.lineHeight);
        ctx.restore();
      });

      // The cue: listen, listen again, your turn.
      if (event.type === "play" || event.type === "turn") {
        const plays = Math.max(1, Math.min(3, Math.round(look.plays) || 1));
        const hudAlpha = envelope(elapsed - event.start, event.end - event.start, 0.12);
        const isTurn = event.type === "turn";
        const play = event.play ?? 0;
        const labelOf = (x: VideoStrings) => (isTurn ? x.yourTurn : play === 0 ? x.listen : x.listenAgain);
        const label = labelOf(primary);
        const text = `${isTurn ? "🗣️" : "🎧"} ${label}${plays > 1 ? `  ${play + 1}/${plays}` : ""}`;

        ctx.save();
        ctx.globalAlpha = hudAlpha;
        ctx.fillStyle = isTurn ? palette.accentAlt : palette.accent;
        kit.setFont(ctx, "bold", 22, label);
        ctx.direction = isRtlText(label) ? "rtl" : "ltr";
        const textW = ctx.measureText(text).width;
        ctx.fillText(text, cX, hudY);
        ctx.direction = "ltr";
        if (!isTurn) kit.voiceBars(ctx, cX + textW / 2 + 14 * s, hudY - 8 * s, voice, elapsed);
        // The other languages' cue, smaller and on its own line, so scripts
        // running in opposite directions never share one.
        strings.slice(1).forEach((x, i) => {
          const other = labelOf(x);
          ctx.globalAlpha = hudAlpha * 0.8;
          kit.setFont(ctx, "600", 15, other);
          kit.centeredText(ctx, other, hudY + (22 + i * 18) * s);
        });
        ctx.restore();
      }
    }

    kit.drawProgress(ctx, total > 0 ? elapsed / total : 0);
    kit.drawCounter(ctx, event?.line !== undefined ? event.line + 1 : 1, lines.length);
  }

  return {
    width,
    height,
    timeline,
    clips,
    theme,
    languages,
    titles,
    strings,
    draw,
    drawBackdrop: kit.drawBackdrop,
  };
}
