/**
 * The story video: a text read aloud, paragraph by paragraph.
 *
 * The paragraph being read is on screen as one flowing block of Kurdish, the
 * way it is printed, so the viewer reads along rather than watching captions
 * flash past. The sentence being heard is lit in the theme's accent on a soft
 * marker band; the sentences already read stay at full strength and the ones
 * still to come wait dimmed, so the eye always knows where the voice is. With
 * karaoke on, the light moves word by word inside the sentence.
 *
 * Under the Kurdish, the translation: either the sentence being read (with its
 * pronunciation, if wanted), or the whole paragraph with the current
 * sentence's part lit — look.storyTranslation.
 *
 * A paragraph too long for the frame first gets smaller type, down to a size
 * that is still comfortable on a phone; past that it is cut into pages of
 * whole sentences. The type size is then the same on every page, so the
 * video reads like one book rather than a run of differently sized cards.
 * Everything is measured once here; a frame only replays the measurements.
 *
 * Same contract as the lesson (PreparedLesson), on the same frame kit, so the
 * title and closing cards, the preview and the exporter work on it unchanged.
 * The page and timing arithmetic is in ./storyLayout.
 */

import { ensureAllFontsLoaded } from "../utils/fontLoader";
import { findAudienceLanguage, type VideoStrings } from "../config/languages";
import { FONTS } from "./themes";
import {
  drawWrappedText,
  easeOutCubic,
  envelope,
  firstStrongDirection,
  isRtlText,
  layoutText,
  type TextDirection,
} from "./textLayout";
import type { ScheduledClip } from "./audioMixdown";
import { splitWords } from "./audioAlign";
import { buildTimeline, eventAt } from "./timeline";
import { familyFor, loadImage, makeFrameKit } from "./frameKit";
import { wordTimings, type PrepareOptions, type PreparedLesson } from "./renderLesson";
import {
  lineSpans,
  pageAlpha,
  pageAt,
  pageWindows,
  paginate,
  paragraphGroups,
  placeLine,
  sentenceState,
  withPauses,
  wordDirections,
  wordsSpoken,
  type WordBox,
} from "./storyLayout";

/* ------------------------------------------------------------------ */
/* Type and timing                                                      */
/* ------------------------------------------------------------------ */

interface TypeSpec {
  /** In design units, at scale 1. */
  size: number;
  lineHeight: number;
  weight: string;
}

/**
 * Medium weight for the Kurdish: bold is right for one line on a card and
 * heavy across a paragraph. Arabic script needs the generous line height.
 */
const KURDISH: TypeSpec = { size: 38, lineHeight: 1.66, weight: "500" };
const TRANSLIT: TypeSpec = { size: 20, lineHeight: 1.4, weight: "italic" };
/** One sentence's translation, per language shown: the first larger. */
const SENTENCE_TRANSLATION: TypeSpec[] = [
  { size: 27, lineHeight: 1.42, weight: "600" },
  { size: 23, lineHeight: 1.42, weight: "500" },
];
/** A whole paragraph's translation is longer, so it starts smaller. */
const PARAGRAPH_TRANSLATION: TypeSpec[] = [
  { size: 25, lineHeight: 1.5, weight: "500" },
  { size: 21, lineHeight: 1.5, weight: "500" },
];
/** Between the Kurdish and the translations, and between translation blocks. */
const DIVIDER_GAP = 40;
const BLOCK_GAP = 14;

/** Every size is the spec times a scale; the scale walks down in these steps. */
const SCALE_STEP = 0.94;
/**
 * Smallest scale a paragraph is shrunk to before it is cut into pages: Kurdish
 * at about 30, the lesson's own minimum. Any smaller and a paragraph becomes a
 * wall of small text — and, the size being shared, so does every other page.
 */
const MIN_SCALE = 0.8;
/** Pages are packed at this scale, then each page may grow back if it has room. */
const PACK_SCALE = 0.9;
/** A single sentence too long for a page even at MIN_SCALE may go this small. */
const FLOOR_SCALE = 0.42;

/** Extra silence between paragraphs, and between pages of one paragraph, in seconds. */
const PARAGRAPH_PAUSE = 0.7;
const PAGE_PAUSE = 0.35;
/** A page fades out, then the next fades in, over this long each. */
const PAGE_FADE = 0.3;
/** How far a new page rises as it fades in, in design units. */
const PAGE_RISE = 14;
/** How long the marker band and a sentence's translation take to appear. */
const SENTENCE_FADE = 0.22;

/** Strength of sentences already read, and still to come. */
const PAST_ALPHA = 0.9;
const FUTURE_ALPHA = 0.34;
/** The marker band behind the current sentence. */
const BAND_ALPHA = 0.17;
/** Paragraph translation: the parts not being read. */
const TRANSLATION_PAST_ALPHA = 0.62;
const TRANSLATION_FUTURE_ALPHA = 0.4;

/* ------------------------------------------------------------------ */
/* Text with sentences inside it                                        */
/* ------------------------------------------------------------------ */

interface RichWord {
  /** A word, or part of one: a run of the other direction has its outer punctuation split off. */
  text: string;
  /** Where to draw it: the right edge for right-to-left text, the left edge otherwise. */
  x: number;
  left: number;
  right: number;
  /** Which sentence (line index) it belongs to, and its place in that sentence. */
  sentence: number;
  index: number;
  /** Drawn in this direction rather than the block's: a word inside a run of the other direction. */
  dir?: TextDirection;
}

interface RichLine {
  words: RichWord[];
  /** Middle of the line, from the top of the block. */
  y: number;
}

interface RichBlock {
  font: string;
  rtl: boolean;
  lineHeight: number;
  height: number;
  lines: RichLine[];
  /** Per sentence: the stretch of each text line it covers, for the marker band. */
  spans: Map<number, { line: number; left: number; right: number }[]>;
}

type Align = "justify" | "start";

/**
 * Lays out several sentences as one paragraph, remembering which sentence each
 * word belongs to so a frame can colour them without measuring anything.
 *
 * The block is as wide as its longest line and centred in the column; inside
 * it, lines start at the reading edge ("start"), or also reach the far edge
 * ("justify", the way Kurdish books are set) except the last line. Sorani
 * words are long, so some breaks leave a lot of room; if any line's gaps would
 * have to stretch past about twice their size, the block is left ragged rather
 * than torn apart.
 *
 * Every word is drawn on its own, which keeps the canvas from reordering
 * words of the other direction the way a browser would; placeLine does that
 * instead, so "J. K. Rowling" in a Kurdish sentence reads in its own order.
 * `direction` is the block's, when its language is known; otherwise it is
 * right to left if the text holds any right-to-left letter.
 */
function layoutRich(
  ctx: CanvasRenderingContext2D,
  parts: { text: string; sentence: number }[],
  font: string,
  lineHeight: number,
  maxWidth: number,
  centerX: number,
  align: Align,
  direction?: TextDirection
): RichBlock {
  const used = parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
  const owners: { sentence: number; index: number }[] = [];
  for (const part of used) splitWords(part.text).forEach((_, index) => owners.push({ sentence: part.sentence, index }));
  const ownerOf = (k: number) => owners[k] ?? { sentence: used[used.length - 1]?.sentence ?? 0, index: 0 };

  ctx.font = font;
  const text = used.map((p) => p.text).join(" ");
  const layout = layoutText(ctx, text, maxWidth, true, direction);
  const rtl = layout.isRtl;
  const base: TextDirection = rtl ? "rtl" : "ltr";
  const previous = ctx.direction;
  ctx.direction = base;
  const space = ctx.measureText(" ").width;
  ctx.direction = previous;
  /** Punctuation split off a run is drawn in the block's direction, so measured in it. */
  const measurePiece = (piece: string) => {
    const before = ctx.direction;
    ctx.font = font;
    ctx.direction = base;
    const width = ctx.measureText(piece).width;
    ctx.direction = before;
    return width;
  };

  // Which way each word reads, sentence by sentence.
  const allWords = layout.lines.flatMap((line) => line.words.map((w) => w.text));
  const dirs = wordDirections(
    allWords,
    base,
    allWords.map((_, k) => ownerOf(k).sentence)
  );

  const blockWidth = layout.lines.reduce((w, l) => Math.max(w, l.width), 0);
  const startEdge = rtl ? centerX + blockWidth / 2 : centerX - blockWidth / 2;
  const spans = new Map<number, { line: number; left: number; right: number }[]>();

  // Justify every line but the last, or none: a block where some lines reach
  // the far edge and others stop short looks like a mistake.
  const stretchOf = (line: (typeof layout.lines)[number]) =>
    line.words.length > 1 ? (blockWidth - line.width) / (line.words.length - 1) : 0;
  const justify =
    align === "justify" &&
    layout.lines.length > 1 &&
    layout.lines.slice(0, -1).every((line) => line.words.length > 1 && stretchOf(line) <= space * 2.2);

  const lines: RichLine[] = layout.lines.map((line, li) => {
    const isLast = li === layout.lines.length - 1;
    const extra = justify && !isLast ? stretchOf(line) : 0;
    const first = layout.lineWordStart[li];
    // Each word's box in reading order from the start edge...
    const boxes: WordBox[] = line.words.map((word, wi) => {
      const offset = word.offset + extra * wi;
      const x = rtl ? startEdge - offset : startEdge + offset;
      return {
        text: word.text,
        left: rtl ? x - word.width : x,
        right: rtl ? x : x + word.width,
        dir: dirs[first + wi],
        group: ownerOf(first + wi).sentence,
      };
    });
    // ...then runs of the other direction turned round inside their room.
    const words: RichWord[] = placeLine(boxes, base, measurePiece).map((piece) => {
      const owner = ownerOf(first + piece.word);
      return {
        text: piece.text,
        x: rtl ? piece.right : piece.left,
        left: piece.left,
        right: piece.right,
        sentence: owner.sentence,
        index: owner.index,
        ...(piece.dir !== base ? { dir: piece.dir } : {}),
      };
    });
    for (const word of words) {
      const list = spans.get(word.sentence) ?? [];
      const last = list[list.length - 1];
      if (last && last.line === li) {
        last.left = Math.min(last.left, word.left);
        last.right = Math.max(last.right, word.right);
      } else {
        list.push({ line: li, left: word.left, right: word.right });
      }
      spans.set(word.sentence, list);
    }
    return { words, y: (li + 0.5) * lineHeight };
  });

  return { font, rtl, lineHeight, height: lines.length * lineHeight, lines, spans };
}

/** Draws one word of a block; the caller has set the block's font, direction and alignment. */
function fillWord(ctx: CanvasRenderingContext2D, block: RichBlock, word: RichWord, y: number) {
  if (!word.dir) {
    ctx.fillText(word.text, word.x, y);
    return;
  }
  ctx.direction = word.dir;
  ctx.fillText(word.text, word.x, y);
  ctx.direction = block.rtl ? "rtl" : "ltr";
}

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

interface PlacedText {
  text: string;
  font: string;
  lineHeight: number;
  /** Middle of the block. */
  centerY: number;
  color: string;
  /** Which way it reads. Unset: worked out from the text, as for the pronunciation. */
  direction?: TextDirection;
}

interface Page {
  /** Which paragraph, from 0, and how many pages it has. */
  paragraph: number;
  first: number;
  last: number;
  kurdish: RichBlock;
  kurdishTop: number;
  /** Where the short rule between the Kurdish and the translations sits; null when there is none. */
  dividerY: number | null;
  scale: number;
  /** "sentence": each sentence's pronunciation and translations, keyed by line index. */
  sentenceBlocks: Map<number, PlacedText[]>;
  /** "paragraph": one block per language, the page's sentences together. */
  paragraphBlocks: { block: RichBlock; top: number; color: string }[];
}

/* ------------------------------------------------------------------ */

export async function prepareStory(options: PrepareOptions): Promise<PreparedLesson> {
  const { lines, languages, titles, look } = options;
  const mode = look.storyTranslation === "paragraph" ? "paragraph" : "sentence";

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
  const translationColors = [palette.translation, palette.translationAlt, palette.translit];

  /* ---------- measuring ---------- */

  const measure = kit.staticLayer.getContext("2d")!;
  const bandTop = kit.headerBottom + 34 * s;
  const bandBottom = hudY - 46 * s;
  const bandHeight = Math.max(0, bandBottom - bandTop);

  const px = (spec: TypeSpec, k: number) => Math.max(1, Math.round(spec.size * k * s));
  const fontOf = (spec: TypeSpec, k: number, family: string) => `${spec.weight} ${px(spec, k)}px ${family}`;
  const lineHeightOf = (spec: TypeSpec, k: number) => px(spec, k) * spec.lineHeight;
  const countLines = (text: string, font: string, direction?: TextDirection) => {
    if (!text.trim()) return 0;
    measure.font = font;
    return layoutText(measure, text, maxTextW, false, direction).lines.length;
  };
  /**
   * A translation reads the way its language does, whatever words it quotes:
   * an English sentence that starts with a Kurdish word is still English.
   * A language the app does not know goes by its first letter.
   */
  const directionOf = (id: string, text: string): TextDirection => {
    const language = findAudienceLanguage(id);
    if (language) return language.rtl ? "rtl" : "ltr";
    return firstStrongDirection(text) ?? "ltr";
  };
  const specFor = (list: TypeSpec[], i: number) => list[Math.min(i, list.length - 1)];
  const translationOf = (line: number, id: string) => (lines[line].translations[id] || "").trim();
  const kurdishOf = (first: number, last: number) =>
    lines
      .slice(first, last + 1)
      .map((l) => l.kurdish.trim())
      .join(" ");
  const paragraphTranslation = (first: number, last: number, id: string) =>
    lines
      .slice(first, last + 1)
      .map((_, i) => translationOf(first + i, id))
      .filter(Boolean)
      .join(" ");

  /** One sentence's pronunciation and translations, stacked: their height. */
  const sentenceZone = (line: number, k: number, translit: boolean): number => {
    const heights: number[] = [];
    if (translit && lines[line].transliteration.trim()) {
      heights.push(countLines(lines[line].transliteration, fontOf(TRANSLIT, k, FONTS.latin)) * lineHeightOf(TRANSLIT, k));
    }
    languages.forEach((id, i) => {
      const text = translationOf(line, id);
      if (!text) return;
      const spec = specFor(SENTENCE_TRANSLATION, i);
      heights.push(countLines(text, fontOf(spec, k, familyFor(text)), directionOf(id, text)) * lineHeightOf(spec, k));
    });
    return heights.reduce((a, b) => a + b, 0) + Math.max(0, heights.length - 1) * BLOCK_GAP * k * s;
  };

  const paragraphZone = (first: number, last: number, k: number): number => {
    const heights: number[] = [];
    languages.forEach((id, i) => {
      const text = paragraphTranslation(first, last, id);
      if (!text) return;
      const spec = specFor(PARAGRAPH_TRANSLATION, i);
      heights.push(countLines(text, fontOf(spec, k, familyFor(text)), directionOf(id, text)) * lineHeightOf(spec, k));
    });
    return heights.reduce((a, b) => a + b, 0) + Math.max(0, heights.length - 1) * BLOCK_GAP * k * s;
  };

  /** Height of the translations under a page: the tallest sentence's, so nothing moves within a page. */
  const zoneHeight = (first: number, last: number, k: number, translit: boolean): number => {
    if (mode === "paragraph") return paragraphZone(first, last, k);
    let tallest = 0;
    for (let i = first; i <= last; i++) tallest = Math.max(tallest, sentenceZone(i, k, translit));
    return tallest;
  };

  const stackHeight = (first: number, last: number, k: number, translit: boolean): number => {
    const kurdish = countLines(kurdishOf(first, last), fontOf(KURDISH, k, FONTS.kurdish)) * lineHeightOf(KURDISH, k);
    const zone = zoneHeight(first, last, k, translit);
    return kurdish + (zone > 0 ? DIVIDER_GAP * k * s + zone : 0);
  };

  const wantTranslit = mode === "sentence" && look.showTransliteration;

  /** The largest scale (down to `floor`) at which a page fits, pronunciation kept if it can be. */
  const bestScale = (first: number, last: number, floor: number): { k: number; translit: boolean } | null => {
    for (const translit of wantTranslit ? [true, false] : [false]) {
      for (let k = 1; k >= floor - 1e-9; k *= SCALE_STEP) {
        if (stackHeight(first, last, k, translit) <= bandHeight) return { k, translit };
      }
    }
    return null;
  };

  /* ---------- paragraphs into pages ---------- */

  const groups = paragraphGroups(lines.map((l) => l.paragraph));
  const plans: { paragraph: number; first: number; last: number; fit: { k: number; translit: boolean }; forced: boolean }[] = [];

  groups.forEach((group, paragraph) => {
    const first = group[0];
    const last = group[group.length - 1];
    const whole = bestScale(first, last, MIN_SCALE);
    if (whole) {
      plans.push({ paragraph, first, last, fit: whole, forced: false });
      return;
    }
    const ranges = paginate(
      group.length,
      (a, b) => stackHeight(first + a, first + b, PACK_SCALE, wantTranslit) <= bandHeight,
      (a, b) => stackHeight(first + a, first + b, PACK_SCALE, wantTranslit)
    );
    for (const [a, b] of ranges) {
      const fit = bestScale(first + a, first + b, MIN_SCALE);
      plans.push({
        paragraph,
        first: first + a,
        last: first + b,
        fit: fit ?? bestScale(first + a, first + b, FLOOR_SCALE) ?? { k: FLOOR_SCALE, translit: false },
        forced: !fit,
      });
    }
  });

  // One type size for the whole story: the smallest any page needed.
  const storyScale = plans.reduce((k, plan) => (plan.forced ? k : Math.min(k, plan.fit.k)), 1);

  const pages: Page[] = plans.map((plan) => {
    const k = plan.forced ? plan.fit.k : storyScale;
    const translit = wantTranslit && (plan.forced ? plan.fit.translit : stackHeight(plan.first, plan.last, k, true) <= bandHeight);
    const total = stackHeight(plan.first, plan.last, k, translit);
    const top = bandTop + Math.max(0, (bandHeight - total) / 2);

    const sentences: { text: string; sentence: number }[] = [];
    for (let i = plan.first; i <= plan.last; i++) sentences.push({ text: lines[i].kurdish, sentence: i });
    const kurdish = layoutRich(
      measure,
      sentences,
      fontOf(KURDISH, k, FONTS.kurdish),
      lineHeightOf(KURDISH, k),
      maxTextW,
      cX,
      "justify"
    );

    const zone = zoneHeight(plan.first, plan.last, k, translit);
    const zoneTop = top + kurdish.height + DIVIDER_GAP * k * s;
    const gap = BLOCK_GAP * k * s;

    const sentenceBlocks = new Map<number, PlacedText[]>();
    const paragraphBlocks: Page["paragraphBlocks"] = [];

    if (mode === "sentence") {
      for (let i = plan.first; i <= plan.last; i++) {
        const blocks: PlacedText[] = [];
        let cursor = zoneTop;
        const place = (text: string, spec: TypeSpec, family: string, color: string, direction?: TextDirection) => {
          const font = fontOf(spec, k, family);
          const lineHeight = lineHeightOf(spec, k);
          const h = countLines(text, font, direction) * lineHeight;
          if (blocks.length) cursor += gap;
          blocks.push({ text, font, lineHeight, centerY: cursor + h / 2, color, ...(direction ? { direction } : {}) });
          cursor += h;
        };
        const translitText = lines[i].transliteration.trim();
        if (translit && translitText) place(translitText, TRANSLIT, FONTS.latin, palette.translit);
        languages.forEach((id, li) => {
          const text = translationOf(i, id);
          if (text) {
            place(
              text,
              specFor(SENTENCE_TRANSLATION, li),
              familyFor(text),
              translationColors[li] ?? palette.translation,
              directionOf(id, text)
            );
          }
        });
        sentenceBlocks.set(i, blocks);
      }
    } else {
      let cursor = zoneTop;
      languages.forEach((id, li) => {
        const parts: { text: string; sentence: number }[] = [];
        for (let i = plan.first; i <= plan.last; i++) parts.push({ text: translationOf(i, id), sentence: i });
        if (!parts.some((p) => p.text)) return;
        const spec = specFor(PARAGRAPH_TRANSLATION, li);
        const sample = parts.find((p) => p.text)!.text;
        const block = layoutRich(
          measure,
          parts,
          fontOf(spec, k, familyFor(sample)),
          lineHeightOf(spec, k),
          maxTextW,
          cX,
          "start",
          directionOf(id, paragraphTranslation(plan.first, plan.last, id))
        );
        if (paragraphBlocks.length) cursor += gap;
        paragraphBlocks.push({ block, top: cursor, color: translationColors[li] ?? palette.translation });
        cursor += block.height;
      });
    }

    return {
      paragraph: plan.paragraph,
      first: plan.first,
      last: plan.last,
      kurdish,
      kurdishTop: top,
      dividerY: zone > 0 ? top + kurdish.height + (DIVIDER_GAP * k * s) / 2 : null,
      scale: k,
      sentenceBlocks,
      paragraphBlocks,
    };
  });

  const pageOfLine = new Array<number>(lines.length).fill(0);
  pages.forEach((page, p) => {
    for (let i = page.first; i <= page.last; i++) pageOfLine[i] = p;
  });

  /* ---------- time ---------- */

  // A breath between paragraphs, and a shorter one where a paragraph turns a
  // page: the reading had them, and the page change needs room to fade.
  const pauseAfter = lines.map((_, i) => {
    if (i + 1 >= lines.length) return 0;
    if (lines[i + 1].paragraph !== lines[i].paragraph) return PARAGRAPH_PAUSE;
    if (pageOfLine[i + 1] !== pageOfLine[i]) return PAGE_PAUSE;
    return 0;
  });
  const timeline = withPauses(
    buildTimeline({
      clipDurations: lines.map((l) => l.clip.duration),
      plays: look.plays,
      repeatGapMode: look.repeatGapMode,
      repeatGapSeconds: look.repeatGapSeconds,
      gapBetweenLines: look.gapBetweenLines,
      intro: false,
      outro: false,
    }),
    pauseAfter
  );
  const total = timeline.total;

  const clips: ScheduledClip[] = timeline.events
    .filter((e) => e.type === "play" && e.line !== undefined && lines[e.line])
    .map((e) => ({ buffer: lines[e.line!].clip, at: e.start }));

  const spans = lineSpans(timeline, lines.length);
  const windows = pageWindows(pages, spans, PAGE_FADE, 0.25);
  kit.paintTrack(
    pages.map((page) => spans[page.first]?.start ?? 0),
    total
  );

  const wordStarts = wordTimings(lines, look.karaoke);
  const plays = Math.max(1, Math.min(3, Math.round(look.plays) || 1));
  const cuesOn = plays > 1 || look.repeatGapMode !== "off";
  const paragraphCount = groups.length;

  /* ---------- the frame ---------- */

  function drawKurdish(ctx: CanvasRenderingContext2D, page: Page, current: number, spoken: number | null, alpha: number, bandIn: number) {
    const block = page.kurdish;
    const top = page.kurdishTop;

    // The marker band behind the sentence being read.
    const band = block.spans.get(current);
    if (band && bandIn > 0) {
      ctx.save();
      ctx.globalAlpha = alpha * BAND_ALPHA * bandIn;
      ctx.fillStyle = palette.accent;
      const padX = 9 * page.scale * s;
      const h = block.lineHeight * 0.86;
      for (const stretch of band) {
        const y = top + block.lines[stretch.line].y;
        ctx.beginPath();
        ctx.roundRect(stretch.left - padX, y - h / 2, stretch.right - stretch.left + padX * 2, h, 12 * page.scale * s);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.font = block.font;
    ctx.textBaseline = "middle";
    ctx.direction = block.rtl ? "rtl" : "ltr";
    ctx.textAlign = block.rtl ? "right" : "left";
    for (const line of block.lines) {
      const y = top + line.y;
      for (const word of line.words) {
        const state = sentenceState(word.sentence, current);
        let color = palette.text;
        let strength = 1;
        if (state === "past") strength = PAST_ALPHA;
        else if (state === "future") strength = FUTURE_ALPHA;
        else if (spoken === null || word.index < spoken) color = palette.accent;
        ctx.globalAlpha = alpha * strength;
        ctx.fillStyle = color;
        fillWord(ctx, block, word, y);
      }
    }
    ctx.restore();
  }

  function drawParagraphTranslation(ctx: CanvasRenderingContext2D, page: Page, current: number, alpha: number) {
    for (const { block, top, color } of page.paragraphBlocks) {
      ctx.save();
      ctx.font = block.font;
      ctx.textBaseline = "middle";
      ctx.direction = block.rtl ? "rtl" : "ltr";
      ctx.textAlign = block.rtl ? "right" : "left";
      ctx.fillStyle = color;
      for (const line of block.lines) {
        const y = top + line.y;
        for (const word of line.words) {
          const state = sentenceState(word.sentence, current);
          ctx.globalAlpha =
            alpha * (state === "current" ? 1 : state === "past" ? TRANSLATION_PAST_ALPHA : TRANSLATION_FUTURE_ALPHA);
          fillWord(ctx, block, word, y);
        }
      }
      ctx.restore();
    }
  }

  function drawSentenceTranslation(ctx: CanvasRenderingContext2D, page: Page, current: number, alpha: number) {
    const blocks = page.sentenceBlocks.get(current);
    if (!blocks) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const block of blocks) {
      ctx.fillStyle = block.color;
      ctx.font = block.font;
      drawWrappedText(ctx, block.text, cX, block.centerY, maxTextW, block.lineHeight, { direction: block.direction });
    }
    ctx.restore();
  }

  function drawCue(ctx: CanvasRenderingContext2D, type: "play" | "turn", play: number, start: number, end: number, elapsed: number, voice: number) {
    ctx.save();
    ctx.fillStyle = palette.accent;
    if (!cuesOn) {
      // Read straight through: no words, just the voice moving.
      ctx.globalAlpha = 0.85;
      kit.voiceBars(ctx, cX - 18 * s, hudY - 8 * s, voice, elapsed);
      ctx.restore();
      return;
    }
    const isTurn = type === "turn";
    const labelOf = (x: VideoStrings) => (isTurn ? x.yourTurn : play === 0 ? x.listen : x.listenAgain);
    const label = labelOf(primary);
    const text = `${isTurn ? "🗣️" : "🎧"} ${label}${plays > 1 ? `  ${play + 1}/${plays}` : ""}`;
    ctx.globalAlpha = envelope(elapsed - start, end - start, 0.12);
    ctx.fillStyle = isTurn ? palette.accentAlt : palette.accent;
    kit.setFont(ctx, "bold", 20, label);
    ctx.textAlign = "center";
    ctx.direction = isRtlText(label) ? "rtl" : "ltr";
    const textW = ctx.measureText(text).width;
    ctx.fillText(text, cX, hudY);
    ctx.direction = "ltr";
    if (!isTurn) kit.voiceBars(ctx, cX + textW / 2 + 14 * s, hudY - 8 * s, voice, elapsed);
    ctx.restore();
  }

  function draw(ctx: CanvasRenderingContext2D, elapsed: number, voice: number) {
    kit.drawBackdrop(ctx, elapsed, voice);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const event = eventAt(timeline, elapsed);
    const current = event?.line ?? -1;

    if (pages.length) {
      const p = pageAt(windows, elapsed);
      const page = pages[p];
      const alpha = easeOutCubic(pageAlpha(windows[p], elapsed));
      // Only the arriving page rises; a leaving one just fades.
      const arriving = elapsed - windows[p].start < windows[p].fadeIn;
      const rise = arriving ? (1 - alpha) * PAGE_RISE * s : 0;

      if (alpha > 0.001) {
        const inPage = current >= page.first && current <= page.last;
        const sinceStart = inPage ? elapsed - (spans[current]?.start ?? 0) : 0;
        const sentenceIn = inPage ? easeOutCubic(sinceStart / SENTENCE_FADE) : 0;

        // Karaoke: words spoken so far in the current sentence; all of them
        // once it has been played.
        let spoken: number | null = null;
        const starts = inPage ? wordStarts[current] : null;
        if (starts && event) {
          spoken = event.type === "play" ? wordsSpoken(starts, elapsed - event.start) : starts.length;
        }

        ctx.save();
        ctx.translate(0, rise);
        drawKurdish(ctx, page, current, spoken, alpha, sentenceIn);

        if (page.dividerY !== null) {
          ctx.save();
          ctx.globalAlpha = alpha * 0.55;
          ctx.fillStyle = palette.accent;
          const w = 46 * page.scale * s;
          ctx.beginPath();
          ctx.roundRect(cX - w / 2, page.dividerY - 1.5 * s, w, 3 * s, 1.5 * s);
          ctx.fill();
          ctx.restore();
        }

        if (mode === "paragraph") drawParagraphTranslation(ctx, page, current, alpha);
        else if (inPage) drawSentenceTranslation(ctx, page, current, alpha * sentenceIn);
        ctx.restore();
      }

      // Which paragraph, bottom left, opposite the sentence counter.
      if (paragraphCount > 1) {
        ctx.save();
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = palette.meta;
        ctx.font = `600 ${Math.round(19 * s)}px ${FONTS.latin}`;
        ctx.fillText(`¶ ${page.paragraph + 1} / ${paragraphCount}`, kit.progress.x, kit.progress.y - 18 * s);
        ctx.restore();
      }
    }

    if (event && (event.type === "play" || event.type === "turn")) {
      drawCue(ctx, event.type, event.play ?? 0, event.start, event.end, elapsed, voice);
    }

    kit.drawProgress(ctx, total > 0 ? elapsed / total : 0);
    kit.drawCounter(ctx, current >= 0 ? current + 1 : 1, lines.length);
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
