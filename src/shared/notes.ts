import type { WorkspaceState } from './status';

/**
 * Notes per workspace (spec §6.15): a list of items written while Claude
 * works, kept in the state database, private until sent.
 */
export type NoteState = 'open' | 'held' | 'sent';

export interface Note {
  id: string;
  workspaceId: string;
  text: string;
  state: NoteState;
  createdAt: string;
  updatedAt: string;
  /** When it was held for Claude's turn to end; null otherwise. */
  heldAt: string | null;
  /** The prompt it went out in; null until sent. */
  sendId: string | null;
  /** When that prompt was sent; null until sent. */
  sentAt: string | null;
}

/** A workspace's unsent items, for the mark on Home's Board and List (spec §6.7). */
export interface NoteCounts {
  /** Open and held items. */
  unsent: number;
  /** Of them, held until Claude is done. */
  held: number;
}

/** Longest note kept; a paste of a whole file fits. */
export const NOTE_MAX = 100_000;

/**
 * The prompt for one or more items (spec §6.15): one item as written;
 * several as a numbered list in the given order, each item its own point,
 * its further lines indented so Markdown keeps them in it, blank lines
 * between points.
 */
export function composePrompt(texts: readonly string[]): string {
  const items = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (items.length <= 1) return items[0] ?? '';
  return items
    .map((text, i) => {
      const lead = `${i + 1}. `;
      const indent = ' '.repeat(lead.length);
      return text
        .split('\n')
        .map((line, j) => (j === 0 ? `${lead}${line}` : line.trim() ? `${indent}${line}` : ''))
        .join('\n');
    })
    .join('\n\n');
}

/** What a held send waits on, or that it can go (spec §6.15). */
export interface HeldSendFacts {
  /** The workspace's state as shown: Awaiting approval at a gate. */
  state: WorkspaceState;
  /** The gate's label at a gate. */
  gate: string | null;
  /** The workspace's Claude session: null when it has none. */
  claude: { status: 'running' | 'suspended' | 'exited'; resuming: boolean } | null;
  /** Text typed into Claude's prompt and not sent (spec §9.8). */
  draft: boolean;
  /** Claude waits on its question tool. */
  question: boolean;
  /** Claude's turn ended with a question in its text ("Claude asked: …"). */
  asked: boolean;
}

export type HeldSendDecision = { send: true } | { send: false; waiting: string };

/** While Claude is still in its turn: nothing is in the way yet. */
export const QUEUED = 'Queued · sends when Claude is done';

/**
 * Whether held items go now (spec §6.15): only when Claude has finished its
 * turn (Done) and a quick reply could go, never into a permission menu, a
 * question or over a draft; never resuming a suspended Claude. Otherwise
 * what they wait on: Claude's turn, its question, a gate, an interrupt.
 */
export function heldSendDecision(f: HeldSendFacts): HeldSendDecision {
  const wait = (waiting: string): HeldSendDecision => ({ send: false, waiting });
  if (!f.claude || f.claude.status === 'exited') return wait("Waiting: Claude isn't running");
  if (f.question) return wait('Waiting: Claude asked a question');
  switch (f.state) {
    case 'needs-permission':
      return wait('Waiting: Claude is asking for permission');
    case 'needs-answer':
      return wait('Waiting: Claude asked a question');
    case 'awaiting-approval':
      return wait(`Waiting: Claude is at ${f.gate ?? 'a gate'}`);
    case 'interrupted':
      return wait('Waiting: you interrupted Claude; sends after its next turn');
    case 'needs-input':
      return wait('Waiting: Claude is waiting for your answer');
    case 'done':
      break;
    default:
      return wait(QUEUED);
  }
  if (f.claude.status === 'suspended' || f.claude.resuming) {
    return wait('Waiting: Claude is suspended; sends once it resumes');
  }
  if (f.asked) return wait('Waiting: Claude asked something');
  if (f.draft) return wait('Waiting: an unsent prompt in the terminal');
  return { send: true };
}

/** A prompt as compared: whitespace collapsed, trimmed. */
export const sameText = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * The parts of a Responses entry the matching needs (spec §6.15): its
 * prompt's id and text, and prompts sent while Claude worked, which Claude
 * Code takes into the running turn (`queued_command`).
 */
export interface MatchEntry {
  /** The prompt's transcript id (`uuid`), else its line; null without a prompt. */
  id: string | null;
  prompt: string | null;
  /** When the prompt was sent, if the transcript says. */
  promptAt: string | null;
  queued: readonly { id: string; text: string; at: string | null }[];
}

export interface MatchSend {
  id: string;
  text: string;
  sentAt: string;
  /** The transcript id it was matched to; null until found. */
  ref: string | null;
}

/** A send matches a prompt written no earlier than this before it was sent. */
export const MATCH_SLACK_MS = 5_000;

/**
 * Finds each unmatched send's prompt in the transcript's entries (spec
 * §6.15): the first prompt, or prompt taken in while Claude worked, with the
 * same text, written no earlier than shortly before the send, that no other
 * send has. Sends are matched oldest first. Gives the new matches by send id.
 */
export function matchSends(
  entries: readonly MatchEntry[],
  sends: readonly MatchSend[],
): Map<string, string> {
  const taken = new Set(sends.flatMap((s) => (s.ref ? [s.ref] : [])));
  const candidates = entries.flatMap((e) => [
    ...(e.id && e.prompt !== null ? [{ id: e.id, text: e.prompt, at: e.promptAt }] : []),
    ...e.queued,
  ]);
  const found = new Map<string, string>();
  const open = sends.filter((s) => !s.ref).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  for (const send of open) {
    const from = Date.parse(send.sentAt) - MATCH_SLACK_MS;
    const hit = candidates.find(
      (c) =>
        !taken.has(c.id) &&
        sameText(c.text, send.text) &&
        (c.at === null || !(Date.parse(c.at) < from)),
    );
    if (!hit) continue;
    taken.add(hit.id);
    found.set(send.id, hit.id);
  }
  return found;
}

/** The entry (0-based) a matched prompt is in; null when it isn't in these entries. */
export function entryOf(entries: readonly MatchEntry[], ref: string): number | null {
  const index = entries.findIndex((e) => e.id === ref || e.queued.some((q) => q.id === ref));
  return index === -1 ? null : index;
}
