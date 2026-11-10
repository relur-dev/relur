/**
 * Merge into the base (spec §14.4): fast-forwards each repository's local
 * base branch to the workspace's branch; when the base has moved on, Claude
 * rebases (or merges the base in) first and the app tries once more. A base
 * behind its upstream is fast-forwarded to it first.
 */

/** The local base against its upstream (spec §14.4), as the last fetch left it. */
export interface BaseUpstream {
  /** The upstream's remote-tracking name: "origin/main". */
  ref: string;
  /** Commits the upstream has that the local base doesn't. */
  behind: number;
  /** Commits the local base has that the upstream doesn't. */
  ahead: number;
}

/** Why the base can't be updated: both it and its upstream moved on (spec §14.4). */
export const divergedBaseText = (base: string, ref: string) =>
  `${base} and ${ref} have both moved on: update ${base} first`;

/**
 * What Merge does with the base first (spec §14.4): "main is 3 behind
 * origin/main; it's updated first", or why it can't; null when it is up to date.
 */
export function baseUpstreamText(base: string, u: BaseUpstream | null | undefined): string | null {
  if (!u || u.behind === 0) return null;
  if (u.ahead > 0) return divergedBaseText(base, u.ref);
  return `${base} is ${u.behind} behind ${u.ref}; it's updated first`;
}

/** Where a repository's base branch is checked out. */
export type BaseCheckout =
  /** In the project's main checkout; `dirty` when tracked files are changed there. */
  | { kind: 'main'; path: string; dirty: boolean }
  /** In another worktree: never touched. */
  | { kind: 'other'; path: string }
  /** Nowhere: the branch is moved with `git update-ref` alone. */
  | { kind: 'none' };

/** What one repository's merge depends on. */
export interface MergeFacts {
  name: string;
  branch: string;
  base: string;
  /** Uncommitted files in its worktree. */
  uncommitted: number;
  /** Its branch has commits of its own (spec §14.2). */
  hasOwnCommits: boolean;
  /** Its branch is merged into its base already. */
  merged: boolean;
  /**
   * The base (its upstream's tip when it is behind it) is contained in the
   * branch: a fast-forward is possible.
   */
  canFastForward: boolean;
  checkout: BaseCheckout;
  /** Where the branch is published ("origin", "origin (PR #12 open)"); null when it isn't. */
  published: string | null;
  /** The base against its fetched upstream; null without one (purely local). */
  baseUpstream: BaseUpstream | null;
}

/** How Claude brings a diverged branch up to the base: rebase, or merge the base in. */
export type DivergedMode = 'rebase' | 'merge';

/** What happens to one repository. */
export type MergeDecision =
  | { action: 'skip'; reason: string }
  | { action: 'refuse'; reason: string }
  | { action: 'fast-forward'; via: 'checkout' | 'ref' }
  | { action: 'ask'; published: string }
  | { action: 'claude'; mode: DivergedMode };

/**
 * The merge rules (spec §14.4). Nothing to merge is skipped; uncommitted
 * files, a main checkout with changed files, a base checked out in another
 * worktree and a base that diverged from its upstream are refused; a branch
 * that contains the base (once updated to its upstream) is fast-forwarded,
 * in the main checkout when the base is checked out there, else by ref; a
 * diverged branch goes to Claude, asking first when it is published, since a
 * rebase would then need a force-push.
 */
export function mergeDecision(f: MergeFacts, diverged: DivergedMode | null = null): MergeDecision {
  if (!f.hasOwnCommits) return { action: 'skip', reason: `${f.branch} has no commits of its own` };
  if (f.merged) return { action: 'skip', reason: `${f.branch} is already merged into ${f.base}` };
  if (f.uncommitted > 0) {
    return {
      action: 'refuse',
      reason: `${f.name} has ${f.uncommitted} uncommitted ${f.uncommitted === 1 ? 'file' : 'files'}: commit first`,
    };
  }
  if (f.checkout.kind === 'main' && f.checkout.dirty) {
    return {
      action: 'refuse',
      reason: `Your main checkout of ${f.name} (${f.checkout.path}) has uncommitted changes on ${f.base}: commit or stash them there first`,
    };
  }
  if (f.checkout.kind === 'other') {
    return {
      action: 'refuse',
      reason: `${f.base} is checked out in ${f.checkout.path}, which the app doesn't change: merge there yourself`,
    };
  }
  const u = f.baseUpstream;
  if (u && u.behind > 0 && u.ahead > 0) {
    return { action: 'refuse', reason: divergedBaseText(f.base, u.ref) };
  }
  if (f.canFastForward) {
    return { action: 'fast-forward', via: f.checkout.kind === 'main' ? 'checkout' : 'ref' };
  }
  if (f.published && !diverged) return { action: 'ask', published: f.published };
  return { action: 'claude', mode: diverged ?? 'rebase' };
}

/** Where a merge stands, per repository. */
export type MergeRepoPhase = 'merged' | 'waiting' | 'failed' | 'skipped';

export interface MergeRepoStatus {
  projectId: string;
  name: string;
  base: string;
  phase: MergeRepoPhase;
  /** Why it failed or was skipped. */
  reason: string | null;
  /** What happened to the base first: updated from its upstream, or its fetch failed. */
  note?: string | null;
}

/**
 * A workspace's merge (spec §14.4): `waiting` while Claude rebases, `done`
 * when every repository merged, `stopped` when one didn't (with why).
 */
export interface MergeStatus {
  workspaceId: string;
  phase: 'waiting' | 'done' | 'stopped';
  mode: DivergedMode;
  repos: MergeRepoStatus[];
}

/** What Merge did, for the button that started it. */
export type MergeResult =
  | { kind: 'merged' }
  | { kind: 'waiting' }
  /** A published branch: the user chooses how Claude brings it up to the base. */
  | { kind: 'ask'; branch: string; base: string; published: string }
  | { kind: 'stopped'; reason: string };

/** The line Claude ends its last message with (spec §14.4). */
export const READY_LINE = 'Ready to merge.';
export const NOT_READY_PREFIX = 'Not ready to merge:';

/** Claude's reason from its last message's "Not ready to merge: …" line, or null. */
export function notReadyReason(message: string | null): string | null {
  if (!message) return null;
  const lines = message
    .split('\n')
    .map((l) => l.trim().replace(/^[*_`>]+|[*_`]+$/g, ''))
    .filter(Boolean);
  const line = lines.reverse().find((l) => l.startsWith(NOT_READY_PREFIX));
  return line ? line.slice(NOT_READY_PREFIX.length).trim() || 'Claude said so' : null;
}

/** "Rebasing for merge…" / "Merging main in for merge…", and how far a linked workspace got. */
export function mergeProgressText(status: MergeStatus): string {
  const what = status.mode === 'rebase' ? 'Rebasing for merge…' : 'Merging the base in for merge…';
  const counted = status.repos.filter((r) => r.phase !== 'skipped');
  if (counted.length < 2) return what;
  const merged = counted.filter((r) => r.phase === 'merged').length;
  return `${what} · ${merged} of ${counted.length} merged`;
}

/** Why a merge stopped: "<reason>", or "Merged 1 of 2 · web: <reason>" in a linked workspace. */
export function mergeStoppedText(status: MergeStatus): string {
  const counted = status.repos.filter((r) => r.phase !== 'skipped');
  const failed = counted.filter((r) => r.phase === 'failed');
  const reasons = failed.map((r) => (counted.length > 1 ? `${r.name}: ${r.reason}` : r.reason));
  if (counted.length < 2) return reasons.join('; ');
  const merged = counted.filter((r) => r.phase === 'merged').length;
  return [`Merged ${merged} of ${counted.length}`, ...reasons].join(' · ');
}
