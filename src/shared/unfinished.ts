import { BRAND } from './brand';
import { glyphFor, type StatusGlyph, type WorkspaceState } from './status';
import type { UsageSnapshot } from './usage';

/**
 * Why Claude didn't finish when the app stopped (spec §9.7): it was working
 * (also while waiting for its own background agents), the user had pressed
 * Esc, it was asking for permission or asking a question, or it was Done
 * while commands it started in the background still ran, which the stop ended.
 */
export type UnfinishedKind = 'working' | 'interrupted' | 'permission' | 'question' | 'commands';

/** A workspace's Unfinished marker (spec §9.7). */
export interface Unfinished {
  kind: UnfinishedKind;
  /** When the app stopped (for a crash: the workspace's last activity). */
  since: string;
  /** For `commands`: how many of Claude's background commands the stop ended; else 0. */
  stopped: number;
}

/**
 * Whether a workspace in this state when the app stops counts as unfinished,
 * and why (spec §9.7). Waiting for input doesn't count, nor does a gate
 * (Awaiting approval is worked out from Done or Waiting for input); Done
 * counts only while Claude's background commands still ran (`background`, §10.2).
 */
export function unfinishedKind(state: WorkspaceState, background = 0): UnfinishedKind | null {
  switch (state) {
    case 'working':
      return 'working';
    case 'interrupted':
      return 'interrupted';
    case 'needs-permission':
      return 'permission';
    case 'needs-answer':
      return 'question';
    case 'done':
      return background > 0 ? 'commands' : null;
    default:
      return null;
  }
}

/** "1 background command was stopped", "2 background commands were stopped". */
export const stoppedNote = (n: number) =>
  n === 1 ? '1 background command was stopped' : `${n} background commands were stopped`;

/** The default continue prompt (spec §3.1, §9.7). */
export const DEFAULT_RESUME_PROMPT = `${BRAND.displayName} was closed while you were working, which stopped any commands or background agents you had running. Continue where you left off.`;

/** The marker's tooltip (spec §9.7). */
export const UNFINISHED_TOOLTIP = `Claude didn't finish when ${BRAND.displayName} closed`;

/** What a marker means, in the overview (spec §9.7). */
export function unfinishedReason(u: Pick<Unfinished, 'kind' | 'stopped'>): string {
  switch (u.kind) {
    case 'working':
      return 'Was working';
    case 'interrupted':
      return 'Interrupted with Esc';
    case 'permission':
      return 'Was asking for permission';
    case 'question':
      return 'Was asking a question';
    case 'commands':
      return stoppedNote(u.stopped);
  }
}

/** The marker's tooltip, with the stopped commands where there were some (spec §9.7). */
export const unfinishedTooltip = (u: Pick<Unfinished, 'kind' | 'stopped'> | null) =>
  u?.kind === 'commands' ? `${UNFINISHED_TOOLTIP}: ${stoppedNote(u.stopped)}` : UNFINISHED_TOOLTIP;

/**
 * Only Working is continued without the user choosing it; Esc-interrupted
 * work, a question it asked (it asks again) and stopped background commands
 * (dev servers, or commands past the hold's fallback, §10.2: Claude may not
 * have waited for them) are offered unticked; a permission has to be
 * given again in the session, so it can't be continued at all (spec §9.7).
 */
export const continuesAtStart = (kind: UnfinishedKind) => kind === 'working';
export const tickedByDefault = (kind: UnfinishedKind) => kind === 'working';
export const canContinue = (kind: UnfinishedKind) => kind !== 'permission';

/** A profile's continue setting (spec §3.1), as config.json has it. */
export interface ResumeSettings {
  continueAtStart: boolean;
  prompt?: string | null;
}

/** The prompt sent to continue, the profile's own or the default. */
export const resumePrompt = (settings: ResumeSettings | null | undefined) =>
  settings?.prompt?.trim() || DEFAULT_RESUME_PROMPT;

/**
 * Whether plan usage is at its limit (spec §9.7, §11): a window at 100% that
 * hasn't reset yet. Nothing is sent then. Returns the reason, or null.
 */
export function planLimitReached(
  snapshot: UsageSnapshot | null | undefined,
  now = Date.now(),
): string | null {
  if (!snapshot) return null;
  const windows = [
    ['session', snapshot.fiveHour],
    ['week', snapshot.sevenDay],
  ] as const;
  for (const [name, w] of windows) {
    if (!w || w.usedPercentage < 100) continue;
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    return `Plan usage is at its ${name} limit${w.resetsAt ? ` until ${new Date(w.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  }
  return null;
}

/**
 * What the quit dialog says comes next for the unfinished sessions it lists
 * (spec §5, §9.7), or null when quitting interrupts none. `continues` is
 * whether that session's profile continues work at start.
 */
export function quitNextStep(
  sessions: { kind: UnfinishedKind; continues: boolean }[],
): string | null {
  if (sessions.length === 0) return null;
  const auto = sessions.filter((s) => s.continues && continuesAtStart(s.kind)).length;
  const app = BRAND.displayName;
  if (auto === sessions.length) {
    return `${auto === 1 ? 'It' : 'They'}'ll continue when ${app} starts again.`;
  }
  if (auto === 0) return `You'll be asked when ${app} starts again.`;
  return `${auto} will continue when ${app} starts again; you'll be asked about the rest.`;
}

/**
 * A workspace's glyph with its Unfinished marker (spec §9.7): the marker
 * shows where the state has none of its own (Claude resumed and idle) or
 * Claude has exited; every other state's glyph wins.
 */
export function workspaceGlyph(
  w: { state: WorkspaceState; unread: boolean; unfinished: Unfinished | null },
  launching = false,
): StatusGlyph | null {
  const glyph = glyphFor(w.state, w.unread, launching);
  return w.unfinished && (glyph === null || glyph === 'exited') ? 'unfinished' : glyph;
}
