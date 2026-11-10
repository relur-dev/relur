/**
 * What Claude's prompt shows on screen (spec §9.8): its input box, read from
 * the terminal's buffer. Claude Code (checked live with 2.1.322, classic and
 * full-screen renderer) draws it as a full-width rule, `❯` and a space (a
 * no-break space) with the text, further lines indented by two spaces, and
 * another rule, with the cursor in it while it waits for typed text. An empty
 * prompt shows a dim placeholder (`Try "…"`); typed text isn't dim.
 */

/** One cell of the terminal's screen. */
export interface ScreenCell {
  chars: string;
  /** 0 for the second cell of a wide character. */
  width: number;
  dim: boolean;
}

/** The part of a terminal's buffer the prompt is read from. */
export interface Screen {
  /** The line's cells; null past the buffer. */
  line(y: number): readonly ScreenCell[] | null;
  /** The cursor's line in the buffer and its column. */
  cursorY: number;
  cursorX: number;
}

export interface PromptLine {
  /** The prompt's text, lines joined with `\n`; empty for the placeholder. */
  text: string;
  /** Where the cursor is in `text`. */
  cursor: number;
  /** How many screen lines it takes: more than one may be a wrapped line, not `\n`. */
  lines: number;
}

/** How far from the cursor the box's rules may be. */
const MAX_LINES = 40;
/** A rule is this long at least, and nothing but `─`. */
const MIN_RULE = 20;

const textOf = (cells: readonly ScreenCell[]) =>
  cells
    .filter((c) => c.width > 0)
    .map((c) => c.chars || ' ')
    .join('');

const isRule = (cells: readonly ScreenCell[] | null): boolean => {
  if (!cells) return false;
  const text = textOf(cells).trim();
  return text.length >= MIN_RULE && /^─+$/.test(text);
};

/** `❯` and a space, then the text. */
const PROMPT = /^❯[  ]/;

/**
 * Claude's input box at the cursor, or null when the cursor isn't in one
 * (a menu, the trust prompt, a working Claude's output, or another program).
 */
export function readPromptLine(screen: Screen): PromptLine | null {
  const { cursorY, cursorX } = screen;
  if (isRule(screen.line(cursorY))) return null;
  let top = cursorY;
  while (top > cursorY - MAX_LINES && !isRule(screen.line(top - 1))) {
    if (!screen.line(top - 1)) return null;
    top--;
  }
  if (!isRule(screen.line(top - 1))) return null;
  let bottom = cursorY;
  while (bottom < cursorY + MAX_LINES && !isRule(screen.line(bottom + 1))) {
    if (!screen.line(bottom + 1)) return null;
    bottom++;
  }
  if (!isRule(screen.line(bottom + 1))) return null;
  const rows: ScreenCell[][] = [];
  for (let y = top; y <= bottom; y++) rows.push([...(screen.line(y) ?? [])]);
  const first = rows[0] ?? [];
  if (!PROMPT.test(textOf(first.slice(0, 2)))) return null;
  // Each line's text past its two columns of `❯ ` or indent.
  const content = rows.map((cells) => cells.slice(2));
  const shown = content.flat().filter((c) => c.width > 0 && c.chars.trim() !== '');
  const lines = rows.length;
  // Only the dim placeholder: an empty prompt.
  if (shown.length === 0 || shown.every((c) => c.dim)) return { text: '', cursor: 0, lines };
  const texts = content.map((cells) => textOf(cells).trimEnd());
  // The cursor past the text: spaces typed at its end.
  const row = cursorY - top;
  const before = textOf((content[row] ?? []).slice(0, Math.max(0, cursorX - 2)));
  const at = before.length;
  if (at > (texts[row] ?? '').length) texts[row] = (texts[row] ?? '').padEnd(at, ' ');
  const cursor = texts.slice(0, row).reduce((n, t) => n + t.length + 1, 0) + at;
  return { text: texts.join('\n'), cursor, lines };
}
