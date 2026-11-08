import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import type { ProcessEntry } from '../memory/processes';
import { SessionHost } from '../sessions/host';
import { HOLD_MINUTES } from './hold';
import { type Alert, MINUTE_MS, StatusService } from './service';

/** The hold's fixed fallback, for a command whose process is never found (spec §10.2). */
const HOLD_DONE_MS = HOLD_MINUTES.fallback * MINUTE_MS;

const workspace: Omit<Workspace, 'repos'> = {
  id: 'ws_1',
  profileId: 'work',
  projectId: 'api',
  name: 'PROJ-1 Fix login',
  task: { id: 'PROJ-1', title: 'Fix login', url: null },
  branch: 'PROJ-1-fix-login',
  baseBranch: 'main',
  worktreePath: '/w/PROJ-1-fix-login',
  state: 'starting',
  unread: false,
  stateMessage: null,
  background: 0,
  unfinished: null,
  lastPrompt: null,
  keepRunning: false,
  claudeMayLink: true,
  stateSince: null,
  claudeSessionId: null,
  ports: null,
  pr: null,
  createdAt: '2026-10-28T10:00:00Z',
  lastActivityAt: null,
};

let records: WorkspaceRecords;
let host: SessionHost;
let status: StatusService;
let visible: boolean;
let quiet: boolean;
let notified: Alert[];
let badge: number;

beforeEach(() => {
  records = new WorkspaceRecords(openStateDb(':memory:'));
  records.insert(workspace);
  host = new SessionHost({ killTimeoutMs: 300 });
  visible = false;
  quiet = false;
  notified = [];
  badge = -1;
  status = new StatusService(
    records,
    host,
    {
      claudeTabInFocus: () => visible,
      quiet: () => quiet,
      profileName: () => 'Work',
      notify: (a) => notified.push(a),
      setBadge: (n) => {
        badge = n;
      },
    },
    [50],
  );
});
afterEach(() => host.stopAll());

const hook = (event: string, payload: unknown = {}, workspaceId: string | null = 'ws_1') =>
  status.handleHook({ event, workspaceId, profileId: 'work', payload });
const state = () => records.get('ws_1')?.state;

describe('StatusService', () => {
  it('plays the Error sound when a workspace goes into Error, without a notification', () => {
    const alerts: Alert[] = [];
    status.onAlert((a) => alerts.push(a));
    records.setState('ws_1', 'error', { message: 'Setup failed' });
    records.setState('ws_1', 'error', { message: 'Still failing' });
    expect(alerts.map((a) => [a.state, a.title, a.body])).toEqual([
      ['error', '[Work] PROJ-1 failed', 'Setup failed'],
    ]);
    expect(notified).toEqual([]);
    // Not while you're looking at it, nor with Do Not Disturb.
    records.setState('ws_1', 'starting');
    visible = true;
    records.setState('ws_1', 'error');
    records.setState('ws_1', 'starting');
    visible = false;
    quiet = true;
    records.setState('ws_1', 'error');
    expect(alerts).toHaveLength(1);
  });

  it('moves the state with hooks, notifies, counts the badge and keeps the session id', () => {
    hook('SessionStart', { session_id: 's1', transcript_path: '/t/s1.jsonl' });
    expect(records.get('ws_1')?.claudeSessionId).toBe('s1');
    hook('UserPromptSubmit');
    expect(state()).toBe('working');
    hook('Notification', { message: 'Claude needs your permission to use Bash' });
    expect(state()).toBe('needs-permission');
    expect(badge).toBe(1);
    expect(notified).toEqual([
      {
        workspaceId: 'ws_1',
        profileId: 'work',
        state: 'needs-permission',
        title: '[Work] PROJ-1 needs permission',
        body: 'Claude needs your permission to use Bash',
      },
    ]);
    hook('PostToolUse');
    expect(badge).toBe(0);
    hook('Stop');
    expect(records.get('ws_1')).toMatchObject({ state: 'done', unread: true });
    // The idle notice after Done changes nothing and doesn't alert again.
    hook('Notification', { message: 'Claude is waiting for your input' });
    expect(state()).toBe('done');
    expect(notified.map((a) => a.state)).toEqual(['needs-permission', 'done']);
  });

  it('stays quiet while the Claude tab is in focus or the profile is on Do Not Disturb', () => {
    visible = true;
    hook('Stop');
    expect(records.get('ws_1')).toMatchObject({ state: 'done', unread: false });
    visible = false;
    quiet = true;
    hook('Notification', { message: 'Allow?' });
    expect(state()).toBe('needs-permission');
    expect(notified).toEqual([]);
  });

  it('finds the workspace by working directory when the id is missing', () => {
    hook('UserPromptSubmit', { cwd: '/w/PROJ-1-fix-login' }, null);
    expect(state()).toBe('working');
  });

  it('starts, interrupts on Esc while Working and exits with the process', async () => {
    const session = host.spawn({
      kind: 'claude',
      title: 'claude',
      command: '/bin/sh',
      args: ['-c', 'read x'],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      profileId: 'work',
      workspaceId: 'ws_1',
    });
    expect(state()).toBe('starting');
    expect(records.claudeWasRunning().map((w) => w.id)).toEqual(['ws_1']);
    hook('UserPromptSubmit');
    const view = host.attach(session.id, { send: () => {}, close: () => {} });
    view.input('\x1b');
    expect(state()).toBe('interrupted');
    view.input('\r');
    await vi.waitFor(() => expect(state()).toBe('exited'));
    expect(records.claudeWasRunning()).toEqual([]);
  });

  it('stays Working while Claude waits for background agents, then is Done once', async () => {
    const session = host.spawn({
      kind: 'claude',
      title: 'claude',
      command: '/bin/sh',
      args: ['-c', 'read x'],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      profileId: 'work',
      workspaceId: 'ws_1',
    });
    const agents = (n: number) => ({
      background_tasks: Array.from({ length: n }, (_, i) => ({
        id: `a${i}`,
        type: 'subagent',
        status: 'running',
      })),
    });
    hook('UserPromptSubmit');
    hook('Stop', agents(2));
    expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 2 });
    expect(notified).toEqual([]);
    // The agents' own tools keep it; the idle notice and Esc at Claude's prompt don't count.
    hook('PreToolUse', { agent_id: 'a0', tool_name: 'Bash' });
    hook('Notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    const view = host.attach(session.id, { send: () => {}, close: () => {} });
    view.input('\x1b');
    expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 2 });
    // One agent hands back: Claude takes another turn, then waits for the other.
    hook('UserPromptSubmit', { prompt: '<task-notification>…</task-notification>' });
    hook('Stop', agents(1));
    expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 1 });
    hook('UserPromptSubmit', { prompt: '<task-notification>…</task-notification>' });
    hook('Stop', agents(0));
    expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 0, unread: true });
    expect(notified.map((a) => [a.state, a.body])).toEqual([['done', 'Fix login']]);
    // Esc while Claude itself works still interrupts.
    hook('UserPromptSubmit');
    view.input('\x1b');
    expect(state()).toBe('interrupted');
  });

  it('sends no prompt for background work handing back (spec §6.8)', () => {
    const events: string[] = [];
    status.onConversation((e) => events.push(`${e.event}:${e.text}`));
    hook('UserPromptSubmit', { prompt: 'Run it in the background' });
    hook('Stop', { last_assistant_message: 'Started.' });
    hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>b1</task-id>' });
    hook('UserPromptSubmit', { prompt: '<agent-message from="a1">\nReport' });
    hook('Stop', { last_assistant_message: 'It finished.' });
    expect(events).toEqual([
      'UserPromptSubmit:Run it in the background',
      'Stop:Started.',
      'Stop:It finished.',
    ]);
    expect(state()).toBe('done');
  });

  it('tells of a resumed session, whose earlier prompts come back (spec §6.8)', () => {
    const events: string[] = [];
    status.onConversation((e) => events.push(`${e.event}:${e.transcript}`));
    hook('SessionStart', { source: 'startup', transcript_path: '/t/a.jsonl' });
    hook('SessionStart', { source: 'resume', transcript_path: '/t/a.jsonl' });
    hook('SessionStart', { source: 'clear', transcript_path: '/t/b.jsonl' });
    expect(events).toEqual(['SessionStart:/t/a.jsonl']);
  });

  it('is Done with a note when only dev servers Claude started still run', () => {
    hook('UserPromptSubmit');
    hook('Stop', {
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run dev' }],
    });
    expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1 });
    expect(notified.map((a) => [a.state, a.body])).toEqual([
      ['done', 'Fix login · 1 still running in the background'],
    ]);
    // The idle notice after Done changes nothing; the count stays until the next Stop.
    hook('Notification', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    expect(state()).toBe('done');
    hook('UserPromptSubmit');
    expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 1 });
    hook('SessionEnd');
    expect(records.get('ws_1')).toMatchObject({ state: 'exited', background: 0 });
  });

  describe('Done held for background commands (spec §10.2)', () => {
    const running = (...commands: string[]) => ({
      background_tasks: commands.map((command, i) => ({
        id: `b${i}`,
        type: 'shell',
        status: 'running',
        command,
      })),
    });
    const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };
    const handBack = { prompt: '<task-notification>\n<task-id>b0</task-id>' };
    const summary = () => notified.map((a) => [a.state, a.body]);
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('stays Working while Claude waits for a command, then is Done once', () => {
      hook('UserPromptSubmit');
      hook('Stop', running('sleep 60 && echo finished'));
      expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 1, unread: false });
      // The idle notice doesn't end it; the hand-back and Claude's turn after it don't either.
      hook('Notification', idle);
      vi.advanceTimersByTime(HOLD_DONE_MS - 1000);
      expect(state()).toBe('working');
      hook('UserPromptSubmit', handBack);
      hook('PreToolUse', { tool_name: 'Read' });
      vi.advanceTimersByTime(2000);
      expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 1 });
      expect(notified).toEqual([]);
      hook('Stop', running());
      expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 0, unread: true });
      vi.advanceTimersByTime(HOLD_DONE_MS);
      expect(summary()).toEqual([['done', 'Fix login']]);
    });

    it('is Done with a note at the fallback, and Done again after a late hand-back', () => {
      hook('UserPromptSubmit');
      hook('Stop', running('npm run dev', './watch-forever.sh'));
      vi.advanceTimersByTime(HOLD_DONE_MS - 1);
      expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 2 });
      expect(notified).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 2, unread: true });
      expect(summary()).toEqual([['done', 'Fix login · 2 still running in the background']]);
      hook('UserPromptSubmit', handBack);
      hook('Stop', running('npm run dev'));
      expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1 });
      expect(summary()).toHaveLength(2);
    });

    it('sends nothing at the fallback while the Claude tab is in view', () => {
      hook('UserPromptSubmit');
      hook('Stop', running('sleep 900'));
      visible = true;
      vi.advanceTimersByTime(HOLD_DONE_MS);
      expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1, unread: false });
      expect(notified).toEqual([]);
    });

    it('ends without Done at a typed prompt, a permission request or the end of the session', () => {
      hook('UserPromptSubmit');
      hook('Stop', running('sleep 60'));
      hook('UserPromptSubmit', { prompt: 'Something else meanwhile' });
      vi.advanceTimersByTime(HOLD_DONE_MS);
      expect(state()).toBe('working');
      hook('Stop', running('sleep 60'));
      hook('Notification', { message: 'Claude needs your permission to use Bash' });
      vi.advanceTimersByTime(HOLD_DONE_MS);
      expect(state()).toBe('needs-permission');
      hook('UserPromptSubmit');
      hook('Stop', running('sleep 60'));
      hook('SessionEnd');
      vi.advanceTimersByTime(HOLD_DONE_MS);
      expect(state()).toBe('exited');
      expect(notified.map((a) => a.state)).toEqual(['needs-permission']);
    });

    describe('with the processes below Claude', () => {
      const CLAUDE_PID = 100;
      let table: ProcessEntry[];
      const entry = (pid: number, ppid: number, args: string): ProcessEntry => ({
        pid,
        ppid,
        rss: 0,
        name: args.split(' ')[0] ?? '',
        args,
      });
      /** Claude, and a background shell for each command, as Claude Code starts them. */
      const running = (...commands: string[]) => {
        table = [
          entry(CLAUDE_PID, 1, 'claude'),
          ...commands.map((c, i) =>
            entry(200 + i, CLAUDE_PID, `/bin/zsh -c eval '${c}' < /dev/null`),
          ),
        ];
      };
      const stop = (...commands: string[]) =>
        hook('Stop', {
          background_tasks: commands.map((command, i) => ({
            id: `b${i}`,
            type: 'shell',
            status: 'running',
            command,
          })),
        });
      const reads = { count: 0 };
      beforeEach(() => {
        table = [];
        reads.count = 0;
        vi.spyOn(host, 'processes').mockReturnValue([
          { info: { workspaceId: 'ws_1' } as never, pid: CLAUDE_PID },
        ]);
        status = new StatusService(
          records,
          host,
          {
            claudeTabInFocus: () => visible,
            quiet: () => quiet,
            profileName: () => 'Work',
            notify: (a) => notified.push(a),
            setBadge: () => {},
          },
          [50],
          {
            readProcesses: async () => {
              reads.count++;
              return table;
            },
          },
        );
      });
      const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * MINUTE_MS);

      it('stays Working past the old 10 minutes while the process lives, then Done after the hand-back', async () => {
        running('./scripts/linux-check.sh');
        hook('UserPromptSubmit');
        stop('./scripts/linux-check.sh');
        await minutes(25);
        expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 1 });
        expect(notified).toEqual([]);
        running();
        hook('UserPromptSubmit', handBack);
        hook('Stop', {});
        expect(summary()).toEqual([['done', 'Fix login']]);
        // The hold is over: the process table isn't read any more.
        const after = reads.count;
        await minutes(5);
        expect(reads.count).toBe(after);
      });

      it('is Done with a note 2 minutes after the process is gone, without a hand-back', async () => {
        running('make test');
        hook('UserPromptSubmit');
        stop('make test');
        await minutes(3);
        // Seen gone at the next look (every quarter minute), Done the grace after it.
        running();
        await minutes(HOLD_MINUTES.grace);
        expect(state()).toBe('working');
        await minutes(HOLD_MINUTES.poll);
        expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1 });
        expect(summary()).toEqual([['done', 'Fix login · 1 still running in the background']]);
      });

      it('keeps the old 10 minutes when the process is never found', async () => {
        running('something else');
        hook('UserPromptSubmit');
        stop('./watch-forever.sh');
        await minutes(HOLD_MINUTES.fallback - 0.25);
        expect(state()).toBe('working');
        await minutes(0.25);
        expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1 });
      });

      it('is Done at the 2-hour cap with the process still alive', async () => {
        running('tail -f build.log');
        hook('UserPromptSubmit');
        stop('tail -f build.log');
        await minutes(HOLD_MINUTES.cap - 0.25);
        expect(state()).toBe('working');
        await minutes(0.25);
        expect(summary()).toEqual([['done', 'Fix login · 1 still running in the background']]);
      });

      it('is Done at once with a dev server, without looking for it', async () => {
        running('npm run dev');
        hook('UserPromptSubmit');
        stop('npm run dev');
        expect(records.get('ws_1')).toMatchObject({ state: 'done', background: 1 });
        await minutes(1);
        expect(reads.count).toBe(0);
      });
    });

    it("holds Done when a Stop lists only the agents' own commands (checked live)", () => {
      hook('UserPromptSubmit');
      hook('Stop', {
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'running' },
          { id: 'a2', type: 'subagent', status: 'running' },
        ],
      });
      hook('Stop', running('sleep 30', 'sleep 30'));
      hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash' });
      expect(records.get('ws_1')).toMatchObject({ state: 'working', background: 2 });
      hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>a1</task-id>' });
      hook('Stop', running());
      expect(summary()).toEqual([['done', 'Fix login']]);
    });
  });

  it('leaves Needs permission when the prompt is answered in the Claude tab', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(transcript, '');
    try {
      const session = host.spawn({
        kind: 'claude',
        title: 'claude',
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        profileId: 'work',
        workspaceId: 'ws_1',
      });
      const view = host.attach(session.id, { send: () => {}, close: () => {} });
      hook('UserPromptSubmit', { transcript_path: transcript });
      hook('Notification', { notification_type: 'permission_prompt', message: 'Allow?' });
      // Arrow keys only move the choice.
      view.input('\x1b[B');
      expect(state()).toBe('needs-permission');
      // Yes: Working until the next hook event.
      view.input('\r');
      expect(state()).toBe('working');
      await new Promise((r) => setTimeout(r, 100));
      expect(state()).toBe('working');
      // No: Claude Code sends nothing; its interrupt note in the transcript says so.
      hook('Notification', { notification_type: 'permission_prompt', message: 'Allow?' });
      fs.appendFileSync(
        transcript,
        `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })}\n`,
      );
      view.input('\x1b');
      expect(state()).toBe('working');
      await vi.waitFor(() => expect(state()).toBe('needs-input'));
      expect(records.get('ws_1')?.stateMessage).toMatch(/Permission denied/);
      // A hook event before the check decides instead.
      hook('Notification', { notification_type: 'permission_prompt', message: 'Allow?' });
      view.input('2');
      hook('Stop');
      await new Promise((r) => setTimeout(r, 100));
      expect(state()).toBe('done');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Claude marked for resume when the app quits', async () => {
    const session = host.spawn({
      kind: 'claude',
      title: 'claude',
      command: '/bin/sh',
      args: ['-c', 'sleep 30'],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      profileId: 'work',
      workspaceId: 'ws_1',
    });
    status.quitting = true;
    await host.stop(session.id);
    expect(state()).toBe('exited');
    expect(records.claudeWasRunning().map((w) => w.id)).toEqual(['ws_1']);
  });
});
