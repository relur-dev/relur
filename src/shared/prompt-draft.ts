import type { PromptLine } from './prompt-line';

/**
 * What Claude's prompt holds, followed from the keys typed into its view
 * (spec §9.8): its text and cursor, as Claude Code edits them. Keys whose
 * effect can't be known (the history on ↑, completion on ⇥, undo, a click)
 * make it `unsure`: a draft until ↵, ⌃C or Esc Esc empty the prompt, or
 * the screen shows what it holds (`promptShown`).
 * Checked live with Claude Code 2.1.322: ⌫, ⌃U, ⌃W, ⌃K and ⌃C clear it, a
 * single Esc doesn't, Esc Esc does when the two come within ~350 ms.
 */
export interface PromptDraft {
  text: string;
  cursor: number;
  unsure: boolean;
  /** When the last key was Esc; null after any other key. */
  escAt: number | null;
}

export const EMPTY_PROMPT: PromptDraft = { text: '', cursor: 0, unsure: false, escAt: null };

/** Esc Esc empties the prompt when the second comes this soon (below what Claude Code takes). */
export const DOUBLE_ESC_MS = 300;

/** Whether the prompt holds text that isn't sent, or might. */
export const holdsDraft = (p: PromptDraft): boolean => p.unsure || p.text.length > 0;

const KEY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC.
  /\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1b\[M[\s\S]{3}|\x1b\[([0-?]*)[ -/]*([@-~])|\x1bO(.)|\x1b([^\x1b])|\x1b|[\s\S]/gu;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control keys aren't text.
const CONTROL = /^[\x00-\x1f\x7f]$/;

const lineStart = (p: PromptDraft) => p.text.lastIndexOf('\n', p.cursor - 1) + 1;
const lineEnd = (p: PromptDraft) => {
  const end = p.text.indexOf('\n', p.cursor);
  return end === -1 ? p.text.length : end;
};
/** Where a word ends going back from the cursor: spaces, then the word. */
const wordBack = (p: PromptDraft) => {
  let i = p.cursor;
  while (i > 0 && /\s/.test(p.text[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(p.text[i - 1] ?? '')) i--;
  return i;
};
const wordForward = (p: PromptDraft) => {
  let i = p.cursor;
  while (i < p.text.length && /\s/.test(p.text[i] ?? '')) i++;
  while (i < p.text.length && !/\s/.test(p.text[i] ?? '')) i++;
  return i;
};

const insert = (p: PromptDraft, s: string): PromptDraft => ({
  ...p,
  text: p.text.slice(0, p.cursor) + s + p.text.slice(p.cursor),
  cursor: p.cursor + s.length,
});
/** Removes the text between the cursor and `to`. */
const cut = (p: PromptDraft, to: number): PromptDraft => {
  const [from, end] = to < p.cursor ? [to, p.cursor] : [p.cursor, to];
  return { ...p, text: p.text.slice(0, from) + p.text.slice(end), cursor: from };
};
const move = (p: PromptDraft, to: number): PromptDraft => ({
  ...p,
  cursor: Math.max(0, Math.min(p.text.length, to)),
});
/** Its effect isn't known: a draft until the prompt is emptied for sure. */
const unsure = (p: PromptDraft): PromptDraft => ({ ...p, unsure: true });

/** A CSI key: arrows (with ⌥ or ⌃ by word), Home, End, Delete; mouse and answers change nothing. */
function csi(p: PromptDraft, params: string, final: string): PromptDraft {
  const mod = params.split(';')[1];
  const byWord = mod === '3' || mod === '5' || mod === '9';
  switch (final) {
    case 'D':
      return byWord ? move(p, wordBack(p)) : move(p, p.cursor - 1);
    case 'C':
      return byWord ? move(p, wordForward(p)) : move(p, p.cursor + 1);
    // ↑ and ↓ move between lines or bring back the history.
    case 'A':
    case 'B':
      return unsure(p);
    case 'H':
      return move(p, lineStart(p));
    case 'F':
      return move(p, lineEnd(p));
    case '~':
      if (params === '1' || params === '7') return move(p, lineStart(p));
      if (params === '4' || params === '8') return move(p, lineEnd(p));
      if (params === '3') return cut(p, p.cursor + 1);
      return p;
    case 'M':
      // SGR mouse: a press (not a move, not the wheel) may put the cursor elsewhere.
      if (params.startsWith('<')) {
        const button = Number(params.slice(1).split(';')[0]);
        if (button < 32 && p.text.length > 0) return unsure(p);
      }
      return p;
    default:
      return p;
  }
}

/** A control key. */
function control(p: PromptDraft, key: string): PromptDraft {
  switch (key) {
    case '\r': {
      // A backslash before ↵ makes a new line, as Claude Code does; else ↵ sends.
      if (!p.unsure && p.text[p.cursor - 1] === '\\') return insert(cut(p, p.cursor - 1), '\n');
      return EMPTY_PROMPT;
    }
    case '\n':
      return insert(p, '\n');
    case '\x03': // ⌃C
      return EMPTY_PROMPT;
    case '\x7f':
    case '\b':
      return cut(p, p.cursor - 1);
    case '\x04': // ⌃D
      return cut(p, p.cursor + 1);
    case '\x17': // ⌃W
      return cut(p, wordBack(p));
    case '\x15': // ⌃U
      return cut(p, lineStart(p));
    case '\x0b': // ⌃K
      return cut(p, lineEnd(p));
    case '\x01':
      return move(p, lineStart(p));
    case '\x05':
      return move(p, lineEnd(p));
    case '\x02':
      return move(p, p.cursor - 1);
    case '\x06':
      return move(p, p.cursor + 1);
    case '\t':
      return p.text.length > 0 ? unsure(p) : p;
    // ⌃Y yank, ⌃_ undo, ⌃R history search, ⌃G editor, ⌃V paste an image.
    case '\x19':
    case '\x1f':
    case '\x12':
    case '\x07':
    case '\x16':
      return unsure(p);
    default:
      return p;
  }
}

/**
 * The prompt as Claude's screen shows it (spec §9.8), which wins over the
 * keys: exact on one line; over several lines, or with a paste Claude shows
 * as `[Pasted text …]`, its text may differ from what the keys would edit, so
 * it stays unsure until the screen shows it again.
 */
export function promptShown(p: PromptDraft, line: PromptLine): PromptDraft {
  if (line.text === '') return { ...EMPTY_PROMPT, escAt: p.escAt };
  const approximate = line.lines > 1 || /\[(Pasted text|Image)\b/.test(line.text);
  return { text: line.text, cursor: line.cursor, unsure: approximate, escAt: p.escAt };
}

/** The prompt after these keys from a view, typed at `now` (ms). */
export function promptAfter(prompt: PromptDraft, data: string, now: number): PromptDraft {
  let p = prompt;
  for (const m of data.matchAll(KEY)) {
    const [key, pasted, params, final, ss3, alt] = m;
    const escAt = p.escAt;
    p = { ...p, escAt: null };
    if (pasted !== undefined) p = insert(p, pasted.replace(/\r\n?/g, '\n'));
    else if (final !== undefined) p = csi(p, params ?? '', final);
    else if (ss3 !== undefined) p = csi(p, '', ss3);
    else if (key === '\x1b') {
      // Esc; a second one soon after empties the prompt.
      p = escAt !== null && now - escAt <= DOUBLE_ESC_MS ? EMPTY_PROMPT : { ...p, escAt: now };
    } else if (alt !== undefined) {
      if (alt === '\r')
        p = insert(p, '\n'); // ⇧↵
      else if (alt === '\x7f') p = cut(p, wordBack(p));
      else if (alt === 'b') p = move(p, wordBack(p));
      else if (alt === 'f') p = move(p, wordForward(p));
      else if (alt === 'd') p = cut(p, wordForward(p));
    } else if (key.startsWith('\x1b')) {
      // OSC, DCS and the like: the terminal's answers, not keys.
    } else if (CONTROL.test(key)) p = control(p, key);
    else p = insert(p, key);
  }
  return p;
}
