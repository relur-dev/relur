import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { PromptLine } from '@shared/prompt-line';
import type {
  SessionInfo,
  SessionKind,
  TerminalMark,
  TerminalServerMessage,
} from '@shared/terminal-protocol';
import * as pty from 'node-pty';
import type { Env } from '../env/scrub';
import { ENTER_ALTERNATE, Scrollback } from './scrollback';

/** Where an attached view receives terminal messages. */
export interface TerminalSink {
  send(message: TerminalServerMessage): void;
  close(): void;
}

export interface Attachment {
  input(data: string): void;
  /** What the view's screen shows in Claude's input box (spec §9.8). */
  prompt(line: PromptLine | null): void;
  detach(): void;
}

export interface SpawnOptions {
  kind: SessionKind;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  env: Env;
  cols?: number;
  rows?: number;
  profileId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  /** The session's id, when the caller chose it before the spawn (its env names it, spec §9.2). */
  id?: string;
  /** Claude: a note on this start, shown above its terminal (SessionInfo.note). */
  note?: string | null;
}

export interface SessionHostOptions {
  /** Scrollback kept per session for replay, in characters. */
  scrollbackSize?: number;
  /** How long output is collected before it is sent to views (spec: ~16 ms). */
  batchMs?: number;
  /** Time between SIGTERM and SIGKILL when stopping (spec §9.5). */
  killTimeoutMs?: number;
  /** How long a Claude session without output counts as launching. */
  launchMs?: number;
}

interface Session {
  info: SessionInfo;
  /** Null for a Claude session that starts suspended (spec §9.8) until it is resumed. */
  pty: pty.IPty | null;
  /** Its process runs; a stopped one's pid may be reused, so it is never signalled. */
  alive: boolean;
  /** Process name of the program the session started (the shell, for shell kinds). */
  program: string;
  scrollback: Scrollback;
  /** Hook events at positions of the whole output (spec §6.8). */
  marks: { at: number; mark: TerminalMark }[];
  sinks: Set<TerminalSink>;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  exited: Promise<void>;
}

const MAX_INPUT = 1024 * 1024;

/** How long a Claude session counts as launching without output (spec §6.3). */
const LAUNCH_MS = 3000;

/** The terminal's foreground process name; node-pty reads it from the tty (macOS, Linux). */
function foregroundName(terminal: pty.IPty): string {
  try {
    // A login shell may report itself as "-zsh".
    return path.basename(terminal.process).replace(/^-/, '');
  } catch {
    return '';
  }
}

/**
 * Sole owner of every PTY (spec §16). Sessions are independent of windows:
 * views attach and detach, and a new view gets the scrollback replayed.
 */
export class SessionHost {
  private readonly sessions = new Map<string, Session>();
  private readonly events = new EventEmitter();
  private readonly scrollbackSize: number;
  private readonly batchMs: number;
  private readonly killTimeoutMs: number;
  private readonly launchMs: number;
  private closed = false;

  constructor(options: SessionHostOptions = {}) {
    // Roughly 10,000 lines of 200 characters (spec §16).
    this.scrollbackSize = options.scrollbackSize ?? 2_000_000;
    this.batchMs = options.batchMs ?? 16;
    this.killTimeoutMs = options.killTimeoutMs ?? 5_000;
    this.launchMs = options.launchMs ?? LAUNCH_MS;
  }

  spawn(options: SpawnOptions): SessionInfo {
    if (this.closed) throw new Error('Quitting: no new terminal sessions start');
    const session = this.newSession(options, 'running');
    this.launch(session, options);
    this.sessions.set(session.info.id, session);
    this.events.emit('spawn', session.info);
    this.changed();
    return session.info;
  }

  /**
   * A Claude session that starts suspended (spec §9.8): it is listed and shown,
   * without a process, until it is resumed.
   */
  addSuspended(options: Omit<SpawnOptions, 'command' | 'args' | 'env'>): SessionInfo {
    if (this.closed) throw new Error('Quitting: no new terminal sessions start');
    const session = this.newSession(options, 'suspended');
    session.info = { ...session.info, launching: false };
    this.sessions.set(session.info.id, session);
    this.changed();
    return session.info;
  }

  /**
   * Suspends a running Claude session (spec §9.8): its process group is
   * stopped as at §9.5, while the session stays, with its views, as
   * `suspended`. Its exit isn't reported (no `exit` event, nothing to views);
   * `suspend` listeners hear of it at once.
   */
  async suspend(id: string): Promise<void> {
    const session = this.session(id);
    if (session.info.kind !== 'claude' || session.info.status !== 'running') return;
    session.info = { ...session.info, status: 'suspended', launching: false, resuming: false };
    this.events.emit('suspend', session.info);
    this.changed();
    await this.stop(id);
  }

  /**
   * Resumes a suspended Claude session with a new process (spec §9.8), in the
   * same session: same id, views attach again (`generation`), and the output
   * starts afresh, as Claude prints the conversation again. Input stays
   * blocked until `ready`.
   */
  async resume(id: string, options: SpawnOptions): Promise<SessionInfo> {
    const session = this.session(id);
    if (session.info.status !== 'suspended') return session.info;
    // A suspend still under way finishes first.
    await session.exited;
    if (this.closed) throw new Error('Quitting: no new terminal sessions start');
    if (session.info.status !== 'suspended') return session.info;
    this.restart(session, { launching: false, resuming: true, note: options.note ?? null });
    this.launch(session, options);
    this.events.emit('resume', session.info);
    this.changed();
    return session.info;
  }

  /**
   * Starts an exited Claude session's process again in the same session
   * (Start Claude, spec §9.8): its tab stays, views attach again
   * (`generation`), and the output starts afresh. Listeners hear it as a spawn.
   */
  relaunch(id: string, options: SpawnOptions): SessionInfo {
    if (this.closed) throw new Error('Quitting: no new terminal sessions start');
    const session = this.session(id);
    if (session.info.kind !== 'claude' || session.info.status !== 'exited') {
      throw new Error('Only an exited Claude session starts again in place');
    }
    this.restart(session, { launching: true, resuming: false, note: options.note ?? null });
    this.launch(session, options);
    this.events.emit('spawn', session.info);
    this.changed();
    return session.info;
  }

  /** A session about to run a new process: fresh output, and views attach again. */
  private restart(
    session: Session,
    start: Pick<SessionInfo, 'launching' | 'resuming' | 'note'>,
  ): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    session.pending = '';
    session.scrollback = new Scrollback(this.scrollbackSize);
    session.marks = [];
    for (const sink of session.sinks) sink.close();
    session.sinks.clear();
    session.info = {
      ...session.info,
      ...start,
      status: 'running',
      exitCode: null,
      signal: null,
      generation: session.info.generation + 1,
    };
  }

  /**
   * A suspended Claude that couldn't be resumed (spec §9.8) ends as if it had
   * exited, so its view offers to start it again.
   */
  endSuspended(id: string): void {
    const session = this.sessions.get(id);
    if (session?.info.status !== 'suspended' || this.closed) return;
    session.info = { ...session.info, status: 'exited', resuming: false };
    for (const sink of session.sinks) sink.send({ type: 'exit', exitCode: null, signal: null });
    this.events.emit('exit', session.info);
    this.changed();
  }

  /** A resumed Claude is ready (spec §9.8): keys reach it again. */
  ready(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.info.resuming) return;
    session.info = { ...session.info, resuming: false };
    this.changed();
  }

  private newSession(
    options: Omit<SpawnOptions, 'command' | 'args' | 'env'> & { command?: string },
    status: SessionInfo['status'],
  ): Session {
    return {
      info: {
        id: options.id ?? randomUUID(),
        kind: options.kind,
        title: options.title,
        cwd: options.cwd,
        profileId: options.profileId,
        projectId: options.projectId ?? null,
        workspaceId: options.workspaceId ?? null,
        status,
        exitCode: null,
        signal: null,
        launching: options.kind === 'claude',
        resuming: false,
        generation: 0,
        note: options.note ?? null,
      },
      pty: null,
      alive: false,
      program: options.command ? path.basename(options.command) : '',
      scrollback: new Scrollback(this.scrollbackSize),
      marks: [],
      sinks: new Set(),
      pending: '',
      flushTimer: null,
      exited: Promise.resolve(),
    };
  }

  /** Starts the session's process; events from an earlier process of it are ignored. */
  private launch(session: Session, options: SpawnOptions): void {
    const child = pty.spawn(options.command, options.args, {
      name: options.env.TERM ?? 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: options.env,
    });
    session.pty = child;
    session.alive = true;
    session.program = path.basename(options.command);
    let markExited: () => void = () => {};
    session.exited = new Promise((resolve) => {
      markExited = resolve;
    });
    const current = () => session.pty === child;

    const launched = () => {
      clearTimeout(launchTimer);
      if (!current() || !session.info.launching) return;
      session.info = { ...session.info, launching: false };
      this.changed();
    };
    const launchTimer = setTimeout(launched, this.launchMs);

    child.onData((data) => {
      // Quitting: the views are going away (spec §5). A suspended Claude's last
      // words (its resume hint) aren't kept either.
      if (this.closed || !current() || session.info.status !== 'running') return;
      launched();
      session.scrollback.push(data);
      session.pending += data;
      session.flushTimer ??= setTimeout(() => this.flush(session), this.batchMs);
    });
    child.onExit(({ exitCode, signal }) => {
      clearTimeout(launchTimer);
      if (current()) session.alive = false;
      markExited();
      if (!current()) return;
      // Suspended (spec §9.8): the session stays; nothing is reported.
      if (session.info.status === 'suspended') return;
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.info = {
        ...session.info,
        status: 'exited',
        exitCode,
        signal: signal || null,
        launching: false,
        resuming: false,
      };
      // Once quitting, an exit only ends the session: nothing goes to views or
      // listeners that are shutting down (spec §5).
      if (this.closed) return;
      // node-pty calls this from native code: an exception thrown here would
      // surface as an uncaught one in the main process.
      try {
        this.flush(session);
        for (const sink of session.sinks)
          sink.send({ type: 'exit', exitCode, signal: signal || null });
        this.events.emit('exit', session.info);
        this.changed();
      } catch (error) {
        console.error('terminal exit handling failed', error);
      }
    });
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionInfo {
    return this.session(id).info;
  }

  /** Running sessions of a kind with the process id of what they started (spec §6.14). */
  processes(kind: SessionKind): { info: SessionInfo; pid: number }[] {
    return [...this.sessions.values()].flatMap((s) =>
      s.info.kind === kind && s.info.status === 'running' && s.pty
        ? [{ info: s.info, pid: s.pty.pid }]
        : [],
    );
  }

  runningCount(): number {
    return this.list().filter((s) => s.status === 'running').length;
  }

  /**
   * Whether a shell session (home or shell) is at its prompt: the foreground
   * process of its terminal is the shell itself (node-pty's process name).
   * Always false for other kinds and for exited sessions.
   */
  isShellIdle(id: string): boolean {
    const session = this.session(id);
    const { kind } = session.info;
    if (session.info.status !== 'running' || kind === 'claude' || kind === 'setup') return false;
    if (process.platform === 'win32') return true; // TODO(M7): no foreground process name on Windows
    return session.pty !== null && foregroundName(session.pty) === session.program;
  }

  /**
   * Sessions that quitting would interrupt (spec §5): running Claude sessions
   * and setup commands, and shells only while a program other than the shell
   * runs in the foreground.
   */
  busyCount(): number {
    return this.busySessions().length;
  }

  /** The sessions quitting would interrupt (spec §5), for the quit dialog. */
  busySessions(): SessionInfo[] {
    return this.list().filter(
      (s) =>
        s.status === 'running' &&
        (s.kind === 'claude' || s.kind === 'setup' || !this.isShellIdle(s.id)),
    );
  }

  /** Resolves with the session's final info once it has exited. */
  async waitForExit(id: string): Promise<SessionInfo> {
    const session = this.session(id);
    await session.exited;
    return session.info;
  }

  /**
   * Types a command line into a shell session, as the user would, but only
   * while the shell itself is in the foreground; otherwise the keystrokes
   * would go to whatever program runs there. Throws `busyMessage` then.
   */
  typeIntoShell(id: string, line: string, busyMessage: string): void {
    if (!this.isShellIdle(id)) throw new Error(busyMessage);
    this.write(id, `${line}\r`);
  }

  scrollback(id: string): string {
    return this.session(id).scrollback.text();
  }

  /** Connects a view: it receives the scrollback first, then live output. */
  attach(id: string, sink: TerminalSink): Attachment {
    if (this.closed) throw new Error('Quitting: no terminal view attaches any more');
    const session = this.session(id);
    // Send buffered output to existing views first, so the replay doesn't repeat it.
    this.flush(session);
    const { start } = session.scrollback;
    session.marks = session.marks.filter((m) => m.at >= start);
    // Kept output that began in the alternate screen replays there (spec §6.8, D9).
    const prefix = session.scrollback.startsAlternate ? ENTER_ALTERNATE : '';
    const marks = session.marks.map((m) => ({ at: prefix.length + m.at - start, mark: m.mark }));
    sink.send({
      type: 'replay',
      data: prefix + session.scrollback.text(),
      ...(marks.length > 0 ? { marks } : {}),
    });
    if (session.info.status === 'exited') {
      sink.send({ type: 'exit', exitCode: session.info.exitCode, signal: session.info.signal });
    }
    session.sinks.add(sink);
    return {
      // Once quitting, keys reach neither the session nor the input listeners,
      // which read state.db (spec §5); nor do they after the session exited,
      // while it is suspended, or while it resumes (spec §9.8).
      input: (data) => {
        if (this.closed || session.info.status !== 'running' || session.info.resuming) return;
        this.write(id, data);
        this.events.emit('input', session.info, data);
      },
      // Like keys: only while Claude runs and takes them.
      prompt: (line) => {
        if (this.closed || session.info.kind !== 'claude') return;
        if (session.info.status !== 'running' || session.info.resuming) return;
        this.events.emit('prompt', session.info, line);
      },
      detach: () => session.sinks.delete(sink),
    };
  }

  /**
   * Marks the current end of the session's output (spec §6.8): views get it
   * in order with the output, and later views with the replay.
   */
  mark(id: string, mark: TerminalMark): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.flush(session);
    session.marks.push({ at: session.scrollback.end, mark });
    for (const sink of session.sinks) sink.send({ type: 'mark', mark });
  }

  write(id: string, data: string): void {
    const session = this.session(id);
    if (session.info.status !== 'running' || !session.pty || data.length > MAX_INPUT) return;
    session.pty.write(data);
  }

  /**
   * Types text into a running session as if the user had: the input
   * listeners see it too (the draft in Claude's prompt, spec §9.8), as for
   * dropped files (§6.16). Nothing while it is suspended or resumes.
   */
  typeAsUser(id: string, data: string): void {
    const session = this.session(id);
    if (this.closed || session.info.status !== 'running' || session.info.resuming) return;
    this.write(id, data);
    this.events.emit('input', session.info, data);
  }

  /** How much the session has printed: unchanged while its output is quiet. */
  outputEnd(id: string): number {
    return this.session(id).scrollback.end;
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.session(id);
    if (session.info.status !== 'running' || !session.pty) return;
    session.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  /**
   * SIGTERM to the process group, SIGKILL if it hasn't exited after the
   * timeout (spec §9.5). Shells get SIGHUP first, as when a terminal window
   * closes: interactive shells ignore SIGTERM, but pass a hangup on to their jobs.
   */
  async stop(id: string): Promise<void> {
    const session = this.session(id);
    if (session.info.status === 'exited' || !session.alive) return;
    if (session.info.kind !== 'claude') this.signal(session, 'SIGHUP');
    this.signal(session, 'SIGTERM');
    const timer = setTimeout(() => this.signal(session, 'SIGKILL'), this.killTimeoutMs);
    await session.exited;
    clearTimeout(timer);
  }

  /** Stops a session if needed and forgets it, closing its views. */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await this.stop(id);
    for (const sink of session.sinks) sink.close();
    this.sessions.delete(id);
    this.changed();
  }

  /**
   * Refuses new sessions from now on, once quitting goes ahead (spec §5), and
   * stops listening to the running ones' output. A start that was already on
   * its way (a view asking for Claude while the window loads) would otherwise
   * spawn after stopAll, and its process would end while Electron shuts down:
   * node-pty's exit callback then has no JavaScript left to call and aborts
   * the app.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The views' ports close too: no input arrives after this.
    for (const session of this.sessions.values()) {
      for (const sink of session.sinks) sink.close();
      session.sinks.clear();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((s) => this.stop(s.id)));
  }

  /**
   * For the app's last moment (spec §5): refuses new sessions and stops every
   * running one, resolving once node-pty has reported each exit, so none can
   * arrive while Electron tears Node down.
   */
  async shutdown(): Promise<void> {
    this.close();
    await this.stopAll();
  }

  onChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  /** A session was started. */
  onSpawn(listener: (info: SessionInfo) => void): () => void {
    this.events.on('spawn', listener);
    return () => this.events.off('spawn', listener);
  }

  /** A session's process exited. */
  onExit(listener: (info: SessionInfo) => void): () => void {
    this.events.on('exit', listener);
    return () => this.events.off('exit', listener);
  }

  /** A Claude session was suspended (spec §9.8); its process is being stopped. */
  onSuspend(listener: (info: SessionInfo) => void): () => void {
    this.events.on('suspend', listener);
    return () => this.events.off('suspend', listener);
  }

  /** A suspended Claude session got a new process (spec §9.8). */
  onResume(listener: (info: SessionInfo) => void): () => void {
    this.events.on('resume', listener);
    return () => this.events.off('resume', listener);
  }

  /** The user typed into a session's view (not text the app typed itself). */
  onInput(listener: (info: SessionInfo, data: string) => void): () => void {
    this.events.on('input', listener);
    return () => this.events.off('input', listener);
  }

  /** A view reported Claude's input box as its screen shows it (spec §9.8). */
  onPrompt(listener: (info: SessionInfo, line: PromptLine | null) => void): () => void {
    this.events.on('prompt', listener);
    return () => this.events.off('prompt', listener);
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`No terminal session ${id}`);
    return session;
  }

  private flush(session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    for (const sink of session.sinks) sink.send({ type: 'data', data });
  }

  private signal(session: Session, signal: NodeJS.Signals): void {
    if (!session.pty || !session.alive) return;
    if (process.platform === 'win32') {
      // TODO(M7): terminate the whole process tree on Windows (spec §9.5).
      session.pty.kill();
      return;
    }
    try {
      // The PTY's child leads its own session and process group.
      process.kill(-session.pty.pid, signal);
    } catch {
      try {
        session.pty?.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  private changed(): void {
    this.events.emit('change');
  }
}
