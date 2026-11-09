import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MergedInto, SubmoduleWork } from '@shared/workspaces';
import type { Env } from '../env/scrub';

/** The first line of git's error, without `fatal:` or `error:` (for notes). */
export function gitReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return (line ?? text).replace(/^(fatal|error):\s*/i, '');
}

/** How long Create waits for the remote, per `ls-remote` or `fetch` (spec §7.3). */
export const NETWORK_TIMEOUT_SEC = 30;

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    /** What git printed before it failed (`merge-tree` lists conflicts there). */
    readonly stdout = '',
  ) {
    super(stderr.trim() || `git ${args.join(' ')} failed with exit code ${exitCode}`);
    this.name = 'GitError';
  }
}

/** A changed file (spec §6.4). `R` is a rename from `oldPath`. */
export interface DiffFile {
  kind: 'M' | 'A' | 'D' | 'R';
  path: string;
  oldPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
}

/** A workspace's branch and the base it merges into (spec §14.2). */
export interface MergedRefs {
  branch: string;
  base: string;
  /** Null without a remote: the local base is the base. */
  remote: string | null;
}

/** One entry of `git worktree list --porcelain`. */
export interface GitWorktree {
  path: string;
  head: string | null;
  /** The checked-out branch, without `refs/heads/`; null when detached. */
  branch: string | null;
  bare: boolean;
  /** Its folder is gone; `git worktree prune` would forget it. */
  prunable: boolean;
  /** `git worktree lock`ed: a plain remove is refused. */
  locked: boolean;
}

/** Parses `git worktree list --porcelain`: blocks of lines, separated by blank lines. */
export function parseWorktreeList(out: string): GitWorktree[] {
  return out
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter(Boolean))
    .filter((lines) => lines[0]?.startsWith('worktree '))
    .map((lines) => {
      const value = (key: string) =>
        lines.find((l) => l === key || l.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
      const branch = value('branch');
      return {
        path: value('worktree') as string,
        head: value('HEAD'),
        branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
        bare: lines.includes('bare'),
        prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
        locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      };
    });
}

export interface GitOptions {
  /** Absolute path of the git executable. */
  gitPath: string;
  /** Environment of the profile the command runs for (rule R3). */
  env: Env;
}

/**
 * Thin wrapper around the git CLI (spec §16): behaviour matches the user's own
 * git config, credentials and hooks. Never prompts; a command that would ask
 * for credentials fails instead.
 */
export class Git {
  constructor(private readonly options: GitOptions) {}

  /**
   * Runs git. With `timeoutSec`, it runs in its own process group, which is
   * stopped after that long: the ssh it started for a remote goes too.
   */
  run(cwd: string, args: string[], { timeoutSec }: { timeoutSec?: number } = {}): Promise<string> {
    // No optional locks: a background `git status` would otherwise take the
    // index lock to refresh it, and the user's own git command could fail
    // on `index.lock` meanwhile (spec §16).
    const env = { ...this.options.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    if (timeoutSec !== undefined) return this.runTimed(cwd, args, env, timeoutSec);
    return new Promise((resolve, reject) => {
      execFile(
        this.options.gitPath,
        args,
        { cwd, env, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            reject(new GitError(args, code, stderr || error.message, stdout));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  private runTimed(cwd: string, args: string[], env: Env, timeoutSec: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(this.options.gitPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, timeoutSec * 1000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const done = (code: number | null, message = '') => {
        clearTimeout(timer);
        if (timedOut) reject(new GitError(args, null, `timed out after ${timeoutSec} s`));
        else if (code !== 0) reject(new GitError(args, code, stderr || message));
        else resolve(stdout);
      };
      child.on('error', (error) => done(null, error.message));
      child.on('close', (code) => done(code));
    });
  }

  /** Like `run`, but returns null instead of throwing when git exits non-zero. */
  async tryRun(cwd: string, args: string[]): Promise<string | null> {
    try {
      return await this.run(cwd, args);
    } catch (error) {
      if (error instanceof GitError && error.exitCode !== null) return null;
      throw error;
    }
  }

  /**
   * The main checkout of the repository containing `dir`. For a linked
   * worktree this is the checkout it was created from, not the worktree.
   */
  async mainCheckout(dir: string): Promise<string> {
    const out = await this.run(dir, [
      'rev-parse',
      '--path-format=absolute',
      '--is-bare-repository',
      '--git-common-dir',
    ]);
    const [isBare, commonDir] = out.trim().split('\n');
    if (isBare === 'true' || !commonDir) {
      throw new GitError(['rev-parse'], 1, `${dir} is a bare repository; pick a checkout`);
    }
    if (path.basename(commonDir) !== '.git') {
      // A separate git dir (`git init --separate-git-dir`) has no checkout to derive.
      return (await this.run(dir, ['rev-parse', '--show-toplevel'])).trim();
    }
    return path.dirname(commonDir);
  }

  async remotes(repo: string): Promise<string[]> {
    return (await this.run(repo, ['remote'])).split('\n').filter(Boolean);
  }

  /** Default branch of a remote from `<remote>/HEAD`, or null if unknown locally. */
  async remoteDefaultBranch(repo: string, remote: string): Promise<string | null> {
    const ref = await this.tryRun(repo, [
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remote}/HEAD`,
    ]);
    const name = ref?.trim();
    return name?.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : null;
  }

  /** The checked-out branch, or null on a detached HEAD. */
  async currentBranch(repo: string): Promise<string | null> {
    return (
      (await this.tryRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null
    );
  }

  /** Whether `name` is a valid branch name (`git check-ref-format --branch`). */
  async isValidBranchName(cwd: string, name: string): Promise<boolean> {
    if (!name || name.startsWith('-')) return false;
    return (await this.tryRun(cwd, ['check-ref-format', '--branch', name])) !== null;
  }

  async localBranchExists(repo: string, branch: string): Promise<boolean> {
    const out = await this.tryRun(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    return out !== null;
  }

  /** Whether the remote-tracking ref exists locally (as of the last fetch). */
  async trackingBranchExists(repo: string, remote: string, branch: string): Promise<boolean> {
    const ref = `refs/remotes/${remote}/${branch}`;
    return (await this.tryRun(repo, ['rev-parse', '--verify', '--quiet', ref])) !== null;
  }

  /** The remote's branches, asked of the remote itself (network). */
  async remoteHeads(repo: string, remote: string): Promise<Set<string>> {
    const out = await this.run(repo, ['ls-remote', '--heads', remote], {
      timeoutSec: NETWORK_TIMEOUT_SEC,
    });
    return new Set(
      out
        .split('\n')
        .map((line) => /\trefs\/heads\/(.+)$/.exec(line)?.[1])
        .filter((b): b is string => Boolean(b)),
    );
  }

  /** Branch names of a remote's tracking refs, e.g. `develop` for `origin/develop`. */
  async remoteBranches(repo: string, remote: string): Promise<string[]> {
    const out = await this.run(repo, [
      'for-each-ref',
      '--format=%(refname:lstrip=3)',
      `refs/remotes/${remote}`,
    ]);
    return out.split('\n').filter((b) => b && b !== 'HEAD');
  }

  async localBranches(repo: string): Promise<string[]> {
    const out = await this.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return out.split('\n').filter(Boolean);
  }

  async fetch(repo: string, remote: string, branch: string): Promise<void> {
    await this.run(repo, ['fetch', '--quiet', remote, branch], { timeoutSec: NETWORK_TIMEOUT_SEC });
  }

  /**
   * New branch and worktree at `dir` from `startPoint`. `--no-track`: the
   * branch must not push to its base by accident.
   */
  async addWorktree(repo: string, dir: string, branch: string, startPoint: string): Promise<void> {
    await this.run(repo, [
      'worktree',
      'add',
      '--quiet',
      '--no-track',
      '-b',
      branch,
      dir,
      startPoint,
    ]);
  }

  /** The repository's shared git dir (`.git` of the main checkout), absolute. */
  async commonDir(dir: string): Promise<string> {
    const out = await this.run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return out.trim();
  }

  /** `git status --porcelain` lines: uncommitted and untracked changes. */
  async status(dir: string): Promise<string[]> {
    const out = await this.run(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
    return out.split('\n').filter(Boolean);
  }

  /**
   * Commits on `branch` that would be lost with it: not on any remote-tracking
   * branch, or, for a repository without remotes, not on any other local branch.
   */
  async unpushedCount(repo: string, branch: string, hasRemote: boolean): Promise<number> {
    const others = hasRemote
      ? ['--remotes']
      : (await this.localBranches(repo)).filter((b) => b !== branch).map((b) => `refs/heads/${b}`);
    const out = await this.run(repo, [
      'rev-list',
      '--count',
      `refs/heads/${branch}`,
      '--not',
      ...others,
    ]);
    return Number(out.trim());
  }

  /**
   * Where `branch`'s own commits start (spec §14.2): `start`, the commit it
   * was created from, moved forward each time the branch caught up with the
   * base while it had no own commits (a fast-forward to the base, a rebase
   * onto it, a reset to it). Read from the branch's reflog: an entry caught
   * up when its new tip is in the base and was committed before the entry
   * (a commit, amend, cherry-pick or rebased commit made on the branch has the
   * entry's own time). Without a reflog, `start` as recorded.
   */
  async ownStart(
    repo: string,
    { branch, start, base, remote }: MergedRefs & { start: string | null },
  ): Promise<string | null> {
    if (!start) return null;
    // Newest first: the new tip, its committer time and the entry's time.
    const out = await this.tryRun(repo, [
      'log',
      '--walk-reflogs',
      '--date=unix',
      '--format=%H %ct %gd',
      `refs/heads/${branch}`,
      '--',
    ]);
    const entries = (out ?? '')
      .split('\n')
      .map((line) => line.match(/^([0-9a-f]+) (\d+) .*@\{(\d+)\}$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ tip: m[1] as string, committed: Number(m[2]), at: Number(m[3]) }))
      .reverse();
    const bases: string[] = [];
    for (const ref of [remote ? `refs/remotes/${remote}/${base}` : null, `refs/heads/${base}`]) {
      if (ref && (await this.revParse(repo, ref))) bases.push(ref);
    }
    const isAncestor = async (a: string, b: string) =>
      a === b || (await this.tryRun(repo, ['merge-base', '--is-ancestor', a, b])) !== null;
    const inBase = async (commit: string) => {
      for (const ref of bases) if (await isAncestor(commit, ref)) return true;
      return false;
    };
    let own = start;
    // The first entry is the branch's creation (or the oldest one kept).
    for (const [i, { tip, committed, at }] of entries.entries()) {
      const before = entries[i - 1]?.tip;
      if (!before || committed >= at || tip === own) continue;
      if (!(await isAncestor(own, tip)) || !(await inBase(tip))) continue;
      // Own commits merged, then caught up: they stay its own.
      if (!(await isAncestor(before, own)) && (await isAncestor(before, tip))) continue;
      own = tip;
    }
    return own;
  }

  /**
   * Where `branch` is merged (spec §14.2): it has commits of its own (since
   * its own start, `ownStart`), and its tip is contained in `<remote>/<base>`
   * (`base`) or only in the local base (`local`), or every one of its commits'
   * changes is already there (`git cherry`, for rebased branches). Otherwise,
   * when merging it would change nothing (`git merge-tree --write-tree` gives
   * the base's own tree, as after a squash merge), `squash` or
   * `squash-local`; never on git before 2.38, which hasn't `--write-tree`.
   * Without a remote the local base is the base. Null when not merged,
   * without commits of its own, or when its start isn't known.
   */
  async mergedInto(
    repo: string,
    refs: MergedRefs & { start: string | null },
  ): Promise<MergedInto | null> {
    const { branch, base, remote } = refs;
    const head = await this.revParse(repo, `refs/heads/${branch}`);
    if (!head || !refs.start || head === refs.start) return null;
    const start = await this.ownStart(repo, refs);
    if (!start || head === start) return null;
    const contains = async (ref: string) => {
      if (!(await this.revParse(repo, ref))) return false;
      if ((await this.tryRun(repo, ['merge-base', '--is-ancestor', head, ref])) !== null)
        return true;
      // Rebased or cherry-picked: each of its own commits has an equivalent in the base.
      const lines = ((await this.tryRun(repo, ['cherry', ref, head, start])) ?? '')
        .split('\n')
        .filter(Boolean);
      return lines.length > 0 && lines.every((l) => l.startsWith('-'));
    };
    // Its changes are there although its commits aren't: a squash merge.
    const changesIn = (ref: string) => this.changesAlreadyIn(repo, ref, head);
    const remoteBase = remote ? `refs/remotes/${remote}/${base}` : null;
    const localBase = `refs/heads/${base}`;
    if (remoteBase && (await contains(remoteBase))) return 'base';
    if (await contains(localBase)) return remote ? 'local' : 'base';
    if (remoteBase && (await changesIn(remoteBase))) return 'squash';
    if (await changesIn(localBase)) return remote ? 'squash-local' : 'squash';
    return null;
  }

  /**
   * Whether merging `rev` into `ref` would change nothing (spec §14.2):
   * `git merge-tree --write-tree` gives `ref`'s own tree. False without
   * `ref`, on a conflict, and on git before 2.38.
   */
  async changesAlreadyIn(repo: string, ref: string, rev: string): Promise<boolean> {
    if (!(await this.hasMergeTreeWriteTree()) || !(await this.revParse(repo, ref))) return false;
    const merged = (await this.tryRun(repo, ['merge-tree', '--write-tree', ref, rev]))
      ?.split('\n')[0]
      ?.trim();
    return Boolean(merged) && merged === (await this.revParse(repo, `${ref}^{tree}`));
  }

  private writeTree: Promise<boolean> | null = null;

  /** Whether git has `merge-tree --write-tree` (git 2.38 and later). */
  hasMergeTreeWriteTree(): Promise<boolean> {
    this.writeTree ??= this.run(process.cwd(), ['version']).then(
      (out) => {
        const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number);
        return major > 2 || (major === 2 && minor >= 38);
      },
      () => false,
    );
    return this.writeTree;
  }

  /**
   * `git worktree remove` (spec §14.2). `plain` lets git refuse a worktree
   * with changes; `submodules` is git's one `--force`, which a worktree with
   * submodules needs, and only for one checked clean first (it would also
   * drop changes); `force` (twice, for a locked one too) after Delete anyway.
   */
  async removeWorktree(
    repo: string,
    dir: string,
    mode: 'plain' | 'submodules' | 'force',
  ): Promise<void> {
    const flags = { plain: [], submodules: ['--force'], force: ['--force', '--force'] }[mode];
    await this.run(repo, ['worktree', 'remove', ...flags, dir]);
  }

  /**
   * Whether `git worktree remove` refuses `dir` without `--force` for its
   * submodules (git 2.17 and later): as git checks, a `modules` folder in the
   * worktree's git dir (left by `git submodule update`, even after `deinit`),
   * or a checked-out submodule.
   */
  async hasSubmodules(dir: string): Promise<boolean> {
    const gitDir = (
      await this.run(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
    ).trim();
    if (fs.existsSync(path.join(gitDir, 'modules'))) return true;
    return (await this.checkedOutSubmodules(dir)).length > 0;
  }

  /**
   * The submodules checked out in `dir`, nested ones too, as paths relative
   * to it: gitlinks in the index whose folder has a `.git` (git's own test).
   */
  async checkedOutSubmodules(dir: string, prefix = ''): Promise<string[]> {
    const out = await this.run(dir, ['ls-files', '-z', '--stage']);
    const paths = new Set(
      out
        .split('\0')
        .map((entry) => /^160000 [0-9a-f]+ \d\t(.+)$/s.exec(entry)?.[1])
        .filter((p): p is string => Boolean(p)),
    );
    const found: string[] = [];
    for (const p of paths) {
      const sub = path.join(dir, p);
      if (!fs.existsSync(path.join(sub, '.git'))) continue;
      found.push(`${prefix}${p}`);
      found.push(...(await this.checkedOutSubmodules(sub, `${prefix}${p}/`)));
    }
    return found;
  }

  /**
   * The checked-out submodules of `dir` with work of their own (spec §14.2):
   * uncommitted changes, or commits (checked out or on a local branch) on
   * none of the submodule's remote-tracking branches. A submodule git can't
   * read counts as changed, with git's reason.
   */
  async submoduleWork(dir: string): Promise<SubmoduleWork[]> {
    const work: SubmoduleWork[] = [];
    for (const sub of await this.checkedOutSubmodules(dir)) {
      const subDir = path.join(dir, sub);
      let uncommitted: string[];
      let unpushed: number;
      try {
        uncommitted = await this.status(subDir);
        const out = await this.run(subDir, [
          'rev-list',
          '--count',
          'HEAD',
          '--branches',
          '--not',
          '--remotes',
        ]);
        unpushed = Number(out.trim());
      } catch (error) {
        uncommitted = [`can't read it: ${gitReason(error)}`];
        unpushed = 0;
      }
      if (uncommitted.length > 0 || unpushed > 0) work.push({ path: sub, uncommitted, unpushed });
    }
    return work;
  }

  /** The repository's worktrees (`git worktree list --porcelain`), the main checkout first. */
  async listWorktrees(repo: string): Promise<GitWorktree[]> {
    return parseWorktreeList(await this.run(repo, ['worktree', 'list', '--porcelain']));
  }

  /** Forgets worktrees whose folders are gone. */
  async pruneWorktrees(repo: string): Promise<void> {
    await this.run(repo, ['worktree', 'prune']);
  }

  /** The best common ancestor of two commits, or null when they share none. */
  async mergeBase(dir: string, a: string, b: string): Promise<string | null> {
    return (await this.tryRun(dir, ['merge-base', a, b]))?.trim() || null;
  }

  async revParse(dir: string, rev: string): Promise<string | null> {
    return (await this.tryRun(dir, ['rev-parse', '--verify', '--quiet', rev]))?.trim() || null;
  }

  /**
   * Changed files between `from` and `to` (or the working tree when `to` is
   * null), with renames: kind, path, old path, and added/removed line counts
   * (null for binary files).
   */
  async diffFiles(dir: string, from: string, to: string | null): Promise<DiffFile[]> {
    const range = to ? [from, to] : [from];
    const [status, numstat] = await Promise.all([
      this.run(dir, ['diff', '-z', '-M', '--name-status', ...range, '--']),
      this.run(dir, ['diff', '-z', '-M', '--numstat', ...range, '--']),
    ]);
    const files: DiffFile[] = [];
    const s = status.split('\0');
    for (let i = 0; i + 1 < s.length; ) {
      const code = s[i++] as string;
      if (!code) continue;
      const kind = code[0] as string;
      if (kind === 'R' || kind === 'C') {
        const oldPath = s[i++] as string;
        files.push({
          kind: kind === 'R' ? 'R' : 'A',
          path: s[i++] as string,
          oldPath,
          added: 0,
          removed: 0,
          binary: false,
        });
      } else {
        files.push({
          kind: kind === 'D' ? 'D' : kind === 'A' ? 'A' : 'M',
          path: s[i++] as string,
          oldPath: null,
          added: 0,
          removed: 0,
          binary: false,
        });
      }
    }
    // numstat: "add\tdel\tpath\0", or for renames "add\tdel\t\0old\0new\0".
    const n = numstat.split('\0');
    for (let i = 0; i < n.length; ) {
      const head = n[i++] as string;
      if (!head) continue;
      const [add, del, rest] = head.split('\t') as [string, string, string];
      let filePath = rest;
      if (rest === '') {
        i++; // the old path of a rename
        filePath = n[i++] as string;
      }
      const file = files.find((f) => f.path === filePath);
      if (!file) continue;
      file.binary = add === '-';
      file.added = file.binary ? 0 : Number(add);
      file.removed = file.binary ? 0 : Number(del);
    }
    return files;
  }

  /** Untracked files that aren't ignored, relative to `dir`. */
  async untrackedFiles(dir: string): Promise<string[]> {
    const out = await this.run(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
    return out.split('\0').filter(Boolean);
  }

  /** A file's content at a revision, or null when it doesn't exist there. */
  async showFile(dir: string, rev: string, file: string): Promise<Buffer | null> {
    return new Promise((resolve) => {
      execFile(
        this.options.gitPath,
        ['show', `${rev}:${file}`],
        {
          cwd: dir,
          env: { ...this.options.env, GIT_TERMINAL_PROMPT: '0' },
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  }

  /** Deletes a local branch; remote branches are never touched. */
  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.run(repo, ['branch', '--quiet', '-D', branch]);
  }

  /** `git fetch --prune <remote>`: every branch of the remote (network, spec §7.6). */
  async fetchRemote(repo: string, remote: string): Promise<void> {
    await this.run(repo, ['fetch', '--quiet', '--prune', remote], {
      timeoutSec: NETWORK_TIMEOUT_SEC,
    });
  }

  /**
   * A remote's URL as git uses it: `git remote get-url` expands the user's
   * `url.<base>.insteadOf` rewrites (spec §7.6). Null without that remote.
   */
  async remoteUrl(repo: string, remote: string): Promise<string | null> {
    return (await this.tryRun(repo, ['remote', 'get-url', remote]))?.trim() || null;
  }

  /** The commit a ref names on the remote (`git ls-remote <remote> <ref>`), or null (network). */
  async remoteRef(repo: string, remote: string, ref: string): Promise<string | null> {
    const out = await this.run(repo, ['ls-remote', remote, ref], {
      timeoutSec: NETWORK_TIMEOUT_SEC,
    });
    const line = out.split('\n').find((l) => l.endsWith(`\t${ref}`));
    return line?.split('\t')[0] || null;
  }

  /**
   * Local and remote-tracking branches with their tip and last commit
   * (author, ISO date, subject), most recently committed first (spec §7.6).
   */
  async branchRefs(repo: string): Promise<BranchRef[]> {
    const out = await this.run(repo, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(objectname)%00%(authorname)%00%(committerdate:iso-strict)%00%(subject)',
      'refs/heads',
      'refs/remotes',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref = '', commit = '', author = '', date = '', subject = ''] = line.split('\0');
        return { ref, commit, author, date, subject };
      })
      .filter((r) => !r.ref.endsWith('/HEAD'));
  }

  /** A branch's upstream (`branch.<b>.remote` and `.merge`), or null without one. */
  async upstream(repo: string, branch: string): Promise<{ remote: string; branch: string } | null> {
    const remote = (await this.tryRun(repo, ['config', `branch.${branch}.remote`]))?.trim();
    const merge = (await this.tryRun(repo, ['config', `branch.${branch}.merge`]))?.trim();
    if (!remote || remote === '.' || !merge) return null;
    return { remote, branch: merge.replace(/^refs\/heads\//, '') };
  }

  /**
   * A worktree at `dir` on an existing branch (spec §7.6), without a new name:
   * the local branch when there is one (its upstream set to `<remote>/<branch>`
   * when it has none), else a new local branch tracking `<remote>/<branch>`.
   * Says which it was: `local` or `remote`.
   */
  async addWorktreeOnBranch(
    repo: string,
    dir: string,
    branch: string,
    remote: string | null,
  ): Promise<'local' | 'remote'> {
    const tracking = remote ? `refs/remotes/${remote}/${branch}` : null;
    const hasTracking = tracking ? (await this.revParse(repo, tracking)) !== null : false;
    if (await this.localBranchExists(repo, branch)) {
      await this.run(repo, ['worktree', 'add', '--quiet', dir, branch]);
      if (remote && hasTracking && !(await this.upstream(repo, branch))) {
        await this.run(repo, [
          'branch',
          '--quiet',
          `--set-upstream-to=${remote}/${branch}`,
          branch,
        ]);
      }
      return 'local';
    }
    if (!remote || !hasTracking) throw new GitError(['worktree', 'add'], 1, `No branch ${branch}`);
    await this.run(repo, [
      'worktree',
      'add',
      '--quiet',
      '--track',
      '-b',
      branch,
      dir,
      `${remote}/${branch}`,
    ]);
    return 'remote';
  }

  /** How many commits `ref` has that HEAD of `dir` doesn't (spec §6.4). */
  async behind(dir: string, ref: string): Promise<number> {
    const out = await this.tryRun(dir, ['rev-list', '--count', `HEAD..${ref}`]);
    return out ? Number(out.trim()) : 0;
  }

  /**
   * The files merging `ref` into HEAD would conflict in (spec §6.4), from
   * `git merge-tree --write-tree` (git 2.38 or newer); null when git can't
   * tell (an older git, unrelated histories).
   */
  async mergeConflicts(dir: string, ref: string): Promise<string[] | null> {
    try {
      await this.run(dir, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        'HEAD',
        ref,
      ]);
      return [];
    } catch (error) {
      // Exit 1 is a merge with conflicts: the tree, then the conflicted files.
      if (!(error instanceof GitError) || error.exitCode !== 1) return null;
      return [...new Set(error.stdout.split('\n').slice(1).filter(Boolean))];
    }
  }

  /** The author emails of the commits in `range` (`a..b`), lowercase and distinct. */
  async authors(dir: string, range: string): Promise<{ name: string; email: string }[]> {
    const out = await this.tryRun(dir, ['log', '--format=%an%x00%ae', range]);
    const seen = new Map<string, string>();
    for (const line of (out ?? '').split('\n').filter(Boolean)) {
      const [name = '', email = ''] = line.split('\0');
      if (!seen.has(email.toLowerCase())) seen.set(email.toLowerCase(), name);
    }
    return [...seen].map(([email, name]) => ({ name, email }));
  }

  /** The email git would author a commit with in `dir` (environment and config), or null. */
  async identityEmail(dir: string): Promise<string | null> {
    const ident = await this.tryRun(dir, ['var', 'GIT_AUTHOR_IDENT']);
    return /<([^>]*)>/.exec(ident ?? '')?.[1]?.toLowerCase() || null;
  }
}

/** One ref of `branchRefs`. */
export interface BranchRef {
  /** Full ref name: `refs/heads/<b>` or `refs/remotes/<remote>/<b>`. */
  ref: string;
  commit: string;
  author: string;
  date: string;
  subject: string;
}
