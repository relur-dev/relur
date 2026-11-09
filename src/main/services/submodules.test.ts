import fs from 'node:fs';
import path from 'node:path';
import type { WorkspaceRepo } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { EnvService } from '../env/service';
import { Git } from '../git/git';
import { SessionHost } from '../sessions/host';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { TerminalService } from './terminals';
import { WorkspaceService } from './workspaces';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } }));

/**
 * Deleting worktrees with submodules (spec §14.2, §21.6): real repositories,
 * each with a submodule `lib` from its own bare origin.
 */
describe('deleting worktrees with submodules (spec §14.2)', () => {
  let fx: Fixture;
  let host: SessionHost;
  let records: WorkspaceRecords;
  let workspaces: WorkspaceService;
  const projects: Record<string, unknown>[] = [];
  const repoPath = (id: string) => projects.find((p) => p.id === id)?.repoPath as string;

  beforeEach(() => {
    fx = createFixture();
    // Submodules from local paths need this since git 2.38.1.
    fs.writeFileSync(fx.env.GIT_CONFIG_GLOBAL as string, '[protocol "file"]\n\tallow = always\n');
    const bin = path.join(fx.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const { origin: libOrigin } = fx.cloneWithRemote('lib');
    projects.length = 0;
    for (const name of ['app', 'web']) {
      const { clone } = fx.cloneWithRemote(name);
      fx.git(clone, 'submodule', 'add', '-q', libOrigin, 'lib');
      fx.git(clone, 'commit', '-q', '-m', 'Add lib');
      fx.git(clone, 'push', '-q', 'origin', 'main');
      projects.push({ id: name, profileId: 'work', name, repoPath: clone, remote: 'origin' });
    }
    const configFile = path.join(fx.root, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: [
          { id: 'work', name: 'Work', defaults: { worktreeRoot: path.join(fx.root, 'wt') } },
        ],
        projects,
      }),
    );
    const config = new ConfigStore(configFile);
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

  const create = (branch: string, linkedProjectIds: string[] = []) =>
    workspaces.create({
      projectId: 'app',
      taskId: null,
      title: branch,
      branch,
      baseBranch: 'main',
      linkedProjectIds,
    });
  /** What a project's setup command does for its submodules. */
  const initSubmodules = (repo: WorkspaceRepo) =>
    fx.git(repo.worktreePath, 'submodule', 'update', '--init', '-q');
  const worktreeAdmin = (id: string) => path.join(repoPath(id), '.git', 'worktrees');

  it('Create leaves submodules uninitialised; a clean one is removed as git requires', async () => {
    const { workspace } = await create('clean');
    const repo = workspace.repos[0] as WorkspaceRepo;
    // `git worktree add` doesn't check submodules out: that is the setup's job (§8.3).
    expect(fs.readdirSync(path.join(repo.worktreePath, 'lib'))).toEqual([]);
    initSubmodules(repo);
    expect(fs.existsSync(path.join(repo.worktreePath, 'lib', 'README'))).toBe(true);
    // A plain `git worktree remove` refuses it.
    const git = new Git({ gitPath: 'git', env: fx.env });
    await expect(git.removeWorktree(repoPath('app'), repo.worktreePath, 'plain')).rejects.toThrow(
      'submodules cannot be moved or removed',
    );

    const check = await workspaces.deleteCheck(workspace.id);
    expect([check.uncommitted, check.unpushed, check.submodules]).toEqual([[], 0, []]);
    await workspaces.delete(workspace.id, { force: false, deleteBranch: true });
    expect(fs.existsSync(repo.worktreePath)).toBe(false);
    expect(fs.existsSync(worktreeAdmin('app'))).toBe(false);
    expect(fx.git(repoPath('app'), 'branch', '--list', 'clean')).toBe('');
    expect(records.get(workspace.id)).toBeNull();
  });

  it('a dirty submodule blocks the clean path and keeps the workspace intact', async () => {
    const { workspace } = await create('dirty');
    const repo = workspace.repos[0] as WorkspaceRepo;
    initSubmodules(repo);
    fs.appendFileSync(path.join(repo.worktreePath, 'lib', 'README'), 'edit\n');
    fs.writeFileSync(path.join(repo.worktreePath, 'lib', 'new.txt'), 'x');

    const check = await workspaces.deleteCheck(workspace.id);
    expect(check.submodules).toEqual([
      { path: 'lib', uncommitted: [' M README', '?? new.txt'], unpushed: 0 },
    ]);
    expect(check.repos[0]?.submodules).toEqual(check.submodules);
    await vi.waitFor(() =>
      expect(host.list().some((s) => s.workspaceId === workspace.id)).toBe(true),
    );
    await expect(
      workspaces.delete(workspace.id, { force: false, deleteBranch: true }),
    ).rejects.toThrow("The worktree wasn't deleted: it has 1 uncommitted change, submodule lib");
    // Nothing went: the worktree, its submodule's work, the branch, the record, Claude.
    expect(fs.readFileSync(path.join(repo.worktreePath, 'lib', 'new.txt'), 'utf8')).toBe('x');
    expect(fx.git(repoPath('app'), 'branch', '--list', 'dirty')).toContain('dirty');
    expect(records.get(workspace.id)).not.toBeNull();
    expect(host.list().some((s) => s.workspaceId === workspace.id)).toBe(true);

    // Delete anyway.
    await workspaces.delete(workspace.id, { force: true, deleteBranch: true });
    expect(fs.existsSync(repo.worktreePath)).toBe(false);
    expect(records.get(workspace.id)).toBeNull();
  });

  it('counts a commit inside a submodule that is on none of its remotes', async () => {
    const { workspace } = await create('sub-commit');
    const repo = workspace.repos[0] as WorkspaceRepo;
    initSubmodules(repo);
    const lib = path.join(repo.worktreePath, 'lib');
    fx.git(lib, 'commit', '-q', '--allow-empty', '-m', 'only here');
    // The superproject records it, so its own status is clean.
    fx.git(repo.worktreePath, 'commit', '-q', '-am', 'Bump lib');
    const check = await workspaces.deleteCheck(workspace.id);
    expect([check.uncommitted, check.unpushed]).toEqual([[], 1]);
    expect(check.submodules).toEqual([{ path: 'lib', uncommitted: [], unpushed: 1 }]);
    await expect(
      workspaces.delete(workspace.id, { force: false, deleteBranch: false }),
    ).rejects.toThrow('submodule lib has 1 commit not pushed');
    expect(fs.existsSync(lib)).toBe(true);

    // Pushed from the submodule: nothing of its own is left.
    fx.git(lib, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    expect((await workspaces.deleteCheck(workspace.id)).submodules).toEqual([]);
    await workspaces.delete(workspace.id, { force: false, deleteBranch: false });
    expect(fs.existsSync(repo.worktreePath)).toBe(false);
  });

  it('does the same for a linked repository: Delete, Unlink and Remove project', async () => {
    const { workspace } = await create('linked', ['web']);
    const [app, web] = workspace.repos as [WorkspaceRepo, WorkspaceRepo];
    initSubmodules(app);
    initSubmodules(web);
    fx.git(path.join(web.worktreePath, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'web only');

    const check = await workspaces.deleteCheck(workspace.id);
    expect(check.repos.map((r) => [r.projectId, r.submodules])).toEqual([
      ['app', []],
      ['web', [{ path: 'lib', uncommitted: [], unpushed: 1 }]],
    ]);
    expect((await workspaces.unlinkCheck(workspace.id, 'web')).submodules).toHaveLength(1);

    // The main repository is clean, but nothing goes while web's submodule would lose a commit.
    await expect(
      workspaces.delete(workspace.id, { force: false, deleteBranch: true }),
    ).rejects.toThrow("The worktree of web wasn't deleted: it has 1 uncommitted change");
    await expect(
      workspaces.unlink(workspace.id, 'web', { force: false, deleteBranch: true }),
    ).rejects.toThrow('submodule lib has 1 commit not pushed');
    await expect(
      workspaces.deleteProjectWorkspaces(
        'web',
        [],
        [{ workspaceId: workspace.id, force: false, deleteBranch: true }],
      ),
    ).rejects.toThrow('The project was not removed');
    expect(fs.existsSync(app.worktreePath)).toBe(true);
    expect(fs.existsSync(web.worktreePath)).toBe(true);
    expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['app', 'web']);

    // Unlink anyway, then the clean main one goes with its submodule.
    await workspaces.unlink(workspace.id, 'web', { force: true, deleteBranch: true });
    expect(fs.existsSync(web.worktreePath)).toBe(false);
    expect(fs.existsSync(worktreeAdmin('web'))).toBe(false);
    await workspaces.delete(workspace.id, { force: false, deleteBranch: true });
    expect(fs.existsSync(app.worktreePath)).toBe(false);
    expect(records.get(workspace.id)).toBeNull();
  });

  it('removes a clean linked worktree with submodules from Remove project', async () => {
    const { workspace } = await create('remove-web', ['web']);
    const web = workspace.repos[1] as WorkspaceRepo;
    initSubmodules(web);
    await workspaces.deleteProjectWorkspaces(
      'web',
      [],
      [{ workspaceId: workspace.id, force: false, deleteBranch: true }],
    );
    expect(fs.existsSync(web.worktreePath)).toBe(false);
    expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['app']);
  });
});
