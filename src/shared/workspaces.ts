import type { WorkspaceState } from './status';
import type { Unfinished } from './unfinished';
import type { WorkflowInfo } from './workflow';

export interface WorkspaceTask {
  /** Optional task id, e.g. `PROJ-123`. */
  id: string | null;
  title: string;
  url: string | null;
}

/** A workspace as the UI sees it (spec §3.3; fields of later milestones come later). */
export interface Workspace {
  id: string;
  profileId: string;
  projectId: string;
  /** `<task id> <title>`, or whichever of the two is set. */
  name: string;
  task: WorkspaceTask;
  branch: string;
  baseBranch: string;
  /** Absolute path of the worktree. */
  worktreePath: string;
  /** Spec §10.2; hooks set it from M1. */
  state: WorkspaceState;
  /** Done while you weren't looking (M1). */
  unread: boolean;
  /** What it waits for, from the Notification hook (e.g. "Claude needs your permission to use Bash"). */
  stateMessage: string | null;
  /** When the state was entered; the sidebar shows elapsed Working time from it. */
  stateSince: string | null;
  /**
   * How many of Claude's background tasks still run (spec §10.2): Working while
   * it waits for agents, Done with a note when only commands are left running.
   */
  background: number;
  /** Claude didn't finish when the app stopped (spec §9.7); null otherwise. */
  unfinished: Unfinished | null;
  /** The last prompt sent to its Claude (UserPromptSubmit), for the overview (spec §9.7). */
  lastPrompt: string | null;
  /** Keep running: its Claude is never suspended when idle (spec §9.8). */
  keepRunning: boolean;
  /**
   * Let Claude add others when needed (spec §21.9): Claude is told about the
   * profile's other projects and may link one with the command line tool.
   */
  claudeMayLink: boolean;
  /** Claude Code's session id, from hook payloads; used for `--resume` (spec §9.4). */
  claudeSessionId: string | null;
  /** Its block of ports (spec §8.4); null until allocated. */
  ports: { base: number; count: number } | null;
  /** Its pull request as last checked (spec §12.3); null when none is known. */
  pr: PrStatus | null;
  /**
   * Every repository it spans, the main one first (spec §21.1). A workspace
   * without linked repositories has just the main one.
   */
  repos: WorkspaceRepo[];
  createdAt: string;
  lastActivityAt: string | null;
  /**
   * Its workflow status (spec §13.5), added by the main process for the UI;
   * null without a workflow, missing where it isn't added.
   */
  workflow?: WorkflowInfo | null;
}

/** One repository of a workspace (spec §21.1): its own worktree on the workspace's branch. */
export interface WorkspaceRepo {
  projectId: string;
  /** The main repository: where the workspace was created and Claude starts. */
  primary: boolean;
  worktreePath: string;
  /** That project's own base branch. */
  baseBranch: string;
  /** Its pull request as last checked; null when none is known. */
  pr: PrStatus | null;
  /** Its branch has commits of its own (as of the last PR check). */
  hasCommits: boolean;
  /** Its branch is contained in its base, as of the last check (spec §14.2); null when not. */
  merged: MergedInto | null;
  /** Why its setup failed; null when it passed or hasn't run. */
  setupError: string | null;
  /**
   * Who linked it from the command line (spec §21.9): Claude, or a workspace's
   * terminal; null for the main one and ones linked in the app.
   */
  addedBy?: RepoAddedBy | null;
  /**
   * Where its branch came from (spec §7.6): made for the workspace (`new`),
   * made from a remote branch that already existed (`remote`), or a local
   * branch that already existed (`local`).
   */
  branchOrigin?: BranchOrigin;
}

export type RepoAddedBy = 'claude' | 'terminal';

/** Where a workspace repository's branch came from (spec §7.6). */
export type BranchOrigin = 'new' | 'remote' | 'local';

/** The linked repositories, without the main one. */
export const linkedRepos = (w: Pick<Workspace, 'repos'>) => w.repos.filter((r) => !r.primary);

/** The repository of `projectId` in the workspace (the main one for null). */
export function workspaceRepo(
  w: Pick<Workspace, 'repos'>,
  projectId: string | null = null,
): WorkspaceRepo | null {
  return w.repos.find((r) => (projectId === null ? r.primary : r.projectId === projectId)) ?? null;
}

/**
 * Where a branch with commits of its own is merged (spec §14.2): `base` when
 * its tip, or every commit's change (`git cherry`), is in `<remote>/<base>`
 * (in the local base for a project without a remote); `local` when only the
 * local base has it, not pushed yet. `squash` and `squash-local` when its
 * commits aren't there but merging it would change nothing (`git merge-tree
 * --write-tree` gives the base's own tree), as after a squash merge.
 */
export type MergedInto = 'base' | 'local' | 'squash' | 'squash-local';

/** Whether only the local base has it, not pushed yet. */
export const mergedLocally = (into: MergedInto | null) =>
  into === 'local' || into === 'squash-local';

/** "Merged into main", "Merged into your local main (not pushed yet)", and the squash forms. */
export function mergedText(into: MergedInto, base: string): string {
  switch (into) {
    case 'base':
      return `Merged into ${base}`;
    case 'local':
      return `Merged into your local ${base} (not pushed yet)`;
    case 'squash':
      return `Merged into ${base} (its changes are already there, for example after a squash merge)`;
    case 'squash-local':
      return `Merged into your local ${base} (its changes are already there, not pushed yet)`;
  }
}

export const prMerged = (pr: PrStatus | null) =>
  pr?.state === 'merged' || pr?.state === 'likely-merged';

/**
 * Whether the workspace's work is merged (spec §21.5, §14.2): every
 * repository with commits of its own, or a known PR, has its PR merged or
 * likely merged, or its branch contained in its base. Null when none has
 * either; otherwise the main repository when it counts, else the first that
 * does.
 */
export function workspaceMerged(w: Pick<Workspace, 'repos'>): WorkspaceRepo | null {
  const counted = w.repos.filter((r) => r.hasCommits || r.pr);
  if (counted.length === 0) return null;
  if (!counted.every((r) => prMerged(r.pr) || r.merged)) return null;
  return counted.find((r) => r.primary) ?? counted[0] ?? null;
}

/**
 * A pull request's state (spec §12.3): from the PR status command, or from
 * git alone (`likely-merged`: the pushed branch was deleted on the remote;
 * `merged`: the branch is in the base).
 */
export interface PrStatus {
  state: 'open' | 'draft' | 'merged' | 'closed' | 'likely-merged';
  url: string | null;
  source: 'command' | 'git';
}

export const PR_LABEL: Record<PrStatus['state'], string> = {
  open: 'PR open',
  draft: 'PR draft',
  merged: 'Merged',
  closed: 'PR closed',
  'likely-merged': 'Likely merged',
};

/** What deleting one repository's worktree would lose (spec §14.2, §21.6). */
/**
 * A checked-out submodule with work that removing its worktree would lose
 * (spec §14.2): its own git folder lives in the worktree's, so it goes too.
 */
export interface SubmoduleWork {
  /** Its path in the worktree, nested ones as `lib/vendor`. */
  path: string;
  /** Its own `git status --porcelain` lines. */
  uncommitted: string[];
  /** Commits checked out or on its local branches that aren't on any of its remotes. */
  unpushed: number;
}

/**
 * Whether removing the worktree needs `--force` after "Delete anyway": it
 * has uncommitted changes, or a submodule has work of its own (spec §14.2).
 */
export const needsForce = (c: Pick<RepoDeleteCheck, 'uncommitted' | 'submodules'>) =>
  c.uncommitted.length > 0 || c.submodules.length > 0;

export interface RepoDeleteCheck {
  projectId: string;
  primary: boolean;
  worktreePath: string;
  /** `git status --porcelain` lines of the worktree; empty when clean. */
  uncommitted: string[];
  /** Commits on the branch that aren't on any remote (or, without remotes, on no other branch). */
  unpushed: number;
  /** Its checked-out submodules with work that removing the worktree would lose (spec §14.2). */
  submodules: SubmoduleWork[];
  /** The worktree folder is gone (deleted outside the app). */
  worktreeMissing: boolean;
  /** Its pull request is known to be open or a draft. */
  prOpen: boolean;
  /**
   * Its branch is merged (spec §14.2); `unpushed` is then 0, since its
   * commits are safe in the base.
   */
  merged: MergedInto | null;
  /** Where its branch came from (spec §7.6). */
  branchOrigin: BranchOrigin;
  /** The remote branch it tracks (`origin/feature-x`), kept by Delete; null without one. */
  upstream: string | null;
  /** Authors of the remote branch's commits other than you (spec §14.2), by name. */
  otherAuthors: string[];
}

/**
 * Whether Delete shows "Also delete the local branch" for a repository, and
 * whether it starts ticked (spec §14.2, §7.6): unticked when it has unpushed
 * commits, or when the local branch was there before the workspace; ticked
 * when the workspace made it from a remote branch with others' commits (the
 * remote one stays). Otherwise it isn't shown and the branch is deleted.
 */
export function branchChoice(check: RepoDeleteCheck): { shown: boolean; ticked: boolean } {
  if (check.unpushed > 0) return { shown: true, ticked: false };
  if (check.branchOrigin === 'local') return { shown: true, ticked: false };
  if (check.otherAuthors.length > 0) return { shown: true, ticked: true };
  return { shown: false, ticked: true };
}

/**
 * What deleting a workspace would lose or interrupt (spec §14.2). The
 * top-level fields are the main repository's; `repos` has every repository.
 */
export interface WorkspaceDeleteCheck {
  repos: RepoDeleteCheck[];
  /** `git status --porcelain` lines of the worktree; empty when clean. */
  uncommitted: string[];
  /** Commits on the branch that aren't on any remote (or, without remotes, on no other branch). */
  unpushed: number;
  /** The main worktree's submodules with work that would be lost. */
  submodules: SubmoduleWork[];
  /** Running sessions of the workspace. */
  running: number;
  /** The worktree folder is gone (deleted outside the app). */
  worktreeMissing: boolean;
  /** Its pull request is known to be open or a draft. */
  prOpen: boolean;
  /** The main repository's branch is merged (spec §14.2). */
  merged: MergedInto | null;
}

/** What removing a project would delete or stop (spec §14.3). */
export interface ProjectRemovalCheck {
  workspaces: { workspace: Workspace; check: WorkspaceDeleteCheck }[];
  /** Other projects' workspaces this project is linked into: only its worktree there goes (§21.6). */
  linked: { workspace: Workspace; check: RepoDeleteCheck }[];
  /** Running sessions of the project: its workspaces' and its main checkout's. */
  runningSessions: number;
}

/** What sets up and tears down a project's workspaces (spec §8.3). */
export interface SetupPlan {
  /** `repo`: the repository's own config file; `app`: kept in the app; null: none. */
  source: 'repo' | 'app' | null;
  setup: string[];
  teardown: string[];
  /** Ports per workspace (§8.4). */
  ports: number;
  setupTimeoutSec: number;
  teardownTimeoutSec: number;
  startClaude: 'after-setup' | 'parallel';
  /** Why the repository's file couldn't be used. */
  error: string | null;
  /**
   * With `repo`, the file used, relative to the repository: the old app's
   * name when only that exists (spec §3.5), which the Setup tab suggests renaming.
   */
  file?: string;
}

/** A workspace whose setup failed (spec §7.3): Retry, Start Claude anyway or Delete. */
export const SETUP_FAILED_PREFIX = 'Setup';
export const setupFailed = (w: Pick<Workspace, 'state' | 'stateMessage'>) =>
  w.state === 'error' && (w.stateMessage?.startsWith(SETUP_FAILED_PREFIX) ?? false);

/**
 * Shown where repositories get linked (spec §21.2, §21.4): Claude asks to
 * trust only the folder it starts in, not linked ones.
 */
export const LINK_TRUST_NOTE =
  "Claude loads this repository's CLAUDE.md and skills without asking; only link repositories you trust.";

/**
 * A git worktree of a project that no workspace uses (spec §13.6), with the
 * task prefilled from its status file or its branch.
 */
export interface OtherWorktree {
  path: string;
  /** Null on a detached HEAD: it can't be opened as a workspace. */
  branch: string | null;
  taskId: string | null;
  title: string;
  /** The title is the status file's title field (spec §13.5). */
  titleFromField: boolean;
}

/** Open as workspace (spec §13.6). */
export interface AdoptWorktreeInput {
  projectId: string;
  worktreePath: string;
  taskId: string | null;
  title: string;
  baseBranch: string;
  runSetup: boolean;
}
