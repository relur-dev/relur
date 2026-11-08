import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The light theme's contrast (spec §6): text 4.5:1 on every surface, focus ring
 * and cursor 3:1, status colors apart from each other. Values are read from
 * theme.css, so a change to the palette is checked here.
 */
const css = fs.readFileSync(path.join(import.meta.dirname, 'theme.css'), 'utf8');

/** The custom properties declared in the block that starts with `opener`. */
function block(opener: string): Record<string, string> {
  const start = css.indexOf(opener);
  if (start < 0) throw new Error(`no ${opener} in theme.css`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1] as string] = m[2] as string;
  return vars;
}

const light = { ...block('@theme static {'), ...block(':root:not([data-theme="dark"]) {') };
const value = (name: string): string => {
  const v = light[name];
  if (!v) throw new Error(`no ${name} in the light theme`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? value(ref[1] as string) : v;
};

interface Oklch {
  L: number;
  C: number;
  h: number;
  a: number;
}
function parse(color: string): Oklch {
  const m = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
  if (!m) throw new Error(`not an oklch() color: ${color}`);
  const [, L, C, h, a] = m.map(Number) as number[];
  return { L: L as number, C: C as number, h: h as number, a: m[4] ? (a as number) : 1 };
}
const oklab = ({ L, C, h }: Oklch) => {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)] as const;
};
/** Linear sRGB, clamped to the gamut. */
function linear(c: Oklch): number[] {
  const [L, a, b] = oklab(c);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.max(0, Math.min(1, x)));
}
const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
/** Luminance of a token, a translucent one composited over `over` as the browser does. */
function luminance(name: string, over?: string): number {
  const c = parse(value(name));
  let lin = linear(c);
  if (c.a < 1) {
    if (!over) throw new Error(`${name} is translucent`);
    const back = linear(parse(value(over))).map(encode);
    lin = lin.map(encode).map((v, i) => decode(v * c.a + (back[i] as number) * (1 - c.a)));
  }
  const [r = 0, g = 0, b = 0] = lin;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
const contrast = (fg: string, bg: string, over?: string) =>
  ratio(luminance(fg), luminance(bg, over));

const SURFACES = ['chrome', 'canvas', 'surface', 'term', 'raised', 'selected'];
const TEXT = [
  'fg',
  'fg-muted',
  'fg-subtle',
  'st-permission',
  'st-input',
  'st-approval',
  'st-error',
  'diff-add',
  'diff-del',
  ...['blue', 'sky', 'teal', 'green', 'olive', 'graphite'].map((p) => `profile-${p}`),
];

describe('light theme contrast', () => {
  for (const text of TEXT) {
    it(`${text} reads at 4.5:1 on every surface`, () => {
      for (const surface of SURFACES) {
        expect(contrast(`--color-${text}`, `--color-${surface}`), surface).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  }

  it('text on filled controls, tinted rows and the Needs you column reads at 4.5:1', () => {
    const pairs: [string, string, string?][] = [
      ['on-fg', 'fg'],
      ['on-permission', 'st-permission'],
      ['on-fg', 'st-error'],
      ['st-permission', 'needs-bg'],
      ['fg-subtle', 'needs-bg'],
      ['st-input', 'needs-input-bg'],
      ['fg-subtle', 'needs-input-bg'],
      ['fg', 'term-sel', 'term'],
      ['fg', 'diff-add-bg', 'term'],
      ['fg', 'diff-del-bg', 'term'],
      ['diff-add', 'diff-add-bg', 'term'],
      ['diff-del', 'diff-del-bg', 'term'],
      ['fg-subtle', 'band-strong', 'canvas'],
    ];
    for (const [fg, bg, over] of pairs) {
      const c = contrast(`--color-${fg}`, `--color-${bg}`, over && `--color-${over}`);
      expect(c, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('focus ring and terminal cursor stand out at 3:1', () => {
    for (const surface of SURFACES) {
      expect(contrast('--color-focus', `--color-${surface}`), surface).toBeGreaterThanOrEqual(3);
    }
    expect(contrast('--color-term-cursor', '--color-term')).toBeGreaterThanOrEqual(3);
  });

  it('every ANSI color reads at 4.5:1 on the terminal', () => {
    for (let i = 0; i < 16; i++) {
      expect(contrast(`--term-ansi-${i}`, '--color-term'), `ANSI ${i}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('status glyph colors are clearly apart from each other and from the neutral ones', () => {
    // Working (fg-muted spinner) and Done (fg dot) are neutral; the shapes differ too.
    const glyphs = ['st-permission', 'st-input', 'st-approval', 'st-error', 'fg', 'fg-muted'];
    for (const [i, a] of glyphs.entries()) {
      for (const b of glyphs.slice(i + 1)) {
        const [x, y] = [oklab(parse(value(`--color-${a}`))), oklab(parse(value(`--color-${b}`)))];
        const distance = Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
        expect(distance, `${a} / ${b}`).toBeGreaterThanOrEqual(0.09);
      }
    }
  });
});
