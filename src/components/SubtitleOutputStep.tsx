/**
 * Last step of a video project: your uploaded video, with the Kurdish and its
 * translation burned in as subtitles — one MP4 per chosen output.
 *
 * The preview is the real video with the subtitles drawn over it on a canvas,
 * by the same code that draws the PNGs ffmpeg burns in (render/subtitles), so
 * what you see here is what the MP4 shows. The 9:16 framing is mimicked with
 * CSS: object-fit contain over a blurred copy, or object-fit cover.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clapperboard, Loader2, Pause, Play, X } from "lucide-react";
import type { Project, RenderedVideo, VideoSettings } from "../types";
import type { AudioSources } from "../audio/clipBuilder";
import type { AppSettings } from "../utils/settings";
import { RESOLUTIONS, type ResolutionId } from "../render/renderLesson";
import { cueIndexAt, cuePng, overlayPng, prepareSubtitles, type PreparedSubtitles } from "../render/subtitles";
import { loadRecordingAudio } from "../audio/useRecordingAudio";
import { encodeWavMono, formatTime } from "../audio/audioTools";
import { softLimit } from "../audio/clipBuilder";
import { mainKey, recallProcessed } from "../audio/processing";
import { fingerprint, outputKey } from "../lessonActions";
import { newId } from "../utils/projectStore";
import { downloadBlob } from "../utils/download";
import { useObjectUrl } from "../utils/useObjectUrl";
import { renderSubtitledVideo } from "../utils/mediaApi";
import { ErrorNote, Field, Segmented, Toggle, VideoCard, languagesLabel } from "./ui";
import { outputChoices, videoFileName } from "./OutputStep";

export interface SubtitleOutputStepProps {
  project: Project;
  sources: AudioSources;
  settings: AppSettings;
  ffmpeg: boolean | null;
  logoSrc: string;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
}

const PREVIEW_WIDTH = 540;

/**
 * The cleaned-up file that matches the project's current sound settings, or
 * undefined. One made with an earlier preset is still stored until the new
 * one lands, and must not be burned in under the new preset's name.
 */
function currentCleanup(project: Project): Blob | undefined {
  const key = mainKey(project);
  if (!key || !project.recording) return undefined;
  if (project.processed?.key === key) return project.processed.blob;
  // Made this session but not (yet) stored in the project: the same file the
  // lines are playing from, so it is just as good.
  return recallProcessed(project.recording.blob, key);
}

/**
 * The cleaned-up sound for the MP4, or null to keep the video's own.
 *
 * Levelled with the same gain and soft limit the line playback uses, so the
 * video sounds like what you heard while proofing. The camera's own track is
 * kept when the preset is "raw", or when the clean-up is not ready yet.
 */
async function cleanedSound(project: Project): Promise<Blob | null> {
  const cleaned = currentCleanup(project);
  if (!cleaned) return null;
  const audio = await loadRecordingAudio(cleaned);
  const out = new Float32Array(audio.mono.length);
  for (let i = 0; i < out.length; i++) out[i] = softLimit(audio.mono[i] * audio.gain);
  return encodeWavMono(out, audio.buffer.sampleRate);
}

export default function SubtitleOutputStep({ project, ffmpeg, logoSrc, update }: SubtitleOutputStepProps) {
  const v = project.video;
  const source = project.sourceVideo;
  const setVideo = (patch: Partial<VideoSettings>) => update((p) => ({ video: { ...p.video, ...patch } }));

  const choices = useMemo(() => outputChoices(project.audiences), [project.audiences]);
  const chosen = new Set(v.outputs.map(outputKey));
  const toggleOutput = (langs: string[]) => {
    const key = outputKey(langs);
    const next = chosen.has(key) ? v.outputs.filter((o) => outputKey(o) !== key) : [...v.outputs, langs];
    setVideo({ outputs: next });
  };

  const [current, setCurrent] = useState<string[]>(() => v.outputs[0] ?? [project.audiences[0]]);
  useEffect(() => {
    if (!current.every((id) => project.audiences.includes(id))) setCurrent([project.audiences[0]]);
  }, [project.audiences, current]);

  /* ---------- preview ---------- */

  const videoUrl = useObjectUrl(source?.blob);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLCanvasElement>(null);
  const preparedRef = useRef<PreparedSubtitles | null>(null);
  const drawnRef = useRef("");
  const scrubRef = useRef(0);
  const [cueCount, setCueCount] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [videoOk, setVideoOk] = useState(true);
  useEffect(() => setVideoOk(true), [videoUrl]);

  const duration = source?.durationSeconds || project.recording?.durationSeconds || 0;
  const upright = source && source.width && source.height ? Math.abs(source.width / source.height - 9 / 16) < 0.01 : false;
  const showBackdrop = v.videoFit === "blur" && !upright;

  const previewKey = JSON.stringify([current, v.showTransliteration, v.subtitlePosition, logoSrc, duration]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      const prepared = await prepareSubtitles(project.lines, {
        width: PREVIEW_WIDTH,
        languages: current,
        showTransliteration: v.showTransliteration,
        position: v.subtitlePosition,
        logoSrc,
        durationSeconds: duration,
      });
      if (!live) return;
      preparedRef.current = prepared;
      drawnRef.current = "";
      setCueCount(prepared.cues.length);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project.lines, previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // One loop for the life of the step: redraw the subtitle only when the cue
  // on screen changes, and keep the blurred backdrop in step with the picture.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      const playable = video && video.readyState >= 2;
      const t = playable ? video.currentTime : scrubRef.current;

      const subs = preparedRef.current;
      const canvas = overlayRef.current;
      if (subs && canvas) {
        const index = cueIndexAt(subs.cues, t);
        const key = `${subs.cues.length}:${subs.width}:${index}`;
        if (drawnRef.current !== key || canvas.width !== subs.width) {
          if (canvas.width !== subs.width) canvas.width = subs.width;
          if (canvas.height !== subs.height) canvas.height = subs.height;
          const ctx = canvas.getContext("2d")!;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          subs.drawOverlay(ctx);
          if (index >= 0) subs.drawCue(ctx, index);
          drawnRef.current = key;
        }
      }

      const backdrop = backdropRef.current;
      if (backdrop && video && playable && video.videoWidth) {
        const ctx = backdrop.getContext("2d")!;
        const scale = Math.max(backdrop.width / video.videoWidth, backdrop.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, (backdrop.width - w) / 2, (backdrop.height - h) / 2, w, h);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoOk) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, [videoOk]);

  const seek = (t: number) => {
    scrubRef.current = t;
    setTime(t);
    if (videoRef.current && videoOk) videoRef.current.currentTime = t;
  };

  /* ---------- rendering ---------- */

  const [job, setJob] = useState<{ label: string; step: string; progress: number; index: number; count: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const outputs = v.outputs.filter((o) => o.every((id) => project.audiences.includes(id)));
  const usingCleanSound = Boolean(currentCleanup(project));

  const makeVideos = async () => {
    if (!source || !outputs.length) return;
    videoRef.current?.pause();
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const projectId = project.id;
    const snapshot = project;
    const cancelled = () => {
      if (signal.aborted) throw new DOMException("The render was cancelled.", "AbortError");
    };

    try {
      setJob({ label: languagesLabel(outputs[0]), step: "Preparing the sound…", progress: 0, index: 0, count: outputs.length });
      const sound = await cleanedSound(snapshot);
      cancelled();

      for (let i = 0; i < outputs.length; i++) {
        const langs = outputs[i];
        const label = languagesLabel(langs);
        const report = (step: string, progress: number) =>
          setJob({ label, step, progress, index: i, count: outputs.length });

        report("Drawing the subtitles…", 0);
        const subs = await prepareSubtitles(snapshot.lines, {
          width: RESOLUTIONS[v.resolution].width,
          languages: langs,
          showTransliteration: v.showTransliteration,
          position: v.subtitlePosition,
          logoSrc,
          durationSeconds: duration,
        });
        const cues: { png: Blob; start: number; end: number }[] = [];
        for (let c = 0; c < subs.cues.length; c++) {
          cancelled();
          cues.push({ png: await cuePng(subs, c), start: subs.cues[c].start, end: subs.cues[c].end });
          if (c % 4 === 0) report("Drawing the subtitles…", (c / subs.cues.length) * 0.1);
        }
        const logo = await overlayPng(subs);
        cancelled();

        const blob = await renderSubtitledVideo(
          {
            video: source.blob,
            videoName: source.fileName || "video.mp4",
            cues,
            cueRect: { x: subs.band.x, y: subs.band.y },
            overlay: logo && subs.overlay ? { png: logo, x: subs.overlay.x, y: subs.overlay.y } : null,
            audio: sound,
            width: subs.width,
            height: subs.height,
            fit: v.videoFit,
          },
          {
            signal,
            onProgress: (p) =>
              p.stage === "upload"
                ? report("Sending it to ffmpeg…", 0.1 + p.fraction * 0.15)
                : report("Burning in the subtitles…", 0.25 + p.fraction * 0.75),
          }
        );

        const video: RenderedVideo = {
          id: newId("v"),
          languages: langs,
          blob,
          createdAt: Date.now(),
          durationSeconds: duration,
          fingerprint: fingerprint(snapshot, langs),
        };
        // Saved as each one lands, so a failure later keeps the earlier ones.
        update((p) =>
          p.id !== projectId
            ? {}
            : { renders: [video, ...p.renders.filter((r) => outputKey(r.languages) !== outputKey(langs))] }
        );
      }
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setJob(null);
    }
  };

  const fitClass = v.videoFit === "crop" ? "object-cover" : "object-contain";

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
          <h2 className="text-lg font-bold">Subtitles</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Where they sit">
              <Segmented
                value={v.subtitlePosition}
                options={[
                  ["lower", "Low, above the captions"],
                  ["middle", "Middle"],
                ]}
                onChange={(value) => setVideo({ subtitlePosition: value as VideoSettings["subtitlePosition"] })}
              />
            </Field>
            <Field label="A video that isn't 9:16">
              <Segmented
                value={v.videoFit}
                options={[
                  ["blur", "Fit, blurred behind"],
                  ["crop", "Crop to fill"],
                ]}
                onChange={(value) => setVideo({ videoFit: value as VideoSettings["videoFit"] })}
              />
              {upright && <p className="text-xs text-paper/45 mt-1">Your video is already 9:16 — it fills the frame either way.</p>}
            </Field>
            <Field label="Quality">
              <Segmented
                value={v.resolution}
                options={(Object.keys(RESOLUTIONS) as ResolutionId[]).map((id) => [id, RESOLUTIONS[id].label])}
                onChange={(value) => setVideo({ resolution: value as ResolutionId })}
              />
              <p className="text-xs text-paper/45 mt-1">{RESOLUTIONS[v.resolution].blurb}</p>
            </Field>
            <Field label="Sound">
              <p className="text-sm text-paper/75">
                {usingCleanSound
                  ? "Your cleaned-up sound, in place of the video's own."
                  : project.audioFx.preset === "raw"
                    ? "The video's own sound, as recorded."
                    : "The video's own sound — the clean-up has not been applied yet (Transcript step)."}
              </p>
              {usingCleanSound && <p className="text-xs text-paper/45 mt-1">The preview plays the video's own sound.</p>}
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Toggle checked={v.showTransliteration} onChange={(on) => setVideo({ showTransliteration: on })}>
              Show pronunciation
            </Toggle>
          </div>
        </section>

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
                  {langs.length > 1 ? `${languagesLabel(langs)} together` : `${languagesLabel(langs)} subtitles`}
                </button>
              );
            })}
          </div>

          {ffmpeg === false && (
            <ErrorNote>
              ffmpeg is not installed, so the video cannot be subtitled. Windows: winget install Gyan.FFmpeg · macOS: brew
              install ffmpeg — then restart the app.
            </ErrorNote>
          )}
          {!source && <ErrorNote>The uploaded video is missing from this project. Upload it again in step 1.</ErrorNote>}
          {cueCount === 0 && (
            <p className="text-xs text-kurd-sun">No line has a time in the video yet, so there is nothing to subtitle.</p>
          )}

          {job ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <Loader2 size={15} className="animate-spin shrink-0" />
                  <span className="truncate">
                    {job.label}
                    {job.count > 1 ? ` (${job.index + 1} of ${job.count})` : ""} · {job.step}
                  </span>
                </span>
                <button type="button" className="btn btn-ghost !py-1 shrink-0" onClick={() => abortRef.current?.abort()}>
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
              disabled={!source || !outputs.length || !cueCount || ffmpeg === false}
            >
              <Clapperboard size={18} />
              Make {outputs.length} video{outputs.length === 1 ? "" : "s"}
              {duration ? ` · ${formatTime(duration, 0)} each` : ""}
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

          <div
            className="relative rounded-xl overflow-hidden bg-black aspect-[9/16] max-w-[320px] mx-auto cursor-pointer select-none"
            onClick={togglePlay}
          >
            {showBackdrop && videoOk && (
              <canvas
                ref={backdropRef}
                width={54}
                height={96}
                className="absolute inset-0 w-full h-full"
                style={{ filter: "blur(10px) brightness(0.5)", transform: "scale(1.2)" }}
              />
            )}
            {videoUrl && (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="auto"
                className={`absolute inset-0 w-full h-full ${fitClass} ${videoOk ? "" : "hidden"}`}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                onError={() => setVideoOk(false)}
              />
            )}
            <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
            {!videoOk && (
              <div className="absolute inset-x-0 top-1/3 text-center text-xs text-paper/50 px-6">
                This browser can't play the video's format — drag the slider to check the subtitles.
              </div>
            )}
            {!playing && videoOk && videoUrl && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="w-14 h-14 rounded-full bg-black/45 flex items-center justify-center">
                  <Play size={26} fill="white" />
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="icon-btn shrink-0"
              onClick={togglePlay}
              disabled={!videoOk || !videoUrl}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={Math.min(time, duration)}
              onChange={(e) => seek(Number(e.target.value))}
              className="flex-1 accent-[#33afd5]"
              aria-label="Position in the video"
            />
            <span className="text-xs font-mono text-paper/60 w-20 text-right">
              {formatTime(time, 0)} / {formatTime(duration, 0)}
            </span>
          </div>
          {cueCount !== null && (
            <p className="text-xs text-paper/45 text-center">
              {cueCount} subtitle{cueCount === 1 ? "" : "s"} · each stays up until the next line, or a moment after a pause
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
