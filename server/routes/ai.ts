/**
 * The two AI steps: hearing the Kurdish, and translating it.
 */

import type { Express } from "express";
import multer from "multer";
import { Type } from "@google/genai";
import { AUDIENCE_LANGUAGES, findAudienceLanguage, findTaughtLanguage } from "../../src/config/languages";
import {
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_TRANSLATE_MODEL,
  TRANSCRIBE_FALLBACK_CHAIN,
  TRANSLATE_FALLBACK_CHAIN,
  type Usage,
} from "../../src/config/models";
import { translatePrompt, translateSystemPrompt } from "../../src/config/prompts";
import { transcribeMode, type TranscribeInput } from "../../src/config/transcribeModes";
import { normalizeTranscript } from "../../src/utils/transcript";
import { audioPart, modelIdOf, parseJson, runWithFallback, usageOf, userKeyOf } from "../gemini";

/**
 * The recording plus a few form fields. A story's text rides along as one JSON
 * field (knownLines), so the field limit is set for a long book chapter rather
 * than multer's 1 MB default.
 */
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 20, fieldSize: 8 * 1024 * 1024 },
});

/** A JSON array field from a multipart form, tolerating junk. */
function jsonList(value: unknown, limit: number): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((v) => String(v ?? "")).slice(0, limit) : [];
  } catch {
    return [];
  }
}

export function registerAiRoutes(app: Express) {
  /* ---------- transcribe: the recording in, Kurdish lines with times out ---------- */

  app.post("/api/transcribe", audioUpload.single("audio"), async (req, res): Promise<any> => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) return res.status(400).json({ error: "No audio was sent." });

      const input: TranscribeInput = {
        language: findTaughtLanguage(String(req.body?.taughtLang || "")),
        durationSeconds: Number(req.body?.durationSeconds) || 0,
        context: String(req.body?.context || "").slice(0, 2000),
        knownLines: jsonList(req.body?.knownLines, 2000).map((l) => l.trim()).filter(Boolean),
        speakers: jsonList(req.body?.speakers, 2),
      };
      const mode = transcribeMode(String(req.body?.mode || "lines"));
      const preferredModel = modelIdOf(req.body?.model, DEFAULT_TRANSCRIBE_MODEL);
      const mimeType = file.mimetype && file.mimetype !== "application/octet-stream" ? file.mimetype : "audio/wav";

      const result = await runWithFallback(userKeyOf(req.body?.userApiKey), preferredModel, TRANSCRIBE_FALLBACK_CHAIN, async (client, model) =>
        client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [await audioPart(client, file.buffer, mimeType), { text: mode.prompt(input) }] }],
          config: {
            systemInstruction: mode.systemPrompt(input),
            responseMimeType: "application/json",
            responseSchema: mode.schema(input),
          },
        })
      );

      const data = parseJson(result.response.text);
      const transcript = normalizeTranscript(mode.toRawLines(data, input), input.durationSeconds, mode.normalize);
      console.log(
        `Transcribed ${transcript.lines.length} lines (${req.body?.mode || "lines"}) with ${result.model}` +
          (transcript.timesTrusted ? "" : " (times not usable — the app will place them from the audio)")
      );

      return res.json({ ...transcript, model: result.model, usage: usageOf(result.response) });
    } catch (error: any) {
      console.error("Transcription error:", error);
      return res.status(500).json({ error: error?.message || "Transcription failed." });
    }
  });

  /* ---------- translate: Kurdish lines in, every audience language out ---------- */

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
      const preferredModel = modelIdOf(req.body?.model, DEFAULT_TRANSLATE_MODEL);
      const kind = String(req.body?.kind || "lesson");

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

        const result = await runWithFallback(userKeyOf(req.body?.userApiKey), preferredModel, TRANSLATE_FALLBACK_CHAIN, (client, model) =>
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
              kind,
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
}
