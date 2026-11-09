import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '@shared/brand';
import { branchChoice } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinishService } from '../changes/finish';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { EnvService } from '../env/service';
import { SessionHost } from '../sessions/host';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { TerminalService } from './terminals';
import { WorkspaceService } from './workspaces';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } }));

describe('a workspace from an existing branch (spec §7.6)', () => {
  let fx: Fixture;
  let host: SessionHost;
  let records: WorkspaceRecords;
  let workspaces: WorkspaceService;
  let finish: FinishService;
  let terminals: TerminalService;
  const repos: Record<string, { origin: string; clone: string }> = {};

  beforeEach(() => {
    fx = createFixture();
    const bin = path.join(fx.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    for (const name of ['api', 'web', 'lib']) repos[name] = fx.cloneWithRemote(name);
    const file = path.join(fx.root, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profiles: [
          { id: 'work', name: 'Work', defaults: { worktreeRoot: path.join(fx.root, 'wt') } },
        ],
        projects: ['api', 'web', 'lib'].map((name) => ({
          id: name,
          profileId: 'work',
          name,
          repoPath: repos[name]?.clone,
          remote: 'origin',
        })),
      }),
    );
    const config = new ConfigStore(file);
    config.load();
    const env = new EnvService(
      config,
      Promise.resolve({
        env: { ...fx.env, PATH: `${bin}:${fx.env.PATH}` },
        shell: '/bin/sh',
        source: 'login-shell',
      }),
    );
    host = new SessionHost({ killTimeoutMs: 300 });
    records = new WorkspaceRecords(openStateDb(':memory:'));
    terminals = new TerminalService(config, env, host);
    workspaces = new WorkspaceService(config, env, records, terminals, () => '/s.json');
    finish = new FinishService(config, records, terminals);
  });
  afterEach(async () => {
    await host.stopAll();
    fx.cleanup();
  });

  /** Someone else pushes `branch` to the project's bare remote, with a commit by Ana. */
  const pushedByAna = (name: string, branch: string, file = 'feature.txt') => {
    const other = path.join(fx.root, `${name}-ana-${branch.replace(/\//g, '-')}`);
    fx.git(fx.root, 'clone', '-q', repos[name]?.origin as string, other);
    fx.git(other, 'checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(other, file), 'from Ana\n');
    fx.git(other, 'add', '.');
    // A minute later than the fixture's commits, so it sorts first.
    execFileSync('git', ['commit', '-q', '--author=Ana <ana@example.com>', '-m', 'Ana’s change'], {
      cwd: other,
      env: { ...fx.env, GIT_COMMITTER_DATE: new Date(Date.now() + 60_000).toISOString() },
    });
    fx.git(other, 'push', '-q', 'origin', branch);
    return other;
  };
  const create = (branch: string, linkedProjectIds: string[] = [], remote: string | null = null) =>
    workspaces.create({
      projectId: 'api',
      taskId: null,
      title: 'Ana’s feature',
      branch,
      baseBranch: 'main',
      linkedProjectIds,
      existing: { remote },
    });
  const api = () => repos.api?.clone as string;

  it('lists local and remote branches after a fetch, newest first, with where they are', async () => {
    pushedByAna('api', 'feature/login');
    const before = await workspaces.existingBranches('api', false);
    expect(before.branches.map((b) => b.name)).not.toContain('feature/login');
    const list = await workspaces.existingBranches('api', true);
    expect(list.fetchErrors).toEqual([]);
    const login = list.branches.find((b) => b.name === 'feature/login');
    expect(login).toMatchObject({
      local: false,
      remotes: ['origin'],
      author: 'Ana',
      subject: 'Ana’s change',
      checkedOut: null,
      base: false,
    });
    expect(list.branches[0]?.name).toBe('feature/login');
    expect(list.branches.find((b) => b.name === 'main')).toMatchObject({
      local: true,
      remotes: ['origin'],
      base: true,
      checkedOut: { kind: 'main' },
    });
  });

  it('checks out a remote branch tracking it, without a new branch, and Push updates it', async () => {
    const ana = pushedByAna('api', 'feature/login');
    await workspaces.existingBranches('api', true);
    const { workspace } = await create('feature/login');
    const dir = workspace.worktreePath;
    expect(fx.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/login');
    expect(fx.git(dir, 'rev-parse', 'HEAD')).toBe(fx.git(ana, 'rev-parse', 'HEAD'));
    expect(fx.git(api(), 'config', 'branch.feature/login.remote').trim()).toBe('origin');
    expect(fs.existsSync(path.join(dir, BRAND.repoDirName, 'task.md'))).toBe(true);
    const saved = records.get(workspace.id);
    expect(saved?.repos[0]?.branchOrigin).toBe('remote');
    // Its own commits start where it left main: Ana's commit counts as its own.
    expect(records.startCommit(workspace.id)).toBe(fx.git(api(), 'rev-parse', 'main').trim());

    fs.writeFileSync(path.join(dir, 'mine.txt'), 'mine\n');
    await finish.commit(workspace.id, 'My change');
    expect((await finish.state(workspace.id)).unpushed).toBe(1);
    await finish.push(workspace.id);
    expect(fx.git(repos.api?.origin as string, 'rev-parse', 'feature/login')).toBe(
      fx.git(dir, 'rev-parse', 'HEAD'),
    );

    // Delete keeps the remote branch and names Ana before the local one goes.
    const check = await workspaces.deleteCheck(workspace.id);
    const main = check.repos[0];
    expect(main).toMatchObject({
      branchOrigin: 'remote',
      upstream: 'origin/feature/login',
      otherAuthors: ['Ana'],
      unpushed: 0,
    });
    expect(main && branchChoice(main)).toEqual({ shown: true, ticked: true });
    await workspaces.delete(workspace.id, { force: false, deleteBranch: true });
    expect(fx.git(api(), 'branch', '--list', 'feature/login').trim()).toBe('');
    expect(fx.git(repos.api?.origin as string, 'branch', '--list', 'feature/login')).toContain(
      'feature/login',
    );
  });

  it('uses a local branch that was there, sets its upstream, and keeps it when Create fails', async () => {
    pushedByAna('api', 'shared');
    fx.git(api(), 'fetch', '-q', 'origin');
    fx.git(api(), 'branch', '--no-track', 'shared', 'main');
    const { workspace, notes } = await create('shared');
    expect(records.get(workspace.id)?.repos[0]?.branchOrigin).toBe('local');
    expect(fx.git(api(), 'config', 'branch.shared.remote').trim()).toBe('origin');
    // Behind its remote branch: the notice says so.
    expect(notes).toContain(
      'Your local shared is 1 commit behind origin/shared; ask Claude to pull before changing it',
    );
    const check = (await workspaces.deleteCheck(workspace.id)).repos[0];
    expect(check && branchChoice(check)).toEqual({ shown: true, ticked: false });

    // A later Create that fails leaves an existing local branch alone.
    await workspaces.delete(workspace.id, { force: false, deleteBranch: false });
    fx.git(api(), 'branch', 'kept', 'main');
    fs.mkdirSync(path.join(fx.root, 'wt', 'api', 'kept'), { recursive: true });
    await expect(create('kept')).rejects.toThrow('already exists');
    expect(fx.git(api(), 'branch', '--list', 'kept')).toContain('kept');
  });

  it('refuses a branch checked out elsewhere, the base, or one that isn’t there', async () => {
    expect(await workspaces.existingProblem('api', 'main', 'main')).toBe(
      'main is the base branch; start a new branch from it instead',
    );
    fx.git(api(), 'checkout', '-q', '-b', 'mine');
    expect(await workspaces.existingProblem('api', 'mine', 'main')).toBe(
      `mine is checked out in the main checkout of api (${api()}). Switch it to another branch there to make a workspace of it`,
    );
    fx.git(api(), 'checkout', '-q', 'main');
    const other = path.join(fx.root, 'elsewhere');
    fx.git(api(), 'worktree', 'add', '-q', other, 'mine');
    expect(await workspaces.existingProblem('api', 'mine', 'main')).toBe(
      `mine is checked out in a worktree at ${other}`,
    );
    await expect(create('nothing-here')).rejects.toThrow('There is no branch nothing-here in api');

    pushedByAna('api', 'taken');
    await workspaces.existingBranches('api', true);
    const { workspace } = await create('taken');
    expect(await workspaces.existingProblem('api', 'taken', 'main')).toBe(
      `taken is open in the workspace ${workspace.name}`,
    );
    const list = await workspaces.existingBranches('api', false);
    expect(list.branches.find((b) => b.name === 'taken')?.checkedOut).toMatchObject({
      kind: 'workspace',
      workspaceId: workspace.id,
    });
  });

  it('finds the branch of a pasted branch or pull request URL', async () => {
    const ana = pushedByAna('api', 'feature/login');
    await workspaces.existingBranches('api', true);
    // Local-path remotes can't be compared with a host: any of them may be it.
    expect(
      await workspaces.resolveBranchUrl(
        'api',
        'https://github.com/acme/api/tree/feature/login/src/app.ts',
      ),
    ).toEqual({ ok: true, branch: 'feature/login', remote: 'origin', prUrl: null });
    // GitHub keeps a pull request's head under refs/pull/<n>/head.
    const origin = repos.api?.origin as string;
    fx.git(origin, 'update-ref', 'refs/pull/7/head', fx.git(ana, 'rev-parse', 'HEAD').trim());
    expect(await workspaces.resolveBranchUrl('api', 'https://github.com/acme/api/pull/7')).toEqual({
      ok: true,
      branch: 'feature/login',
      remote: 'origin',
      prUrl: 'https://github.com/acme/api/pull/7',
    });
    const missing = await workspaces.resolveBranchUrl('api', 'https://github.com/acme/api/pull/8');
    expect(missing.ok).toBe(false);
    const cloud = await workspaces.resolveBranchUrl(
      'api',
      'https://bitbucket.org/acme/api/pull-requests/3',
    );
    expect(cloud).toEqual({
      ok: false,
      message:
        "Bitbucket Cloud doesn't tell git which branch pull request #3 comes from. Copy the branch name shown at the top of the pull request page and paste it here, or pick the branch from the list.",
    });
    // A URL of another repository than the remote's.
    fx.git(api(), 'remote', 'set-url', 'origin', 'git@github.com:acme/api.git');
    expect(
      await workspaces.resolveBranchUrl('api', 'https://github.com/acme/other/tree/feature/login'),
    ).toEqual({
      ok: false,
      message: 'That URL is for github.com/other, not api (origin is github.com/api)',
    });
  });

  it('linked repositories use the branch where they have it, else a new one', async () => {
    pushedByAna('api', 'feature/x');
    pushedByAna('web', 'feature/x');
    await workspaces.existingBranches('api', true);
    // web hasn't fetched it: its remote's answer says it has it.
    expect(await workspaces.branchPresence(['web', 'lib'], 'feature/x')).toEqual([
      { projectId: 'web', exists: true, checkedOut: null },
      { projectId: 'lib', exists: false, checkedOut: null },
    ]);
    const { workspace } = await create('feature/x', ['web', 'lib']);
    const [main, web, lib] = records.get(workspace.id)?.repos ?? [];
    expect([main?.branchOrigin, web?.branchOrigin, lib?.branchOrigin]).toEqual([
      'remote',
      'remote',
      'new',
    ]);
    const webClone = repos.web?.clone as string;
    expect(fx.git(webClone, 'config', 'branch.feature/x.remote').trim()).toBe('origin');
    const libClone = repos.lib?.clone as string;
    expect(fx.git(libClone, 'rev-parse', 'feature/x')).toBe(fx.git(libClone, 'rev-parse', 'main'));
  });

  it('counts commits behind the base and the files a merge would conflict in', async () => {
    pushedByAna('api', 'feature/readme', 'README');
    await workspaces.existingBranches('api', true);
    const { workspace } = await create('feature/readme');
    expect(await finish.state(workspace.id)).toMatchObject({
      baseRef: 'origin/main',
      behind: 0,
      conflicts: [],
    });
    // main moves on with a change to the same file.
    const other = path.join(fx.root, 'api-main');
    fx.git(fx.root, 'clone', '-q', repos.api?.origin as string, other);
    fs.writeFileSync(path.join(other, 'README'), 'changed on main\n');
    fx.git(other, 'commit', '-q', '-am', 'main changes README');
    fx.git(other, 'push', '-q', 'origin', 'main');
    fx.git(api(), 'fetch', '-q', 'origin', 'main');
    expect(await finish.state(workspace.id)).toMatchObject({ behind: 1, conflicts: ['README'] });
    expect(await finish.conflicts(workspace.id)).toEqual([
      { projectId: 'api', name: 'api', baseBranch: 'main', files: ['README'] },
    ]);
  });
});
