import { describe, expect, it } from 'vitest';
import {
  branchMatches,
  checkedOutText,
  type ExistingBranch,
  parseBranchUrl,
  prBranchUnknown,
  prHeadRef,
  remoteRepo,
  taskFromBranch,
} from './existing-branch';

describe('parseBranchUrl (spec §7.6)', () => {
  it('reads GitHub branch and pull request URLs', () => {
    expect(parseBranchUrl('https://github.com/acme/shop/tree/feature/login')).toEqual({
      kind: 'branch',
      candidates: ['feature/login', 'feature'],
      host: 'github.com',
      repo: 'shop',
    });
    expect(parseBranchUrl('https://www.github.com/acme/Shop/pull/42/files')).toEqual({
      kind: 'pr',
      number: 42,
      prHost: 'github',
      host: 'github.com',
      repo: 'shop',
    });
    // Encoded names, and a GitHub Enterprise host by the path's shape.
    expect(parseBranchUrl('https://git.example.com/acme/shop/tree/fix%2Fa%C4%8D')).toMatchObject({
      kind: 'branch',
      candidates: ['fix/ač'],
      host: 'git.example.com',
    });
  });

  it('reads GitLab URLs, with groups and subgroups', () => {
    expect(
      parseBranchUrl('https://gitlab.com/acme/team/shop/-/tree/ABC-12-fix?ref_type=heads'),
    ).toEqual({ kind: 'branch', candidates: ['ABC-12-fix'], host: 'gitlab.com', repo: 'shop' });
    expect(parseBranchUrl('https://gitlab.example.com/acme/shop/-/merge_requests/7')).toEqual({
      kind: 'pr',
      number: 7,
      prHost: 'gitlab',
      host: 'gitlab.example.com',
      repo: 'shop',
    });
  });

  it('reads Bitbucket Cloud and Bitbucket Server URLs', () => {
    expect(parseBranchUrl('https://bitbucket.org/acme/shop/branch/feature/x')).toMatchObject({
      kind: 'branch',
      candidates: ['feature/x', 'feature'],
      repo: 'shop',
    });
    expect(parseBranchUrl('https://bitbucket.org/acme/shop/src/feature/x/README.md')).toMatchObject(
      { kind: 'branch', candidates: ['feature/x/README.md', 'feature/x', 'feature'] },
    );
    expect(parseBranchUrl('https://bitbucket.org/acme/shop/pull-requests/3')).toMatchObject({
      kind: 'pr',
      number: 3,
      prHost: 'bitbucket',
    });
    expect(
      parseBranchUrl(
        'https://bitbucket.example.com/projects/ACME/repos/shop/browse?at=refs%2Fheads%2Ffeature%2Fx',
      ),
    ).toEqual({
      kind: 'branch',
      candidates: ['feature/x'],
      host: 'bitbucket.example.com',
      repo: 'shop',
    });
    expect(
      parseBranchUrl('https://bitbucket.example.com/users/ana/repos/shop/pull-requests/9/overview'),
    ).toMatchObject({ kind: 'pr', number: 9, prHost: 'bitbucket-server', repo: 'shop' });
  });

  it('is null for text and URLs that name no branch', () => {
    expect(parseBranchUrl('feature/x')).toBeNull();
    expect(parseBranchUrl('https://github.com/acme/shop')).toBeNull();
    expect(parseBranchUrl('https://github.com/acme/shop/issues/4')).toBeNull();
    expect(parseBranchUrl('https://gitlab.com/acme/shop/-/issues/4')).toBeNull();
    expect(parseBranchUrl('ssh://git@github.com/acme/shop/tree/x')).toBeNull();
  });
});

describe('remoteRepo', () => {
  it('reads scp-like, ssh and https remotes', () => {
    expect(remoteRepo('git@github.com:acme/Shop.git')).toEqual({
      host: 'github.com',
      repo: 'shop',
    });
    expect(remoteRepo('ssh://git@bitbucket.example.com:7999/acme/shop.git')).toEqual({
      host: 'bitbucket.example.com',
      repo: 'shop',
    });
    expect(remoteRepo('https://gitlab.com/acme/team/shop')).toEqual({
      host: 'gitlab.com',
      repo: 'shop',
    });
  });

  it('is null for local paths, which no web URL can be compared with', () => {
    expect(remoteRepo('/tmp/shop-origin.git')).toBeNull();
    expect(remoteRepo('file:///tmp/shop-origin.git')).toBeNull();
    expect(remoteRepo('../shop.git')).toBeNull();
  });
});

describe('pull request refs', () => {
  it('names each host’s head ref; Bitbucket Cloud has none', () => {
    expect(prHeadRef('github', 4)).toBe('refs/pull/4/head');
    expect(prHeadRef('gitlab', 4)).toBe('refs/merge-requests/4/head');
    expect(prHeadRef('bitbucket-server', 4)).toBe('refs/pull-requests/4/from');
    expect(prHeadRef('bitbucket', 4)).toBeNull();
  });

  it('says what to paste when the branch can’t be told', () => {
    expect(prBranchUnknown('bitbucket', 3, 'no-refs')).toBe(
      "Bitbucket Cloud doesn't tell git which branch pull request #3 comes from. Copy the branch name shown at the top of the pull request page and paste it here, or pick the branch from the list.",
    );
    expect(prBranchUnknown('gitlab', 7, 'fork')).toMatch(
      /^Merge request !7 comes from a branch .* \(a fork\?\)\. Copy the branch name shown at the top of the merge request page/,
    );
  });
});

describe('taskFromBranch', () => {
  it('splits a leading key off and turns dashes into spaces', () => {
    expect(taskFromBranch('ENG-1423-fix-login-timeout')).toEqual({
      id: 'ENG-1423',
      title: 'fix login timeout',
    });
    expect(taskFromBranch('feature/ABC-1_dark_mode')).toEqual({ id: 'ABC-1', title: 'dark mode' });
    expect(taskFromBranch('ana/landing-page')).toEqual({ id: null, title: 'landing page' });
  });
});

describe('branch list helpers', () => {
  const row = (name: string, author = 'Ana'): ExistingBranch => ({
    name,
    local: false,
    remotes: ['origin'],
    author,
    date: '2026-11-01T10:00:00Z',
    subject: 's',
    checkedOut: null,
    base: false,
  });

  it('filters by every word, in the name or the author', () => {
    expect(branchMatches(row('feature/login'), 'feat log')).toBe(true);
    expect(branchMatches(row('feature/login', 'Ana Ek'), 'ana')).toBe(true);
    expect(branchMatches(row('feature/login'), 'signup')).toBe(false);
  });

  it('says where a branch is checked out', () => {
    expect(checkedOutText('x', { kind: 'main', path: '/r/shop' }, 'shop')).toBe(
      'x is checked out in the main checkout of shop (/r/shop). Switch it to another branch there to make a workspace of it',
    );
    expect(
      checkedOutText('x', { kind: 'workspace', workspaceId: 'w', name: 'X', path: '/w' }, 'shop'),
    ).toBe('x is open in the workspace X');
  });
});
