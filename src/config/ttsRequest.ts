/**
 * What is sent to the speech model: the words to be spoken, and nothing else.
 *
 * Every earlier version sent a style direction alongside the line — pace and
 * accent — and every one of them was, at some point, read out loud in a
 * finished video. The history, so it is not repeated:
 *
 *   - a paragraph of phonetic notes in front of the line: narrated, letter
 *     examples and all, as a burst of "k-ch-k-ch" at every speaker change.
 *   - a one-sentence direction: narrated on gemini-3.8-flash-tts, measured
 *     2.28s bare against 7.44s directed for the same four words.
 *   - `systemInstruction`: rejected outright by every TTS model, 400
 *     "Developer instruction is not enabled for this model".
 *   - a fenced template with a #### TRANSCRIPT delimiter: shipped without being
 *     heard, because the speech quota was exhausted, and reported still read.
 *
 * Each of those depends on the model choosing to treat some of the text as
 * direction. That is a probability, and a narrated paragraph in a published
 * video is not a cost worth paying again. A request whose only content is the
 * sentence cannot contain a direction to read — which is a property of the
 * request, checkable without calling the model at all.
 *
 * What this gives up, said plainly: the model is no longer told an accent or a
 * pace. The accent comes from the text, read as written, at the model's
 * natural speed.
 *
 * Copied from Reels Creator, where that history happened. Here it voices only
 * the title and closing cards, in the audience's language — never Kurdish.
 */

export interface TtsRequest {
  model: string;
  contents: { role: string; parts: { text: string }[] }[];
  config: {
    responseModalities: string[];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
}

/** Words that mark a leading clause as delivery direction rather than speech. */
const DIRECTION_WORDS =
  /\b(?:aloud|accent|voice|tone|pace|pacing|slowly|naturally|clearly|dialect|style|narrator|voiceover)\b/i;

/**
 * Strips a delivery direction that has found its way into the words themselves.
 *
 * No direction is ever added here, so this only guards against one arriving
 * with the text — a lesson line written as "Say slowly: صباح الخير" would
 * otherwise be read out whole. A leading clause is taken as direction only when
 * it both opens with a speaking verb and talks about delivery, so an ordinary
 * line like "Read the sign: Exit" survives intact.
 */
export function stripDirectionPrefix(spokenText: string): string {
  const original = String(spokenText ?? "");
  let text = original;

  for (let pass = 0; pass < 3; pass++) {
    const before = text;

    // "Say slowly and clearly: ..." / "Read the following aloud in an Iraqi accent: ..."
    const lead = /^\s*(?:please\s+)?(?:read|say|speak|perform|narrate|pronounce)\b([^\n:]{0,200}):\s*/i.exec(text);
    if (lead && DIRECTION_WORDS.test(lead[0])) text = text.slice(lead[0].length);

    // A whole template pasted in: drop everything up to and including its
    // transcript marker.
    const marker = /^[\s\S]{0,2000}?#{2,}\s*transcript\s*:?\s*\n/i.exec(text);
    if (marker && /perform the voiceover|direction only|#\s*audio profile|#+\s*performance/i.test(marker[0])) {
      text = text.slice(marker[0].length);
    }

    // A stray heading on its own.
    text = text.replace(/^\s*#+\s*(?:transcript|performance|audio profile)\b[^\n]*\n/i, "");

    text = text.trimStart();
    if (text === before) break;
  }

  // Never strip a line down to nothing: an empty clip is worse than a strange one.
  return text.trim() || original.trim();
}

/** The request: the spoken words as the whole of the content. */
export function buildTtsRequest(options: { model: string; voiceName: string; text: string }): TtsRequest {
  const { model, voiceName, text } = options;
  return {
    model,
    contents: [{ role: "user", parts: [{ text: stripDirectionPrefix(text) }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  };
}
