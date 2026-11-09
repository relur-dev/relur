import fs from 'node:fs';
import path from 'node:path';
import type { OtherWorktree } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { EnvService } from '../env/service';
import { parseWorktreeList } from '../git/git';
import { SessionHost } from '../sessions/host';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { WorktreeNotices } from '../worktrees/notices';
import { TerminalService } from './terminals';
import { WorkspaceService } from './workspaces';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } }));

describe('parseWorktreeList', () => {
  it('reads paths, branches, detached, bare, prunable and locked entries', () => {
    const out = [
      'worktree /r/main',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /r/.worktrees/r/feat-a',
      'HEAD bbb',
      'branch refs/heads/feat/a',
      '',
      'worktree /r/detached',
      'HEAD ccc',
      'detached',
      'locked',
      '',
      'worktree /r/gone',
      'HEAD ddd',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r/main', head: 'aaa', branch: 'main', bare: false, prunable: false, locked: false },
      {
        path: '/r/.worktrees/r/feat-a',
        head: 'bbb',
        branch: 'feat/a',
        bare: false,
        prunable: false,
        locked: false,
      },
      {
        path: '/r/detached',
        head: 'ccc',
        branch: null,
        bare: false,
        prunable: false,
        locked: true,
      },
      { path: '/r/gone', head: 'ddd', branch: 'gone', bare: false, prunable: true, locked: false },
    ]);
    expect(parseWorktreeList('worktree /b\nbare\n')[0]?.bare).toBe(true);
  });
});

describe('adopting worktrees (spec §13.6)', () => {
  let fx: Fixture;
  let repo: string;
  let records: WorkspaceRecords;
  let workspaces: WorkspaceService;
  let host: SessionHost;

  beforeEach(() => {
    fx = createFixture();
    repo = fx.cloneWithRemote('shop').clone;
    const file = path.join(fx.root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'work', name: 'Work' }],
        projects: [
          { id: 'shop', profileId: 'work', name: 'shop', repoPath: repo, worktreeRoot: fx.root },
        ],
      }),
    );
    const config = new ConfigStore(file);
    config.load();
    const env = new EnvService(
      config,
      Promise.resolve({ env: fx.env, shell: '/bin/sh', source: 'login-shell' }),
    );
    host = new SessionHost({ killTimeoutMs: 300 });
    records = new WorkspaceRecords(openStateDb(':memory:'));
    workspaces = new WorkspaceService(
      config,
      env,
      records,
      new TerminalService(config, env, host),
      () => '/s.json',
    );
  });
  afterEach(async () => {
    await host.stopAll();
    fx.cleanup();
  });

  const tree = (branch: string) => path.join(fx.root, '.worktrees', 'shop', branch);

  it('lists unknown worktrees with a prefill, adopts one, and stops listing it', async () => {
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'ABC-12-fix-login', tree('ABC-12-fix-login'));
    fx.git(repo, 'worktree', 'add', '-q', '--detach', tree('detached'));
    workspaces.adoptPrefill = (_p, _w, branch) =>
      branch === 'from-file'
        ? { taskId: 'XYZ-1', title: 'From the file', titleFromField: true }
        : null;
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'from-file', tree('from-file'));

    const others = await workspaces.otherWorktrees('shop');
    expect(others.map((w) => [path.basename(w.path), w.branch, w.taskId, w.title])).toEqual([
      ['ABC-12-fix-login', 'ABC-12-fix-login', 'ABC-12', 'fix login'],
      ['detached', null, null, 'detached'],
      ['from-file', 'from-file', 'XYZ-1', 'From the file'],
    ]);

    const adopted = await workspaces.adopt({
      projectId: 'shop',
      worktreePath: tree('ABC-12-fix-login'),
      taskId: 'ABC-12',
      title: 'Fix login',
      baseBranch: 'main',
      runSetup: false,
    });
    expect(adopted).toMatchObject({
      name: 'ABC-12 Fix login',
      branch: 'ABC-12-fix-login',
      baseBranch: 'main',
      state: 'exited',
    });
    expect(adopted.ports).not.toBeNull();
    expect(records.startCommit(adopted.id)).toBe(fx.git(repo, 'rev-parse', 'origin/main').trim());
    expect(records.startPromptPending(adopted.id)).toBe(false);
    // A title typed over the offered one stays (spec §13.5).
    expect(records.titleFromStatusPending(adopted.id)).toBe(false);
    expect(host.list()).toEqual([]);
    expect((await workspaces.otherWorktrees('shop')).map((w) => w.branch)).toEqual([
      null,
      'from-file',
    ]);
    await expect(
      workspaces.adopt({
        projectId: 'shop',
        worktreePath: tree('detached'),
        taskId: null,
        title: 'x',
        baseBranch: 'main',
        runSetup: false,
      }),
    ).rejects.toThrow(/Detached HEAD/);
    await expect(
      workspaces.adopt({
        projectId: 'shop',
        worktreePath: repo,
        taskId: null,
        title: 'x',
        baseBranch: 'main',
        runSetup: false,
      }),
    ).rejects.toThrow(/can be opened/);
    // Taken from the file's title field already: nothing more to fill in.
    const fromFile = await workspaces.adopt({
      projectId: 'shop',
      worktreePath: tree('from-file'),
      taskId: 'XYZ-1',
      title: 'From the file',
      baseBranch: 'main',
      runSetup: false,
    });
    expect(records.titleFromStatusPending(fromFile.id)).toBe(false);
  });

  it('fills an adopted title from the status file once, when it was only guessed', async () => {
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'ABC-13-guess', tree('ABC-13-guess'));
    const adopted = await workspaces.adopt({
      projectId: 'shop',
      worktreePath: tree('ABC-13-guess'),
      taskId: 'ABC-13',
      title: 'guess',
      baseBranch: 'main',
      runSetup: false,
    });
    expect(records.titleFromStatusPending(adopted.id)).toBe(true);
  });

  it("doesn't offer worktrees being created by the app", async () => {
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'mine', tree('mine'));
    workspaces.creating.add(tree('mine'));
    expect(await workspaces.otherWorktrees('shop')).toEqual([]);
  });
});

describe('WorktreeNotices', () => {
  it('reports worktrees that appear after the baseline, each once', async () => {
    const fx = createFixture();
    try {
      const file = path.join(fx.root, 'config.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          profiles: [{ id: 'work', name: 'Work' }],
          projects: [
            {
              id: 'shop',
              profileId: 'work',
              name: 'shop',
              repoPath: fx.root,
              worktreeRoot: fx.root,
            },
          ],
        }),
      );
      const config = new ConfigStore(file);
      config.load();
      let listed: OtherWorktree[] = [
        { path: '/old', branch: 'old', taskId: null, title: 'old', titleFromField: false },
      ];
      const notices = new WorktreeNotices(config, { otherWorktrees: async () => listed }, 20);
      const found: string[] = [];
      notices.onNew((w) => found.push(`${w.projectName}:${w.branch}`));
      await notices.start();
      expect(found).toEqual([]);
      listed = [
        ...listed,
        { path: '/new', branch: 'feat', taskId: null, title: 'feat', titleFromField: false },
      ];
      await notices.check('shop');
      await notices.check('shop');
      expect(found).toEqual(['shop:feat']);

      // A new folder in the project's worktree folder is checked by itself.
      const dir = path.join(fx.root, '.worktrees', 'shop');
      fs.mkdirSync(dir, { recursive: true });
      notices.focused(0);
      await vi.waitFor(() => expect(found).toEqual(['shop:feat']));
      listed = [
        ...listed,
        { path: path.join(dir, 'b'), branch: 'b', taskId: null, title: 'b', titleFromField: false },
      ];
      await new Promise((r) => setTimeout(r, 50));
      fs.mkdirSync(path.join(dir, 'b'));
      await vi.waitFor(() => expect(found).toEqual(['shop:feat', 'shop:b']));
      notices.dispose();
    } finally {
      fx.cleanup();
    }
  });
});
