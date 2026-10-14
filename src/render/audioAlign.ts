/**
 * Word timings measured from the audio, rather than asked for.
 *
 * Karaoke used to get its timings by sending the clip to a text model and
 * asking it to transcribe with per-word timestamps. That has three problems
 * that no amount of fixing the mapping can reach:
 *
 *   1. The timestamps are a guess. The model predicts plausible numbers token
 *      by token; it is not aligning anything. Ask twice, get two answers.
 *   2. Its timeline is its own. When it reports a 2.4s clip that is really
 *      3.1s, every word is early and the highlight runs ahead the whole line.
 *   3. It is a network call per line that can fail or be rate limited, and the
 *      silent fallback is an even spread — which is why it was right sometimes
 *      and badly wrong other times.
 *
 * The clip is sitting in memory as samples, and TTS output is studio clean:
 * one speaker, no room, no background. Where the speech is, is not something
 * that needs guessing — it is measurable, and it is the same answer every time.
 *
 * So: find the speech, find the pauses, and lay the written words over that
 * structure. No network, no quota, deterministic, and it works on a line the
 * user recorded themselves — which never got real timings at all before.
 */

export interface SpeechSegment {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  /** Loudest frame in this run, in dB relative to the clip's robust peak. */
  peakDb?: number;
}

export interface SpeechAnalysis {
  duration: number;
  /** Runs of speech, in order, with the pauses between them left out. */
  segments: SpeechSegment[];
}

/** Analysis window. 10ms is well under the shortest speech sound. */
const FRAME_SECONDS = 0.01;

/**
 * Dips shorter than this are inside a phone rather than between two sounds —
 * the notch where one consonant hands over to the next. Anything longer is left
 * in place as a candidate word boundary, because the assignment below can close
 * a gap that turns out not to be one but cannot invent a boundary it never saw.
 */
const WITHIN_WORD_GAP = 0.03;

/** Shorter than this is a click or a breath, not a word. */
const MIN_SEGMENT = 0.04;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

/**
 * Finds the runs of speech in a mono clip.
 *
 * Thresholds are set in dB against the clip's own robust peak and noise floor,
 * because speech energy inside one sentence spans 30dB or more — a plain
 * fraction-of-peak threshold drops every unvoiced fricative (س، ش، ف، ث) and
 * chops words in half. Entering and leaving speech use different thresholds so
 * a quiet consonant inside a word does not end it.
 */
export function analyzeSpeech(samples: Float32Array, sampleRate: number): SpeechAnalysis {
  const duration = samples.length / sampleRate;
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { duration: 0, segments: [] };
  }

  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameCount = Math.floor(samples.length / frameSize);
  if (frameCount < 2) return { duration, segments: [{ start: 0, end: duration }] };

  const db = new Array<number>(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let k = 0; k < frameSize; k++) {
      const s = samples[base + k];
      sum += s * s;
    }
    db[f] = 20 * Math.log10(Math.sqrt(sum / frameSize) + 1e-9);
  }

  const sorted = [...db].sort((a, b) => a - b);
  const floorDb = percentile(sorted, 0.1);

  /*
   * The peak is the loudest three-frame stretch, not a high percentile.
   *
   * A percentile was wrong whenever speech is a small part of the clip: at
   * 0.12s of speech in a 2.5s clip, even the 95th percentile lands in the
   * silence, the measured range collapses, and the whole clip comes back as one
   * undifferentiated segment. Smoothing over three frames instead keeps the
   * reason the percentile was there — a single-frame click averages away, while
   * real speech runs for many frames — without assuming how much of the clip
   * is speech.
   */
  let peakDb = -Infinity;
  for (let f = 0; f + 2 < frameCount; f++) {
    const mean = (db[f] + db[f + 1] + db[f + 2]) / 3;
    if (mean > peakDb) peakDb = mean;
  }
  if (!Number.isFinite(peakDb)) peakDb = percentile(sorted, 0.95);

  // Too little range to separate speech from silence: either the clip is wall
  // to wall speech, or there is nothing here. Either way, one segment.
  if (peakDb - floorDb < 12) return { duration, segments: [{ start: 0, end: duration }] };

  // Two thresholds, doing two different jobs. The generous one decides where a
  // sound begins and ends: speech inside one sentence spans 30dB or more, and
  // an unvoiced consonant (س، ش، ف، ث) sits far below the vowel beside it, so a
  // boundary read off the loud threshold cuts the front off every word that
  // opens on one. The strict one only decides whether a run is speech at all,
  // which keeps room tone and breaths out.
  const enterDb = Math.max(peakDb - 25, floorDb + 8);
  const exitDb = Math.max(peakDb - 35, floorDb + 4);

  const sounding = db.map((value) => value >= exitDb);

  // Close the dips that fall inside a word before reading any boundaries off:
  // a stop closure, the notch between two consonants, the moment of silence in
  // a geminate. Arabic is full of them and none is a word boundary.
  const bridge = Math.round(WITHIN_WORD_GAP / FRAME_SECONDS);
  for (let f = 0; f < frameCount; f++) {
    if (sounding[f]) continue;
    let g = f;
    while (g < frameCount && !sounding[g]) g++;
    if (f > 0 && g < frameCount && g - f <= bridge) {
      for (let k = f; k < g; k++) sounding[k] = true;
    }
    f = g - 1;
  }

  const raw: SpeechSegment[] = [];
  for (let f = 0; f < frameCount; f++) {
    if (!sounding[f]) continue;
    let g = f;
    let loudest = -Infinity;
    while (g < frameCount && sounding[g]) {
      if (db[g] > loudest) loudest = db[g];
      g++;
    }
    // A run that never gets loud is a breath, a click or the room, not a word.
    if (loudest >= enterDb) {
      raw.push({
        start: f * FRAME_SECONDS,
        end: g * FRAME_SECONDS,
        // Relative to the clip's own peak, so callers can compare runs without
        // knowing anything about absolute levels.
        peakDb: loudest - peakDb,
      });
    }
    f = g - 1;
  }

  const merged = raw;
  const segments = merged.filter((s) => s.end - s.start >= MIN_SEGMENT);

  return { duration, segments: segments.length ? segments : [{ start: 0, end: duration }] };
}

/**
 * Roughly how long a word takes to say, in arbitrary units.
 *
 * Letter count is a decent proxy within one language, and the pause structure
 * does most of the real work — this only shares out the time inside a run of
 * speech. Digits get extra because a numeral is one short token on the page and
 * several syllables out loud: "15" is two characters and خمستعشر to say.
 */
export function wordWeight(word: string): number {
  const bare = (word || "")
    .normalize("NFKC")
    // Harakat, tanwin, sukun, superscript alef, tatweel: written, not spoken.
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  const digits = (bare.match(/\p{N}/gu) || []).length;
  const letters = bare.length - digits;
  // The constant is the cost of starting and ending a word at all, so a
  // one-letter word does not get a twentieth of a five-letter word's time.
  return 1.4 + letters + digits * 3;
}

/** Total speech time in a group of segments, pauses excluded. */
function speechTime(segments: SpeechSegment[]): number {
  return segments.reduce((total, s) => total + (s.end - s.start), 0);
}

/**
 * Lays `words` over the speech in `analysis` and returns a start time for each.
 *
 * Two stages. First decide how many words fall in each run of speech, by
 * matching each run's share of the talking time against the words' share of the
 * expected talking time — a pause is strong evidence of a word boundary, so the
 * runs are treated as fixed and the words are fitted to them. Then share each
 * run's time out among its own words by weight.
 *
 * A word therefore never starts during a pause: the highlight waits out the
 * silence and moves when the voice does.
 */
export function alignWordsToAudio(words: string[], analysis: SpeechAnalysis): number[] {
  const n = words.length;
  if (!n) return [];

  const weights = words.map(wordWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || n;

  const segments = analysis.segments;
  if (!segments.length) {
    // Nothing detectable. Spread by weight over whatever length we have.
    const span = analysis.duration || 0;
    const starts: number[] = [];
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      starts.push((cursor / totalWeight) * span);
      cursor += weights[i];
    }
    return starts;
  }

  const segmentCount = segments.length;
  const speechPrefix = [0];
  for (const seg of segments) speechPrefix.push(speechPrefix[speechPrefix.length - 1] + (seg.end - seg.start));
  const totalTime = speechPrefix[segmentCount] || 1;

  const weightPrefix = [0];
  for (let i = 0; i < n; i++) weightPrefix.push(weightPrefix[i] + weights[i]);

  /** Silence swallowed by putting segments a..b-1 in the same group. */
  const internalGap = (a: number, b: number): number => {
    let total = 0;
    for (let k = a; k < b - 1; k++) total += segments[k + 1].start - segments[k].end;
    return total;
  };

  /**
   * How much a long pause counts as evidence of a word boundary. Duration share
   * alone will happily run a group straight through a half-second silence if the
   * arithmetic works out; it never should, so absorbing silence is paid for.
   */
  const GAP_COST = 1.6;

  // How many segments one word may span, and how many words one segment may
  // hold. Both are generous relative to the counts involved, and only exist to
  // keep the search from growing with the square of a long line.
  const maxSegmentsPerGroup = Math.max(3, Math.ceil(segmentCount / n) + 3);
  const maxWordsPerGroup = Math.max(4, Math.ceil(n / segmentCount) + 4);

  const INF = Infinity;
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array(segmentCount + 1).fill(INF));
  const fromWord: number[][] = Array.from({ length: n + 1 }, () => new Array(segmentCount + 1).fill(-1));
  const fromSeg: number[][] = Array.from({ length: n + 1 }, () => new Array(segmentCount + 1).fill(-1));
  best[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let sg = 1; sg <= segmentCount; sg++) {
      for (let m = 1; m <= Math.min(i, maxWordsPerGroup); m++) {
        for (let k = 1; k <= Math.min(sg, maxSegmentsPerGroup); k++) {
          const prior = best[i - m][sg - k];
          if (prior === INF) continue;
          const wordShare = (weightPrefix[i] - weightPrefix[i - m]) / totalWeight;
          const timeShare = (speechPrefix[sg] - speechPrefix[sg - k]) / totalTime;
          const diff = wordShare - timeShare;
          const cost = prior + diff * diff + GAP_COST * internalGap(sg - k, sg);
          if (cost < best[i][sg]) {
            best[i][sg] = cost;
            fromWord[i][sg] = i - m;
            fromSeg[i][sg] = sg - k;
          }
        }
      }
    }
  }

  // Walk the groups back out: each is a run of words over a run of segments.
  const groups: { firstWord: number; lastWord: number; segs: SpeechSegment[] }[] = [];
  let wi = n;
  let si = segmentCount;
  while (wi > 0 && si > 0 && fromWord[wi][si] >= 0) {
    const pw = fromWord[wi][si];
    const ps = fromSeg[wi][si];
    groups.unshift({ firstWord: pw, lastWord: wi, segs: segments.slice(ps, si) });
    wi = pw;
    si = ps;
  }
  if (!groups.length) {
    groups.push({ firstWord: 0, lastWord: n, segs: segments.slice() });
  }

  const starts = new Array<number>(n).fill(0);
  for (const group of groups) {
    const { firstWord, lastWord, segs } = group;
    if (lastWord <= firstWord || !segs.length) continue;
    const runWeight = weightPrefix[lastWord] - weightPrefix[firstWord] || 1;
    const runTime = speechTime(segs);

    let consumed = 0;
    for (let i = firstWord; i < lastWord; i++) {
      // Position inside the group measured in talking time, then converted to
      // clock time by walking the segments — so a pause inside a group is
      // stepped over rather than divided up.
      let remaining = (consumed / runWeight) * runTime;
      let at = segs[0].start;
      for (const seg of segs) {
        const length = seg.end - seg.start;
        if (remaining <= length) {
          at = seg.start + remaining;
          break;
        }
        remaining -= length;
        at = seg.end;
      }
      starts[i] = at;
      consumed += weights[i];
    }
  }

  // Time only moves forward.
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(starts[i]) || starts[i] < starts[i - 1]) starts[i] = starts[i - 1];
  }
  if (!Number.isFinite(starts[0])) starts[0] = 0;

  return starts.map((v) => Math.max(0, v));
}

/** The whole job for one clip: samples in, a start time per word out. */
export function timeWordsFromAudio(
  words: string[],
  samples: Float32Array,
  sampleRate: number
): number[] {
  return alignWordsToAudio(words, analyzeSpeech(samples, sampleRate));
}

/**
 * How the words are split, kept here next to the timing so the renderer and the
 * aligner can never disagree about what counts as a word.
 */
export function splitWords(text: string): string[] {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}
