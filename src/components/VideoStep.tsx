import { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Download, Loader2, Play, Square, Trash2, AlertTriangle, Copy, Check, X } from "lucide-react";
import type { Project, RenderedVideo, VideoSettings } from "../types";
import type { RecordingAudio } from "../audio/useRecordingAudio";
import { THEMES, THEME_ORDER } from "../render/themes";
import {
  RESOLUTIONS,
  drawStill,
  prepareLesson,
  renderVideo,
  startPreview,
  stillMoment,
  type PreparedLesson,
  type PreviewHandle,
  type ResolutionId,
} from "../render/renderLesson";
import { findAudienceLanguage } from "../config/languages";
import { fingerprint, outputKey, videoLinesFrom } from "../lessonActions";
import { newId, formatBytes } from "../utils/projectStore";
import { asciiFileName, downloadBlob } from "../utils/download";
import { formatTime } from "../audio/audioTools";
import { stopPlayback } from "../audio/audioTools";

interface Props {
  project: Project;
  audio: RecordingAudio | null;
  ffmpeg: boolean | null;
  logoSrc: string;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

const PREVIEW_WIDTH = 540;

export default function VideoStep({ project, audio, ffmpeg, logoSrc, update }: Props) {
  const v = project.video;
  const setVideo = (patch: Partial<VideoSettings>) => update((p) => ({ video: { ...p.video, ...patch } }));

  // Every video that can be made: one per language, plus all of them together.
  const choices = useMemo(() => {
    const single = project.audiences.map((id) => [id]);
    return project.audiences.length > 1 ? [...single, [...project.audiences]] : single;
  }, [project.audiences]);

  const chosen = new Set(v.outputs.map(outputKey));
  const toggleOutput = (langs: string[]) => {
    const key = outputKey(langs);
    const next = chosen.has(key) ? v.outputs.filter((o) => outputKey(o) !== key) : [...v.outputs, langs];
    setVideo({ outputs: next });
  };

  const [previewLangs, setPreviewLangs] = useState<string[]>(() => v.outputs[0] ?? [project.audiences[0]]);
  useEffect(() => {
    if (!project.audiences.includes(previewLangs[0])) setPreviewLangs([project.audiences[0]]);
  }, [project.audiences, previewLangs]);

  /* ---------- preview ---------- */

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const [prepared, setPrepared] = useState<PreparedLesson | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);

  const lines = useMemo(() => (audio ? videoLinesFrom(project, audio) : []), [project.lines, audio]); // eslint-disable-line react-hooks/exhaustive-deps

  const look = useMemo(
    () => ({
      theme: v.theme,
      plays: v.plays,
      repeatGapMode: v.repeatGapMode,
      repeatGapSeconds: v.repeatGapSeconds,
      gapBetweenLines: v.gapBetweenLines,
      intro: v.intro,
      outro: v.outro,
      showTransliteration: v.showTransliteration,
      karaoke: v.karaoke,
    }),
    [v.theme, v.plays, v.repeatGapMode, v.repeatGapSeconds, v.gapBetweenLines, v.intro, v.outro, v.showTransliteration, v.karaoke]
  );

  useEffect(() => {
    if (!lines.length) return;
    let live = true;
    previewRef.current?.stop();
    const timer = setTimeout(() => {
      prepareLesson({ width: PREVIEW_WIDTH, lines, languages: previewLangs, titles: project.titles, look, logoSrc }).then(
        (p) => {
          if (!live) return;
          setPrepared(p);
          if (canvasRef.current) drawStill(p, canvasRef.current, stillMoment(p));
        }
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lines, previewLangs, project.titles, look, logoSrc]);

  useEffect(() => () => previewRef.current?.stop(), []);

  const togglePreview = () => {
    if (!prepared || !canvasRef.current) return;
    if (previewRef.current) {
      previewRef.current.stop();
      previewRef.current = null;
      setPreviewTime(null);
      drawStill(prepared, canvasRef.current, stillMoment(prepared));
      return;
    }
    stopPlayback();
    const handle = startPreview(prepared, canvasRef.current, setPreviewTime);
    previewRef.current = handle;
    void handle.done.then(() => {
      if (previewRef.current === handle) {
        previewRef.current = null;
        setPreviewTime(null);
      }
    });
  };

  /* ---------- rendering ---------- */

  const [job, setJob] = useState<{ label: string; progress: number; index: number; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const makeVideos = async () => {
    if (!audio || !lines.length) return;
    previewRef.current?.stop();
    previewRef.current = null;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const outputs = v.outputs.filter((o) => o.every((id) => project.audiences.includes(id)));
    const made: RenderedVideo[] = [];
    try {
      for (let i = 0; i < outputs.length; i++) {
        const langs = outputs[i];
        const label = langs.map((id) => findAudienceLanguage(id)?.label ?? id).join(" + ");
        setJob({ label, progress: 0, index: i, count: outputs.length });
        const lesson = await prepareLesson({
          width: RESOLUTIONS[v.resolution].width,
          lines,
          languages: langs,
          titles: project.titles,
          look,
          logoSrc,
        });
        const result = await renderVideo(
          lesson,
          (progress) => setJob({ label, progress, index: i, count: outputs.length }),
          controller.signal
        );
        const video: RenderedVideo = {
          id: newId("v"),
          languages: langs,
          blob: result.blob,
          createdAt: Date.now(),
          durationSeconds: result.durationSeconds,
          fingerprint: fingerprint(project, langs),
        };
        made.push(video);
        // Save each one as it lands, so a failure later keeps the earlier ones.
        update((p) => ({
          renders: [video, ...p.renders.filter((r) => outputKey(r.languages) !== outputKey(langs))],
        }));
      }
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setJob(null);
      abortRef.current = null;
    }
  };

  const fileName = (video: RenderedVideo) => {
    const base = asciiFileName(project.titles.en || project.name || "", "kurdish-lesson")
      .replace(/\s+/g, "-")
      .toLowerCase();
    return `${base}-${video.languages.join("-")}.mp4`;
  };

  const notReady = !project.approvedAt;
  const totalSeconds = prepared?.timeline.total ?? 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5 order-2 lg:order-1">
        {notReady && (
          <div className="card !border-kurd-sun/40 p-4 text-sm flex items-center gap-2">
            <AlertTriangle size={16} className="text-kurd-sun shrink-0" />
            The translations were edited after approval, or never approved. You can still make videos — check them first.
          </div>
        )}

        <section className="card p-5 space-y-4">
          <h2 className="text-lg font-bold">Look</h2>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {THEME_ORDER.map((id) => {
              const theme = THEMES[id];
              const on = v.theme === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setVideo({ theme: id })}
                  className={`rounded-xl p-1.5 border text-left cursor-pointer transition-colors ${
                    on ? "border-brand-blue bg-brand-blue/10" : "border-white/10 hover:bg-white/5"
                  }`}
                  title={theme.blurb}
                >
                  <div className="h-14 rounded-lg" style={{ background: theme.swatch }} />
                  <div className="text-[11px] mt-1 font-semibold truncate">{theme.label}</div>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Each line plays">
              <Segmented
                value={String(v.plays)}
                options={[
                  ["1", "Once"],
                  ["2", "Twice"],
                  ["3", "3 times"],
                ]}
                onChange={(value) => setVideo({ plays: Number(value) })}
              />
            </Field>
            <Field label="Time to repeat after each play">
              <Segmented
                value={v.repeatGapMode}
                options={[
                  ["off", "None"],
                  ["auto", "As long as the line"],
                  ["fixed", "Fixed"],
                ]}
                onChange={(value) => setVideo({ repeatGapMode: value as VideoSettings["repeatGapMode"] })}
              />
              {v.repeatGapMode === "fixed" && (
                <Slider
                  value={v.repeatGapSeconds}
                  min={0.5}
                  max={8}
                  step={0.5}
                  suffix="s"
                  onChange={(value) => setVideo({ repeatGapSeconds: value })}
                />
              )}
            </Field>
            <Field label="Pause between lines">
              <Slider
                value={v.gapBetweenLines}
                min={0}
                max={3}
                step={0.1}
                suffix="s"
                onChange={(value) => setVideo({ gapBetweenLines: value })}
              />
            </Field>
            <Field label="Quality">
              <Segmented
                value={v.resolution}
                options={(Object.keys(RESOLUTIONS) as ResolutionId[]).map((id) => [id, RESOLUTIONS[id].label])}
                onChange={(value) => setVideo({ resolution: value as ResolutionId })}
              />
              <p className="text-xs text-paper/45 mt-1">{RESOLUTIONS[v.resolution].blurb}</p>
            </Field>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Toggle checked={v.showTransliteration} onChange={(on) => setVideo({ showTransliteration: on })}>
              Show pronunciation
            </Toggle>
            <Toggle checked={v.karaoke} onChange={(on) => setVideo({ karaoke: on })}>
              Highlight words as you speak
            </Toggle>
            <Toggle checked={v.intro} onChange={(on) => setVideo({ intro: on })}>
              Title card
            </Toggle>
            <Toggle checked={v.outro} onChange={(on) => setVideo({ outro: on })}>
              Closing card
            </Toggle>
          </div>
        </section>

        <section className="card p-5 space-y-4">
          <h2 className="text-lg font-bold">Videos to make</h2>
          <div className="flex flex-wrap gap-2">
            {choices.map((langs) => {
              const key = outputKey(langs);
              const on = chosen.has(key);
              const label =
                langs.length > 1
                  ? `${langs.map((id) => findAudienceLanguage(id)?.label ?? id).join(" + ")} together`
                  : `${findAudienceLanguage(langs[0])?.label ?? langs[0]} video`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleOutput(langs)}
                  className={`px-3.5 py-2 rounded-xl text-sm border cursor-pointer transition-colors ${
                    on ? "bg-brand-green/20 border-brand-green text-white" : "border-white/15 text-paper/50 hover:bg-white/5"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {label}
                </button>
              );
            })}
          </div>

          {ffmpeg === false && (
            <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              ffmpeg is not installed, so the MP4 cannot be assembled. Windows: <code>winget install Gyan.FFmpeg</code> ·
              macOS: <code>brew install ffmpeg</code> — then restart the app.
            </p>
          )}

          {job ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 size={15} className="animate-spin" />
                  Making the {job.label} video{job.count > 1 ? ` (${job.index + 1} of ${job.count})` : ""}…
                </span>
                <button type="button" className="btn btn-ghost !py-1" onClick={() => abortRef.current?.abort()}>
                  <X size={14} /> Cancel
                </button>
              </div>
              <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-brand-blue to-brand-green transition-[width]"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary w-full py-3 text-base"
              onClick={makeVideos}
              disabled={!audio || !lines.length || !v.outputs.length || ffmpeg === false}
            >
              <Clapperboard size={18} />
              Make {v.outputs.length} video{v.outputs.length === 1 ? "" : "s"}
              {totalSeconds ? ` · ${formatTime(totalSeconds, 0)} each` : ""}
            </button>
          )}
          {error && (
            <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
          )}
        </section>

        {project.renders.length > 0 && (
          <section className="card p-5 space-y-3">
            <h2 className="text-lg font-bold">Your videos</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {project.renders.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  stale={video.fingerprint !== fingerprint(project, video.languages)}
                  caption={video.languages.map((id) => project.captions[id] || "").filter(Boolean).join("\n\n")}
                  onDownload={() => downloadBlob(video.blob, fileName(video))}
                  onDelete={() => update((p) => ({ renders: p.renders.filter((r) => r.id !== video.id) }))}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="order-1 lg:order-2 lg:sticky lg:top-24 self-start space-y-3">
        <div className="card p-3 space-y-3">
          <div className="flex gap-1 flex-wrap">
            {choices.map((langs) => (
              <button
                key={outputKey(langs)}
                type="button"
                onClick={() => setPreviewLangs(langs)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                  outputKey(langs) === outputKey(previewLangs) ? "bg-white/15 text-white" : "text-paper/50 hover:bg-white/5"
                }`}
              >
                {langs.map((id) => findAudienceLanguage(id)?.label ?? id).join(" + ")}
              </button>
            ))}
          </div>
          <div className="relative rounded-xl overflow-hidden bg-black aspect-[9/16] max-w-[320px] mx-auto">
            <canvas ref={canvasRef} className="w-full h-full block" />
            {!lines.length && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-paper/50 p-6 text-center">
                Nothing to show yet — the lesson needs at least one line.
              </div>
            )}
          </div>
          <button type="button" className="btn btn-ghost w-full" onClick={togglePreview} disabled={!prepared}>
            {previewTime !== null ? <Square size={14} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            {previewTime !== null
              ? `Stop · ${formatTime(previewTime, 0)} / ${formatTime(totalSeconds, 0)}`
              : "Play preview with sound"}
          </button>
        </div>
      </aside>
    </div>
  );
}

function VideoCard({
  video,
  stale,
  caption,
  onDownload,
  onDelete,
}: {
  video: RenderedVideo;
  stale: boolean;
  caption: string;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(video.blob), [video.blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [copied, setCopied] = useState(false);
  const label = video.languages.map((id) => findAudienceLanguage(id)?.label ?? id).join(" + ");

  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">{label}</span>
        <span className="text-xs text-paper/50">
          {formatTime(video.durationSeconds, 0)} · {formatBytes(video.blob.size)}
        </span>
      </div>
      <video src={url} controls playsInline className="w-full rounded-lg aspect-[9/16] bg-black" />
      {stale && <p className="text-xs text-kurd-sun">Made before your latest edits — make it again to include them.</p>}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary flex-1" onClick={onDownload}>
          <Download size={15} /> MP4
        </button>
        {caption && (
          <button
            type="button"
            className="btn btn-ghost"
            title="Copy the post caption"
            onClick={() => {
              void navigator.clipboard.writeText(caption);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          title="Delete this video"
          onClick={() => window.confirm("Delete this video?") && onDelete()}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg bg-black/30 border border-white/10 p-0.5">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex-1 px-2 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
            value === id ? "bg-brand-blue/30 text-white" : "text-paper/55 hover:text-white"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[#33afd5]"
      />
      <span className="text-sm font-mono w-12 text-right">
        {value.toFixed(1)}
        {suffix}
      </span>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-[#8bb942]"
      />
      <span className="text-paper/85">{children}</span>
    </label>
  );
}
