import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { MergeStatus } from '@shared/merge';
import type { PrStatus } from '@shared/workspaces';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import type { TerminalService } from '../services/terminals';
import type { ConversationEvent } from '../status/service';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { SEED_CONFIG } from '../test-support/seed-config';
import { FinishService } from './finish';
import { MergeService, mergePrompt } from './merge';

const BRANCH = 'PROJ-1-fix';

interface Repo {
  name: string;
  /** The main checkout. */
  repo: string;
  worktree: string;
  base: string;
}

/**
 * Repositories with a workspace worktree on BRANCH each (the first is the
 * main one), the records, and a merge service whose Claude is `claude`.
 */
function setup(fx: Fixture, names: string[], { remote = false }: { remote?: boolean } = {}) {
  const repos: Repo[] = names.map((name) => {
    const repo = remote ? fx.cloneWithRemote(name, 'main').clone : fx.localRepo(name);
    const worktree = path.join(fx.root, 'wt', name);
    fx.git(repo, 'worktree', 'add', '-q', '--no-track', '-b', BRANCH, worktree, 'main');
    return { name, repo, worktree, base: 'main' };
  });
  const file = path.join(fx.root, `config-${names.join('-')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...SEED_CONFIG,
      projects: repos.map((r) => ({
        id: r.name,
        profileId: 'work',
        name: r.name,
        repoPath: r.repo,
        remote: remote ? 'origin' : null,
        baseBranch: 'main',
      })),
    }),
  );
  const config = new ConfigStore(file);
  config.load();
  const records = new WorkspaceRecords(openStateDb(':memory:'));
  const [main, ...linked] = repos as [Repo, ...Repo[]];
  records.insert({
    id: 'ws',
    profileId: 'work',
    projectId: main.name,
    name: 'PROJ-1 Fix',
    task: { id: 'PROJ-1', title: 'Fix', url: null },
    branch: BRANCH,
    baseBranch: 'main',
    worktreePath: main.worktree,
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
    repos: linked.map((r) => ({ projectId: r.name, worktreePath: r.worktree, baseBranch: 'main' })),
  });
  for (const r of repos) {
    records.setStartCommit(
      'ws',
      fx.git(r.worktree, 'rev-parse', 'HEAD').trim(),
      r === main ? null : r.name,
    );
  }
  const terminals = {
    workspaceCommandEnv: async () => ({ shell: '/bin/sh', env: { ...fx.env } }),
    host: { list: () => [] },
  } as unknown as TerminalService;
  const finish = new FinishService(config, records, terminals);
  const events = new EventEmitter();
  const prompts: string[] = [];
  /** What the stand-in Claude does with a prompt, before its turn ends. */
  let claude: ((prompt: string) => void) | null = null;
  const merge = new MergeService(
    records,
    finish,
    async (_id, prompt) => {
      prompts.push(prompt);
      records.setState('ws', 'working');
      claude?.(prompt);
    },
    {
      onConversation: (listener: (e: ConversationEvent) => void) => {
        events.on('conversation', listener);
        return () => events.off('conversation', listener);
      },
    },
  );
  /** Claude's turn ends with `said` as its last message. */
  const stop = (said = 'Ready to merge.') => {
    events.emit('conversation', {
      workspaceId: 'ws',
      event: 'Stop',
      text: said,
      transcript: null,
    } satisfies ConversationEvent);
    records.setState('ws', 'done');
  };
  return {
    repos,
    records,
    merge,
    prompts,
    stop,
    onPrompt: (f: (prompt: string) => void) => {
      claude = f;
    },
  };
}

/** A commit of `file` in `dir`. */
function commit(fx: Fixture, dir: string, file: string, text = `${file}\n`) {
  fs.writeFileSync(path.join(dir, file), text);
  fx.git(dir, 'add', file);
  fx.git(dir, 'commit', '-q', '-m', `add ${file}`);
}

const tip = (fx: Fixture, repo: string, ref: string) => fx.git(repo, 'rev-parse', ref).trim();

/** Waits until the merge status is no longer waiting (the retry is async). */
async function settled(merge: MergeService): Promise<MergeStatus | undefined> {
  for (let i = 0; i < 100; i++) {
    const s = merge.list()[0];
    if (s && s.phase !== 'waiting') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return merge.list()[0];
}

describe('Merge into the base (spec §14.4)', () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  it('fast-forwards the base in a clean main checkout, untracked files allowed', async () => {
    fx = createFixture();
    const { repos, merge, records, prompts } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fs.writeFileSync(path.join(web.repo, 'notes.txt'), 'mine\n');
    expect(await merge.merge('ws')).toEqual({ kind: 'merged' });
    expect(tip(fx, web.repo, 'main')).toBe(tip(fx, web.worktree, 'HEAD'));
    // The main checkout's files follow; its branch stays.
    expect(fs.existsSync(path.join(web.repo, 'fix.txt'))).toBe(true);
    expect(fx.git(web.repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(prompts).toEqual([]);
    expect(records.get('ws')?.repos[0]?.merged).toBe('base');
    expect(merge.list()[0]?.phase).toBe('done');
  });

  it('shows git refusing to overwrite an untracked file', async () => {
    fx = createFixture();
    const { repos, merge } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fs.writeFileSync(path.join(web.repo, 'fix.txt'), 'mine\n');
    const result = await merge.merge('ws');
    expect(result.kind).toBe('stopped');
    expect(result.kind === 'stopped' && result.reason).toMatch(
      /^git refused to fast-forward main: /,
    );
    expect(tip(fx, web.repo, 'main')).not.toBe(tip(fx, web.worktree, 'HEAD'));
  });

  it('refuses a main checkout with changed files, and changes nothing', async () => {
    fx = createFixture();
    const { repos, merge } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    const before = tip(fx, web.repo, 'main');
    fs.writeFileSync(path.join(web.repo, 'README'), 'changed\n');
    const result = await merge.merge('ws');
    expect(result).toEqual({
      kind: 'stopped',
      reason: `Your main checkout of web (${web.repo}) has uncommitted changes on main: commit or stash them there first`,
    });
    expect(tip(fx, web.repo, 'main')).toBe(before);
  });

  it('moves the base by ref when the main checkout is on another branch, without touching it', async () => {
    fx = createFixture();
    const { repos, merge } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fx.git(web.repo, 'switch', '-q', '-c', 'other');
    fs.writeFileSync(path.join(web.repo, 'README'), 'work in progress\n');
    expect(await merge.merge('ws')).toEqual({ kind: 'merged' });
    expect(tip(fx, web.repo, 'main')).toBe(tip(fx, web.worktree, 'HEAD'));
    expect(fx.git(web.repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('other');
    expect(fs.readFileSync(path.join(web.repo, 'README'), 'utf8')).toBe('work in progress\n');
    expect(fs.existsSync(path.join(web.repo, 'fix.txt'))).toBe(false);
  });

  it('refuses a base checked out in another worktree', async () => {
    fx = createFixture();
    const { repos, merge } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fx.git(web.repo, 'switch', '-q', '-c', 'other');
    const elsewhere = path.join(fx.root, 'elsewhere');
    fx.git(web.repo, 'worktree', 'add', '-q', elsewhere, 'main');
    const result = await merge.merge('ws');
    expect(result.kind === 'stopped' && result.reason).toBe(
      `main is checked out in ${elsewhere}, which the app doesn't change: merge there yourself`,
    );
  });

  it('refuses uncommitted files, and while Claude works', async () => {
    fx = createFixture();
    const { repos, merge, records } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fs.writeFileSync(path.join(web.worktree, 'more.txt'), 'x\n');
    expect(await merge.merge('ws')).toEqual({
      kind: 'stopped',
      reason: 'web has 1 uncommitted file: commit first',
    });
    records.setState('ws', 'working');
    await expect(merge.merge('ws')).rejects.toThrow(/Claude is working/);
  });

  it('asks Claude to rebase a diverged branch, then merges once its turn ends', async () => {
    fx = createFixture();
    const { repos, merge, records, prompts, stop, onPrompt } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, web.repo, 'other.txt');
    onPrompt(() => fx.git(web.worktree, 'rebase', '-q', 'main'));
    expect(await merge.merge('ws')).toEqual({ kind: 'waiting' });
    expect(prompts).toEqual([
      mergePrompt(BRANCH, 'rebase', [{ name: 'web', worktree: web.worktree, base: 'main' }], false),
    ]);
    expect(prompts[0]).toMatch(
      /^Rebase PROJ-1-fix onto the local main branch .*run git rebase main /,
    );
    expect(merge.list()[0]?.phase).toBe('waiting');
    await expect(merge.merge('ws')).rejects.toThrow(/already under way/);
    stop();
    const status = await settled(merge);
    expect(status?.phase).toBe('done');
    expect(tip(fx, web.repo, 'main')).toBe(tip(fx, web.worktree, 'HEAD'));
    expect(records.get('ws')?.repos[0]?.merged).toBe('base');
  });

  it('stops without looping when Claude says it is not ready', async () => {
    fx = createFixture();
    const { repos, merge, stop, prompts, onPrompt } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, web.repo, 'other.txt');
    onPrompt(() => fx.git(web.worktree, 'rebase', '-q', 'main'));
    await merge.merge('ws');
    stop('The rebase went fine.\n\nNot ready to merge: the tests fail');
    const status = await settled(merge);
    expect(status?.phase).toBe('stopped');
    expect(status?.repos[0]?.reason).toBe("Claude says it isn't ready: the tests fail");
    expect(prompts).toHaveLength(1);
  });

  it('names the conflicts left by an unfinished rebase', async () => {
    fx = createFixture();
    const { repos, merge, stop, onPrompt } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'same.txt', 'mine\n');
    commit(fx, web.repo, 'same.txt', 'theirs\n');
    onPrompt(() => {
      try {
        fx.git(web.worktree, 'rebase', '-q', 'main');
      } catch {
        // stops at the conflict
      }
    });
    await merge.merge('ws');
    stop();
    const status = await settled(merge);
    expect(status?.repos[0]?.reason).toBe('Conflicts left in same.txt');
  });

  it('says when the base moved again while Claude worked', async () => {
    fx = createFixture();
    const { repos, merge, stop, onPrompt } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, web.repo, 'other.txt');
    onPrompt(() => {
      fx.git(web.worktree, 'rebase', '-q', 'main');
      commit(fx, web.repo, 'later.txt');
    });
    await merge.merge('ws');
    stop();
    expect((await settled(merge))?.repos[0]?.reason).toBe(
      'main moved again while Claude worked: merge again',
    );
  });

  it('stops waiting on Cancel, and when Claude is interrupted', async () => {
    fx = createFixture();
    const { repos, merge, records, stop } = setup(fx, ['web']);
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, web.repo, 'other.txt');
    const before = tip(fx, web.repo, 'main');
    await merge.merge('ws');
    merge.cancel('ws');
    expect(merge.list()).toEqual([]);
    stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(tip(fx, web.repo, 'main')).toBe(before);
    await merge.merge('ws');
    records.setState('ws', 'interrupted');
    expect(merge.list()[0]?.phase).toBe('stopped');
    expect(merge.list()[0]?.repos[0]?.reason).toBe('Claude was interrupted before it finished');
  });

  it('asks first for a pushed branch, and merges the base in when told to', async () => {
    fx = createFixture();
    const { repos, merge, records, prompts, stop, onPrompt } = setup(fx, ['web'], { remote: true });
    const [web] = repos as [Repo];
    commit(fx, web.worktree, 'fix.txt');
    fx.git(web.worktree, 'push', '-q', '-u', 'origin', BRANCH);
    const pr: PrStatus = { state: 'open', url: 'https://example.com/pull/12', source: 'command' };
    records.setPr('ws', pr);
    commit(fx, web.repo, 'other.txt');
    expect(await merge.merge('ws')).toEqual({
      kind: 'ask',
      branch: BRANCH,
      base: 'main',
      published: `origin/${BRANCH}, PR #12 open`,
    });
    expect(prompts).toEqual([]);
    onPrompt(() => fx.git(web.worktree, 'merge', '-q', '--no-edit', 'main'));
    expect(await merge.merge('ws', null, 'merge')).toEqual({ kind: 'waiting' });
    expect(prompts[0]).toMatch(
      /^Merge the local main branch into PROJ-1-fix .*run git merge main .*Don't rebase and don't push/,
    );
    stop();
    expect((await settled(merge))?.phase).toBe('done');
    expect(tip(fx, web.repo, 'main')).toBe(tip(fx, web.worktree, 'HEAD'));
    // The base is never pushed.
    expect(tip(fx, web.repo, 'origin/main')).not.toBe(tip(fx, web.repo, 'main'));
  });

  it('merges each repository of a linked workspace into its own base, Claude only where needed', async () => {
    fx = createFixture();
    const { repos, merge, prompts, stop, onPrompt } = setup(fx, ['web', 'api', 'docs']);
    const [web, api] = repos as [Repo, Repo, Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, api.worktree, 'fix.txt');
    commit(fx, api.repo, 'other.txt');
    // docs has no commits of its own: skipped.
    onPrompt(() => fx.git(api.worktree, 'rebase', '-q', 'main'));
    expect(await merge.merge('ws')).toEqual({ kind: 'waiting' });
    expect(tip(fx, web.repo, 'main')).toBe(tip(fx, web.worktree, 'HEAD'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      `api (worktree ${api.worktree}): run git -C ${api.worktree} rebase main`,
    );
    expect(prompts[0]).not.toContain('web (worktree');
    expect(merge.list()[0]?.repos.map((r) => `${r.name}:${r.phase}`)).toEqual([
      'web:merged',
      'api:waiting',
      'docs:skipped',
    ]);
    stop();
    expect((await settled(merge))?.phase).toBe('done');
    expect(tip(fx, api.repo, 'main')).toBe(tip(fx, api.worktree, 'HEAD'));
  });

  it('refuses everything when one repository of a linked workspace is refused', async () => {
    fx = createFixture();
    const { repos, merge } = setup(fx, ['web', 'api']);
    const [web, api] = repos as [Repo, Repo];
    commit(fx, web.worktree, 'fix.txt');
    commit(fx, api.worktree, 'fix.txt');
    const before = tip(fx, web.repo, 'main');
    fs.writeFileSync(path.join(api.repo, 'README'), 'changed\n');
    const result = await merge.merge('ws');
    expect(result.kind).toBe('stopped');
    expect(tip(fx, web.repo, 'main')).toBe(before);
  });
});
