/**
 * Title and closing cards: on or off, their words per language, and their
 * sound — an AI voice reading the words, your own voice, or silence.
 *
 * The AI voice only ever speaks the audience's language on these two cards.
 * The lesson itself is always your recording.
 *
 * Every AI clip remembers the voice and words it was made from, so editing the
 * text or picking another voice marks it out of date with a button to make it
 * again. A clip whose words no longer match is left out of the video until it
 * is remade, rather than saying one thing while the card shows another.
 */

import { useRef, useState } from "react";
import { Loader2, Mic, Play, RefreshCw, Sparkles, Square, Trash2, Upload, Wand2 } from "lucide-react";
import type { CardAudioMode, CardClip, CardSettings, Project } from "../types";
import type { AppSettings } from "../utils/settings";
import { findAudienceLanguage } from "../config/languages";
import { PREBUILT_VOICES, estimateVoiceCost, findVoice } from "../config/voices";
import { CARD_LINES_SENT } from "../config/prompts/cards";
import { useRecorder } from "../audio/useRecorder";
import { formatTime, playRange, stopPlayback } from "../audio/audioTools";
import { loadRecordingAudio } from "../audio/useRecordingAudio";
import { audioFileToSound, requestTts } from "../audio/ttsAudio";
import {
  CARD_TIMING,
  cardLength,
  cardSpokenText,
  clipIsUsable,
  clipMadeFrom,
  clipStatus,
  defaultCardText,
  madeFromParts,
  type CardWhich,
  type ClipStatus,
} from "../render/cards";
import { addUsage } from "../lessonActions";
import { ErrorNote, Segmented, Toggle, languagesLabel } from "./ui";
import AutoTextarea from "./AutoTextarea";

interface Props {
  project: Project;
  settings: AppSettings;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

/** Longer than this and a card starts to cost viewers. */
const LONG_CLIP_SECONDS = 12;

const COPY: Record<CardWhich, { title: string; blurb: string }> = {
  intro: { title: "Title card", blurb: "Opens the video: the title, and a line that tells the viewer what they will learn." },
  outro: { title: "Closing card", blurb: "Ends the video: well done, and a reason to follow." },
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared by both cards: one microphone and one player for the whole panel. */
interface Shared {
  recorder: ReturnType<typeof useRecorder>;
  /** "intro:ar" while that clip is being recorded. */
  recordingFor: string | null;
  startRecording: (key: string) => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  playingKey: string | null;
  togglePlay: (key: string, blob: Blob) => void;
}

export default function IntroOutroPanel(props: Props) {
  return <CardsPanel {...props} />;
}

function CardsPanel({ project, settings, update }: Props) {
  const recorder = useRecorder({ noiseSuppression: settings.noiseSuppression });
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  const shared: Shared = {
    recorder,
    recordingFor,
    startRecording: async (key) => {
      stopPlayback();
      setPlayingKey(null);
      setRecordingFor(key);
      await recorder.start();
    },
    stopRecording: async () => {
      try {
        return await recorder.stop();
      } catch {
        return null;
      } finally {
        setRecordingFor(null);
      }
    },
    playingKey,
    togglePlay: (key, blob) => {
      if (playingKey === key) {
        stopPlayback();
        setPlayingKey(null);
        return;
      }
      void loadRecordingAudio(blob)
        .then((audio) => {
          setPlayingKey(key);
          // Played at the level the video will use, so what you hear is what you get.
          return playRange(audio.buffer, 0, audio.buffer.duration, () => setPlayingKey((k) => (k === key ? null : k)), audio.gain);
        })
        .catch(() => setPlayingKey(null));
    },
  };

  return (
    <section className="card p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold">Title &amp; closing cards</h2>
        <p className="text-xs text-paper/55 mt-1">
          Each card can be read by an AI voice in {languagesLabel(project.audiences)}, carry a clip of your own voice, or stay
          silent. The AI voice is only used here — never for the Kurdish.
        </p>
      </div>
      <CardBlock which="intro" project={project} settings={settings} update={update} shared={shared} />
      <div className="border-t border-white/10" />
      <CardBlock which="outro" project={project} settings={settings} update={update} shared={shared} />
    </section>
  );
}

/* ------------------------------------------------------------------ */

function CardBlock({
  which,
  project,
  settings,
  update,
  shared,
}: Props & { which: CardWhich; shared: Shared }) {
  const card = project[which];
  const audiences = project.audiences;
  const copy = COPY[which];

  const setCard = (fn: (c: CardSettings) => Partial<CardSettings>) =>
    update((p) => ({ [which]: { ...p[which], ...fn(p[which]) } }) as Partial<Project>);
  const setClip = (id: string, clip: CardClip | null) =>
    setCard((c) => {
      const clips = { ...c.clips };
      if (clip) clips[id] = clip;
      else delete clips[id];
      return { clips };
    });

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);

  const run = async (key: string, task: () => Promise<void>) => {
    setError(null);
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await task();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };
  const anyBusy = Object.values(busy).some(Boolean);

  /* ---------- words ---------- */

  const hasText = audiences.some((id) => card.text[id]?.trim());

  const write = () =>
    run("write", async () => {
      const res = await fetch("/api/cards/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          which,
          kind: project.kind,
          taughtLang: project.taughtLang,
          audiences,
          titles: project.titles,
          lines: project.lines
            .filter((l) => !l.skip && l.kurdish.trim())
            .slice(0, CARD_LINES_SENT)
            .map((l) => ({ kurdish: l.kurdish, translations: l.translations })),
          note,
          previous: hasText ? card.text : undefined,
          model: settings.translateModel,
          userApiKey: settings.apiKey.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Writing the card failed (HTTP ${res.status}).`);
      const written: Record<string, string> = {};
      for (const id of audiences) if (String(data?.text?.[id] ?? "").trim()) written[id] = String(data.text[id]).trim();
      update((p) => ({
        [which]: { ...p[which], text: { ...p[which].text, ...written } },
        usage: data?.usage ? addUsage(p.usage, String(data.model || ""), data.usage) : p.usage,
      }));
    });

  /* ---------- AI voice ---------- */

  const makeVoice = async (id: string) => {
    // Read now, so the clip records exactly the words and voice it was made from.
    const text = cardSpokenText(card, which, id, project.titles);
    const voice = card.voice;
    const sound = await requestTts({ text, voiceName: voice, apiKey: settings.apiKey });
    const clip: CardClip = {
      blob: sound.blob,
      mimeType: "audio/wav",
      durationSeconds: sound.durationSeconds,
      source: "ai",
      madeFrom: clipMadeFrom(voice, text),
    };
    update((p) => ({
      [which]: { ...p[which], clips: { ...p[which].clips, [id]: clip } },
      usage: { ...p.usage, costUsd: p.usage.costUsd + estimateVoiceCost(sound.model, text) },
    }));
  };

  const statuses = Object.fromEntries(audiences.map((id) => [id, clipStatus(card, which, id, project.titles)])) as Record<
    string,
    ClipStatus
  >;
  const allReady = audiences.every((id) => statuses[id] === "ready");

  const makeAll = () =>
    run("all", async () => {
      // Only what is missing or out of date, unless everything is fine — then all of it again.
      const targets = allReady ? audiences : audiences.filter((id) => statuses[id] !== "ready");
      for (const id of targets) {
        setBusy((b) => ({ ...b, [`tts:${id}`]: true }));
        try {
          await makeVoice(id);
        } finally {
          setBusy((b) => ({ ...b, [`tts:${id}`]: false }));
        }
      }
    });

  /* ---------- your voice ---------- */

  const acceptSound = (id: string, blob: Blob) =>
    run(`file:${id}`, async () => {
      const sound = await audioFileToSound(blob);
      setClip(id, { blob: sound.blob, mimeType: "audio/wav", durationSeconds: sound.durationSeconds, source: "recorded" });
    });

  const recordKey = (id: string) => `${which}:${id}`;
  const isRecording = (id: string) => shared.recordingFor === recordKey(id) && shared.recorder.state !== "idle";
  const recordingHere = audiences.some(isRecording);
  /** Turning the card off or leaving "My voice" hides the Stop button, so the microphone is closed first. */
  const cancelRecording = () => {
    if (recordingHere) void shared.stopRecording();
  };

  const toggleRecord = async (id: string) => {
    if (isRecording(id)) {
      const blob = await shared.stopRecording();
      if (blob && blob.size) await acceptSound(id, blob);
      return;
    }
    setError(null);
    await shared.startRecording(recordKey(id));
  };

  /* ---------- how long the card lasts ---------- */

  const lengthFor = (languages: string[]) =>
    cardLength(
      {
        enabled: true,
        clips:
          card.audio === "silent"
            ? []
            : languages.filter((id) => clipIsUsable(statuses[id] ?? "missing")).map((id) => ({ duration: card.clips[id].durationSeconds })),
      },
      which === "intro" ? CARD_TIMING.introMin : CARD_TIMING.outroMin
    );
  const outputs = project.video.outputs.filter((o) => o.length && o.every((id) => audiences.includes(id)));

  const voice = findVoice(card.voice);
  const recorderError = shared.recordingFor?.startsWith(`${which}:`) ? shared.recorder.error : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Toggle
            checked={card.enabled}
            onChange={(on) => {
              if (!on) cancelRecording();
              setCard(() => ({ enabled: on }));
            }}
          >
            <span className="font-semibold text-white">{copy.title}</span>
          </Toggle>
          <p className="text-xs text-paper/50 mt-0.5 ml-6">{copy.blurb}</p>
        </div>
        {card.enabled && outputs.length > 0 && (
          <span className="text-xs text-paper/50">
            On screen{" "}
            {outputs.map((o, i) => (
              <span key={o.join("+")}>
                {i > 0 && " · "}
                {languagesLabel(o)} <b className="text-paper/80">{lengthFor(o).toFixed(1)}s</b>
              </span>
            ))}
          </span>
        )}
      </div>

      {card.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_1fr] sm:items-end">
            <div className="space-y-1.5">
              <span className="label">Sound</span>
              <Segmented
                value={card.audio}
                options={[
                  ["ai", "AI voice"],
                  ["recorded", "My voice"],
                  ["silent", "Silent"],
                ]}
                onChange={(value) => {
                  if (value !== "recorded") cancelRecording();
                  setCard(() => ({ audio: value as CardAudioMode }));
                }}
              />
            </div>
            {card.audio === "ai" && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1.5 flex-1 min-w-[200px]">
                  <span className="label">Voice</span>
                  <select className="field !py-1.5 text-sm" value={card.voice} onChange={(e) => setCard(() => ({ voice: e.target.value }))}>
                    {!voice && (
                      <option value={card.voice} className="bg-ink">
                        {card.voice}
                      </option>
                    )}
                    {(["male", "female"] as const).map((gender) => (
                      <optgroup key={gender} label={gender === "male" ? "Male voices" : "Female voices"} className="bg-ink">
                        {PREBUILT_VOICES.filter((v) => v.gender === gender).map((v) => (
                          <option key={v.name} value={v.name} className="bg-ink">
                            {v.name} — {v.character}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <button type="button" className="btn btn-primary" onClick={makeAll} disabled={anyBusy}>
                  {busy.all ? <Loader2 size={15} className="animate-spin" /> : allReady ? <RefreshCw size={15} /> : <Sparkles size={15} />}
                  {allReady ? "Make all again" : audiences.length > 1 ? "Make voice for all" : "Make voice"}
                </button>
              </div>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {audiences.map((id) => {
              const language = findAudienceLanguage(id);
              const rtl = Boolean(language?.rtl);
              const status = statuses[id];
              const clip = card.clips[id];
              const ownClip = clip && status !== "other-source" ? clip : undefined;
              const playKey = `${which}:${id}`;
              const playing = shared.playingKey === playKey;
              const ttsBusy = Boolean(busy[`tts:${id}`]);
              const recording = isRecording(id);

              return (
                <div key={id} className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="label">{language?.label ?? id}</span>
                    {card.audio !== "silent" && (
                      <StatusNote
                        audio={card.audio}
                        status={status}
                        clip={ownClip}
                        voice={card.voice}
                        recording={recording ? shared.recorder.elapsed : null}
                      />
                    )}
                  </div>

                  <AutoTextarea
                    value={card.text[id] ?? ""}
                    onChange={(e) => setCard((c) => ({ text: { ...c.text, [id]: e.target.value } }))}
                    placeholder={defaultCardText(which, id, project.titles)}
                    dir={rtl ? "rtl" : "ltr"}
                    className={`text-sm ${rtl ? "script" : ""}`}
                  />

                  {card.audio !== "silent" && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        className="icon-btn"
                        title={playing ? "Stop" : "Play"}
                        disabled={!ownClip || recording}
                        onClick={() => ownClip && shared.togglePlay(playKey, ownClip.blob)}
                      >
                        {playing ? <Square size={14} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                      </button>

                      {card.audio === "ai" ? (
                        <button
                          type="button"
                          className={`btn ${status === "new-words" || status === "new-voice" ? "btn-primary" : "btn-ghost"} !py-1 !px-2.5 text-xs`}
                          disabled={anyBusy}
                          onClick={() => run(`tts:${id}`, () => makeVoice(id))}
                        >
                          {ttsBusy ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : status === "ready" || status === "new-voice" || status === "new-words" ? (
                            <RefreshCw size={14} />
                          ) : (
                            <Wand2 size={14} />
                          )}
                          {status === "new-words" || status === "new-voice"
                            ? "Regenerate"
                            : status === "ready"
                              ? "Make again"
                              : "Make voice"}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`btn ${recording ? "btn-danger" : "btn-ghost"} !py-1 !px-2.5 text-xs`}
                            disabled={(anyBusy && !recording) || (shared.recorder.state !== "idle" && !recording)}
                            onClick={() => void toggleRecord(id)}
                          >
                            {recording ? <Square size={13} fill="currentColor" /> : <Mic size={14} />}
                            {recording ? `Stop · ${formatTime(shared.recorder.elapsed, 0)}` : ownClip ? "Record again" : "Record"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost !py-1 !px-2.5 text-xs"
                            disabled={anyBusy || recordingHere}
                            onClick={() => {
                              uploadFor.current = id;
                              fileRef.current?.click();
                            }}
                          >
                            {busy[`file:${id}`] ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                            Upload
                          </button>
                          {recording && (
                            <span className="h-1.5 w-16 rounded-full bg-white/10 overflow-hidden">
                              <span
                                className="block h-full bg-brand-green transition-[width]"
                                style={{ width: `${Math.round(Math.min(1, shared.recorder.level * 1.6) * 100)}%` }}
                              />
                            </span>
                          )}
                        </>
                      )}

                      {ownClip && !recording && (
                        <button
                          type="button"
                          className="icon-btn ml-auto"
                          title="Remove this clip"
                          disabled={anyBusy}
                          onClick={() => {
                            if (playing) stopPlayback();
                            setClip(id, null);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              className="field !py-1.5 text-sm flex-1 min-w-[220px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={which === "intro" ? "For the AI (optional): e.g. mention it's for beginners" : "For the AI (optional): e.g. ask them to comment"}
            />
            <button type="button" className="btn btn-ghost" onClick={write} disabled={anyBusy}>
              {busy.write ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
              {hasText ? "Write again" : "Write with AI"}
            </button>
          </div>

          {card.audio === "silent" && (
            <p className="text-xs text-paper/45">
              Text only — the card stays up for {(which === "intro" ? CARD_TIMING.introMin : CARD_TIMING.outroMin).toFixed(1)}s.
            </p>
          )}
          {card.audio === "ai" && (
            <p className="text-xs text-paper/45">
              An empty box uses the wording shown in grey — that is what the voice reads and the card shows.
            </p>
          )}
          {card.audio === "recorded" && (
            <p className="text-xs text-paper/45">
              Say the card's words in each language, or upload a clip. Silence at the ends is trimmed off.
            </p>
          )}

          {recorderError && <ErrorNote>{recorderError}</ErrorNote>}
          {error && <ErrorNote>{error}</ErrorNote>}

          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              const id = uploadFor.current;
              if (file && id) void acceptSound(id, file);
            }}
          />
        </>
      )}
    </div>
  );
}

/** One language's clip, in a few words. */
function StatusNote({
  audio,
  status,
  clip,
  voice,
  recording,
}: {
  audio: CardAudioMode;
  status: ClipStatus;
  clip?: CardClip;
  voice: string;
  /** Seconds recorded so far, while recording. */
  recording: number | null;
}) {
  if (recording !== null) return <span className="text-xs text-kurd-red font-semibold">● Recording {formatTime(recording, 0)}</span>;
  if (!clip || status === "missing" || status === "other-source") {
    return (
      <span className="text-xs text-paper/45">
        {audio === "ai" ? "No voice yet — silent in this language" : "Not recorded yet"}
      </span>
    );
  }
  const seconds = `${clip.durationSeconds.toFixed(1)}s`;
  if (status === "new-words") {
    return <span className="text-xs text-kurd-sun">Words changed — left out until you regenerate</span>;
  }
  if (status === "new-voice") {
    const was = madeFromParts(clip.madeFrom)?.voice;
    return (
      <span className="text-xs text-kurd-sun">
        {seconds} · made with {was || "another voice"}, not {voice}
      </span>
    );
  }
  return (
    <span className={`text-xs ${clip.durationSeconds > LONG_CLIP_SECONDS ? "text-kurd-sun" : "text-brand-green"}`}>
      {clip.source === "ai" ? "AI voice" : "Your voice"} · {seconds}
      {clip.durationSeconds > LONG_CLIP_SECONDS ? " — long for a card" : ""}
    </span>
  );
}
