import { EventEmitter } from 'node:events';
import type { WorkspaceState } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookMessage } from '../bridge/server';
import { SuspendService } from './service';

const MINUTE = 1000;

/** The parts of SessionHost the service uses, without processes. */
class FakeHost {
  readonly events = new EventEmitter();
  readonly sessions = new Map<string, SessionInfo>();
  readonly suspended: string[] = [];

  /**
   * A running Claude; with `saved`, its hooks name its transcript, which
   * exists (Claude saved its conversation).
   */
  add(id: string, more: Partial<SessionInfo> = {}, saved = true): SessionInfo {
    const info: SessionInfo = {
      id,
      kind: 'claude',
      title: id,
      cwd: '/w',
      profileId: 'work',
      projectId: 'api',
      workspaceId: `ws_${id}`,
      status: 'running',
      exitCode: null,
      signal: null,
      launching: false,
      resuming: false,
      generation: 0,
      note: null,
      ...more,
    };
    this.sessions.set(id, info);
    this.events.emit('spawn', info);
    if (saved) {
      files.add(`/t/${id}.jsonl`);
      hook('PreCompact', { sessionId: id }, { transcript_path: `/t/${id}.jsonl` });
    }
    return info;
  }
  set(id: string, more: Partial<SessionInfo>) {
    const info = { ...(this.sessions.get(id) as SessionInfo), ...more };
    this.sessions.set(id, info);
    return info;
  }
  list = () => [...this.sessions.values()];
  get = (id: string) => this.sessions.get(id) as SessionInfo;
  has = (id: string) => this.sessions.has(id);
  suspend = async (id: string) => {
    this.suspended.push(id);
    this.set(id, { status: 'suspended' });
  };
  ready = (id: string) => {
    this.set(id, { resuming: false });
  };
  endSuspended = (id: string) => {
    this.set(id, { status: 'exited' });
  };
  on = (event: string) => (listener: (info: SessionInfo, data?: string) => void) => {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  };
  onSpawn = this.on('spawn');
  onResume = this.on('resume');
  onExit = this.on('exit');
  onInput = this.on('input');
  type(id: string, data: string) {
    this.events.emit('input', this.get(id), data);
  }
  resumed(id: string) {
    this.events.emit('resume', this.set(id, { status: 'running', resuming: true }));
  }
}

let host: FakeHost;
let service: SuspendService;
let delay: number | null;
let states: Record<string, { state: WorkspaceState; background: number; keepRunning: boolean }>;
let shown: { workspaces: Set<string>; sessions: Set<string> };
let kept: string[];
let resumes: string[];
let follows: [string, string][];
let logged: string[];
/** Transcript files that exist. */
let files: Set<string>;

const hook = (event: string, more: Partial<HookMessage> = {}, payload: object = {}) =>
  service.handleHook({ event, workspaceId: null, profileId: 'work', payload, ...more });
const workspace = (state: WorkspaceState, background = 0, keepRunning = false) => ({
  state,
  background,
  keepRunning,
});
const pass = (ms: number) => {
  vi.advanceTimersByTime(ms);
  service.check();
};

beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  delay = 5;
  states = {};
  shown = { workspaces: new Set(), sessions: new Set() };
  kept = [];
  resumes = [];
  follows = [];
  logged = [];
  files = new Set();
  service = new SuspendService({
    host: host as never,
    delayMin: () => delay,
    workspace: (id) => states[id],
    mainCheckoutKept: (projectId) => kept.includes(projectId),
    shown: () => shown,
    resume: async (info) => {
      resumes.push(info.id);
      host.resumed(info.id);
    },
    followMainClaude: (sessionId, claudeId) => follows.push([sessionId, claudeId]),
    label: (info) => info.id,
    log: { write: (line) => logged.push(line) },
    exists: (file) => files.has(file),
    minuteMs: MINUTE,
    readyMs: 20_000,
    settleMs: 2000,
    now: () => Date.now(),
  });
});
afterEach(() => {
  service.stop();
  vi.useRealTimers();
});

describe('SuspendService (spec §9.8)', () => {
  it('suspends an idle workspace session after the whole delay, not before', () => {
    host.add('a');
    states.ws_a = workspace('done');
    service.check();
    pass(5 * MINUTE - 1);
    expect(host.suspended).toEqual([]);
    pass(1);
    expect(host.suspended).toEqual(['a']);
  });

  it('starts the clock again when a condition breaks during the delay', () => {
    host.add('a');
    states.ws_a = workspace('done');
    service.check();
    pass(3 * MINUTE);
    shown.workspaces.add('ws_a');
    pass(1);
    shown.workspaces.delete('ws_a');
    pass(1);
    pass(4 * MINUTE);
    expect(host.suspended).toEqual([]);
    pass(MINUTE);
    expect(host.suspended).toEqual(['a']);
  });

  it('never suspends while shown, working, asking, with background work, kept or off', () => {
    host.add('shown');
    states.ws_shown = workspace('done');
    shown.workspaces.add('ws_shown');
    host.add('working');
    states.ws_working = workspace('working');
    host.add('asking');
    states.ws_asking = workspace('needs-permission');
    host.add('bg');
    states.ws_bg = workspace('done', 1);
    host.add('kept');
    states.ws_kept = workspace('done', 0, true);
    service.check();
    pass(60 * MINUTE);
    expect(host.suspended).toEqual([]);
    delay = null;
    host.add('off');
    states.ws_off = workspace('done');
    pass(60 * MINUTE);
    expect(host.suspended).toEqual([]);
  });

  it('never suspends before Claude saved a conversation, nor after /clear until it saves the new one', () => {
    host.add('a', {}, false);
    states.ws_a = workspace('starting');
    hook('SessionStart', { sessionId: 'a' }, { transcript_path: '/t/new.jsonl' });
    pass(60 * MINUTE);
    expect(host.suspended).toEqual([]);
    expect(logged).toEqual(['suspend a: not suspended: no conversation yet']);
    expect(service.clocks()).toEqual([
      { workspaceId: 'ws_a', blocker: 'no-conversation', dueAt: null },
    ]);
    // The first prompt writes the transcript.
    files.add('/t/new.jsonl');
    pass(1);
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a']);

    host.add('b');
    states.ws_b = workspace('done');
    hook('SessionStart', { sessionId: 'b' }, { transcript_path: '/t/cleared.jsonl' });
    pass(60 * MINUTE);
    expect(host.suspended).toEqual(['a']);
    files.add('/t/cleared.jsonl');
    pass(1);
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a', 'b']);
  });

  it('logs the clock: eligible, reset with the reason, suspended, resumed (spec §3.4)', async () => {
    host.add('a');
    states.ws_a = workspace('done');
    service.check();
    pass(MINUTE);
    host.type('a', 'half a prompt');
    pass(1);
    pass(1);
    host.type('a', '\r');
    pass(1);
    shown.workspaces.add('ws_a');
    pass(1);
    shown.workspaces.delete('ws_a');
    pass(1);
    pass(5 * MINUTE);
    expect(logged).toEqual([
      'suspend a: eligible: suspended after 5 min idle',
      'suspend a: clock reset: a draft in the prompt',
      'suspend a: eligible: suspended after 5 min idle',
      'suspend a: clock reset: shown in a window',
      'suspend a: eligible: suspended after 5 min idle',
      'suspend a: suspended after 5 min idle',
    ]);
    shown.workspaces.add('ws_a');
    service.checkShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged.at(-1)).toBe('suspend a: resumed: shown in a window');
  });

  it('logs what keeps a session running when it changes, nothing while off', () => {
    host.add('a');
    states.ws_a = workspace('working');
    service.check();
    states.ws_a = workspace('done', 1);
    pass(1);
    pass(1);
    states.ws_a = workspace('done', 0, true);
    pass(1);
    host.add('b');
    states.ws_b = workspace('done');
    delay = null;
    pass(1);
    expect(logged).toEqual([
      "suspend a: not suspended: Claude isn't idle",
      'suspend a: not suspended: background work running',
      'suspend a: not suspended: Keep Claude Running is on',
      'suspend a: not suspended: suspension is off',
    ]);
  });

  it("gives each running workspace Claude's clock: why not, or when", () => {
    host.add('a');
    states.ws_a = workspace('done');
    host.add('b');
    states.ws_b = workspace('done');
    host.type('b', 'x');
    host.add('main', { workspaceId: null });
    service.check();
    pass(2 * MINUTE);
    const start = Date.now() - 2 * MINUTE;
    expect(service.clocks()).toEqual([
      { workspaceId: 'ws_a', blocker: null, dueAt: start + 5 * MINUTE },
      { workspaceId: 'ws_b', blocker: 'draft', dueAt: null },
    ]);
  });

  it('counts a Claude waiting after SessionStart as idle, not one still starting', () => {
    host.add('a');
    states.ws_a = workspace('starting');
    service.check();
    pass(10 * MINUTE);
    expect(host.suspended).toEqual([]);
    hook('SessionStart', { workspaceId: 'ws_a' });
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a']);
  });

  it('keeps a typed draft until a prompt is sent; arrows, Esc and answers are no draft', () => {
    host.add('a');
    states.ws_a = workspace('done');
    host.type('a', '\x1b[A');
    host.type('a', '\x1b');
    host.type('a', '\x03');
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a']);
    host.add('b');
    states.ws_b = workspace('done');
    host.type('b', 'half a prompt');
    // Home's quick reply never types over it (spec §6.7).
    expect(service.hasDraft('b')).toBe(true);
    expect(service.hasDraft('a')).toBe(false);
    expect(service.drafts()).toEqual(['ws_b']);
    service.check();
    pass(10 * MINUTE);
    expect(host.suspended).toEqual(['a']);
    // A background hand-back isn't a prompt; a real one clears the draft.
    hook('UserPromptSubmit', { workspaceId: 'ws_b' }, { prompt: '<task-notification>x' });
    pass(10 * MINUTE);
    expect(host.suspended).toEqual(['a']);
    hook('UserPromptSubmit', { workspaceId: 'ws_b' }, { prompt: 'go' });
    expect(service.drafts()).toEqual([]);
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a', 'b']);
    // A digit answering a permission prompt is no draft.
    host.add('c');
    states.ws_c = workspace('needs-permission');
    host.type('c', '1');
    states.ws_c = workspace('done');
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['a', 'b', 'c']);
  });

  it('reports a draft that starts and one cleared again by ⌫, ⌃U or ⌃C', () => {
    host.add('a');
    states.ws_a = workspace('done');
    const seen: boolean[] = [];
    const off = service.onDraftChange((info) => seen.push(service.hasDraft(info.id)));
    host.type('a', 'half a thought');
    host.type('a', '\x7f'.repeat(13));
    expect(seen).toEqual([true]);
    host.type('a', '\x7f');
    expect(service.hasDraft('a')).toBe(false);
    host.type('a', 'again');
    host.type('a', '\x15');
    host.type('a', 'and again');
    host.type('a', '\x03');
    expect(seen).toEqual([true, false, true, false, true, false]);
    off();
  });

  it('resumes a suspended session when a window shows it', async () => {
    host.add('a', { status: 'suspended' });
    host.add('b', { status: 'suspended' });
    shown.workspaces.add('ws_b');
    service.checkShown();
    await vi.runOnlyPendingTimersAsync();
    expect(resumes).toEqual(['b']);
    // Once per resume.
    host.set('b', { status: 'suspended' });
    service.checkShown();
    service.checkShown();
    expect(resumes).toEqual(['b', 'b']);
  });

  it('wakes a suspended Claude and waits for SessionStart and its prompt', async () => {
    host.add('a', { status: 'suspended' });
    let woken = false;
    const waking = service.wake(host.get('a')).then(() => {
      woken = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumes).toEqual(['a']);
    expect(host.get('a').resuming).toBe(true);
    hook('SessionStart', { workspaceId: 'ws_a' });
    expect(host.get('a').resuming).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(woken).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waking;
    expect(woken).toBe(true);
  });

  it('counts a resume as ready after 20 s without SessionStart', async () => {
    host.add('a', { status: 'suspended' });
    const waking = service.wake(host.get('a'));
    await vi.advanceTimersByTimeAsync(20_001);
    await waking;
    expect(host.get('a').resuming).toBe(false);
  });

  it('ends a session that cannot resume, so it can be started again', async () => {
    host.add('a', { status: 'suspended' });
    const failing = new SuspendService({
      host: host as never,
      delayMin: () => 5,
      workspace: () => null,
      mainCheckoutKept: () => false,
      shown: () => ({ workspaces: new Set(['ws_a']), sessions: new Set() }),
      resume: async () => {
        throw new Error('claude not found');
      },
      followMainClaude: () => {},
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failing.checkShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.get('a').status).toBe('exited');
    failing.stop();
  });

  it('gives a resume back the permission mode and model the session had', () => {
    host.add('a');
    expect(service.restoreArgs('a')).toEqual([]);
    hook(
      'UserPromptSubmit',
      { workspaceId: 'ws_a' },
      { prompt: 'x', permission_mode: 'acceptEdits' },
    );
    service.handleStatusLine({
      profileId: 'work',
      workspaceId: 'ws_a',
      rateLimits: null,
      model: 'claude-haiku-5-5',
    });
    expect(service.restoreArgs('a')).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--model',
      'claude-haiku-5-5',
    ]);
  });

  it("follows a main checkout's Claude by its own hooks and keeps its state", () => {
    host.add('m', { workspaceId: null });
    const send = (event: string, payload: object = {}) =>
      hook(event, { sessionId: 'm' }, { session_id: 'conv-1', ...payload });
    send('SessionStart');
    expect(follows).toContainEqual(['m', 'conv-1']);
    send('UserPromptSubmit', { prompt: 'hi' });
    service.check();
    pass(10 * MINUTE);
    expect(host.suspended).toEqual([]);
    send('Stop', { background_tasks: [{ type: 'shell', status: 'running' }] });
    service.check();
    pass(10 * MINUTE);
    expect(host.suspended).toEqual([]);
    send('Stop');
    // Its tab shown, or kept for the project, keeps it.
    shown.sessions.add('m');
    service.check();
    pass(10 * MINUTE);
    expect(host.suspended).toEqual([]);
    shown.sessions.delete('m');
    kept.push('api');
    pass(10 * MINUTE);
    expect(host.suspended).toEqual([]);
    kept.length = 0;
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['m']);
  });

  it("interrupts a main checkout's Claude with Esc, which then counts as idle", () => {
    host.add('m', { workspaceId: null });
    hook('UserPromptSubmit', { sessionId: 'm' }, { prompt: 'hi' });
    host.type('m', '\x1b');
    service.check();
    pass(5 * MINUTE);
    expect(host.suspended).toEqual(['m']);
  });
});
