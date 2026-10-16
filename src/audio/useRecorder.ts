import { useCallback, useEffect, useRef, useState } from "react";
import { audioContext } from "./audioTools";
import { RECORDING_IN_PROGRESS, holdLeave } from "../utils/leaveGuard";

export type RecorderState = "idle" | "recording" | "paused";

/**
 * Microphone recording with pause, a running clock and a live level.
 *
 * Echo cancellation and automatic gain are off: both reshape the voice, and
 * the levelling is done properly afterwards on the whole recording. Noise
 * suppression is the user's call — it helps in a noisy room and can make a
 * quiet one sound processed.
 */
export function useRecorder(options: { noiseSuppression: boolean }) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const clockRef = useRef<{ startedAt: number; banked: number }>({ startedAt: 0, banked: 0 });
  const resolveRef = useRef<((blob: Blob) => void) | null>(null);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  // Leaving the screen this recorder is on throws the recording away, so the
  // app asks first while it runs — whichever screen it is on.
  const live = state !== "idle";
  useEffect(() => (live ? holdLeave(RECORDING_IN_PROGRESS) : undefined), [live]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: options.noiseSuppression,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
        MediaRecorder.isTypeSupported?.(t)
      );
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 128000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        teardown();
        setState("idle");
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        resolveRef.current?.(blob);
        resolveRef.current = null;
      };

      // Live level for the meter.
      const ctx = audioContext();
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(bins);
        let peak = 0;
        for (let i = 0; i < bins.length; i++) peak = Math.max(peak, Math.abs(bins[i] - 128) / 128);
        setLevel(peak);
        const clock = clockRef.current;
        if (recorderRef.current?.state === "recording") {
          setElapsed(clock.banked + (performance.now() - clock.startedAt) / 1000);
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      recorder.start(1000);
      recorderRef.current = recorder;
      clockRef.current = { startedAt: performance.now(), banked: 0 };
      setElapsed(0);
      setState("recording");
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      teardown();
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "The browser blocked the microphone. Allow it for this site (the icon in the address bar) and try again."
          : "Could not open the microphone. Check that one is connected and not in use by another app."
      );
    }
  }, [options.noiseSuppression, teardown]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    recorder.pause();
    const clock = clockRef.current;
    clock.banked += (performance.now() - clock.startedAt) / 1000;
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state !== "paused") return;
    recorder.resume();
    clockRef.current.startedAt = performance.now();
    setState("recording");
  }, []);

  const stop = useCallback((): Promise<Blob> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return Promise.reject(new Error("Not recording."));
    return new Promise<Blob>((resolve) => {
      resolveRef.current = resolve;
      recorder.stop();
    });
  }, []);

  return { state, elapsed, level, error, start, pause, resume, stop };
}
