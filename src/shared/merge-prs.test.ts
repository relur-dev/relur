import { describe, expect, it } from 'vitest';
import {
  allowedMethods,
  canMerge,
  chooseMergeMethod,
  defaultOrder,
  type LocalFacts,
  localProblems,
  mergeAllPrsBlocked,
  orderProblem,
  type PrDetails,
  parseMergeOutput,
  prDetails,
  prProblems,
  type RepoPreflight,
  reportSummary,
  runMerges,
} from './merge-prs';

const clean: LocalFacts = {
  uncommitted: 0,
  checkedOut: 'feat',
  remoteRef: 'origin/feat',
  fetchError: null,
  remoteHead: 'abc',
  ahead: 0,
  behind: 0,
};

const mergeable: PrDetails = {
  state: 'open',
  url: 'https://example.com/pull/1',
  base: 'main',
  head: 'abc',
  mergeable: true,
  conflicts: false,
  checks: 'passed',
  reviews: 'approved',
  methods: ['squash', 'merge'],
};

describe('Merge all PRs preflight (spec §21.10)', () => {
  it('passes a clean worktree level with its remote branch', () => {
    expect(localProblems('feat', clean)).toEqual([]);
  });

  it('refuses a dirty tree, unpushed and unpulled commits, and names each', () => {
    expect(localProblems('feat', { ...clean, uncommitted: 2 })).toEqual([
      '2 uncommitted files: commit and push them first',
    ]);
    expect(localProblems('feat', { ...clean, ahead: 1 })).toEqual([
      '1 commit not pushed: push first',
    ]);
    expect(localProblems('feat', { ...clean, behind: 3 })).toEqual([
      "origin/feat has 3 commits this worktree doesn't: pull first",
    ]);
    expect(localProblems('feat', { ...clean, ahead: 1, behind: 1 })).toEqual([
      'feat and origin/feat have both moved on: merge origin/feat into it and push',
    ]);
  });

  it('refuses another branch, a branch not on the remote, and a failed fetch', () => {
    expect(localProblems('feat', { ...clean, checkedOut: 'other' })).toEqual([
      'Its worktree is on other, not feat',
    ]);
    expect(localProblems('feat', { ...clean, checkedOut: null })).toEqual([
      'Its worktree is on a detached HEAD, not feat',
    ]);
    expect(localProblems('feat', { ...clean, remoteHead: null })).toEqual([
      "feat isn't on the remote (origin/feat): push it first",
    ]);
    expect(localProblems('feat', { ...clean, fetchError: 'no network' })).toEqual([
      "Couldn't fetch origin/feat: no network",
    ]);
  });

  it('passes a mergeable open pull request into the expected base at the pushed commit', () => {
    expect(prProblems(mergeable, 'main', 'abc')).toEqual([]);
  });

  it('refuses a draft, a closed one, another base and a head the host has not seen', () => {
    expect(prProblems({ ...mergeable, state: 'draft' }, 'main', 'abc')).toEqual([
      'Its pull request is a draft: mark it ready for review',
    ]);
    expect(prProblems({ ...mergeable, state: 'closed' }, 'main', 'abc')).toEqual([
      'Its pull request is closed',
    ]);
    expect(prProblems({ ...mergeable, base: 'develop' }, 'main', 'abc')).toEqual([
      'Its pull request merges into develop, not main',
    ]);
    expect(prProblems({ ...mergeable, head: 'old' }, 'main', 'abc')).toEqual([
      "The pull request isn't at the pushed commit yet: check again in a moment",
    ]);
  });

  it('names conflicts, running and failed checks, and missing reviews', () => {
    const no = { ...mergeable, mergeable: false };
    expect(prProblems({ ...no, conflicts: true }, 'main', 'abc')).toEqual([
      'It has conflicts with main',
    ]);
    expect(prProblems({ ...no, checks: 'pending' }, 'main', 'abc')).toEqual([
      'Checks running: check again when they finish',
    ]);
    expect(prProblems({ ...no, checks: 'failed' }, 'main', 'abc')).toEqual(['Checks failed']);
    expect(prProblems({ ...no, reviews: 'required' }, 'main', 'abc')).toEqual([
      'It needs an approving review',
    ]);
    expect(prProblems({ ...no, reviews: 'changes-requested' }, 'main', 'abc')).toEqual([
      'A reviewer requested changes',
    ]);
  });

  it("goes by the host's mergeable: its reason, still working it out, or not said", () => {
    expect(
      prProblems({ ...mergeable, mergeable: false, blockedReason: 'Behind main' }, 'main', 'abc'),
    ).toEqual(['Behind main']);
    expect(prProblems({ ...mergeable, mergeable: false }, 'main', 'abc')).toEqual([
      "The host won't merge it yet",
    ]);
    expect(prProblems({ ...mergeable, mergeable: null }, 'main', 'abc')).toEqual([
      'The host is still working out whether it can be merged: check again',
    ]);
    const { mergeable: _, base: __, ...bare } = mergeable;
    expect(prProblems(bare, 'main', 'abc')).toEqual([
      "The PR status command doesn't say which branch it merges into (base)",
      "The PR status command doesn't say whether it can be merged (mergeable)",
    ]);
  });

  it("reads the status command's extra fields and leaves out wrong ones", () => {
    expect(
      prDetails(
        {
          base: 'main',
          head: 'abc',
          mergeable: null,
          conflicts: 'yes',
          checks: 'pending',
          reviews: 'nope',
          methods: ['rebase', 'fast', 'squash'],
          blockedReason: '',
        },
        'open',
        null,
      ),
    ).toEqual({
      state: 'open',
      url: null,
      base: 'main',
      head: 'abc',
      mergeable: null,
      checks: 'pending',
      methods: ['squash', 'rebase'],
    });
  });

  it("reads the merge command's last line for the merge commit", () => {
    expect(
      parseMergeOutput('Merged\n{"commit":"abc","commitUrl":"https://x/commit/abc"}\n'),
    ).toEqual({ commit: 'abc', commitUrl: 'https://x/commit/abc' });
    expect(parseMergeOutput('✓ Merged pull request #3')).toEqual({ commit: null, commitUrl: null });
    expect(parseMergeOutput('{oops')).toEqual({ commit: null, commitUrl: null });
  });
});

describe('merge method (spec §21.10)', () => {
  it("starts with the project's method when the host allows it", () => {
    expect(chooseMergeMethod(['squash', 'merge', 'rebase'], 'rebase')).toBe('rebase');
    expect(chooseMergeMethod(['squash', 'merge'], 'rebase')).toBe('squash');
  });

  it('else squash, else a merge commit, else rebase; none when nothing is allowed', () => {
    expect(chooseMergeMethod(['rebase', 'merge', 'squash'], null)).toBe('squash');
    expect(chooseMergeMethod(['rebase', 'merge'], null)).toBe('merge');
    expect(chooseMergeMethod(['rebase'], undefined)).toBe('rebase');
    expect(chooseMergeMethod([], 'squash')).toBeNull();
  });

  it('takes every method when the status command does not say', () => {
    expect(allowedMethods({ state: 'open', url: null })).toEqual(['squash', 'merge', 'rebase']);
    expect(allowedMethods({ state: 'open', url: null, methods: ['rebase', 'merge'] })).toEqual([
      'merge',
      'rebase',
    ]);
  });
});

describe('order and availability (spec §21.10)', () => {
  it('starts with the primary, then the linked repositories in link order', () => {
    expect(
      defaultOrder([
        { projectId: 'infra', primary: false },
        { projectId: 'web', primary: true },
        { projectId: 'api', primary: false },
      ]),
    ).toEqual(['web', 'infra', 'api']);
  });

  it('wants every repository once', () => {
    expect(orderProblem(['b', 'a'], ['a', 'b'])).toBeNull();
    expect(orderProblem(['a'], ['a', 'b'])).toBe('The order leaves out b');
    expect(orderProblem(['a', 'a', 'b'], ['a', 'b'])).toBe('A repository is listed twice');
    expect(orderProblem(['a', 'b', 'x'], ['a', 'b'])).toBe('Not in this workspace: x');
  });

  it('enables the header button once every repository has a pull request', () => {
    const pr = (state: string) => ({ state });
    expect(
      mergeAllPrsBlocked([
        { name: 'web', pr: pr('open') },
        { name: 'api', pr: null },
      ]),
    ).toBe('No pull request known in api');
    expect(
      mergeAllPrsBlocked([
        { name: 'web', pr: pr('open') },
        { name: 'api', pr: pr('closed') },
      ]),
    ).toBe('Its pull request is closed in api');
    expect(
      mergeAllPrsBlocked([
        { name: 'web', pr: pr('merged') },
        { name: 'api', pr: pr('merged') },
      ]),
    ).toBe('Every pull request is merged');
    expect(
      mergeAllPrsBlocked([
        { name: 'web', pr: pr('merged') },
        { name: 'api', pr: pr('draft') },
      ]),
    ).toBeNull();
  });

  it('allows Merge only when nothing failed and something is left', () => {
    expect(canMerge([{ result: 'ready' }, { result: 'merged' }])).toBe(true);
    expect(canMerge([{ result: 'ready' }, { result: 'failed' }])).toBe(false);
    expect(canMerge([{ result: 'merged' }])).toBe(false);
    expect(canMerge([])).toBe(false);
  });
});

describe('merging in order (spec §21.10)', () => {
  const repos = ['infra', 'api', 'web', 'docs'].map((name) => ({ projectId: name, name }));
  const row = (projectId: string, result: RepoPreflight['result'], problems: string[] = []) =>
    ({
      projectId,
      name: projectId,
      primary: false,
      branch: 'feat',
      baseBranch: 'main',
      prUrl: `https://example.com/${projectId}/pull/1`,
      result,
      problems,
      methods: ['squash'],
      method: 'squash',
      head: 'abc',
    }) satisfies RepoPreflight;
  const merged = (projectId: string) => ({
    method: 'squash' as const,
    commit: `c-${projectId}`,
    commitUrl: null,
    branchDeleted: true,
    deleteError: null,
    warning: null,
  });

  it('merges each in turn, checking it just before', async () => {
    const calls: string[] = [];
    const report = await runMerges(repos, {
      check: async (r) => {
        calls.push(`check ${r.name}`);
        return row(r.projectId, 'ready');
      },
      merge: async (r) => {
        calls.push(`merge ${r.name}`);
        return merged(r.projectId);
      },
    });
    expect(calls).toEqual([
      'check infra',
      'merge infra',
      'check api',
      'merge api',
      'check web',
      'merge web',
      'check docs',
      'merge docs',
    ]);
    expect(report.stopped).toBe(false);
    expect(report.repos.map((r) => r.outcome)).toEqual(['merged', 'merged', 'merged', 'merged']);
    expect(reportSummary(report)).toBe('Merged 4 pull requests');
  });

  it('stops at the first failed merge, skips the rest and undoes nothing', async () => {
    const merges: string[] = [];
    const progress: (string | null)[] = [];
    const report = await runMerges(repos, {
      check: async (r) => row(r.projectId, r.name === 'infra' ? 'merged' : 'ready'),
      merge: async (r) => {
        merges.push(r.name);
        if (r.name === 'web') throw new Error('The PR merge command failed: conflict on host');
        return merged(r.projectId);
      },
      progress: (_, current) => progress.push(current),
    });
    expect(merges).toEqual(['api', 'web']);
    expect(progress).toEqual(['infra', 'api', 'web', null]);
    expect(report.stopped).toBe(true);
    expect(report.repos).toEqual([
      expect.objectContaining({ projectId: 'infra', outcome: 'already-merged' }),
      expect.objectContaining({
        projectId: 'api',
        outcome: 'merged',
        commit: 'c-api',
        prUrl: 'https://example.com/api/pull/1',
        branchDeleted: true,
      }),
      expect.objectContaining({
        projectId: 'web',
        outcome: 'failed',
        reason: 'The PR merge command failed: conflict on host',
      }),
      expect.objectContaining({ projectId: 'docs', outcome: 'skipped', reason: null }),
    ]);
    expect(reportSummary(report)).toBe(
      'Merge stopped at web: The PR merge command failed: conflict on host · 1 merged · 1 skipped',
    );
  });

  it('stops when the check just before a merge fails, without merging it', async () => {
    const merges: string[] = [];
    const report = await runMerges(repos, {
      check: async (r) =>
        r.name === 'api'
          ? row(r.projectId, 'failed', ['Checks running: check again when they finish'])
          : row(r.projectId, 'ready'),
      merge: async (r) => {
        merges.push(r.name);
        return merged(r.projectId);
      },
    });
    expect(merges).toEqual(['infra']);
    expect(report.repos.map((r) => [r.name, r.outcome, r.reason])).toEqual([
      ['infra', 'merged', null],
      ['api', 'failed', 'Checks running: check again when they finish'],
      ['web', 'skipped', null],
      ['docs', 'skipped', null],
    ]);
  });

  it('stops when the check itself throws', async () => {
    const report = await runMerges(repos.slice(0, 2), {
      check: async () => {
        throw new Error('The PR status command timed out after 15 s');
      },
      merge: async (r) => merged(r.projectId),
    });
    expect(report.repos.map((r) => r.outcome)).toEqual(['failed', 'skipped']);
    expect(reportSummary(report)).toBe(
      'Merge stopped at infra: The PR status command timed out after 15 s · 0 merged · 1 skipped',
    );
  });

  it('says when everything was merged already', async () => {
    const report = await runMerges(repos.slice(0, 1), {
      check: async (r) => row(r.projectId, 'merged'),
      merge: async (r) => merged(r.projectId),
    });
    expect(reportSummary(report)).toBe('Nothing to merge: every pull request was merged already');
  });
});
