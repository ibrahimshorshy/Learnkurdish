/**
 * Audio clean-up: noise-removal and tone presets, room ambience, and
 * shortening long pauses inside lines — plus a summary of the parts you cut
 * out on the waveform.
 *
 * None of it touches the recording you made. Presets make a cleaned copy with
 * exactly the same timing; pauses and cuts are skipped when each line's clip
 * is built. Pick "Raw" or turn things off and the original is back.
 */

import { useMemo, useState } from "react";
import { Sparkles, Loader2, Check, RotateCcw, Play, Square, Scissors, Timer, AlertTriangle } from "lucide-react";
import type { LessonLine, Project } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";
import { loadRecordingAudio } from "../audio/useRecordingAudio";
import { AUDIO_PRESETS, needsProcessing } from "../config/audioPresets";
import { buildLineClip, cutSummary, lineDuration, type AudioSources } from "../audio/clipBuilder";
import { recallProcessed, takeKey } from "../audio/processing";
import { Slider, Toggle } from "./ui";

export interface AudioCleanupPanelProps {
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
  /** The line the before/after compare plays. Without it, the first line with sound. */
  selectedLineId?: string | null;
}

/** Without lines yet, the compare plays this much of the start of the recording. */
const PREVIEW_SECONDS = 8;

export default function AudioCleanupPanel({ project, audio, playback, update, selectedLineId }: AudioCleanupPanelProps) {
  const fx = project.audioFx;
  const isVideo = project.kind === "video";
  const cleaning = needsProcessing(fx);
  const status = audio.processing;
  const [compareError, setCompareError] = useState<string | null>(null);

  const setFx = (patch: Partial<Project["audioFx"]>) => update((p) => ({ audioFx: { ...p.audioFx, ...patch } }));

  /* ---------- before / after ---------- */

  const hasSound = (l: LessonLine) => !l.skip && (Boolean(l.take) || l.end > l.start);
  const compareIndex = (() => {
    const chosen = project.lines.findIndex((l) => l.id === selectedLineId && hasSound(l));
    if (chosen >= 0) return chosen;
    const playingIndex = project.lines.findIndex((l) => playback.playing?.key === l.id);
    if (playingIndex >= 0) return playingIndex;
    return project.lines.findIndex((l) => hasSound(l) && l.kurdish.trim());
  })();
  const compareLine: LessonLine | null =
    compareIndex >= 0
      ? project.lines[compareIndex]
      : audio.raw
        ? {
            id: "preview",
            kurdish: "",
            start: 0,
            end: Math.min(PREVIEW_SECONDS, audio.raw.buffer.duration),
            transliteration: "",
            translations: {},
          }
        : null;
  const compareName = compareIndex >= 0 ? `line ${compareIndex + 1}` : `the first ${PREVIEW_SECONDS} seconds`;
  const afterReady = (() => {
    const take = compareLine?.take;
    if (!take) return audio.cleaned;
    const k = takeKey(fx, take);
    const made = Boolean(k && (take.processed?.key === k || recallProcessed(take.blob, k)));
    return made && audio.sources.takes.has(take.id);
  })();

  const compare = async (which: "before" | "after") => {
    if (!compareLine) return;
    const key = `ab:${which}:${compareLine.id}`;
    if (playback.playing?.key === key) return playback.stop();
    setCompareError(null);
    try {
      let sources: AudioSources = audio.sources;
      if (which === "before") {
        const takes = new Map(audio.sources.takes);
        if (compareLine.take) takes.set(compareLine.take.id, await loadRecordingAudio(compareLine.take.blob));
        sources = { main: audio.raw, takes };
      }
      const clip = buildLineClip(compareLine, sources, project);
      if (clip) await playback.play(key, clip, { start: compareLine.start, end: compareLine.end });
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    }
  };

  /* ---------- what tightening and cuts take out ---------- */

  const savings = useMemo(() => {
    if (isVideo || !fx.tightenPauses || !audio.sources.main) return null;
    const loose: Project = { ...project, audioFx: { ...fx, tightenPauses: false } };
    let saved = 0;
    let lines = 0;
    for (const line of project.lines) {
      if (line.skip || !line.kurdish.trim()) continue;
      const source = line.take ? audio.sources.takes.get(line.take.id) : audio.sources.main;
      if (!source) continue;
      const diff = lineDuration(line, audio.sources, loose) - lineDuration(line, audio.sources, project);
      // Below a few milliseconds it is only the crossfade at a cut, not a pause.
      if (diff > 0.03) {
        saved += diff;
        lines++;
      }
    }
    return { saved, lines };
  }, [isVideo, fx, project, audio.sources]);

  const cuts = cutSummary(project);

  return (
    <section className="card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Sparkles size={18} /> Sound
          </h2>
          <p className="text-xs text-paper/55">
            Clean up your voice. The timing never changes, and your original recording is always kept.
          </p>
        </div>
        <StatusPill preset={fx.preset} cleaning={cleaning} cleaned={audio.cleaned} status={status} onRetry={audio.retryProcessing} />
      </div>

      {status.state === "error" && (
        <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 whitespace-pre-wrap flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            {status.message}{" "}
            <span className="text-paper/60">Until it works, the lines use your recording as it is.</span>
          </span>
        </p>
      )}

      <div className="space-y-2">
        <span className="label">Clean-up</span>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {AUDIO_PRESETS.map((preset) => {
            const on = fx.preset === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setFx({ preset: preset.id })}
                aria-pressed={on}
                className={`text-left rounded-xl border px-3 py-2.5 transition-colors cursor-pointer ${
                  on ? "bg-brand-blue/20 border-brand-blue text-white" : "border-white/10 hover:bg-white/5 text-paper/80"
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {on && <Check size={14} />}
                  {preset.label}
                </span>
                <span className="block text-[11px] leading-snug text-paper/55 mt-0.5">{preset.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={cleaning ? "" : "opacity-40 pointer-events-none"} title={cleaning ? undefined : "Pick a clean-up preset first"}>
          <Toggle checked={fx.room && cleaning} onChange={(room) => setFx({ room })}>
            Room ambience{" "}
            <span className="text-paper/50 text-xs">— a touch of small-room sound, for a very dry recording</span>
          </Toggle>
        </div>

        {cleaning && compareLine && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-paper/55">Compare on {compareName}:</span>
            <CompareButton
              label="Before"
              playing={playback.playing?.key === `ab:before:${compareLine.id}`}
              disabled={!audio.raw && !compareLine.take}
              onClick={() => void compare("before")}
            />
            <CompareButton
              label="After"
              playing={playback.playing?.key === `ab:after:${compareLine.id}`}
              disabled={!afterReady}
              title={afterReady ? undefined : "Still cleaning — a moment"}
              onClick={() => void compare("after")}
            />
          </div>
        )}
      </div>
      {compareError && <p className="text-xs text-red-300">{compareError}</p>}

      {isVideo ? (
        <p className="text-xs text-paper/50 flex items-center gap-1.5">
          <Timer size={13} /> A video keeps every pause, so its sound stays in step with the picture.
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 pt-1 border-t border-white/5">
          <div className="space-y-2 pt-4">
            <span className="label flex items-center gap-1.5">
              <Timer size={13} /> Pauses
            </span>
            <Toggle checked={fx.tightenPauses} onChange={(tightenPauses) => setFx({ tightenPauses })}>
              Shorten long pauses inside lines
            </Toggle>
            {fx.tightenPauses && (
              <>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-paper/60 shrink-0">Longest pause</span>
                  <div className="flex-1">
                    <Slider value={fx.maxPause} min={0.2} max={1.5} step={0.05} suffix="s" onChange={(maxPause) => setFx({ maxPause })} />
                  </div>
                </div>
                <p className="text-xs text-paper/50">
                  {savings === null
                    ? "Measuring your pauses…"
                    : savings.lines
                      ? `Takes out ${savings.saved.toFixed(1)}s of silence across ${savings.lines} ${savings.lines === 1 ? "line" : "lines"}. The pause between lines is set on the video step.`
                      : `No pause inside a line is longer than ${fx.maxPause.toFixed(2)}s.`}
                </p>
              </>
            )}
          </div>

          <div className="space-y-2 pt-4">
            <span className="label flex items-center gap-1.5">
              <Scissors size={13} /> Cut parts
            </span>
            <p className="text-xs text-paper/55">
              To cut a cough, a false start or an “um”: on the waveform, turn on <b className="text-paper/80">Cut</b> (or hold
              Shift and drag), select the part, then <b className="text-paper/80">Remove</b>. Click a removed part to restore it.
            </p>
            {cuts.count > 0 ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-paper/80">
                  {cuts.count} {cuts.count === 1 ? "part" : "parts"} cut · {cuts.total.toFixed(1)}s
                  {Math.abs(cuts.inLines - cuts.total) > 0.05 && (
                    <span className="text-paper/50"> ({cuts.inLines.toFixed(1)}s of it inside lines)</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost !py-1 !px-2.5 !text-xs"
                  onClick={() => window.confirm(`Restore all ${cuts.count} cut ${cuts.count === 1 ? "part" : "parts"}?`) && update({ cuts: [] })}
                >
                  <RotateCcw size={12} /> Restore all
                </button>
              </div>
            ) : (
              <p className="text-xs text-paper/40">Nothing cut.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function StatusPill({
  preset,
  cleaning,
  cleaned,
  status,
  onRetry,
}: {
  preset: string;
  cleaning: boolean;
  cleaned: boolean;
  status: LessonAudio["processing"];
  onRetry: () => void;
}) {
  const base = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border";
  if (!cleaning || preset === "raw") {
    return <span className={`${base} border-white/10 text-paper/55`}>As recorded</span>;
  }
  if (status.state === "processing") {
    return (
      <span className={`${base} border-brand-blue/40 bg-brand-blue/10 text-paper/85`} title="Your recording is used as it is until this finishes">
        <Loader2 size={12} className="animate-spin" /> Cleaning {status.label}
        {status.remaining > 1 ? ` (+${status.remaining - 1} more)` : ""}…
      </span>
    );
  }
  if (status.state === "error") {
    return (
      <span className="inline-flex items-center gap-2">
        <span className={`${base} border-red-500/40 bg-red-500/10 text-red-200`}>Clean-up failed</span>
        <button type="button" className="btn btn-ghost !py-1 !px-2.5 !text-xs" onClick={onRetry}>
          <RotateCcw size={12} /> Try again
        </button>
      </span>
    );
  }
  if (cleaned) {
    return (
      <span className={`${base} border-brand-green/50 bg-brand-green/15 text-white`}>
        <Check size={12} /> Cleaned
      </span>
    );
  }
  return null;
}

function CompareButton({
  label,
  playing,
  disabled,
  title,
  onClick,
}: {
  label: string;
  playing: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn btn-ghost !py-1 !px-2.5 !text-xs ${playing ? "!bg-brand-blue/30 !text-white" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {playing ? <Square size={11} fill="currentColor" /> : <Play size={12} />} {label}
    </button>
  );
}
