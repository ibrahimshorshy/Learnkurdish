/**
 * Calling Gemini: credential and model fallback, usage accounting, and getting
 * audio into a request. Shared by every route that talks to the AI.
 */

import { GoogleGenAI, createPartFromUri, type GenerateContentResponse } from "@google/genai";
import type { Usage } from "../src/config/models";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function errorText(err: unknown): string {
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
export function isCredentialProblem(err: unknown): boolean {
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

/**
 * The key typed into the app, if it is one. Only a short string is passed on:
 * anything else would fail inside the SDK with an unhelpful error.
 */
export function userKeyOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && key.length <= 200 ? key : undefined;
}

/**
 * A model id as the app sends it ("gemini-3.8-flash", or with "models/" in
 * front). It becomes part of the request URL, so nothing with slashes or odd
 * characters gets through; anything else means `fallback`.
 */
export function modelIdOf(value: unknown, fallback: string): string {
  const id = String(value ?? "").trim();
  return /^(models\/)?[A-Za-z0-9][\w.-]{0,79}$/.test(id) ? id : fallback;
}

export interface FallbackResult<T> {
  response: T;
  model: string;
}

/**
 * Tries the preferred model first, then the rest of the chain. A key typed into
 * the app wins over the one in .env, but a key that is rejected outright falls
 * back to .env rather than failing every request until someone clears the box.
 */
export async function runWithFallback<T>(
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

export function usageOf(response: GenerateContentResponse): Usage {
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

export function parseJson(text: string | undefined): any {
  const cleaned = (text || "{}")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

/**
 * Inline audio is limited by the 20MB request cap. The browser sends 16kHz mono
 * WAV, about 1.9MB a minute, so inline covers recordings up to roughly seven
 * minutes; anything longer goes through the Files API.
 */
const INLINE_AUDIO_LIMIT = 14 * 1024 * 1024;

/** The audio as a request part: inline when small enough, uploaded otherwise. */
export async function audioPart(client: GoogleGenAI, buffer: Buffer, mimeType: string): Promise<any> {
  if (buffer.length <= INLINE_AUDIO_LIMIT) {
    return { inlineData: { mimeType, data: buffer.toString("base64") } };
  }
  const uploaded = await client.files.upload({
    file: new Blob([new Uint8Array(buffer)], { type: mimeType }),
    config: { mimeType },
  });
  // Large uploads are processed before they can be referenced.
  let info = uploaded;
  for (let i = 0; i < 60 && String(info.state) === "PROCESSING" && info.name; i++) {
    await sleep(1000);
    info = await client.files.get({ name: info.name });
  }
  if (!info.uri) throw new Error("The audio upload did not finish processing.");
  return createPartFromUri(info.uri, info.mimeType || mimeType);
}
