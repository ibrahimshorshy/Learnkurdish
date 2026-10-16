/**
 * Colour: every MP4 the app makes is BT.709 SDR in limited range — what
 * phones, browsers and the platforms assume for HD video.
 *
 * The parts come from different places and do not agree on their own: the
 * canvas renderer's JPEG frames are BT.601 full range, phone videos are
 * usually BT.709, older or smaller ones BT.601, and an iPhone records HDR
 * (HLG, BT.2020, 10-bit) by default. Left alone, the encoder writes whatever
 * the first frame says, so a title card in front of a phone video re-labels
 * the whole file and every colour after it shifts. So each picture is
 * converted to BT.709 on the way in, and every output is tagged as such.
 */

import { runTool } from "./ffmpeg";

/** A video stream's colour description, as ffprobe names it. Missing when the file does not say. */
export interface ColourInfo {
  /** Matrix: bt709, smpte170m, bt470bg, bt2020nc… */
  matrix?: string;
  /** Transfer: bt709, arib-std-b67 (HLG), smpte2084 (PQ)… */
  transfer?: string;
  primaries?: string;
  /** tv (limited) or pc (full). */
  range?: string;
  /** Decoded pixel format, e.g. yuv420p10le or yuvj420p. */
  pixelFormat?: string;
}

/** Output options that label the encoded stream BT.709 SDR, limited range. */
export const BT709_OUTPUT = [
  "-colorspace", "bt709",
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-color_range", "tv",
];

/** Labels frames BT.709 SDR; used after they have been converted to it. */
export const TAG_BT709 = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

/** HLG and PQ: high dynamic range, which an SDR file cannot just carry over. */
export function isHdr(colour: ColourInfo | undefined): boolean {
  return colour?.transfer === "arib-std-b67" || colour?.transfer === "smpte2084";
}

/** ffprobe's matrix names → the scale filter's. */
const SCALE_MATRIX: Record<string, string> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470",
  fcc: "fcc",
  smpte240m: "smpte240m",
  bt2020nc: "bt2020",
  bt2020c: "bt2020",
};

/**
 * Options for the scale filter that convert the source's YUV to BT.709
 * limited range while it scales — no extra pass over the picture.
 *
 * A file that does not say which matrix it uses is read the way players
 * guess it (mpv's rule, and close to what browsers do): BT.709 when it is HD,
 * BT.601 when it is not. Reading every untagged file as BT.601, which is
 * swscale's own default, would shift the colours of an untagged HD phone
 * video against what the preview showed.
 */
export function toBt709(colour: ColourInfo | undefined, size?: { width: number; height: number }): string {
  let matrix = colour?.matrix ? SCALE_MATRIX[colour.matrix] : undefined;
  if (!matrix) {
    const hd = size ? Math.max(size.width, size.height) >= 1280 || Math.min(size.width, size.height) > 576 : false;
    // Unknown size: "auto" reads the frame's own tag, or BT.601 without one.
    matrix = size ? (hd ? "bt709" : "bt601") : "auto";
  }
  const range = colour?.range === "pc" ? "full" : colour?.range === "tv" ? "limited" : "auto";
  return `in_color_matrix=${matrix}:in_range=${range}:out_color_matrix=bt709:out_range=tv`;
}

/* ------------------------------------------------------------------ */
/* HDR                                                                   */
/* ------------------------------------------------------------------ */

let zscaleCheck: Promise<boolean> | null = null;

/**
 * Whether this ffmpeg has zscale and tonemap, which tone-mapping HDR needs.
 * zscale comes from an optional library (zimg): the common Windows and
 * Linux builds have it, a minimal build may not. Asked once.
 */
export function hasToneMapping(): Promise<boolean> {
  if (!zscaleCheck) {
    zscaleCheck = runTool("ffmpeg", ["-hide_banner", "-filters"])
      .then(({ stdout }) => /^\s*\S+\s+zscale\s/m.test(stdout) && /^\s*\S+\s+tonemap\s/m.test(stdout))
      .catch(() => false);
  }
  return zscaleCheck;
}

const ZSCALE_MATRIX: Record<string, string> = { bt2020nc: "bt2020nc", bt2020c: "bt2020c", bt709: "bt709" };

/**
 * A chain that turns an HLG or PQ picture into BT.709 SDR, or "" for SDR.
 *
 * With zscale: to linear light, into BT.709 primaries, tone-mapped, back to
 * BT.709 gamma. Mobius rather than the often-quoted hable: hable leaves a
 * phone's HLG picture a good stop too dark (reference white, 75% HLG, came
 * out at 76% grey; mobius gives 92% and only compresses the highlights).
 * The input's description is spelled out because zscale cannot work from a
 * file that leaves part of it unsaid.
 *
 * Without zscale, the colours are still converted from BT.2020 and the file
 * labelled BT.709. HLG was designed to look acceptable read that way; PQ
 * will look flat, but plays everywhere.
 */
export function hdrToSdr(colour: ColourInfo | undefined, toneMapping: boolean): string {
  if (!isHdr(colour)) return "";
  const transfer = colour!.transfer!;
  if (toneMapping) {
    const input = [
      `tin=${transfer}`,
      `min=${ZSCALE_MATRIX[colour!.matrix ?? ""] ?? "bt2020nc"}`,
      `pin=${colour!.primaries === "bt709" ? "bt709" : "bt2020"}`,
      `rin=${colour!.range === "pc" ? "pc" : "tv"}`,
    ].join(":");
    return [
      `zscale=${input}:t=linear:npl=100`,
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=tonemap=mobius:desat=0",
      "zscale=t=bt709:m=bt709:r=tv",
      "format=yuv420p",
      TAG_BT709,
    ].join(",");
  }
  // The colorspace filter knows BT.2020 but not the HLG/PQ curves, so the
  // curve is read as BT.2020's own SDR one: the primaries and matrix are
  // still converted properly.
  return [
    `colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:irange=${colour!.range === "pc" ? "pc" : "tv"}:range=tv:format=yuv420p`,
    TAG_BT709,
  ].join(",");
}
