import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CliHandlers,
  HookBridge,
  type HookMessage,
  type LinkRequest,
  type MergeCliRequest,
} from './server';

const cli: CliHandlers = {
  add: async () => ({ ok: false, error: 'unused' }),
  link: async () => ({ ok: false, error: 'unused' }),
  projects: () => ({ ok: false, error: 'unused' }),
  merge: async () => ({ ok: false, error: 'unused' }),
  sessionNote: () => null,
};

let bridge: HookBridge;

beforeEach(async () => {
  bridge = new HookBridge();
  await bridge.start();
});
afterEach(() => bridge.stop());

const post = (route: string, body: unknown, token = bridge.token) =>
  fetch(`${bridge.url}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('HookBridge', () => {
  it('listens on 127.0.0.1 and refuses requests without the token', async () => {
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await post('/hook', { event: 'Stop' }, 'wrong')).status).toBe(403);
    expect((await fetch(`${bridge.url}/hook`)).status).toBe(403);
  });

  it('emits hook and status line messages', async () => {
    const hooks: HookMessage[] = [];
    bridge.onHook((m) => hooks.push(m));
    const lines: unknown[] = [];
    bridge.onStatusLine((m) => lines.push(m));
    expect(
      (
        await post('/hook', {
          event: 'Stop',
          workspaceId: 'ws',
          profileId: 'work',
          sessionId: 'term-1',
          payload: { a: 1 },
        })
      ).status,
    ).toBe(200);
    await post('/statusline', {
      profileId: 'work',
      rateLimits: { five_hour: {} },
      model: 'claude-haiku-5-5',
    });
    expect(hooks).toEqual([
      {
        event: 'Stop',
        workspaceId: 'ws',
        profileId: 'work',
        sessionId: 'term-1',
        payload: { a: 1 },
      },
    ]);
    expect(lines).toEqual([
      {
        profileId: 'work',
        workspaceId: null,
        sessionId: null,
        rateLimits: { five_hour: {} },
        model: 'claude-haiku-5-5',
      },
    ]);
  });

  it('refuses everything once closed for quitting, and dispatches nothing', async () => {
    const hooks: unknown[] = [];
    bridge.onHook((m) => hooks.push(m));
    bridge.close();
    expect((await post('/hook', { event: 'Stop', workspaceId: 'w1' })).status).toBe(503);
    expect((await post('/statusline', { profileId: 'work' })).status).toBe(503);
    expect(hooks).toEqual([]);
  });

  it('rejects bad bodies and unknown routes', async () => {
    expect((await post('/hook', 'nope')).status).toBe(400);
    expect((await post('/hook', {})).status).toBe(400);
    expect((await post('/other', {})).status).toBe(404);
    expect((await post('/hook', { event: 'x', payload: 'a'.repeat(2_000_000) })).status).toBe(413);
  });

  it('answers add requests with the handler result', async () => {
    bridge.handleCli({
      ...cli,
      add: async (r) =>
        r.path === '/bad'
          ? { ok: false, error: 'not a repository' }
          : {
              ok: true,
              project: { id: 'p', profileId: 'work', repoPath: r.path, baseBranch: 'main' },
            },
    });
    expect(await (await post('/add', { path: '/r', profileId: 'work' })).json()).toMatchObject({
      ok: true,
      project: { repoPath: '/r' },
    });
    expect(await (await post('/add', { path: '/bad' })).json()).toEqual({
      ok: false,
      error: 'not a repository',
    });
  });

  it('answers link and projects requests, and a failing handler with its message', async () => {
    const asked: LinkRequest[] = [];
    bridge.handleCli({
      ...cli,
      link: async (r) => {
        asked.push(r);
        if (r.project === 'boom') throw new Error('boom');
        return {
          ok: true,
          name: 'web',
          projectId: 'web',
          added: false,
          worktreePath: '/w/web',
          branch: 'b',
          baseBranch: 'main',
          setup: false,
          setupError: null,
        };
      },
      projects: () => ({
        ok: true,
        projects: [{ id: 'web', name: 'web', repoPath: '/r/web', inWorkspace: 'no' }],
      }),
    });
    const link = {
      project: 'web',
      cwd: '/c',
      workspaceId: 'ws',
      profileId: 'work',
      byClaude: true,
    };
    expect(await (await post('/link', link)).json()).toMatchObject({
      ok: true,
      worktreePath: '/w/web',
    });
    expect(asked).toEqual([link]);
    expect(await (await post('/link', { project: 'boom' })).json()).toEqual({
      ok: false,
      error: 'boom',
    });
    expect((await post('/link', {})).status).toBe(400);
    expect(await (await post('/projects', { profileId: 'work' })).json()).toMatchObject({
      ok: true,
      projects: [{ id: 'web' }],
    });
  });

  it('answers merge requests with their fields cleaned up (spec §21.10)', async () => {
    const asked: MergeCliRequest[] = [];
    bridge.handleCli({
      ...cli,
      merge: async (r) => {
        asked.push(r);
        if (r.workspaceId === 'boom') throw new Error('boom');
        return { ok: true, branch: 'b', preflight: null, report: null };
      },
    });
    expect(
      await (
        await post('/merge', {
          action: 'merge',
          workspaceId: 'ws',
          order: ['api', 3, 'web'],
          methods: { api: 'squash', web: 1 },
          deleteBranch: false,
          byClaude: true,
        })
      ).json(),
    ).toEqual({ ok: true, branch: 'b', preflight: null, report: null });
    expect(await (await post('/merge', { workspaceId: 'boom' })).json()).toEqual({
      ok: false,
      error: 'boom',
    });
    expect(asked).toEqual([
      {
        action: 'merge',
        workspaceId: 'ws',
        order: ['api', 'web'],
        methods: { api: 'squash' },
        deleteBranch: false,
        byClaude: true,
      },
      {
        action: 'preflight',
        workspaceId: 'boom',
        order: [],
        methods: {},
        deleteBranch: true,
        byClaude: false,
      },
    ]);
  });

  it("answers SessionStart with Claude's note, other hooks with nothing", async () => {
    bridge.handleCli({ ...cli, sessionNote: (id) => (id === 'ws' ? 'note' : null) });
    const answer = async (body: unknown) => (await post('/hook', body)).json();
    expect(await answer({ event: 'SessionStart', workspaceId: 'ws' })).toEqual({
      additionalContext: 'note',
    });
    expect(await answer({ event: 'SessionStart', workspaceId: 'other' })).toEqual({});
    expect(await answer({ event: 'Stop', workspaceId: 'ws' })).toEqual({});
  });

  it('writes cli.json readable by the user only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
    try {
      const file = path.join(dir, 'cli.json');
      bridge.writeCliFile(file);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
        url: bridge.url,
        token: bridge.token,
      });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
