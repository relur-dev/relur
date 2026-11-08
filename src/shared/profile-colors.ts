/**
 * The fixed profile palette (spec §3.1). The config stores a color name; the
 * theme maps it to light and dark values (`--color-profile-<name>`). The
 * picker shows it as one row, in this order.
 */
export const PROFILE_COLORS = [
  'blue',
  'sky',
  'teal',
  'green',
  'olive',
  'graphite',
  'indigo',
  'slate',
  'petrol',
  'pine',
  'plum',
  'charcoal',
] as const;

export type ProfileColor = (typeof PROFILE_COLORS)[number];

export const FALLBACK_PROFILE_COLOR: ProfileColor = 'graphite';

export function isProfileColor(value: unknown): value is ProfileColor {
  return (PROFILE_COLORS as readonly unknown[]).includes(value);
}

/** The name a color is shown with: tooltip and accessible label. */
export const profileColorLabel = (color: ProfileColor): string =>
  color.charAt(0).toUpperCase() + color.slice(1);

/**
 * Hues (OKLCH degrees) of the first palette's colored entries. Only these:
 * a `#rrggbb` value predates the palette, so it keeps mapping as it always has.
 */
const PALETTE_HUES: [ProfileColor, number][] = [
  ['blue', 258],
  ['sky', 228],
  ['teal', 190],
  ['green', 148],
  ['olive', 115],
];

/** Below this OKLCH chroma a color reads as grey. */
const GREY_CHROMA = 0.04;

const HEX = /^#([0-9a-f]{6})$/i;

/** sRGB hex to OKLCH chroma and hue (Björn Ottosson's OKLab matrices). */
function hexToChromaHue(hex: string): { chroma: number; hue: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(A, B), hue: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/**
 * The palette name for a stored value: names pass through, `#rrggbb` values
 * (configs from before the palette) map to the name with the nearest hue, or
 * graphite if they are grey, and anything else falls back to graphite.
 */
export function toProfileColor(value: unknown): ProfileColor {
  if (isProfileColor(value)) return value;
  if (typeof value !== 'string' || !HEX.test(value)) return FALLBACK_PROFILE_COLOR;
  const { chroma, hue } = hexToChromaHue(value);
  if (chroma < GREY_CHROMA) return 'graphite';
  const distance = (h: number) => Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
  let best = PALETTE_HUES[0] as [ProfileColor, number];
  for (const entry of PALETTE_HUES) if (distance(entry[1]) < distance(best[1])) best = entry;
  return best[0];
}
