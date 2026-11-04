/**
 * The clean-up presets must never move the voice in time or change the
 * length: the line times index into the cleaned audio.
 *
 * Pure checks first (every preset is described, keys change when they should,
 * no time-shifting filter sneaks into a chain), then every preset with and
 * without room is run through ffmpeg exactly as the server runs it, on a
 * signal with voice-like bursts at known times. Skipped, not failed, when
 * ffmpeg is not installed.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  AUDIO_PRESETS,
  TIME_SHIFTING_FILTERS,
  presetGraph,
  processedKey,
  needsProcessing,
  isAudioPresetId,
  findAudioPreset,
} from "../src/config/audioPresets.ts";
import { processAudioFile, readWav, writeWav16, timingSafeGraph, PROCESS_RATE } from "../server/routes/audio.ts";
import { check, near, done } from "./harness.mjs";

/* ---------------- pure ---------------- */

const ids = AUDIO_PRESETS.map((p) => p.id);
check("presets: raw, clean, noisy, studio, warm", ["raw", "clean", "noisy", "studio", "warm"].every((id) => ids.includes(id)));
check("every preset has a label and a one-line description", AUDIO_PRESETS.every((p) => p.label && p.description && !p.description.includes("\n")));
check("raw has no filters", presetGraph("raw", false) === "" && presetGraph("raw", true) === "");
check("raw needs no processing; clean does", !needsProcessing({ preset: "raw" }) && needsProcessing({ preset: "clean" }));
check("unknown preset ids are rejected", !isAudioPresetId("loud") && !findAudioPreset("loud") && isAudioPresetId("warm"));
check(
  "every non-raw preset removes noise with afftdn and rumble with highpass",
  AUDIO_PRESETS.filter((p) => p.id !== "raw").every((p) => p.filters.some((f) => f.startsWith("afftdn")) && p.filters.some((f) => f.startsWith("highpass")))
);
const allGraphs = AUDIO_PRESETS.flatMap((p) => [presetGraph(p.id, false), presetGraph(p.id, true)]).join(",");
const bad = TIME_SHIFTING_FILTERS.filter((name) => new RegExp(`(^|[,;\\]])${name}(=|,|$)`).test(allGraphs));
check("no chain uses a filter that buffers ahead or changes tempo", bad.length === 0, bad.join(", "));
check("room adds to the chain", presetGraph("clean", true).startsWith(presetGraph("clean", false)) && presetGraph("clean", true).length > presetGraph("clean", false).length);

const source = { size: 123456, durationSeconds: 12.3456 };
const key = processedKey({ preset: "clean", room: false }, source);
check("key is stable", key === processedKey({ preset: "clean", room: false }, { ...source }));
check("key changes with the preset", key !== processedKey({ preset: "studio", room: false }, source));
check("key changes with room", key !== processedKey({ preset: "clean", room: true }, source));
check("key changes with the source size", key !== processedKey({ preset: "clean", room: false }, { ...source, size: 123457 }));
check("key changes with the source duration", key !== processedKey({ preset: "clean", room: false }, { ...source, durationSeconds: 12.4 }));

const safe = timingSafeGraph("afftdn", 1200, 48000);
check(
  "timing-safe graph pads, trims the latency and pins the length",
  safe.includes("apad=pad_len=1200") && safe.includes("atrim=start_sample=1200") && safe.endsWith("apad=whole_len=48000,atrim=end_sample=48000"),
  safe
);

// WAV round trip, including a LIST chunk before the data as ffmpeg writes.
{
  const samples = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 7) * 0.5);
  const plain = writeWav16(samples, 48000);
  const back = readWav(plain);
  check("WAV round trip", back.sampleRate === 48000 && back.samples.length === 480 && near(back.samples[100], samples[100], 1e-4));
  const list = Buffer.alloc(8 + 6);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(6, 4);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  check("WAV reader skips unknown chunks", readWav(withList).samples.length === 480);
}

/* ---------------- through ffmpeg ---------------- */

let ffmpegOk = false;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  ffmpegOk = true;
} catch {
  console.log("SKIP  ffmpeg is not installed — the timing checks did not run");
}

/** Voice-like bursts (a harmonic tone with soft edges) over a little noise, at `rate`. */
function testSignal(rate, seconds, bursts) {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 5;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 0.01;
  }
  const length = Math.round(0.12 * rate);
  for (const at of bursts) {
    const from = Math.round(at * rate);
    for (let k = 0; k < length && from + k < out.length; k++) {
      // A fast attack, so the onset is sharp enough to time.
      const env = Math.min(1, k / (0.002 * rate)) * Math.min(1, (length - k) / (0.02 * rate));
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 160 * h * k) / rate) / h;
      out[from + k] += 0.4 * env * v;
    }
  }
  return out;
}

/** Where each burst starts: the first sample above a third of the loudest, after a quiet stretch. */
function onsets(samples, rate) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const threshold = peak / 3;
  const found = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) < threshold) continue;
    if (i - lastLoud > rate * 0.2) found.push(i / rate);
    lastLoud = i;
  }
  return found;
}

if (ffmpegOk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leen-ku-test-"));
  try {
    // 44.1kHz in, so the resampling to 48kHz is checked too. The last burst
    // sits right at the end, where a delaying filter would cut it off.
    const inRate = 44100;
    const seconds = 3.0;
    const bursts = [0.3, 1.234, 2.0, seconds - 0.14];
    const input = testSignal(inRate, seconds, bursts);
    const inputPath = path.join(dir, "in.wav");
    fs.writeFileSync(inputPath, writeWav16(input, inRate));
    const expectedSamples = Math.round(seconds * PROCESS_RATE);
    const inputOnsets = onsets(input, inRate);
    check("test signal onsets are where they were put", inputOnsets.length === bursts.length && inputOnsets.every((t, i) => near(t, bursts[i], 0.003)), inputOnsets.join(" "));

    for (const preset of AUDIO_PRESETS) {
      for (const room of preset.id === "raw" ? [false] : [false, true]) {
        const name = `${preset.id}${room ? " + room" : ""}`;
        const work = fs.mkdtempSync(path.join(dir, "w-"));
        try {
          const result = await processAudioFile(inputPath, preset.id, room, work);
          const out = readWav(result.wav);
          check(`${name}: 48kHz mono`, out.sampleRate === PROCESS_RATE && out.channels === 1);
          check(
            `${name}: same duration (±10ms)`,
            near(out.samples.length / PROCESS_RATE, seconds, 0.01) && Math.abs(out.samples.length - expectedSamples) <= 2,
            `${out.samples.length} samples`
          );
          const found = onsets(out.samples, PROCESS_RATE);
          check(
            `${name}: every burst starts at the same time (±3ms)`,
            found.length === bursts.length && found.every((t, i) => near(t, inputOnsets[i], 0.003)),
            `in ${inputOnsets.map((t) => t.toFixed(4)).join(" ")} / out ${found.map((t) => t.toFixed(4)).join(" ")} (latency ${result.latency})`
          );
          let peak = 0;
          for (const v of out.samples) peak = Math.max(peak, Math.abs(v));
          check(`${name}: not clipped, not silent`, peak <= 0.99 && peak > 0.05, `peak ${peak.toFixed(3)}`);
        } catch (err) {
          check(`${name}: processes`, false, String(err?.stderr || err?.message || err).slice(-300));
        }
      }
    }

    // The onset check above reads a level threshold, which a compressor can
    // nudge by a millisecond or two on the attack. Cross-correlation over the
    // whole signal measures the real shift: it must be well under a millisecond.
    {
      const signal = testSignal(PROCESS_RATE, seconds, bursts);
      const at48 = path.join(dir, "in48.wav");
      fs.writeFileSync(at48, writeWav16(signal, PROCESS_RATE));
      const lagOf = (a, b) => {
        let best = 0;
        let bestScore = -Infinity;
        for (let lag = -240; lag <= 240; lag++) {
          let s = 0;
          for (let i = 0; i < a.length; i += 2) {
            const j = i + lag;
            if (j >= 0 && j < b.length) s += a[i] * b[j];
          }
          if (s > bestScore) {
            bestScore = s;
            best = lag;
          }
        }
        return best;
      };
      for (const preset of AUDIO_PRESETS.filter((p) => p.id !== "raw")) {
        for (const room of [false, true]) {
          const work = fs.mkdtempSync(path.join(dir, "w-"));
          const out = readWav((await processAudioFile(at48, preset.id, room, work)).wav).samples;
          const lag = lagOf(signal, out);
          check(`${preset.id}${room ? " + room" : ""}: no shift by cross-correlation (±0.5ms)`, Math.abs(lag) <= 24, `${lag} samples`);
        }
      }
    }

    // A loud recording must come back below full scale, not squared off.
    {
      const loud = testSignal(PROCESS_RATE, 1.0, [0.3]).map((v) => Math.max(-1, Math.min(1, v * 2.2)));
      const loudPath = path.join(dir, "loud.wav");
      fs.writeFileSync(loudPath, writeWav16(loud, PROCESS_RATE));
      const work = fs.mkdtempSync(path.join(dir, "w-"));
      const out = readWav((await processAudioFile(loudPath, "studio", true, work)).wav).samples;
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      check("a hot recording through studio + room stays under full scale", peak <= 0.981, `peak ${peak.toFixed(3)}`);
    }

    // Only the WAV the browser sends goes in. Anything else (here an Opus file
    // like the browser records) is refused before ffmpeg sees it, so ffmpeg
    // never guesses a format; see tests/serverSecurity.test.mjs.
    try {
      const opusPath = path.join(dir, "in.webm");
      execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-c:a", "libopus", opusPath]);
      const work = fs.mkdtempSync(path.join(dir, "w-"));
      let refused = null;
      try {
        await processAudioFile(opusPath, "clean", false, work);
      } catch (err) {
        refused = err;
      }
      check("a WebM/Opus upload is refused as not WAV (415)", refused?.status === 415, String(refused?.message || "accepted"));
    } catch (err) {
      console.log(`SKIP  WebM/Opus refusal: ${String(err?.message || err).split("\n")[0]}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

done("audioPresets");
