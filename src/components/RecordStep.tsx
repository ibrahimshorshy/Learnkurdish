import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Pause, Play, Square, Upload, Wand2, RotateCcw, Loader2, Info } from "lucide-react";
import type { Project } from "../types";
import type { AppSettings } from "../utils/settings";
import type { RecordingAudio } from "../audio/useRecordingAudio";
import { useRecorder } from "../audio/useRecorder";
import { decodeAudio, formatTime } from "../audio/audioTools";
import { findTextModel } from "../config/models";

interface Props {
  project: Project;
  settings: AppSettings;
  audio: RecordingAudio | null;
  audioError: string | null;
  busy: boolean;
  update: (patch: Partial<Project>) => void;
  onTranscribe: () => void;
}

export default function RecordStep({ project, settings, audio, audioError, busy, update, onTranscribe }: Props) {
  const recorder = useRecorder({ noiseSuppression: settings.noiseSuppression });
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const recording = project.recording;
  const url = useMemo(() => (recording ? URL.createObjectURL(recording.blob) : null), [recording]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const hasWork = project.lines.length > 0;

  /** Stores a new recording, after checking it decodes. */
  const accept = async (blob: Blob, fileName?: string) => {
    setSaving(true);
    setProblem(null);
    try {
      const decoded = await decodeAudio(blob);
      if (decoded.duration < 0.5) throw new Error("That recording is too short to use.");
      update({
        recording: {
          blob,
          mimeType: blob.type || "audio/webm",
          durationSeconds: decoded.duration,
          fileName,
        },
        lines: [],
        titles: {},
        captions: {},
        renders: [],
        approvedAt: undefined,
        timesSource: undefined,
        step: "record",
      });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmReplace = () =>
    !hasWork ||
    window.confirm("Replace this recording? Its transcript, translations and videos will be cleared.");

  const startRecording = () => {
    if (recording && !confirmReplace()) return;
    void recorder.start();
  };

  const stopRecording = async () => {
    const blob = await recorder.stop();
    await accept(blob);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (recording && !confirmReplace()) return;
    void accept(file, file.name);
  };

  const live = recorder.state !== "idle";
  const model = findTextModel(settings.transcribeModel);

  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
      <section className="card p-6 flex flex-col items-center text-center gap-5">
        <div>
          <h2 className="text-xl font-bold">Record your Kurdish</h2>
          <p className="text-sm text-paper/60 mt-1">
            Say each sentence clearly, then pause for about a second before the next one.
          </p>
        </div>

        <button
          type="button"
          onClick={live ? stopRecording : startRecording}
          disabled={saving}
          className={`relative w-36 h-36 rounded-full flex items-center justify-center transition-all cursor-pointer ${
            live ? "bg-kurd-red recording-pulse" : "bg-gradient-to-br from-brand-blue to-brand-green hover:scale-105"
          }`}
          aria-label={live ? "Stop recording" : "Start recording"}
        >
          {live ? <Square size={44} fill="white" /> : <Mic size={54} />}
        </button>

        <div className="h-16 flex flex-col items-center justify-center gap-2 w-full max-w-xs">
          {live ? (
            <>
              <div className="font-mono text-2xl tabular-nums">
                {formatTime(recorder.elapsed, 0)}
                {recorder.state === "paused" && <span className="ml-2 text-sm text-kurd-sun">paused</span>}
              </div>
              <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-brand-green via-kurd-sun to-kurd-red transition-[width] duration-75"
                  style={{ width: `${Math.min(100, recorder.level * 140)}%` }}
                />
              </div>
            </>
          ) : saving ? (
            <span className="text-sm text-paper/70 flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Reading the recording…
            </span>
          ) : (
            <span className="text-sm text-paper/50">{recording ? "Tap to record again" : "Tap to start"}</span>
          )}
        </div>

        {live && (
          <div className="flex gap-2">
            {recorder.state === "recording" ? (
              <button type="button" className="btn btn-ghost" onClick={recorder.pause}>
                <Pause size={16} /> Pause
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={recorder.resume}>
                <Play size={16} /> Resume
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={stopRecording}>
              <Square size={14} /> Done
            </button>
          </div>
        )}

        {!live && (
          <div className="flex items-center gap-3 text-sm text-paper/50">
            <span className="h-px w-10 bg-white/10" /> or <span className="h-px w-10 bg-white/10" />
          </div>
        )}
        {!live && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.ogg,.webm"
              className="hidden"
              onChange={onFile}
            />
            <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={saving}>
              <Upload size={16} /> Upload an audio file
            </button>
          </>
        )}

        {(recorder.error || problem || audioError) && (
          <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {recorder.error || problem || audioError}
          </p>
        )}
      </section>

      <section className="card p-6 flex flex-col gap-5">
        {recording && url ? (
          <>
            <div>
              <p className="label">Your recording</p>
              <div className="mt-2 flex items-center justify-between text-sm text-paper/70">
                <span className="truncate">{recording.fileName || "Recorded in the app"}</span>
                <span className="font-mono">{formatTime(recording.durationSeconds)}</span>
              </div>
              <audio controls src={url} className="w-full mt-3" />
              {audio && (
                <p className="text-xs text-paper/50 mt-2">
                  {audio.analysis.segments.length > 1
                    ? `Heard speech with ${countPauses(audio)} clear pauses — good for finding where each line starts.`
                    : "Could not find clear pauses. That's fine — you can adjust the line timings by hand after transcribing."}
                </p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="context">
                What is it about? <span className="normal-case font-normal tracking-normal">(optional)</span>
              </label>
              <input
                id="context"
                className="field mt-2"
                placeholder="e.g. Greetings at a family visit — names: Rêbwar, Shilan"
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
                disabled={busy || !audio}
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
              <li>Record the sentences for one lesson in Kurdish Sorani — five to twenty is a good size.</li>
              <li>The AI writes down what you said, one line per sentence, and finds each line in your recording.</li>
              <li>Add a note if you want — what to focus on — then it translates every line into Arabic and English.</li>
              <li>You proof everything. Nothing goes into a video until you approve it.</li>
              <li>Get one MP4 per language: your voice, the Kurdish, how to say it, and what it means.</li>
            </ol>
            <p className="text-xs text-paper/45">
              Your voice is the audio. Nothing in the video is synthesized — AI voices mispronounce Kurdish.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function countPauses(audio: RecordingAudio): number {
  const segs = audio.analysis.segments;
  let n = 0;
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i + 1].start - segs[i].end >= 0.35) n++;
  return n;
}
