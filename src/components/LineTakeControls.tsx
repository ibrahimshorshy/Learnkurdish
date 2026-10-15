/**
 * Re-record a single line: record or upload a fresh take that replaces this
 * line's slice of the main recording, hear it, trim it, or go back to the
 * original.
 *
 * Only the line's sound changes. Its text, translations and place in the
 * lesson stay exactly as they are, so one misspoken sentence no longer means
 * recording the whole lesson again.
 */

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, Play, Undo2, Loader2, X, Minus, Plus, AudioLines } from "lucide-react";
import type { LessonLine, Project, Take } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";
import type { AppSettings } from "../utils/settings";
import { useRecorder } from "../audio/useRecorder";
import { buildLineClip } from "../audio/clipBuilder";
import { formatTime } from "../audio/audioTools";
import { nudgeTake, takeFromBlob } from "../audio/takes";

export interface LineTakeControlsProps {
  line: LessonLine;
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  settings: AppSettings;
  /** Smaller layout for the review step. */
  compact?: boolean;
  /** Writes into this project, even when a take lands after another one was opened. */
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

/**
 * Sent when a line starts recording, so any other line that is recording
 * stops: one microphone, one take at a time.
 */
const TAKE_RECORDING_EVENT = "leen-take-recording";

const NUDGE = 0.05;

export default function LineTakeControls({
  line,
  project,
  audio,
  playback,
  settings,
  compact = false,
  update,
}: LineTakeControlsProps) {
  const recorder = useRecorder({ noiseSuppression: settings.noiseSuppression });
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const discardRef = useRef(false);
  const stateRef = useRef(recorder.state);
  stateRef.current = recorder.state;
  const stopRef = useRef(recorder.stop);
  stopRef.current = recorder.stop;

  const take = line.take;
  const live = recorder.state !== "idle";

  // Another line started recording: drop this one's unfinished take.
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail === line.id || stateRef.current === "idle") return;
      discardRef.current = true;
      void stopRef.current().catch(() => {});
    };
    window.addEventListener(TAKE_RECORDING_EVENT, onOther);
    return () => window.removeEventListener(TAKE_RECORDING_EVENT, onOther);
  }, [line.id]);

  // Video projects keep their own sound, in step with the picture.
  if (project.kind === "video") return null;

  const setTake = (next: Take | undefined) =>
    update((p) => ({
      lines: p.lines.map((l) => {
        if (l.id !== line.id) return l;
        if (next) return { ...l, take: next };
        const { take: _old, ...rest } = l;
        return rest;
      }),
    }));

  const patchTake = (patch: Partial<Take>) =>
    update((p) => ({
      lines: p.lines.map((l) => (l.id === line.id && l.take ? { ...l, take: { ...l.take, ...patch } } : l)),
    }));

  const accept = async (blob: Blob, mimeType?: string) => {
    setReading(true);
    setProblem(null);
    try {
      setTake(await takeFromBlob(blob, mimeType));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  };

  const startRecording = () => {
    playback.stop();
    setProblem(null);
    discardRef.current = false;
    window.dispatchEvent(new CustomEvent(TAKE_RECORDING_EVENT, { detail: line.id }));
    void recorder.start();
  };

  const stopRecording = async () => {
    try {
      const blob = await recorder.stop();
      if (!discardRef.current) await accept(blob);
    } catch {
      /* already stopped */
    }
  };

  const cancelRecording = () => {
    discardRef.current = true;
    void recorder.stop().catch(() => {});
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void accept(file, file.type);
  };

  const takeKeyName = `${line.id}:take`;
  const originalKeyName = `${line.id}:original`;
  const takeReady = Boolean(take && audio.sources.takes.has(take.id));

  /** The take exactly as the video gets it: trimmed, tightened, cleaned, levelled. */
  const playTake = () => {
    if (playback.playing?.key === takeKeyName) return playback.stop();
    const clip = buildLineClip(line, audio.sources, project);
    if (clip) void playback.play(takeKeyName, clip, { start: line.start, end: line.end });
  };

  const playOriginal = () => {
    if (playback.playing?.key === originalKeyName) return playback.stop();
    const { take: _take, ...original } = line;
    const clip = buildLineClip(original, audio.sources, project);
    if (clip) void playback.play(originalKeyName, clip, { start: line.start, end: line.end });
  };

  const useOriginal = () => {
    if (!window.confirm("Go back to this line's part of the main recording? The new take will be deleted.")) return;
    if (playback.playing?.key === takeKeyName) playback.stop();
    setTake(undefined);
  };

  const fileInput = (
    <input ref={fileRef} type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.webm,.ogg,.opus" className="hidden" onChange={onFile} />
  );
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  /* ---------- recording ---------- */

  if (live) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-kurd-red/40 bg-kurd-red/10 px-2.5 py-1.5 text-xs"
        onClick={stop}
      >
        <span className="w-2.5 h-2.5 rounded-full bg-kurd-red recording-pulse shrink-0" />
        <span className="font-mono tabular-nums text-white">{formatTime(recorder.elapsed, 1)}</span>
        <div className="w-20 sm:w-28 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-brand-green via-kurd-sun to-kurd-red transition-[width] duration-75"
            style={{ width: `${Math.min(100, recorder.level * 140)}%` }}
          />
        </div>
        {!compact && <span className="text-paper/60">Say the line, then stop. Silence either side is trimmed.</span>}
        <span className="flex gap-1.5 ml-auto">
          <button type="button" className="btn btn-primary !py-1 !px-2.5 !text-xs" onClick={() => void stopRecording()}>
            <Square size={12} fill="currentColor" /> Stop
          </button>
          <button type="button" className="btn btn-ghost !py-1 !px-2 !text-xs" title="Throw this take away" onClick={cancelRecording}>
            <X size={13} />
          </button>
        </span>
      </div>
    );
  }

  if (reading) {
    return (
      <div className="flex items-center gap-2 text-xs text-paper/70" onClick={stop}>
        <Loader2 size={13} className="animate-spin" /> Reading the take and trimming it to your voice…
      </div>
    );
  }

  const problemNote = (problem || recorder.error) && (
    <p className="text-xs text-red-300 w-full">{problem || recorder.error}</p>
  );

  /* ---------- compact: the review step ---------- */

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs" onClick={stop}>
        {fileInput}
        {take && <TakeBadge />}
        {take && (
          <button
            type="button"
            className="icon-btn !w-7 !h-7"
            title={takeReady ? "Play the new take" : "Loading the take…"}
            disabled={!takeReady}
            onClick={playTake}
          >
            {playback.playing?.key === takeKeyName ? <Square size={12} fill="currentColor" /> : <Play size={13} />}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost !py-1 !px-2 !text-xs"
          title={take ? "Record this line again, replacing the take" : "Record this line again; only this line's sound changes"}
          onClick={startRecording}
        >
          <Mic size={13} /> {take ? "Again" : "Re-record"}
        </button>
        {!take && (
          <button type="button" className="icon-btn !w-7 !h-7" title="Use an audio file as this line's take" onClick={() => fileRef.current?.click()}>
            <Upload size={13} />
          </button>
        )}
        {take && (
          <button type="button" className="icon-btn !w-7 !h-7" title="Use the original recording" onClick={useOriginal}>
            <Undo2 size={13} />
          </button>
        )}
        {problemNote}
      </div>
    );
  }

  /* ---------- full: the transcript step ---------- */

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs" onClick={stop}>
      {fileInput}
      {take ? (
        <>
          <TakeBadge />
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              className={`btn btn-ghost !py-1 !px-2 !text-xs ${playback.playing?.key === takeKeyName ? "!bg-brand-blue/30 !text-white" : ""}`}
              disabled={!takeReady}
              title={takeReady ? "Play the take exactly as the video will have it" : "Loading the take…"}
              onClick={playTake}
            >
              {playback.playing?.key === takeKeyName ? <Square size={11} fill="currentColor" /> : <Play size={12} />} Take
            </button>
            {audio.sources.main && line.end > line.start && (
              <button
                type="button"
                className={`btn btn-ghost !py-1 !px-2 !text-xs ${playback.playing?.key === originalKeyName ? "!bg-brand-blue/30 !text-white" : ""}`}
                title="Play this line from the main recording, to compare"
                onClick={playOriginal}
              >
                {playback.playing?.key === originalKeyName ? <Square size={11} fill="currentColor" /> : <AudioLines size={12} />} Original
              </button>
            )}
          </span>
          <TakeEdge
            label="Start"
            value={take.start}
            onMinus={() => patchTake(nudgeTake(take, "start", -NUDGE))}
            onPlus={() => patchTake(nudgeTake(take, "start", NUDGE))}
          />
          <TakeEdge
            label="End"
            value={take.end}
            onMinus={() => patchTake(nudgeTake(take, "end", -NUDGE))}
            onPlus={() => patchTake(nudgeTake(take, "end", NUDGE))}
          />
          <span className="text-paper/40">
            {(take.end - take.start).toFixed(1)}s of {take.durationSeconds.toFixed(1)}s
          </span>
          <span className="inline-flex items-center gap-1 ml-auto">
            <button type="button" className="btn btn-ghost !py-1 !px-2 !text-xs" title="Record this line again, replacing the take" onClick={startRecording}>
              <Mic size={12} /> Again
            </button>
            <button type="button" className="btn btn-ghost !py-1 !px-2 !text-xs" title="Use a file as this line's take" onClick={() => fileRef.current?.click()}>
              <Upload size={12} />
            </button>
            <button type="button" className="btn btn-ghost !py-1 !px-2 !text-xs" title="Delete the take and use the main recording" onClick={useOriginal}>
              <Undo2 size={12} /> Use the original
            </button>
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-ghost !py-1 !px-2.5 !text-xs"
            title="Record this line again. Only its sound changes; the text and translations stay."
            onClick={startRecording}
          >
            <Mic size={12} /> Re-record this line
          </button>
          <button
            type="button"
            className="btn btn-ghost !py-1 !px-2.5 !text-xs"
            title="Use an audio file as this line's take"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={12} /> Upload take
          </button>
        </>
      )}
      {problemNote}
    </div>
  );
}

function TakeBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-brand-green/20 border border-brand-green/50 text-white"
      title="This line uses a re-recorded take instead of its part of the main recording"
    >
      <Mic size={11} /> New take
    </span>
  );
}

function TakeEdge({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: number;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-paper/60">
      <span className="text-paper/45">{label}</span>
      <button type="button" className="icon-btn !w-6 !h-6" onClick={onMinus} title={`${label} of the take 0.05s earlier`}>
        <Minus size={12} />
      </button>
      <span className="font-mono tabular-nums text-paper/80 w-10 text-center">{value.toFixed(2)}</span>
      <button type="button" className="icon-btn !w-6 !h-6" onClick={onPlus} title={`${label} of the take 0.05s later`}>
        <Plus size={12} />
      </button>
    </span>
  );
}
