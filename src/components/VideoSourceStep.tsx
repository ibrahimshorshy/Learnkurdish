/**
 * Step 1 of a video project: upload a video of yourself speaking Kurdish. Its
 * sound is pulled out on the server and becomes the recording every later
 * step uses — the transcript, the translations and the line timings all come
 * from it, and the subtitles are timed against it.
 */

import { useEffect, useRef, useState } from "react";
import { Film, Info, Loader2, RotateCcw, Upload, Wand2, X, AlertTriangle } from "lucide-react";
import type { Project } from "../types";
import type { AppSettings } from "../utils/settings";
import type { LessonAudio } from "../audio/useRecordingAudio";
import { loadRecordingAudio } from "../audio/useRecordingAudio";
import { formatTime } from "../audio/audioTools";
import { findTextModel } from "../config/models";
import { useObjectUrl } from "../utils/useObjectUrl";
import { formatBytes, freshRecordingPatch } from "../utils/projectStore";
import { extractVideoAudio, readVideoMeta } from "../utils/mediaApi";

export interface VideoSourceStepProps {
  project: Project;
  settings: AppSettings;
  audio: LessonAudio;
  busy: boolean;
  update: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void;
  onTranscribe: () => void;
}

const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.m4v,.mov,.webm,.mkv";
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

/** Past this the transcription takes noticeably longer, so it is said up front. */
const LONG_VIDEO = 3 * 60;
/** Past this a single pass gets less reliable; splitting the video is the honest advice. */
const VERY_LONG_VIDEO = 12 * 60;

const HOW = [
  "Upload a video of you speaking Kurdish Sorani — straight from your phone is fine.",
  "The app takes the sound out of it, and the AI writes down what you said, line by line, with the time of each line.",
  "Fix anything it misheard, add a note if you want, and it translates every line into Arabic and English.",
  "Proof the translations, then approve.",
  "You get your own video back as a 9:16 reel, with the Kurdish and its meaning burned in as subtitles.",
];

function extensionOf(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || extensionOf(file.name) in MIME_BY_EXT;
}

export default function VideoSourceStep({ project, settings, audio, busy, update, onTranscribe }: VideoSourceStepProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [job, setJob] = useState<{ label: string; fraction: number | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playable, setPlayable] = useState(true);

  const source = project.sourceVideo;
  const url = useObjectUrl(source?.blob);
  const hasWork = project.lines.length > 0;

  useEffect(() => setPlayable(true), [url]);
  // Leaving the step (or the tab) stops an upload in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  const accept = async (file: File) => {
    setProblem(null);
    if (!isVideoFile(file)) {
      setProblem("That doesn't look like a video. Upload an MP4, MOV, WebM or MKV file.");
      return;
    }
    if (hasWork && !window.confirm("Replace this video? Its transcript, translations and subtitled videos will be cleared.")) {
      return;
    }

    // The result must land on the project it was uploaded for, even if
    // another one has been opened by the time the server answers.
    const projectId = project.id;
    const controller = new AbortController();
    abortRef.current = controller;
    setJob({ label: "Uploading the video…", fraction: 0 });
    try {
      // A Blob of the file with its type always set: some browsers leave
      // File.type empty for .mkv, and the player needs it.
      const mimeType = file.type || MIME_BY_EXT[extensionOf(file.name)] || "video/mp4";
      const blob = file.slice(0, file.size, mimeType);

      const [extracted, meta] = await Promise.all([
        extractVideoAudio(blob, file.name, {
          signal: controller.signal,
          onProgress: (p) =>
            setJob(
              p.stage === "upload"
                ? { label: "Uploading the video…", fraction: p.fraction }
                : { label: "Taking the sound out of the video…", fraction: null }
            ),
        }),
        readVideoMeta(blob),
      ]);
      setJob({ label: "Listening for the pauses…", fraction: null });
      const decoded = await loadRecordingAudio(extracted.wav);
      if (decoded.buffer.duration < 0.5) throw new Error("This video is too short to use.");
      if (controller.signal.aborted) return;

      update((p) =>
        p.id !== projectId
          ? {}
          : {
              sourceVideo: {
                blob,
                mimeType,
                durationSeconds: extracted.durationSeconds || meta?.durationSeconds || decoded.buffer.duration,
                width: extracted.width || meta?.width || 0,
                height: extracted.height || meta?.height || 0,
                fileName: file.name,
              },
              ...freshRecordingPatch({
                blob: extracted.wav,
                mimeType: "audio/wav",
                durationSeconds: decoded.buffer.duration,
                fileName: file.name,
              }),
            }
      );
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setJob(null);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void accept(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !job) void accept(file);
  };

  const model = findTextModel(settings.transcribeModel);
  const duration = source?.durationSeconds ?? project.recording?.durationSeconds ?? 0;
  const raw = audio.raw;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
      <section
        className={`card p-6 flex flex-col gap-4 transition-colors ${dragging ? "!border-brand-blue bg-brand-blue/10" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!job) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onFile} />

        {source && url ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-bold">Your video</h2>
                <p className="text-sm text-paper/60 mt-1 truncate" title={source.fileName}>
                  {source.fileName || "Uploaded video"}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost shrink-0"
                onClick={() => fileRef.current?.click()}
                disabled={Boolean(job) || busy}
              >
                <Upload size={15} /> Replace
              </button>
            </div>
            <div className="rounded-xl overflow-hidden bg-black flex justify-center">
              <video
                key={url}
                src={url}
                controls
                playsInline
                preload="metadata"
                className="max-h-[60vh] max-w-full"
                onError={() => setPlayable(false)}
              />
            </div>
            {!playable && (
              <p className="text-xs text-kurd-sun flex items-start gap-1.5">
                <AlertTriangle size={14} className="shrink-0 mt-px" />
                This browser can't play this video's format, but the app can still take its sound, transcribe it and
                subtitle it. The preview in the last step will show the subtitles without the picture.
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper/55">
              <span className="font-mono">{formatTime(duration)}</span>
              {source.width > 0 && source.height > 0 && (
                <span>
                  {source.width}×{source.height}
                  {source.width / source.height > 0.6 ? " · will be fitted into a 9:16 frame" : ""}
                </span>
              )}
              <span>{formatBytes(source.blob.size)}</span>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={Boolean(job)}
            className="flex-1 min-h-[300px] rounded-2xl border-2 border-dashed border-white/15 hover:border-brand-blue/70 hover:bg-white/[0.03] transition-colors flex flex-col items-center justify-center gap-4 p-6 text-center cursor-pointer disabled:cursor-wait"
          >
            <span className="w-24 h-24 rounded-full bg-gradient-to-br from-brand-blue to-brand-green flex items-center justify-center">
              <Film size={44} />
            </span>
            <span>
              <span className="block text-xl font-bold">Upload your video</span>
              <span className="block text-sm text-paper/60 mt-1">
                Drop it here, or click to choose · MP4, MOV, WebM or MKV
              </span>
            </span>
          </button>
        )}

        {job && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 size={15} className="animate-spin" /> {job.label}
              </span>
              <button type="button" className="btn btn-ghost !py-1" onClick={() => abortRef.current?.abort()}>
                <X size={14} /> Cancel
              </button>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              {job.fraction === null ? (
                <div className="h-full w-1/3 bg-gradient-to-r from-brand-blue to-brand-green animate-pulse" />
              ) : (
                <div
                  className="h-full bg-gradient-to-r from-brand-blue to-brand-green transition-[width]"
                  style={{ width: `${Math.round(job.fraction * 100)}%` }}
                />
              )}
            </div>
          </div>
        )}

        {(problem || audio.error) && (
          <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {problem || audio.error}
          </p>
        )}
      </section>

      <section className="card p-6 flex flex-col gap-5">
        {source && project.recording ? (
          <>
            <div>
              <p className="label">The sound</p>
              <p className="text-sm text-paper/70 mt-2">
                {raw
                  ? raw.analysis.segments.length > 1
                    ? `Heard speech with ${countPauses(raw)} clear pauses — good for finding where each line starts.`
                    : "Could not find clear pauses. That's fine — you can adjust the line timings by hand after transcribing."
                  : "Reading the sound…"}
              </p>
              {duration > LONG_VIDEO && (
                <p className="text-xs text-kurd-sun mt-2 flex items-start gap-1.5">
                  <AlertTriangle size={14} className="shrink-0 mt-px" />
                  {duration > VERY_LONG_VIDEO
                    ? `This video is ${Math.round(duration / 60)} minutes long. Transcribing it takes a while and is less reliable in one go — if it fails or drifts, split the video into parts of a few minutes each.`
                    : `This video is ${Math.round(duration / 60)} minutes long, so transcribing it takes longer than a short clip — give it a minute or two.`}
                </p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="video-context">
                What is it about? <span className="normal-case font-normal tracking-normal">(optional)</span>
              </label>
              <input
                id="video-context"
                className="field mt-2"
                placeholder="e.g. Ordering at a café in Erbil — names: Rêbwar, Shilan"
                value={project.context}
                onChange={(e) => update({ context: e.target.value })}
              />
              <p className="text-xs text-paper/45 mt-1.5">
                Helps the AI spell names and topic words. It never adds words you did not say.
              </p>
            </div>

            <div className="mt-auto space-y-2">
              <button
                type="button"
                className="btn btn-primary w-full py-3 text-base"
                onClick={() => {
                  if (
                    hasWork &&
                    !window.confirm("Transcribe again? The current lines and their translations will be replaced.")
                  )
                    return;
                  onTranscribe();
                }}
                disabled={busy || !raw || Boolean(job)}
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : hasWork ? <RotateCcw size={18} /> : <Wand2 size={18} />}
                {busy ? "Listening to your Kurdish…" : hasWork ? "Transcribe again" : "Transcribe line by line"}
              </button>
              <p className="text-xs text-paper/45 text-center">
                {model?.label ?? settings.transcribeModel} · change in Settings
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-4 text-sm text-paper/70">
            <p className="label flex items-center gap-1.5">
              <Info size={13} /> How it works
            </p>
            <ol className="space-y-3 list-decimal list-inside marker:text-brand-blue">
              {HOW.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
            <p className="text-xs text-paper/45">
              The sound is always your own voice from the video. Nothing is synthesized — AI voices mispronounce Kurdish.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function countPauses(audio: NonNullable<LessonAudio["raw"]>): number {
  const segs = audio.analysis.segments;
  let n = 0;
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i + 1].start - segs[i].end >= 0.35) n++;
  return n;
}
