import fs from 'node:fs';
import path from 'node:path';
import { BRAND, envVar } from '@shared/brand';
import { type Workspace, type WorkspaceRepo, workspaceMerged } from '@shared/workspaces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedPrContext } from '../changes/finish';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import { EnvService } from '../env/service';
import { Git } from '../git/git';
import { SessionHost } from '../sessions/host';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { type CliLinkEvent, CliLinkService } from './cli-link';
import { ProjectService } from './projects';
import { newConversationArgs, TerminalService, workspaceClaudeLaunch } from './terminals';
import { setupFailureMessage, WorkspaceService } from './workspaces';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US', getVersion: () => '0.0.0' } }));

const repo = (projectId: string, primary: boolean, extra: Partial<WorkspaceRepo> = {}) => ({
  projectId,
  primary,
  worktreePath: `/w/${projectId}`,
  baseBranch: 'main',
  pr: null,
  hasCommits: false,
  merged: null,
  setupError: null,
  ...extra,
});

describe('workspaceMerged (spec §21.5)', () => {
  const merged = { state: 'merged' as const, url: null, source: 'git' as const };
  it('needs every repository with commits or a PR to be merged', () => {
    expect(workspaceMerged({ repos: [repo('api', true)] })).toBeNull();
    expect(workspaceMerged({ repos: [repo('api', true, { pr: merged })] })?.pr).toEqual(merged);
    expect(
      workspaceMerged({
        repos: [repo('api', true, { pr: merged }), repo('web', false, { hasCommits: true })],
      }),
    ).toBeNull();
    // A linked repository without commits of its own doesn't hold it back.
    expect(
      workspaceMerged({
        repos: [repo('api', true, { pr: merged, hasCommits: true }), repo('web', false)],
      })?.pr,
    ).toEqual(merged);
  });

  it('counts a branch contained in its base, per repository (spec §14.2)', () => {
    const local = { hasCommits: true, merged: 'local' as const };
    expect(workspaceMerged({ repos: [repo('api', true, local)] })?.merged).toBe('local');
    // The linked one is merged locally, the main one's PR isn't known: not merged.
    expect(
      workspaceMerged({
        repos: [repo('api', true, { hasCommits: true }), repo('web', false, local)],
      }),
    ).toBeNull();
    // One by its PR, the other by its base: merged, shown by the main one.
    const both = workspaceMerged({
      repos: [repo('api', true, { pr: merged }), repo('web', false, local)],
    });
    expect(both?.projectId).toBe('api');
  });
});

describe('Claude arguments (spec §21.3)', () => {
  it('adds --add-dir per linked worktree and loads their CLAUDE.md only with links', () => {
    const single = { claudeSessionId: 's1', repos: [repo('api', true)] };
    expect(workspaceClaudeLaunch(single, '/s.json', { resume: true })).toEqual({
      args: ['--settings', '/s.json', '--resume', 's1'],
      env: {},
    });
    const linked = { claudeSessionId: null, repos: [repo('api', true), repo('web', false)] };
    expect(workspaceClaudeLaunch(linked, '/s.json', { resume: true })).toEqual({
      args: ['--settings', '/s.json', '--continue', '--add-dir', '/w/web'],
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
    });
  });

  it('replaces a resume that has no conversation with a new one (spec §9.8)', () => {
    const fresh = newConversationArgs([
      '--settings',
      '/s.json',
      '--resume',
      's1',
      '--add-dir',
      '/w',
    ]);
    expect(fresh).toEqual([
      '--settings',
      '/s.json',
      '--session-id',
      expect.any(String),
      '--add-dir',
      '/w',
    ]);
    expect(fresh?.[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(newConversationArgs(['--continue', '--add-dir', '/w'])).toEqual([
      '--session-id',
      expect.any(String),
      '--add-dir',
      '/w',
    ]);
    expect(newConversationArgs(['--settings', '/s.json', '--session-id', 's1'])).toBeNull();
  });

  it('names the repositories in setup failures and the PR prompt', () => {
    expect(setupFailureMessage([{ name: 'api', detail: 'exit 2' }], false)).toBe(
      'Setup failed (exit 2)',
    );
    expect(
      setupFailureMessage(
        [
          { name: 'api', detail: 'exit 2' },
          { name: 'web', detail: 'timed out after 5 s' },
        ],
        true,
      ),
    ).toBe('Setup failed in api (exit 2), web (timed out after 5 s)');
    expect(linkedPrContext({ name: 'api', worktreePath: '/w/api' }, [])).toEqual({
      before: '',
      after: '',
    });
    const text = linkedPrContext({ name: 'api', worktreePath: '/w/api' }, [
      { name: 'web', branch: 'b', prUrl: 'https://pr/1' },
    ]);
    expect(text.before).toContain('/w/api');
    expect(text.after).toContain('web (branch b, PR https://pr/1)');
  });
});

describe('WorkspaceRecords with linked repositories', () => {
  it('keeps them in order, per repository, and finds where a project is linked', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    const base: Omit<Workspace, 'repos'> = {
      id: 'ws',
      profileId: 'work',
      projectId: 'api',
      name: 'X',
      task: { id: null, title: 'X', url: null },
      branch: 'x',
      baseBranch: 'main',
      worktreePath: '/w/api',
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
      createdAt: '2026-10-29T10:00:00Z',
      lastActivityAt: null,
    };
    records.insert({
      ...base,
      repos: [{ projectId: 'web', worktreePath: '/w/web', baseBranch: 'develop' }],
    });
    records.addRepo('ws', { projectId: 'lib', worktreePath: '/w/lib', baseBranch: 'main' });
    const ws = records.get('ws') as Workspace;
    expect(ws.repos.map((r) => [r.projectId, r.primary, r.baseBranch])).toEqual([
      ['api', true, 'main'],
      ['web', false, 'develop'],
      ['lib', false, 'main'],
    ]);
    records.setPr('ws', { state: 'open', url: 'u', source: 'command' }, { projectId: 'web' });
    records.setSetupError('ws', 'lib', 'exit 1');
    records.setStartCommit('ws', 'abc', 'web');
    records.setStartCommit('ws', 'def');
    expect(records.startCommit('ws', 'web')).toBe('abc');
    expect(records.startCommit('ws')).toBe('def');
    const after = records.get('ws') as Workspace;
    expect(after.pr).toBeNull();
    expect(after.repos[1]?.pr?.state).toBe('open');
    expect(after.repos[2]?.setupError).toBe('exit 1');
    expect(records.linkedInto('web').map((l) => l.workspace.id)).toEqual(['ws']);
    records.removeRepo('ws', 'web');
    expect(records.get('ws')?.repos.map((r) => r.projectId)).toEqual(['api', 'lib']);
    records.archive('ws');
    expect(records.linkedInto('lib')).toEqual([]);
  });

  it('keeps who linked a repository, and whether Claude may (spec §21.9)', () => {
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    const base = {
      id: 'ws',
      profileId: 'work',
      projectId: 'api',
      name: 'X',
      task: { id: null, title: 'X', url: null },
      branch: 'x',
      baseBranch: 'main',
      worktreePath: '/w/api',
      state: 'starting' as const,
      unread: false,
      stateMessage: null,
      stateSince: null,
      claudeSessionId: null,
      ports: null,
      pr: null,
      createdAt: '2026-10-29T10:00:00Z',
      lastActivityAt: null,
    };
    // On unless told otherwise, as for workspaces made before the setting.
    records.insert(base);
    expect(records.get('ws')?.claudeMayLink).toBe(true);
    records.setClaudeMayLink('ws', false);
    expect(records.get('ws')?.claudeMayLink).toBe(false);
    records.insert({ ...base, id: 'off', claudeMayLink: false });
    expect(records.get('off')?.claudeMayLink).toBe(false);
    records.addRepo('ws', { projectId: 'web', worktreePath: '/w/web', baseBranch: 'main' });
    records.addRepo('ws', {
      projectId: 'lib',
      worktreePath: '/w/lib',
      baseBranch: 'main',
      addedBy: 'claude',
    });
    records.addRepo('ws', {
      projectId: 'ui',
      worktreePath: '/w/ui',
      baseBranch: 'main',
      addedBy: 'terminal',
    });
    expect(records.get('ws')?.repos.map((r) => [r.projectId, r.addedBy ?? null])).toEqual([
      ['api', null],
      ['web', null],
      ['lib', 'claude'],
      ['ui', 'terminal'],
    ]);
  });
});

describe('linked workspaces (spec §21)', () => {
  let fx: Fixture;
  let host: SessionHost;
  let records: WorkspaceRecords;
  let workspaces: WorkspaceService;
  let configFile: string;
  let config: ConfigStore;
  let log: string;
  let envService: EnvService;
  const projects: Record<string, unknown>[] = [];

  const writeConfig = () =>
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: [
          { id: 'work', name: 'Work', defaults: { worktreeRoot: path.join(fx.root, 'wt') } },
          { id: 'home', name: 'Home' },
        ],
        projects,
      }),
    );
  const runs = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .replace(/\n?---$/, '')
          .split('\n---\n')
          .map((r) => r.split('\n'))
      : [];
  const claudeRunning = (id: string) =>
    host.list().some((s) => s.workspaceId === id && s.kind === 'claude' && s.status === 'running');

  beforeEach(() => {
    fx = createFixture();
    log = path.join(fx.root, 'claude.log');
    const bin = path.join(fx.root, 'bin');
    fs.mkdirSync(bin);
    // Records its arguments and the variables that matter, one run per block.
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh
{ echo "cwd $PWD"; echo "args $*"; echo "linked \${${envVar('LINKED_WORKTREES')}-unset}"
  echo "worktree \${${envVar('WORKTREE_PATH')}}"; echo "md \${CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD-unset}"
  echo ---; } >> "${log}"
exec sleep 30
`,
      { mode: 0o755 },
    );
    projects.length = 0;
    for (const name of ['api', 'web', 'lib']) {
      const { clone } = fx.cloneWithRemote(name);
      projects.push({ id: name, profileId: 'work', name, repoPath: clone, remote: 'origin' });
    }
    const other = fx.localRepo('elsewhere');
    projects.push({
      id: 'elsewhere',
      profileId: 'home',
      name: 'elsewhere',
      repoPath: other,
      remote: null,
    });
    configFile = path.join(fx.root, 'config.json');
    writeConfig();
    config = new ConfigStore(configFile);
    config.load();
    const env = new EnvService(
      config,
      Promise.resolve({
        env: { ...fx.env, PATH: `${bin}:${fx.env.PATH}` },
        shell: '/bin/sh',
        source: 'login-shell',
      }),
    );
    envService = env;
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

  const setSetup = (id: string, setup: string[], teardown: string[] = []) => {
    const project = projects.find((p) => p.id === id) as Record<string, unknown>;
    project.setup = { setup, teardown };
    writeConfig();
    config.reload();
  };
  const create = (branch: string, linkedProjectIds: string[]) =>
    workspaces.create({
      projectId: 'api',
      taskId: null,
      title: branch,
      branch,
      baseBranch: 'main',
      linkedProjectIds,
    });

  it('checks the branch in every repository, locally and on the remotes', async () => {
    const web = projects[1]?.repoPath as string;
    fx.git(web, 'branch', 'taken');
    expect(await workspaces.branchProblem('api', 'taken')).toBeNull();
    expect(await workspaces.branchProblem('api', 'taken', ['web'])).toBe(
      'A branch named taken already exists in web',
    );
    // Only on the remote: Create asks it, and leaves nothing behind.
    const { origin } = { origin: path.join(fx.root, 'lib-origin.git') };
    fx.git(origin, 'branch', 'remote-only', 'main');
    await expect(create('remote-only', ['web', 'lib'])).rejects.toThrow(
      'origin of lib already has a branch named remote-only',
    );
    for (const name of ['api', 'web']) {
      expect(fs.existsSync(path.join(fx.root, 'wt', name, 'remote-only'))).toBe(false);
      const repoPath = projects.find((p) => p.id === name)?.repoPath as string;
      expect(fx.git(repoPath, 'branch', '--list', 'remote-only')).toBe('');
    }
    // Only projects of the same profile.
    await expect(create('x', ['elsewhere'])).rejects.toThrow('belongs to another profile');
  });

  it("adds the task folder to info/exclude and keeps the old app's entry", async () => {
    const repoPath = projects.find((p) => p.id === 'api')?.repoPath as string;
    const exclude = path.join(repoPath, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `# local\n/${BRAND.legacy.repoDirName}/`);
    await create('excluded', []);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(
      `# local\n/${BRAND.legacy.repoDirName}/\n/${BRAND.repoDirName}/\n`,
    );
  });

  it('creates a worktree per repository and starts one Claude with --add-dir', async () => {
    const { workspace, claude } = await create('two-repos', ['web']);
    const [api, web] = workspace.repos;
    expect(api?.worktreePath).toBe(path.join(fx.root, 'wt', 'api', 'two-repos'));
    expect(web?.worktreePath).toBe(path.join(fx.root, 'wt', 'web', 'two-repos'));
    for (const r of workspace.repos) {
      expect(fx.git(r.worktreePath, 'branch', '--show-current').trim()).toBe('two-repos');
      expect(fs.existsSync(path.join(r.worktreePath, BRAND.repoDirName, 'task.md'))).toBe(true);
    }
    expect(claude).not.toBeNull();
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    expect(runs()[0]).toEqual([
      `cwd ${api?.worktreePath}`,
      `args --settings /s.json --session-id ${records.get(workspace.id)?.claudeSessionId} --add-dir ${web?.worktreePath}`,
      `linked ${web?.worktreePath}`,
      `worktree ${api?.worktreePath}`,
      'md 1',
    ]);

    // Without links: no --add-dir, the variable empty, CLAUDE.md loading untouched.
    const { workspace: single } = await create('one-repo', []);
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    expect(runs()[1]?.slice(1)).toEqual([
      `args --settings /s.json --session-id ${records.get(single.id)?.claudeSessionId}`,
      'linked ',
      `worktree ${path.join(fx.root, 'wt', 'api', 'one-repo')}`,
      'md unset',
    ]);
  });

  it('starts Claude once every setup passed; Retry runs only the failed ones', async () => {
    const marks = path.join(fx.root, 'marks');
    setSetup('api', [`sleep 0.3; echo api >> ${marks}`]);
    setSetup('web', [`echo web >> ${marks}; test -f ok`]);
    const { workspace, setup } = await create('setup', ['web']);
    expect(setup?.kind).toBe('setup');
    const setups = host.list().filter((s) => s.kind === 'setup');
    expect(setups.map((s) => s.projectId).sort()).toEqual(['api', 'web']);
    await vi.waitFor(() => expect(records.get(workspace.id)?.state).toBe('error'), {
      timeout: 5000,
    });
    const failed = records.get(workspace.id) as Workspace;
    expect(failed.stateMessage).toBe('Setup failed in web (exit 1)');
    expect(failed.repos.map((r) => r.setupError)).toEqual([null, 'exit 1']);
    expect(claudeRunning(workspace.id)).toBe(false);

    fs.writeFileSync(path.join(failed.repos[1]?.worktreePath as string, 'ok'), '');
    await workspaces.runSetup(workspace.id);
    await vi.waitFor(() => expect(claudeRunning(workspace.id)).toBe(true), { timeout: 5000 });
    // api's setup ran once, web's twice.
    expect(fs.readFileSync(marks, 'utf8').trim().split('\n').sort()).toEqual(['api', 'web', 'web']);
    expect(records.get(workspace.id)?.repos.every((r) => !r.setupError)).toBe(true);
  });

  it('links and unlinks repositories, restarting Claude with the conversation', async () => {
    const { workspace } = await create('linking', []);
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
    // The id the app chose at the first start (spec §9.4): a restart resumes
    // it although no hook has reported it.
    const session = records.get(workspace.id)?.claudeSessionId;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs()[0]?.[1]).toBe(`args --settings /s.json --session-id ${session}`);

    const linked = await workspaces.link(workspace.id, 'web', { restart: true });
    const webPath = path.join(fx.root, 'wt', 'web', 'linking');
    expect(linked.addDirLine).toBe(`/add-dir ${webPath}`);
    expect(fs.existsSync(path.join(webPath, BRAND.repoDirName, 'task.md'))).toBe(true);
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    expect(runs()[1]?.[1]).toBe(`args --settings /s.json --resume ${session} --add-dir ${webPath}`);
    await expect(workspaces.link(workspace.id, 'web', { restart: true })).rejects.toThrow(
      'already in this workspace',
    );

    // Link only: Claude keeps running.
    const libPath = path.join(fx.root, 'wt', 'lib', 'linking');
    await workspaces.link(workspace.id, 'lib', { restart: false });
    expect(runs()).toHaveLength(2);
    expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['api', 'web', 'lib']);

    // Unlink web: its worktree goes, the branch stays unless asked, Claude restarts without it.
    fs.writeFileSync(path.join(webPath, 'new.txt'), 'x');
    const check = await workspaces.unlinkCheck(workspace.id, 'web');
    expect(check.uncommitted).toEqual(['?? new.txt']);
    await expect(workspaces.unlinkCheck(workspace.id, 'api')).rejects.toThrow("isn't linked");
    await workspaces.unlink(workspace.id, 'web', { force: true, deleteBranch: false });
    expect(fs.existsSync(webPath)).toBe(false);
    const webRepo = projects[1]?.repoPath as string;
    expect(fx.git(webRepo, 'branch', '--list', 'linking').trim()).toBe('linking');
    await vi.waitFor(() => expect(runs()).toHaveLength(3));
    expect(runs()[2]?.[1]).toBe(`args --settings /s.json --resume ${session} --add-dir ${libPath}`);
    expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['api', 'lib']);
  });

  it('deletes every worktree with teardown per repository', async () => {
    const torn = path.join(fx.root, 'torn');
    setSetup('api', [], [`echo "$PWD" >> ${torn}`]);
    setSetup('web', [], [`echo "$PWD" >> ${torn}`]);
    const { workspace } = await create('delete-me', ['web']);
    const [api, web] = workspace.repos as [WorkspaceRepo, WorkspaceRepo];
    fx.git(web.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'local work');
    const check = await workspaces.deleteCheck(workspace.id);
    expect(check.repos.map((r) => [r.projectId, r.unpushed])).toEqual([
      ['api', 0],
      ['web', 1],
    ]);
    await workspaces.delete(workspace.id, {
      force: false,
      deleteBranch: true,
      repos: [{ projectId: 'web', force: false, deleteBranch: false }],
    });
    expect(fs.existsSync(api.worktreePath)).toBe(false);
    expect(fs.existsSync(web.worktreePath)).toBe(false);
    expect(fs.readFileSync(torn, 'utf8').trim().split('\n').sort()).toEqual(
      [api.worktreePath, web.worktreePath].sort(),
    );
    const repoPath = (id: string) => projects.find((p) => p.id === id)?.repoPath as string;
    expect(fx.git(repoPath('api'), 'branch', '--list', 'delete-me')).toBe('');
    expect(fx.git(repoPath('web'), 'branch', '--list', 'delete-me').trim()).toBe('delete-me');
    expect(records.get(workspace.id)).toBeNull();
  });

  it('a branch merged into its local base has nothing unpushed, per repository (§14.2)', async () => {
    const { workspace } = await create('merged-here', ['web']);
    const [, web] = workspace.repos as [WorkspaceRepo, WorkspaceRepo];
    fx.git(web.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'local work');
    const webPath = projects.find((p) => p.id === 'web')?.repoPath as string;
    fx.git(webPath, 'merge', '-q', '--ff-only', 'merged-here');
    const check = await workspaces.deleteCheck(workspace.id);
    expect(check.repos.map((r) => [r.projectId, r.unpushed, r.merged])).toEqual([
      ['api', 0, null],
      ['web', 0, 'local'],
    ]);
    // Stored for Home: web counts, api has no work of its own.
    expect(workspaceMerged(records.get(workspace.id) as Workspace)?.projectId).toBe('web');
    // Pushed: merged into the base itself.
    fx.git(webPath, 'push', '-q', 'origin', 'main');
    expect((await workspaces.deleteCheck(workspace.id)).repos[1]?.merged).toBe('base');
  });

  it('removing a linked project deletes only its worktree; the workspace stays', async () => {
    const { workspace } = await create('remove-linked', ['web']);
    const check = await workspaces.projectRemovalCheck('web');
    expect(check.workspaces).toEqual([]);
    expect(check.linked.map((l) => l.workspace.id)).toEqual([workspace.id]);
    await workspaces.deleteProjectWorkspaces(
      'web',
      [],
      [{ workspaceId: workspace.id, force: false, deleteBranch: true }],
    );
    expect(fs.existsSync(path.join(fx.root, 'wt', 'web', 'remove-linked'))).toBe(false);
    expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['api']);
    expect(fs.existsSync(path.join(fx.root, 'wt', 'api', 'remove-linked'))).toBe(true);
    // Unconfirmed links are refused.
    await create('again', ['web']);
    await expect(workspaces.deleteProjectWorkspaces('web', [], [])).rejects.toThrow(
      "weren't confirmed",
    );
  });

  describe('linked from the command line (spec §21.9)', () => {
    let cli: CliLinkService;
    let events: CliLinkEvent[];
    beforeEach(() => {
      cli = new CliLinkService(config, records, new ProjectService(config, envService), workspaces);
      events = [];
      cli.onLinked((e) => events.push(e));
    });
    const request = (workspaceId: string | null, project: string, cwd: string | null = null) => ({
      project,
      cwd,
      workspaceId,
      profileId: 'work',
      byClaude: true,
    });

    it('links a project by name with the Link flow, and says so', async () => {
      const { workspace } = await create('cli-name', []);
      const result = await cli.link(request(workspace.id, 'WEB'));
      const worktree = path.join(fx.root, 'wt', 'web', 'cli-name');
      expect(result).toEqual({
        ok: true,
        name: 'web',
        projectId: 'web',
        added: false,
        worktreePath: worktree,
        branch: 'cli-name',
        baseBranch: 'main',
        setup: false,
        setupError: null,
      });
      expect(fx.git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('cli-name');
      expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['api', 'web']);
      expect(records.get(workspace.id)?.repos[1]?.addedBy).toBe('claude');
      expect(events).toEqual([
        {
          workspaceId: workspace.id,
          profileId: 'work',
          workspaceName: 'cli-name',
          repoName: 'web',
          worktreePath: worktree,
          byClaude: true,
        },
      ]);
      expect(await cli.link(request(workspace.id, 'web'))).toEqual({
        ok: false,
        error: 'That project is already in this workspace',
      });
    });

    it('answers once the setup has run, with its failure', async () => {
      const { workspace } = await create('cli-setup', []);
      const marks = path.join(fx.root, 'setup-marks');
      setSetup('web', [`sleep 0.5; echo done >> ${marks}`]);
      const passed = await cli.link(request(workspace.id, 'web'));
      expect(passed).toMatchObject({ ok: true, setup: true, setupError: null });
      // Not before the setup finished.
      expect(fs.readFileSync(marks, 'utf8')).toBe('done\n');
      setSetup('lib', ['echo broken; exit 3']);
      expect(await cli.link(request(workspace.id, 'lib'))).toMatchObject({
        ok: true,
        setup: true,
        setupError: 'exit 3',
      });
    });

    it('adds a repository given by path to the profile first; refuses other profiles', async () => {
      const { workspace } = await create('cli-path', []);
      const fresh = fx.localRepo('fresh');
      const fromTerminal = { ...request(workspace.id, './fresh', fx.root), byClaude: false };
      const result = await cli.link(fromTerminal);
      expect(result).toMatchObject({ ok: true, name: 'fresh', added: true });
      const added = config.require().projects.find((p) => p.name === 'fresh');
      expect(added).toMatchObject({ profileId: 'work', repoPath: fresh });
      expect(records.get(workspace.id)?.repos.map((r) => r.projectId)).toEqual(['api', added?.id]);
      expect(records.get(workspace.id)?.repos[1]?.addedBy).toBe('terminal');
      // Rule R1: a repository of another profile isn't added, nor linked.
      const elsewhere = projects.find((p) => p.id === 'elsewhere')?.repoPath as string;
      expect(await cli.link(request(workspace.id, elsewhere))).toEqual({
        ok: false,
        error: 'This repository is already registered under the Home profile',
      });
      expect(await cli.link(request(workspace.id, 'nothing'))).toMatchObject({
        ok: false,
        error: expect.stringContaining('There is no project "nothing"'),
      });
    });

    it("refuses Claude a path that isn't a project yet, not one that is (spec §21.9)", async () => {
      const { workspace } = await create('cli-claude-path', []);
      fx.localRepo('stranger');
      expect(await cli.link(request(workspace.id, './stranger', fx.root))).toMatchObject({
        ok: false,
        error: expect.stringContaining("./stranger isn't a project of this profile"),
      });
      expect(config.require().projects.some((p) => p.name === 'stranger')).toBe(false);
      const web = projects.find((p) => p.id === 'web')?.repoPath as string;
      expect(await cli.link(request(workspace.id, web))).toMatchObject({
        ok: true,
        name: 'web',
        added: false,
      });
    });

    it('refuses Claude when the workspace says it may not link; a terminal still can', async () => {
      const { workspace } = await workspaces.create({
        projectId: 'api',
        taskId: null,
        title: 'cli-off',
        branch: 'cli-off',
        baseBranch: 'main',
        claudeMayLink: false,
      });
      expect(records.get(workspace.id)?.claudeMayLink).toBe(false);
      expect(await cli.link(request(workspace.id, 'web'))).toMatchObject({
        ok: false,
        error: expect.stringContaining('Claude may not add repositories to this workspace'),
      });
      expect(records.get(workspace.id)?.repos).toHaveLength(1);
      expect(events).toEqual([]);
      expect(await cli.link({ ...request(workspace.id, 'web'), byClaude: false })).toMatchObject({
        ok: true,
        name: 'web',
      });
      // Turned on later, from the workspace's menu.
      records.setClaudeMayLink(workspace.id, true);
      expect(await cli.link(request(workspace.id, 'lib'))).toMatchObject({ ok: true });
    });

    it('refuses outside a workspace, or for another profile', async () => {
      expect(await cli.link(request(null, 'web'))).toMatchObject({
        ok: false,
        error: expect.stringContaining('only works inside a workspace'),
      });
      const { workspace } = await create('cli-other', []);
      expect(await cli.link({ ...request(workspace.id, 'web'), profileId: 'home' })).toMatchObject({
        ok: false,
      });
      expect(events).toEqual([]);
    });

    it("lists the profile's projects and tells Claude about the ones it could link", async () => {
      const { workspace } = await create('cli-list', ['web']);
      const list = cli.projectList({ workspaceId: workspace.id, profileId: 'work' });
      expect(list.ok && list.projects.map((p) => [p.id, p.inWorkspace])).toEqual([
        ['api', 'main'],
        ['web', 'linked'],
        ['lib', 'no'],
      ]);
      const outside = cli.projectList({ workspaceId: null, profileId: 'work' });
      expect(outside.ok && outside.projects.map((p) => p.inWorkspace)).toEqual([null, null, null]);
      const note = cli.sessionNote(workspace.id) as string;
      expect(note).toContain(
        `- lib: ${projects.find((p) => p.id === 'lib')?.repoPath} (base main)`,
      );
      expect(note).not.toContain('- web:');
      expect(note).not.toContain('- elsewhere:');
      expect(note).toContain(`${BRAND.cliCommand} link <name>`);
      expect(note).toContain(
        "This folder's repository stays your main one and your working folder",
      );
      expect(note).toContain('Only those projects can be linked, nothing outside them');
      expect(cli.sessionNote(null)).toBeNull();
      // Spec §13.5: the worktree and branch always; nothing to link once all are in.
      expect(note).toContain(`this folder, ${workspace.worktreePath}, is the git worktree`);
      await cli.link(request(workspace.id, 'lib'));
      const all = cli.sessionNote(workspace.id) as string;
      expect(all).toContain(`on branch ${workspace.branch}. Work here`);
      expect(all).not.toContain('link <name>');
    });

    it("gives each project's own base, and nothing to link when Claude may not", async () => {
      const lib = projects.find((p) => p.id === 'lib') as Record<string, unknown>;
      lib.baseBranch = 'develop';
      writeConfig();
      config.reload();
      const { workspace } = await create('cli-note', []);
      const note = cli.sessionNote(workspace.id) as string;
      expect(note).toContain(`- lib: ${lib.repoPath} (base develop)`);
      expect(note).toContain(
        `- web: ${projects.find((p) => p.id === 'web')?.repoPath} (base main)`,
      );
      records.setClaudeMayLink(workspace.id, false);
      const off = cli.sessionNote(workspace.id) as string;
      expect(off).toContain(`this folder, ${workspace.worktreePath}, is the git worktree`);
      expect(off).not.toContain('- lib:');
      expect(off).not.toContain('link <name>');
    });

    it("tells Claude the workspace's ports, when it has them (spec §8.4)", async () => {
      const { workspace } = await create('cli-ports', []);
      records.setPorts(workspace.id, { base: 20040, count: 10 });
      expect(cli.sessionNote(workspace.id)).toContain(
        `Use ports 20040–20049 for anything you start (dev servers, tests); $${BRAND.envPrefix}PORT is the first.`,
      );
      records.insert({ ...(records.get(workspace.id) as Workspace), id: 'no-ports', ports: null });
      expect(cli.sessionNote('no-ports')).not.toContain('Use ports');
    });
  });

  describe('the base when the remote lacks it (spec §7.3)', () => {
    /** A project whose origin is a new, empty repository. */
    const emptyRemoteProject = () => {
      const repoPath = fx.localRepo('fresh');
      const origin = path.join(fx.root, 'fresh-origin.git');
      fx.git(fx.root, 'init', '-q', '--bare', origin);
      fx.git(repoPath, 'remote', 'add', 'origin', origin);
      projects.push({ id: 'fresh', profileId: 'work', name: 'fresh', repoPath, remote: 'origin' });
      writeConfig();
      config.reload();
      return { repoPath, origin };
    };
    const createIn = (projectId: string, branch: string, extra: { baseBranch?: string } = {}) =>
      workspaces.create({
        projectId,
        taskId: null,
        title: branch,
        branch,
        baseBranch: extra.baseBranch ?? 'main',
      });
    const head = (dir: string) => fx.git(dir, 'rev-parse', 'HEAD').trim();

    it('starts from the local base until the remote has it, then from the remote', async () => {
      const { repoPath, origin } = emptyRemoteProject();
      const first = await createIn('fresh', 'first');
      expect(first.notes).toEqual([
        "main isn't on origin yet; the workspace starts from your local main",
      ]);
      expect(head(first.workspace.worktreePath)).toBe(head(repoPath));
      // Pushed, and one more commit on the remote: the next one starts there.
      fx.git(repoPath, 'push', '-q', 'origin', 'main');
      const other = path.join(fx.root, 'fresh-other');
      fx.git(fx.root, 'clone', '-q', '-b', 'main', origin, other);
      fx.git(other, 'commit', '-q', '--allow-empty', '-m', 'on the remote');
      fx.git(other, 'push', '-q', 'origin', 'main');
      const second = await createIn('fresh', 'second');
      expect(second.notes).toEqual([]);
      expect(head(second.workspace.worktreePath)).toBe(head(other));
    });

    it("starts from the local base when the remote can't be reached, with the reason", async () => {
      const { repoPath } = emptyRemoteProject();
      fx.git(repoPath, 'remote', 'set-url', 'origin', path.join(fx.root, 'gone.git'));
      const { workspace, notes } = await createIn('fresh', 'offline');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(
        /^Couldn't fetch origin\/main \(.*gone\.git.*\); the workspace starts from your local main$/,
      );
      expect(head(workspace.worktreePath)).toBe(head(repoPath));
    });

    it('fails only when the base is neither on the remote nor local', async () => {
      emptyRemoteProject();
      await expect(createIn('fresh', 'nowhere', { baseBranch: 'develop' })).rejects.toThrow(
        'develop is neither on origin nor a local branch',
      );
      expect(fs.existsSync(path.join(fx.root, 'wt', 'fresh', 'nowhere'))).toBe(false);
    });
  });

  it('asks each remote once for New workspace and Create, fetching the base meanwhile', async () => {
    const heads = vi.spyOn(Git.prototype, 'remoteHeads');
    const fetches = vi.spyOn(Git.prototype, 'fetch');
    try {
      await workspaces.prepareRemotes('api', ['web'], 'main');
      const { workspace } = await create('asked-early', ['web']);
      expect(heads.mock.calls.map(([repo]) => path.basename(repo)).sort()).toEqual(['api', 'web']);
      expect(
        fetches.mock.calls.map(([repo, , base]) => [path.basename(repo), base]).sort(),
      ).toEqual([
        ['api', 'main'],
        ['web', 'main'],
      ]);
      // Started from the fetched base, as before.
      expect(fx.git(workspace.worktreePath, 'rev-parse', 'HEAD')).toBe(
        fx.git(projects[0]?.repoPath as string, 'rev-parse', 'origin/main'),
      );
    } finally {
      heads.mockRestore();
      fetches.mockRestore();
    }
  });

  it('gives a branch from the task the next free name; offers it for a typed one', async () => {
    const api = projects.find((p) => p.id === 'api')?.repoPath as string;
    fx.git(api, 'branch', 'landing');
    fx.git(path.join(fx.root, 'api-origin.git'), 'branch', 'landing-2', 'main');
    expect(await workspaces.branchCheck('api', 'landing')).toEqual({
      problem: 'A branch named landing already exists',
      suggestion: 'landing-2',
    });
    expect(await workspaces.branchCheck('api', 'bad name..')).toEqual({
      problem: '"bad name.." isn\'t a valid branch name',
      suggestion: 'bad-name',
    });
    expect(await workspaces.branchCheck('api', 'free')).toEqual({
      problem: null,
      suggestion: null,
    });
    // Create asks the remote too: landing-2 is there, so landing-3.
    const { workspace, notes } = await workspaces.create({
      projectId: 'api',
      taskId: null,
      title: 'Landing',
      branch: 'landing',
      baseBranch: 'main',
      uniqueBranch: true,
    });
    expect(workspace.branch).toBe('landing-3');
    expect(notes).toEqual(['landing already exists; the branch is landing-3']);
    // A typed branch the remote has fails, naming a free one.
    await expect(create('landing-2', [])).rejects.toThrow(
      'origin already has a branch named landing-2; landing-2-2 is free',
    );
  });
});
