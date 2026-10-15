import { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Loader2, Play, Square, AlertTriangle, X } from "lucide-react";
import type { Project, RenderedVideo, VideoSettings } from "../types";
import type { AudioSources } from "../audio/clipBuilder";
import type { AppSettings } from "../utils/settings";
import { THEMES, THEME_ORDER, themeFor } from "../render/themes";
import {
  RESOLUTIONS,
  drawStill,
  renderVideo,
  startPreview,
  stillMoment,
  type LessonLook,
  type PreparedLesson,
  type PreviewHandle,
  type ResolutionId,
} from "../render/renderLesson";
import { prepareOutput } from "../render/kinds";
import { loadCardsInput } from "../render/cards";
import { fingerprint, outputKey, videoLinesFrom } from "../lessonActions";
import { newId } from "../utils/projectStore";
import { asciiFileName, downloadBlob } from "../utils/download";
import { formatTime, stopPlayback } from "../audio/audioTools";
import { ErrorNote, Field, Segmented, Slider, Toggle, VideoCard, languagesLabel } from "./ui";
import IntroOutroPanel from "./IntroOutroPanel";

interface Props {
  project: Project;
  sources: AudioSources;
  settings: AppSettings;
  ffmpeg: boolean | null;
  logoSrc: string;
  /** The recording is still being cleaned up in the background. */
  processing?: boolean;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

const PREVIEW_WIDTH = 540;

/** Every video that can be made: one per language, plus all of them together. */
export function outputChoices(audiences: string[]): string[][] {
  const single = audiences.map((id) => [id]);
  return audiences.length > 1 ? [...single, [...audiences]] : single;
}

export function videoFileName(project: Project, languages: string[]): string {
  const base = asciiFileName(project.titles.en || project.name || "", `kurdish-${project.kind}`)
    .replace(/\s+/g, "-")
    .toLowerCase();
  return `${base}-${languages.join("-")}.mp4`;
}

/**
 * The last step for lessons, dialogues and stories: pick the look, preview it
 * with sound, and make one MP4 per chosen output.
 */
export default function OutputStep({ project, sources, settings, ffmpeg, logoSrc, processing, update }: Props) {
  const v = project.video;
  const setVideo = (patch: Partial<VideoSettings>) => update((p) => ({ video: { ...p.video, ...patch } }));

  const choices = useMemo(() => outputChoices(project.audiences), [project.audiences]);
  const chosen = new Set(v.outputs.map(outputKey));
  const toggleOutput = (langs: string[]) => {
    const key = outputKey(langs);
    const next = chosen.has(key) ? v.outputs.filter((o) => outputKey(o) !== key) : [...v.outputs, langs];
    setVideo({ outputs: next });
  };

  // The output being previewed is also the one whose look is being edited.
  const [current, setCurrent] = useState<string[]>(() => v.outputs[0] ?? [project.audiences[0]]);
  useEffect(() => {
    if (!current.every((id) => project.audiences.includes(id))) setCurrent([project.audiences[0]]);
  }, [project.audiences, current]);
  const currentTheme = themeFor(v.themes, current);

  const lookFor = (languages: string[]): LessonLook => ({
    theme: themeFor(v.themes, languages),
    plays: v.plays,
    repeatGapMode: v.repeatGapMode,
    repeatGapSeconds: v.repeatGapSeconds,
    gapBetweenLines: v.gapBetweenLines,
    showTransliteration: v.showTransliteration,
    karaoke: v.karaoke,
    storyTranslation: v.storyTranslation,
  });

  const lines = useMemo(() => videoLinesFrom(project, sources), [project.lines, project.cuts, project.audioFx, sources]); // eslint-disable-line react-hooks/exhaustive-deps
  const missingAudio = project.lines.filter((l) => !l.skip && l.kurdish.trim()).length - lines.length;
  // Names as typed: the dialogue renderer labels an unnamed speaker in the
  // video's own language rather than with an English "Speaker 1".
  const speakers = project.speakers.map((sp) => sp.name.trim());

  /* ---------- preview ---------- */

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const [prepared, setPrepared] = useState<PreparedLesson | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);

  const previewKey = JSON.stringify([lookFor(current), current, project.titles, speakers, project.intro, project.outro]);
  useEffect(() => {
    if (!lines.length) return;
    let live = true;
    previewRef.current?.stop();
    previewRef.current = null;
    setPreviewTime(null);
    const timer = setTimeout(async () => {
      const cards = await loadCardsInput(project, current);
      const p = await prepareOutput(
        project.kind,
        { width: PREVIEW_WIDTH, lines, languages: current, titles: project.titles, look: lookFor(current), logoSrc, speakers },
        cards
      );
      if (!live) return;
      setPrepared(p);
      if (canvasRef.current) drawStill(p, canvasRef.current, stillMoment(p));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lines, previewKey, logoSrc]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!lines.length) return;
    previewRef.current?.stop();
    previewRef.current = null;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const outputs = v.outputs.filter((o) => o.every((id) => project.audiences.includes(id)));
    try {
      for (let i = 0; i < outputs.length; i++) {
        const langs = outputs[i];
        const label = languagesLabel(langs);
        setJob({ label, progress: 0, index: i, count: outputs.length });
        const cards = await loadCardsInput(project, langs);
        const lesson = await prepareOutput(
          project.kind,
          {
            width: RESOLUTIONS[v.resolution].width,
            lines,
            languages: langs,
            titles: project.titles,
            look: lookFor(langs),
            logoSrc,
            speakers,
          },
          cards
        );
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
        // Save each one as it lands, so a failure later keeps the earlier ones.
        update((p) => ({
          renders: [video, ...p.renders.filter((r) => outputKey(r.languages) !== outputKey(langs))],
        }));
      }
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    } finally {
      setJob(null);
      abortRef.current = null;
    }
  };

  const totalSeconds = prepared?.timeline.total ?? 0;
  const isLesson = project.kind === "lesson";

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5 order-2 lg:order-1">
        {!project.approvedAt && (
          <div className="card !border-kurd-sun/40 p-4 text-sm flex items-center gap-2">
            <AlertTriangle size={16} className="text-kurd-sun shrink-0" />
            The translations were edited after approval, or never approved. You can still make videos — check them first.
          </div>
        )}

        <section className="card p-5 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-bold">Look</h2>
            <span className="text-xs text-paper/55">
              Background for the <b className="text-paper/85">{languagesLabel(current)}</b> video — pick the video on the
              right to change another.
            </span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
            {THEME_ORDER.map((id) => {
              const theme = THEMES[id];
              const on = currentTheme === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setVideo({ themes: { ...v.themes, [outputKey(current)]: id } })}
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
            <Field label={project.kind === "story" ? "Pause between sentences" : "Pause between lines"}>
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
            {project.kind === "story" && (
              <Field label="Translation shown">
                <Segmented
                  value={v.storyTranslation}
                  options={[
                    ["sentence", "The sentence being read"],
                    ["paragraph", "The whole paragraph"],
                  ]}
                  onChange={(value) => setVideo({ storyTranslation: value as VideoSettings["storyTranslation"] })}
                />
              </Field>
            )}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Toggle checked={v.showTransliteration} onChange={(on) => setVideo({ showTransliteration: on })}>
              Show pronunciation
            </Toggle>
            <Toggle checked={v.karaoke} onChange={(on) => setVideo({ karaoke: on })}>
              Highlight words as you speak
            </Toggle>
          </div>
          {!isLesson && v.plays > 1 && (
            <p className="text-xs text-paper/45">
              Tip: {project.kind === "story" ? "stories" : "dialogues"} usually read best with each line played once.
            </p>
          )}
        </section>

        <IntroOutroPanel project={project} settings={settings} update={update} />

        <section className="card p-5 space-y-4">
          <h2 className="text-lg font-bold">Videos to make</h2>
          <div className="flex flex-wrap gap-2">
            {choices.map((langs) => {
              const key = outputKey(langs);
              const on = chosen.has(key);
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
                  {langs.length > 1 ? `${languagesLabel(langs)} together` : `${languagesLabel(langs)} video`}
                </button>
              );
            })}
          </div>

          {ffmpeg === false && (
            <ErrorNote>
              ffmpeg is not installed, so the MP4 cannot be assembled. Windows: winget install Gyan.FFmpeg · macOS: brew
              install ffmpeg — then restart the app.
            </ErrorNote>
          )}
          {processing && (
            <p className="text-xs text-kurd-sun">
              Still cleaning up your recording — a video made now uses it as recorded.
            </p>
          )}
          {missingAudio > 0 && (
            <p className="text-xs text-kurd-sun">
              {missingAudio} line{missingAudio === 1 ? " has" : "s have"} no audio loaded yet and will be left out.
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
              disabled={!lines.length || !v.outputs.length || ffmpeg === false}
            >
              <Clapperboard size={18} />
              Make {v.outputs.length} video{v.outputs.length === 1 ? "" : "s"}
              {totalSeconds ? ` · ${formatTime(totalSeconds, 0)} each` : ""}
            </button>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
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
                  onDownload={() => downloadBlob(video.blob, videoFileName(project, video.languages))}
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
                onClick={() => setCurrent(langs)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer ${
                  outputKey(langs) === outputKey(current) ? "bg-white/15 text-white" : "text-paper/50 hover:bg-white/5"
                }`}
              >
                {languagesLabel(langs)}
              </button>
            ))}
          </div>
          <div className="relative rounded-xl overflow-hidden bg-black aspect-[9/16] max-w-[320px] mx-auto">
            <canvas ref={canvasRef} className="w-full h-full block" />
            {!lines.length && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-paper/50 p-6 text-center">
                Nothing to show yet — the video needs at least one line with audio.
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
