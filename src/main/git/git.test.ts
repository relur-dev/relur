import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { Git, GitError, gitReason } from './git';

let fx: Fixture;
let git: Git;

beforeAll(() => {
  fx = createFixture();
  git = new Git({ gitPath: 'git', env: fx.env });
});
afterAll(() => fx.cleanup());

// Each test runs dozens of git commands: 5 s is too tight under x64 emulation (linux-check.sh).
describe('Git', { timeout: 20_000 }, () => {
  it('finds the main checkout from the root, a subfolder and a linked worktree', async () => {
    const { clone } = fx.cloneWithRemote('main-checkout');
    fs.mkdirSync(path.join(clone, 'src', 'deep'), { recursive: true });
    const worktree = path.join(fx.root, 'wt-main-checkout');
    fx.git(clone, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    expect(await git.mainCheckout(clone)).toBe(clone);
    expect(await git.mainCheckout(path.join(clone, 'src', 'deep'))).toBe(clone);
    expect(await git.mainCheckout(worktree)).toBe(clone);
  });

  it('rejects folders outside a repository and bare repositories', async () => {
    const plain = path.join(fx.root, 'plain');
    fs.mkdirSync(plain);
    await expect(git.mainCheckout(plain)).rejects.toBeInstanceOf(GitError);

    const { origin } = fx.cloneWithRemote('bare-check');
    await expect(git.mainCheckout(origin)).rejects.toThrow(/bare repository/);
  });

  it('reads remotes and the remote default branch', async () => {
    const { clone } = fx.cloneWithRemote('remote-head', 'develop');
    expect(await git.remotes(clone)).toEqual(['origin']);
    expect(await git.remoteDefaultBranch(clone, 'origin')).toBe('develop');

    fx.git(clone, 'remote', 'add', 'upstream', 'https://example.invalid/repo.git');
    expect(await git.remotes(clone)).toEqual(['origin', 'upstream']);
    expect(await git.remoteDefaultBranch(clone, 'upstream')).toBeNull();
  });

  it('reads the current branch, null when detached', async () => {
    const repo = fx.localRepo('current', 'trunk');
    expect(await git.currentBranch(repo)).toBe('trunk');
    fx.git(repo, 'checkout', '-q', '--detach');
    expect(await git.currentBranch(repo)).toBeNull();
  });

  it('runs git without prompts and without optional locks (spec §16)', async () => {
    // `env` in place of git prints the environment git would get.
    const env = new Git({ gitPath: '/usr/bin/env', env: fx.env });
    const out = (await env.run(fx.root, [])).split('\n');
    expect(out).toContain('GIT_TERMINAL_PROMPT=0');
    expect(out).toContain('GIT_OPTIONAL_LOCKS=0');
  });

  it('reports git stderr in errors', async () => {
    const repo = fx.localRepo('errors');
    const error = await git.run(repo, ['rev-parse', 'no-such-ref']).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBe(128);
    expect(error.message).toMatch(/no-such-ref/);
  });

  it('validates and finds branches locally and on the remote', async () => {
    const { clone } = fx.cloneWithRemote('branches', 'develop');
    expect(await git.isValidBranchName(clone, 'feature/x-1')).toBe(true);
    expect(await git.isValidBranchName(clone, 'bad..name')).toBe(false);
    expect(await git.isValidBranchName(clone, '-x')).toBe(false);
    expect(await git.localBranchExists(clone, 'develop')).toBe(true);
    expect(await git.localBranchExists(clone, 'nope')).toBe(false);
    expect([...(await git.remoteHeads(clone, 'origin'))]).toEqual(['develop']);
    // A remote without branches, such as a new, empty repository.
    fx.git(fx.root, 'init', '-q', '--bare', 'empty.git');
    fx.git(clone, 'remote', 'add', 'empty', path.join(fx.root, 'empty.git'));
    expect(await git.remoteHeads(clone, 'empty')).toEqual(new Set());
    const unreachable = await git.remoteHeads(clone, 'nowhere').catch((e) => e);
    expect(gitReason(unreachable)).toMatch(/^'nowhere' does not appear to be a git repository/);
    expect(await git.trackingBranchExists(clone, 'origin', 'develop')).toBe(true);
    expect(await git.remoteBranches(clone, 'origin')).toEqual(['develop']);
  });

  it('adds, inspects and removes a worktree and its branch', async () => {
    const { clone } = fx.cloneWithRemote('worktrees', 'main');
    const dir = path.join(fx.root, 'wt', 'worktrees', 'task-1');
    await git.fetch(clone, 'origin', 'main');
    await git.addWorktree(clone, dir, 'task-1', 'origin/main');
    expect(fx.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('task-1');
    // --no-track: the new branch has no upstream.
    expect(await git.tryRun(clone, ['config', '--get', 'branch.task-1.remote'])).toBeNull();
    expect(await git.commonDir(dir)).toBe(path.join(clone, '.git'));
    expect(await git.status(dir)).toEqual([]);
    expect(await git.unpushedCount(clone, 'task-1', true)).toBe(0);

    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    expect(await git.status(dir)).toEqual(['?? new.txt']);
    fx.git(dir, 'add', '.');
    fx.git(dir, 'commit', '-q', '-m', 'work');
    expect(await git.unpushedCount(clone, 'task-1', true)).toBe(1);

    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
    await expect(git.removeWorktree(clone, dir, 'plain')).rejects.toBeInstanceOf(GitError);
    await git.removeWorktree(clone, dir, 'force');
    expect(fs.existsSync(dir)).toBe(false);
    await git.deleteBranch(clone, 'task-1');
    expect(await git.localBranchExists(clone, 'task-1')).toBe(false);
  });

  it('finds nested submodules and what git needs to remove their worktree (spec §14.2)', async () => {
    const allow = ['-c', 'protocol.file.allow=always'];
    const { origin: inner } = fx.cloneWithRemote('sm-inner');
    const { origin: outer, clone: outerClone } = fx.cloneWithRemote('sm-outer');
    fx.git(outerClone, ...allow, 'submodule', 'add', '-q', inner, 'inner');
    fx.git(outerClone, 'commit', '-q', '-m', 'inner');
    fx.git(outerClone, 'push', '-q', 'origin', 'main');
    const { clone } = fx.cloneWithRemote('sm-super');
    fx.git(clone, ...allow, 'submodule', 'add', '-q', outer, 'deps/outer');
    fx.git(clone, 'commit', '-q', '-m', 'outer');
    const dir = path.join(fx.root, 'wt-sm');
    fx.git(clone, 'worktree', 'add', '-q', '-b', 'sm', dir);
    // Not checked out yet: nothing to refuse.
    expect(await git.hasSubmodules(dir)).toBe(false);
    fx.git(dir, ...allow, 'submodule', 'update', '-q', '--init', '--recursive');
    expect(await git.checkedOutSubmodules(dir)).toEqual(['deps/outer', 'deps/outer/inner']);
    expect(await git.submoduleWork(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'deps', 'outer', 'inner', 'x'), 'x');
    expect(await git.submoduleWork(dir)).toEqual([
      { path: 'deps/outer', uncommitted: [' M inner'], unpushed: 0 },
      { path: 'deps/outer/inner', uncommitted: ['?? x'], unpushed: 0 },
    ]);
    fs.rmSync(path.join(dir, 'deps', 'outer', 'inner', 'x'));
    // After `deinit` git still refuses: its `modules` folder is left behind.
    fx.git(dir, 'submodule', 'deinit', '-q', '--all');
    expect(await git.checkedOutSubmodules(dir)).toEqual([]);
    expect(await git.hasSubmodules(dir)).toBe(true);
    await expect(git.removeWorktree(clone, dir, 'plain')).rejects.toThrow(/submodules/);
    await git.removeWorktree(clone, dir, 'submodules');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('counts commits not on other branches in a repository without remotes', async () => {
    const repo = fx.localRepo('no-remote');
    fx.git(repo, 'switch', '-q', '-c', 'task');
    fx.git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
    expect(await git.unpushedCount(repo, 'task', false)).toBe(1);
  });

  it('stops a network call after its timeout, with the ssh it started (spec §7.3)', async () => {
    // A git that starts a child holding its output open, as ssh does.
    const slow = path.join(fx.root, 'slow-git');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 30 &\nsleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const error = await new Git({ gitPath: slow, env: fx.env })
      .run(fx.root, ['fetch'], { timeoutSec: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(gitReason(error)).toBe('timed out after 1 s');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
