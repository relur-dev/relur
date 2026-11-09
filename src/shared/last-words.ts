import type { PendingQuestion } from './question';

/**
 * What a Board card shows above its quick reply (spec §6.7): what Claude last
 * said, so the reply has something to answer.
 */
export interface LastWords {
  /** A question Claude waits on, Claude's words at a gate (or its hint), or its last message. */
  kind: 'question' | 'gate' | 'said';
  /**
   * The lead-in: "Claude asked:", "At Spec review, Claude:", "Claude:"; empty
   * for a gate's hint, as the status already names the gate.
   */
  lead: string;
  /** Plain text, one paragraph; the card shows two lines of it. */
  text: string;
  /** The Responses entry it is from (0-based), to open the panel there; null for a gate's hint. */
  entry: number | null;
  /** The question Claude waits on, with its options; null otherwise. */
  question: PendingQuestion | null;
}

/** The parts of the transcript's entries `chooseLastWords` needs. */
export interface LastWordsEntry {
  parts: readonly { text: string; question?: true }[];
}

export interface LastWordsContext {
  /** The question Claude waits on, from the transcript. */
  pending: PendingQuestion | null;
  /** At a workflow gate (spec §13.5): its label and hint. */
  gate: { label: string; hint: string | null } | null;
}

/** Longest text kept; the card shows two lines and the tooltip the rest. */
const MAX = 400;

/**
 * Markdown as plain text for one line of a card: no code fences, headings,
 * emphasis, inline code marks, link targets, list or quote marks, and
 * whitespace collapsed.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The end of a message: its last paragraph with text, as plain text. */
export function lastParagraph(markdown: string): string {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map(plainText)
    .filter((p) => p.length > 0);
  const last = paragraphs.at(-1) ?? '';
  return last.length > MAX ? `…${last.slice(-(MAX - 1)).trimStart()}` : last;
}

/**
 * What the card shows (spec §6.7): the question Claude waits on; at a gate,
 * the end of Claude's last message, else the gate's hint alone; otherwise the end of
 * Claude's last message ("Claude asked:" when it ends with a question mark).
 * Null when there is nothing yet (a fresh session).
 */
export function chooseLastWords(
  entries: readonly LastWordsEntry[],
  { pending, gate }: LastWordsContext,
): LastWords | null {
  if (pending) {
    const [first] = pending.questions;
    const more = pending.questions.length - 1;
    return {
      kind: 'question',
      lead: 'Claude asked:',
      text: `${first?.question ?? ''}${more > 0 ? ` (+${more} more)` : ''}`,
      entry: entries.length > 0 ? entries.length - 1 : null,
      question: pending,
    };
  }
  // The newest entry with a message; a question already answered isn't one.
  let said: { text: string; entry: number } | null = null;
  for (let i = entries.length - 1; i >= 0 && !said; i--) {
    const parts = (entries[i] as LastWordsEntry).parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as LastWordsEntry['parts'][number];
      const text = part.question ? '' : lastParagraph(part.text);
      if (text) {
        said = { text, entry: i };
        break;
      }
    }
  }
  if (gate) {
    if (said) return { kind: 'gate', lead: `At ${gate.label}, Claude:`, ...said, question: null };
    if (gate.hint) {
      return {
        kind: 'gate',
        lead: '',
        text: gate.hint,
        entry: null,
        question: null,
      };
    }
    return null;
  }
  if (!said) return null;
  return {
    kind: 'said',
    lead: said.text.endsWith('?') ? 'Claude asked:' : 'Claude:',
    ...said,
    question: null,
  };
}
