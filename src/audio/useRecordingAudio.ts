import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioFxSettings, LessonLine, Project } from "../types";
import { analyzeSpeech, type SpeechAnalysis } from "../render/audioAlign";
import { audioContext, decodeAudio, levellingGain, stopPlayback, toMono } from "./audioTools";
import type { AudioSources } from "./clipBuilder";
import {
  ProcessingError,
  mainKey,
  needsProcessing,
  recallProcessed,
  rememberProcessed,
  requestProcessed,
  takeKey,
  type AudioProcessingStatus,
} from "./processing";

export interface RecordingAudio {
  buffer: AudioBuffer;
  mono: Float32Array;
  /** Where the speech and the pauses are. */
  analysis: SpeechAnalysis;
  /** Gain that levels the recording; applied to playback and to the video. */
  gain: number;
}

/** Decoding is the slow part, so each Blob is decoded once. */
const cache = new WeakMap<Blob, Promise<RecordingAudio>>();

export function loadRecordingAudio(blob: Blob): Promise<RecordingAudio> {
  let pending = cache.get(blob);
  if (!pending) {
    pending = decodeAudio(blob).then((buffer) => {
      const mono = toMono(buffer);
      return {
        buffer,
        mono,
        analysis: analyzeSpeech(mono, buffer.sampleRate),
        gain: levellingGain(mono),
      };
    });
    pending.catch(() => cache.delete(blob));
    cache.set(blob, pending);
  }
  return pending;
}

/**
 * Decodes `blob`, keeping track of which Blob the result belongs to, so that
 * for the render or two before a new decode lands the old audio is not passed
 * off as the new one.
 */
function useDecoded(blob: Blob | undefined): { audio: RecordingAudio | null; error: string | null } {
  const [state, setState] = useState<{ blob: Blob; audio: RecordingAudio | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    if (!blob) {
      setState(null);
      return;
    }
    loadRecordingAudio(blob)
      .then((audio) => live && setState({ blob, audio, error: null }))
      .catch((err) => live && setState({ blob, audio: null, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [blob]);
  if (!blob || !state || state.blob !== blob) return { audio: null, error: null };
  return { audio: state.audio, error: state.error };
}

/** Writes into the project with that id, whether or not it is still the open one. */
type WriteProject = (projectId: string, patch: Partial<Project> | ((p: Project) => Partial<Project>)) => unknown;

export interface LessonAudio {
  /** The main recording as recorded — what the waveform shows. */
  raw: RecordingAudio | null;
  /**
   * What the lines and the video use: the cleaned-up recording and takes when
   * they are ready for the current preset, else the raw ones. Never a version
   * made with other settings.
   */
  sources: AudioSources;
  error: string | null;
  /** The clean-up working in the background. */
  processing: AudioProcessingStatus;
  /** Whether `sources.main` is the cleaned-up recording (false with "raw", or while it is being made). */
  cleaned: boolean;
  /** Forgets failures and tries the clean-up again. */
  retryProcessing: () => void;
}

interface Job {
  /** Stable for the same source and settings, so a failure is not retried in a loop. */
  id: string;
  /** The project it is made for: the result is stored there, even if another one is open by then. */
  projectId: string;
  label: string;
  source: Blob;
  key: string;
  fx: Pick<AudioFxSettings, "preset" | "room">;
  takeId?: string;
}

/**
 * Every cleaned file the current settings call for, main recording first,
 * then the takes in line order. `stored` says whether the project already has
 * it.
 */
function wantedJobs(project: Project | null): (Job & { stored: boolean })[] {
  if (!project || !needsProcessing(project.audioFx)) return [];
  const fx = { preset: project.audioFx.preset, room: project.audioFx.room };
  const jobs: (Job & { stored: boolean })[] = [];
  const key = mainKey(project);
  if (key && project.recording) {
    jobs.push({
      id: `main|${key}`,
      projectId: project.id,
      label: project.kind === "video" ? "the video's sound" : "your recording",
      source: project.recording.blob,
      key,
      fx,
      stored: project.processed?.key === key,
    });
  }
  project.lines.forEach((line, index) => {
    if (!line.take) return;
    const tk = takeKey(project.audioFx, line.take);
    if (!tk) return;
    jobs.push({
      id: `take|${line.take.id}|${tk}`,
      projectId: project.id,
      label: `the new take for line ${index + 1}`,
      source: line.take.blob,
      key: tk,
      fx,
      takeId: line.take.id,
      stored: line.take.processed?.key === tk,
    });
  });
  return jobs;
}

/**
 * What still needs doing: files neither in the project nor made already. With
 * somewhere to store results, a file made already but not yet stored counts
 * too — storing it is instant.
 */
function pendingJobs(project: Project | null, skip: Record<string, unknown>, canStore: boolean): Job[] {
  return wantedJobs(project).filter(
    (job) => !job.stored && !skip[job.id] && (canStore || !recallProcessed(job.source, job.key))
  );
}

/** Keeps the previous array while its entries are the same, so effects do not re-run on every keystroke. */
function useStableEntries<T extends { id: string; blob: Blob }>(entries: T[]): T[] {
  const ref = useRef(entries);
  const prev = ref.current;
  const same = prev.length === entries.length && prev.every((e, i) => e.id === entries[i].id && e.blob === entries[i].blob);
  if (!same) ref.current = entries;
  return ref.current;
}

/**
 * Everything a project sounds like, decoded: the main recording, its cleaned-up
 * version, and every re-recorded take.
 *
 * With a preset other than "raw", the cleaned-up versions are made in the
 * background — debounced, one file at a time, main recording first — and
 * stored through `write` (project.processed, line.take.processed) in the
 * project each was made for. Without `write` they are still made and used,
 * just not saved.
 *
 * A cleaned file is used only when it was made with the current settings;
 * until the right one exists, the raw audio is used, so what you hear is
 * always either the recording as made or exactly what the preset gives.
 */
export function useLessonAudio(project: Project | null, write?: WriteProject): LessonAudio {
  const raw = useDecoded(project?.recording?.blob);

  // Bumped whenever a result lands in memory, so the choices below are re-read.
  const [madeVersion, setMadeVersion] = useState(0);
  const [failed, setFailed] = useState<Record<string, string>>({});

  /* ---------- which version of each file to use ---------- */

  const recordingBlob = project?.recording?.blob;
  const key = project ? mainKey(project) : null;
  const storedMain = project?.processed;
  const processedBlob = useMemo(() => {
    if (!key || !recordingBlob) return undefined;
    if (storedMain?.key === key) return storedMain.blob;
    return recallProcessed(recordingBlob, key);
  }, [key, recordingBlob, storedMain, madeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const processed = useDecoded(processedBlob);

  const fx = project?.audioFx;
  const takeEntries = useStableEntries(
    useMemo(
      () =>
        (project?.lines ?? [])
          .filter((l) => l.take)
          .map((l) => {
            const take = l.take!;
            const tk = fx ? takeKey(fx, take) : null;
            const cleanedTake = tk
              ? take.processed?.key === tk
                ? take.processed.blob
                : recallProcessed(take.blob, tk)
              : undefined;
            return { id: take.id, blob: cleanedTake ?? take.blob };
          }),
      [project?.lines, fx?.preset, fx?.room, madeVersion] // eslint-disable-line react-hooks/exhaustive-deps
    )
  );

  const [takes, setTakes] = useState<Map<string, RecordingAudio>>(new Map());
  useEffect(() => {
    let live = true;
    Promise.all(
      takeEntries.map((t) =>
        loadRecordingAudio(t.blob)
          .then((a) => [t.id, a] as const)
          .catch(() => null)
      )
    ).then((entries) => {
      if (!live) return;
      setTakes(new Map(entries.filter(Boolean) as [string, RecordingAudio][]));
    });
    return () => {
      live = false;
    };
  }, [takeEntries]);

  const sources = useMemo<AudioSources>(
    () => ({ main: processed.audio ?? raw.audio, takes }),
    [processed.audio, raw.audio, takes]
  );

  /* ---------- making them, in the background ---------- */

  const projectRef = useRef(project);
  projectRef.current = project;
  const writeRef = useRef(write);
  writeRef.current = write;
  const failedRef = useRef(failed);
  failedRef.current = failed;

  const runningRef = useRef(false);
  const currentRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const [running, setRunning] = useState<AudioProcessingStatus | null>(null);

  const pending = pendingJobs(project, failed, Boolean(write));
  const signature = pending.map((j) => j.id).join(",");
  const wantedIds = wantedJobs(project).map((j) => j.id).join(",");

  /**
   * Stores a finished file in the project it was made for, if that project
   * still has the same audio and settings. The key holds the audio's size and
   * length, so the check also works on a saved copy, whose Blobs are new ones.
   */
  const store = useCallback((job: Job, blob: Blob) => {
    const save = writeRef.current;
    if (!save) return;
    if (job.takeId) {
      save(job.projectId, (p) => {
        const matches = (l: LessonLine) => l.take?.id === job.takeId && takeKey(p.audioFx, l.take) === job.key;
        if (!p.lines.some(matches)) return {};
        return {
          lines: p.lines.map((l) => (matches(l) && l.take ? { ...l, take: { ...l.take, processed: { key: job.key, blob } } } : l)),
        };
      });
    } else {
      save(job.projectId, (p) => (mainKey(p) === job.key ? { processed: { key: job.key, blob } } : {}));
    }
  }, []);

  /**
   * Works through the queue, one file at a time, re-reading it after each file
   * so a change made meanwhile is picked up in the same pass.
   */
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const againRef = useRef(false);
  const drain = useCallback(async () => {
    if (runningRef.current) {
      // Asked again mid-pass: run one more pass afterwards, in case the change
      // came just as this one was finishing.
      againRef.current = true;
      return;
    }
    runningRef.current = true;
    // Everything tried in this pass, so nothing is tried twice while React catches up.
    const tried: Record<string, true> = {};
    try {
      for (;;) {
        const canStore = Boolean(writeRef.current);
        const queue = pendingJobs(projectRef.current, { ...failedRef.current, ...tried }, canStore);
        const job = queue[0];
        if (!job) break;
        tried[job.id] = true;

        const ready = recallProcessed(job.source, job.key);
        if (ready) {
          store(job, ready);
        } else {
          setRunning({ state: "processing", label: job.label, remaining: queue.length });
          const controller = new AbortController();
          currentRef.current = { id: job.id, controller };
          try {
            const audio = await loadRecordingAudio(job.source);
            const blob = await requestProcessed(audio, job.fx, controller.signal);
            rememberProcessed(job.source, job.key, blob);
            setMadeVersion((v) => v + 1);
            store(job, blob);
          } catch (err) {
            if ((err as Error)?.name !== "AbortError") {
              const message = err instanceof Error ? err.message : String(err);
              // No ffmpeg, or no server: every other file would fail the same way.
              const fatal = err instanceof ProcessingError && err.fatal;
              const ids = fatal ? queue.map((j) => j.id) : [job.id];
              setFailed((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, message])) }));
              if (fatal) break;
            }
          } finally {
            currentRef.current = null;
          }
        }
        // Let React render what was just stored before the queue is read again.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      runningRef.current = false;
      setRunning(null);
      if (againRef.current) {
        againRef.current = false;
        window.setTimeout(() => void drainRef.current(), 0);
      }
    }
  }, [store]);
  drainRef.current = drain;

  // Settings changed while a file was being cleaned for the old ones: drop it.
  useEffect(() => {
    const current = currentRef.current;
    if (current && !wantedIds.split(",").includes(current.id)) current.controller.abort();
  }, [wantedIds]);

  // Debounced, so clicking through the presets only cleans the one you stop on.
  useEffect(() => {
    if (!signature) return;
    const timer = window.setTimeout(() => void drain(), 700);
    return () => window.clearTimeout(timer);
  }, [signature, drain]);

  const retryProcessing = useCallback(() => setFailed({}), []);

  const failure = wantedJobs(project).find((j) => !j.stored && failed[j.id]);
  const processing: AudioProcessingStatus = running
    ? running
    : pending.length
      ? { state: "processing", label: pending[0].label, remaining: pending.length }
      : failure
        ? { state: "error", message: failed[failure.id] }
        : { state: "idle" };

  return {
    raw: raw.audio,
    sources,
    error: raw.error,
    processing,
    cleaned: Boolean(processed.audio),
    retryProcessing,
  };
}

/**
 * Plays finished line clips and reports where the playhead is in the main
 * recording, so the waveform and the line list can follow along.
 */
export function usePlayback() {
  const [playing, setPlaying] = useState<{ key: string; start: number; end: number } | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const halt = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(null);
    setPosition(null);
  }, []);

  const stop = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    stopPlayback();
    halt();
  }, [halt]);

  /**
   * Plays `clip`. `span` is where it sits in the main recording, for the
   * playhead; a clip with cuts or tightened pauses maps onto it proportionally.
   */
  const play = useCallback(
    async (key: string, clip: AudioBuffer, span?: { start: number; end: number }) => {
      stop();
      const ctx = audioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createBufferSource();
      source.buffer = clip;
      source.connect(ctx.destination);
      sourceRef.current = source;
      const range = span ?? { start: 0, end: clip.duration };
      setPlaying({ key, ...range });
      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null;
          halt();
        }
      };
      const started = ctx.currentTime;
      source.start();
      const tick = () => {
        const fraction = Math.min(1, (ctx.currentTime - started) / Math.max(0.01, clip.duration));
        setPosition(range.start + fraction * (range.end - range.start));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [halt, stop]
  );

  useEffect(() => () => stop(), [stop]);

  return { playing, position, play, stop };
}

export type Playback = ReturnType<typeof usePlayback>;
