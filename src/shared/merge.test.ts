import { describe, expect, it } from 'vitest';
import {
  baseUpstreamText,
  type MergeFacts,
  type MergeStatus,
  mergeDecision,
  mergeProgressText,
  mergeStoppedText,
  notReadyReason,
} from './merge';

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  name: 'web',
  branch: 'PROJ-1-fix',
  base: 'main',
  uncommitted: 0,
  hasOwnCommits: true,
  merged: false,
  canFastForward: true,
  checkout: { kind: 'main', path: '/repos/web', dirty: false },
  published: null,
  baseUpstream: null,
  ...over,
});

describe('the merge rules (spec §14.4)', () => {
  it('fast-forwards in the main checkout when the base is checked out there and it is clean', () => {
    expect(mergeDecision(facts())).toEqual({ action: 'fast-forward', via: 'checkout' });
  });

  it('moves the base by ref when it is checked out nowhere (the main checkout on another branch)', () => {
    expect(mergeDecision(facts({ checkout: { kind: 'none' } }))).toEqual({
      action: 'fast-forward',
      via: 'ref',
    });
  });

  it('refuses a main checkout with changed files, and a base checked out in another worktree', () => {
    expect(
      mergeDecision(facts({ checkout: { kind: 'main', path: '/repos/web', dirty: true } })),
    ).toEqual({
      action: 'refuse',
      reason:
        'Your main checkout of web (/repos/web) has uncommitted changes on main: commit or stash them there first',
    });
    expect(mergeDecision(facts({ checkout: { kind: 'other', path: '/wt/other' } }))).toEqual({
      action: 'refuse',
      reason:
        "main is checked out in /wt/other, which the app doesn't change: merge there yourself",
    });
    // Also when the branch has diverged: nothing goes to Claude.
    expect(
      mergeDecision(
        facts({ canFastForward: false, checkout: { kind: 'main', path: '/r', dirty: true } }),
      ).action,
    ).toBe('refuse');
  });

  it('refuses uncommitted files in the worktree', () => {
    expect(mergeDecision(facts({ uncommitted: 2 }))).toEqual({
      action: 'refuse',
      reason: 'web has 2 uncommitted files: commit first',
    });
  });

  it('skips a branch without commits of its own, and one already merged', () => {
    expect(mergeDecision(facts({ hasOwnCommits: false })).action).toBe('skip');
    expect(mergeDecision(facts({ merged: true })).action).toBe('skip');
  });

  it('sends a diverged branch to Claude to rebase', () => {
    expect(mergeDecision(facts({ canFastForward: false }))).toEqual({
      action: 'claude',
      mode: 'rebase',
    });
  });

  it('asks first for a published branch, then follows the answer', () => {
    const pushed = facts({ canFastForward: false, published: 'origin/PROJ-1-fix, PR #12 open' });
    expect(mergeDecision(pushed)).toEqual({
      action: 'ask',
      published: 'origin/PROJ-1-fix, PR #12 open',
    });
    expect(mergeDecision(pushed, 'merge')).toEqual({ action: 'claude', mode: 'merge' });
    expect(mergeDecision(pushed, 'rebase')).toEqual({ action: 'claude', mode: 'rebase' });
    // A fast-forward needs no question.
    expect(mergeDecision(facts({ published: 'origin/PROJ-1-fix' })).action).toBe('fast-forward');
  });
});

describe('the base against its upstream (spec §14.4)', () => {
  it('refuses a base that diverged from its upstream, and merges one that is behind', () => {
    expect(
      mergeDecision(facts({ baseUpstream: { ref: 'origin/main', behind: 2, ahead: 1 } })),
    ).toEqual({
      action: 'refuse',
      reason: 'main and origin/main have both moved on: update main first',
    });
    expect(
      mergeDecision(facts({ baseUpstream: { ref: 'origin/main', behind: 3, ahead: 0 } })),
    ).toEqual({ action: 'fast-forward', via: 'checkout' });
    // Only ahead: the local base has unpushed commits, which is fine.
    expect(
      mergeDecision(facts({ baseUpstream: { ref: 'origin/main', behind: 0, ahead: 2 } })),
    ).toEqual({ action: 'fast-forward', via: 'checkout' });
  });

  it('says what Merge does with the base first', () => {
    expect(baseUpstreamText('main', { ref: 'origin/main', behind: 3, ahead: 0 })).toBe(
      "main is 3 behind origin/main; it's updated first",
    );
    expect(baseUpstreamText('main', { ref: 'origin/main', behind: 3, ahead: 1 })).toBe(
      'main and origin/main have both moved on: update main first',
    );
    expect(baseUpstreamText('main', { ref: 'origin/main', behind: 0, ahead: 1 })).toBeNull();
    expect(baseUpstreamText('main', null)).toBeNull();
  });
});

describe("Claude's last line", () => {
  it('reads the reason from "Not ready to merge: …", also in Markdown', () => {
    expect(notReadyReason('Rebased.\n\nNot ready to merge: the tests fail')).toBe('the tests fail');
    expect(notReadyReason('**Not ready to merge: lint fails**')).toBe('lint fails');
    expect(notReadyReason('All good.\nReady to merge.')).toBeNull();
    expect(notReadyReason(null)).toBeNull();
  });
});

describe('the progress and outcome texts', () => {
  const status = (
    repos: MergeStatus['repos'],
    mode: MergeStatus['mode'] = 'rebase',
  ): MergeStatus => ({
    workspaceId: 'ws',
    phase: 'waiting',
    mode,
    repos,
  });
  const r = (
    name: string,
    phase: MergeStatus['repos'][number]['phase'],
    reason: string | null = null,
  ) => ({
    projectId: name,
    name,
    base: 'main',
    phase,
    reason,
  });

  it('counts the repositories of a linked workspace', () => {
    expect(mergeProgressText(status([r('web', 'waiting')]))).toBe('Rebasing for merge…');
    expect(mergeProgressText(status([r('web', 'waiting')], 'merge'))).toBe(
      'Merging the base in for merge…',
    );
    expect(
      mergeProgressText(status([r('web', 'waiting'), r('api', 'merged'), r('docs', 'skipped')])),
    ).toBe('Rebasing for merge… · 1 of 2 merged');
  });

  it('says why it stopped, and what merged already', () => {
    expect(mergeStoppedText(status([r('web', 'failed', 'Conflicts left in a.ts')]))).toBe(
      'Conflicts left in a.ts',
    );
    expect(
      mergeStoppedText(status([r('api', 'merged'), r('web', 'failed', 'main moved again')])),
    ).toBe('Merged 1 of 2 · web: main moved again');
  });
});
