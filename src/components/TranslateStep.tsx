import { useState } from "react";
import {
  Play,
  Square,
  RefreshCw,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  Copy,
  Check,
  AlertTriangle,
  Languages,
  Wand2,
} from "lucide-react";
import type { LessonLine, Project } from "../types";
import type { LessonAudio, Playback } from "../audio/useRecordingAudio";
import type { AppSettings } from "../utils/settings";
import { buildLineClip } from "../audio/clipBuilder";
import { speakerName } from "../utils/projectStore";
import LineTakeControls from "./LineTakeControls";
import AutoTextarea from "./AutoTextarea";
import { findAudienceLanguage } from "../config/languages";
import { untranslated } from "../lessonActions";

interface Props {
  project: Project;
  audio: LessonAudio;
  playback: Playback;
  settings: AppSettings;
  busy: boolean;
  /** Which line is being re-translated on its own, if any. */
  busyLineId: string | null;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
  onTranslateAll: () => void;
  onTranslateLines: (ids: string[], instruction?: string) => void;
  onApprove: () => void;
}

export default function TranslateStep({
  project,
  audio,
  playback,
  settings,
  busy,
  busyLineId,
  update,
  onTranslateAll,
  onTranslateLines,
  onApprove,
}: Props) {
  const audiences = project.audiences.map((id) => findAudienceLanguage(id)).filter(Boolean) as NonNullable<
    ReturnType<typeof findAudienceLanguage>
  >[];
  const lines = project.lines;
  const stale = untranslated(project);
  const hasAny = lines.some((l) => Object.values(l.translations).some((t) => t?.trim()));
  const included = lines.filter((l) => !l.skip && l.kurdish.trim()).length;

  const patchLine = (id: string, patch: Partial<LessonLine>) =>
    update((p) => ({ lines: p.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)), approvedAt: undefined }));

  const play = (line: LessonLine) => {
    if (playback.playing?.key === line.id) return playback.stop();
    const clip = buildLineClip(line, audio.sources, project);
    if (clip) void playback.play(line.id, clip, { start: line.start, end: line.end });
  };

  if (!hasAny) {
    return (
      <div className="card p-8 text-center space-y-4">
        <Languages className="mx-auto text-brand-blue" size={36} />
        <p className="text-paper/70">Nothing has been translated yet.</p>
        <button type="button" className="btn btn-primary" onClick={onTranslateAll} disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}
          {busy ? "Translating…" : `Translate ${lines.length} lines`}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {stale.length > 0 && (
        <div className="card !border-kurd-sun/40 p-4 flex flex-wrap items-center gap-3">
          <AlertTriangle className="text-kurd-sun shrink-0" size={18} />
          <p className="text-sm flex-1 min-w-48">
            {stale.length} line{stale.length === 1 ? " has" : "s have"} Kurdish that changed after translating, or a
            missing translation.
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onTranslateLines(stale.map((l) => l.id))}
            disabled={busy}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Translate just those
          </button>
        </div>
      )}

      <section className="card p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Lesson title</h2>
          <button type="button" className="btn btn-ghost" onClick={onTranslateAll} disabled={busy}>
            {busy && !busyLineId ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Translate everything again
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {audiences.map((a) => (
            <div key={a.id}>
              <label className="label">{a.label}</label>
              <input
                dir={a.rtl ? "rtl" : "ltr"}
                className={`field mt-1.5 ${a.rtl ? "script" : ""}`}
                value={project.titles[a.id] || ""}
                placeholder={a.rtl ? "عنوان الدرس" : "Lesson title"}
                onChange={(e) =>
                  update((p) => ({ titles: { ...p.titles, [a.id]: e.target.value }, approvedAt: undefined }))
                }
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        {lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            audiences={audiences}
            playing={playback.playing?.key === line.id}
            canPlay={Boolean(audio.sources.main || line.take)}
            tag={
              project.kind === "dialogue"
                ? { text: speakerName(project, line.speaker ?? 0), tone: (line.speaker ?? 0) === 0 ? "blue" : "green" }
                : project.kind === "story" && (line.paragraphStart || index === 0)
                  ? { text: "¶ New paragraph", tone: "sun" }
                  : undefined
            }
            takeControls={
              <LineTakeControls
                line={line}
                project={project}
                audio={audio}
                playback={playback}
                settings={settings}
                compact
                update={update}
              />
            }
            busy={busyLineId === line.id}
            disabled={busy}
            onPlay={() => play(line)}
            onPatch={(patch) => patchLine(line.id, patch)}
            onRetranslate={(instruction) => onTranslateLines([line.id], instruction)}
          />
        ))}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-lg font-bold">Post captions</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {audiences.map((a) => (
            <CaptionBox
              key={a.id}
              label={a.label}
              rtl={a.rtl}
              value={project.captions[a.id] || ""}
              onChange={(value) => update((p) => ({ captions: { ...p.captions, [a.id]: value } }))}
            />
          ))}
        </div>
      </section>

      <div className="card p-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-paper/65">
          {included} of {lines.length} lines go into the video.
          {project.approvedAt ? " Approved — edits since then un-approve it." : " Proofread, then approve."}
        </p>
        <button
          type="button"
          className="btn btn-primary px-5 py-2.5"
          onClick={onApprove}
          disabled={busy || !included || stale.some((l) => !l.skip)}
          title={stale.some((l) => !l.skip) ? "Translate the changed lines first" : undefined}
        >
          <CheckCircle2 size={17} /> Approve &amp; make videos
        </button>
      </div>
    </div>
  );
}

function LineCard({
  line,
  index,
  audiences,
  playing,
  canPlay,
  tag,
  takeControls,
  busy,
  disabled,
  onPlay,
  onPatch,
  onRetranslate,
}: {
  tag?: { text: string; tone: "blue" | "green" | "sun" };
  takeControls?: React.ReactNode;
  line: LessonLine;
  index: number;
  audiences: NonNullable<ReturnType<typeof findAudienceLanguage>>[];
  playing: boolean;
  canPlay: boolean;
  busy: boolean;
  disabled: boolean;
  onPlay: () => void;
  onPatch: (patch: Partial<LessonLine>) => void;
  onRetranslate: (instruction?: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");
  const changed = line.translatedFrom !== undefined && line.translatedFrom !== line.kurdish;

  return (
    <div className={`card p-4 space-y-3 ${line.skip ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1 shrink-0 pt-1">
          <span className="text-xs font-bold text-paper/50">{index + 1}</span>
          <button
            type="button"
            className={`icon-btn ${playing ? "!bg-brand-blue/30 !text-white" : ""}`}
            onClick={onPlay}
            disabled={!canPlay}
            title="Play this line"
          >
            {playing ? <Square size={14} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          {tag && (
            <span
              className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                tag.tone === "blue"
                  ? "bg-brand-blue/20 border-brand-blue/60"
                  : tag.tone === "green"
                    ? "bg-brand-green/20 border-brand-green/60"
                    : "bg-kurd-sun/15 border-kurd-sun/50"
              }`}
            >
              {tag.text}
            </span>
          )}
          <AutoTextarea
            dir="rtl"
            lang="ckb"
            className="script text-xl font-semibold"
            value={line.kurdish}
            onChange={(e) => onPatch({ kurdish: e.target.value })}
          />
          <input
            dir="ltr"
            className="field italic text-sm text-paper/80"
            placeholder="Pronunciation (Latin letters)"
            value={line.transliteration}
            onChange={(e) => onPatch({ transliteration: e.target.value })}
          />
          {takeControls}
          {changed && (
            <p className="text-xs text-kurd-sun flex flex-wrap items-center gap-x-3 gap-y-1">
              The Kurdish changed after this was translated.
              <button type="button" className="underline cursor-pointer" onClick={() => onRetranslate()}>
                Re-translate
              </button>
              <button
                type="button"
                className="underline cursor-pointer text-paper/70"
                onClick={() => onPatch({ translatedFrom: line.kurdish })}
              >
                The translation still fits
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            className="icon-btn"
            title={line.skip ? "Put back in the video" : "Leave out of the video"}
            onClick={() => onPatch({ skip: !line.skip })}
          >
            {line.skip ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Translate this line again"
            onClick={() => setAsking((v) => !v)}
            disabled={disabled}
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
          </button>
        </div>
      </div>

      {asking && (
        <div className="flex flex-wrap gap-2 pl-11">
          <input
            className="field flex-1 min-w-52 text-sm"
            placeholder="Optional: how should it change? e.g. “more casual”, “say ‘dear’ not ‘darling’”"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRetranslate(instruction);
                setAsking(false);
              }
            }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => {
              onRetranslate(instruction);
              setAsking(false);
            }}
          >
            <RefreshCw size={14} /> Re-translate
          </button>
        </div>
      )}

      <div className={`grid gap-3 pl-11 ${audiences.length > 1 ? "md:grid-cols-2" : ""}`}>
        {audiences.map((a) => (
          <div key={a.id}>
            <span className="label">{a.label}</span>
            <AutoTextarea
              dir={a.rtl ? "rtl" : "ltr"}
              lang={a.id}
              className={`mt-1 ${a.rtl ? "script" : ""}`}
              value={line.translations[a.id] || ""}
              onChange={(e) => onPatch({ translations: { ...line.translations, [a.id]: e.target.value } })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function CaptionBox({
  label,
  rtl,
  value,
  onChange,
}: {
  label: string;
  rtl: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <button
          type="button"
          className="icon-btn"
          title="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      <AutoTextarea
        dir={rtl ? "rtl" : "ltr"}
        minRows={3}
        // Each line takes its own direction, so an English hashtag line under
        // Arabic text does not come out mirrored.
        style={{ unicodeBidi: "plaintext" }}
        className={`mt-1 text-sm ${rtl ? "script" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
