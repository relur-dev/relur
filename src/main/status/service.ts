import { EventEmitter } from 'node:events';
import { atMenu, backgroundNote, needsYou, type WorkspaceState } from '@shared/status';
import { atGate, type WorkflowInfo } from '@shared/workflow';
import type { Workspace } from '@shared/workspaces';
import type { HookMessage } from '../bridge/server';
import { endsWithDeniedPermission, isBackgroundHandBack } from '../claude/transcript';
import type { WorkspaceRecords } from '../db/workspaces';
import { descendants, type ProcessTree, processTree } from '../memory/measure';
import type { ProcessEntry } from '../memory/processes';
import type { SessionHost } from '../sessions/host';
import { checkHold, HOLD_MINUTES, type Hold, runsCommand, startHold } from './hold';
import { asking, type Transition, transition, waitedCommands } from './transitions';

/** States that alert: a notification and a sound (spec §10.3). */
const ALERT_STATES: readonly WorkspaceState[] = [
  'needs-permission',
  'needs-input',
  'needs-answer',
  'awaiting-approval',
  'done',
];

/** An alert for the renderer (sounds) and the notifier; Error is a sound only. */
export interface Alert {
  workspaceId: string;
  profileId: string;
  state: WorkspaceState;
  title: string;
  body: string;
}

/** A hook event for the conversation aids in Claude tabs (spec §6.8). */
export interface ConversationEvent {
  workspaceId: string;
  /** SessionStart: only for a resumed session, whose earlier prompts Claude reprints. */
  event: 'UserPromptSubmit' | 'Stop' | 'SessionStart';
  /** The prompt, or the last assistant message at Stop, when the hook says. */
  text: string | null;
  /** The session transcript, when the hook says. */
  transcript: string | null;
}

/** What the status service needs from Electron; replaced in tests. */
export interface StatusPlatform {
  /** Whether the workspace's Claude tab is visible in the focused window. */
  claudeTabInFocus(workspaceId: string): boolean;
  /** Whether the profile silences notifications and sounds (Do Not Disturb). */
  quiet(profileId: string): boolean;
  profileName(profileId: string): string;
  notify(alert: Alert): void;
  /** The Dock / taskbar badge (spec §5). */
  setBadge(count: number): void;
}

const ALERT_TEXT: Partial<Record<WorkspaceState, string>> = {
  'needs-permission': 'needs permission',
  'needs-input': 'is waiting for input',
  'needs-answer': 'asked a question',
  'awaiting-approval': 'awaits approval',
  done: 'is done',
};

/** The workflow statuses the status service reads (spec §13.5). */
export interface WorkflowStatuses {
  info(workspaceId: string): WorkflowInfo | null;
  /** Reads the status file again (on Stop and PostToolUse). */
  refresh(workspaceId: string): void;
}

/** Hook events after which the status file is read again: Claude may have moved it. */
const REREAD_EVENTS = ['Stop', 'PostToolUse'];

/** When the transcript is checked for a denied permission after an answer (ms). */
export const ANSWER_CHECKS_MS = [1000, 3000];

/** A minute, in ms: the hold's times are counted in it (spec §10.2); test runs shorten it. */
export const MINUTE_MS = 60_000;

/** How the status service watches held commands; replaced in tests. */
export interface HoldOptions {
  /** The length of a minute for the hold's times (spec §10.2). */
  minuteMs?: number;
  /** The machine's process table; without it no process is ever found. */
  readProcesses?: () => Promise<ProcessEntry[]>;
}

/**
 * Whether keys typed while Claude asks for permission answer it: Enter picks
 * the highlighted choice, Esc declines, a digit picks that choice. Arrow keys
 * only move the highlight.
 */
export function answersPermission(data: string): boolean {
  return data === '\x1b' || data.includes('\r') || /^[0-9]$/.test(data);
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Workspace states from hooks and processes (spec §10.2) and their alerts
 * (§10.3): hook events move the state, Esc while Working interrupts, Claude's
 * exit ends it. Also keeps the Dock badge and resume data up to date.
 */
export class StatusService {
  private readonly events = new EventEmitter();
  /** Set while the app quits, so stopping Claude keeps it marked for resume. */
  quitting = false;

  /** Set once the workflow service exists; without it there are no gates. */
  workflow: WorkflowStatuses | null = null;

  /** Each workspace's last state, to notice one going into Error. */
  private readonly lastStates = new Map<string, WorkspaceState>();

  /**
   * Workspaces whose Claude ended its turn while it waits for background
   * work (spec §10.2), until its next turn starts.
   */
  private readonly waiting = new Set<string>();

  /** Workspaces whose Claude waits on its question tool (spec §10.2). */
  private readonly asking = new Set<string>();

  /** Each workspace whose Done is held for background commands (spec §10.2). */
  private readonly holds = new Map<string, Hold>();
  /** Looks at the process table while any Done is held. */
  private holdTimer: NodeJS.Timeout | null = null;
  /** A look at the process table is under way. */
  private readingProcesses = false;
  private readonly minuteMs: number;
  private readonly readProcesses: (() => Promise<ProcessEntry[]>) | null;

  /** Workspaces whose permission prompt was answered, until the next hook event. */
  private readonly answered = new Map<string, NodeJS.Timeout[]>();

  constructor(
    private readonly records: WorkspaceRecords,
    private readonly host: SessionHost,
    private readonly platform: StatusPlatform,
    private readonly answerChecksMs: readonly number[] = ANSWER_CHECKS_MS,
    holdOptions: HoldOptions = {},
  ) {
    this.minuteMs = holdOptions.minuteMs ?? MINUTE_MS;
    this.readProcesses = holdOptions.readProcesses ?? null;
    host.onSpawn((info) => {
      if (info.kind !== 'claude' || !info.workspaceId) return;
      records.setClaudeRunning(info.workspaceId, true);
      records.setState(info.workspaceId, 'starting');
    });
    host.onExit((info) => {
      if (info.kind !== 'claude' || !info.workspaceId) return;
      if (!this.quitting) records.setClaudeRunning(info.workspaceId, false);
      this.waiting.delete(info.workspaceId);
      this.asking.delete(info.workspaceId);
      this.clearHold(info.workspaceId);
      const workspace = records.get(info.workspaceId);
      if (workspace && workspace.state !== 'exited') records.setState(workspace.id, 'exited');
    });
    host.onInput((info, data) => {
      if (info.kind !== 'claude' || !info.workspaceId) return;
      const current = records.get(info.workspaceId)?.state;
      // Stop doesn't fire when the user interrupts Claude; the Esc key in its
      // own terminal does (spec §10.2), unless its turn has already ended and
      // only its background work goes on.
      if (current === 'working' && data === '\x1b' && !this.waiting.has(info.workspaceId)) {
        records.setState(info.workspaceId, 'interrupted');
      } else if (atMenu(current) && answersPermission(data)) {
        this.permissionAnswered(info.workspaceId, current === 'needs-answer');
      }
    });
    for (const w of records.list()) this.lastStates.set(w.id, w.state);
    records.onChange(() => {
      this.updateBadge();
      this.errorSounds();
    });
    this.updateBadge();
  }

  /** A hook event from the bridge. */
  handleHook(message: HookMessage): void {
    const workspace = this.findWorkspace(message);
    if (!workspace) return;
    // A suspended Claude's end, and the old process's end while it resumes,
    // leave the state as it was (spec §9.8).
    if (message.event === 'SessionEnd' && this.suspendedOrResuming(workspace.id)) return;
    this.clearAnswered(workspace.id);
    const payload = record(message.payload);
    this.records.setClaudeSession(
      workspace.id,
      str(payload.session_id),
      str(payload.transcript_path),
    );
    // Background work handing back to Claude isn't a prompt: no marker (spec §6.8).
    const handBack =
      message.event === 'UserPromptSubmit' && isBackgroundHandBack(str(payload.prompt));
    // A prompt is the last prompt and ends the Unfinished marker (spec §9.7).
    if (message.event === 'UserPromptSubmit' && !handBack) {
      this.records.promptSent(workspace.id, str(payload.prompt));
    }
    if (message.event === 'SessionStart') this.events.emit('sessionStart', workspace.id);
    // A resumed session reprints its earlier prompts: their markers come back (spec §6.8).
    const event: ConversationEvent['event'] | null =
      (message.event === 'UserPromptSubmit' && !handBack) || message.event === 'Stop'
        ? message.event
        : message.event === 'SessionStart' && payload.source === 'resume'
          ? 'SessionStart'
          : null;
    if (event) {
      this.events.emit('conversation', {
        workspaceId: workspace.id,
        event,
        text: str(
          event === 'Stop'
            ? payload.last_assistant_message
            : event === 'UserPromptSubmit'
              ? payload.prompt
              : null,
        ),
        transcript: str(payload.transcript_path),
      } satisfies ConversationEvent);
    }
    if (REREAD_EVENTS.includes(message.event)) this.workflow?.refresh(workspace.id);
    const wasAsking = this.asking.has(workspace.id);
    if (asking(wasAsking, message.event, message.payload)) this.asking.add(workspace.id);
    else this.asking.delete(workspace.id);
    const next = transition(workspace.state, message.event, message.payload, {
      background: workspace.background,
      waiting: this.waiting.has(workspace.id),
      asking: this.asking.has(workspace.id),
    });
    if (!next) return;
    // Tool events may come from a background agent; any other event ends the
    // wait and the hold, and a Stop that waits starts them again.
    if (message.event !== 'PreToolUse' && message.event !== 'PostToolUse') {
      this.waiting.delete(workspace.id);
      this.clearHold(workspace.id);
    }
    if (message.event === 'Stop' && next.state === 'working') this.waiting.add(workspace.id);
    if (next.held) this.hold(workspace.id, waitedCommands(message.payload));
    this.settle(workspace, next);
  }

  /** Moves a workspace to its next state, with the unread marker and alerts it brings. */
  private settle(workspace: Workspace, next: Transition): void {
    const changed = next.state !== workspace.state;
    const visible = this.platform.claudeTabInFocus(workspace.id);
    const gate = this.workflow?.info(workspace.id) ?? null;
    const wasAtGate = atGate(workspace.state, gate);
    this.records.setState(workspace.id, next.state, {
      message: next.message,
      background: next.background,
      // Done while you weren't looking (spec §10.2).
      unread: next.state === 'done' ? !visible : undefined,
    });
    // One notification per moment (spec §13.5): at a gate only the gate's.
    if (atGate(next.state, gate)) {
      if (!wasAtGate) this.gateAlert(workspace, gate, visible);
    } else if (changed && ALERT_STATES.includes(next.state)) {
      this.alert(workspace, next, visible);
    }
  }

  /**
   * Done held for background commands (spec §10.2): a hand-back ends the hold
   * and Claude takes another turn. Without one, Done comes, with the commands
   * still counted, once each command's process, found below Claude, has been
   * gone for the grace; for one never found, after the fixed fallback; for
   * all, at the cap.
   */
  private hold(workspaceId: string, commands: string[]): void {
    this.holds.set(workspaceId, startHold(commands, Date.now()));
    if (!this.holdTimer) {
      this.holdTimer = setInterval(() => this.checkHolds(), HOLD_MINUTES.poll * this.minuteMs);
    }
    this.checkHolds();
  }

  private clearHold(workspaceId: string): void {
    this.holds.delete(workspaceId);
    if (this.holds.size === 0 && this.holdTimer) {
      clearInterval(this.holdTimer);
      this.holdTimer = null;
    }
  }

  /**
   * Reads the process table once for every held Done. While a read is still
   * under way (a slow `ps`), only the times are checked.
   */
  private checkHolds(): void {
    if (!this.readProcesses || this.readingProcesses) {
      this.settleHolds(null);
      return;
    }
    this.readingProcesses = true;
    this.readProcesses()
      .then(processTree, () => null)
      .then((tree) => {
        this.readingProcesses = false;
        this.settleHolds(tree);
      });
  }

  private settleHolds(tree: ProcessTree | null): void {
    const now = Date.now();
    const pids = new Map(this.host.processes('claude').map((p) => [p.info.workspaceId, p.pid]));
    for (const [workspaceId, hold] of [...this.holds]) {
      const pid = pids.get(workspaceId);
      const below =
        tree && pid !== undefined && tree.byPid.has(pid) ? descendants(tree, pid) : null;
      const running = below
        ? (command: string) => below.some((p) => runsCommand(p, command))
        : null;
      const checked = checkHold(hold, now, running, this.minuteMs);
      if (!checked.done) {
        this.holds.set(workspaceId, checked.hold);
        continue;
      }
      this.clearHold(workspaceId);
      this.waiting.delete(workspaceId);
      const workspace = this.records.get(workspaceId);
      // While the app quits, states stay as quitting marked them (spec §9.7).
      if (this.quitting || workspace?.state !== 'working') continue;
      this.settle(workspace, { state: 'done', message: null, background: workspace.background });
    }
  }

  /**
   * The workflow status changed (spec §13.5): reaching a gate while Claude is
   * idle alerts; the badge follows either way.
   */
  workflowChanged(workspaceId: string, before: WorkflowInfo | null, after: WorkflowInfo | null) {
    const workspace = this.records.get(workspaceId);
    if (workspace && atGate(workspace.state, after) && !atGate(workspace.state, before)) {
      this.gateAlert(workspace, after, this.platform.claudeTabInFocus(workspaceId));
    }
    this.updateBadge();
  }

  private gateAlert(workspace: Workspace, gate: WorkflowInfo | null, visible: boolean): void {
    this.alert(
      workspace,
      { state: 'awaiting-approval', message: null },
      visible,
      `waits for you: ${gate?.statuses[gate.index]?.hint || (gate?.label ?? '')}`,
    );
  }

  /** The state shown and counted (spec §13.5): Awaiting approval at a gate. */
  private shownState(workspace: Workspace): WorkspaceState {
    return atGate(workspace.state, this.workflow?.info(workspace.id) ?? null)
      ? 'awaiting-approval'
      : workspace.state;
  }

  /**
   * The permission prompt, or Claude's question, was answered in the Claude
   * tab (spec §10.2). Yes goes on with the tool, so Working; Claude Code
   * sends no hook event for No (or a question declined with Esc), so the
   * transcript tells: ending in its interrupt note, Claude waits for input.
   * Any hook event before the checks decides instead.
   */
  private permissionAnswered(workspaceId: string, question = false): void {
    this.clearAnswered(workspaceId);
    this.records.setState(workspaceId, 'working', { message: null });
    const check = () => {
      const file = this.records.transcriptPath(workspaceId);
      if (!file || !endsWithDeniedPermission(file)) return;
      this.clearAnswered(workspaceId);
      if (this.records.get(workspaceId)?.state !== 'working') return;
      this.records.setState(workspaceId, 'needs-input', {
        message: question
          ? 'Question declined. What should Claude do instead?'
          : 'Permission denied. What should Claude do instead?',
      });
    };
    this.answered.set(
      workspaceId,
      this.answerChecksMs.map((ms) => setTimeout(check, ms)),
    );
  }

  private clearAnswered(workspaceId: string): void {
    for (const timer of this.answered.get(workspaceId) ?? []) clearTimeout(timer);
    this.answered.delete(workspaceId);
  }

  onAlert(listener: (alert: Alert) => void): () => void {
    this.events.on('alert', listener);
    return () => this.events.off('alert', listener);
  }

  /** A workspace's Claude has started or resumed its session (the SessionStart hook). */
  onSessionStart(listener: (workspaceId: string) => void): () => void {
    this.events.on('sessionStart', listener);
    return () => this.events.off('sessionStart', listener);
  }

  onConversation(listener: (event: ConversationEvent) => void): () => void {
    this.events.on('conversation', listener);
    return () => this.events.off('conversation', listener);
  }

  /** The workspace an event belongs to: by its id, else by the working directory. */
  private suspendedOrResuming(workspaceId: string): boolean {
    return this.host
      .list()
      .some(
        (s) =>
          s.workspaceId === workspaceId &&
          s.kind === 'claude' &&
          (s.status === 'suspended' || s.resuming),
      );
  }

  private findWorkspace(message: HookMessage): Workspace | null {
    if (message.workspaceId) return this.records.get(message.workspaceId);
    // A main checkout's Claude (spec §9.8): its state is the suspend service's own.
    if (message.sessionId && this.host.has(message.sessionId)) return null;
    const cwd = str(record(message.payload).cwd);
    return cwd ? (this.records.list().find((w) => w.worktreePath === cwd) ?? null) : null;
  }

  /**
   * Notification and sound, unless the workspace's Claude tab is visible in
   * the focused window or the profile is set to Do Not Disturb (spec §10.3).
   */
  private alert(
    workspace: Workspace,
    next: { state: WorkspaceState; message: string | null; background?: number },
    visible: boolean,
    text = ALERT_TEXT[next.state] ?? '',
  ): void {
    if (visible || this.platform.quiet(workspace.profileId)) return;
    const label = workspace.task.id ?? workspace.name;
    const alert: Alert = {
      workspaceId: workspace.id,
      profileId: workspace.profileId,
      state: next.state,
      title: `[${this.platform.profileName(workspace.profileId)}] ${label} ${text}`.trim(),
      // Done with commands still running says so (spec §10.2).
      body:
        next.message ??
        [workspace.task.title || workspace.name, backgroundNote(next.state, next.background ?? 0)]
          .filter(Boolean)
          .join(' · '),
    };
    this.platform.notify(alert);
    this.events.emit('alert', alert);
  }

  /**
   * A workspace that went into Error (a failed setup or start): a sound, if
   * the profile plays one for it, but no notification (spec §10.3).
   */
  private errorSounds(): void {
    for (const workspace of this.records.list()) {
      const before = this.lastStates.get(workspace.id);
      this.lastStates.set(workspace.id, workspace.state);
      if (workspace.state !== 'error' || before === 'error') continue;
      const visible = this.platform.claudeTabInFocus(workspace.id);
      if (visible || this.platform.quiet(workspace.profileId)) continue;
      this.events.emit('alert', {
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        state: 'error',
        title: `[${this.platform.profileName(workspace.profileId)}] ${workspace.task.id ?? workspace.name} failed`,
        body: workspace.stateMessage ?? workspace.name,
      } satisfies Alert);
    }
  }

  private updateBadge(): void {
    this.platform.setBadge(this.records.list().filter((w) => needsYou(this.shownState(w))).length);
  }
}
