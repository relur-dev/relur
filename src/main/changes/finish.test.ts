import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Workspace } from '@shared/workspaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import type { TerminalService } from '../services/terminals';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { SEED_CONFIG } from '../test-support/seed-config';
import {
  commitMessage,
  FinishService,
  fillTemplate,
  parsePrOutput,
  parsePrStatus,
  pushProblem,
} from './finish';

describe('finish helpers', () => {
  it('fills the create prompt, dropping what is empty', () => {
    const template =
      'Open a pull request from this branch into {base}. Title: "{id}: {title}". Link the task: {url}.';
    expect(
      fillTemplate(template, {
        base: 'develop',
        id: 'PROJ-1',
        title: 'Fix it',
        url: 'https://x/1',
      }),
    ).toBe(
      'Open a pull request from this branch into develop. Title: "PROJ-1: Fix it". Link the task: https://x/1.',
    );
    expect(fillTemplate(template, { base: 'main', id: '', title: 'Fix it', url: '' })).toBe(
      'Open a pull request from this branch into main. Title: "Fix it".',
    );
  });

  it('prefills the commit message with id and title', () => {
    const w = (id: string | null, title: string) =>
      ({
        task: { id, title, url: null },
        name: [id, title].filter(Boolean).join(' '),
      }) as Workspace;
    expect(commitMessage(w('PROJ-1', 'Fix login'))).toBe('PROJ-1: Fix login');
    expect(commitMessage(w(null, 'Fix login'))).toBe('Fix login');
    expect(commitMessage(w('PROJ-2', ''))).toBe('PROJ-2: PROJ-2');
  });

  it('explains a push that needs credentials', () => {
    expect(
      pushProblem(
        'origin',
        "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      ),
    ).toMatch(/^git couldn't sign in to origin\. The app can't ask for a password/);
    expect(pushProblem('origin', ' ! [rejected] x -> x (fetch first)')).toMatch(
      /rejected the push/,
    );
  });

  it('reads the PR status command output', () => {
    expect(parsePrStatus('')).toBeNull();
    expect(parsePrStatus('null\n')).toBeNull();
    expect(parsePrStatus('{"state":"draft","url":"https://x/pr/1"}')).toEqual({
      state: 'draft',
      url: 'https://x/pr/1',
      source: 'command',
    });
    expect(() => parsePrStatus('nope')).toThrow(/didn't print JSON/);
    expect(() => parsePrStatus('{"state":"weird"}')).toThrow(/unknown state/);
  });

  it('reads the PR title when the command prints one (spec §7.6)', () => {
    expect(parsePrOutput('{"state":"open","url":"u","title":" ABC-1: Fix it "}')).toEqual({
      status: { state: 'open', url: 'u', source: 'command' },
      title: 'ABC-1: Fix it',
    });
    expect(parsePrOutput('{"state":"open","url":"u"}').title).toBeNull();
    expect(parsePrOutput('null')).toEqual({ status: null, title: null });
  });
});

describe('FinishService with a local bare remote', () => {
  let fx: Fixture;
  let origin: string;
  let repo: string;
  let worktree: string;
  let records: WorkspaceRecords;
  let finish: FinishService;
  let config: ConfigStore;
  const id = 'ws_1';

  beforeAll(async () => {
    fx = createFixture();
    ({ origin, clone: repo } = fx.cloneWithRemote('finish-repo', 'main'));
    worktree = path.join(fx.root, 'wt');
    fx.git(
      repo,
      'worktree',
      'add',
      '-q',
      '--no-track',
      '-b',
      'PROJ-1-fix',
      worktree,
      'origin/main',
    );
    const file = path.join(fx.root, 'config', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...SEED_CONFIG,
        projects: [
          {
            id: 'finish-repo',
            profileId: 'work',
            name: 'finish-repo',
            repoPath: repo,
            remote: 'origin',
            baseBranch: 'main',
          },
        ],
      }),
    );
    config = new ConfigStore(file);
    config.load();
    records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert({
      id,
      profileId: 'work',
      projectId: 'finish-repo',
      name: 'PROJ-1 Fix',
      task: { id: 'PROJ-1', title: 'Fix', url: null },
      branch: 'PROJ-1-fix',
      baseBranch: 'main',
      worktreePath: worktree,
      state: 'done',
      unread: false,
      stateMessage: null,
      background: 0,
      stateSince: null,
      claudeSessionId: null,
      ports: null,
      pr: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: null,
    });
    records.setStartCommit(id, fx.git(worktree, 'rev-parse', 'HEAD').trim());
    const terminals = {
      workspaceCommandEnv: async () => ({ shell: '/bin/sh', env: { ...fx.env } }),
      host: { list: () => [] },
    } as unknown as TerminalService;
    finish = new FinishService(config, records, terminals);
  });
  afterAll(() => fx.cleanup());

  it('lists committed and uncommitted changes against the merge base', async () => {
    fs.writeFileSync(path.join(worktree, 'README'), 'hello\nchanged\n');
    fx.git(worktree, 'commit', '-qam', 'change readme');
    fx.git(worktree, 'mv', 'README', 'README.md');
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'a\nb\n');
    const changes = await finish.changes(id);
    expect(changes.base).toBe('origin/main');
    expect(changes.committed).toEqual([
      { kind: 'M', path: 'README', oldPath: null, added: 1, removed: 0, binary: false },
    ]);
    expect(changes.uncommitted.map((f) => [f.kind, f.path, f.oldPath, f.added])).toEqual([
      ['A', 'new.txt', null, 2],
      ['R', 'README.md', 'README', 0],
    ]);
    const diff = await finish.diff(id, 'committed', { path: 'README', oldPath: null });
    expect(diff).toEqual({ binary: false, original: 'hello\n', modified: 'hello\nchanged\n' });
    const added = await finish.diff(id, 'uncommitted', { path: 'new.txt', oldPath: null });
    expect(added).toEqual({ binary: false, original: null, modified: 'a\nb\n' });
    await expect(finish.diff(id, 'uncommitted', { path: '../x', oldPath: null })).rejects.toThrow(
      /outside/,
    );
  });

  it('commits everything, pushes with -u to the bare remote and shows the state', async () => {
    expect(await finish.state(id)).toMatchObject({
      hasRemote: true,
      uncommitted: 2,
      unpushed: 1,
      pushed: false,
      commitMessage: 'PROJ-1: Fix',
      createsWithCommand: false,
    });
    await finish.commit(id, 'PROJ-1: Fix');
    await expect(finish.commit(id, 'again')).rejects.toThrow(/nothing to commit/);
    await finish.push(id);
    expect(fx.git(origin, 'rev-parse', 'PROJ-1-fix').trim()).toBe(
      fx.git(worktree, 'rev-parse', 'HEAD').trim(),
    );
    expect(await finish.state(id)).toMatchObject({ uncommitted: 0, unpushed: 0, pushed: true });
  });

  it('knows nothing until merged, then Merged; a deleted remote branch is Likely merged', async () => {
    expect(await finish.refreshPr(id)).toBeNull();
    // Merge on the "host": the branch goes into main, in the bare remote.
    const host = path.join(fx.root, 'host');
    fx.git(fx.root, 'clone', '-q', origin, host);
    fx.git(host, 'merge', '-q', '--ff-only', 'origin/PROJ-1-fix');
    fx.git(host, 'push', '-q', 'origin', 'main');
    await new Promise((r) => setTimeout(r, 10));
    // The fetch is throttled per repository; a new service fetches at once.
    const fresh = new FinishService(
      config,
      records,
      (finish as unknown as { terminals: TerminalService }).terminals,
    );
    expect(await fresh.refreshPr(id)).toEqual({ state: 'merged', url: null, source: 'git' });
    expect(records.get(id)?.pr?.state).toBe('merged');
    fx.git(host, 'push', '-q', 'origin', '--delete', 'PROJ-1-fix');
    const later = new FinishService(
      config,
      records,
      (finish as unknown as { terminals: TerminalService }).terminals,
    );
    expect(await later.refreshPr(id)).toEqual({ state: 'likely-merged', url: null, source: 'git' });
  });

  it('uses the PR status command when one is set', async () => {
    config.update((raw) => {
      const [work] = raw.profiles as { pr?: unknown }[];
      if (work)
        work.pr = { statusCommand: `printf '{"state":"open","url":"https://example.com/pr/"}'` };
    });
    expect(await finish.refreshPr(id)).toEqual({
      state: 'open',
      url: 'https://example.com/pr/',
      source: 'command',
    });
  });
});

describe('Ask Claude to write it in a linked workspace (spec §21.5)', () => {
  it('names that repository and its worktree, and only commits there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-ask-'));
    try {
      const file = path.join(dir, 'config.json');
      const project = (id: string) => ({
        id,
        profileId: 'work',
        name: id,
        repoPath: `/r/${id}`,
        remote: null,
        baseBranch: 'main',
      });
      fs.writeFileSync(
        file,
        JSON.stringify({ ...SEED_CONFIG, projects: [project('api'), project('web')] }),
      );
      const config = new ConfigStore(file);
      config.load();
      const records = new WorkspaceRecords(openStateDb(':memory:'));
      records.insert({
        id: 'ws',
        profileId: 'work',
        projectId: 'api',
        name: 'PROJ-9 Both',
        task: { id: 'PROJ-9', title: 'Both', url: null },
        branch: 'PROJ-9-both',
        baseBranch: 'main',
        worktreePath: '/w/api',
        state: 'done',
        unread: false,
        stateMessage: null,
        background: 0,
        stateSince: null,
        claudeSessionId: null,
        ports: null,
        pr: null,
        createdAt: new Date().toISOString(),
        lastActivityAt: null,
        repos: [{ projectId: 'web', worktreePath: '/w/my web', baseBranch: 'main' }],
      });
      const written: string[] = [];
      const terminals = {
        sendToClaude: (_id: string, prompt: string) => written.push(prompt),
      } as unknown as TerminalService;
      new FinishService(config, records, terminals).askClaudeToCommit('ws', 'web');
      expect(written[0]).toContain('in the web repository only, whose worktree is /w/my web');
      expect(written[0]).toContain("git -C '/w/my web' add -A");
      expect(written[0]).toContain('Start the subject line with "PROJ-9: "');
      expect(written[0]).toContain("Don't commit in the workspace's other repositories.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
