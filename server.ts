import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, createPartFromUri, type GenerateContentResponse } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { AUDIENCE_LANGUAGES, findAudienceLanguage, findTaughtLanguage } from "./src/config/languages";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_TRANSLATE_MODEL,
  TRANSCRIBE_FALLBACK_CHAIN,
  TRANSLATE_FALLBACK_CHAIN,
  type Usage,
} from "./src/config/models";
import {
  transcribePrompt,
  transcribeSystemPrompt,
  translatePrompt,
  translateSystemPrompt,
} from "./src/config/prompts";
import { normalizeTranscript } from "./src/utils/transcript";

dotenv.config();

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();
const PORT = Number(process.env.PORT) || 3100;

/** Read from package.json so it cannot drift from the released version. */
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
})();

app.use(express.json({ limit: "10mb" }));

/* ------------------------------------------------------------------ */
/* Gemini with credential and model fallback                            */
/* ------------------------------------------------------------------ */

function errorText(err: unknown): string {
  let message: any = (err as any)?.message ?? err;
  if (typeof message === "string" && message.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(message);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      /* not JSON after all */
    }
  }
  return String(message);
}

/** A rejected key, which no other model will accept either. */
function isCredentialProblem(err: unknown): boolean {
  const status = (err as any)?.status;
  if (status === 401 || status === 403) return true;
  const text = errorText(err).toLowerCase();
  return (
    text.includes("api key not valid") ||
    text.includes("api_key_invalid") ||
    text.includes("authentication credential") ||
    text.includes("unauthenticated") ||
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("unregistered callers")
  );
}

interface FallbackResult<T> {
  response: T;
  model: string;
}

/**
 * Tries the preferred model first, then the rest of the chain. A key typed into
 * the app wins over the one in .env, but a key that is rejected outright falls
 * back to .env rather than failing every request until someone clears the box.
 */
async function runWithFallback<T>(
  userApiKey: string | undefined,
  preferredModel: string,
  chain: string[],
  call: (client: GoogleGenAI, model: string) => Promise<T>
): Promise<FallbackResult<T>> {
  const userKey = (userApiKey || "").trim();
  const envKey = (process.env.GEMINI_API_KEY || "").trim();

  const keys: { key: string; label: string }[] = [];
  if (userKey) keys.push({ key: userKey, label: "key from the app" });
  if (envKey && envKey !== userKey) keys.push({ key: envKey, label: "key from .env" });
  if (!keys.length) {
    throw new Error("No Gemini API key. Paste one into Settings, or put GEMINI_API_KEY in .env.");
  }

  const models = [preferredModel, ...chain.filter((m) => m !== preferredModel)];
  let lastError: Error | null = null;

  for (const { key, label } of keys) {
    const client = new GoogleGenAI({ apiKey: key });
    let rejected = false;
    for (const model of models) {
      try {
        console.log(`→ ${model} (${label})`);
        const response = await call(client, model);
        if (response) return { response, model };
      } catch (err) {
        const message = errorText(err);
        console.warn(`  ${model} failed: ${message.slice(0, 300)}`);
        lastError = new Error(message);
        if (isCredentialProblem(err)) {
          rejected = true;
          break;
        }
      }
    }
    if (!rejected) break;
  }
  throw lastError || new Error("Every model attempt failed.");
}

function usageOf(response: GenerateContentResponse): Usage {
  const meta: any = response.usageMetadata || {};
  const audioTokens = Array.isArray(meta.promptTokensDetails)
    ? meta.promptTokensDetails
        .filter((d: any) => String(d?.modality).toUpperCase() === "AUDIO")
        .reduce((sum: number, d: any) => sum + (Number(d?.tokenCount) || 0), 0)
    : 0;
  return {
    inputTokens: Number(meta.promptTokenCount) || 0,
    audioTokens,
    outputTokens: (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0),
  };
}

function parseJson(text: string | undefined): any {
  const cleaned = (text || "{}")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/* ------------------------------------------------------------------ */
/* Health                                                               */
/* ------------------------------------------------------------------ */

app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    app: "leen-kurdish-studio",
    version: APP_VERSION,
    ffmpeg: await hasFfmpeg(),
    serverKey: Boolean((process.env.GEMINI_API_KEY || "").trim()),
  });
});

/* ------------------------------------------------------------------ */
/* 1. Transcribe: the recording in, Kurdish lines with times out         */
/* ------------------------------------------------------------------ */

/**
 * Inline audio is limited by the 20MB request cap. The browser sends 16kHz mono
 * WAV, about 1.9MB a minute, so inline covers recordings up to roughly seven
 * minutes; anything longer goes through the Files API.
 */
const INLINE_AUDIO_LIMIT = 14 * 1024 * 1024;

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/transcribe", audioUpload.single("audio"), async (req, res): Promise<any> => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: "No audio was sent." });

    const language = findTaughtLanguage(String(req.body?.taughtLang || ""));
    const durationSeconds = Number(req.body?.durationSeconds) || 0;
    const context = String(req.body?.context || "").slice(0, 2000);
    const preferredModel = String(req.body?.model || DEFAULT_TRANSCRIBE_MODEL);
    const mimeType = file.mimetype && file.mimetype !== "application/octet-stream" ? file.mimetype : "audio/wav";

    const prompt = transcribePrompt({ language, durationSeconds, context });

    const result = await runWithFallback(req.body?.userApiKey, preferredModel, TRANSCRIBE_FALLBACK_CHAIN, async (client, model) => {
      let audioPart: any;
      if (file.buffer.length <= INLINE_AUDIO_LIMIT) {
        audioPart = { inlineData: { mimeType, data: file.buffer.toString("base64") } };
      } else {
        const uploaded = await client.files.upload({
          file: new Blob([new Uint8Array(file.buffer)], { type: mimeType }),
          config: { mimeType },
        });
        // Large uploads are processed before they can be referenced.
        let info = uploaded;
        for (let i = 0; i < 60 && String(info.state) === "PROCESSING" && info.name; i++) {
          await sleep(1000);
          info = await client.files.get({ name: info.name });
        }
        if (!info.uri) throw new Error("The audio upload did not finish processing.");
        audioPart = createPartFromUri(info.uri, info.mimeType || mimeType);
      }

      return client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [audioPart, { text: prompt }] }],
        config: {
          systemInstruction: transcribeSystemPrompt(language),
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              lines: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    start: { type: Type.NUMBER },
                    end: { type: Type.NUMBER },
                  },
                  required: ["text", "start", "end"],
                },
              },
            },
            required: ["lines"],
          },
        },
      });
    });

    const data = parseJson(result.response.text);
    const transcript = normalizeTranscript(Array.isArray(data?.lines) ? data.lines : [], durationSeconds);
    console.log(
      `Transcribed ${transcript.lines.length} lines with ${result.model}` +
        (transcript.timesTrusted ? "" : " (times not usable — the app will place them from the audio)")
    );

    return res.json({ ...transcript, model: result.model, usage: usageOf(result.response) });
  } catch (error: any) {
    console.error("Transcription error:", error);
    return res.status(500).json({ error: error?.message || "Transcription failed." });
  }
});

/* ------------------------------------------------------------------ */
/* 2. Translate: Kurdish lines in, every audience language out          */
/* ------------------------------------------------------------------ */

/** One response cannot reliably hold a very long lesson; longer ones go in passes. */
const TRANSLATE_CHUNK = 30;

app.post("/api/translate", async (req, res): Promise<any> => {
  try {
    const language = findTaughtLanguage(String(req.body?.taughtLang || ""));
    const lines: string[] = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((l: unknown) =>
      String(l ?? "").trim()
    );
    if (!lines.length) return res.status(400).json({ error: "There are no lines to translate." });

    const requested: string[] = Array.isArray(req.body?.audiences) ? req.body.audiences : ["ar", "en"];
    const audiences = requested
      .map((id) => findAudienceLanguage(String(id)))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (!audiences.length) return res.status(400).json({ error: "Pick at least one language to translate into." });

    const note = String(req.body?.note || "").slice(0, 4000);
    const context = String(req.body?.context || "").slice(0, 2000);
    const withTitles = req.body?.withTitles !== false;
    const surrounding: string[] = Array.isArray(req.body?.surrounding)
      ? req.body.surrounding.map((s: unknown) => String(s ?? "")).slice(0, 60)
      : [];
    const preferredModel = String(req.body?.model || DEFAULT_TRANSLATE_MODEL);

    const languageProps: Record<string, any> = {};
    for (const a of audiences) languageProps[a.id] = { type: Type.STRING };

    const schema: any = {
      type: Type.OBJECT,
      properties: {
        lines: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              n: { type: Type.INTEGER },
              transliteration: { type: Type.STRING },
              ...languageProps,
            },
            required: ["n", "transliteration", ...audiences.map((a) => a.id)],
          },
        },
      },
      required: ["lines"],
    };
    if (withTitles) {
      schema.properties.titles = { type: Type.OBJECT, properties: languageProps, required: audiences.map((a) => a.id) };
      schema.properties.captions = { type: Type.OBJECT, properties: languageProps, required: audiences.map((a) => a.id) };
      schema.required.push("titles", "captions");
    }

    const out: Array<{ transliteration: string; translations: Record<string, string> }> = [];
    let titles: Record<string, string> = {};
    let captions: Record<string, string> = {};
    const usage: Usage = { inputTokens: 0, audioTokens: 0, outputTokens: 0 };
    let modelUsed = preferredModel;

    for (let offset = 0; offset < lines.length; offset += TRANSLATE_CHUNK) {
      const chunk = lines.slice(offset, offset + TRANSLATE_CHUNK);
      const first = offset === 0;
      // Later passes see the earlier lines so terms stay consistent.
      const priorContext = first ? surrounding : [...surrounding, ...lines.slice(Math.max(0, offset - 12), offset)];

      const result = await runWithFallback(req.body?.userApiKey, preferredModel, TRANSLATE_FALLBACK_CHAIN, (client, model) =>
        client.models.generateContent({
          model,
          contents: translatePrompt({
            language,
            audiences,
            lines: chunk,
            note,
            context,
            withTitles: withTitles && first,
            surrounding: priorContext,
          }),
          config: {
            systemInstruction: translateSystemPrompt(language),
            responseMimeType: "application/json",
            responseSchema: withTitles && first ? schema : { ...schema, properties: { lines: schema.properties.lines }, required: ["lines"] },
          },
        })
      );

      modelUsed = result.model;
      const u = usageOf(result.response);
      usage.inputTokens += u.inputTokens;
      usage.audioTokens += u.audioTokens;
      usage.outputTokens += u.outputTokens;

      const data = parseJson(result.response.text);
      const got: any[] = Array.isArray(data?.lines) ? data.lines : [];

      // Match by the echoed number, falling back to position.
      for (let i = 0; i < chunk.length; i++) {
        const hit = got.find((g) => Number(g?.n) === i + 1) ?? got[i] ?? {};
        const translations: Record<string, string> = {};
        for (const a of audiences) translations[a.id] = String(hit?.[a.id] ?? "").trim();
        out.push({ transliteration: String(hit?.transliteration ?? "").trim(), translations });
      }

      if (first && withTitles) {
        titles = data?.titles || {};
        captions = data?.captions || {};
      }
    }

    return res.json({ lines: out, titles, captions, model: modelUsed, usage });
  } catch (error: any) {
    console.error("Translation error:", error);
    return res.status(500).json({ error: error?.message || "Translation failed." });
  }
});

/** The audience languages the server knows, for a client that wants to check. */
app.get("/api/languages", (_req, res) => {
  res.json({ audiences: AUDIENCE_LANGUAGES.map(({ id, label, nativeLabel, rtl }) => ({ id, label, nativeLabel, rtl })) });
});

/* ------------------------------------------------------------------ */
/* 3. Video: frames uploaded in batches, then muxed with ffmpeg          */
/* ------------------------------------------------------------------ */

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

const frameUpload = multer({ dest: os.tmpdir() });

app.post("/api/render/start", async (_req, res): Promise<any> => {
  if (!(await hasFfmpeg())) {
    return res.status(503).json({
      error:
        "Making the MP4 needs ffmpeg. Install it (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg, Linux: sudo apt install ffmpeg) and restart the app.",
    });
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
    await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16 });
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

let ffmpegAvailable: boolean | null = null;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable) return true;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    // Not cached when missing, so installing it does not need a restart.
    ffmpegAvailable = null;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled API error:", err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: err?.message || "Internal server error" });
});

/**
 * The built bundle serves the built client. Detected from the file being run as
 * well as NODE_ENV, because `NODE_ENV=production node …` does not work in the
 * Windows command prompt.
 */
const PRODUCTION = process.env.NODE_ENV === "production" || /server\.cjs$/.test(process.argv[1] || "");

async function startServer() {
  if (!PRODUCTION) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Derived from PORT so a second copy on another port does not collide.
        hmr: { port: PORT + 21678 },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Leen Kurdish Studio ${APP_VERSION} running at http://localhost:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${PORT} is already in use — the app is probably already running.`);
      console.error(`Open http://localhost:${PORT}, or start this copy elsewhere: PORT=${PORT + 1} npm run dev\n`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
