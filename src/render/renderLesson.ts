/**
 * The lesson video: your voice, line by line, with the Kurdish on screen, how
 * to pronounce it, and what it means in the viewer's language.
 *
 * One drawing function serves three jobs, so what you preview is exactly what
 * you get:
 *
 *   drawStill     — a single frame, for the look picker
 *   startPreview  — plays in the page in real time, with sound
 *   renderVideo   — draws every frame as fast as the machine allows, ships them
 *                   to the server in batches, and lets ffmpeg mux them against
 *                   an offline mixdown of the voice clips (as in Reels Creator)
 */

import { ensureAllFontsLoaded } from "../utils/fontLoader";
import { findAudienceLanguage, type VideoStrings } from "../config/languages";
import { FONTS, resolveTheme, type ThemeId } from "./themes";
import { drawWrappedText, easeOutCubic, envelope, isRtlText } from "./textLayout";
import { REEL_SAFE, fitTextStack, safeTextWidth, type PlacedBlock } from "./safeArea";
import { mixdown, encodeWav, type ScheduledClip } from "./audioMixdown";
import { createFrameEncoder } from "./frameEncoderPool";
import { analyzeSpeech, alignWordsToAudio, splitWords } from "./audioAlign";
import { buildTimeline, eventAt, type RepeatGapMode, type Timeline } from "./timeline";
import { audioContext, toMono } from "../audio/audioTools";

export type ResolutionId = "720p" | "1080p" | "1440p";

export const RESOLUTIONS: Record<ResolutionId, { label: string; width: number; blurb: string }> = {
  "720p": { label: "720p", width: 720, blurb: "Quickest to make. Fine for a draft." },
  "1080p": { label: "1080p", width: 1080, blurb: "What Instagram and TikTok actually serve." },
  "1440p": { label: "1440p", width: 1440, blurb: "Sharper on desktop, about twice as slow." },
};

export const DEFAULT_RESOLUTION: ResolutionId = "1080p";

/** Design units; every position is multiplied by `s`. */
const BASE = { w: 720, h: 1280 };
const FPS = 30;

export interface VideoLine {
  kurdish: string;
  transliteration: string;
  translations: Record<string, string>;
  clip: AudioBuffer;
}

export interface LessonLook {
  theme: ThemeId;
  plays: number;
  repeatGapMode: RepeatGapMode;
  repeatGapSeconds: number;
  gapBetweenLines: number;
  intro: boolean;
  outro: boolean;
  showTransliteration: boolean;
  karaoke: boolean;
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
}

export interface PreparedLesson {
  width: number;
  height: number;
  timeline: Timeline;
  clips: ScheduledClip[];
  /** Paints the frame at `elapsed` seconds. `voice` is the current level, 0..1. */
  draw: (ctx: CanvasRenderingContext2D, elapsed: number, voice: number) => void;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function stringsFor(ids: string[]): VideoStrings[] {
  const found = ids.map((id) => findAudienceLanguage(id)?.strings).filter(Boolean) as VideoStrings[];
  return found.length ? found : [findAudienceLanguage("en")!.strings];
}

function familyFor(text: string): string {
  return isRtlText(text) ? FONTS.arabicScript : FONTS.latin;
}

/* ------------------------------------------------------------------ */
/* Preparation: everything that does not change from frame to frame     */
/* ------------------------------------------------------------------ */

export async function prepareLesson(options: PrepareOptions): Promise<PreparedLesson> {
  const { lines, languages, titles, look } = options;
  const theme = resolveTheme(look.theme);
  const palette = theme.palette;
  const strings = stringsFor(languages);
  const primary = strings[0];

  const width = Math.round(options.width / 2) * 2;
  const height = Math.round((width * BASE.h) / BASE.w / 2) * 2;
  const s = width / BASE.w;
  const cX = width / 2;
  const safe = REEL_SAFE;

  await ensureAllFontsLoaded();
  const logo = await loadImage(options.logoSrc);

  const timeline = buildTimeline({
    clipDurations: lines.map((l) => l.clip.duration),
    plays: look.plays,
    repeatGapMode: look.repeatGapMode,
    repeatGapSeconds: look.repeatGapSeconds,
    gapBetweenLines: look.gapBetweenLines,
    intro: look.intro,
    outro: look.outro,
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

  /* ---------- static layer ---------- */

  const staticLayer = document.createElement("canvas");
  staticLayer.width = width;
  staticLayer.height = height;
  const sctx = staticLayer.getContext("2d")!;
  theme.paintStatic(sctx, width, height, s);

  const maxTextW = safeTextWidth(BASE.w, safe) * s;
  let cursor = safe.top * s;

  if (logo) {
    const scale = Math.min((220 * s) / logo.width, (88 * s) / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    sctx.drawImage(logo, cX - w / 2, cursor, w, h);
    cursor += h + 26 * s;
  } else {
    cursor += 30 * s;
  }

  // Tagline: "Learn Kurdish Sorani" in the viewer's language.
  sctx.textAlign = "center";
  sctx.textBaseline = "alphabetic";
  sctx.fillStyle = palette.accent;
  sctx.direction = isRtlText(primary.tagline) ? "rtl" : "ltr";
  sctx.font = `bold ${Math.round(23 * s)}px ${familyFor(primary.tagline)}`;
  sctx.fillText(primary.tagline, cX, cursor);
  sctx.direction = "ltr";
  cursor += 24 * s;

  // Lesson title pill.
  const title = (titles[languages[0]] || "").trim();
  let pillBottom = cursor;
  if (title) {
    const pillY = cursor + 30 * s;
    sctx.font = `600 ${Math.round(19 * s)}px ${familyFor(title)}`;
    const textW = Math.min(sctx.measureText(title).width, maxTextW - 40 * s);
    const pillW = textW + 40 * s;
    const pillH = 40 * s;
    sctx.fillStyle = palette.pillFill;
    sctx.strokeStyle = palette.pillStroke;
    sctx.lineWidth = 1 * s;
    sctx.beginPath();
    sctx.roundRect(cX - pillW / 2, pillY - pillH / 2, pillW, pillH, 20 * s);
    sctx.fill();
    sctx.stroke();
    sctx.fillStyle = palette.pillText;
    sctx.textBaseline = "middle";
    sctx.direction = isRtlText(title) ? "rtl" : "ltr";
    sctx.fillText(title, cX, pillY, maxTextW - 40 * s);
    sctx.direction = "ltr";
    sctx.textBaseline = "alphabetic";
    pillBottom = pillY + pillH / 2;
  }

  // Footer: HUD above the progress bar, both clear of the platforms' captions.
  const hudY = (BASE.h - safe.bottom - 62) * s;
  const progressY = (BASE.h - safe.bottom - 22) * s;
  const progressW = maxTextW;
  const progressH = 8 * s;
  const progressX = cX - progressW / 2;

  sctx.fillStyle = palette.progressTrack;
  sctx.beginPath();
  sctx.roundRect(progressX, progressY, progressW, progressH, 4 * s);
  sctx.fill();
  sctx.fillStyle = palette.isLight ? "rgba(4, 23, 48, 0.3)" : "rgba(255, 255, 255, 0.35)";
  for (const span of lineSpan) {
    if (span.start > 0 && span.start < total) {
      const x = progressX + (span.start / total) * progressW;
      sctx.fillRect(x - 1 * s, progressY - 2 * s, 2 * s, progressH + 4 * s);
    }
  }

  /* ---------- text, measured once per line ---------- */

  const bandTop = pillBottom + 40 * s;
  const bandBottom = hudY - 50 * s;
  const ctxMeasure = sctx;

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
      ctxMeasure,
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

  // Karaoke word timings, measured from each clip rather than guessed.
  const wordStarts: (number[] | null)[] = lines.map((line) => {
    if (!look.karaoke) return null;
    const words = splitWords(line.kurdish);
    if (!words.length) return null;
    return alignWordsToAudio(words, analyzeSpeech(toMono(line.clip), line.clip.sampleRate));
  });

  const translationColors = [palette.translation, palette.translationAlt, palette.translit];

  /* ---------- the frame ---------- */

  const setFont = (ctx: CanvasRenderingContext2D, weight: string, size: number, text: string) => {
    ctx.font = `${weight} ${Math.round(size * s)}px ${familyFor(text)}`;
  };

  const centeredText = (ctx: CanvasRenderingContext2D, text: string, y: number) => {
    ctx.direction = isRtlText(text) ? "rtl" : "ltr";
    ctx.fillText(text, cX, y);
    ctx.direction = "ltr";
  };

  /** Five little bars that move with the voice, beside the LISTEN cue. */
  const voiceBars = (ctx: CanvasRenderingContext2D, x: number, y: number, voice: number, elapsed: number) => {
    const barW = 4 * s;
    const gap = 4 * s;
    for (let i = 0; i < 5; i++) {
      const wobble = 0.55 + 0.45 * Math.sin(elapsed * 9 + i * 1.7);
      const h = (4 + 18 * Math.min(1, voice * 1.4) * wobble) * s;
      ctx.beginPath();
      ctx.roundRect(x + i * (barW + gap), y - h / 2, barW, h, 2 * s);
      ctx.fill();
    }
  };

  function draw(ctx: CanvasRenderingContext2D, elapsed: number, voice: number) {
    ctx.drawImage(staticLayer, 0, 0);
    theme.paintDynamic?.(ctx, width, height, s, elapsed, voice);

    const event = eventAt(timeline, elapsed);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    if (event?.type === "intro") {
      const local = elapsed - event.start;
      const rise = easeOutCubic(local / 0.5);
      const fadeOut = Math.min(1, Math.max(0, (event.end - elapsed) / 0.25));
      ctx.save();
      ctx.globalAlpha = (0.1 + rise * 0.9) * fadeOut;
      ctx.translate(0, (1 - rise) * 18 * s);
      ctx.fillStyle = palette.text;
      if (palette.textGlow) {
        ctx.shadowColor = palette.textGlow;
        ctx.shadowBlur = 12 * s;
      }
      const centerY = (BASE.h - safe.bottom + safe.top) * 0.5 * s;
      const heading = (titles[languages[0]] || primary.tagline).trim();
      setFont(ctx, "bold", isRtlText(heading) ? 50 : 44, heading);
      drawWrappedText(ctx, heading, cX, centerY - 40 * s, maxTextW, 64 * s);
      ctx.shadowBlur = 0;
      if (languages.length > 1) {
        const second = (titles[languages[1]] || "").trim();
        if (second) {
          ctx.fillStyle = palette.translationAlt;
          setFont(ctx, "600", 28, second);
          drawWrappedText(ctx, second, cX, centerY + 50 * s, maxTextW, 40 * s);
        }
      }
      // One line per language: Arabic and English joined on one line reorder
      // each other under the bidi algorithm.
      ctx.fillStyle = palette.accent;
      strings.forEach((x, i) => {
        const cue = i === 0 ? `🎧 ${x.getReady}` : x.getReady;
        setFont(ctx, "600", i === 0 ? 20 : 17, cue);
        centeredText(ctx, cue, centerY + (130 + i * 30) * s);
      });
      ctx.restore();
    } else if (event?.type === "outro") {
      const rise = easeOutCubic((elapsed - event.start) / 0.5);
      ctx.save();
      ctx.globalAlpha = 0.1 + rise * 0.9;
      const centerY = (BASE.h - safe.bottom + safe.top) * 0.5 * s;
      ctx.fillStyle = palette.text;
      if (palette.textGlow) {
        ctx.shadowColor = palette.textGlow;
        ctx.shadowBlur = 12 * s;
      }
      const head = `${primary.wellDone} 🎉`;
      setFont(ctx, "bold", 54, head);
      drawWrappedText(ctx, head, cX, centerY - 50 * s, maxTextW, 70 * s);
      ctx.shadowBlur = 0;
      let y = centerY + 40 * s;
      if (strings.length > 1) {
        ctx.fillStyle = palette.translationAlt;
        const second = strings.slice(1).map((x) => x.wellDone);
        for (const text of second) {
          setFont(ctx, "bold", 32, text);
          centeredText(ctx, text, centerY + 10 * s);
        }
        y = centerY + 80 * s;
      }
      strings.forEach((x, i) => {
        ctx.fillStyle = i === 0 ? palette.accentAlt : palette.translationAlt;
        setFont(ctx, "600", 25, x.follow);
        drawWrappedText(ctx, x.follow, cX, y, maxTextW, 36 * s);
        y += 46 * s;
      });
      ctx.restore();
    } else if (event && event.line !== undefined && lines[event.line]) {
      const index = event.line;
      const line = lines[index];
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
        setFont(ctx, "bold", 22, label);
        ctx.direction = isRtlText(label) ? "rtl" : "ltr";
        const textW = ctx.measureText(text).width;
        ctx.fillText(text, cX, hudY);
        ctx.direction = "ltr";
        if (!isTurn) voiceBars(ctx, cX + textW / 2 + 14 * s, hudY - 8 * s, voice, elapsed);
        // The other languages' cue, smaller and on its own line, so scripts
        // running in opposite directions never share one.
        strings.slice(1).forEach((x, i) => {
          const other = labelOf(x);
          ctx.globalAlpha = hudAlpha * 0.8;
          setFont(ctx, "600", 15, other);
          centeredText(ctx, other, hudY + (22 + i * 18) * s);
        });
        ctx.restore();
      }
    }

    // Progress.
    const progress = total > 0 ? Math.min(elapsed / total, 1) : 0;
    const fillW = progressW * progress;
    if (fillW > 0) {
      const grad = ctx.createLinearGradient(progressX, 0, progressX + progressW, 0);
      grad.addColorStop(0, palette.progressStops[0]);
      grad.addColorStop(0.5, palette.progressStops[1]);
      grad.addColorStop(1, palette.progressStops[2]);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(progressX, progressY, fillW, progressH, 4 * s);
      ctx.fill();
    }

    // Line counter, right-aligned to the safe edge.
    if (lines.length) {
      const current =
        event?.line !== undefined ? event.line + 1 : event?.type === "outro" ? lines.length : 1;
      ctx.textAlign = "right";
      ctx.fillStyle = palette.meta;
      ctx.font = `600 ${Math.round(21 * s)}px ${FONTS.latin}`;
      ctx.fillText(`${current} / ${lines.length}`, width - safe.right * s, progressY - 18 * s);
      ctx.textAlign = "center";
    }
  }

  return { width, height, timeline, clips, draw };
}

/* ------------------------------------------------------------------ */
/* Still frame and live preview                                          */
/* ------------------------------------------------------------------ */

/** Paints one frame onto a canvas, sizing the canvas to the lesson. */
export function drawStill(prepared: PreparedLesson, canvas: HTMLCanvasElement, at: number) {
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const ctx = canvas.getContext("2d");
  if (ctx) prepared.draw(ctx, at, 0.35);
}

/** A moment worth showing as a thumbnail: halfway through the first play. */
export function stillMoment(prepared: PreparedLesson): number {
  const play = prepared.timeline.events.find((e) => e.type === "play");
  return play ? play.start + (play.end - play.start) * 0.6 : 0;
}

export interface PreviewHandle {
  stop: () => void;
  done: Promise<void>;
}

/** Plays the lesson in the page, with sound, from `from` seconds. */
export function startPreview(
  prepared: PreparedLesson,
  canvas: HTMLCanvasElement,
  onTime?: (t: number) => void,
  from = 0
): PreviewHandle {
  const ctx = audioContext();
  canvas.width = prepared.width;
  canvas.height = prepared.height;
  const g = canvas.getContext("2d")!;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  analyser.connect(ctx.destination);
  const bins = new Uint8Array(analyser.fftSize);

  const sources: AudioBufferSourceNode[] = [];
  let running = true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));

  const begin = async () => {
    if (ctx.state === "suspended") await ctx.resume();
    const base = ctx.currentTime + 0.08;
    for (const clip of prepared.clips) {
      const clipEnd = clip.at + clip.buffer.duration;
      if (clipEnd <= from) continue;
      const source = ctx.createBufferSource();
      source.buffer = clip.buffer;
      source.connect(analyser);
      const offset = Math.max(0, from - clip.at);
      source.start(base + Math.max(0, clip.at - from), offset);
      sources.push(source);
    }

    const frame = () => {
      if (!running) return;
      const t = from + Math.max(0, ctx.currentTime - base);
      analyser.getByteTimeDomainData(bins);
      let sum = 0;
      for (let i = 0; i < bins.length; i++) {
        const v = (bins[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / bins.length) * 3.2);
      prepared.draw(g, t, level);
      onTime?.(t);
      if (t >= prepared.timeline.total) {
        stop();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  const stop = () => {
    if (!running) return;
    running = false;
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    analyser.disconnect();
    resolveDone();
  };

  void begin();
  return { stop, done };
}

/* ------------------------------------------------------------------ */
/* The MP4                                                              */
/* ------------------------------------------------------------------ */

/** Frames per upload: small enough to bound memory, large enough to be cheap. */
const FRAME_BATCH = 45;
/**
 * Intermediate JPEG quality. ffmpeg re-encodes to H.264 at CRF 20, so these
 * only need to be visually lossless going in; 0.85 is about half the bytes and
 * time of 0.92 with no visible difference afterwards (measured in Reels Creator).
 */
const FRAME_QUALITY = 0.85;

export interface RenderResult {
  blob: Blob;
  durationSeconds: number;
  /** Frames produced per second of wall-clock time. */
  speed: number;
}

export async function renderVideo(
  prepared: PreparedLesson,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<RenderResult> {
  const { width, height, timeline, clips, draw } = prepared;
  const started = performance.now();
  // A short tail so the last frame is not cut on the final syllable.
  const duration = timeline.total + 0.4;

  // Mix first: cheap, and a failure here should not waste a render.
  const mixed = await mixdown(clips, duration);
  const wav = encodeWav(mixed);

  const totalFrames = Math.max(1, Math.ceil(duration * FPS));
  const channel = mixed.getChannelData(0);
  const perFrame = Math.floor(mixed.sampleRate / FPS);
  const levels = new Float32Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    const from = f * perFrame;
    const to = Math.min(channel.length, from + perFrame);
    let sum = 0;
    for (let i = from; i < to; i += 8) sum += channel[i] * channel[i];
    levels[f] = Math.min(1, Math.sqrt(sum / Math.max(1, Math.ceil((to - from) / 8))) * 3.2);
  }

  // A detached, CPU-backed canvas: reading every frame back off a page canvas
  // costs twice as much (measured in Reels Creator).
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const ctx = surface.getContext("2d", { alpha: false, willReadFrequently: true }) as CanvasRenderingContext2D;

  const startRes = await fetch("/api/render/start", { method: "POST" });
  if (!startRes.ok) {
    const detail = await startRes.json().catch(() => ({}));
    throw new Error(detail.error || "Could not start a render on the server.");
  }
  const { sessionId } = await startRes.json();
  const encoder = createFrameEncoder(FRAME_QUALITY);

  try {
    let batch: Blob[] = [];
    let batchStart = 0;
    const inFlight: Promise<void>[] = [];

    const send = (frames: Blob[], startIndex: number) => {
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("startIndex", String(startIndex));
      frames.forEach((blob, i) => form.append("frames", blob, `f${startIndex + i}.jpg`));
      return fetch("/api/render/frames", { method: "POST", body: form }).then(async (res) => {
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error || "Uploading frames failed.");
        }
      });
    };

    const flush = async () => {
      if (!batch.length) return;
      const pending = send(batch, batchStart);
      batchStart += batch.length;
      batch = [];
      inFlight.push(pending);
      pending.catch(() => {});
      if (inFlight.length >= 2) await inFlight.shift();
    };

    // Budget a fixed amount of bitmap memory in flight — the measured optimum
    // in Reels Creator was 3 to 4 frames.
    const maxAhead = Math.max(3, Math.min(4, Math.floor(48_000_000 / (width * height * 4))));
    const encoding: Array<Promise<{ index: number; blob: Blob }>> = [];
    const finished: Blob[] = [];
    let next = 0;

    const collectOne = async () => {
      const settled = await Promise.race(encoding.map((p, i) => p.then((v) => ({ v, i }))));
      encoding.splice(settled.i, 1);
      finished[settled.v.index] = settled.v.blob;
    };

    while (next < totalFrames || encoding.length) {
      if (signal?.aborted) throw new DOMException("The render was cancelled.", "AbortError");
      while (next < totalFrames && encoding.length < maxAhead) {
        const index = next++;
        draw(ctx, index / FPS, levels[index]);
        const bitmap = await createImageBitmap(surface);
        encoding.push(encoder.encode(index, bitmap).then((blob) => ({ index, blob })));
      }
      if (encoding.length) await collectOne();
      while (finished[batchStart + batch.length]) {
        batch.push(finished[batchStart + batch.length]);
        delete finished[batchStart + batch.length - 1];
        if (batch.length >= FRAME_BATCH) await flush();
      }
      onProgress?.((Math.min(next, totalFrames) / totalFrames) * 0.92);
    }

    await flush();
    await Promise.all(inFlight);

    const finish = new FormData();
    finish.append("sessionId", sessionId);
    finish.append("audio", wav, "audio.wav");
    finish.append("fps", String(FPS));
    const muxed = await fetch("/api/render/finish", { method: "POST", body: finish });
    if (!muxed.ok) {
      const detail = await muxed.json().catch(() => ({}));
      throw new Error(detail.error || "Assembling the MP4 failed on the server.");
    }
    const blob = await muxed.blob();
    onProgress?.(1);

    const wall = (performance.now() - started) / 1000;
    return { blob, durationSeconds: timeline.total, speed: totalFrames / FPS / Math.max(0.001, wall) };
  } catch (err) {
    void fetch("/api/render/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
    throw err;
  } finally {
    encoder.destroy();
  }
}
