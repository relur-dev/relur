import { describe, expect, it } from 'vitest';
import { EMPTY_PROMPT, holdsDraft, type PromptDraft, promptAfter } from './prompt-draft';

/** The prompt after each chunk in turn, typed 1 s apart unless given. */
const typed = (...chunks: (string | [string, number])[]): PromptDraft => {
  let p = EMPTY_PROMPT;
  let now = 0;
  for (const chunk of chunks) {
    const [data, at] = typeof chunk === 'string' ? [chunk, now + 1000] : chunk;
    now = at;
    p = promptAfter(p, data, now);
  }
  return p;
};
const draft = (...chunks: (string | [string, number])[]) => holdsDraft(typed(...chunks));

describe('promptAfter (spec §9.8)', () => {
  it('starts a draft with typed text and ends it with ↵', () => {
    expect(draft('f')).toBe(true);
    expect(draft('f', '\x1b[D')).toBe(true);
    expect(draft('f', '\r')).toBe(false);
    // A command such as /model sends no prompt hook, but ↵ sent it.
    expect(draft('/model sonnet\r')).toBe(false);
    expect(typed('one\rtwo').text).toBe('two');
  });

  it.each([
    ['\x1bOC'],
    ['\x1b'],
    ['\x03'],
    ['\r'],
    ['\x7f'],
    ['\x1b\r\x7f'],
    ['\x1b[Z'],
    ['\x1bb'],
    ['\x1b[200~\x1b[201~'],
    // Mouse reports: Claude Code turns on SGR (1006) and any-motion (1003) tracking.
    ['\x1b[<35;10;5M'],
    ['\x1b[<0;10;5M\x1b[<0;10;5m'],
    ['\x1b[<64;1;1M'],
    ['\x1b[M #!'],
    // Focus reports and the terminal's answers to queries.
    ['\x1b[I\x1b[O'],
    ['\x1b[?1;2c'],
    ['\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['\x1b]10;rgb:ffff/ffff/ffff\x07'],
    ['\x1bP>|xterm.js(6.0.0)\x1b\\'],
  ])('types nothing with %j', (data) => {
    expect(draft(data)).toBe(false);
  });

  it('ignores the mouse moving over the terminal, the wheel and focus reports', () => {
    expect(draft('\x1b[<35;40;12M')).toBe(false);
    expect(draft('x', '\x1b[<35;40;12M', '\x7f')).toBe(false);
    expect(draft('\x1b[<64;40;12M\x1b[I\x1b[O')).toBe(false);
    expect(draft('\x1b[<35;40;12Mx')).toBe(true);
  });

  it('keeps it through ⇧↵ and pasted line breaks', () => {
    expect(typed('a', '\x1b\r', 'b').text).toBe('a\nb');
    expect(typed('\x1b[200~line one\rline two\x1b[201~').text).toBe('line one\nline two');
    expect(draft('\x1b[200~\x1b[201~')).toBe(false);
    expect(typed('one\\', '\r').text).toBe('one\n');
  });

  it('ends it when the text is deleted again: ⌫, ⌃U, ⌃W, ⌃A ⌃K, Delete', () => {
    expect(draft('half a thought', '\x7f'.repeat(14))).toBe(false);
    expect(draft('half a thought', '\x7f'.repeat(13))).toBe(true);
    expect(draft('half a thought', '\x15')).toBe(false);
    expect(draft('half a thought', '\x17\x17\x17')).toBe(false);
    expect(draft('half a thought', '\x01\x0b')).toBe(false);
    expect(draft('ab', '\x1b[D\x1b[D', '\x1b[3~\x1b[3~')).toBe(false);
    // ⌫ at the start of the prompt deletes nothing.
    expect(draft('ab', '\x01', '\x7f\x7f')).toBe(true);
  });

  it('follows the cursor and the lines', () => {
    expect(typed('helo', '\x1b[D', 'l').text).toBe('hello');
    expect(typed('one two', '\x1b[1;3D', '\x0b').text).toBe('one ');
    // ⌃U deletes only the line the cursor is on.
    expect(typed('one', '\x1b\r', 'two', '\x15').text).toBe('one\n');
  });

  it('ends it with ⌃C, and with Esc Esc in quick succession, not with one Esc', () => {
    expect(draft('half a thought', '\x03')).toBe(false);
    expect(draft('half a thought', ['\x1b', 5000], ['\x1b', 5200])).toBe(false);
    expect(draft('half a thought', '\x1b\x1b')).toBe(false);
    expect(draft('half a thought', '\x1b')).toBe(true);
    expect(draft('half a thought', ['\x1b', 5000], ['\x1b', 5400])).toBe(true);
    expect(draft('half a thought', ['\x1b', 5000], ['x', 5100], ['\x1b', 5200])).toBe(true);
  });

  it('is unsure after keys it cannot follow, until the prompt is emptied for sure', () => {
    // ↑ may bring back a prompt from the history.
    expect(draft('\x1b[A')).toBe(true);
    expect(draft('\x1b[A', '\x7f\x7f\x7f')).toBe(true);
    expect(draft('\x1b[A', '\x03')).toBe(false);
    expect(draft('/mo', '\t')).toBe(true);
    expect(draft('\t')).toBe(false);
    expect(draft('ab', '\x1f')).toBe(true);
    // A click may put the cursor anywhere.
    expect(draft('ab', '\x1b[<0;3;4M', '\x7f\x7f')).toBe(true);
    expect(draft('ab', '\x1b[<0;3;4M', '\r')).toBe(false);
  });
});
