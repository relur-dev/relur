/**
 * Merge all PRs (spec §21.10): every repository's pull request of a
 * workspace merged on its host, through the PR status and merge commands
 * (§12.3, §12.5), one after another in an order the user picks. Never a
 * local merge (that is Merge into the base, §14.4). These are the rules the
 * main process, the dialog and the command line tool share.
 */
import { envVar } from './brand';
import type { MergeMethod } from './schemas';

export const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: 'Squash',
  merge: 'Merge commit',
  rebase: 'Rebase',
};

/**
 * What the PR status command may add for Merge all PRs (spec §12.3): each
 * field is optional, `undefined` when the command didn't print it.
 */
export interface PrDetails {
  state: 'open' | 'draft' | 'merged' | 'closed';
  url: string | null;
  /** The branch the pull request merges into. */
  base?: string;
  /** The commit the host has as the pull request's head. */
  head?: string;
  /** The host lets it be merged now; null while the host is still working it out. */
  mergeable?: boolean | null;
  /** It conflicts with its base. */
  conflicts?: boolean;
  /** The checks that must pass before merging. */
  checks?: 'passed' | 'pending' | 'failed' | 'none';
  /** The reviews it needs. */
  reviews?: 'approved' | 'required' | 'changes-requested' | 'none';
  /** The merge methods the repository allows. */
  methods?: MergeMethod[];
  /** Why the host won't merge it, when nothing above says. */
  blockedReason?: string;
}

/** A repository's own state, read with git (spec §21.10). */
export interface LocalFacts {
  /** `git status --porcelain` lines of its worktree. */
  uncommitted: number;
  /** The branch its worktree has checked out; null on a detached HEAD. */
  checkedOut: string | null;
  /** `origin/feature-x`: the remote branch the pull request is from. */
  remoteRef: string;
  /** Why fetching that remote branch failed; null when it worked. */
  fetchError: string | null;
  /** The remote branch's commit; null when it isn't there. */
  remoteHead: string | null;
  /** Commits only the local branch has, and only the remote one has. */
  ahead: number;
  behind: number;
}

/** One repository's preflight (spec §21.10). */
export interface RepoPreflight {
  projectId: string;
  name: string;
  primary: boolean;
  branch: string;
  baseBranch: string;
  prUrl: string | null;
  /**
   * `ready` to merge, `merged` already (skipped when merging, so Merge all
   * PRs can go on after a stop), or `failed` with its problems.
   */
  result: 'ready' | 'merged' | 'failed';
  /** Why it can't be merged, in plain words; empty unless failed. */
  problems: string[];
  /** The methods its host allows; all three when the command doesn't say. */
  methods: MergeMethod[];
  /** The method it starts with (spec §21.10); null when none is allowed. */
  method: MergeMethod | null;
  /** The commit to merge: the remote branch's, checked against the PR's head. */
  head: string | null;
}

export interface MergePrsPreflight {
  workspaceId: string;
  repos: RepoPreflight[];
}

/** One repository's part of the report (spec §21.10). */
export interface RepoMergeResult {
  projectId: string;
  name: string;
  outcome: 'merged' | 'already-merged' | 'failed' | 'skipped';
  /** Why it failed. */
  reason: string | null;
  prUrl: string | null;
  method: MergeMethod | null;
  /** The merge commit and its link, when the merge command printed them. */
  commit: string | null;
  commitUrl: string | null;
  /** The remote branch was deleted (true), couldn't be (false), or wasn't asked to be (null). */
  branchDeleted: boolean | null;
  /** Why deleting the remote branch failed. */
  deleteError: string | null;
  /**
   * Merged, but not cleanly: the merge command failed after the host had
   * merged it (its status says merged), with the command's error.
   */
  warning: string | null;
}

export interface MergePrsReport {
  /** Every repository, in the order they were to be merged. */
  repos: RepoMergeResult[];
  /** The first failure stopped it. */
  stopped: boolean;
}

/** A Merge all PRs run of a workspace: while it merges, and its report afterwards. */
export interface MergePrsRun {
  workspaceId: string;
  running: boolean;
  /** The repository being merged now. */
  current: string | null;
  /** The order it merges in (project ids). */
  order: string[];
  /** Done so far, then the whole report. */
  report: MergePrsReport | null;
}

/** How long a merge asked for over the bridge waits for its confirmation in the app (spec §21.10). */
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A merge asked for over the bridge (`<slug> merge`), waiting for a click in
 * the app (spec §21.10): nothing merges without it. `expired` once the
 * command line stopped waiting, kept until the dialog is closed.
 */
export interface MergePrsConfirmation {
  id: string;
  workspaceId: string;
  /** The order and methods asked for; the dialog starts with them and may change them. */
  order: string[];
  methods: Record<string, MergeMethod>;
  deleteBranch: boolean;
  /** "Requested from the command line", with "by Claude in <workspace>" when Claude ran it. */
  requestedBy: string;
  expiresAt: string;
  state: 'pending' | 'expired';
}

/** Who asked for a bridge merge, as the dialog says it (spec §21.10). */
export const requestedByText = (byClaude: boolean, workspaceName: string) =>
  byClaude
    ? `Requested from the command line by Claude in ${workspaceName}`
    : 'Requested from the command line';

/** What Merge all PRs is asked to do. */
export interface MergePrsRequest {
  /** Project ids, in the order to merge; every repository of the workspace once. */
  order: string[];
  /** A method per project id; unset ones use their preflight's. */
  methods: Record<string, MergeMethod>;
  /** Delete each remote branch once its pull request is merged. */
  deleteBranch: boolean;
}

/**
 * The method a repository starts with (spec §21.10): its `pr.mergeMethod`
 * when the host allows it, else squash, else a merge commit, else rebase,
 * whichever the host allows first; null when it allows none.
 */
export function chooseMergeMethod(
  allowed: readonly MergeMethod[],
  preferred: MergeMethod | null | undefined,
): MergeMethod | null {
  if (preferred && allowed.includes(preferred)) return preferred;
  return MERGE_METHODS.find((m) => allowed.includes(m)) ?? null;
}

/** The host's allowed methods; every one when the status command doesn't say. */
export const allowedMethods = (pr: PrDetails | null): MergeMethod[] =>
  pr?.methods ? MERGE_METHODS.filter((m) => pr.methods?.includes(m)) : [...MERGE_METHODS];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a repository's local branch can't be merged yet (spec §21.10): its
 * worktree must be clean, on the workspace's branch, and level with the
 * remote branch the pull request is from.
 */
export function localProblems(branch: string, f: LocalFacts): string[] {
  const out: string[] = [];
  if (f.uncommitted > 0) {
    out.push(`${plural(f.uncommitted, 'uncommitted file')}: commit and push them first`);
  }
  if (f.checkedOut !== branch) {
    out.push(
      f.checkedOut
        ? `Its worktree is on ${f.checkedOut}, not ${branch}`
        : `Its worktree is on a detached HEAD, not ${branch}`,
    );
  }
  if (f.fetchError) {
    out.push(`Couldn't fetch ${f.remoteRef}: ${f.fetchError}`);
    return out;
  }
  if (!f.remoteHead) {
    out.push(`${branch} isn't on the remote (${f.remoteRef}): push it first`);
    return out;
  }
  if (f.ahead > 0 && f.behind > 0) {
    out.push(
      `${branch} and ${f.remoteRef} have both moved on: merge ${f.remoteRef} into it and push`,
    );
  } else if (f.ahead > 0) {
    out.push(`${plural(f.ahead, 'commit')} not pushed: push first`);
  } else if (f.behind > 0) {
    out.push(`${f.remoteRef} has ${plural(f.behind, 'commit')} this worktree doesn't: pull first`);
  }
  return out;
}

/**
 * Why a pull request can't be merged yet (spec §21.10), from the PR status
 * command's answer: it must be open, not a draft, into the expected base, at
 * the pushed commit, and mergeable by the host's own rules. Checks still
 * running, failed checks and missing reviews are named when the command
 * reports them; a host that says no without a reason says so.
 */
export function prProblems(pr: PrDetails, expectedBase: string, remoteHead: string | null) {
  const out: string[] = [];
  if (pr.state === 'closed') return ['Its pull request is closed'];
  if (pr.state === 'draft') out.push('Its pull request is a draft: mark it ready for review');
  if (pr.base === undefined) {
    out.push("The PR status command doesn't say which branch it merges into (base)");
  } else if (pr.base !== expectedBase) {
    out.push(`Its pull request merges into ${pr.base}, not ${expectedBase}`);
  }
  if (pr.head && remoteHead && pr.head !== remoteHead) {
    out.push("The pull request isn't at the pushed commit yet: check again in a moment");
  }
  if (pr.conflicts) out.push(`It has conflicts with ${pr.base ?? expectedBase}`);
  if (pr.checks === 'pending') out.push('Checks running: check again when they finish');
  if (pr.checks === 'failed') out.push('Checks failed');
  if (pr.reviews === 'changes-requested') out.push('A reviewer requested changes');
  if (pr.reviews === 'required') out.push('It needs an approving review');
  if (pr.mergeable === undefined) {
    out.push("The PR status command doesn't say whether it can be merged (mergeable)");
  } else if (pr.mergeable === null) {
    if (out.length === 0)
      out.push('The host is still working out whether it can be merged: check again');
  } else if (!pr.mergeable && out.length === 0) {
    out.push(pr.blockedReason ?? "The host won't merge it yet");
  }
  return out;
}

/**
 * Parses the PR status command's extra fields (spec §12.3) on top of its
 * state and URL; fields of the wrong type are left out.
 */
export function prDetails(
  value: Record<string, unknown>,
  state: PrDetails['state'],
  url: string | null,
): PrDetails {
  const pr: PrDetails = { state, url };
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  if (str(value.base)) pr.base = str(value.base);
  if (str(value.head)) pr.head = str(value.head);
  if (typeof value.mergeable === 'boolean' || value.mergeable === null) {
    pr.mergeable = value.mergeable;
  }
  if (typeof value.conflicts === 'boolean') pr.conflicts = value.conflicts;
  if (['passed', 'pending', 'failed', 'none'].includes(value.checks as string)) {
    pr.checks = value.checks as PrDetails['checks'];
  }
  if (['approved', 'required', 'changes-requested', 'none'].includes(value.reviews as string)) {
    pr.reviews = value.reviews as PrDetails['reviews'];
  }
  if (Array.isArray(value.methods)) {
    pr.methods = MERGE_METHODS.filter((m) => (value.methods as unknown[]).includes(m));
  }
  if (str(value.blockedReason)) pr.blockedReason = str(value.blockedReason);
  return pr;
}

/** The merge command's optional answer (spec §12.5): the merge commit and its link. */
export function parseMergeOutput(output: string): {
  commit: string | null;
  commitUrl: string | null;
} {
  const none = { commit: null, commitUrl: null };
  const text = output.trim().split('\n').at(-1)?.trim() ?? '';
  if (!text.startsWith('{')) return none;
  try {
    const v = JSON.parse(text) as { commit?: unknown; commitUrl?: unknown };
    return {
      commit: typeof v.commit === 'string' && v.commit ? v.commit : null,
      commitUrl: typeof v.commitUrl === 'string' && v.commitUrl ? v.commitUrl : null,
    };
  } catch {
    return none;
  }
}

/**
 * The order rows start in (spec §21.10): the primary first, then the linked
 * repositories in the order they were linked (the workspace's own order).
 */
export const defaultOrder = (repos: { projectId: string; primary: boolean }[]) => [
  ...repos.filter((r) => r.primary).map((r) => r.projectId),
  ...repos.filter((r) => !r.primary).map((r) => r.projectId),
];

/**
 * Why the header's Merge all PRs is disabled (spec §21.10), or null when it
 * isn't: every repository needs a pull request known to be open (a draft
 * counts; the preflight names it), or merged already, with one left to merge.
 */
export function mergeAllPrsBlocked(
  repos: { name: string; pr: { state: string } | null }[],
): string | null {
  const withoutPr = repos.filter((r) => !r.pr).map((r) => r.name);
  if (withoutPr.length > 0) return `No pull request known in ${withoutPr.join(', ')}`;
  const closed = repos.filter((r) => r.pr?.state === 'closed').map((r) => r.name);
  if (closed.length > 0) return `Its pull request is closed in ${closed.join(', ')}`;
  const open = repos.filter((r) => r.pr?.state === 'open' || r.pr?.state === 'draft');
  if (open.length === 0) return 'Every pull request is merged';
  return null;
}

/** Merge can go ahead: nothing failed and something is left to merge. */
export const canMerge = (p: Pick<RepoPreflight, 'result'>[]) =>
  p.length > 0 && p.every((r) => r.result !== 'failed') && p.some((r) => r.result === 'ready');

/**
 * Checks a request against the workspace's repositories: every one once,
 * known methods. Returns why it is refused, or null.
 */
export function orderProblem(order: string[], projectIds: string[]): string | null {
  const known = new Set(projectIds);
  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length > 0) return `Not in this workspace: ${unknown.join(', ')}`;
  if (new Set(order).size !== order.length) return 'A repository is listed twice';
  const missing = projectIds.filter((id) => !order.includes(id));
  if (missing.length > 0) return `The order leaves out ${missing.join(', ')}`;
  return null;
}

/**
 * Runs the merges one after another (spec §21.10): each repository is
 * checked again just before, then merged; the first failure stops it, and
 * every repository after it is skipped. Nothing already merged is undone.
 */
export async function runMerges<R extends { projectId: string; name: string }>(
  repos: R[],
  steps: {
    /** The repository's fresh preflight just before merging it. */
    check: (repo: R) => Promise<RepoPreflight>;
    merge: (
      repo: R,
      check: RepoPreflight,
    ) => Promise<
      Pick<
        RepoMergeResult,
        'commit' | 'commitUrl' | 'branchDeleted' | 'deleteError' | 'method' | 'warning'
      >
    >;
    /** After each repository, with the report so far. */
    progress?: (report: MergePrsReport, current: string | null) => void;
  },
): Promise<MergePrsReport> {
  const results: RepoMergeResult[] = [];
  let stopped = false;
  const base = (r: R, prUrl: string | null): RepoMergeResult => ({
    projectId: r.projectId,
    name: r.name,
    outcome: 'skipped',
    reason: null,
    prUrl,
    method: null,
    commit: null,
    commitUrl: null,
    branchDeleted: null,
    deleteError: null,
    warning: null,
  });
  for (const repo of repos) {
    if (stopped) {
      results.push(base(repo, null));
      continue;
    }
    steps.progress?.({ repos: [...results], stopped }, repo.projectId);
    let check: RepoPreflight;
    try {
      check = await steps.check(repo);
    } catch (error) {
      results.push({ ...base(repo, null), outcome: 'failed', reason: message(error) });
      stopped = true;
      continue;
    }
    if (check.result === 'merged') {
      results.push({ ...base(repo, check.prUrl), outcome: 'already-merged' });
      continue;
    }
    if (check.result === 'failed') {
      results.push({
        ...base(repo, check.prUrl),
        outcome: 'failed',
        reason: check.problems.join('; '),
      });
      stopped = true;
      continue;
    }
    try {
      const done = await steps.merge(repo, check);
      results.push({ ...base(repo, check.prUrl), ...done, outcome: 'merged' });
    } catch (error) {
      results.push({ ...base(repo, check.prUrl), outcome: 'failed', reason: message(error) });
      stopped = true;
    }
  }
  const report = { repos: results, stopped };
  steps.progress?.(report, null);
  return report;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The report's headline (spec §21.10): "Merged 3 pull requests", or
 * "Merge stopped at web: <reason>" with what merged and what was skipped.
 */
export function reportSummary(report: MergePrsReport): string {
  const merged = report.repos.filter((r) => r.outcome === 'merged').length;
  const skipped = report.repos.filter((r) => r.outcome === 'skipped').length;
  const failed = report.repos.find((r) => r.outcome === 'failed');
  if (!failed) {
    return merged === 0
      ? 'Nothing to merge: every pull request was merged already'
      : `Merged ${plural(merged, 'pull request')}`;
  }
  const parts = [`Merge stopped at ${failed.name}: ${failed.reason ?? 'it failed'}`];
  parts.push(`${merged} merged`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(' · ');
}

/** Said before confirming (spec §21.10): partial merges can't be undone. */
export const NO_UNDO_TEXT =
  'Pull requests are merged one at a time, in this order. If one fails, the rest are skipped, and the ones already merged stay merged: nothing is undone.';

/**
 * The GitHub CLI preset (spec §12.6): a status command that adds the fields
 * Merge all PRs needs, and a merge command. Both need `gh` and `jq`.
 */
export function githubPreset(): { statusCommand: string; mergeCommand: string } {
  const branch = `"$${envVar('BRANCH')}"`;
  const jq = [
    '($p.statusCheckRollup // []) as $c',
    '| ($p.mergeStateStatus | IN("CLEAN","HAS_HOOKS","UNSTABLE")) as $ok',
    '| {state: (if $p.isDraft then "draft" else ($p.state | ascii_downcase) end),',
    'url: $p.url, title: $p.title, base: $p.baseRefName, head: $p.headRefOid,',
    'conflicts: ($p.mergeable == "CONFLICTING"),',
    'mergeable: (if $p.mergeStateStatus == "UNKNOWN" then null else $ok end),',
    'checks: (if $ok then "passed"',
    'elif ($c | any((.conclusion // "") | IN("FAILURE","TIMED_OUT","CANCELLED","ACTION_REQUIRED","STARTUP_FAILURE")) or any((.state // "") | IN("FAILURE","ERROR"))) then "failed"',
    'elif ($c | any(((.status // "COMPLETED") != "COMPLETED") or ((.state // "") | IN("PENDING","EXPECTED")))) then "pending"',
    'elif ($c | length) > 0 then "passed" else "none" end),',
    'reviews: ({"APPROVED":"approved","REVIEW_REQUIRED":"required","CHANGES_REQUESTED":"changes-requested"}[$p.reviewDecision // ""] // "none"),',
    'methods: [(if $r.squashMergeAllowed then "squash" else empty end), (if $r.mergeCommitAllowed then "merge" else empty end), (if $r.rebaseMergeAllowed then "rebase" else empty end)]}',
    '| if $p.mergeStateStatus == "BEHIND" then .blockedReason = "Its branch is behind \\($p.baseRefName), and the repository requires it to be up to date" else . end',
  ].join(' ');
  const statusCommand = [
    `p=$(gh pr view ${branch} --json state,isDraft,url,title,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup 2>&1)`,
    `|| { case "$p" in *"no pull requests found"*) exit 0 ;; *) echo "$p" >&2; exit 1 ;; esac; }`,
    `&& r=$(gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed)`,
    `&& jq -n --argjson p "$p" --argjson r "$r" '${jq}'`,
  ].join(' ');
  const mergeCommand = [
    `gh pr merge ${branch} "--$${envVar('MERGE_METHOD')}" --match-head-commit "$${envVar('PR_HEAD')}" >&2`,
    `&& gh pr view ${branch} --json url,mergeCommit --jq '{url, commit: .mergeCommit.oid} | if .commit then .commitUrl = ((.url | sub("/pull/[0-9]+$"; "")) + "/commit/" + .commit) else . end'`,
  ].join(' ');
  return { statusCommand, mergeCommand };
}
