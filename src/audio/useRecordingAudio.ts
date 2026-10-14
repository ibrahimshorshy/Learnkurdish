import { useCallback, useEffect, useRef, useState } from "react";
import type { Recording } from "../types";
import { analyzeSpeech, type SpeechAnalysis } from "../render/audioAlign";
import { audioContext, decodeAudio, levellingGain, playRange, stopPlayback, toMono } from "./audioTools";

export interface RecordingAudio {
  buffer: AudioBuffer;
  mono: Float32Array;
  /** Where the speech and the pauses are. */
  analysis: SpeechAnalysis;
  /** Gain that levels the recording; applied to playback and to the video. */
  gain: number;
}

/** Decoding is the slow part, so each recording Blob is decoded once. */
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

export function useRecordingAudio(recording: Recording | undefined) {
  const [audio, setAudio] = useState<RecordingAudio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blob = recording?.blob;

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

/**
 * Plays stretches of the recording and reports where the playhead is, so the
 * waveform and the line list can follow along.
 */
export function usePlayback(audio: RecordingAudio | null) {
  const [playing, setPlaying] = useState<{ key: string; start: number; end: number } | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedRef = useRef(0);

  const halt = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(null);
    setPosition(null);
  }, []);

  const stop = useCallback(() => {
    stopPlayback();
    halt();
  }, [halt]);

  const play = useCallback(
    async (key: string, start: number, end: number) => {
      if (!audio) return;
      stopPlayback();
      halt();
      const ctx = audioContext();
      setPlaying({ key, start, end });
      await playRange(audio.buffer, start, end, halt, audio.gain);
      startedRef.current = ctx.currentTime;
      const tick = () => {
        const t = start + (ctx.currentTime - startedRef.current);
        setPosition(Math.min(end, t));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [audio, halt]
  );

  useEffect(() => () => stopPlayback(), []);

  return { playing, position, play, stop };
}
