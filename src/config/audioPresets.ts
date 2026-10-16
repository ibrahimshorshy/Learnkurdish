/**
 * Clean-up presets for your recorded voice: noise removal and tone, run
 * through ffmpeg on this computer.
 *
 * Shared by the browser (labels, the key that tells a processed file is out of
 * date) and the server (the filter chains). Pure: no DOM, no Node.
 *
 * One rule above everything else: NOTHING here may move the audio in time or
 * change its length. The line times index straight into this audio, so a
 * filter that delayed the voice by 25ms would make every line start 25ms
 * early. Filters that buffer (lookahead limiters, loudness normalisers,
 * tempo changes) are not allowed at all. The FFT denoiser does buffer — it
 * returns the signal 25ms late at 48kHz — so the server measures that delay
 * and takes it back out, and finally pins the output to the exact input
 * sample count. tests/audioPresets.test.mjs checks both.
 */

import type { AudioFxSettings, AudioPresetId } from "../types";

export interface AudioPreset {
  id: AudioPresetId;
  label: string;
  /** One line for the chip: what it is for. */
  description: string;
  /**
   * ffmpeg audio filters, in order, run on 48kHz mono float. Empty for "raw".
   * Each entry is one filter; the server joins them with commas.
   */
  filters: string[];
}

/**
 * Bump when any chain below changes, so files made with the old chain are seen
 * as out of date and made again.
 */
export const AUDIO_FX_VERSION = 1;

/*
 * Notes on the building blocks, so the numbers below can be tuned with care:
 *
 *   highpass f=…   removes rumble (desk knocks, traffic, air conditioning)
 *                  below the voice. A male voice's fundamental sits around
 *                  85–155Hz, so nothing above ~90Hz.
 *   afftdn         FFT noise reduction. nr = how many dB of noise to remove,
 *                  nf = the noise floor it assumes, tn=1 = keep learning the
 *                  noise as it changes. Too much nr gives "underwater" voice.
 *   equalizer      a bell: f centre, w width (Q), g gain in dB.
 *   bass / treble  low and high shelves.
 *   acompressor    evens out loud and soft words. threshold is linear
 *                  (0.125 ≈ -18dB), makeup is linear gain. No lookahead, so
 *                  no delay.
 */
export const AUDIO_PRESETS: AudioPreset[] = [
  {
    id: "raw",
    label: "Raw",
    description: "Exactly as recorded. No clean-up.",
    filters: [],
  },
  {
    id: "clean",
    label: "Clean",
    description: "Light hiss and rumble removal. Safe for any recording.",
    filters: [
      "highpass=f=70",
      "afftdn=nr=10:nf=-50:tn=1",
      "acompressor=threshold=0.125:ratio=2:attack=20:release=250:makeup=1.2",
    ],
  },
  {
    id: "noisy",
    label: "Noisy room",
    description: "Stronger removal for fans, traffic or a humming fridge.",
    filters: [
      "highpass=f=100",
      "afftdn=nr=24:nf=-38:tn=1",
      // Strong denoising dulls the consonants a little; give the clarity back.
      "equalizer=f=3200:t=q:w=1:g=2",
      "acompressor=threshold=0.1:ratio=3:attack=10:release=180:makeup=1.6",
    ],
  },
  {
    id: "studio",
    label: "Studio",
    description: "Clear and close, like a voice on the radio.",
    filters: [
      "highpass=f=85",
      "afftdn=nr=14:nf=-48:tn=1",
      // Less of the boxy low-mid a laptop or phone microphone adds…
      "equalizer=f=220:t=q:w=1.2:g=-2.5",
      // …more presence, where the consonants live…
      "equalizer=f=3500:t=q:w=1.4:g=3",
      // …and a little air on top.
      "treble=g=2:f=9000",
      "acompressor=threshold=0.09:ratio=3.5:attack=8:release=140:makeup=1.8",
    ],
  },
  {
    id: "warm",
    label: "Warm",
    description: "Fuller and softer. Tames a thin or harsh microphone.",
    filters: [
      "highpass=f=65",
      "afftdn=nr=12:nf=-50:tn=1",
      "bass=g=3:f=160",
      "equalizer=f=5000:t=q:w=1.5:g=-2.5",
      "treble=g=-1.5:f=10000",
      "acompressor=threshold=0.11:ratio=2.5:attack=15:release=220:makeup=1.5",
    ],
  },
];

/**
 * A small room around the voice, for a recording so dry it sounds boxed in.
 *
 * A handful of early reflections between 5 and 52ms, each quieter than the
 * last, low-passed because real walls soak up the highs, then mixed in well
 * below the voice. There is no reverb tail to smear the words. The reflections
 * come after the voice, never before it, so where each word starts does not
 * move.
 *
 * Written as a small filter graph: the voice is split, one copy becomes the
 * reflections, and the two are summed back into one channel.
 */
export const ROOM_GRAPH =
  "asplit=2[voice][send];" +
  "[send]aecho=0:1:5|9|14|19|26|33|41|52:0.07|0.06|0.05|0.045|0.035|0.028|0.02|0.014," +
  "highpass=f=180,lowpass=f=4200[room];" +
  "[voice][room]amerge=inputs=2,pan=mono|c0=c0+c1";

/**
 * Filters a chain must never contain: each one buffers ahead or changes the
 * tempo, so it would move the voice against the line times.
 */
export const TIME_SHIFTING_FILTERS = [
  "alimiter",
  "loudnorm",
  "dynaudnorm",
  "speechnorm",
  "atempo",
  "rubberband",
  "adelay",
  "silenceremove",
  "areverse",
];

export const DEFAULT_AUDIO_PRESET: AudioPresetId = "clean";

export function findAudioPreset(id: string | undefined): AudioPreset | undefined {
  return AUDIO_PRESETS.find((p) => p.id === id);
}

export function isAudioPresetId(id: unknown): id is AudioPresetId {
  return typeof id === "string" && AUDIO_PRESETS.some((p) => p.id === id);
}

/** Whether these settings change the sound at all. Room needs a preset: "raw" means raw. */
export function needsProcessing(fx: Pick<AudioFxSettings, "preset">): boolean {
  return fx.preset !== "raw" && isAudioPresetId(fx.preset);
}

/**
 * The filter graph for a preset, without the timing safeguards the server
 * wraps around it. Empty for "raw".
 */
export function presetGraph(preset: AudioPresetId, room: boolean): string {
  const found = findAudioPreset(preset);
  if (!found || found.id === "raw") return "";
  const chain = found.filters.join(",");
  return room ? `${chain},${ROOM_GRAPH}` : chain;
}

/**
 * Which source and settings a processed file was made from. Stored with the
 * file; when the current settings give a different key, the file is stale.
 *
 * The source is identified by its size and duration rather than its contents:
 * cheap, stable across saves, and a different recording all but never matches
 * both.
 */
export function processedKey(
  fx: Pick<AudioFxSettings, "preset" | "room">,
  source: { size: number; durationSeconds: number }
): string {
  return [
    `v${AUDIO_FX_VERSION}`,
    fx.preset,
    fx.room ? "room" : "dry",
    source.size,
    (Number(source.durationSeconds) || 0).toFixed(3),
  ].join("|");
}
