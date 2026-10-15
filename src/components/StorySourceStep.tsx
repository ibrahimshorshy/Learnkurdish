/**
 * Step 1 of a story project: the text, then you reading it aloud.
 *
 * The text is pasted or uploaded first and kept as the project's script, one
 * sentence per entry, paragraph starts marked. Because the words are already
 * known, the transcriber does not guess them: it only finds where each
 * sentence is in your reading (the "aligned" mode), and a sentence you
 * skipped is simply left out.
 *
 * Reading a long text aloud means looking at it while recording, so the
 * recorder sits beside a teleprompter — the same text, large, a paragraph at a
 * time — which can also fill the screen. Click a sentence (or use ↑ ↓ in full
 * screen) to keep your place.
 *
 * The audio is always your own voice: there is no AI voice for Kurdish,
 * because every one of them mispronounces it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  FileUp,
  Info,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Upload,
  Wand2,
} from "lucide-react";
import type { Project } from "../types";
import type { RecordStepProps } from "./RecordStep";
import type { RecordingAudio } from "../audio/useRecordingAudio";
import { useRecorder } from "../audio/useRecorder";
import { decodeAudio, formatTime } from "../audio/audioTools";
import { findTextModel } from "../config/models";
import { useObjectUrl } from "../utils/useObjectUrl";
import {
  STORY_FILE_ACCEPT,
  matchLinesToScript,
  readStoryFile,
  scriptToText,
  splitStory,
  storyStats,
  toScript,
} from "../utils/storyText";
import { ErrorNote } from "./ui";
import { freshRecordingPatch } from "../utils/projectStore";

export type StorySourceStepProps = RecordStepProps;

/** Teleprompter type sizes, in pixels; the choice is remembered in this browser. */
const SIZES = [20, 24, 28, 32, 38, 44, 52];
const SIZE_KEY = "leen-story-teleprompter-size";

function loadSize(): number {
  try {
    const saved = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(saved) ? saved : 28;
  } catch {
    return 28;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function StorySourceStep({ project, settings, audio, audioError, busy, update, onTranscribe }: StorySourceStepProps) {
  /* ---------- the text ---------- */

  // A story made before the text box existed (or from a built-in script) has
  // only the script; show it as text.
  const text = project.storyText ?? scriptToText(project.script);
  const split = useMemo(() => splitStory(text), [text]);
  const stats = useMemo(() => storyStats(split), [split]);
  const hasText = stats.sentences > 0;

  const setText = useCallback(
    (next: string) => update({ storyText: next, script: toScript(next) }),
    [update]
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);

  const onTextFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (text.trim() && !window.confirm(`Replace the text in the box with "${file.name}"?`)) return;
    setReading(true);
    setFileProblem(null);
    try {
      const content = await readStoryFile(file);
      if (!content.trim()) throw new Error("That file has no text in it.");
      setText(content);
    } catch (err) {
      setFileProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  };

  /* ---------- the text against the transcribed lines ---------- */

  const hasWork = project.lines.length > 0;
  const match = useMemo(
    () =>
      hasWork && project.script?.some((l) => l.trim())
        ? matchLinesToScript(
            project.lines.map((l) => l.kurdish),
            project.script
          )
        : null,
    [hasWork, project.lines, project.script]
  );

  const transcribe = () => {
    if (hasWork && !window.confirm("Transcribe again? The current sentences and their translations will be replaced.")) return;
    onTranscribe();
  };

  /** The transcribed lines, back into the text box: one sentence per line, paragraphs kept. */
  const copyLinesToText = () => {
    if (!window.confirm("Replace the text with the transcribed sentences? Anything in the text that is not among them is dropped.")) return;
    const paragraphs: string[][] = [];
    project.lines.forEach((line, i) => {
      if (!line.kurdish.trim()) return;
      if (i === 0 || line.paragraphStart || !paragraphs.length) paragraphs.push([]);
      paragraphs[paragraphs.length - 1].push(line.kurdish.trim());
    });
    setText(paragraphs.map((p) => p.join("\n")).join("\n\n"));
  };

  /* ---------- recording ---------- */

  const recorder = useRecorder({ noiseSuppression: settings.noiseSuppression });
  const audioFileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recording = project.recording;
  const url = useObjectUrl(recording?.blob);
  const live = recorder.state !== "idle";

  /** Stores a new recording after checking it decodes — the same reset as the lesson's record step. */
  const accept = async (blob: Blob, fileName?: string) => {
    setSaving(true);
    setProblem(null);
    try {
      const decoded = await decodeAudio(blob);
      if (decoded.duration < 0.5) throw new Error("That recording is too short to use.");
      update({
        ...freshRecordingPatch({ blob, mimeType: blob.type || "audio/webm", durationSeconds: decoded.duration, fileName }),
      });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmReplace = () =>
    !hasWork || window.confirm("Replace this recording? Its sentences, translations and videos will be cleared.");

  const startRecording = () => {
    if (recording && !confirmReplace()) return;
    void recorder.start();
  };

  const stopRecording = async () => {
    try {
      const blob = await recorder.stop();
      await accept(blob);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const onAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (recording && !confirmReplace()) return;
    void accept(file, file.name);
  };

  /* ---------- teleprompter ---------- */

  const [size, setSize] = useState(loadSize);
  const [marked, setMarked] = useState(-1);
  const [fullScreen, setFullScreen] = useState(false);
  const fullRef = useRef<HTMLDivElement>(null);

  const changeSize = (delta: number) => {
    const at = SIZES.indexOf(size);
    const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (at < 0 ? 2 : at) + delta))];
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      // Only the preference is lost.
    }
  };

  // A changed text may have fewer sentences than the marker points at.
  useEffect(() => {
    if (marked >= stats.sentences) setMarked(-1);
  }, [marked, stats.sentences]);

  // Full screen: no page scroll behind it; Esc leaves, ↑ ↓ move the marker.
  useEffect(() => {
    if (!fullScreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
      else if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        setMarked((m) => Math.min(stats.sentences - 1, m + 1));
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        setMarked((m) => Math.max(0, m - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullScreen, stats.sentences]);

  // Keep the marked sentence in the middle of the full-screen view. Scrolled
  // by hand rather than scrollIntoView, which would also scroll the page.
  useEffect(() => {
    const box = fullRef.current;
    if (!fullScreen || !box || marked < 0) return;
    const el = box.querySelector<HTMLElement>(`[data-sentence="${marked}"]`);
    if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: "smooth" });
  }, [marked, fullScreen]);

  const model = findTextModel(settings.transcribeModel);
  const tooShort = Boolean(recording && hasText && recording.durationSeconds < stats.readingSeconds * 0.45);
  const recorderProps = { recorder, live, saving, onStart: startRecording, onStop: stopRecording };

  return (
    <div className="space-y-5">
      {match && match.strayLines > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-kurd-sun/40 bg-kurd-sun/10 px-4 py-3 text-sm">
          <AlertTriangle size={18} className="text-kurd-sun shrink-0" />
          <p className="flex-1 text-paper/90">
            The text no longer matches the transcribed sentences —{" "}
            {plural(match.strayLines, "sentence")} on the next step {match.strayLines === 1 ? "is" : "are"} not in it. If
            you changed the text, transcribe again so the sentences and their timings follow it. If you corrected the
            sentences on the next step instead, copy them back into the text.
          </p>
          <div className="flex gap-2 shrink-0">
            <button type="button" className="btn btn-primary" onClick={transcribe} disabled={busy || !audio}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />} Transcribe again
            </button>
            <button type="button" className="btn btn-ghost" onClick={copyLinesToText} disabled={busy}>
              Use the sentences as the text
            </button>
          </div>
        </div>
      )}

      {/* ---------- the text ---------- */}
      <section className="card p-5 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[14rem]">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <BookOpen size={20} className="text-brand-blue" /> Your story
            </h2>
            <p className="text-sm text-paper/60 mt-1">
              Paste the text you will read, or upload it. Each sentence becomes one line of the video; leave a blank line
              between paragraphs.
            </p>
          </div>
          <input ref={fileRef} type="file" accept={STORY_FILE_ACCEPT} className="hidden" onChange={onTextFile} />
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={reading}>
            {reading ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />} Upload .txt / .docx
          </button>
        </div>

        <textarea
          dir="rtl"
          lang="ckb"
          className="field script text-lg min-h-[14rem] resize-y"
          rows={10}
          placeholder={"ڕۆژێک لە ڕۆژان…\n\nچیرۆکەکە لێرە دابنێ. بۆشاییەک لە نێوان بڕگەکاندا جێبهێڵە."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="The story text"
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-paper/55">
          {hasText ? (
            <span className="font-semibold text-paper/80">
              {plural(stats.paragraphs, "paragraph")} · {plural(stats.sentences, "sentence")} · about{" "}
              {formatTime(stats.readingSeconds, 0)} to read aloud
            </span>
          ) : (
            <span>No text yet.</span>
          )}
          <span>A line break always ends a sentence. To join two sentences, take out the full stop between them.</span>
        </div>
        {fileProblem && <ErrorNote>{fileProblem}</ErrorNote>}
      </section>

      {/* ---------- reading it ---------- */}
      <section className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="card p-5 flex flex-col gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <p className="label flex-1">Read along</p>
            <SizeControls size={size} onChange={changeSize} />
            <button
              type="button"
              className="icon-btn"
              title="Full screen (Esc to leave)"
              onClick={() => setFullScreen(true)}
              disabled={!hasText}
            >
              <Maximize2 size={16} />
            </button>
          </div>
          <div className="relative max-h-[62vh] overflow-y-auto rounded-xl bg-black/25 border border-white/5 px-5 py-4">
            {hasText ? (
              <Teleprompter paragraphs={split.paragraphs} size={size} marked={marked} onMark={setMarked} numbers />
            ) : (
              <p className="text-sm text-paper/45 py-10 text-center">
                Your text appears here, large enough to read from while you record.
              </p>
            )}
          </div>
          {hasText && (
            <p className="text-xs text-paper/45">
              Click a sentence to keep your place. The small numbers are the lines of the video.
            </p>
          )}
        </div>

        <aside className="card p-5 flex flex-col items-center text-center gap-4 lg:sticky lg:top-20 self-start">
          <div>
            <h3 className="font-bold">Record yourself reading it</h3>
            <p className="text-xs text-paper/55 mt-1">
              Read at an easy pace. Pause briefly after each sentence, and a little longer between paragraphs.
            </p>
          </div>
          <RecorderControls {...recorderProps} />
          {!live && (
            <>
              <input
                ref={audioFileRef}
                type="file"
                accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.ogg,.webm"
                className="hidden"
                onChange={onAudioFile}
              />
              <button type="button" className="btn btn-ghost w-full" onClick={() => audioFileRef.current?.click()} disabled={saving}>
                <Upload size={15} /> Upload a recording
              </button>
            </>
          )}
          {(recorder.error || problem || audioError) && <ErrorNote>{recorder.error || problem || audioError}</ErrorNote>}
          <p className="text-[11px] text-paper/45 flex gap-1.5 text-left">
            <Info size={13} className="shrink-0 mt-0.5" />
            Your voice is the sound of the video. There is no AI voice for Kurdish — they all mispronounce it.
          </p>
        </aside>
      </section>

      {/* ---------- the recording, and transcribing it ---------- */}
      {recording && url && (
        <section className="card p-5 grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <p className="label">Your recording</p>
            <div className="flex items-center justify-between text-sm text-paper/70 gap-3">
              <span className="truncate">{recording.fileName || "Recorded in the app"}</span>
              <span className="font-mono">{formatTime(recording.durationSeconds)}</span>
            </div>
            <audio controls src={url} className="w-full" />
            {audio && <p className="text-xs text-paper/50">{pauseNote(audio)}</p>}
            {tooShort && (
              <p className="text-xs text-kurd-sun">
                The recording is {formatTime(recording.durationSeconds, 0)}, but this text takes about{" "}
                {formatTime(stats.readingSeconds, 0)} to read. Sentences you did not read are left out of the video.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <label className="label" htmlFor="story-context">
                Names and topic <span className="normal-case font-normal tracking-normal">(optional)</span>
              </label>
              <input
                id="story-context"
                className="field mt-2"
                placeholder="e.g. A folk tale from Hawraman — names: Azad, Shirin"
                value={project.context}
                onChange={(e) => update({ context: e.target.value })}
              />
            </div>

            {match && match.strayLines === 0 && match.missingSentences > 0 && (
              <p className="text-xs text-paper/60 bg-white/5 rounded-lg px-3 py-2">
                {plural(match.missingSentences, "sentence")} of the text {match.missingSentences === 1 ? "is" : "are"} not
                among the transcribed sentences — not heard in the recording, or added to the text afterwards. Transcribe
                again to pick up sentences you added.
              </p>
            )}

            <div className="mt-auto space-y-2">
              <button type="button" className="btn btn-primary w-full py-3 text-base" onClick={transcribe} disabled={busy || !audio}>
                {busy ? <Loader2 size={18} className="animate-spin" /> : hasWork ? <RotateCcw size={18} /> : <Wand2 size={18} />}
                {busy
                  ? hasText
                    ? "Finding each sentence in your reading…"
                    : "Listening to your Kurdish…"
                  : hasWork
                    ? "Transcribe again"
                    : hasText
                      ? "Find each sentence in my reading"
                      : "Transcribe what I read"}
              </button>
              <p className="text-xs text-paper/45 text-center">
                {hasText
                  ? "The AI keeps your text exactly and only finds where each sentence is."
                  : "No text? The AI writes down what it hears instead, as one paragraph."}{" "}
                {model?.label ?? settings.transcribeModel} · change in Settings
              </p>
            </div>
          </div>
        </section>
      )}

      {fullScreen && (
        <div className="fixed inset-0 z-50 bg-[#03101f] flex flex-col" role="dialog" aria-label="Read along, full screen">
          <div className="flex items-center gap-2 px-4 h-14 border-b border-white/10 shrink-0">
            <p className="label flex-1">Read along · ↑ ↓ to keep your place · Esc to leave</p>
            <SizeControls size={size} onChange={changeSize} />
            <button type="button" className="icon-btn" title="Leave full screen" onClick={() => setFullScreen(false)}>
              <Minimize2 size={16} />
            </button>
          </div>
          <div ref={fullRef} className="relative flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-6 py-[30vh]">
              <Teleprompter paragraphs={split.paragraphs} size={Math.round(size * 1.25)} marked={marked} onMark={setMarked} />
            </div>
          </div>
          <div className="shrink-0 border-t border-white/10 px-4 py-3 flex items-center justify-center">
            <RecorderControls {...recorderProps} compact />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function pauseNote(audio: RecordingAudio): string {
  const segments = audio.analysis.segments;
  let pauses = 0;
  for (let i = 0; i + 1 < segments.length; i++) if (segments[i + 1].start - segments[i].end >= 0.35) pauses++;
  return pauses > 0
    ? `Heard speech with ${pauses} clear pauses — they help place each sentence exactly.`
    : "Could not find clear pauses. That's fine — you can adjust the timings by hand on the next step.";
}

function SizeControls({ size, onChange }: { size: number; onChange: (delta: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" className="icon-btn" title="Smaller text" onClick={() => onChange(-1)} disabled={size <= SIZES[0]}>
        <Minus size={15} />
      </button>
      <span className="text-xs text-paper/50 w-8 text-center font-mono">{size}</span>
      <button
        type="button"
        className="icon-btn"
        title="Larger text"
        onClick={() => onChange(1)}
        disabled={size >= SIZES[SIZES.length - 1]}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}

/**
 * The text to read from: paragraphs apart, sentences inline. The marked
 * sentence is lit and the ones before it fade back, so after a glance at the
 * recorder the eye finds its place again.
 */
function Teleprompter({
  paragraphs,
  size,
  marked,
  onMark,
  numbers = false,
}: {
  paragraphs: string[][];
  size: number;
  marked: number;
  onMark: (index: number) => void;
  numbers?: boolean;
}) {
  let index = 0;
  return (
    <div dir="rtl" lang="ckb" className="script select-none" style={{ fontSize: size, lineHeight: 1.95 }}>
      {paragraphs.map((sentences, p) => (
        <div key={p} className={p ? "mt-[1em]" : ""}>
          <div dir="ltr" className="font-sans text-[11px] font-semibold tracking-wider text-paper/30 text-right leading-4 mb-1">
            ¶ {p + 1}
          </div>
          <p>
            {sentences.map((sentence) => {
              const i = index++;
              const state = marked < 0 ? "plain" : i === marked ? "marked" : i < marked ? "done" : "plain";
              return (
                <span key={i}>
                  <span
                    data-sentence={i}
                    onClick={() => onMark(i === marked ? -1 : i)}
                    className={`rounded-md px-1 -mx-0.5 cursor-pointer transition-colors ${
                      state === "marked"
                        ? "bg-brand-blue/25 text-white"
                        : state === "done"
                          ? "text-paper/40 hover:bg-white/5"
                          : "text-white hover:bg-white/5"
                    }`}
                  >
                    {numbers && (
                      <sup className="font-sans text-[0.42em] text-brand-blue/70 font-semibold me-0.5 select-none">{i + 1}</sup>
                    )}
                    {sentence}
                  </span>{" "}
                </span>
              );
            })}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The record button, clock, level and pause/done — beside the text, or under it in full screen. */
function RecorderControls({
  recorder,
  live,
  saving,
  onStart,
  onStop,
  compact = false,
}: {
  recorder: ReturnType<typeof useRecorder>;
  live: boolean;
  saving: boolean;
  onStart: () => void;
  onStop: () => void;
  compact?: boolean;
}) {
  const button = (
    <button
      type="button"
      onClick={live ? onStop : onStart}
      disabled={saving}
      className={`relative shrink-0 rounded-full flex items-center justify-center transition-all cursor-pointer ${
        compact ? "w-14 h-14" : "w-24 h-24"
      } ${live ? "bg-kurd-red recording-pulse" : "bg-gradient-to-br from-brand-blue to-brand-green hover:scale-105"}`}
      aria-label={live ? "Stop recording" : "Start recording"}
    >
      {live ? <Square size={compact ? 20 : 30} fill="white" /> : <Mic size={compact ? 24 : 38} />}
    </button>
  );

  const status = live ? (
    <div className={`flex flex-col gap-1.5 ${compact ? "w-40" : "w-full max-w-[13rem] items-center"}`}>
      <div className="font-mono text-xl tabular-nums">
        {formatTime(recorder.elapsed, 0)}
        {recorder.state === "paused" && <span className="ml-2 text-sm text-kurd-sun">paused</span>}
      </div>
      <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-brand-green via-kurd-sun to-kurd-red transition-[width] duration-75"
          style={{ width: `${Math.min(100, recorder.level * 140)}%` }}
        />
      </div>
    </div>
  ) : saving ? (
    <span className="text-sm text-paper/70 flex items-center gap-2">
      <Loader2 size={16} className="animate-spin" /> Reading the recording…
    </span>
  ) : (
    <span className="text-sm text-paper/50">Tap to start recording</span>
  );

  const actions = live && (
    <div className="flex gap-2">
      {recorder.state === "recording" ? (
        <button type="button" className="btn btn-ghost" onClick={recorder.pause}>
          <Pause size={15} /> Pause
        </button>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={recorder.resume}>
          <Play size={15} /> Resume
        </button>
      )}
      <button type="button" className="btn btn-primary" onClick={onStop}>
        <Square size={13} /> Done
      </button>
    </div>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-4">
        {button}
        {status}
        {actions}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {button}
      <div className="min-h-12 flex items-center justify-center w-full">{status}</div>
      {actions}
    </div>
  );
}
