/**
 * Projects live in IndexedDB on this computer: the recording, the lines, the
 * translations and the finished videos.
 *
 * Unlike Reels Creator's seven-day library, nothing here expires. A recording
 * is your own voice and cannot be regenerated, so it is kept until you delete
 * it.
 */

import type { AudioFxSettings, CardSettings, Project, ProjectKind, Recording, VideoSettings } from "../types";
import { DEFAULT_RESOLUTION } from "../render/renderLesson";
import { DEFAULT_TAUGHT_LANGUAGE } from "../config/languages";

const DB_NAME = "leen-kurdish-studio";
const STORE = "projects";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const tx = database.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export function newId(prefix = "p"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_TTS_VOICE = "Charon";

export function defaultCard(enabled = true): CardSettings {
  return { enabled, audio: "silent", text: {}, clips: {}, voice: DEFAULT_TTS_VOICE };
}

export function defaultAudioFx(): AudioFxSettings {
  return { preset: "clean", room: false, tightenPauses: true, maxPause: 0.45 };
}

/**
 * Video defaults differ by kind: a lesson plays each line twice with time to
 * repeat; a dialogue and a story read straight through.
 */
export function defaultVideoSettings(audiences: string[], kind: ProjectKind = "lesson"): VideoSettings {
  const readThrough = kind === "dialogue" || kind === "story";
  return {
    themes: {},
    resolution: DEFAULT_RESOLUTION,
    plays: readThrough ? 1 : 2,
    repeatGapMode: readThrough ? "off" : "auto",
    repeatGapSeconds: 2.5,
    gapBetweenLines: kind === "dialogue" ? 0.45 : kind === "story" ? 0.35 : 0.6,
    showTransliteration: kind !== "story",
    karaoke: kind === "story",
    outputs: audiences.map((id) => [id]),
    storyTranslation: "sentence",
    subtitlePosition: "lower",
    videoFit: "blur",
  };
}

export function createProject(kind: ProjectKind, audiences: string[], carry?: Partial<VideoSettings>): Project {
  const now = Date.now();
  const video = defaultVideoSettings(audiences, kind);
  // Carry the look over from the last project of the same kind, but never its outputs.
  if (carry) {
    video.themes = carry.themes ?? video.themes;
    video.resolution = carry.resolution ?? video.resolution;
  }
  return {
    id: newId(),
    kind,
    name: "",
    createdAt: now,
    updatedAt: now,
    taughtLang: DEFAULT_TAUGHT_LANGUAGE,
    audiences,
    cuts: [],
    audioFx: kind === "video" ? { ...defaultAudioFx(), tightenPauses: false } : defaultAudioFx(),
    speakers: [{ name: "" }, { name: "" }],
    context: "",
    note: "",
    lines: [],
    titles: {},
    captions: {},
    step: "record",
    intro: defaultCard(kind !== "video"),
    outro: defaultCard(kind !== "video"),
    video,
    renders: [],
    usage: { inputTokens: 0, audioTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

/**
 * Brings a project saved by any earlier version up to the current shape.
 * Applied to everything read from the store, so the rest of the app can rely
 * on every field being there.
 */
export function normalizeProject(raw: any): Project {
  const kind: ProjectKind = raw?.kind ?? "lesson";
  const audiences: string[] = Array.isArray(raw?.audiences) && raw.audiences.length ? raw.audiences : ["ar", "en"];
  const base = createProject(kind, audiences);
  const oldVideo = raw?.video ?? {};
  const video: VideoSettings = { ...base.video, ...oldVideo };
  if (!video.themes || typeof video.themes !== "object") video.themes = {};
  // 1.0 had one theme for every output; keep it only if it was changed from the old default.
  if (oldVideo.theme && oldVideo.theme !== "sun" && !Object.keys(video.themes).length) {
    for (const output of video.outputs ?? []) video.themes[output.join("+")] = oldVideo.theme;
  }
  delete video.theme;
  const introOn = oldVideo.intro;
  const outroOn = oldVideo.outro;
  delete video.intro;
  delete video.outro;

  return {
    ...base,
    ...raw,
    kind,
    audiences,
    cuts: Array.isArray(raw?.cuts) ? raw.cuts : [],
    // 1.0 (no kind) played each line exactly as recorded: no clean-up and no
    // shortened pauses, so an old lesson re-rendered sounds the way it did.
    audioFx: raw?.audioFx
      ? { ...base.audioFx, ...raw.audioFx }
      : raw?.kind
        ? base.audioFx
        : { ...base.audioFx, preset: "raw", tightenPauses: false },
    speakers:
      Array.isArray(raw?.speakers) && raw.speakers.length >= 2 ? raw.speakers : [{ name: "" }, { name: "" }],
    intro: raw?.intro ?? { ...defaultCard(), enabled: introOn ?? true },
    outro: raw?.outro ?? { ...defaultCard(), enabled: outroOn ?? true },
    video,
    lines: Array.isArray(raw?.lines) ? raw.lines : [],
    titles: raw?.titles ?? {},
    captions: raw?.captions ?? {},
    renders: Array.isArray(raw?.renders) ? raw.renders : [],
    usage: raw?.usage ?? base.usage,
  };
}

/**
 * What a new main recording replaces. Everything derived from the old one —
 * its lines and takes, cuts, cleaned-up audio, titles, captions and videos —
 * describes a recording that is gone, so it all goes with it. One place, so
 * the record, story and video steps cannot drift apart.
 */
export function freshRecordingPatch(recording: Recording): Partial<Project> {
  return {
    recording,
    lines: [],
    cuts: [],
    processed: undefined,
    titles: {},
    captions: {},
    renders: [],
    approvedAt: undefined,
    timesSource: undefined,
    step: "record",
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                              */
/* ------------------------------------------------------------------ */

export async function saveProject(project: Project): Promise<void> {
  await run("readwrite", (store) => store.put({ ...project, updatedAt: Date.now() }));
}

export async function getProject(id: string): Promise<Project | null> {
  const found = await run<Project | undefined>("readonly", (store) => store.get(id));
  return found ? normalizeProject(found) : null;
}

export async function listProjects(): Promise<Project[]> {
  const all = await run<Project[]>("readonly", (store) => store.getAll());
  return all.map(normalizeProject).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
}

/** A display name for a project that may not have one yet. */
export function projectLabel(project: Project): string {
  return (
    project.name.trim() ||
    project.titles.en?.trim() ||
    project.lines[0]?.kurdish?.slice(0, 40) ||
    `Untitled ${project.kind} · ${new Date(project.createdAt).toLocaleDateString()}`
  );
}

export function speakerName(project: Project, index: number): string {
  return project.speakers[index]?.name?.trim() || `Speaker ${index + 1}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
