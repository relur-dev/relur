import { describe, expect, it } from 'vitest';
import { readPromptLine, type Screen, type ScreenCell } from './prompt-line';

const RULE = '─'.repeat(60);
const NBSP = ' ';

/**
 * A screen from lines; text between `{` and `}` is dim (the placeholder), a
 * `|` marks the cursor and isn't drawn, `＊` is a wide character.
 */
function screen(lines: string[]): Screen {
  let cursorY = -1;
  let cursorX = -1;
  const rows = lines.map((source, y) => {
    const cells: ScreenCell[] = [];
    let dim = false;
    for (const ch of source) {
      if (ch === '{') dim = true;
      else if (ch === '}') dim = false;
      else if (ch === '|') {
        cursorY = y;
        cursorX = cells.length;
      } else if (ch === '＊') {
        cells.push({ chars: ch, width: 2, dim }, { chars: '', width: 0, dim });
      } else cells.push({ chars: ch === ' ' ? '' : ch, width: 1, dim });
    }
    // Lines are padded to the width with empty cells, as xterm's are.
    while (cells.length < 60) cells.push({ chars: '', width: 1, dim: false });
    return cells;
  });
  return { line: (y) => rows[y] ?? null, cursorY, cursorX };
}

describe('readPromptLine (spec §9.8)', () => {
  it('reads the text and cursor of the input box, as Claude Code 2.1.322 draws it', () => {
    const s = screen(['⏺ Done.', '', RULE, `❯${NBSP}half a thought|`, RULE, '  ⏵⏵ auto mode on']);
    expect(readPromptLine(s)).toEqual({ text: 'half a thought', cursor: 14, lines: 1 });
  });

  it('places the cursor inside the text, also after a wide character', () => {
    expect(readPromptLine(screen([RULE, `❯ ha|lf`, RULE]))).toEqual({
      text: 'half',
      cursor: 2,
      lines: 1,
    });
    expect(readPromptLine(screen([RULE, `❯ ＊a|b`, RULE]))?.cursor).toBe(2);
  });

  it('counts the dim placeholder and an empty prompt as no text', () => {
    expect(readPromptLine(screen([RULE, `❯${NBSP}|{Try "refactor <filepath>"}`, RULE]))).toEqual({
      text: '',
      cursor: 0,
      lines: 1,
    });
    expect(readPromptLine(screen([RULE, `❯ |`, RULE]))).toEqual({ text: '', cursor: 0, lines: 1 });
  });

  it('keeps spaces typed at the end, up to the cursor', () => {
    expect(readPromptLine(screen([RULE, '❯ word  |', RULE]))).toEqual({
      text: 'word  ',
      cursor: 6,
      lines: 1,
    });
  });

  it('joins further lines, indented by two spaces', () => {
    expect(readPromptLine(screen([RULE, '❯ first line', '  second| one', RULE]))).toEqual({
      text: 'first line\nsecond one',
      cursor: 17,
      lines: 2,
    });
  });

  it("finds nothing where the cursor isn't in Claude's input box", () => {
    // A menu: no rules around the cursor.
    expect(
      readPromptLine(screen(['Do you trust this folder?', '❯ 1. Yes|', '  2. No'])),
    ).toBeNull();
    // Output under the box, a shell prompt, a box without its `❯`.
    expect(readPromptLine(screen([RULE, '❯ text', RULE, 'output|']))).toBeNull();
    expect(readPromptLine(screen(['$ ls|']))).toBeNull();
    expect(readPromptLine(screen([RULE, '> text|', RULE]))).toBeNull();
    // The cursor on a rule, and a short line of dashes that isn't one.
    expect(readPromptLine(screen([`${RULE}|`, '❯ text', RULE]))).toBeNull();
    expect(readPromptLine(screen(['─────', '❯ text|', RULE]))).toBeNull();
  });
});
