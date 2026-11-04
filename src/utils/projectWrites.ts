/**
 * Writing into a project from work that finishes later.
 *
 * A transcription, a translation, a render or a cleaned-up recording can take
 * a minute, and by then the teacher may have opened another project. Every
 * such write names the project it was started for. If that project is still
 * open it is changed in memory; if not, its saved copy is read, changed and
 * stored again. Either way the work lands where it belongs, never in whatever
 * happens to be open, and is not lost.
 *
 * Reads and writes of saved projects go through one queue, so a change to a
 * closed project cannot interleave with another change to it, with opening
 * it, or with deleting it.
 */

import type { Project, Recording } from "../types";

export type Patch = Partial<Project> | ((p: Project) => Partial<Project>);

export type WriteResult =
  /** Changed in memory: it is the open project. */
  | "open"
  /** Changed in the saved copy: it is not open. */
  | "saved"
  /** The patch changed nothing. */
  | "unchanged"
  /** Deleted meanwhile, so there was nothing to write into. */
  | "gone";

/** Runs tasks one after another, in the order they were queued. A failure does not stop the ones after it. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The app's one queue for reading, changing and deleting saved projects. */
export const inOrder = serialQueue();

/** What `patch` changes in `p`, or null when it changes nothing. */
export function changesOf(p: Project, patch: Patch): Partial<Project> | null {
  const changes = typeof patch === "function" ? patch(p) : patch;
  return changes && Object.keys(changes).length ? changes : null;
}

/**
 * Tells one recording from another, and stays the same when the project is
 * saved and read back (a Blob does not). The same size, length and type is
 * the same audio, as far as anything made from it is concerned.
 */
export function recordingSignature(recording: Recording | undefined): string {
  return recording ? `${recording.blob.size}:${recording.durationSeconds}:${recording.mimeType}` : "";
}

export interface ProjectWriterDeps {
  /** The project open right now, if any. Must change the moment another one is opened. */
  current: () => Project | null;
  /** Shows a changed version of the open project. */
  commit: (next: Project) => void;
  load: (id: string) => Promise<Project | null>;
  save: (project: Project) => Promise<void>;
  /** Defaults to the app's queue. */
  queue?: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * `write(projectId, patch)`: applies `patch` to that project, open or not.
 * An open project is changed at once; a closed one through the queue. The
 * promise rejects only when the browser's storage fails.
 */
export function createProjectWriter(deps: ProjectWriterDeps) {
  const queue = deps.queue ?? inOrder;

  const writeOpen = (id: string, patch: Patch): WriteResult | null => {
    const open = deps.current();
    if (!open || open.id !== id) return null;
    const changes = changesOf(open, patch);
    if (!changes) return "unchanged";
    deps.commit({ ...open, ...changes, id, updatedAt: Date.now() });
    return "open";
  };

  return function write(id: string, patch: Patch): Promise<WriteResult> {
    const now = writeOpen(id, patch);
    if (now) return Promise.resolve(now);
    return queue(async () => {
      // Opened again while this waited its turn: change it in memory.
      const reopened = writeOpen(id, patch);
      if (reopened) return reopened;
      const saved = await deps.load(id);
      if (!saved) return "gone";
      const changes = changesOf(saved, patch);
      if (!changes) return "unchanged";
      await deps.save({ ...saved, ...changes, id, updatedAt: Date.now() });
      return "saved";
    });
  };
}

export type ProjectWriter = ReturnType<typeof createProjectWriter>;
