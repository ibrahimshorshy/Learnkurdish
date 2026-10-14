/**
 * Saving a Blob to disk, with a filename that survives the trip.
 *
 * Chrome ignores a `download` attribute whose value has no ASCII in it and
 * saves the file as "download", with no extension. Measured in Chromium:
 *
 *   "plain-ascii.srt"     -> "plain-ascii.srt"
 *   "with space.srt"      -> "with space.srt"
 *   "ڕستەی عێراقی.srt"     -> "download"
 *
 * Titles here are usually Arabic or Kurdish, so that is the common case rather
 * than the edge case. Names are reduced to ASCII, falling back to something
 * descriptive when nothing usable survives.
 */

/**
 * An ASCII filename base derived from `title`, or `fallback` when the title is
 * entirely non-Latin. Never includes an extension.
 */
export function asciiFileName(title: string, fallback: string): string {
  const base = (title || "")
    .normalize("NFKD")
    // Drop combining marks left behind by the decomposition.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  const cleaned = base.replace(/^[-_ ]+|[-_ ]+$/g, "");
  return cleaned || fallback;
}

/** Saves a Blob, keeping the anchor alive long enough for the browser to act. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}
