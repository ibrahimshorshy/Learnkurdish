/**
 * The steps of the pipeline that talk to the AI or shape the lesson, kept out
 * of the components so the buttons that trigger them stay simple.
 */

import type { LessonLine, Project, UsageTotals } from "./types";
import type { AppSettings } from "./utils/settings";
import type { RecordingAudio } from "./audio/useRecordingAudio";
import { estimateCost, type Usage } from "./config/models";
import { placeLinesByLength, snapLinesToPauses, pausesOf } from "./audio/segmentation";
import { sliceClip, wavForTranscription } from "./audio/audioTools";
import { newId } from "./utils/projectStore";
import * as api from "./utils/api";
import type { VideoLine } from "./render/renderLesson";

export function addUsage(totals: UsageTotals, model: string, usage: Usage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    audioTokens: totals.audioTokens + usage.audioTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    costUsd: totals.costUsd + estimateCost(model, usage),
  };
}

/** Step 1 → 2: hear the recording, and place every line in it. */
export async function transcribeRecording(
  project: Project,
  audio: RecordingAudio,
  settings: AppSettings
): Promise<(current: Project) => Partial<Project>> {
  const wav = await wavForTranscription(audio.buffer);
  const result = await api.transcribe({
    wav,
    durationSeconds: audio.buffer.duration,
    taughtLang: project.taughtLang,
    context: project.context,
    model: settings.transcribeModel,
    apiKey: settings.apiKey,
  });

  if (!result.lines.length) {
    throw new Error(
      "The AI did not hear any Kurdish in this recording. Check the recording plays back, or try a stronger model in Settings."
    );
  }

  const ranges = result.timesTrusted
    ? snapLinesToPauses(result.lines, audio.analysis)
    : placeLinesByLength(
        result.lines.map((l) => l.text),
        audio.analysis
      );

  const lines: LessonLine[] = result.lines.map((line, i) => ({
    id: newId("l"),
    kurdish: line.text,
    start: ranges[i].start,
    end: ranges[i].end,
    transliteration: "",
    translations: {},
  }));

  return (current) => ({
    lines,
    timesSource: result.timesTrusted ? "model" : "audio",
    titles: {},
    captions: {},
    approvedAt: undefined,
    step: "transcript",
    usage: addUsage(current.usage, result.model, result.usage),
  });
}

/** Lines whose Kurdish changed after they were translated, or never were. */
export function untranslated(project: Project): LessonLine[] {
  return project.lines.filter(
    (l) =>
      l.kurdish.trim() &&
      (l.translatedFrom !== l.kurdish || project.audiences.some((id) => !(l.translations[id] || "").trim()))
  );
}

/**
 * Step 2 → 3: translate every line (or just `onlyIds`) into the project's
 * audience languages. A whole-lesson pass also writes titles and captions.
 *
 * Returns an updater rather than a patch: the request takes a few seconds, and
 * anything edited meanwhile must survive. Only lines whose Kurdish is still
 * what was sent get the new translations.
 */
export async function translateLines(
  project: Project,
  settings: AppSettings,
  options: { onlyIds?: string[]; instruction?: string } = {}
): Promise<(current: Project) => Partial<Project>> {
  const targets = project.lines.filter(
    (l) => l.kurdish.trim() && (!options.onlyIds || options.onlyIds.includes(l.id))
  );
  if (!targets.length) return () => ({});
  const partial = Boolean(options.onlyIds);

  const note = [
    project.note.trim(),
    options.instruction?.trim() ? `For this line specifically: ${options.instruction.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await api.translate({
    lines: targets.map((l) => l.kurdish),
    audiences: project.audiences,
    taughtLang: project.taughtLang,
    note,
    context: project.context,
    model: settings.translateModel,
    apiKey: settings.apiKey,
    withTitles: !partial,
    surrounding: partial ? project.lines.filter((l) => !targets.includes(l)).map((l) => l.kurdish) : undefined,
  });

  const sent = new Map(targets.map((l, i) => [l.id, { kurdish: l.kurdish, got: result.lines[i] }]));

  return (current) => {
    const lines = current.lines.map((line) => {
      const entry = sent.get(line.id);
      if (!entry?.got || entry.kurdish !== line.kurdish) return line;
      return {
        ...line,
        transliteration: entry.got.transliteration || line.transliteration,
        translations: { ...line.translations, ...entry.got.translations },
        translatedFrom: line.kurdish,
      };
    });
    const patch: Partial<Project> = {
      lines,
      approvedAt: undefined,
      usage: addUsage(current.usage, result.model, result.usage),
    };
    if (!partial) {
      patch.titles = { ...current.titles, ...result.titles };
      patch.captions = { ...current.captions, ...result.captions };
      if (!current.name.trim() && result.titles?.en) patch.name = result.titles.en;
    }
    return patch;
  };
}

/**
 * Splits a line in two at a character position. The time is split at the
 * pause nearest to the same proportion of the line, when there is one.
 */
export function splitLine(
  line: LessonLine,
  at: number,
  audio: RecordingAudio | null
): [LessonLine, LessonLine] | null {
  const text = line.kurdish;
  let cut = Math.max(0, Math.min(text.length, at));
  if (cut <= 0 || cut >= text.length) {
    // No usable caret: split at the space nearest the middle.
    const middle = text.length / 2;
    let best = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === " " && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
    }
    if (best < 0) return null;
    cut = best;
  }
  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  if (!left || !right) return null;

  const share = left.length / (left.length + right.length);
  let boundary = line.start + (line.end - line.start) * share;
  if (audio) {
    const inside = pausesOf(audio.analysis, 0.08).filter((p) => p.start > line.start && p.end < line.end);
    if (inside.length) {
      const nearest = inside.reduce((a, b) =>
        Math.abs((a.start + a.end) / 2 - boundary) <= Math.abs((b.start + b.end) / 2 - boundary) ? a : b
      );
      boundary = (nearest.start + nearest.end) / 2;
    }
  }

  return [
    { ...line, kurdish: left, end: boundary, translations: {}, transliteration: "", translatedFrom: undefined },
    {
      ...line,
      id: newId("l"),
      kurdish: right,
      start: boundary,
      translations: {},
      transliteration: "",
      translatedFrom: undefined,
    },
  ];
}

export function mergeLines(a: LessonLine, b: LessonLine): LessonLine {
  return {
    ...a,
    kurdish: `${a.kurdish.trim()} ${b.kurdish.trim()}`.trim(),
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    transliteration: "",
    translations: {},
    translatedFrom: undefined,
    skip: a.skip && b.skip,
  };
}

/** The lines that go into the video, each with its own clip of your voice. */
export function videoLinesFrom(project: Project, audio: RecordingAudio): VideoLine[] {
  return project.lines
    .filter((l) => !l.skip && l.kurdish.trim() && l.end > l.start)
    .map((l) => ({
      kurdish: l.kurdish.trim(),
      transliteration: l.transliteration.trim(),
      translations: l.translations,
      clip: sliceClip(audio.buffer, l.start, l.end, audio.gain),
    }));
}

/**
 * A short hash of everything that changes how a video looks or sounds, so a
 * video made before an edit can be marked as out of date.
 */
export function fingerprint(project: Project, languages: string[]): string {
  const { outputs: _outputs, resolution: _resolution, ...look } = project.video;
  const material = JSON.stringify({
    languages,
    look,
    titles: languages.map((id) => project.titles[id] || ""),
    lines: project.lines
      .filter((l) => !l.skip)
      .map((l) => [
        l.kurdish,
        l.transliteration,
        languages.map((id) => l.translations[id] || ""),
        Math.round(l.start * 100),
        Math.round(l.end * 100),
      ]),
  });
  let hash = 5381;
  for (let i = 0; i < material.length; i++) hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export const outputKey = (languages: string[]) => languages.join("+");
