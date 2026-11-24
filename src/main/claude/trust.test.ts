import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../git/git';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { ensureClaudeCodeReady, mergeClaudeState, trustRoot } from './trust';

let fx: Fixture;
let git: Git;

beforeAll(() => {
  fx = createFixture();
  git = new Git({ gitPath: 'git', env: fx.env });
});
afterAll(() => fx.cleanup());

const real = (p: string) => fs.realpathSync(p);

describe('trustRoot', () => {
  it('is the main checkout for the checkout, a subfolder and a linked worktree', async () => {
    const repo = fx.localRepo('trusted', 'main');
    fs.mkdirSync(path.join(repo, 'src'));
    const worktree = path.join(fx.root, 'worktrees', 'trusted', 'feature');
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    expect(await trustRoot(repo, git)).toBe(real(repo));
    expect(await trustRoot(path.join(repo, 'src'), git)).toBe(real(repo));
    expect(await trustRoot(worktree, git)).toBe(real(repo));
    expect(await trustRoot(`${worktree}/`, git)).toBe(real(repo));
  });

  it('is the folder itself outside a repository or without git', async () => {
    const plain = path.join(fx.root, 'plain-trust');
    fs.mkdirSync(plain);
    expect(await trustRoot(plain, git)).toBe(real(plain));
    expect(await trustRoot(`${plain}/`, null)).toBe(real(plain));
  });
});

describe('mergeClaudeState', () => {
  it('trusts each root and dismisses the resume question, keeping every other key', () => {
    const before = {
      numStartups: 7,
      oauthAccount: { emailAddress: 'test@example.com' },
      projects: {
        '/a': { allowedTools: ['Bash'], hasTrustDialogAccepted: false },
        '/other': { hasTrustDialogAccepted: true, history: [] },
      },
    };
    const merged = mergeClaudeState(JSON.stringify(before), ['/a', '/b']);
    expect(JSON.parse(merged ?? '')).toEqual({
      numStartups: 7,
      oauthAccount: { emailAddress: 'test@example.com' },
      resumeReturnDismissed: true,
      projects: {
        '/a': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
        '/b': { hasTrustDialogAccepted: true },
        '/other': { hasTrustDialogAccepted: true, history: [] },
      },
    });
  });

  it('is null when nothing changes, and throws for a file that is no JSON object', () => {
    const done = {
      resumeReturnDismissed: true,
      projects: { '/a': { hasTrustDialogAccepted: true } },
    };
    expect(mergeClaudeState(JSON.stringify(done), ['/a'])).toBeNull();
    expect(() => mergeClaudeState('{"projects":', ['/a'])).toThrow();
    expect(() => mergeClaudeState('[]', ['/a'])).toThrow();
  });
});

describe('ensureClaudeCodeReady', () => {
  it('writes the file once, with its mode, and leaves it alone on the second run', async () => {
    const repo = fx.localRepo('ready', 'main');
    const worktree = path.join(fx.root, 'worktrees', 'ready', 'task');
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'task', worktree);
    const linked = fx.localRepo('ready-linked', 'main');
    const stateFile = path.join(fx.root, 'ready-state', '.claude.json');
    fs.mkdirSync(path.dirname(stateFile));
    fs.writeFileSync(stateFile, JSON.stringify({ userID: 'u', projects: {} }), { mode: 0o600 });
    const warn = vi.fn();
    const options = { stateFile, gitPath: 'git', env: fx.env, warn };

    await ensureClaudeCodeReady([worktree, linked], options);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state).toEqual({
      userID: 'u',
      resumeReturnDismissed: true,
      projects: {
        [real(repo)]: { hasTrustDialogAccepted: true },
        [real(linked)]: { hasTrustDialogAccepted: true },
      },
    });
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(stateFile))).toEqual(['.claude.json']);

    const written = fs.statSync(stateFile).mtimeMs;
    const ino = fs.statSync(stateFile).ino;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureClaudeCodeReady([worktree, linked], options);
    expect(fs.statSync(stateFile).mtimeMs).toBe(written);
    expect(fs.statSync(stateFile).ino).toBe(ino);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes nothing and warns when the file is missing or not JSON', async () => {
    const dir = path.join(fx.root, 'broken-state');
    fs.mkdirSync(dir);
    const warn = vi.fn();
    const stateFile = path.join(dir, '.claude.json');

    await ensureClaudeCodeReady([dir], { stateFile, gitPath: 'git', env: fx.env, warn });
    expect(fs.existsSync(stateFile)).toBe(false);

    fs.writeFileSync(stateFile, '{"projects": {');
    await ensureClaudeCodeReady([dir], { stateFile, gitPath: 'git', env: fx.env, warn });
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('{"projects": {');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
