/**
 * Uploads: what each one is saved as, how big it may be, and which formats
 * ffmpeg may read it as.
 *
 * An upload is not always the app's own: with HOST set the server is open to
 * the local network, and the request guard (server/security.ts) is one fence,
 * not the only one. Two things keep a crafted upload harmless:
 *
 * - The browser's file name never chooses the extension. ffmpeg picks some
 *   formats by extension alone — a playlist named x.m3u8 is read as HLS and
 *   ffmpeg follows it to any file on the disk, which the route would then
 *   return. Each field is saved under a name of the server's choosing.
 * - Every `-i` of an upload carries -format_whitelist, so ffmpeg refuses any
 *   container but the expected ones whatever the bytes say (a concat list or
 *   playlist inside a file named .mp4 included).
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { Transform, pipeline } from "stream";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/* ------------------------------------------------------------------ */
/* Formats ffmpeg may open                                              */
/* ------------------------------------------------------------------ */

/**
 * Phone and camera videos: MP4/MOV/M4V/3GP (one demuxer), MKV/WebM, AVI,
 * and the older camera and PC formats the app also takes when dropped on it
 * (a camcorder's .mts, .mpg, .wmv, .flv, and Ogg/Theora .ogv, which the
 * browser also reports as video/*). None of these reads other files.
 */
export const VIDEO_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,asf,flv,ogg";
/** The browser's WAV encoder output. */
export const WAV_FORMATS = "wav";
/** A single PNG, whichever of the two image readers ffmpeg picks for it. */
export const PNG_FORMATS = "png_pipe,image2";
/** The app's own concat list of cue PNGs; the list's entries are held to it too. */
export const CUE_LIST_FORMATS = `concat,${PNG_FORMATS}`;

/** Input options that refuse any container outside `formats`. Goes before the `-i`. */
export function only(formats: string): string[] {
  return ["-format_whitelist", formats];
}

/* ------------------------------------------------------------------ */
/* Names and sizes, per field                                           */
/* ------------------------------------------------------------------ */

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"]);

/**
 * A video keeps its extension only when it is one of the expected ones, and
 * gets none otherwise: ffmpeg recognises these containers by their content,
 * so the name is only there to make a leftover file recognisable.
 */
export function videoExtension(originalName: string | undefined): string {
  const ext = path.extname(originalName || "").toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? ext : "";
}

export interface FieldRule {
  /** Largest single file. */
  maxBytes: number;
  /** Largest sum over all files of this field (for fields that take many). */
  maxTotalBytes?: number;
  /** The extension the file is saved with, from the browser's name for it. */
  extension: (originalName: string | undefined) => string;
}

/**
 * A disk storage that names every file itself (`<field>-<n><ext>`) and holds
 * each field to its own size: a subtitle image has no business being 8 GB
 * just because a video may be. A file over its limit stops the upload with
 * multer's LIMIT_FILE_SIZE and its partial copy is removed.
 */
export function fieldStorage(destination: (req: Request) => string, rules: Record<string, FieldRule>): multer.StorageEngine {
  const counts = new WeakMap<Request, { files: number; bytes: Record<string, number> }>();
  return {
    _handleFile(req, file, cb) {
      const rule = rules[file.fieldname];
      if (!rule) return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
      const tally = counts.get(req) ?? { files: 0, bytes: {} };
      counts.set(req, tally);
      tally.files++;

      const dir = destination(req);
      const filename = `${file.fieldname}-${tally.files}${rule.extension(file.originalname)}`;
      const target = path.join(dir, filename);
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          size += chunk.length;
          const total = (tally.bytes[file.fieldname] = (tally.bytes[file.fieldname] ?? 0) + chunk.length);
          if (size > rule.maxBytes || (rule.maxTotalBytes !== undefined && total > rule.maxTotalBytes)) {
            return next(new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname));
          }
          next(null, chunk);
        },
      });
      const out = fs.createWriteStream(target);
      pipeline(file.stream, meter, out, (err) => {
        if (err) {
          // Retries cover Windows, where the handle can take a moment to go.
          fs.rm(target, { force: true, maxRetries: 5, retryDelay: 100 }, () => cb(err));
          return;
        }
        cb(null, { destination: dir, filename, path: target, size });
      });
    },
    _removeFile(_req, file, cb) {
      fs.rm(file.path, { force: true, maxRetries: 5, retryDelay: 100 }, (err) => cb(err ?? null));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

const WHAT: Record<string, string> = {
  video: "The video",
  cue: "A subtitle image",
  overlay: "The logo image",
  audio: "The sound",
  frames: "A video frame",
  parts: "A part of the video",
};

/** A multer error as a status and a sentence for the person using the app. */
export function uploadProblem(err: unknown): { status: number; error: string } | null {
  if (!(err instanceof multer.MulterError)) return null;
  if (err.code === "LIMIT_FILE_SIZE") {
    return { status: 413, error: `${WHAT[err.field ?? ""] ?? "A file"} is too large to upload.` };
  }
  return { status: 400, error: `The upload was refused: ${err.message}.` };
}

/**
 * Runs a multer middleware and answers its refusals (too large, too many
 * files) as JSON the app can show, instead of a bare 500. `onRefused` runs
 * first, for routes that track a job.
 */
export function receive(upload: RequestHandler, onRefused?: (req: Request) => void): RequestHandler {
  return (req, res, next) =>
    upload(req, res, (err?: unknown) => {
      if (!err) return next();
      const problem = uploadProblem(err);
      // The browser hung up mid-upload (a cancel): multer has already removed
      // the partial files, and there is nobody to answer.
      if (!problem && !(req.destroyed || res.destroyed)) return next(err);
      onRefused?.(req);
      if (!problem || res.headersSent || res.writableEnded || res.destroyed) return;
      res.status(problem.status).json({ error: problem.error });
    });
}

/**
 * An async route whose failures reach Express's error handler. Express 4
 * ignores the promise an async handler returns, and Node ends the whole
 * process on a rejection nobody handles, so one bad request would otherwise
 * take the app down.
 */
export function asyncRoute<R extends Request = Request>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req as R, res, next).catch((err) => {
      console.error(`${req.method} ${req.path} failed:`, err);
      if (!res.headersSent) return next(err);
      // Half-sent: the browser cannot be told any more, only cut off.
      if (!res.writableEnded) res.destroy();
    });
  };
}
