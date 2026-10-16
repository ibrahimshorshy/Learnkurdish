import {
  CARD_TIMING,
  cardLength,
  cardSpokenText,
  clipIsUsable,
  clipMadeFrom,
  clipSpans,
  clipStatus,
  defaultCardText,
  madeFromParts,
  speakingLanguage,
  spokenCase,
} from "../src/render/cards.ts";
import { buildTtsRequest, stripDirectionPrefix } from "../src/config/ttsRequest.ts";
import { CARD_LINES_SENT, CARD_MAX_WORDS, cardWritePrompt, cleanCardText } from "../src/config/prompts/cards.ts";
import { DEFAULT_MALE_VOICE, DEFAULT_VOICE_MODEL, safeVoiceModel, safeVoiceName } from "../src/config/voices.ts";
import { findAudienceLanguage, findTaughtLanguage } from "../src/config/languages.ts";
import {
  base64ToArrayBuffer,
  decodePcmPayload,
  isPcmPayload,
  pcm16ToMono,
  sampleRateFromMime,
  trimToSpeech,
  ttsPayloadToSound,
  unwrapWav,
} from "../src/audio/ttsAudio.ts";
import { check, near, done } from "./harness.mjs";

/* ---------- card length ---------- */

const { leadIn, betweenClips, tail, introMin, outroMin } = CARD_TIMING;
check("a card that is off takes no time", cardLength({ enabled: false, clips: [{ duration: 3 }] }, introMin) === 0);
check("a silent card lasts the minimum", cardLength({ enabled: true, clips: [] }, introMin) === introMin);
check("a short clip still gets the minimum", cardLength({ enabled: true, clips: [{ duration: 0.5 }] }, outroMin) === outroMin);
check(
  "two clips play back to back with a breath around them",
  near(cardLength({ enabled: true, clips: [{ duration: 2 }, { duration: 1.5 }] }, introMin), leadIn + 2 + betweenClips + 1.5 + tail, 1e-9)
);
const spans = clipSpans({ clips: [{ duration: 2 }, { duration: 1.5 }] });
check("first clip starts after the lead-in", near(spans[0].start, leadIn, 1e-9));
check("second clip starts after the first and a breath", near(spans[1].start, leadIn + 2 + betweenClips, 1e-9));

/* ---------- which language is being spoken ---------- */

const bilingual = { enabled: true, texts: ["", ""], clips: [{ duration: 2 }, { duration: 1.5 }], clipLanguages: [0, 1] };
check("nothing highlighted before the first clip", speakingLanguage(bilingual, 0.1) === null);
check("first language while its clip plays", speakingLanguage(bilingual, 1) === 0);
check("first language stays lit through the breath", speakingLanguage(bilingual, leadIn + 2 + 0.1) === 0);
check("second language once its clip starts", speakingLanguage(bilingual, leadIn + 2 + betweenClips + 0.1) === 1);
check("everything lit again after the last clip", speakingLanguage(bilingual, 10) === null);
check(
  "one language never highlights",
  speakingLanguage({ ...bilingual, clips: [{ duration: 2 }], clipLanguages: [0] }, 1) === null
);
check("no language map, no highlight", speakingLanguage({ ...bilingual, clipLanguages: undefined }, 1) === null);

/* ---------- default words ---------- */

const titles = { ar: "التحيات بالكردية", en: "" };
check("intro default is the title", defaultCardText("intro", "ar", titles) === "التحيات بالكردية");
check("intro default without a title is get-ready, in sentence case", defaultCardText("intro", "en", titles) === "Get ready to listen");
check("Arabic get-ready is untouched", defaultCardText("intro", "ar", {}) === findAudienceLanguage("ar").strings.getReady);
check("Turkish capitals lower with Turkish rules", spokenCase("DİNLEMEYE HAZIR OL", "tr") === "Dinlemeye hazır ol");
check("mixed case is left alone", spokenCase("Well done!", "en") === "Well done!");
check("outro default is well done + follow", defaultCardText("outro", "en", {}) === "Well done! Follow for a new Kurdish lesson");
check("custom text wins", cardSpokenText({ text: { en: " Hi there " } }, "intro", "en", titles) === "Hi there");
check("blank custom text falls back", cardSpokenText({ text: { en: "   " } }, "outro", "en", titles) === defaultCardText("outro", "en", titles));

/* ---------- staleness ---------- */

const blob = { size: 10 };
const aiCard = (overrides = {}) => ({
  audio: "ai",
  voice: "Charon",
  text: { en: "Learn to say hello" },
  clips: { en: { blob, mimeType: "audio/wav", durationSeconds: 2, source: "ai", madeFrom: clipMadeFrom("Charon", "Learn to say hello") } },
  ...overrides,
});
check("made-from round trips", madeFromParts(clipMadeFrom("Kore", "a|b"))?.text === "a|b" && madeFromParts("Kore|x")?.voice === "Kore");
check("no made-from, no parts", madeFromParts(undefined) === null && madeFromParts("nobar") === null);
check("fresh AI clip is ready", clipStatus(aiCard(), "intro", "en", {}) === "ready");
check("missing clip", clipStatus(aiCard(), "intro", "ar", {}) === "missing");
check("edited words make it stale", clipStatus(aiCard({ text: { en: "Learn to say goodbye" } }), "intro", "en", {}) === "new-words");
check("whitespace-only edits do not", clipStatus(aiCard({ text: { en: "  Learn to say hello  " } }), "intro", "en", {}) === "ready");
check("another voice makes it stale", clipStatus(aiCard({ voice: "Kore" }), "intro", "en", {}) === "new-voice");
check("an AI clip does not count as your voice", clipStatus(aiCard({ audio: "recorded" }), "intro", "en", {}) === "other-source");
check(
  "your recording is ready in My voice",
  clipStatus(aiCard({ audio: "recorded", clips: { en: { blob, mimeType: "audio/wav", durationSeconds: 2, source: "recorded" } } }), "intro", "en", {}) === "ready"
);
const madeFromTitle = aiCard({
  text: {},
  clips: { en: { blob, mimeType: "audio/wav", durationSeconds: 2, source: "ai", madeFrom: clipMadeFrom("Charon", "Greetings") } },
});
check("default wording made from the title is ready", clipStatus(madeFromTitle, "intro", "en", { en: "Greetings" }) === "ready");
check("a new title makes a default-wording clip stale", clipStatus(madeFromTitle, "intro", "en", { en: "Saying hello" }) === "new-words");
check("an old clip without made-from is trusted", clipStatus(aiCard({ clips: { en: { blob, mimeType: "audio/wav", durationSeconds: 1, source: "ai" } } }), "intro", "en", {}) === "ready");
check("usable: ready and new voice", clipIsUsable("ready") && clipIsUsable("new-voice"));
check("not usable: changed words, other source, missing", !clipIsUsable("new-words") && !clipIsUsable("other-source") && !clipIsUsable("missing"));

/* ---------- the speech request carries the words and nothing else ---------- */

const request = buildTtsRequest({ model: "gemini-3.1-flash-tts-preview", voiceName: "Kore", text: "مرحبا بكم" });
check("one part", request.contents.length === 1 && request.contents[0].parts.length === 1);
check("the part is exactly the words", request.contents[0].parts[0].text === "مرحبا بكم");
check("no system instruction", !("systemInstruction" in request.config));
check("audio only, with the chosen voice",
  request.config.responseModalities.join() === "AUDIO" && request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === "Kore");
check("a delivery direction is stripped", stripDirectionPrefix("Say slowly and clearly: Hello there") === "Hello there");
check("an ordinary line survives", stripDirectionPrefix("Read the sign: Exit") === "Read the sign: Exit");
check("voice names are sanitised", safeVoiceName("Kore") === "Kore" && safeVoiceName("x; rm") === DEFAULT_MALE_VOICE);
check("a text model is not used for speech", safeVoiceModel("gemini-3.8-flash") === DEFAULT_VOICE_MODEL);
check("a speech model is kept", safeVoiceModel("gemini-3.8-flash-tts") === "gemini-3.8-flash-tts");

/* ---------- writing the card ---------- */

const audiences = [findAudienceLanguage("ar"), findAudienceLanguage("en")];
const lines = Array.from({ length: 20 }, (_, i) => ({ kurdish: `ڕستەی ${i + 1}`, translations: { en: `Sentence ${i + 1}` } }));
const prompt = cardWritePrompt({ which: "intro", kind: "lesson", language: findTaughtLanguage("ckb"), audiences, titles: { en: "Greetings" }, lines });
check("prompt asks for every language", prompt.includes('"ar"') && prompt.includes('"en"'));
check("prompt caps the length", prompt.includes(`at most ${CARD_MAX_WORDS} words`));
check("prompt forbids Kurdish in the card", /never write Kurdish Sorani words/.test(prompt));
check("prompt shows the title", prompt.includes("Greetings"));
check("prompt sends only the first lines", prompt.includes(`Sentence ${CARD_LINES_SENT}`) && !prompt.includes(`Sentence ${CARD_LINES_SENT + 1})`));
check("no previous block on a first write", !prompt.includes("DIFFERENT VERSION"));
const again = cardWritePrompt({
  which: "outro", kind: "story", language: findTaughtLanguage("ckb"), audiences, titles: {}, lines: [], previous: { en: "Great job!" }, note: "Ask them to comment",
});
check("write again names the last version", again.includes("DIFFERENT VERSION") && again.includes("Great job!"));
check("the teacher's note is included", again.includes("Ask them to comment"));
check("outro prompt is about closing", again.includes("CLOSING"));
check("clean strips quotes, emoji and hashtags", cleanCardText(' "Well done! 🎉 #LearnKurdish" ') === "Well done!");
check("clean keeps Arabic", cleanCardText("«أحسنت! تابعنا»") === "أحسنت! تابعنا");

/* ---------- decoding speech ---------- */

check("rate from mime", sampleRateFromMime("audio/L16;codec=pcm;rate=24000") === 24000);
check("no rate in mime", sampleRateFromMime("audio/wav") === undefined);
check("PCM and WAV are read here", isPcmPayload("audio/L16;codec=pcm;rate=24000") && isPcmPayload("audio/wav") && isPcmPayload(""));
check("MP3 goes to the browser", !isPcmPayload("audio/mpeg"));

/** A 16-bit mono WAV with a LIST chunk before the data and junk after it, like a manifest. */
function wavWithExtras(samples, rate) {
  const list = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0], [..."INFO"].map((c) => c.charCodeAt(0))));
  const data = samples.length * 2;
  const junk = 50;
  const buf = new ArrayBuffer(12 + 24 + list.length + 8 + data + junk);
  const v = new DataView(buf);
  const ascii = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  new Uint8Array(buf, 36, list.length).set(list);
  let o = 36 + list.length;
  ascii(o, "data");
  v.setUint32(o + 4, data, true);
  o += 8;
  samples.forEach((s, i) => v.setInt16(o + i * 2, s, true));
  for (let i = 0; i < junk; i++) v.setUint8(o + data + i, 0xff);
  return buf;
}

const wav = wavWithExtras([1000, -1000, 2000, -2000], 22050);
const unwrapped = unwrapWav(wav);
check("WAV header is read", unwrapped.sampleRate === 22050 && unwrapped.channels === 1 && unwrapped.bits === 16);
check("only the data chunk is kept", unwrapped.pcm.byteLength === 8);
const decoded = decodePcmPayload(wav, "audio/wav");
check("WAV decodes at its own rate", decoded.sampleRate === 22050 && decoded.samples.length === 4 && near(decoded.samples[2], 2000 / 32768, 1e-6));
const headerless = new Int16Array([16384, -16384, 0]).buffer;
const raw = decodePcmPayload(headerless, "audio/L16;codec=pcm;rate=24000");
check("headerless PCM uses the mime rate", raw.sampleRate === 24000 && near(raw.samples[0], 0.5, 1e-6) && near(raw.samples[1], -0.5, 1e-6));
check("stereo PCM mixes down", near(pcm16ToMono(new Int16Array([16384, 0, -16384, 0]).buffer, 2)[0], 0.25, 1e-6));

/** Silence, a second of tone, silence. */
function toneInSilence(rate, before, length, after) {
  const out = new Float32Array(Math.round((before + length + after) * rate));
  const from = Math.round(before * rate);
  const to = from + Math.round(length * rate);
  for (let i = from; i < to; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
  // A whisper of noise so the floor is not digital zero.
  for (let i = 0; i < out.length; i++) out[i] += (Math.random() - 0.5) * 1e-4;
  return out;
}

const rate = 24000;
const trimmed = trimToSpeech(toneInSilence(rate, 0.8, 1, 1.2), rate);
const trimmedSeconds = trimmed.samples.length / rate;
check("silence trimmed off both ends", trimmedSeconds > 0.95 && trimmedSeconds < 1.3, trimmedSeconds.toFixed(3));
check("head trim is about the silence", near(trimmed.trimmedHead, 0.8 - 0.04, 0.08), trimmed.trimmedHead.toFixed(3));
check("the ends are faded to silence", Math.abs(trimmed.samples[0]) < 1e-3 && Math.abs(trimmed.samples[trimmed.samples.length - 1]) < 1e-3);
const allSpeech = trimToSpeech(toneInSilence(rate, 0, 1, 0), rate);
check("speech end to end is kept whole", near(allSpeech.samples.length / rate, 1, 0.02));

function toBase64(buffer) {
  return Buffer.from(new Uint8Array(buffer)).toString("base64");
}
check("base64 round trips", new Uint8Array(base64ToArrayBuffer(toBase64(new Uint8Array([1, 2, 255]).buffer)))[2] === 255);

const tone = toneInSilence(rate, 0.5, 1.5, 0.5);
const pcm = new Int16Array(tone.length);
tone.forEach((s, i) => (pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))));
const sound = await ttsPayloadToSound(toBase64(pcm.buffer), "audio/L16;codec=pcm;rate=24000");
check("payload becomes a trimmed WAV", sound.blob.type === "audio/wav" && sound.durationSeconds > 1.45 && sound.durationSeconds < 1.8, sound.durationSeconds.toFixed(3));
const wavHeader = new Uint8Array(await sound.blob.slice(0, 4).arrayBuffer());
check("the WAV starts with RIFF", String.fromCharCode(...wavHeader) === "RIFF");

done("cards");
