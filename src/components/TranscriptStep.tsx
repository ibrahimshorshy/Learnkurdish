import { useRef, useState } from "react";
import {
  Play,
  Square,
  Trash2,
  Scissors,
  Merge,
  Plus,
  Minus,
  Magnet,
  AudioLines,
  Languages,
  Loader2,
  StickyNote,
  ArrowRight,
  Pilcrow,
  Users,
} from "lucide-react";
import type { LessonLine, Project } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";
import type { AppSettings } from "../utils/settings";
import { buildLineClip } from "../audio/clipBuilder";
import WaveformEditor from "./WaveformEditor";
import AudioCleanupPanel from "./AudioCleanupPanel";
import LineTakeControls from "./LineTakeControls";
import DialogueSpeakers from "./DialogueSpeakers";
import AutoTextarea from "./AutoTextarea";
import { formatTime } from "../audio/audioTools";
import { placeLinesByLength, snapLinesToPauses } from "../audio/segmentation";
import { mergeLines, splitLine, untranslated } from "../lessonActions";
import { newId, speakerName } from "../utils/projectStore";
import { AUDIENCE_LANGUAGES } from "../config/languages";

interface Props {
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  settings: AppSettings;
  enabledAudiences: string[];
  busy: boolean;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
  onTranslate: () => void;
}

const NUDGE = 0.05;

export default function TranscriptStep({
  project,
  audio,
  playback,
  settings,
  enabledAudiences,
  busy,
  update,
  onTranslate,
}: Props) {
  const raw = audio.raw;
  const [selectedId, setSelectedId] = useState<string | null>(project.lines[0]?.id ?? null);
  const caretRef = useRef<Record<string, number>>({});
  const lines = project.lines;
  const duration = raw?.buffer.duration ?? project.recording?.durationSeconds ?? 0;
  const isDialogue = project.kind === "dialogue";
  const isStory = project.kind === "story";

  const setLines = (next: LessonLine[], manual = true) =>
    update({ lines: next, ...(manual ? { timesSource: "manual" as const } : {}) });

  const patchLine = (id: string, patch: Partial<LessonLine>) =>
    update((p) => ({ lines: p.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));

  /** Plays the line as the video will have it: its take or slice, cuts out, pauses tightened, cleaned up. */
  const play = (line: LessonLine) => {
    if (playback.playing?.key === line.id) return playback.stop();
    const clip = buildLineClip(line, audio.sources, project);
    if (clip) void playback.play(line.id, clip, { start: line.start, end: line.end });
  };

  const nudge = (index: number, edge: "start" | "end", delta: number) => {
    const line = lines[index];
    const floor = index > 0 ? lines[index - 1].end : 0;
    const ceiling = index < lines.length - 1 ? lines[index + 1].start : duration;
    const value =
      edge === "start"
        ? Math.max(floor, Math.min(line.end - 0.15, line.start + delta))
        : Math.min(ceiling, Math.max(line.start + 0.15, line.end + delta));
    update((p) => ({
      timesSource: "manual",
      lines: p.lines.map((l) => (l.id === line.id ? { ...l, [edge]: Math.round(value * 1000) / 1000 } : l)),
    }));
  };

  const split = (index: number) => {
    const line = lines[index];
    const parts = splitLine(line, caretRef.current[line.id] ?? -1, raw);
    if (!parts) {
      window.alert("Put the cursor where the line should be split, between two words.");
      return;
    }
    setLines([...lines.slice(0, index), ...parts, ...lines.slice(index + 1)]);
    setSelectedId(parts[1].id);
  };

  const merge = (index: number) => {
    if (index >= lines.length - 1) return;
    const merged = mergeLines(lines[index], lines[index + 1]);
    setLines([...lines.slice(0, index), merged, ...lines.slice(index + 2)]);
    setSelectedId(merged.id);
  };

  const remove = (index: number) => {
    const line = lines[index];
    if (line.kurdish.trim() && !window.confirm(`Delete line ${index + 1}?`)) return;
    setLines(lines.filter((_, i) => i !== index));
  };

  const addAfter = (index: number) => {
    const prev = lines[index];
    const next = lines[index + 1];
    const start = prev ? prev.end : 0;
    const end = next ? next.start : Math.min(duration, start + 2);
    const line: LessonLine = {
      id: newId("l"),
      kurdish: "",
      start,
      end: end - start >= 0.3 ? end : Math.min(duration, start + 1),
      transliteration: "",
      translations: {},
    };
    setLines([...lines.slice(0, index + 1), line, ...lines.slice(index + 1)]);
    setSelectedId(line.id);
  };

  const snapAll = () => {
    if (!raw) return;
    const ranges = snapLinesToPauses(lines, raw.analysis);
    setLines(lines.map((l, i) => ({ ...l, ...ranges[i] })), false);
    update({ timesSource: "audio" });
  };

  const placeAll = () => {
    if (!raw) return;
    if (!window.confirm("Ignore the current times and place every line again from the pauses in your voice?")) return;
    const ranges = placeLinesByLength(
      lines.map((l) => l.kurdish),
      raw.analysis
    );
    setLines(lines.map((l, i) => ({ ...l, ...ranges[i] })), false);
    update({ timesSource: "audio" });
  };

  const toggleAudience = (id: string) => {
    const has = project.audiences.includes(id);
    const next = has ? project.audiences.filter((a) => a !== id) : [...project.audiences, id];
    if (!next.length) return;
    // Keep the language order stable, as listed in the config.
    const ordered = AUDIENCE_LANGUAGES.map((a) => a.id).filter((a) => next.includes(a));
    update((p) => ({
      audiences: ordered,
      video: { ...p.video, outputs: ordered.map((a) => [a]) },
    }));
  };

  const stale = untranslated(project).length;
  const anyTranslated = lines.some((l) => Object.values(l.translations).some((t) => t?.trim()));
  const empty = lines.filter((l) => !l.kurdish.trim()).length;

  return (
    <div className="space-y-5">
      <section className="card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">
              {isStory ? "Sentences" : "Transcript"} — {lines.length} {isStory ? "sentences" : "lines"}
            </h2>
            <p className="text-xs text-paper/55">
              {project.timesSource === "audio"
                ? "Line times were placed from the pauses in your voice."
                : project.timesSource === "manual"
                  ? "Line times adjusted by hand."
                  : "Line times from the AI, moved into the nearest pauses."}{" "}
              Listen to each line and fix anything misheard.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost" onClick={snapAll} disabled={!raw || !lines.length}>
              <Magnet size={15} /> Snap edges to pauses
            </button>
            <button type="button" className="btn btn-ghost" onClick={placeAll} disabled={!raw || !lines.length}>
              <AudioLines size={15} /> Re-place from audio
            </button>
          </div>
        </div>

        {raw && (
          <WaveformEditor
            playback={playback}
            mono={raw.mono}
            duration={duration}
            lines={lines}
            cuts={project.kind === "video" ? undefined : project.cuts}
            onCutsChange={project.kind === "video" ? undefined : (cuts) => update({ cuts })}
            selectedId={selectedId}
            playhead={playback.position}
            onSelect={setSelectedId}
            onPlayLine={play}
            onRetime={(id, range) =>
              update((p) => ({
                timesSource: "manual",
                lines: p.lines.map((l) =>
                  l.id === id
                    ? { ...l, start: Math.round(range.start * 1000) / 1000, end: Math.round(range.end * 1000) / 1000 }
                    : l
                ),
              }))
            }
          />
        )}
      </section>

      <AudioCleanupPanel
        project={project}
        audio={audio}
        playback={playback}
        update={update}
        selectedLineId={selectedId}
      />

      {isDialogue && (
        <section className="card p-5 space-y-3">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Users size={18} /> Speakers
          </h2>
          <DialogueSpeakers project={project} update={update} />
        </section>
      )}

      <section className="space-y-2">
        {lines.map((line, index) => {
          const selected = line.id === selectedId;
          const isPlaying = playback.playing?.key === line.id;
          return (
            <div
              key={line.id}
              onClick={() => setSelectedId(line.id)}
              className={`card p-3 sm:p-4 flex flex-col sm:flex-row gap-3 transition-colors ${
                selected ? "!border-brand-blue/60" : ""
              }`}
            >
              <div className="flex sm:flex-col items-center gap-2 sm:w-10 shrink-0">
                <span className="text-xs font-bold text-paper/50 w-6 text-center">{index + 1}</span>
                <button
                  type="button"
                  className={`icon-btn ${isPlaying ? "!bg-brand-blue/30 !text-white" : ""}`}
                  title={isPlaying ? "Stop" : "Play this line"}
                  onClick={(e) => {
                    e.stopPropagation();
                    play(line);
                  }}
                  disabled={!audio.sources.main && !line.take}
                >
                  {isPlaying ? <Square size={14} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                </button>
              </div>

              <div className="flex-1 min-w-0 space-y-2">
                {(isDialogue || isStory) && (
                  <div className="flex flex-wrap items-center gap-2">
                    {isDialogue &&
                      [0, 1].map((who) => (
                        <button
                          key={who}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            patchLine(line.id, { speaker: who });
                          }}
                          className={`px-2.5 py-1 rounded-full text-xs font-semibold border cursor-pointer transition-colors ${
                            (line.speaker ?? 0) === who
                              ? who === 0
                                ? "bg-brand-blue/25 border-brand-blue text-white"
                                : "bg-brand-green/25 border-brand-green text-white"
                              : "border-white/10 text-paper/45 hover:bg-white/5"
                          }`}
                        >
                          {speakerName(project, who)}
                        </button>
                      ))}
                    {isStory && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (index > 0) patchLine(line.id, { paragraphStart: !line.paragraphStart });
                        }}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border cursor-pointer transition-colors ${
                          line.paragraphStart || index === 0
                            ? "bg-kurd-sun/15 border-kurd-sun/60 text-white"
                            : "border-white/10 text-paper/45 hover:bg-white/5"
                        }`}
                        title={index === 0 ? "The story starts here" : "Start a new paragraph at this sentence"}
                      >
                        <Pilcrow size={12} /> {line.paragraphStart || index === 0 ? "New paragraph" : "Same paragraph"}
                      </button>
                    )}
                  </div>
                )}
                <AutoTextarea
                  dir="rtl"
                  lang="ckb"
                  className="script text-lg"
                  placeholder="بنووسە…"
                  value={line.kurdish}
                  onChange={(e) => {
                    caretRef.current[line.id] = e.target.selectionStart;
                    patchLine(line.id, { kurdish: e.target.value });
                  }}
                  onSelect={(e) => {
                    caretRef.current[line.id] = (e.target as HTMLTextAreaElement).selectionStart;
                  }}
                  onFocus={() => setSelectedId(line.id)}
                />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-paper/60">
                  <TimeControl
                    label="Start"
                    value={line.start}
                    onMinus={() => nudge(index, "start", -NUDGE)}
                    onPlus={() => nudge(index, "start", NUDGE)}
                  />
                  <TimeControl
                    label="End"
                    value={line.end}
                    onMinus={() => nudge(index, "end", -NUDGE)}
                    onPlus={() => nudge(index, "end", NUDGE)}
                  />
                  <span className="text-paper/40">{(line.end - line.start).toFixed(1)}s</span>
                  {line.translatedFrom !== undefined && line.translatedFrom !== line.kurdish && (
                    <span className="text-kurd-sun">changed since translation</span>
                  )}
                </div>
                <LineTakeControls
                  line={line}
                  project={project}
                  audio={audio}
                  playback={playback}
                  settings={settings}
                  update={update}
                />
              </div>

              <div className="flex sm:grid sm:grid-cols-2 gap-1 shrink-0 justify-end self-start">
                <button type="button" className="icon-btn" title="Split at the cursor" onClick={() => split(index)}>
                  <Scissors size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Merge with the next line"
                  onClick={() => merge(index)}
                  disabled={index === lines.length - 1}
                >
                  <Merge size={15} />
                </button>
                <button type="button" className="icon-btn" title="Add a line after this one" onClick={() => addAfter(index)}>
                  <Plus size={15} />
                </button>
                <button type="button" className="icon-btn hover:!text-red-300" title="Delete line" onClick={() => remove(index)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          );
        })}
        {!lines.length && (
          <div className="card p-6 text-center text-paper/60 text-sm">
            No lines yet.{" "}
            <button type="button" className="underline" onClick={() => addAfter(-1)}>
              Add one by hand
            </button>
            .
          </div>
        )}
      </section>

      <section className="card p-5 space-y-4">
        <div>
          <label className="label flex items-center gap-1.5" htmlFor="note">
            <StickyNote size={13} /> Note for the translation{" "}
            <span className="normal-case font-normal tracking-normal">(optional)</span>
          </label>
          <AutoTextarea
            id="note"
            minRows={2}
            className="mt-2"
            placeholder="Tell the AI what to focus on — e.g. “Keep the English very simple”, “Use Iraqi Arabic”, “This lesson is about the verb چوون — translate each form so the difference is clear”. Or leave it empty."
            value={project.note}
            onChange={(e) => update({ note: e.target.value })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="label mr-1">Translate into</span>
          {AUDIENCE_LANGUAGES.filter((a) => enabledAudiences.includes(a.id) || project.audiences.includes(a.id)).map(
            (a) => {
              const on = project.audiences.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggleAudience(a.id)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-colors cursor-pointer ${
                    on ? "bg-brand-blue/20 border-brand-blue text-white" : "border-white/15 text-paper/50 hover:bg-white/5"
                  }`}
                >
                  {a.label} <span className="script text-paper/60">{a.nativeLabel !== a.label ? a.nativeLabel : ""}</span>
                </button>
              );
            }
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {empty > 0 && <span className="text-xs text-kurd-sun">{empty} empty line(s) will be skipped</span>}
          {anyTranslated && stale === 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => update({ step: "translate" })}>
              Review translations <ArrowRight size={15} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary px-5 py-2.5"
            onClick={onTranslate}
            disabled={busy || !lines.some((l) => l.kurdish.trim())}
          >
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Languages size={17} />}
            {busy ? "Translating…" : anyTranslated ? "Translate again" : "Translate"}
          </button>
        </div>
      </section>
    </div>
  );
}

function TimeControl({
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
    <span className="inline-flex items-center gap-1">
      <span className="text-paper/45">{label}</span>
      <button type="button" className="icon-btn !w-6 !h-6" onClick={onMinus} title={`${label} 0.05s earlier`}>
        <Minus size={12} />
      </button>
      <span className="font-mono tabular-nums text-paper/80 w-14 text-center">{formatTime(value, 2)}</span>
      <button type="button" className="icon-btn !w-6 !h-6" onClick={onPlus} title={`${label} 0.05s later`}>
        <Plus size={12} />
      </button>
    </span>
  );
}

