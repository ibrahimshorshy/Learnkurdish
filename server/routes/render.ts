/**
 * Making the MP4: frames uploaded in batches, then muxed with ffmpeg against
 * the audio mixdown.
 */

import type { Express } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { FFMPEG_MISSING, ffmpeg, hasFfmpeg } from "../ffmpeg";

interface RenderSession {
  dir: string;
  touchedAt: number;
  frames: number;
}

const renderSessions = new Map<string, RenderSession>();

/** A session nobody has touched in this long was abandoned; its frames go. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of renderSessions) {
    if (now - session.touchedAt > SESSION_IDLE_MS) {
      fs.rmSync(session.dir, { recursive: true, force: true });
      renderSessions.delete(id);
      console.warn(`Swept render session ${id} after ${SESSION_IDLE_MS / 60000} idle minutes`);
    }
  }
}, 5 * 60 * 1000).unref();

export const frameUpload = multer({ dest: os.tmpdir() });

export function registerRenderRoutes(app: Express) {

  app.post("/api/render/start", async (_req, res): Promise<any> => {
    if (!(await hasFfmpeg())) {
      return res.status(503).json({ error: FFMPEG_MISSING });
    }
    const sessionId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `leen-ku-${sessionId}-`));
    renderSessions.set(sessionId, { dir, touchedAt: Date.now(), frames: 0 });
    return res.json({ sessionId });
  });

  app.post("/api/render/frames", frameUpload.array("frames", 200), async (req, res): Promise<any> => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    const files = (req.files as Express.Multer.File[]) || [];

    if (!session) {
      files.forEach((f) => fs.existsSync(f.path) && fs.unlinkSync(f.path));
      return res.status(404).json({ error: "Unknown render session. Start the video again." });
    }

    const startIndex = Number(req.body?.startIndex || 0);
    files.forEach((file, i) => {
      // ffmpeg's image sequence reader needs zero-padded, strictly ordered names.
      fs.renameSync(file.path, path.join(session.dir, `${String(startIndex + i).padStart(6, "0")}.jpg`));
    });
    session.frames = Math.max(session.frames, startIndex + files.length);
    session.touchedAt = Date.now();
    return res.json({ received: files.length, total: session.frames });
  });

  app.post("/api/render/finish", frameUpload.single("audio"), async (req, res): Promise<any> => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    const audioPath = req.file?.path;

    const cleanup = () => {
      if (session) fs.rmSync(session.dir, { recursive: true, force: true });
      renderSessions.delete(sessionId);
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    };

    if (!session) {
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      return res.status(404).json({ error: "Unknown render session." });
    }
    if (!session.frames) {
      cleanup();
      return res.status(400).json({ error: "No frames were uploaded for this video." });
    }

    const fps = Number(req.body?.fps) || 30;
    const outputPath = path.join(os.tmpdir(), `${sessionId}.mp4`);
    const started = Date.now();

    try {
      const args = ["-framerate", String(fps), "-i", path.join(session.dir, "%06d.jpg")];
      if (audioPath) args.push("-i", audioPath);
      args.push(
        "-map", "0:v:0",
        ...(audioPath ? ["-map", "1:a:0"] : []),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-threads", "0",
        ...(audioPath ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : []),
        // The frames define the length; trailing silence in the mixdown is dropped.
        "-shortest",
        "-movflags", "+faststart",
        "-loglevel", "error",
        "-y",
        outputPath
      );
      await ffmpeg(args);
      console.log(`Muxed ${session.frames} frames in ${Date.now() - started}ms`);

      res.download(outputPath, "lesson.mp4", () => {
        cleanup();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      });
    } catch (err) {
      console.error("Mux failed:", err);
      cleanup();
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      return res.status(500).json({ error: "Could not assemble the video from the rendered frames." });
    }
  });

  app.post("/api/render/abort", async (req, res): Promise<any> => {
    const sessionId = String(req.body?.sessionId || "");
    const session = renderSessions.get(sessionId);
    if (session) {
      fs.rmSync(session.dir, { recursive: true, force: true });
      renderSessions.delete(sessionId);
    }
    return res.json({ ok: true });
  });
}
