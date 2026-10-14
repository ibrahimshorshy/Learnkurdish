/**
 * Offline audio mixdown.
 *
 * Real-time recording captures audio by playing it through a MediaStream, which
 * pins the whole render to wall-clock speed. The fast path instead mixes every
 * scheduled clip into one buffer ahead of time with an OfflineAudioContext —
 * which runs as fast as the CPU allows — and hands ffmpeg a WAV to mux against
 * the rendered frames.
 */

export interface ScheduledClip {
  buffer: AudioBuffer;
  /** Seconds from the start of the video. */
  at: number;
}

const SAMPLE_RATE = 48000;

/** Renders all clips onto one stereo timeline of the requested length. */
export async function mixdown(clips: ScheduledClip[], durationSeconds: number): Promise<AudioBuffer> {
  const OfflineCtx =
    window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error("This browser has no OfflineAudioContext.");

  const length = Math.max(1, Math.ceil(durationSeconds * SAMPLE_RATE));
  const offline = new OfflineCtx(2, length, SAMPLE_RATE);

  for (const clip of clips) {
    if (!clip.buffer) continue;
    const source = offline.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(offline.destination);
    source.start(Math.max(0, clip.at));
  }

  return offline.startRendering();
}

/** Encodes an AudioBuffer as a 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: "audio/wav" });
}
