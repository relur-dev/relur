import { QUESTION_TOOL } from '@shared/question';
import type { WorkspaceState } from '@shared/status';
import { looksLikeDevServer } from '../memory/measure';

export interface Transition {
  state: WorkspaceState;
  /** Shown with the state, e.g. what Claude waits for; null clears it. */
  message: string | null;
  /** How many of Claude's background tasks still run (spec §10.2). */
  background: number;
  /**
   * Working only for background commands, no agent: Done is held until they
   * hand back, or until the fallback (spec §10.2).
   */
  held?: boolean;
}

/** Where the workspace is when a hook event arrives. */
export interface Current {
  /** Its background count. */
  background?: number;
  /** Claude's turn has ended while it waits for background work (spec §10.2). */
  waiting?: boolean;
  /** Claude's question tool has been called and has no result yet (`asking`). */
  asking?: boolean;
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Whether a Notification hook says Claude waits for input rather than asks
 * for permission. Claude Code's `notification_type` decides when present;
 * otherwise the message text. Anything unrecognised counts as permission,
 * the more urgent case (spec §10.2).
 */
export function isIdleNotification(payload: unknown): boolean {
  const { notification_type: type, message } = record(payload);
  if (type === 'idle_prompt') return true;
  if (type === 'permission_prompt') return false;
  return typeof message === 'string' && /waiting for (your )?input/i.test(message);
}

/**
 * Whether Claude's question tool waits after this hook event (spec §10.2):
 * from its PreToolUse until its PostToolUse, a new prompt, Stop or the end.
 * Claude Code reports its menu as a permission request, naming no tool, so
 * this tells the two apart. Other tools' events change nothing: they may be
 * a background agent's.
 */
export function asking(before: boolean, event: string, payload: unknown): boolean {
  const tool = record(payload).tool_name;
  switch (event) {
    case 'PreToolUse':
      return tool === QUESTION_TOOL || before;
    case 'PostToolUse':
      return tool === QUESTION_TOOL ? false : before;
    case 'UserPromptSubmit':
    case 'Stop':
    case 'SessionEnd':
      return false;
    default:
      return before;
  }
}

/** One of Claude's background tasks, as the Stop hook lists them in `background_tasks`. */
export interface BackgroundTask {
  type: string;
  status: string;
  /** A command's command line; empty for agents. */
  command: string;
}

/** The background tasks still running at Stop (spec §10.2); none when the payload has no list. */
export function runningBackgroundTasks(payload: unknown): BackgroundTask[] {
  const tasks = record(payload).background_tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map(record)
    .map((t) => ({
      type: String(t.type ?? ''),
      status: String(t.status ?? ''),
      command: typeof t.command === 'string' ? t.command : '',
    }))
    .filter((t) => t.status === 'running');
}

const isAgent = (task: BackgroundTask) => task.type === 'subagent';

/**
 * Whether Claude waits for the task (spec §10.2): a background agent always
 * hands its result back. A command Claude waits for and one it leaves running
 * on purpose send the same payload (checked live), so the command line
 * decides: one that looks like a dev server, as the memory panel judges it,
 * isn't waited for; any other command, and types not known, are.
 */
export const waitedFor = (task: BackgroundTask) =>
  isAgent(task) || !looksLikeDevServer(task.command);

/** The commands a held Done waits for (spec §10.2): the waited-for ones of a `Stop`. */
export const waitedCommands = (payload: unknown): string[] =>
  runningBackgroundTasks(payload)
    .filter((t) => !isAgent(t) && waitedFor(t))
    .map((t) => t.command);

/**
 * The state a hook event moves a workspace to (spec §10.2), or null for none.
 * SessionStart changes nothing: Starting is set when Claude is spawned.
 */
export function transition(
  current: WorkspaceState,
  event: string,
  payload: unknown,
  { background = 0, waiting = false, asking = false }: Current = {},
): Transition | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      // Background work goes on until the next Stop counts it again.
      return { state: 'working', message: null, background };
    case 'Notification': {
      const message = record(payload).message;
      const text = typeof message === 'string' ? message : null;
      if (isIdleNotification(payload)) {
        // The idle notice after Done changes nothing and doesn't alert again; nor
        // does it while Claude waits for its background work.
        if (current === 'done' || (current === 'working' && waiting)) return null;
        return { state: 'needs-input', message: text, background: 0 };
      }
      // Claude's question menu comes as a permission request (spec §10.2).
      if (asking) return { state: 'needs-answer', message: null, background: 0 };
      return { state: 'needs-permission', message: text, background: 0 };
    }
    case 'Stop': {
      // Waiting for background work is still Working; dev servers left
      // running only add a note to Done.
      const running = runningBackgroundTasks(payload);
      const waited = running.filter(waitedFor);
      if (waited.length === 0) return { state: 'done', message: null, background: running.length };
      // Only commands: held, with a fallback for one that never ends.
      const held = !waited.some(isAgent);
      return { state: 'working', message: null, background: running.length, ...(held && { held }) };
    }
    case 'SessionEnd':
      return { state: 'exited', message: null, background: 0 };
    default:
      return null;
  }
}
