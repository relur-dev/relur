import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEW_CONVERSATION_NOTE } from '@shared/suspend';
import type { Workspace } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { EnvService } from '../env/service';
import { SessionHost } from '../sessions/host';
import { TerminalService } from './terminals';
import { WorkspaceService } from './workspaces';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } }));

let home: string;
let host: SessionHost;
let records: WorkspaceRecords;
let workspaces: WorkspaceService;

const workspace = (id: string, claudeSessionId: string | null): Workspace => ({
  id,
  profileId: 'work',
  projectId: 'api',
  name: id,
  task: { id: null, title: id, url: null },
  branch: id,
  baseBranch: 'main',
  worktreePath: path.join(home, id),
  state: 'working',
  unread: false,
  stateMessage: null,
  background: 0,
  unfinished: null,
  lastPrompt: null,
  keepRunning: false,
  flag: null,
  claudeMayLink: true,
  stateSince: null,
  claudeSessionId,
  ports: null,
  pr: null,
  repos: [
    {
      projectId: 'api',
      primary: true,
      worktreePath: path.join(home, id),
      baseBranch: 'main',
      pr: null,
      hasCommits: false,
      merged: null,
      setupError: null,
    },
  ],
  createdAt: '2026-10-28T10:00:00Z',
  lastActivityAt: null,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  fs.mkdirSync(path.join(home, 'bin'));
  // Records its arguments, one run per file.
  fs.writeFileSync(
    path.join(home, 'bin', 'claude'),
    `#!/bin/sh\nprintf '%s ' "$@" > "$PWD/args.txt"\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  const file = path.join(home, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      profiles: [{ id: 'work', name: 'Work' }],
      projects: [{ id: 'api', profileId: 'work', name: 'api', repoPath: home, remote: null }],
    }),
  );
  const config = new ConfigStore(file);
  config.load();
  const env = new EnvService(
    config,
    Promise.resolve({
      env: { PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, HOME: home },
      shell: '/bin/sh',
      source: 'login-shell',
    }),
  );
  host = new SessionHost({ killTimeoutMs: 300 });
  records = new WorkspaceRecords(openStateDb(':memory:'));
  for (const [id, session] of [
    ['a', 'sess-a'],
    ['b', null],
    ['c', 'sess-c'],
  ] as const) {
    fs.mkdirSync(path.join(home, id));
    records.insert(workspace(id, session));
  }
  records.setClaudeRunning('a', true);
  records.setClaudeRunning('b', true);
  const terminals = new TerminalService(config, env, host);
  workspaces = new WorkspaceService(config, env, records, terminals, () => '/s.json');
});
afterEach(async () => {
  await host.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resume (spec §9.4)', () => {
  it('restarts the Claude sessions that ran at quit, by session id or with --continue', async () => {
    // At launch nothing runs yet, so states that imply Claude were reset.
    expect(records.get('a')?.state).toBe('exited');
    await workspaces.resumeAtLaunch();
    const args = (id: string) => fs.readFileSync(path.join(home, id, 'args.txt'), 'utf8').trim();
    await vi.waitFor(() => expect(fs.existsSync(path.join(home, 'b', 'args.txt'))).toBe(true));
    await vi.waitFor(() => expect(fs.existsSync(path.join(home, 'a', 'args.txt'))).toBe(true));
    expect(args('a')).toBe('--settings /s.json --resume sess-a');
    expect(args('b')).toBe('--settings /s.json --continue');
    expect(fs.existsSync(path.join(home, 'c', 'args.txt'))).toBe(false);
    expect(
      host
        .list()
        .filter((s) => s.kind === 'claude')
        .map((s) => s.workspaceId),
    ).toEqual(['a', 'b']);
  });
});

describe('Start prompt (spec §13.5)', () => {
  it('goes out at the first start only, never on restart or resume', async () => {
    const args = () => fs.readFileSync(path.join(home, 'c', 'args.txt'), 'utf8').trim();
    workspaces.startPrompt = (w) => `Start ${w.branch}.`;
    records.setStartPromptPending('c', true);
    await workspaces.startClaude('c');
    // The first start begins a new conversation with an id the app chose (spec §9.4).
    await vi.waitFor(() =>
      expect(args()).toMatch(/^--settings \/s\.json --session-id \S+ Start c\.$/),
    );
    const session = records.get('c')?.claudeSessionId;
    expect(args()).toBe(`--settings /s.json --session-id ${session} Start c.`);
    expect(records.startPromptPending('c')).toBe(false);
    fs.rmSync(path.join(home, 'c', 'args.txt'));
    await workspaces.restartClaude('c');
    await vi.waitFor(() => expect(args()).toBe(`--settings /s.json --resume ${session}`));
  });
});

describe('a conversation that was never saved (spec §9.8)', () => {
  const claudes = (id: string) =>
    host.list().filter((s) => s.kind === 'claude' && s.workspaceId === id);

  it('starts a new one with the same id instead of resuming, in the same tab', async () => {
    const args = () => fs.readFileSync(path.join(home, 'c', 'args.txt'), 'utf8').trim();
    const transcript = path.join(home, 'transcripts', 'sess-c.jsonl');
    records.setClaudeSession('c', 'sess-c', transcript);
    const first = await workspaces.startClaude('c');
    await vi.waitFor(() => expect(args()).toBe('--settings /s.json --session-id sess-c'));
    expect(first.note).toBe(NEW_CONVERSATION_NOTE);
    // Claude ends; once it saved the conversation, Start Claude resumes it in that tab.
    await host.stop(first.id);
    fs.mkdirSync(path.dirname(transcript));
    fs.writeFileSync(transcript, '{}\n');
    fs.rmSync(path.join(home, 'c', 'args.txt'));
    const again = await workspaces.startClaude('c');
    await vi.waitFor(() => expect(args()).toBe('--settings /s.json --resume sess-c'));
    expect(again).toMatchObject({ id: first.id, generation: 1, note: null });
    expect(claudes('c').map((s) => s.id)).toEqual([first.id]);
  });

  it('starts a new one in the same tab when Claude finds nothing to resume', async () => {
    const starts = path.join(home, 'a', 'starts.txt');
    // As Claude Code: a resume of a conversation it doesn't have fails at once.
    fs.writeFileSync(
      path.join(home, 'bin', 'claude'),
      `#!/bin/sh\necho "$*" >> "$PWD/starts.txt"\ncase " $* " in *" --resume "*) echo "No conversation found with session ID: sess-a"; exit 1 ;; esac\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    const info = await workspaces.startClaude('a');
    await vi.waitFor(() =>
      expect(fs.existsSync(starts) && fs.readFileSync(starts, 'utf8').trim().split('\n')).toEqual([
        '--settings /s.json --resume sess-a',
        expect.stringMatching(/^--settings \/s\.json --session-id [0-9a-f-]{36}$/),
      ]),
    );
    await vi.waitFor(() =>
      expect(host.get(info.id)).toMatchObject({
        status: 'running',
        generation: 1,
        note: NEW_CONVERSATION_NOTE,
      }),
    );
    expect(claudes('a').map((s) => s.id)).toEqual([info.id]);
  });
});
