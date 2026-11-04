/**
 * Work that leaving the screen would throw away: a recording in progress, a
 * video being made, a video being uploaded.
 *
 * Whatever is doing it holds the guard while it runs (useRecorder does this
 * for every microphone, so no recording screen has to remember). The app asks
 * before a tab, the Library, a new project or another step takes the screen
 * away, and the browser asks before the page is closed or reloaded.
 */

const holds = new Map<symbol, string>();

/** Marks `what` as in progress until the returned function is called. */
export function holdLeave(what: string): () => void {
  const token = Symbol(what);
  holds.set(token, what);
  return () => {
    holds.delete(token);
  };
}

/** What is in progress right now, each said once. */
export function workInProgress(): string[] {
  return [...new Set(holds.values())];
}

/** True when nothing is in progress, or the teacher says to leave anyway. */
export function confirmLeave(): boolean {
  const work = workInProgress();
  if (!work.length) return true;
  return window.confirm(`${work.join("\n")}\n\nLeave anyway?`);
}

export const RECORDING_IN_PROGRESS = "A recording is in progress — leaving now throws it away.";
/**
 * After Done or an upload, the take is checked before it is stored. A project
 * that has nothing else in it yet has never been saved, so a take that lands
 * after it was left has nowhere to go.
 */
export const RECORDING_BEING_READ = "Your recording is still being read — leaving now may throw it away.";
export const RENDER_IN_PROGRESS = "A video is being made — leaving now cancels it.";
export const UPLOAD_IN_PROGRESS = "Your video is still being read — leaving now cancels it.";
