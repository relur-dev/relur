import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envVar } from '@shared/brand';
import type { Workspace } from '@shared/workspaces';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import type { TerminalService } from '../services/terminals';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { SEED_CONFIG } from '../test-support/seed-config';
import {
  allPrsPrompt,
  commitMessage,
  FinishService,
  fillTemplate,
  parsePrOutput,
  parsePrStatus,
  planPrs,
  pushProblem,
  type RepoPrFacts,
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

describe('Create PRs in a linked workspace (spec §21.5)', () => {
  const facts = (name: string, more: Partial<RepoPrFacts> = {}): RepoPrFacts => ({
    projectId: name,
    name,
    hasRemote: true,
    hasOwnCommits: true,
    pr: null,
    uncommitted: 0,
    pushed: true,
    unpushed: 0,
    ...more,
  });

  it('opens one where there are commits of its own and no PR, and skips the rest', () => {
    const plan = planPrs([
      facts('web'),
      facts('api', { pushed: false, unpushed: 2 }),
      facts('docs', { hasOwnCommits: false }),
      facts('lib', { pr: { state: 'open', url: 'https://x/pr/3', source: 'command' } }),
      facts('local', { hasRemote: false }),
    ]);
    expect(plan.create.map((f) => f.name)).toEqual(['web', 'api']);
    expect(plan.skipped).toEqual([
      { name: 'docs', reason: 'no commits of its own' },
      { name: 'lib', reason: 'has a pull request' },
      { name: 'local', reason: 'no remote' },
    ]);
  });

  it('asks Claude once for all of them, with each worktree, and to link them', () => {
    const prompt = allPrsPrompt({
      branch: 'PROJ-8-cart',
      repos: [
        {
          name: 'web',
          worktreePath: '/w/web',
          prompt: 'Open a pull request into main.',
          existed: false,
        },
        {
          name: 'api',
          worktreePath: '/w/api',
          prompt: 'Open a pull request into dev.',
          existed: true,
        },
      ],
      known: [{ name: 'lib', url: 'https://x/pr/3' }],
    });
    expect(prompt).toContain('all on the branch PROJ-8-cart');
    expect(prompt).toContain('each of these 2');
    expect(prompt).toContain(
      '1. In the web repository, whose worktree is /w/web: Open a pull request into main. 2. In the api repository, whose worktree is /w/api: Open a pull request into dev. This branch existed there before',
    );
    expect(prompt).toContain('open already: lib https://x/pr/3.');
    expect(prompt).toContain('link the pull requests to each other');
  });

  describe('with local bare remotes and PR commands', () => {
    let fx: Fixture;
    let records: WorkspaceRecords;
    let finish: FinishService;
    let trees: Record<'web' | 'api' | 'docs', string>;
    let origins: Record<'web' | 'api' | 'docs', string>;
    const id = 'ws_all';
    const branch = 'PROJ-8-cart';
    const bases = { web: 'main', api: 'dev', docs: 'main' } as const;

    beforeAll(() => {
      fx = createFixture();
      const names = ['web', 'api', 'docs'] as const;
      origins = {} as typeof origins;
      trees = {} as typeof trees;
      const projects = names.map((name) => {
        const { origin, clone } = fx.cloneWithRemote(name, bases[name]);
        origins[name] = origin;
        trees[name] = path.join(fx.root, 'wt', name);
        fx.git(
          clone,
          'worktree',
          'add',
          '-q',
          '--no-track',
          '-b',
          branch,
          trees[name],
          `origin/${bases[name]}`,
        );
        return {
          id: name,
          profileId: 'work',
          name,
          repoPath: clone,
          remote: 'origin',
          baseBranch: bases[name],
        };
      });
      // The create command records what it was given; the status command
      // answers per repository once its PR was "created".
      const made = path.join(fx.root, 'made');
      fs.mkdirSync(made);
      const file = path.join(fx.root, 'config', 'config.json');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...SEED_CONFIG,
          profiles: SEED_CONFIG.profiles.map((p) =>
            p.id === 'work'
              ? {
                  ...p,
                  pr: {
                    createCommand: `n=$(basename "$PWD"); printf '%s %s' "$${envVar('BASE_BRANCH')}" "$${envVar('WORKTREE_PATH')}" > "${made}/$n"; echo "created $n"`,
                    statusCommand: `n=$(basename "$PWD"); if [ -f "${made}/$n" ]; then printf '{"state":"open","url":"https://example.com/%s/pull/1"}' "$n"; fi`,
                  },
                }
              : p,
          ),
          projects,
        }),
      );
      const config = new ConfigStore(file);
      config.load();
      records = new WorkspaceRecords(openStateDb(':memory:'));
      records.insert({
        id,
        profileId: 'work',
        projectId: 'web',
        name: 'PROJ-8 Cart',
        task: { id: 'PROJ-8', title: 'Cart', url: null },
        branch,
        baseBranch: 'main',
        worktreePath: trees.web,
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
        repos: [
          { projectId: 'api', worktreePath: trees.api, baseBranch: 'dev' },
          { projectId: 'docs', worktreePath: trees.docs, baseBranch: 'main' },
        ],
      });
      for (const name of names) {
        records.setStartCommit(
          id,
          fx.git(trees[name], 'rev-parse', 'HEAD').trim(),
          name === 'web' ? null : name,
        );
      }
      // As in the app: the workspace's variables describe the main repository.
      const terminals = {
        workspaceCommandEnv: async () => ({
          shell: '/bin/sh',
          env: {
            ...fx.env,
            [envVar('BASE_BRANCH')]: 'main',
            [envVar('WORKTREE_PATH')]: trees.web,
          },
        }),
        host: { list: () => [] },
      } as unknown as TerminalService;
      finish = new FinishService(config, records, terminals);
    });
    afterAll(() => fx.cleanup());

    it('refuses uncommitted files, then pushes and creates in each, skipping one without commits', async () => {
      for (const name of ['web', 'api'] as const) {
        fs.writeFileSync(path.join(trees[name], `${name}.txt`), `${name}\n`);
        fx.git(trees[name], 'add', '.');
        fx.git(trees[name], 'commit', '-qm', `PROJ-8: ${name}`);
      }
      expect(await finish.state(id, 'docs')).toMatchObject({ hasOwnCommits: false, usesPrs: true });
      expect(await finish.state(id, 'api')).toMatchObject({ hasOwnCommits: true, pushed: false });
      fs.writeFileSync(path.join(trees.api, 'more.txt'), 'more\n');
      await expect(finish.createAllPrs(id)).rejects.toThrow('Commit first in api');
      fx.git(trees.api, 'add', '.');
      fx.git(trees.api, 'commit', '-qm', 'PROJ-8: more');

      const result = await finish.createAllPrs(id);
      expect(result.pushed).toEqual(['web', 'api']);
      expect(result.commands.map((c) => [c.name, c.result.ok])).toEqual([
        ['web', true],
        ['api', true],
      ]);
      expect(result.claude).toEqual([]);
      expect(result.skipped).toEqual([{ name: 'docs', reason: 'no commits of its own' }]);
      for (const name of ['web', 'api'] as const) {
        expect(fx.git(origins[name], 'rev-parse', branch).trim()).toBe(
          fx.git(trees[name], 'rev-parse', 'HEAD').trim(),
        );
        // Each command got its own repository's base and worktree.
        expect(fs.readFileSync(path.join(fx.root, 'made', name), 'utf8')).toBe(
          `${bases[name]} ${trees[name]}`,
        );
      }
      expect(fs.existsSync(path.join(fx.root, 'made', 'docs'))).toBe(false);

      // Each repository has its own PR, with its own link.
      await finish.refreshPr(id);
      const repos = records.get(id)?.repos ?? [];
      expect(repos.map((r) => [r.projectId, r.pr?.url ?? null])).toEqual([
        ['web', 'https://example.com/web/pull/1'],
        ['api', 'https://example.com/api/pull/1'],
        ['docs', null],
      ]);
      await expect(finish.createAllPrs(id)).rejects.toThrow('No repository needs a pull request');
    });
  });
});
