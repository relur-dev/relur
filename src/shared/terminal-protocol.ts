import type { PromptLine } from './prompt-line';

/**
 * Terminal data travels over a dedicated MessagePort per attached view, not
 * over tRPC: output is batched in the main process, and the first message
 * after attaching replays the scrollback.
 */

/** IPC channel on which the main process hands a window its end of a terminal port. */
export const TERMINAL_PORT_CHANNEL = 'terminal-port';

export interface TerminalPortInfo {
  attachId: string;
  sessionId: string;
}

/**
 * A point in a Claude session's output where a hook event happened (spec
 * §6.8): a prompt was submitted (with its text as Claude Code shows it, if the
 * hook said), or a response ended (with its text from the transcript, which
 * its Copy button copies). Views find the text in the lines above and put an
 * xterm marker there. `resumed`: a prompt from before a resume, read from the
 * transcript at SessionStart, found once Claude has reprinted the conversation.
 */
export type TerminalMark =
  | { kind: 'prompt'; text: string | null; resumed?: boolean }
  | { kind: 'response'; text: string };

export type TerminalServerMessage =
  /** `marks` are positions within `data`. */
  | { type: 'replay'; data: string; marks?: { at: number; mark: TerminalMark }[] }
  | { type: 'data'; data: string }
  | { type: 'mark'; mark: TerminalMark }
  | { type: 'exit'; exitCode: number | null; signal: number | null };

/**
 * `prompt`: what a Claude view's screen shows in Claude's input box once its
 * output settles (spec §9.8), null when the cursor isn't in one. It travels
 * with the keys, so the main process knows which keys came after it.
 */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'prompt'; line: PromptLine | null };

/**
 * `home`: the profile's home terminal (spec §6.7). `setup`: an install or
 * sign-in command of the setup check (§6.11).
 */
export type SessionKind = 'home' | 'shell' | 'claude' | 'setup';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  title: string;
  cwd: string;
  profileId: string;
  projectId: string | null;
  workspaceId: string | null;
  /**
   * `suspended`: Claude only, its process stopped to save memory while the
   * session stays, to be resumed (spec §9.8).
   */
  status: 'running' | 'suspended' | 'exited';
  /**
   * Claude only: true from spawn until its first output, at most about 3 s
   * (spec §6.3, launch spinner).
   */
  launching: boolean;
  /**
   * Claude only: true from a resume until Claude is ready (its SessionStart,
   * at most 20 s); keys typed meanwhile aren't sent (spec §9.8).
   */
  resuming: boolean;
  /**
   * How many times it was resumed or started again in place: each starts its
   * output afresh, so views attach again.
   */
  generation: number;
  /**
   * Claude only: a short note on how this start went, shown above its
   * terminal; a new conversation where none was saved to resume (spec §9.8).
   */
  note: string | null;
  exitCode: number | null;
  signal: number | null;
}
