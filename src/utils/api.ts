/** Calls to this app's own server. */

import type { Usage } from "../config/models";
import type { TranscriptLine } from "./transcript";

async function readError(res: Response, fallback: string): Promise<Error> {
  const detail = await res.json().catch(() => ({}));
  return new Error(detail?.error || `${fallback} (HTTP ${res.status})`);
}

export interface Health {
  status: string;
  version: string;
  ffmpeg: boolean;
  serverKey: boolean;
}

export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch("/api/health");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export interface TranscribeResult {
  lines: TranscriptLine[];
  timesTrusted: boolean;
  model: string;
  usage: Usage;
}

export async function transcribe(params: {
  wav: Blob;
  durationSeconds: number;
  taughtLang: string;
  context: string;
  model: string;
  apiKey: string;
  mode?: string;
  knownLines?: string[];
  speakers?: string[];
}): Promise<TranscribeResult> {
  const form = new FormData();
  if (params.mode) form.append("mode", params.mode);
  if (params.knownLines?.length) form.append("knownLines", JSON.stringify(params.knownLines));
  if (params.speakers?.length) form.append("speakers", JSON.stringify(params.speakers));
  form.append("audio", params.wav, "recording.wav");
  form.append("durationSeconds", String(params.durationSeconds));
  form.append("taughtLang", params.taughtLang);
  form.append("context", params.context);
  form.append("model", params.model);
  if (params.apiKey.trim()) form.append("userApiKey", params.apiKey.trim());
  const res = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!res.ok) throw await readError(res, "Transcription failed");
  return res.json();
}

export interface TranslateResult {
  lines: { transliteration: string; translations: Record<string, string> }[];
  titles: Record<string, string>;
  captions: Record<string, string>;
  model: string;
  usage: Usage;
}

export async function translate(params: {
  lines: string[];
  audiences: string[];
  taughtLang: string;
  note: string;
  context: string;
  model: string;
  apiKey: string;
  withTitles: boolean;
  surrounding?: string[];
  kind?: string;
}): Promise<TranslateResult> {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lines: params.lines,
      audiences: params.audiences,
      taughtLang: params.taughtLang,
      note: params.note,
      context: params.context,
      model: params.model,
      withTitles: params.withTitles,
      surrounding: params.surrounding,
      kind: params.kind,
      userApiKey: params.apiKey.trim() || undefined,
    }),
  });
  if (!res.ok) throw await readError(res, "Translation failed");
  return res.json();
}
