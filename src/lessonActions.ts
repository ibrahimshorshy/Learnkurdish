/**
 * The steps of the pipeline that talk to the AI or shape the lesson, kept out
 * of the components so the buttons that trigger them stay simple.
 */

import type { LessonLine, Project, UsageTotals } from "./types";
import type { AppSettings } from "./utils/settings";
import type { RecordingAudio } from "./audio/useRecordingAudio";
import { estimateCost, type Usage } from "./config/models";
import { placeLinesByLength, snapLinesToPauses, pausesOf } from "./audio/segmentation";
import { wavForTranscription } from "./audio/audioTools";
import { buildLineClip, type AudioSources } from "./audio/clipBuilder";
import { newId } from "./utils/projectStore";
import * as api from "./utils/api";
import type { VideoLine } from "./render/renderLesson";
import { themeFor } from "./render/themes";
import type { TranscribeMode } from "./config/transcribeModes";

export function addUsage(totals: UsageTotals, model: string, usage: Usage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    audioTokens: totals.audioTokens + usage.audioTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    costUsd: totals.costUsd + estimateCost(model, usage),
  };
}

/**
 * How a project's recording is transcribed: a dialogue gets speakers, and a
 * recording of a known text (a story, a script) is aligned to that text
 * rather than transcribed from scratch.
 */
export function transcribeModeFor(project: Project): TranscribeMode {
  if (project.kind === "dialogue") return "dialogue";
  if (project.script?.some((l) => l.trim())) return "aligned";
  return "lines";
}

/** Step 1 → 2: hear the recording, and place every line in it. */
export async function transcribeRecording(
  project: Project,
  audio: RecordingAudio,
  settings: AppSettings
): Promise<(current: Project) => Partial<Project>> {
  const wav = await wavForTranscription(audio.buffer);
  const mode = transcribeModeFor(project);
  const result = await api.transcribe({
    wav,
    durationSeconds: audio.buffer.duration,
    taughtLang: project.taughtLang,
    context: project.context,
    model: settings.transcribeModel,
    apiKey: settings.apiKey,
    mode,
    knownLines: mode === "aligned" ? project.script : undefined,
    speakers: project.kind === "dialogue" ? project.speakers.map((s) => s.name) : undefined,
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
    ...(project.kind === "dialogue" ? { speaker: line.speaker ?? 0 } : {}),
    ...(project.kind === "story" && (line.paragraphStart || i === 0) ? { paragraphStart: true } : {}),
  }));

  return (current) => ({
    lines,
    cuts: [],
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
    kind: project.kind,
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

/**
 * The lines that go into the video, each with its finished clip of your voice
 * (its take if it has one, cuts removed, pauses tightened). Lines whose audio
 * is not loaded yet are left out rather than played silent.
 */
export function videoLinesFrom(project: Project, sources: AudioSources): VideoLine[] {
  const out: VideoLine[] = [];
  let paragraph = -1;
  project.lines.forEach((l, index) => {
    if (l.paragraphStart || index === 0) paragraph++;
    if (l.skip || !l.kurdish.trim() || (!l.take && l.end <= l.start)) return;
    const clip = buildLineClip(l, sources, project);
    if (!clip) return;
    out.push({
      id: l.id,
      kurdish: l.kurdish.trim(),
      transliteration: l.transliteration.trim(),
      translations: l.translations,
      clip,
      speaker: l.speaker ?? 0,
      paragraph: Math.max(0, paragraph),
    });
  });
  return out;
}

/**
 * A short hash of everything that changes how a video looks or sounds, so a
 * video made before an edit can be marked as out of date.
 */
export function fingerprint(project: Project, languages: string[]): string {
  const { outputs: _outputs, resolution: _resolution, themes: _themes, ...look } = project.video;
  const card = (c: Project["intro"]) => [
    c.enabled,
    c.audio,
    c.voice,
    languages.map((id) => c.text[id] || ""),
    languages.map((id) =>
      c.clips[id]
        ? `${c.clips[id].blob.size}:${c.clips[id].durationSeconds}:${c.clips[id].madeFrom ?? c.clips[id].source}`
        : ""
    ),
  ];
  const material = JSON.stringify({
    kind: project.kind,
    languages,
    look,
    theme: themeFor(project.video.themes, languages),
    titles: languages.map((id) => project.titles[id] || ""),
    speakers: project.kind === "dialogue" ? project.speakers.map((s) => s.name) : undefined,
    intro: card(project.intro),
    outro: card(project.outro),
    // Video projects never cut or tighten, so those settings cannot change one.
    cuts:
      project.kind === "video" ? [] : project.cuts.map((c) => [Math.round(c.start * 100), Math.round(c.end * 100)]),
    fx: project.kind === "video" ? { preset: project.audioFx.preset, room: project.audioFx.room } : project.audioFx,
    processed: project.processed?.key,
    lines: project.lines
      .filter((l) => !l.skip)
      .map((l) => [
        l.kurdish,
        l.transliteration,
        languages.map((id) => l.translations[id] || ""),
        Math.round(l.start * 100),
        Math.round(l.end * 100),
        l.take ? `${l.take.id}:${Math.round(l.take.start * 100)}:${Math.round(l.take.end * 100)}:${l.take.processed?.key ?? ""}` : "",
        l.speaker ?? 0,
        l.paragraphStart ? 1 : 0,
      ]),
  });
  let hash = 5381;
  for (let i = 0; i < material.length; i++) hash = ((hash << 5) + hash + material.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export const outputKey = (languages: string[]) => languages.join("+");
