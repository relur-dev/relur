import { describe, expect, it } from 'vitest';
import {
  claudePastes,
  claudePath,
  type DroppedFile,
  relativePath,
  shellText,
} from './dropped-paths';
import { shellQuote } from './shell';

const file = (path: string, folder = false, real = path): DroppedFile => ({ path, real, folder });
const where = { cwd: '/wt/app', roots: ['/wt/app', '/wt/api'] };

describe('dropped paths', () => {
  it('gives a file inside the worktree as a relative @path', () => {
    expect(claudePath(file('/wt/app/src/main.ts'), where)).toBe('@src/main.ts');
    expect(claudePath(file('/wt/app/red.png'), where)).toBe('@red.png');
  });

  it('gives a folder with a trailing slash, and the worktree itself as ./', () => {
    expect(claudePath(file('/wt/app/src', true), where)).toBe('@src/');
    expect(claudePath(file('/wt/app', true), where)).toBe('@./');
  });

  it('gives a linked repository relative to Claude’s folder', () => {
    expect(claudePath(file('/wt/api/routes.ts'), where)).toBe('@../api/routes.ts');
  });

  it('quotes an @path with spaces, and goes absolute for a name with "', () => {
    expect(claudePath(file('/wt/app/my notes/a b.md'), where)).toBe('@"my notes/a b.md"');
    expect(claudePath(file('/wt/app/say "hi".txt'), where)).toBe(`'/wt/app/say "hi".txt'`);
  });

  it('gives a file outside as its absolute path, quoted when needed', () => {
    expect(claudePath(file('/tmp/log.txt'), where)).toBe('/tmp/log.txt');
    expect(claudePath(file('/Users/me/My Pictures/shot 1.png'), where)).toBe(
      "'/Users/me/My Pictures/shot 1.png'",
    );
    expect(claudePath(file('/tmp/it’s here', true), where)).toBe("'/tmp/it’s here'");
    expect(claudePath(file("/tmp/don't"), where)).toBe(`'/tmp/don'\\''t'`);
  });

  it('takes a root only as a whole folder, not a prefix', () => {
    expect(claudePath(file('/wt/application/x.ts'), where)).toBe('/wt/application/x.ts');
  });

  it('decides by the real path and shows the given one outside', () => {
    expect(claudePath(file('/link/app/a.ts', false, '/wt/app/a.ts'), where)).toBe('@a.ts');
    expect(claudePath(file('/var/x/a.ts', false, '/private/var/x/a.ts'), where)).toBe(
      '/var/x/a.ts',
    );
  });

  it('pastes several files one by one, each with a space; a space first after a draft', () => {
    const files = [file('/wt/app/a.ts'), file('/tmp/b c.png'), file('/wt/app/lib', true)];
    expect(claudePastes(files, where, false)).toEqual(['@a.ts ', "'/tmp/b c.png' ", '@lib/ ']);
    expect(claudePastes(files.slice(0, 1), where, true)).toEqual([' @a.ts ']);
  });

  it('gives no @path where Claude has no roots (Claude in the home folder)', () => {
    expect(claudePath(file('/Users/me/a.txt'), { cwd: '/Users/me', roots: [] })).toBe(
      '/Users/me/a.txt',
    );
  });

  it('gives a shell the quoted absolute paths', () => {
    expect(shellText([file('/wt/app/a.ts'), file('/tmp/my file'), file('/tmp/dir', true)])).toBe(
      "/wt/app/a.ts '/tmp/my file' /tmp/dir ",
    );
    expect(shellQuote('/a/$HOME/`x`')).toBe("'/a/$HOME/`x`'");
  });

  it('makes relative paths', () => {
    expect(relativePath('/a/b', '/a/b/c/d')).toBe('c/d');
    expect(relativePath('/a/b', '/a/x')).toBe('../x');
    expect(relativePath('/a/b', '/a/b')).toBe('.');
  });
});
