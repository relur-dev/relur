import fs from 'node:fs';
import { atMenu, type WorkspaceState } from '@shared/status';
import {
  BLOCKER_TEXT,
  draftAfter,
  RESUME_READY_MS,
  type SuspendBlocker,
  type SuspendClock,
  type SuspendFacts,
  suspendBlocker,
  suspendDue,
} from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { Workspace } from '@shared/workspaces';
import type { HookMessage, StatusLineMessage } from '../bridge/server';
import { isBackgroundHandBack } from '../claude/transcript';
import type { SessionHost } from '../sessions/host';
import { answersPermission } from '../status/service';
import { asking, transition } from '../status/transitions';

/** How long after SessionStart a resumed Claude takes to show its prompt (as spec §9.7). */
export const SETTLE_MS = 2000;

type Host = Pick<
  SessionHost,
  | 'list'
  | 'get'
  | 'has'
  | 'suspend'
  | 'ready'
  | 'endSuspended'
  | 'onSpawn'
  | 'onResume'
  | 'onExit'
  | 'onInput'
>;

export interface SuspendDeps {
  host: Host;
  /** The profile's delay in minutes; null when suspension is off there (spec §9.8). */
  delayMin(profileId: string): number | null;
  workspace(
    workspaceId: string,
  ): Pick<Workspace, 'state' | 'background' | 'keepRunning'> | null | undefined;
  /** Keep running for a project's main-checkout Claude. */
  mainCheckoutKept(projectId: string): boolean;
  /** What visible windows show: workspaces, and the sessions of shown tabs. */
  shown(): { workspaces: ReadonlySet<string>; sessions: ReadonlySet<string> };
  /**
   * Starts a suspended session's Claude again in that session: a workspace's
   * as Start Claude does, a main checkout's with its conversation.
   */
  resume(info: SessionInfo): Promise<unknown>;
  /** A main-checkout Claude's conversation id, from its hooks (after /clear). */
  followMainClaude(sessionId: string, claudeId: string): void;
  /** How app.log names a session: its workspace, or "<project> (main checkout)". */
  label?(info: SessionInfo): string;
  /** app.log (spec §3.4): the idle clocks, suspends and resumes. */
  log?: { write(line: string): void } | null;
  /** Whether a file exists: Claude's transcript (spec §9.8). */
  exists?(file: string): boolean;
  /** Length of a minute; shorter in the e2e tests. */
  minuteMs?: number;
  readyMs?: number;
  settleMs?: number;
  now?: () => number;
}

/** What the service knows of one running Claude session. */
interface Facts {
  /** SessionStart arrived since it was started or resumed. */
  started: boolean;
  /** Typed text not yet sent as a prompt (spec §9.8). */
  draft: boolean;
  /** From hook payloads; given back with `--permission-mode` on resume. */
  permissionMode: string | null;
  /** From the status line; given back with `--model` on resume. */
  model: string | null;
  /** Claude's transcript, from hook payloads (read-only use, decision D12). */
  transcript: string | null;
  /** The transcript was seen to exist: Claude saved its conversation. */
  saved: boolean;
  /** Since when it may be suspended; null while it may not. */
  eligibleSince: number | null;
  /** What the last check found, for app.log; undefined before the first. */
  blocker?: SuspendBlocker | null;
  /** A main checkout's Claude: its state, kept here only (spec §9.8). */
  main: { state: WorkspaceState; background: number; waiting: boolean; asking: boolean } | null;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Suspends idle Claude sessions to save memory and resumes them when they are
 * opened (spec §9.8). Checks every quarter minute (at most 15 s) whether each
 * running Claude may be suspended, and suspends it once it has been so for the
 * profile's whole delay.
 */
export class SuspendService {
  private readonly facts = new Map<string, Facts>();
  /** Resumes under way, so one session is never started twice. */
  private readonly resuming = new Map<string, Promise<void>>();
  /** Callers waiting for a resumed Claude to be ready, by session. */
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly readyTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private readonly minuteMs: number;
  private readonly readyMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly deps: SuspendDeps) {
    this.minuteMs = deps.minuteMs ?? 60_000;
    this.readyMs = deps.readyMs ?? RESUME_READY_MS;
    this.settleMs = deps.settleMs ?? SETTLE_MS;
    this.now = deps.now ?? Date.now;
    const { host } = deps;
    this.unsubscribe = [
      host.onSpawn((info) => {
        if (info.kind !== 'claude') return;
        this.facts.set(info.id, {
          started: false,
          draft: false,
          permissionMode: null,
          model: null,
          transcript: null,
          saved: false,
          eligibleSince: null,
          main: info.workspaceId
            ? null
            : { state: 'starting', background: 0, waiting: false, asking: false },
        });
      }),
      host.onResume((info) => {
        const facts = this.factsOf(info);
        facts.started = false;
        facts.draft = false;
        facts.eligibleSince = null;
        facts.blocker = undefined;
        // Ready at SessionStart, or after 20 s without one.
        this.readyTimers.set(
          info.id,
          setTimeout(() => this.markReady(info.id, 0), this.readyMs),
        );
      }),
      host.onExit((info) => {
        this.facts.delete(info.id);
        this.clearReady(info.id);
        this.release(info.id);
      }),
      host.onInput((info, data) => this.input(info, data)),
    ];
  }

  start(): void {
    if (this.timer) return;
    const every = Math.min(15_000, Math.max(50, Math.floor(this.minuteMs / 4)));
    this.timer = setInterval(() => this.check(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.readyTimers.values()) clearTimeout(timer);
    this.readyTimers.clear();
    for (const off of this.unsubscribe) off();
  }

  /** A hook event (spec §10.1), for any Claude the app started. */
  handleHook(message: HookMessage): void {
    const info = this.sessionOf(message.sessionId, message.workspaceId);
    if (!info) return;
    const facts = this.factsOf(info);
    const payload = record(message.payload);
    const mode = str(payload.permission_mode);
    if (mode) facts.permissionMode = mode;
    // A new one after /clear: saved once its file exists.
    const transcript = str(payload.transcript_path);
    if (transcript && transcript !== facts.transcript) {
      facts.transcript = transcript;
      facts.saved = false;
    }
    if (message.event === 'UserPromptSubmit' && !isBackgroundHandBack(str(payload.prompt))) {
      facts.draft = false;
    }
    if (message.event === 'SessionStart') {
      facts.started = true;
      if (info.resuming) this.markReady(info.id, this.settleMs);
    }
    if (facts.main) this.mainHook(info, facts.main, message);
  }

  /** The status line's model, so a resume keeps it (spec §9.8). */
  handleStatusLine(message: StatusLineMessage): void {
    const info = this.sessionOf(message.sessionId ?? null, message.workspaceId);
    if (info && message.model) this.factsOf(info).model = message.model;
  }

  /**
   * Arguments that give a resumed Claude back what the session had (spec
   * §9.8): its permission mode, switched with ⇧⇥, and its model.
   */
  restoreArgs(sessionId: string): string[] {
    const facts = this.facts.get(sessionId);
    if (!facts) return [];
    return [
      ...(facts.permissionMode ? ['--permission-mode', facts.permissionMode] : []),
      ...(facts.model ? ['--model', facts.model] : []),
    ];
  }

  /**
   * Whether text was typed into this Claude's prompt and not sent (spec
   * §9.8): Home's quick reply never types over it (§6.7).
   */
  hasDraft(sessionId: string): boolean {
    return this.facts.get(sessionId)?.draft ?? false;
  }

  /** The workspaces whose Claude's prompt holds a draft (spec §6.7, quick reply). */
  drafts(): string[] {
    return this.deps.host
      .list()
      .filter((s) => s.kind === 'claude' && s.workspaceId && this.hasDraft(s.id))
      .map((s) => s.workspaceId as string);
  }

  /** Suspends every session that has been idle for its profile's whole delay. */
  check(): void {
    const now = this.now();
    const shown = this.deps.shown();
    for (const info of this.deps.host.list()) {
      if (info.kind !== 'claude' || info.status !== 'running') continue;
      const facts = this.facts.get(info.id);
      const current = facts && this.suspendFacts(info, facts, shown);
      const blocker = current ? suspendBlocker(current) : null;
      if (facts && current) this.noteBlocker(info, facts, blocker, current.delayMin);
      if (!facts || !current || blocker !== null) {
        if (facts) facts.eligibleSince = null;
        continue;
      }
      facts.eligibleSince ??= now;
      if (
        current.delayMin !== null &&
        suspendDue(facts.eligibleSince, now, current.delayMin, this.minuteMs)
      ) {
        facts.eligibleSince = null;
        facts.blocker = undefined;
        this.note(info, `suspended after ${current.delayMin} min idle`);
        void this.deps.host.suspend(info.id).catch((error: unknown) => {
          console.error('suspending a Claude session failed', error);
          this.note(info, `suspending failed: ${error instanceof Error ? error.message : error}`);
        });
      }
    }
  }

  /**
   * Each running workspace Claude's idle clock now (spec §9.8): why it isn't
   * suspended, or when it will be. For a Board card's tooltip.
   */
  clocks(): SuspendClock[] {
    const shown = this.deps.shown();
    const clocks: SuspendClock[] = [];
    for (const info of this.deps.host.list()) {
      if (info.kind !== 'claude' || info.status !== 'running' || !info.workspaceId) continue;
      const facts = this.facts.get(info.id);
      const current = facts && this.suspendFacts(info, facts, shown);
      if (!facts || !current) continue;
      const blocker = suspendBlocker(current);
      const dueAt =
        blocker === null && current.delayMin !== null
          ? (facts.eligibleSince ?? this.now()) + current.delayMin * this.minuteMs
          : null;
      clocks.push({ workspaceId: info.workspaceId, blocker, dueAt });
    }
    return clocks;
  }

  /** Resumes every suspended session that a window shows now (spec §9.8). */
  checkShown(): void {
    const shown = this.deps.shown();
    for (const info of this.deps.host.list()) {
      if (info.kind !== 'claude' || info.status !== 'suspended') continue;
      const isShown = info.workspaceId
        ? shown.workspaces.has(info.workspaceId)
        : shown.sessions.has(info.id);
      if (isShown) void this.resume(info, 'shown in a window');
    }
  }

  /**
   * Resumes a suspended Claude, or waits for one that resumes, until it is
   * ready for typed text: its SessionStart and a moment for its prompt to
   * show, or 20 s (spec §9.8).
   */
  async wake(info: SessionInfo): Promise<void> {
    if (info.status === 'running' && !info.resuming) return;
    // Released once ready and settled, when it exits, or when it can't start.
    const waiting = new Promise<void>((resolve) => {
      this.waiters.set(info.id, [...(this.waiters.get(info.id) ?? []), resolve]);
    });
    await this.resume(info, 'the app types into it');
    const now = this.deps.host.has(info.id) ? this.deps.host.get(info.id) : null;
    if (now?.status !== 'running') this.release(info.id);
    await waiting;
  }

  /** Starts a suspended session's Claude again, once per resume. */
  private resume(info: SessionInfo, why: string): Promise<void> {
    let running = this.resuming.get(info.id);
    if (running) return running;
    if (info.status !== 'suspended') return Promise.resolve();
    this.note(info, `resumed: ${why}`);
    running = this.deps
      .resume(info)
      .then(() => undefined)
      .catch((error: unknown) => {
        // It can't start (setup, a missing project): it has exited, and the
        // view offers to start it with the reason (spec §9.8).
        console.error('resuming a Claude session failed', error);
        this.note(info, `resume failed: ${error instanceof Error ? error.message : error}`);
        this.deps.host.endSuspended(info.id);
      })
      .finally(() => this.resuming.delete(info.id));
    this.resuming.set(info.id, running);
    return running;
  }

  /**
   * app.log (spec §3.4, §9.8): the clock starting, starting again with the
   * reason, and what keeps a session running when that changes. Nothing while
   * suspension is off.
   */
  private noteBlocker(
    info: SessionInfo,
    facts: Facts,
    blocker: SuspendBlocker | null,
    delayMin: number | null,
  ): void {
    const before = facts.blocker;
    facts.blocker = blocker;
    if (before === blocker || (blocker === 'off' && (before === undefined || before === 'off'))) {
      return;
    }
    if (blocker === null) this.note(info, `eligible: suspended after ${delayMin} min idle`);
    else if (before === null) this.note(info, `clock reset: ${BLOCKER_TEXT[blocker]}`);
    else this.note(info, `not suspended: ${BLOCKER_TEXT[blocker]}`);
  }

  private note(info: SessionInfo, text: string): void {
    const label = this.deps.label?.(info) ?? info.title;
    this.deps.log?.write(`suspend ${label}: ${text}`);
  }

  /** Whether Claude has written its transcript yet; once it has, it stays so. */
  private saved(facts: Facts): boolean {
    if (!facts.saved && facts.transcript) {
      facts.saved = (this.deps.exists ?? fs.existsSync)(facts.transcript);
    }
    return facts.saved;
  }

  private markReady(id: string, settleMs: number): void {
    this.clearReady(id);
    this.deps.host.ready(id);
    setTimeout(() => this.release(id), settleMs);
  }

  private clearReady(id: string): void {
    const timer = this.readyTimers.get(id);
    if (timer) clearTimeout(timer);
    this.readyTimers.delete(id);
  }

  private release(id: string): void {
    const waiting = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const resolve of waiting) resolve();
  }

  private suspendFacts(
    info: SessionInfo,
    facts: Facts,
    shown: { workspaces: ReadonlySet<string>; sessions: ReadonlySet<string> },
  ): SuspendFacts | null {
    const delayMin = this.deps.delayMin(info.profileId);
    const base = {
      delayMin,
      started: facts.started,
      draft: facts.draft,
      resuming: info.resuming,
      conversation: this.saved(facts),
    };
    if (info.workspaceId) {
      const workspace = this.deps.workspace(info.workspaceId);
      if (!workspace) return null;
      return {
        ...base,
        shown: shown.workspaces.has(info.workspaceId),
        state: workspace.state,
        background: workspace.background,
        keepRunning: workspace.keepRunning,
      };
    }
    if (!facts.main) return null;
    return {
      ...base,
      shown: shown.sessions.has(info.id),
      state: facts.main.state,
      background: facts.main.background,
      keepRunning: info.projectId ? this.deps.mainCheckoutKept(info.projectId) : false,
    };
  }

  /** A main checkout's Claude state from its hooks, as a workspace's (spec §10.2). */
  private mainHook(
    info: SessionInfo,
    main: NonNullable<Facts['main']>,
    message: HookMessage,
  ): void {
    const claudeId = str(record(message.payload).session_id);
    if (claudeId) this.deps.followMainClaude(info.id, claudeId);
    // Its end while suspended or resuming changes nothing.
    if (message.event === 'SessionEnd' && (info.status === 'suspended' || info.resuming)) return;
    main.asking = asking(main.asking, message.event, message.payload);
    const next = transition(main.state, message.event, message.payload, {
      background: main.background,
      waiting: main.waiting,
      asking: main.asking,
    });
    if (!next) return;
    if (message.event === 'Stop') main.waiting = next.state === 'working';
    else if (message.event !== 'PreToolUse' && message.event !== 'PostToolUse') {
      main.waiting = false;
    }
    main.state = next.state;
    main.background = next.background;
  }

  /** Keys from a view: typed text is a draft; Esc interrupts a main checkout's Claude. */
  private input(info: SessionInfo, data: string): void {
    if (info.kind !== 'claude') return;
    const facts = this.facts.get(info.id);
    if (!facts) return;
    const state = info.workspaceId
      ? this.deps.workspace(info.workspaceId)?.state
      : facts.main?.state;
    // Keys that answer a permission prompt or a question aren't a draft (spec §10.2).
    if (!atMenu(state)) facts.draft = draftAfter(facts.draft, data);
    const main = facts.main;
    if (!main) return;
    if (main.state === 'working' && data === '\x1b' && !main.waiting) main.state = 'interrupted';
    else if (atMenu(main.state) && answersPermission(data)) main.state = 'working';
  }

  private sessionOf(
    sessionId: string | null | undefined,
    workspaceId: string | null,
  ): SessionInfo | null {
    const { host } = this.deps;
    if (sessionId && host.has(sessionId)) return host.get(sessionId);
    if (!workspaceId) return null;
    return (
      host
        .list()
        .find(
          (s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status !== 'exited',
        ) ?? null
    );
  }

  private factsOf(info: SessionInfo): Facts {
    let facts = this.facts.get(info.id);
    if (!facts) {
      facts = {
        started: false,
        draft: false,
        permissionMode: null,
        model: null,
        transcript: null,
        saved: false,
        eligibleSince: null,
        main: info.workspaceId
          ? null
          : { state: 'starting', background: 0, waiting: false, asking: false },
      };
      this.facts.set(info.id, facts);
    }
    return facts;
  }
}
