/**
 * Intro and outro cards: the AI writes their words, and an AI voice reads them
 * aloud.
 *
 *   POST /api/cards/write — a short card per audience language, from the
 *                           lesson's title and first lines
 *   POST /api/tts         — one card's words in one language, spoken
 *
 * The voice is only ever used for the cards, in the audience's language.
 * Nothing Kurdish is synthesized: the lesson is the teacher's own recording.
 */

import type { Express } from "express";
import { Type } from "@google/genai";
import { findAudienceLanguage, findTaughtLanguage, type AudienceLanguage } from "../../src/config/languages";
import { DEFAULT_TRANSLATE_MODEL, TRANSLATE_FALLBACK_CHAIN } from "../../src/config/models";
import {
  CARD_LINES_SENT,
  cardWritePrompt,
  cardWriteSystemPrompt,
  cleanCardText,
  type CardWhich,
} from "../../src/config/prompts/cards";
import { VOICE_FALLBACK_CHAIN, safeVoiceModel, safeVoiceName } from "../../src/config/voices";
import { buildTtsRequest } from "../../src/config/ttsRequest";
import { errorText, isCredentialProblem, parseJson, runWithFallback, usageOf, type FallbackResult } from "../gemini";
import { abortOnClose } from "../ffmpeg";

/** Longest card text the voice is asked to read. A card is a sentence, not a paragraph. */
const TTS_MAX_CHARS = 600;

/**
 * A per-minute cap is a wait, not a refusal. Told apart from the error text
 * because runWithFallback hands back a plain Error.
 */
function isRateLimited(err: unknown): boolean {
  const status = (err as any)?.status;
  if (status === 429) return true;
  const text = errorText(err).toLowerCase();
  return (
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("resource_exhausted") ||
    text.includes("resource exhausted") ||
    text.includes("429")
  );
}

/**
 * The key typed into the app, if it is one. Only a short string is passed on:
 * anything else would fail inside the SDK with an unhelpful error.
 */
function userKeyOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 200 ? key : undefined;
}

/**
 * A text model id as the app sends it ("gemini-3.8-flash", or with "models/"
 * in front). It becomes part of the request URL, so nothing with slashes or
 * odd characters gets through; anything else means the default.
 */
function textModelOf(value: unknown): string {
  const id = String(value ?? "").trim();
  return /^(models\/)?[A-Za-z0-9][\w.-]{0,79}$/.test(id) ? id : DEFAULT_TRANSLATE_MODEL;
}

/** Waits `ms`, or less if the request goes away meanwhile. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function stringMap(value: unknown, keys: string[], limit: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const key of keys) {
    const text = String((value as any)[key] ?? "").trim();
    if (text) out[key] = text.slice(0, limit);
  }
  return out;
}

export function registerCardRoutes(app: Express) {
  /* ---------- write: a short card per audience language ---------- */

  app.post("/api/cards/write", async (req, res): Promise<any> => {
    try {
      const which: CardWhich = req.body?.which === "outro" ? "outro" : "intro";
      const requested: unknown[] = Array.isArray(req.body?.audiences) ? req.body.audiences.slice(0, 20) : [];
      // Each language once: a repeated id would ask the AI for the same field twice.
      const audiences = [...new Set(requested.map((id) => findAudienceLanguage(String(id))))].filter(
        (a): a is AudienceLanguage => Boolean(a)
      );
      if (!audiences.length) return res.status(400).json({ error: "Pick at least one language for the card." });
      const ids = audiences.map((a) => a.id);

      const lines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
        .slice(0, CARD_LINES_SENT)
        .map((l: any) => ({
          kurdish: String(l?.kurdish ?? "").slice(0, 400),
          translations: stringMap(l?.translations, ids, 400),
        }))
        .filter((l: { kurdish: string }) => l.kurdish.trim());

      const preferredModel = textModelOf(req.body?.model);
      const languageProps: Record<string, any> = {};
      for (const id of ids) languageProps[id] = { type: Type.STRING };

      const result = await runWithFallback(userKeyOf(req.body?.userApiKey), preferredModel, TRANSLATE_FALLBACK_CHAIN, (client, model) =>
        client.models.generateContent({
          model,
          contents: cardWritePrompt({
            which,
            kind: String(req.body?.kind || "lesson").slice(0, 40),
            language: findTaughtLanguage(String(req.body?.taughtLang || "")),
            audiences,
            titles: stringMap(req.body?.titles, ids, 200),
            lines,
            note: String(req.body?.note || "").slice(0, 1000),
            previous: stringMap(req.body?.previous, ids, 400),
          }),
          config: {
            systemInstruction: cardWriteSystemPrompt(findTaughtLanguage(String(req.body?.taughtLang || ""))),
            responseMimeType: "application/json",
            responseSchema: { type: Type.OBJECT, properties: languageProps, required: ids },
            // "Write again" should come back different, so a little more room than translation.
            temperature: 1,
          },
        })
      );

      const data = parseJson(result.response.text);
      const text: Record<string, string> = {};
      for (const id of ids) text[id] = cleanCardText(data?.[id]);
      if (!Object.values(text).some(Boolean)) throw new Error("The AI returned an empty card. Try again.");

      console.log(`Wrote the ${which} card (${ids.join("+")}) with ${result.model}`);
      return res.json({ text, model: result.model, usage: usageOf(result.response) });
    } catch (error: any) {
      console.error("Card writing error:", error);
      return res.status(500).json({ error: error?.message || "Could not write the card." });
    }
  });

  /* ---------- tts: one card's words, spoken ---------- */

  app.post("/api/tts", async (req, res): Promise<any> => {
    // The app cancels a voice it no longer needs; the waiting and retrying stop with it.
    const signal = abortOnClose(res);
    try {
      const spoken = String(req.body?.text ?? "").trim();
      if (!spoken) return res.status(400).json({ error: "There is no text to read." });
      if (spoken.length > TTS_MAX_CHARS) {
        return res.status(400).json({ error: `The card text is too long to read aloud — keep it under ${TTS_MAX_CHARS} characters.` });
      }
      const voiceName = safeVoiceName(req.body?.voiceName);
      const preferredModel = safeVoiceModel(req.body?.model);
      const userApiKey = userKeyOf(req.body?.userApiKey);

      console.log(`TTS: voice=[${voiceName}] chars=[${spoken.length}] — words only, no direction`);

      // The request carries the spoken words and nothing else; see config/ttsRequest.
      const synthesize = (client: any, model: string) =>
        client.models.generateContent(buildTtsRequest({ model, voiceName, text: spoken }) as any);

      /*
       * The speech models are capped per minute, and "make voice for every
       * language" fires several requests back to back. Falling through to
       * another model on a rate limit would make the Arabic and the English
       * card sound like two different people, so the preferred model gets the
       * retries to itself first; the rest of the chain is only for a model that
       * is genuinely refusing rather than busy.
       */
      const RATE_LIMIT_WAITS_MS = [12_000, 24_000, 36_000];
      let result: FallbackResult<any> | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= RATE_LIMIT_WAITS_MS.length; attempt++) {
        try {
          result = await runWithFallback(userApiKey, preferredModel, [preferredModel], synthesize);
          break;
        } catch (err) {
          lastError = err;
          if (isCredentialProblem(err) || !isRateLimited(err)) break;
          if (attempt === RATE_LIMIT_WAITS_MS.length) break;
          const waitMs = RATE_LIMIT_WAITS_MS[attempt];
          console.log(`TTS rate limited on ${preferredModel}; waiting ${waitMs / 1000}s rather than switching voice model.`);
          await pause(waitMs, signal);
          if (signal.aborted) break;
        }
      }
      if (signal.aborted) {
        console.log("TTS stopped: the app no longer wanted it.");
        return;
      }

      // Still nothing: another model's voice is better than no audio at all.
      if (!result && !isCredentialProblem(lastError)) {
        try {
          result = await runWithFallback(userApiKey, preferredModel, VOICE_FALLBACK_CHAIN, synthesize);
        } catch (err) {
          lastError = err;
        }
      }

      if (!result) {
        if (isRateLimited(lastError)) {
          return res.status(429).json({
            error: "The AI voice is rate limited right now. Wait a minute and try again.",
            retryAfterMs: 30_000,
          });
        }
        throw lastError || new Error("Speech synthesis failed.");
      }

      const payload = result.response?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData;
      if (!payload?.data) throw new Error("The speech model returned no audio.");

      return res.json({
        base64Audio: payload.data,
        // Passed on rather than assumed: some models send headerless PCM
        // ("audio/L16;codec=pcm;rate=24000"), others a WAV. The client decodes by it.
        mimeType: payload.mimeType || null,
        model: result.model,
        voiceName,
      });
    } catch (error: any) {
      console.error("TTS error:", error);
      if (signal.aborted) return;
      return res.status(500).json({ error: errorText(error) || "Could not make the voice." });
    }
  });
}
