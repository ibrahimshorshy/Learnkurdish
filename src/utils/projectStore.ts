/**
 * Projects live in IndexedDB on this computer: the recording, the lines, the
 * translations and the finished videos.
 *
 * Unlike Reels Creator's seven-day library, nothing here expires. A recording
 * is your own voice and cannot be regenerated, so it is kept until you delete
 * it.
 */

import type { Project, VideoSettings } from "../types";
import { DEFAULT_THEME } from "../render/themes";
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

export function defaultVideoSettings(audiences: string[]): VideoSettings {
  return {
    theme: DEFAULT_THEME,
    resolution: DEFAULT_RESOLUTION,
    plays: 2,
    repeatGapMode: "auto",
    repeatGapSeconds: 2.5,
    gapBetweenLines: 0.6,
    showTransliteration: true,
    karaoke: false,
    intro: true,
    outro: true,
    outputs: audiences.map((id) => [id]),
  };
}

export function createProject(audiences: string[], video?: Partial<VideoSettings>): Project {
  const now = Date.now();
  return {
    id: newId(),
    name: "",
    createdAt: now,
    updatedAt: now,
    taughtLang: DEFAULT_TAUGHT_LANGUAGE,
    audiences,
    context: "",
    note: "",
    lines: [],
    titles: {},
    captions: {},
    step: "record",
    video: { ...defaultVideoSettings(audiences), ...video, outputs: audiences.map((id) => [id]) },
    renders: [],
    usage: { inputTokens: 0, audioTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

export async function saveProject(project: Project): Promise<void> {
  await run("readwrite", (store) => store.put({ ...project, updatedAt: Date.now() }));
}

export async function getProject(id: string): Promise<Project | null> {
  const found = await run<Project | undefined>("readonly", (store) => store.get(id));
  return found ?? null;
}

export async function listProjects(): Promise<Project[]> {
  const all = await run<Project[]>("readonly", (store) => store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
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
    `Untitled lesson · ${new Date(project.createdAt).toLocaleDateString()}`
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
