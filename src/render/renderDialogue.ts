/**
 * The dialogue video: a chat thread between the two speakers.
 *
 * A conversation reads badly as centred captions, because nothing on screen
 * says who is talking. Here every line is a bubble on its speaker's side, the
 * speaker's name on top, the Kurdish in the middle and the translation under
 * it. A bubble appears as its line is played, the thread moves up to keep the
 * newest one in view, and the one being spoken is lit in its speaker's colour
 * while the earlier ones dim — so a viewer with the sound off can still follow
 * who says what, and one with the sound on knows which line they are hearing.
 *
 * Same contract as the lesson (PreparedLesson), drawn on the same frame kit,
 * so the title and closing cards, the preview and the exporter all work on it
 * unchanged. Text is measured once per line up front; a frame only replays
 * the measurements. The thread's arithmetic lives in ./dialogueLayout.
 */

import { ensureAllFontsLoaded } from "../utils/fontLoader";
import type { VideoStrings } from "../config/languages";
import { findAudienceLanguage } from "../config/languages";
import { FONTS, type ThemePalette } from "./themes";
import { easeOutBack, easeOutCubic, envelope, isRtlText, layoutText, type TextLayout } from "./textLayout";
import { fitTextStack, type StackBlock } from "./safeArea";
import type { ScheduledClip } from "./audioMixdown";
import { buildTimeline, eventAt } from "./timeline";
import { familyFor, loadImage, makeFrameKit } from "./frameKit";
import { wordTimings, type PrepareOptions, type PreparedLesson } from "./renderLesson";
import {
  APPEAR_SECONDS,
  bubbleAlpha,
  currentBubble,
  planScroll,
  shiftAt,
  speakerIndex,
  speakerSide,
  stackBubbles,
  visibleRange,
  type ThreadGeometry,
} from "./dialogueLayout";

/* ------------------------------------------------------------------ */
/* Colour                                                               */
/* ------------------------------------------------------------------ */

/** [r, g, b] from "#rgb", "#rrggbb" or "rgb(a)(…)"; null when unreadable. */
function parseColor(color: string): [number, number, number] | null {
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

function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : color;
}

function distance(a: string, b: string): number {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return 255;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * The two speakers' colours, from the theme's own palette so every theme keeps
 * its character: the accent for the first speaker, the second accent for the
 * other. A theme whose two accents are close (Cinematic's are both gold) would
 * make the speakers hard to tell apart, so the second falls back to the next
 * palette colour that is clearly different.
 */
export function speakerColors(palette: ThemePalette): [string, string] {
  const first = palette.accent;
  const second =
    [palette.accentAlt, palette.translationAlt, palette.translation, palette.text].find(
      (c) => distance(c, first) >= 70
    ) ?? palette.accentAlt;
  return [first, second];
}

/* ------------------------------------------------------------------ */
/* Speakers                                                             */
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

/* ------------------------------------------------------------------ */
/* Bubble geometry, measured once                                       */
/* ------------------------------------------------------------------ */

interface BubbleText {
  layout: TextLayout;
  font: string;
  lineHeight: number;
  /** Top of the block, from the top of the bubble. */
  top: number;
  color: string;
  rtl: boolean;
}

interface Bubble {
  speaker: 0 | 1;
  side: "left" | "right";
  x: number;
  w: number;
  h: number;
  name: { text: string; font: string; rtl: boolean };
  kurdish: BubbleText | null;
  rest: BubbleText[];
  /** Hairline between the Kurdish and its translation, from the top of the bubble. */
  divider: number | null;
}

/** A rounded box with the corner by the speaker's edge squared off, which reads as a tail. */
function bubblePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  side: "left" | "right"
) {
  const tail = r * 0.25;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, side === "left" ? [tail, r, r, r] : [r, tail, r, r]);
}

/* ------------------------------------------------------------------ */

export async function prepareDialogue(options: PrepareOptions): Promise<PreparedLesson> {
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
  const primaryId = languages[0] ?? "en";

  /* ---------- time ---------- */

  const plays = Math.max(1, Math.min(3, Math.round(look.plays) || 1));
  const turnsOn = look.repeatGapMode !== "off";
  // The listen / your-turn cue only means something when there is a turn or
  // a repeat; a dialogue read straight through gives that space to the thread.
  const cuesOn = turnsOn || plays > 1;

  const timeline = buildTimeline({
    clipDurations: lines.map((l) => l.clip.duration),
    plays,
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

  const firstPlay: number[] = lines.map(() => 0);
  const lineEnd: number[] = lines.map(() => 0);
  for (const e of timeline.events) {
    if (e.line === undefined || !lines[e.line]) continue;
    if (e.type === "play" && e.play === 0) firstPlay[e.line] = e.start;
    if (e.type === "play" || e.type === "turn") lineEnd[e.line] = Math.max(lineEnd[e.line], e.end);
  }
  // A bubble arrives a moment before its voice, inside the silence between
  // lines, so the words are already settling as the first one is heard.
  const appear = firstPlay.map((at, i) => (i === 0 ? at : at - Math.max(0, Math.min(0.15, at - lineEnd[i - 1]))));
  kit.paintTrack(firstPlay, total);

  /* ---------- the thread's box ---------- */

  const threadTop = Math.round(kit.headerBottom + 22 * s);
  const threadBottom = Math.round(cuesOn ? hudY - 46 * s : hudY - 4 * s);
  const viewHeight = Math.max(1, threadBottom - threadTop);
  const geo: ThreadGeometry = { viewHeight, fadeTop: 40 * s, padBottom: 18 * s };
  const threadLeft = cX - maxTextW / 2;
  const threadRight = cX + maxTextW / 2;

  const bubbleMaxW = maxTextW * 0.78;
  const padX = 20 * s;
  const padY = 14 * s;
  const radius = 22 * s;
  const nameSize = 17;
  const nameRow = 22 * s;
  const nameGap = 6 * s;
  const barsWidth = 36 * s;
  const innerMaxW = bubbleMaxW - padX * 2;
  // Tallest the words in one bubble may be: it must fit the space the thread
  // rests in, so even a very long line is seen whole.
  const maxContent = Math.max(80 * s, viewHeight - geo.fadeTop - geo.padBottom - padY * 2 - nameRow - nameGap);

  const [colorA, colorB] = speakerColors(palette);
  const colorOf = (speaker: 0 | 1) => (speaker === 0 ? colorA : colorB);
  const translationColors = [palette.translation, palette.translationAlt, palette.translit];
  const names: [string, string] = [
    dialogueSpeakerName(options.speakers?.[0], 0, primaryId),
    dialogueSpeakerName(options.speakers?.[1], 1, primaryId),
  ];
  // The first speaker starts on the side the viewer starts reading from.
  const firstOnRight = findAudienceLanguage(primaryId)?.rtl ?? false;

  /* ---------- bubbles, measured once ---------- */

  const measure = kit.staticLayer.getContext("2d")!;
  measure.save();

  const bubbles: Bubble[] = lines.map((line) => {
    const speaker = speakerIndex(line.speaker);
    const blocks: StackBlock[] = [
      {
        text: line.kurdish,
        size: 36,
        lineHeight: 1.4,
        minSize: 22,
        weight: "bold",
        family: FONTS.kurdish,
        gapBefore: 0,
        yieldOrder: 0,
      },
      {
        text: look.showTransliteration ? line.transliteration : "",
        size: 18,
        lineHeight: 1.4,
        minSize: 13,
        weight: "italic",
        family: FONTS.latin,
        gapBefore: 4,
        yieldOrder: 10,
        droppable: true,
      },
      ...languages.map((id, i) => {
        const text = line.translations[id] || "";
        return {
          text,
          size: i === 0 ? 24 : 21,
          lineHeight: 1.42,
          minSize: i === 0 ? 16 : 14,
          weight: i === 0 ? "600" : "500",
          family: familyFor(text),
          gapBefore: i === 0 ? 17 : 6,
          yieldOrder: 1 + i,
        };
      }),
    ];
    const placed = fitTextStack(measure, blocks, { top: 0, bottom: maxContent, maxWidth: innerMaxW, scale: s });

    // fitTextStack centres the group in the band; the bubble wants it from the top.
    const visible = placed.filter((p) => p.visible);
    const groupTop = visible.length ? Math.min(...visible.map((p) => p.centerY - (p.lines * p.lineHeight) / 2)) : 0;
    const contentTop = padY + nameRow + nameGap;

    let widest = 0;
    const texts: (BubbleText | null)[] = placed.map((p, i) => {
      if (!p.visible) return null;
      measure.font = p.font;
      const isKurdish = i === 0;
      const layout = layoutText(measure, p.text, innerMaxW, isKurdish && look.karaoke);
      for (const l of layout.lines) widest = Math.max(widest, l.width);
      return {
        layout,
        font: p.font,
        lineHeight: p.lineHeight,
        top: contentTop + (p.centerY - (p.lines * p.lineHeight) / 2 - groupTop),
        color: isKurdish ? palette.text : i === 1 ? palette.translit : translationColors[i - 2] ?? palette.translation,
        rtl: layout.isRtl,
      };
    });

    const nameText = names[speaker];
    const nameFont = `bold ${Math.round(nameSize * s)}px ${familyFor(nameText)}`;
    measure.font = nameFont;
    const nameW = measure.measureText(nameText).width;
    widest = Math.max(widest, nameW + 14 * s + barsWidth);

    const contentBottom = texts.reduce((m, t) => (t ? Math.max(m, t.top + t.layout.lines.length * t.lineHeight) : m), contentTop);
    const w = Math.min(bubbleMaxW, Math.max(widest + padX * 2, 120 * s));
    const h = contentBottom + padY;
    const side = speakerSide(speaker, firstOnRight);

    // A hairline between what is said and what it means, when both are there.
    const [kurdish, translit, ...translations] = texts;
    const firstTranslation = translations.find(Boolean);
    const above = translit ?? kurdish;
    const divider =
      firstTranslation && above
        ? (above.top + above.layout.lines.length * above.lineHeight + firstTranslation.top) / 2
        : null;

    return {
      speaker,
      side,
      x: side === "left" ? threadLeft : threadRight - w,
      w,
      h,
      name: { text: nameText, font: nameFont, rtl: isRtlText(nameText) },
      kurdish,
      rest: [translit, ...translations].filter((t): t is BubbleText => Boolean(t)),
      divider,
    };
  });
  measure.restore();

  const heights = bubbles.map((b) => b.h);
  const tops = stackBubbles(
    heights,
    bubbles.map((b) => b.speaker),
    16 * s,
    8 * s
  );
  const plan = planScroll(tops, heights, appear, geo);
  const wordStarts = wordTimings(lines, look.karaoke);

  /* ---------- the thread's own layer ---------- */

  // Bubbles are drawn into a layer of their own so the top of the thread can
  // fade out under the header instead of being sliced off. Kept on the CPU,
  // like the exporter's canvas, so no frame waits on a GPU read-back.
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = Math.ceil(viewHeight);
  const g = layer.getContext("2d", { willReadFrequently: true })!;
  const mask = g.createLinearGradient(0, 0, 0, layer.height);
  mask.addColorStop(0, "rgba(0, 0, 0, 0)");
  mask.addColorStop(Math.min(0.45, geo.fadeTop / layer.height), "rgba(0, 0, 0, 1)");
  mask.addColorStop(Math.max(0.55, 1 - (geo.padBottom * 0.6) / layer.height), "rgba(0, 0, 0, 1)");
  mask.addColorStop(1, "rgba(0, 0, 0, 0)");

  const bubbleBase = palette.isLight ? "rgba(255, 255, 255, 0.86)" : "rgba(2, 6, 14, 0.4)";

  const drawText = (block: BubbleText, x: number, y: number, w: number, highlight?: { upTo: number; color: string }) => {
    const left = x + padX;
    const right = x + w - padX;
    const anchor = block.rtl ? right : left;
    g.font = block.font;
    g.direction = block.rtl ? "rtl" : "ltr";
    g.textAlign = block.rtl ? "right" : "left";
    g.textBaseline = "middle";
    g.fillStyle = block.color;
    block.layout.lines.forEach((line, k) => {
      const lineY = y + block.top + block.lineHeight * (k + 0.5);
      if (!highlight || !line.words.length) {
        g.fillText(line.text, anchor, lineY);
        return;
      }
      line.words.forEach((word, w) => {
        g.fillStyle = block.layout.lineWordStart[k] + w < highlight.upTo ? highlight.color : block.color;
        g.fillText(word.text, block.rtl ? anchor - word.offset : anchor + word.offset, lineY);
      });
    });
    g.direction = "ltr";
  };

  const drawBubble = (
    b: Bubble,
    y: number,
    alpha: number,
    state: { current: boolean; speaking: number; voice: number; elapsed: number; highlight?: number }
  ) => {
    const color = colorOf(b.speaker);
    g.save();
    g.globalAlpha = alpha;

    bubblePath(g, b.x, y, b.w, b.h, radius, b.side);
    g.fillStyle = bubbleBase;
    g.fill();
    g.fillStyle = withAlpha(color, state.current ? 0.17 : 0.12);
    g.fill();

    // The speaking bubble is outlined in its speaker's colour and glows with
    // the voice; the others keep a quiet edge.
    if (state.current) {
      g.save();
      g.shadowColor = withAlpha(color, palette.isLight ? 0.35 : 0.6);
      g.shadowBlur = (8 + state.speaking * (12 + 16 * state.voice)) * s;
      g.strokeStyle = color;
      g.lineWidth = 2.4 * s;
      g.stroke();
      g.restore();
    } else {
      g.strokeStyle = withAlpha(color, 0.5);
      g.lineWidth = 1.2 * s;
      g.stroke();
    }

    // Name, at the edge its own script starts from; voice bars at the other end.
    const nameY = y + padY + nameRow / 2;
    g.font = b.name.font;
    g.fillStyle = color;
    g.textBaseline = "middle";
    g.direction = b.name.rtl ? "rtl" : "ltr";
    g.textAlign = b.name.rtl ? "right" : "left";
    g.fillText(b.name.text, b.name.rtl ? b.x + b.w - padX : b.x + padX, nameY);
    g.direction = "ltr";
    if (state.speaking > 0) {
      g.save();
      g.globalAlpha = alpha * state.speaking;
      const barsX = b.name.rtl ? b.x + padX : b.x + b.w - padX - barsWidth;
      kit.voiceBars(g, barsX, nameY, state.voice, state.elapsed);
      g.restore();
    }

    if (b.kurdish) {
      drawText(
        b.kurdish,
        b.x,
        y,
        b.w,
        state.highlight !== undefined ? { upTo: state.highlight, color } : undefined
      );
    }
    if (b.divider !== null) {
      g.fillStyle = palette.isLight ? "rgba(4, 23, 48, 0.12)" : "rgba(255, 255, 255, 0.12)";
      g.fillRect(b.x + padX, y + b.divider - 0.5 * s, b.w - padX * 2, Math.max(1, 1 * s));
    }
    for (const block of b.rest) drawText(block, b.x, y, b.w);

    g.restore();
  };

  /* ---------- the frame ---------- */

  function draw(ctx: CanvasRenderingContext2D, elapsed: number, voice: number) {
    kit.drawBackdrop(ctx, elapsed, voice);

    const event = eventAt(timeline, elapsed);
    const current = currentBubble(appear, elapsed);

    if (current >= 0 && bubbles.length) {
      const shift = shiftAt(plan, elapsed);
      g.clearRect(0, 0, layer.width, layer.height);

      for (const i of visibleRange(tops, heights, current, shift, viewHeight, 40 * s)) {
        const b = bubbles[i];
        const alpha = bubbleAlpha(i, appear, elapsed);
        if (alpha <= 0.002) continue;
        let y = tops[i] + shift;

        const isCurrent = i === current;
        let speaking = 0;
        let highlight: number | undefined;
        if (isCurrent && event?.line === i) {
          if (event.type === "play") speaking = envelope(elapsed - event.start, event.end - event.start, 0.15);
          const starts = wordStarts[i];
          if (starts) {
            if (event.type === "play") {
              const local = elapsed - event.start;
              let count = 0;
              while (count < starts.length && starts[count] <= local) count++;
              highlight = count;
            } else {
              highlight = starts.length;
            }
          }
        }

        // The newest bubble slides up from its own side and settles with a
        // small overshoot, anchored at its tail corner.
        const local = elapsed - appear[i];
        if (local < APPEAR_SECONDS) {
          const p = local / APPEAR_SECONDS;
          const scale = 0.9 + 0.1 * easeOutBack(p);
          const anchorX = b.side === "left" ? b.x : b.x + b.w;
          y += (1 - easeOutCubic(p)) * 26 * s;
          g.save();
          g.translate(anchorX, y + b.h);
          g.scale(scale, scale);
          g.translate(-anchorX, -(y + b.h));
          drawBubble(b, y, alpha, { current: isCurrent, speaking, voice, elapsed, highlight });
          g.restore();
          continue;
        }
        drawBubble(b, y, alpha, { current: isCurrent, speaking, voice, elapsed, highlight });
      }

      g.save();
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = mask;
      g.fillRect(0, 0, layer.width, layer.height);
      g.restore();
      ctx.drawImage(layer, 0, threadTop);
    }

    // The cue: listen, listen again, your turn — as in the lesson.
    if (cuesOn && event && event.line !== undefined && lines[event.line]) {
      const isTurn = event.type === "turn";
      if (event.type === "play" || (isTurn && turnsOn)) {
        const hudAlpha = envelope(elapsed - event.start, event.end - event.start, 0.12);
        const play = event.play ?? 0;
        const labelOf = (x: VideoStrings) => (isTurn ? x.yourTurn : play === 0 ? x.listen : x.listenAgain);
        const label = labelOf(primary);
        const text = `${isTurn ? "🗣️" : "🎧"} ${label}${plays > 1 ? `  ${play + 1}/${plays}` : ""}`;
        const speakerColor = colorOf(bubbles[event.line]?.speaker ?? 0);

        ctx.save();
        ctx.globalAlpha = hudAlpha;
        ctx.fillStyle = isTurn ? palette.accentAlt : speakerColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
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
    kit.drawCounter(ctx, Math.max(1, current + 1), lines.length);
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
