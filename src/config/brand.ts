/**
 * Leen brand palette.
 *
 * These are the official values from the brand colour sheet, not sampled
 * approximations.
 *
 * Blue, green and white are the primaries and should carry every theme. The
 * supporting navies and teals exist to give depth; the warm and red accents are
 * deliberately last and should stay rare — a single highlight, never a field.
 */

export const BRAND = {
  /* ---- primary ---- */
  blue: "#33AFD5",
  green: "#8BB942",
  white: "#FFFFFF",
  /** Off-white with a blue cast. The "white" to use on screen, not pure #FFF. */
  paper: "#D7E1F2",

  /* ---- supporting: structure and depth ---- */
  /** Deepest navy. The dark backdrop for every dark theme. */
  ink: "#041730",
  inkSoft: "#0A2444",
  navy: "#3B4D81",
  indigo: "#5060A5",
  teal: "#217C6C",
  mint: "#6FCFBD",

  /* ---- accents: use sparingly, never as a background field ---- */
  gold: "#C7A057",
  yellow: "#FFD105",
  crimson: "#A02932",
  red: "#D71920",

  /** Ink colour for text sitting on white or paper. */
  onLight: "#041730",
} as const;

/**
 * The house gradient: blue into green, the two primaries. Everything that
 * should read as "Leen" uses this and nothing else.
 */
export const BRAND_RAMP: Array<[number, string]> = [
  [0.0, BRAND.indigo],
  [0.28, BRAND.blue],
  [0.62, BRAND.teal],
  [1.0, BRAND.green],
];

/** Three-stop version for the progress bar, which takes exactly three. */
export const BRAND_PROGRESS: [string, string, string] = [BRAND.blue, BRAND.teal, BRAND.green];

/** Same ramp for light themes, where it sits on white and needs more contrast. */
export const BRAND_PROGRESS_LIGHT: [string, string, string] = [
  BRAND.navy,
  BRAND.teal,
  BRAND.green,
];

export function rgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mixes two brand hexes. Handy for deriving a tint without inventing a colour. */
export function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const c = hex.replace("#", "");
    return [
      parseInt(c.slice(0, 2), 16),
      parseInt(c.slice(2, 4), 16),
      parseInt(c.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const to = (x: number) => Math.round(x).toString(16).padStart(2, "0");
  return `#${to(r1 + (r2 - r1) * t)}${to(g1 + (g2 - g1) * t)}${to(b1 + (b2 - b1) * t)}`;
}
