import { BRAND } from './brand';
import type { WorkspaceState } from './status';

/**
 * Suspending idle Claude sessions to save memory (spec §9.8): when a session
 * may be suspended, and the profile's choices.
 */

/** Edit profile › General's choices, in minutes. */
export const SUSPEND_CHOICES = [5, 10, 30] as const;
export type SuspendChoice = (typeof SUSPEND_CHOICES)[number];

/** What `suspendIdleMin` stores: a choice, or 0 for an explicit Off (spec §9.8). */
export type SuspendSetting = 0 | SuspendChoice;

/** The delay of a profile that never chose one: new profiles and those from before. */
export const DEFAULT_SUSPEND_MIN = 10 satisfies SuspendChoice;

/**
 * A profile's delay in minutes, or null when suspension is off: 0 is Off,
 * and a profile that never chose gets the default (spec §9.8).
 */
export function suspendDelay(profile: {
  suspendIdleMin?: SuspendSetting | null;
}): SuspendChoice | null {
  const stored = profile.suspendIdleMin;
  if (stored === 0) return null;
  return stored ?? DEFAULT_SUSPEND_MIN;
}

/**
 * The one-time notice after the update that turned suspension on by default
 * (spec §9.8), naming the profiles it changed when there are several.
 */
export function suspendDefaultNotice(profiles: readonly string[]): string {
  const text = `${BRAND.displayName} now suspends Claude sessions you haven't used for ${DEFAULT_SUSPEND_MIN} minutes, to save memory. They resume when you open them.`;
  return profiles.length > 1 ? `${text} Profiles: ${listOf(profiles)}.` : text;
}

const listOf = (names: readonly string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/** The mark's tooltip on the sidebar row, on a Board card and on a tab (spec §9.8). */
export const SUSPENDED_TOOLTIP = 'Suspended to save memory; resumes when you open it';

/**
 * Above a Claude terminal that started a new conversation because there was
 * none saved to resume (spec §9.8).
 */
export const NEW_CONVERSATION_NOTE =
  'There was no saved conversation to resume, so Claude started a new one.';

/** How long a resume waits for Claude's SessionStart before it counts as ready (spec §9.8). */
export const RESUME_READY_MS = 20_000;

/** What decides whether a running Claude session may be suspended now. */
export interface SuspendFacts {
  /** The profile's delay in minutes; null when suspension is off. */
  delayMin: number | null;
  /** Its workspace, or its main-checkout tab, is shown in a visible window. */
  shown: boolean;
  /** Its state from hooks (spec §10.2). Awaiting approval is worked out from Done or Waiting. */
  state: WorkspaceState;
  /** Claude's SessionStart arrived since it was started or resumed. */
  started: boolean;
  /** Claude's background tasks still running at the last Stop (spec §10.2). */
  background: number;
  /** Marked Keep running. */
  keepRunning: boolean;
  /** Text typed into Claude's prompt since the last prompt was sent. */
  draft: boolean;
  /** Being resumed: Claude isn't ready yet. */
  resuming: boolean;
  /**
   * Claude has saved its conversation (its transcript file exists): it writes
   * none before the first prompt, and a resume without one fails.
   */
  conversation: boolean;
}

export type SuspendBlocker =
  | 'off'
  | 'shown'
  | 'busy'
  | 'background'
  | 'kept'
  | 'draft'
  | 'resuming'
  | 'no-conversation';

/** Idle states: Claude waits at its prompt (spec §9.8). */
const IDLE_STATES: readonly WorkspaceState[] = ['done', 'needs-input', 'interrupted'];

/**
 * Why the session can't be suspended now, or null when it may be. Never while
 * Claude works or asks for permission; a Claude in Starting only once its
 * SessionStart arrived (it was resumed or started and waits); never before
 * Claude saved a conversation to resume.
 */
export function suspendBlocker(facts: SuspendFacts): SuspendBlocker | null {
  if (facts.delayMin === null) return 'off';
  if (facts.resuming) return 'resuming';
  if (facts.keepRunning) return 'kept';
  if (facts.shown) return 'shown';
  const idle = IDLE_STATES.includes(facts.state) || (facts.state === 'starting' && facts.started);
  if (!idle) return 'busy';
  if (facts.background > 0) return 'background';
  if (facts.draft) return 'draft';
  if (!facts.conversation) return 'no-conversation';
  return null;
}

/**
 * Whether a session that may be suspended since `eligibleSince` has been so
 * for the whole delay.
 */
export function suspendDue(
  eligibleSince: number,
  now: number,
  delayMin: number,
  minuteMs = 60_000,
): boolean {
  return now - eligibleSince >= delayMin * minuteMs;
}

/**
 * Escape sequences a terminal view sends: strings (OSC, DCS, APC, PM, SOS: the
 * terminal's answers to queries), X10 mouse reports (ESC [ M and three bytes),
 * CSI with any parameter bytes (SGR mouse reports `ESC [ < 35 ; 10 ; 5 M`,
 * focus `ESC [ I`, arrows), SS3 keys and Alt+key.
 */
const SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC.
  /\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.|\x1b./g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control keys aren't text.
const TEXT = /[^\x00-\x1f\x7f]/;

/**
 * Whether keys from a terminal view type text into Claude's prompt (a draft,
 * spec §9.8): printable characters, pasted text included. Escape sequences
 * (arrow keys, the paste markers, Alt+key, Esc, mouse reports and the
 * terminal's answers to queries), Enter, Backspace and other control keys
 * (⌃C) aren't.
 */
export function typesText(data: string): boolean {
  return TEXT.test(data.replace(SEQUENCES, ''));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the paste markers start with ESC.
const PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC ↵ is a new line in the prompt.
const NEW_LINE = /\x1b\r/g;

/**
 * Whether Claude's prompt holds a draft after these keys (spec §9.8): typed
 * text makes one; ↵ sends what is there (a prompt or a command such as
 * /model) and ends it, while ⇧↵ (ESC ↵) and pasted line breaks only add lines.
 */
export function draftAfter(draft: boolean, data: string): boolean {
  const keys = data
    .replace(PASTE, (pasted) => (typesText(pasted) ? 'x' : ''))
    .replace(NEW_LINE, 'x');
  const sent = keys.lastIndexOf('\r');
  if (sent >= 0) return typesText(keys.slice(sent + 1));
  return draft || typesText(keys);
}

/** Why a running Claude isn't suspended, for app.log and a Board card's tooltip (spec §9.8). */
export const BLOCKER_TEXT: Record<SuspendBlocker, string> = {
  off: 'suspension is off',
  resuming: 'resuming',
  kept: 'Keep Claude Running is on',
  shown: 'shown in a window',
  busy: "Claude isn't idle",
  background: 'background work running',
  draft: 'a draft in the prompt',
  'no-conversation': 'no conversation yet',
};

/** What a running Claude's idle clock says now (spec §9.8). */
export interface SuspendClock {
  workspaceId: string;
  /** Why it isn't suspended; null while its clock runs. */
  blocker: SuspendBlocker | null;
  /** When it will be suspended (ms since the epoch) while its clock runs. */
  dueAt: number | null;
}

/**
 * A Board card's tooltip on a running Claude's state (spec §9.8):
 * "Not suspended: a draft in the prompt", or "Suspended in 3 min if it stays
 * idle"; nothing while suspension is off.
 */
export function suspendClockNote(clock: SuspendClock, now: number): string | null {
  if (clock.blocker === 'off') return null;
  if (clock.blocker) return `Not suspended: ${BLOCKER_TEXT[clock.blocker]}`;
  if (clock.dueAt === null) return null;
  const min = Math.max(1, Math.ceil((clock.dueAt - now) / 60_000));
  return `Suspended in ${min} min if it stays idle`;
}

/** "2 sessions suspended", for the memory tooltip and the project view (spec §6.14). */
export const suspendedNote = (count: number): string =>
  `${count} ${count === 1 ? 'session' : 'sessions'} suspended`;
