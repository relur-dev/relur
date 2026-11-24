import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../git/git';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import {
  excludeLocalSettings,
  LOCAL_SETTINGS,
  setAdditionalDirectory,
  withAdditionalDirectory,
} from './local-settings';

let fx: Fixture;
let git: Git;

beforeAll(() => {
  fx = createFixture();
  git = new Git({ gitPath: 'git', env: fx.env });
});
afterAll(() => fx.cleanup());

const parse = (text: string | null) => JSON.parse(text ?? '');

describe('withAdditionalDirectory', () => {
  it('adds the folder once, keeping every other key', () => {
    const before = {
      model: 'haiku',
      permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/x'] },
    };
    const added = withAdditionalDirectory(JSON.stringify(before), '/w/api', true);
    expect(parse(added)).toEqual({
      model: 'haiku',
      permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/x', '/w/api'] },
    });
    expect(withAdditionalDirectory(added, '/w/api', true)).toBeNull();
  });

  it('starts a missing or empty file, and one without permissions', () => {
    const expected = { permissions: { additionalDirectories: ['/w/api'] } };
    expect(parse(withAdditionalDirectory(null, '/w/api', true))).toEqual(expected);
    expect(parse(withAdditionalDirectory('', '/w/api', true))).toEqual(expected);
    expect(parse(withAdditionalDirectory('{"env":{}}', '/w/api', true))).toEqual({
      env: {},
      ...expected,
    });
  });

  it('removes only that folder, and is null when it is not listed', () => {
    const before = {
      permissions: { deny: ['Read(.env)'], additionalDirectories: ['/x', '/w/api'] },
    };
    expect(parse(withAdditionalDirectory(JSON.stringify(before), '/w/api', false))).toEqual({
      permissions: { deny: ['Read(.env)'], additionalDirectories: ['/x'] },
    });
    expect(withAdditionalDirectory(JSON.stringify(before), '/w/web', false)).toBeNull();
    expect(withAdditionalDirectory('{}', '/w/api', false)).toBeNull();
  });

  it('throws for a file that is no JSON object', () => {
    expect(() => withAdditionalDirectory('{"permissions":', '/w', true)).toThrow();
    expect(() => withAdditionalDirectory('[]', '/w', true)).toThrow();
  });
});

describe('setAdditionalDirectory', () => {
  it('creates .claude and the file, writes only on a change and removes again', () => {
    const dir = path.join(fx.root, 'claude-dir');
    fs.mkdirSync(dir);
    const file = path.join(dir, LOCAL_SETTINGS);
    const warn = vi.fn();

    setAdditionalDirectory(dir, '/w/api', false, warn);
    expect(fs.existsSync(file)).toBe(false);

    setAdditionalDirectory(dir, '/w/api', true, warn);
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual({
      permissions: { additionalDirectories: ['/w/api'] },
    });
    const { ino, mtimeMs } = fs.statSync(file);
    setAdditionalDirectory(dir, '/w/api', true, warn);
    expect(fs.statSync(file).ino).toBe(ino);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeMs);

    setAdditionalDirectory(dir, '/w/api', false, warn);
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual({
      permissions: { additionalDirectories: [] },
    });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.local.json']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a broken file alone and warns', () => {
    const dir = path.join(fx.root, 'claude-broken');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, LOCAL_SETTINGS), '{"permissions":');
    const warn = vi.fn();
    setAdditionalDirectory(dir, '/w/api', true, warn);
    expect(fs.readFileSync(path.join(dir, LOCAL_SETTINGS), 'utf8')).toBe('{"permissions":');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('excludeLocalSettings', () => {
  const excludeOf = (repo: string) => path.join(repo, '.git', 'info', 'exclude');

  it("adds the file to the main repository's info/exclude once, from a worktree", async () => {
    const repo = fx.localRepo('exclude-me');
    const worktree = path.join(fx.root, 'wt-exclude', 'task');
    fx.git(repo, 'worktree', 'add', '-q', '-b', 'task', worktree);
    fs.writeFileSync(excludeOf(repo), '# mine\n/build/');
    setAdditionalDirectory(worktree, '/w/api', true);

    await excludeLocalSettings(git, worktree);
    await excludeLocalSettings(git, worktree);
    expect(fs.readFileSync(excludeOf(repo), 'utf8')).toBe(
      '# mine\n/build/\n.claude/settings.local.json\n',
    );
    expect(fx.git(worktree, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  });

  it('leaves info/exclude alone when git ignores the file already', async () => {
    const repo = fx.localRepo('ignored-already');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
    const before = fs.existsSync(excludeOf(repo)) ? fs.readFileSync(excludeOf(repo), 'utf8') : null;
    await excludeLocalSettings(git, repo);
    const after = fs.existsSync(excludeOf(repo)) ? fs.readFileSync(excludeOf(repo), 'utf8') : null;
    expect(after).toBe(before);
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('.claude/\n');
  });
});
