/**
 * Calls to the server's video routes (server/routes/media.ts).
 *
 * These use XMLHttpRequest rather than fetch for one reason: a video is
 * hundreds of megabytes, and fetch cannot report how much of an upload has
 * gone. Without that the bar would sit at zero for the whole upload.
 */

export interface UploadProgress {
  /** "upload" while the file is going up; "server" while the server works on it. */
  stage: "upload" | "server";
  /** 0..1 within the stage. */
  fraction: number;
}

/** Turns an error response (JSON {error}, sometimes delivered as a Blob) into a readable Error. */
async function errorFrom(xhr: XMLHttpRequest, fallback: string): Promise<Error> {
  let text = "";
  try {
    text = xhr.response instanceof Blob ? await xhr.response.text() : String(xhr.responseText ?? "");
  } catch {
    /* no body */
  }
  try {
    const detail = JSON.parse(text);
    if (detail?.error) return new Error(detail.error);
  } catch {
    /* not JSON */
  }
  return new Error(`${fallback} (HTTP ${xhr.status})`);
}

function send(
  url: string,
  form: FormData,
  options: { signal?: AbortSignal; onUpload?: (fraction: number) => void; fallback: string }
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new DOMException("Cancelled.", "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "blob";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onUpload?.(e.loaded / Math.max(1, e.total));
    };
    xhr.upload.onload = () => options.onUpload?.(1);
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
      else reject(await errorFrom(xhr, options.fallback));
    };
    xhr.onerror = () =>
      reject(new Error(`${options.fallback}: the app's server did not answer. Is it still running?`));
    xhr.onabort = () => reject(new DOMException("Cancelled.", "AbortError"));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/* ------------------------------------------------------------------ */
/* Step 1: the sound out of the video                                    */
/* ------------------------------------------------------------------ */

export interface ExtractedAudio {
  /** 48kHz mono WAV of the video's sound. */
  wav: Blob;
  /** The picture as displayed (after rotation); 0 when the server could not tell. */
  width: number;
  height: number;
  durationSeconds: number;
}

export async function extractVideoAudio(
  video: Blob,
  fileName: string,
  options: { signal?: AbortSignal; onProgress?: (p: UploadProgress) => void } = {}
): Promise<ExtractedAudio> {
  const form = new FormData();
  form.append("video", video, fileName || "video.mp4");
  const xhr = await send("/api/media/extract-audio", form, {
    signal: options.signal,
    fallback: "Could not read the video",
    onUpload: (fraction) => options.onProgress?.({ stage: fraction >= 1 ? "server" : "upload", fraction }),
  });
  const header = (name: string) => Number(xhr.getResponseHeader(name)) || 0;
  const wav = xhr.response as Blob;
  return {
    wav: wav.type === "audio/wav" ? wav : new Blob([wav], { type: "audio/wav" }),
    width: header("X-Media-Width"),
    height: header("X-Media-Height"),
    durationSeconds: header("X-Media-Duration"),
  };
}

/**
 * Size and length as the browser sees them — a second opinion for when the
 * server could not tell, and a check that the browser can play the file at
 * all (it may not, for some MKV and HEVC files; the server still can).
 */
export function readVideoMeta(
  blob: Blob,
  timeoutMs = 8000
): Promise<{ width: number; height: number; durationSeconds: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const finish = (value: { width: number; height: number; durationSeconds: number } | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.onloadedmetadata = () =>
      finish({
        width: video.videoWidth,
        height: video.videoHeight,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
      });
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Step 4: the subtitled MP4                                            */
/* ------------------------------------------------------------------ */

export interface SubtitledRenderRequest {
  video: Blob;
  videoName: string;
  /** One PNG per cue, all the size of `cueRect`. */
  cues: { png: Blob; start: number; end: number }[];
  /** Where the cue PNGs go in the frame. */
  cueRect: { x: number; y: number };
  overlay?: { png: Blob; x: number; y: number } | null;
  /** Replaces the video's own sound when given. */
  audio?: Blob | null;
  width: number;
  height: number;
  fit: "blur" | "crop";
}

export interface RenderProgress {
  stage: "upload" | "encoding";
  fraction: number;
}

/** Sends everything, follows ffmpeg's progress, and returns the MP4. */
export async function renderSubtitledVideo(
  request: SubtitledRenderRequest,
  options: { signal?: AbortSignal; onProgress?: (p: RenderProgress) => void } = {}
): Promise<Blob> {
  const job = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const form = new FormData();
  form.append("width", String(request.width));
  form.append("height", String(request.height));
  form.append("fit", request.fit);
  form.append("cueX", String(request.cueRect.x));
  form.append("cueY", String(request.cueRect.y));
  const names = request.cues.map((_, i) => `cue-${String(i).padStart(5, "0")}.png`);
  form.append("cues", JSON.stringify(request.cues.map((c, i) => ({ file: names[i], start: c.start, end: c.end }))));
  if (request.overlay) {
    form.append("overlayX", String(request.overlay.x));
    form.append("overlayY", String(request.overlay.y));
  }
  request.cues.forEach((c, i) => form.append("cue", c.png, names[i]));
  if (request.overlay) form.append("overlay", request.overlay.png, "overlay.png");
  if (request.audio) form.append("audio", request.audio, "audio.wav");
  form.append("video", request.video, request.videoName || "video.mp4");

  let uploaded = false;
  let polling: number | null = null;
  const poll = async () => {
    try {
      const res = await fetch(`/api/render/subtitled/progress?job=${job}`);
      const data = await res.json();
      if (data?.stage === "encoding") options.onProgress?.({ stage: "encoding", fraction: Number(data.fraction) || 0 });
    } catch {
      /* a missed tick is harmless */
    }
  };

  const cancelOnServer = () => {
    void fetch(`/api/render/subtitled/cancel?job=${job}`, { method: "POST" }).catch(() => {});
  };
  options.signal?.addEventListener("abort", cancelOnServer, { once: true });

  try {
    const xhr = await send(`/api/render/subtitled?job=${job}`, form, {
      signal: options.signal,
      fallback: "Making the subtitled video failed",
      onUpload: (fraction) => {
        if (!uploaded) options.onProgress?.({ stage: "upload", fraction });
        if (fraction >= 1 && !uploaded) {
          uploaded = true;
          options.onProgress?.({ stage: "encoding", fraction: 0 });
          polling = window.setInterval(poll, 700);
        }
      },
    });
    options.onProgress?.({ stage: "encoding", fraction: 1 });
    const blob = xhr.response as Blob;
    return blob.type === "video/mp4" ? blob : new Blob([blob], { type: "video/mp4" });
  } finally {
    if (polling !== null) window.clearInterval(polling);
    options.signal?.removeEventListener("abort", cancelOnServer);
  }
}
