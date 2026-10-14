import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../types";
import { analyzeSpeech, type SpeechAnalysis } from "../render/audioAlign";
import { audioContext, decodeAudio, levellingGain, stopPlayback, toMono } from "./audioTools";
import type { AudioSources } from "./clipBuilder";

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

function useDecoded(blob: Blob | undefined): { audio: RecordingAudio | null; error: string | null } {
  const [audio, setAudio] = useState<RecordingAudio | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    if (!blob) {
      setAudio(null);
      return;
    }
    loadRecordingAudio(blob)
      .then((a) => live && setAudio(a))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [blob]);
  return { audio, error };
}

export interface LessonAudio {
  /** The main recording as recorded — what the waveform shows. */
  raw: RecordingAudio | null;
  /** What the lines and the video use: the cleaned-up recording when there is one, else the raw. */
  sources: AudioSources;
  error: string | null;
}

/**
 * Everything a project sounds like, decoded: the main recording, its cleaned-up
 * version, and every re-recorded take.
 *
 * The cleaned-up versions are used once they exist; making them (and noticing
 * when they are out of date) is the audio clean-up's job.
 */
export function useLessonAudio(project: Project | null): LessonAudio {
  const raw = useDecoded(project?.recording?.blob);
  const processed = useDecoded(project?.processed?.blob);

  const takeBlobs = useMemo(
    () =>
      (project?.lines ?? [])
        .filter((l) => l.take)
        .map((l) => ({ id: l.take!.id, blob: l.take!.processed?.blob ?? l.take!.blob })),
    [project?.lines]
  );

  const [takes, setTakes] = useState<Map<string, RecordingAudio>>(new Map());
  useEffect(() => {
    let live = true;
    Promise.all(
      takeBlobs.map((t) =>
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
  }, [takeBlobs]);

  const sources = useMemo<AudioSources>(
    () => ({ main: processed.audio ?? raw.audio, takes }),
    [processed.audio, raw.audio, takes]
  );

  return { raw: raw.audio, sources, error: raw.error };
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
