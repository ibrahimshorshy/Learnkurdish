/**
 * Making the MP4: frames uploaded in batches, then muxed with ffmpeg against
 * the audio mixdown.
 */

import type { Express, Response } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { FFMPEG_MISSING, abortOnClose, ffmpeg, hasFfmpeg, isAborted } from "../ffmpeg";
import { BT709_OUTPUT, TAG_BT709, hasToneMapping, hdrToSdr, isHdr, toBt709 } from "../color";
import { GB, MB, VIDEO_FORMATS, WAV_FORMATS, asyncRoute, only, receive } from "../uploads";
import { probeMedia, type MediaInfo } from "./media";

export interface RenderSession {
  dir: string;
  touchedAt: number;
  frames: number;
  /** /finish is muxing it: nothing else may remove its frames. */
  busy?: boolean;
}

const renderSessions = new Map<string, RenderSession>();

/** A session nobody has touched in this long was abandoned; its frames go. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** The image sequence is named %06d.jpg, so it holds at most this many frames (over nine hours at 30fps). */
const MAX_FRAMES = 1_000_000;

/**
 * Renders open at once. The app makes one video at a time; a session the
 * browser abandoned without /abort lingers until the sweeper takes it, so
 * this leaves plenty of room for those and still stops a runaway client
 * from opening folders without end.
 */
const MAX_SESSIONS = 64;

/**
 * Removes in the background, retrying for Windows, where a file ffmpeg has
 * just closed can stay locked for a moment. Never throws: a leftover temp
 * file is not worth a crashed server.
 */
function remove(target: string | undefined, recursive = false) {
  if (!target) return;
  fs.rm(target, { recursive, force: true, maxRetries: 5, retryDelay: 200 }, (err) => {
    if (err) console.warn(`Could not remove ${target}:`, err.message);
  });
}

/**
 * The sessions to sweep at `now`: untouched for too long, and not being
 * muxed — a long mux can outlast the idle limit, and its frames are in use.
 */
export function staleSessions(sessions: Iterable<[string, RenderSession]>, now: number): string[] {
  const stale: string[] = [];
  for (const [id, session] of sessions) {
    if (!session.busy && now - session.touchedAt > SESSION_IDLE_MS) stale.push(id);
  }
  return stale;
}

setInterval(() => {
  // Nothing may escape a timer: an exception here would end the server.
  try {
    for (const id of staleSessions(renderSessions, Date.now())) {
      const session = renderSessions.get(id)!;
      renderSessions.delete(id);
      remove(session.dir, true);
      console.warn(`Swept render session ${id} after ${SESSION_IDLE_MS / 60000} idle minutes`);
    }
  } catch (err) {
    console.error("Sweeping render sessions failed:", err);
  }
}, 5 * 60 * 1000).unref();

/*
 * Upload limits, each well above what the app itself sends, so a client on
 * the network cannot fill the disk with one request. multer removes the
 * partial file when a limit is hit. Its own random names carry no extension,
 * so ffmpeg cannot be steered by one (see server/uploads.ts).
 */

/** Canvas frames as JPEG: a few hundred KB each, even at 1440p. */
export const frameUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * MB, files: 200, fields: 16 } });
/** The mixdown as a 16-bit stereo WAV: about 690 MB an hour. */
const audioUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 2 * GB, files: 1, fields: 16 } });
/** A video project's parts; the subtitled one can be as large as the video it came from. */
const partsUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 8 * GB, files: 8, fields: 16 } });

/**
 * Aborts when the browser goes away before the answer is sent, so the ffmpeg
 * for it stops. A hang-up that came while multer was still storing the
 * upload has already fired 'close' before the route runs; that counts too.
 */
function browserGone(res: Response): AbortSignal {
  const signal = abortOnClose(res);
  return res.destroyed ? AbortSignal.abort() : signal;
}

/**
 * Card renders (canvas frames, JPEG) are BT.601 full range like every JPEG.
 * They are converted to BT.709 so the card matches the subtitled video it
 * is joined to; see server/color.ts.
 */
const JPEG_TO_BT709 = `scale=${toBt709({ matrix: "bt470bg", range: "pc" })},format=yuv420p,${TAG_BT709}`;

/**
 * The graph that joins the parts: each picture converted to BT.709 (and
 * tone-mapped first if it is HDR), fitted into the frame at 30fps, each sound
 * brought to 48kHz stereo, then all of it end to end as [v] and [a].
 * `silentIndex` gives, for a part with no sound, the input holding its silence.
 */
export function joinGraph(
  infos: Pick<MediaInfo, "width" | "height" | "colour">[],
  silentIndex: Record<number, number>,
  width: number,
  height: number,
  toneMapping: boolean
): string {
  const chains: string[] = [];
  const pairs: string[] = [];
  infos.forEach((info, i) => {
    // Each part converted and labelled; otherwise the encoder takes the first
    // part's labels for the whole file, and every colour after a title card
    // (BT.601, like every JPEG) would shift.
    const hdr = hdrToSdr(info.colour, toneMapping);
    const size = info.width && info.height ? info : undefined;
    const matrix = hdr ? toBt709({ matrix: "bt709", range: "tv" }) : toBt709(info.colour, size);
    chains.push(
      `[${i}:v]${hdr ? `${hdr},` : ""}scale=${width}:${height}:${matrix}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,${TAG_BT709}[v${i}]`
    );
    const audioIn = i in silentIndex ? `[${silentIndex[i]}:a]` : `[${i}:a]`;
    // concat does not pad the start of a part: a sound track that starts
    // late, or has a hole, is filled with silence here, or everything after
    // it would play early against the picture.
    chains.push(`${audioIn}aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    pairs.push(`[v${i}][a${i}]`);
  });
  chains.push(`${pairs.join("")}concat=n=${infos.length}:v=1:a=1[v][a]`);
  return chains.join(";");
}

export function registerRenderRoutes(app: Express) {

  app.post("/api/render/start", asyncRoute(async (_req, res): Promise<any> => {
    if (!(await hasFfmpeg())) {
      return res.status(503).json({ error: FFMPEG_MISSING });
    }
    if (renderSessions.size >= MAX_SESSIONS) {
      return res.status(503).json({ error: "Too many videos are being made at once. Wait for one to finish and try again." });
    }
    const sessionId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leen-ku-${sessionId}-`));
    renderSessions.set(sessionId, { dir, touchedAt: Date.now(), frames: 0 });
    return res.json({ sessionId });
  }));

  app.post("/api/render/frames", receive(frameUpload.array("frames", 200)), (req, res): any => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    const files = (req.files as Express.Multer.File[]) || [];
    const discard = () => files.forEach((f) => remove(f.path));

    if (!session || session.busy) {
      discard();
      return res.status(404).json({ error: "Unknown render session. Start the video again." });
    }

    const startIndex = Math.floor(Number(req.body?.startIndex) || 0);
    if (startIndex < 0 || startIndex + files.length > MAX_FRAMES) {
      discard();
      return res.status(400).json({ error: "Frame numbers out of range." });
    }
    try {
      files.forEach((file, i) => {
        // ffmpeg's image sequence reader needs zero-padded, strictly ordered names.
        fs.renameSync(file.path, path.join(session.dir, `${String(startIndex + i).padStart(6, "0")}.jpg`));
      });
    } catch (err) {
      console.error("Storing frames failed:", err);
      discard();
      return res.status(500).json({ error: "Could not store the uploaded frames." });
    }
    session.frames = Math.max(session.frames, startIndex + files.length);
    session.touchedAt = Date.now();
    return res.json({ received: files.length, total: session.frames });
  });

  app.post("/api/render/finish", receive(audioUpload.single("audio")), asyncRoute(async (req, res): Promise<any> => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    const audioPath = req.file?.path;

    if (!session || session.busy) {
      remove(audioPath);
      return res.status(404).json({ error: "Unknown render session." });
    }
    // Held from here until it is cleaned up: the idle sweeper and /abort
    // leave a busy session alone, however long the mux takes.
    session.busy = true;
    session.touchedAt = Date.now();

    const outputPath = path.join(os.tmpdir(), `${sessionId}.mp4`);
    const cleanup = () => {
      renderSessions.delete(sessionId);
      remove(session.dir, true);
      remove(audioPath);
      remove(outputPath);
    };
    if (!session.frames) {
      cleanup();
      return res.status(400).json({ error: "No frames were uploaded for this video." });
    }

    // The browser closing the tab stops the mux; ffmpeg() settles only once
    // the process has exited, so the cleanup never pulls files from under it.
    const signal = browserGone(res);
    const fps = Math.min(120, Math.max(1, Number(req.body?.fps) || 30));
    const started = Date.now();
    let sending = false;

    try {
      const args = ["-framerate", String(fps), "-f", "image2", "-i", path.join(session.dir, "%06d.jpg")];
      if (audioPath) args.push(...only(WAV_FORMATS), "-i", audioPath);
      args.push(
        "-map", "0:v:0",
        ...(audioPath ? ["-map", "1:a:0"] : []),
        "-vf", JPEG_TO_BT709,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        ...BT709_OUTPUT,
        "-threads", "0",
        ...(audioPath ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []),
        // The frames define the length; trailing silence in the mixdown is dropped.
        "-shortest",
        "-movflags", "+faststart",
        "-loglevel", "error",
        "-y",
        outputPath
      );
      await ffmpeg(args, { signal });
      if (signal.aborted) return;
      console.log(`Muxed ${session.frames} frames in ${Date.now() - started}ms`);

      sending = true;
      res.download(outputPath, "lesson.mp4", cleanup);
    } catch (err) {
      if (isAborted(err) || signal.aborted) return;
      console.error("Mux failed:", err);
      return res.status(500).json({ error: "Could not assemble the video from the rendered frames." });
    } finally {
      if (!sending) cleanup();
    }
  }));

  app.post("/api/render/abort", (req, res) => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    // A session that is being muxed is cleaned up by /finish itself.
    if (session && !session.busy) {
      renderSessions.delete(sessionId);
      remove(session.dir, true);
    }
    res.json({ ok: true });
  });

  /**
   * Joins MP4 parts end to end — a video project's title card, the subtitled
   * video, its closing card. The parts come from different encoders (the
   * canvas renderer and the subtitle burner), so each is brought to the same
   * size, frame rate, pixel format, colours and audio layout before ffmpeg's
   * concat filter; a part with no sound gets silence so the streams stay
   * paired.
   */
  app.post("/api/render/join", receive(partsUpload.array("parts", 8)), asyncRoute(async (req, res): Promise<any> => {
    const files = (req.files as Express.Multer.File[]) || [];
    const outputPath = path.join(os.tmpdir(), `join-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.mp4`);
    const cleanup = () => {
      files.forEach((f) => remove(f.path));
      remove(outputPath);
    };
    // Cancelling in the app aborts this request: the encode stops with it.
    const signal = browserGone(res);
    let sending = false;

    try {
      if (!(await hasFfmpeg())) {
        return res.status(503).json({ error: FFMPEG_MISSING });
      }
      if (files.length < 2) {
        return res.status(400).json({ error: "Joining needs at least two parts." });
      }
      const width = Math.round((Number(req.body?.width) || 1080) / 2) * 2;
      const height = Math.round((Number(req.body?.height) || 1920) / 2) * 2;
      if (width < 240 || width > 4096 || height < 240 || height > 4096) {
        return res.status(400).json({ error: `Unsupported output size ${width}x${height}.` });
      }

      // allSettled, not all: every probe has exited before anything is removed.
      const probes = await Promise.allSettled(files.map((f) => probeMedia(f.path, { signal })));
      if (signal.aborted) return;
      const failed = probes.find((p): p is PromiseRejectedResult => p.status === "rejected");
      if (failed) throw failed.reason;
      const infos = probes.map((p) => (p as PromiseFulfilledResult<MediaInfo>).value);
      if (infos.some((info) => !info.hasVideo)) {
        return res.status(400).json({ error: "One of the parts is not a video this app can read." });
      }

      const args: string[] = [];
      files.forEach((f) => args.push(...only(VIDEO_FORMATS), "-i", f.path));
      // One silent source per part without sound, after the real inputs.
      const silentIndex: Record<number, number> = {};
      infos.forEach((info, i) => {
        if (!info.hasAudio) {
          silentIndex[i] = files.length + Object.keys(silentIndex).length;
          args.push("-f", "lavfi", "-t", String(Math.max(0.1, info.durationSeconds || 0.1)), "-i", "anullsrc=r=48000:cl=stereo");
        }
      });
      // The app's own parts are already SDR; an HDR one would have to be
      // tone-mapped like a source video is, or it would look washed out.
      const toneMapping = infos.some((info) => isHdr(info.colour)) && (await hasToneMapping());
      if (signal.aborted) return;
      args.push(
        "-filter_complex", joinGraph(infos, silentIndex, width, height, toneMapping),
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        ...BT709_OUTPUT,
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-loglevel", "error",
        "-y",
        outputPath
      );
      await ffmpeg(args, { signal });
      if (signal.aborted) return;
      sending = true;
      res.download(outputPath, "video.mp4", cleanup);
    } catch (err) {
      if (isAborted(err) || signal.aborted) return;
      console.error("Join failed:", err);
      return res.status(500).json({ error: "Could not join the title card, the video and the closing card." });
    } finally {
      if (!sending) cleanup();
    }
  }));
}
