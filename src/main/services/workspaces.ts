import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { numberedBranch, validBranchName } from '@shared/branch';
import { BRAND } from '@shared/brand';
import { projectWorktreeDir, WORKTREES_DIR } from '@shared/projects';
import { DEFAULT_PORT_RANGE, type Profile, type Project } from '@shared/schemas';
import { NEW_CONVERSATION_NOTE } from '@shared/suspend';
import { parseTask } from '@shared/tasks';
import type { SessionInfo } from '@shared/terminal-protocol';
import {
  type AdoptWorktreeInput,
  linkedRepos,
  type OtherWorktree,
  type ProjectRemovalCheck,
  type RepoAddedBy,
  type RepoDeleteCheck,
  SETUP_FAILED_PREFIX,
  type SetupPlan,
  setupFailed,
  type Workspace,
  type WorkspaceDeleteCheck,
  type WorkspaceRepo,
  type WorkspaceTask,
  workspaceRepo,
} from '@shared/workspaces';
import { type AppLog, PhaseTimer } from '../app-log';
import { refreshMerged } from '../changes/finish';
import { baseRef } from '../changes/service';
import type { ConfigStore } from '../config/store';
import type { WorkspaceRecords } from '../db/workspaces';
import type { EnvService } from '../env/service';
import { type Git, gitReason } from '../git/git';
import { expandHome } from '../paths';
import { copyIncludedFiles } from '../worktrees/include';
import { RemoteAnswers } from '../worktrees/remote-answers';
import {
  allocatePorts,
  type CommandResult,
  commandScript,
  runCommands,
  setupPlan,
} from '../worktrees/setup';
import type { TerminalService } from './terminals';

export interface CreateWorkspaceInput {
  projectId: string;
  taskId: string | null;
  title: string;
  branch: string;
  baseBranch: string;
  /** Run setup before Claude starts (spec §8.3); on unless unticked. */
  runSetup?: boolean;
  /** Other projects of the profile the workspace also spans (spec §21.2). */
  linkedProjectIds?: string[];
  /** Let Claude add others when needed (spec §21.9); on unless unticked. */
  claudeMayLink?: boolean;
  /**
   * The branch came from the task, not typed: when it is taken, here or on a
   * remote, the next free name (`-2`, `-3` …) is used instead (spec §7.1).
   */
  uniqueBranch?: boolean;
}

/** A repository's remote branches, why the remote couldn't be asked, or null without one. */
/**
 * What a remote answered (spec §7.3): its branches and whether the base was
 * fetched (null, or why not), or why it couldn't be asked; null without a remote.
 */
type RemoteHeads = { heads: Set<string>; fetchError?: string | null } | { error: string } | null;

/** How deleting treats one repository's worktree and branch (spec §14.2). */
export interface RepoDeleteChoice {
  force: boolean;
  deleteBranch: boolean;
}

/** What Link another repository started (spec §21.4). */
export interface LinkResult {
  workspace: Workspace;
  /** Its Setup tab, when it has setup commands. */
  setup: SessionInfo | null;
  /** The restarted Claude, when it restarted right away. */
  claude: SessionInfo | null;
  /** A base that came from the local branch (spec §7.3), for the notice. */
  notes: string[];
  /** The line to paste into Claude with Link only. */
  addDirLine: string;
}

/** What Create started (spec §7.3). */
export interface CreateResult {
  workspace: Workspace;
  claude: SessionInfo | null;
  claudeError: string | null;
  /** The first Setup tab, when setup runs. */
  setup: SessionInfo | null;
  /** What went differently, for the notice (spec §7.3): a renamed branch, a local base. */
  notes: string[];
}

/**
 * The workspace's message when setup failed (spec §8.3, §21.3): as before
 * for a single repository, naming the repositories for a linked workspace.
 * `detail` is `exit n`, `timed out after n s`, or why the plan couldn't be read.
 */
export function setupFailureMessage(
  failures: { name: string; detail: string }[],
  linked: boolean,
): string {
  const P = SETUP_FAILED_PREFIX;
  if (!linked) {
    const detail = failures[0]?.detail ?? '';
    if (detail.startsWith('timed out')) return `${P} ${detail}`;
    if (/^exit /.test(detail)) return `${P} failed (${detail})`;
    return `${P} failed: ${detail}`;
  }
  return `${P} failed in ${failures.map((f) => `${f.name} (${f.detail})`).join(', ')}`;
}

/** A failed step of creating a workspace, named as the user sees it (spec §7.3). */
class StepError extends Error {
  constructor(step: string, cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new StepError(name, error);
  }
}

/** The task file, `<repo dir>/task.md` (spec §7.4). */
/** The real path, or the path itself when it doesn't exist. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whether `child` is `parent` or inside it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function taskFile(task: WorkspaceTask): string {
  const front = [task.id ? `id: ${task.id}` : null, task.url ? `url: ${task.url}` : null].filter(
    Boolean,
  );
  const header = front.length > 0 ? `---\n${front.join('\n')}\n---\n` : '';
  return `${header}# ${task.title || task.id}\n`;
}

/** Creating, opening and deleting workspaces (spec §7, §14.2, §21). */
export class WorkspaceService {
  /**
   * The task an adopted worktree's status file names (spec §13.6), or null;
   * set by the app from the workflow.
   */
  adoptPrefill:
    | ((
        projectId: string,
        worktreePath: string,
        branch: string,
      ) => {
        taskId: string | null;
        title: string | null;
        /** The title is the file's title field, not its heading. */
        titleFromField: boolean;
      } | null)
    | null = null;
  /** Worktree folders being created right now, so they aren't offered for adoption. */
  readonly creating = new Set<string>();

  /** The project's filled-in Start prompt for a workspace (spec §13.5); set by the app. */
  startPrompt: ((workspace: Workspace) => string | null) | null = null;

  /** Whether the profile suspends idle sessions, so they start suspended (spec §9.8); set by the app. */
  suspendAtStart: ((profileId: string) => boolean) | null = null;

  /** What a resumed Claude gets back: its permission mode and model (spec §9.8); set by the app. */
  restoreArgs: ((sessionId: string) => string[]) | null = null;

  /** What happens once every running setup of a workspace has finished (spec §21.3). */
  private readonly afterSetup = new Map<string, { start: boolean; restart: boolean }>();

  /** Each remote's branches and fetched base, asked once for New workspace and Create (spec §7.3). */
  private readonly remoteAnswers = new RemoteAnswers();

  /** Where Create's phases are timed (spec §3.4); set by the app. */
  log: AppLog | null = null;
  /**
   * The timers of workspaces just created, until their Claude's session has
   * started: setup and Claude's start come after Create returns.
   */
  private readonly timings = new Map<string, { timer: PhaseTimer; claudeAt: number | null }>();

  constructor(
    private readonly config: ConfigStore,
    private readonly env: EnvService,
    private readonly records: WorkspaceRecords,
    private readonly terminals: TerminalService,
    /** The `--settings` file for a profile's Claude (spec §9.3, §21.9). */
    private readonly settingsFile: (profileId: string) => string,
  ) {
    // An unmarked state still saying Claude was at work means the app crashed
    // (spec §9.7): a quit marks those itself.
    records.markUnfinishedAfterCrash();
    // No Claude runs yet at launch; StatusService follows states from here (spec §10.2).
    records.resetRunningStates();
  }

  /**
   * Why `branch` can't be used for a new workspace in the project and the
   * projects linked with it, or null (spec §21.2). Local checks only.
   */
  async branchProblem(
    projectId: string,
    branch: string,
    linkedProjectIds: string[] = [],
  ): Promise<string | null> {
    if (!branch.trim()) return 'Enter a branch name';
    const { project, git } = await this.context(projectId);
    if (!(await git.isValidBranchName(expandHome(project.repoPath), branch)))
      return `"${branch}" isn't a valid branch name`;
    const projects = [project, ...linkedProjectIds.map((id) => this.linkable(project, id))];
    const several = projects.length > 1;
    for (const p of projects) {
      const repo = expandHome(p.repoPath);
      const where = several ? ` in ${p.name}` : '';
      if (await git.localBranchExists(repo, branch))
        return `A branch named ${branch} already exists${where}`;
      if (p.remote && (await git.trackingBranchExists(repo, p.remote, branch))) {
        return `${p.remote}${several ? ` of ${p.name}` : ''} already has a branch named ${branch}`;
      }
    }
    return null;
  }

  /**
   * branchProblem with a name to use instead (spec §7.1): what git refuses
   * replaced, then the next free name (`-2`, `-3` …). Local checks only.
   */
  async branchCheck(
    projectId: string,
    branch: string,
    linkedProjectIds: string[] = [],
  ): Promise<{ problem: string | null; suggestion: string | null }> {
    const problem = await this.branchProblem(projectId, branch, linkedProjectIds);
    const valid = validBranchName(branch.trim());
    if (!problem || !valid) return { problem, suggestion: null };
    const { project, profile, git } = await this.context(projectId);
    const projects = [project, ...linkedProjectIds.map((id) => this.linkable(project, id))];
    const free = await this.freeBranch(
      git,
      profile,
      projects.map((p) => ({ project: p, remote: null })),
      valid,
    );
    return { problem, suggestion: free === branch.trim() ? null : free };
  }

  /** Branches to offer as the base: the remote's, or local ones without a remote. */
  async baseBranches(projectId: string): Promise<string[]> {
    const { project, git } = await this.context(projectId);
    const repo = expandHome(project.repoPath);
    return project.remote ? git.remoteBranches(repo, project.remote) : git.localBranches(repo);
  }

  /**
   * Spec §7.3, per repository (§21.2): fetch the base, add the worktree and
   * branch, copy the .worktreeinclude files, write the task file; then save
   * the record and start setup or Claude. A failure before the record is
   * saved removes every worktree and branch created so far.
   */
  async create(input: CreateWorkspaceInput): Promise<CreateResult> {
    const timer = new PhaseTimer(this.log, `create ${input.branch.trim()} in ${input.projectId}`);
    try {
      const result = await this.createTimed(input, timer);
      timer.total('Create done');
      return result;
    } catch (error) {
      timer.total(`Create failed (${error instanceof Error ? error.message : String(error)})`);
      throw error;
    }
  }

  private async createTimed(input: CreateWorkspaceInput, timer: PhaseTimer): Promise<CreateResult> {
    const { project, profile, git } = await timer.time('environment', () =>
      this.context(input.projectId),
    );
    const wanted = input.uniqueBranch ? validBranchName(input.branch.trim()) : input.branch.trim();
    const base = input.baseBranch.trim();
    const title = input.title.trim();
    if (!title && !input.taskId?.trim()) throw new Error('Enter a task');
    if (!base) throw new Error('Enter a base branch');
    const linkedIds = [...new Set(input.linkedProjectIds ?? [])].filter((id) => id !== project.id);
    if (!input.uniqueBranch) {
      const problem = await timer.time('branch check', () =>
        this.branchProblem(project.id, wanted, linkedIds),
      );
      if (problem) throw new Error(problem);
    } else if (!wanted) {
      throw new Error('Enter a branch name');
    }
    const projects = [project, ...linkedIds.map((id) => this.linkable(project, id))];
    // Spec §7.3: each remote is asked once, for the branch and the base, while
    // its base is fetched; New workspace may have asked already.
    const remoteTargets = await Promise.all(
      projects.map(async (p, i) => ({
        project: p,
        remote: await this.askRemote(git, p, i === 0 ? base : this.projectBase(profile, p), timer),
      })),
    );
    const notes: string[] = [];
    let branch = wanted;
    if (input.uniqueBranch) {
      branch = await timer.time('free branch name', () =>
        this.freeBranch(git, profile, remoteTargets, wanted),
      );
      if (branch !== wanted) notes.push(`${wanted} already exists; the branch is ${branch}`);
    } else {
      for (const { project: p, remote } of remoteTargets) {
        if (remote && 'heads' in remote && remote.heads.has(branch)) {
          const free = await this.freeBranch(git, profile, remoteTargets, branch);
          throw new Error(
            `${p.remote}${projects.length > 1 ? ` of ${p.name}` : ''} already has a branch named ${branch}; ${free} is free`,
          );
        }
      }
    }
    const targets = remoteTargets.map((t, i) => ({
      project: t.project,
      remote: t.remote,
      base: i === 0 ? base : this.projectBase(profile, t.project),
    }));
    const paths = targets.map((t) =>
      path.join(expandHome(projectWorktreeDir(profile, t.project)), branch),
    );
    for (const p of paths) if (fs.existsSync(p)) throw new Error(`${p} already exists`);

    const task: WorkspaceTask = { id: input.taskId?.trim() || null, title, url: null };
    const created: { repo: string; worktreePath: string }[] = [];
    const several = targets.length > 1;
    for (const p of paths) this.creating.add(path.resolve(p));
    try {
      for (const [index, target] of targets.entries()) {
        const worktreePath = paths[index] as string;
        const note = await this.addRepoWorktree(
          git,
          target.project,
          target.remote,
          worktreePath,
          branch,
          target.base,
          task,
          {
            named: several,
            timer,
            onCreated: () =>
              created.push({ repo: expandHome(target.project.repoPath), worktreePath }),
          },
        );
        if (note) notes.push(note);
      }
    } catch (error) {
      await this.removeCreated(git, created, branch);
      for (const p of paths) this.creating.delete(path.resolve(p));
      throw error;
    }

    // The repositories' setup files as of the new branch (spec §8.3).
    const plans = targets.map((t, i) => ({
      projectId: t.project.id,
      name: t.project.name,
      plan: setupPlan(t.project, paths[i] as string),
    }));
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      profileId: profile.id,
      projectId: project.id,
      name: [task.id, task.title].filter(Boolean).join(' '),
      task,
      branch,
      baseBranch: base,
      worktreePath: paths[0] as string,
      state: 'starting',
      unread: false,
      stateMessage: null,
      background: 0,
      unfinished: null,
      lastPrompt: null,
      keepRunning: false,
      claudeMayLink: input.claudeMayLink !== false,
      stateSince: now,
      claudeSessionId: null,
      ports: null,
      pr: null,
      repos: targets.map((t, i) => ({
        projectId: t.project.id,
        primary: i === 0,
        worktreePath: paths[i] as string,
        baseBranch: t.base,
        pr: null,
        hasCommits: false,
        merged: null,
        setupError: null,
      })),
      createdAt: now,
      lastActivityAt: now,
    };
    const recording = performance.now();
    try {
      // One block for the workspace, as large as any repository asks for (spec §21.2).
      workspace.ports = await step('Allocating ports', async () =>
        allocatePorts(
          Math.max(...plans.map((p) => p.plan.ports)),
          this.portRange(),
          this.records.portBlocks(),
        ),
      );
      this.records.insert(workspace);
      for (const p of paths) this.creating.delete(path.resolve(p));
      // Spec §13.5: the project's Start prompt goes out at Claude's first start.
      this.records.setStartPromptPending(workspace.id, true);
      // Spec §13.5: without a title, the status file's title field gives one.
      if (!workspace.task.title) this.records.setTitleFromStatusPending(workspace.id, true);
      for (const repo of workspace.repos) {
        const start = await git.revParse(repo.worktreePath, 'HEAD');
        if (start) this.records.setStartCommit(workspace.id, start, repo.projectId);
      }
      timer.since('ports and records', recording);
    } catch (error) {
      await this.removeCreated(git, created, branch);
      for (const p of paths) this.creating.delete(path.resolve(p));
      throw error;
    }

    // The workspace exists now; a setup or Claude that fails is reported, not undone.
    const unreadable = plans.filter((p) => p.plan.error);
    if (unreadable.length > 0) {
      for (const p of unreadable) {
        this.records.setSetupError(workspace.id, p.projectId, p.plan.error);
      }
      this.records.setState(workspace.id, 'error', {
        message: setupFailureMessage(
          unreadable.map((p) => ({ name: p.name, detail: p.plan.error as string })),
          several,
        ),
      });
      return {
        workspace: this.workspace(workspace.id),
        claude: null,
        claudeError: null,
        setup: null,
        notes,
      };
    }
    this.timings.set(workspace.id, { timer, claudeAt: null });
    const withSetup = plans.filter((p) => p.plan.setup.length > 0);
    // The main repository's plan says whether Claude waits for setup.
    const mainPlan = (plans[0] as (typeof plans)[number]).plan;
    if (input.runSetup !== false && withSetup.length > 0) {
      const afterSetup = mainPlan.startClaude === 'after-setup';
      const sessions = await timer.time('setup started', () =>
        this.startSetups(workspace, withSetup, { start: afterSetup, restart: false }),
      );
      const setup = sessions[0] ?? null;
      if (afterSetup) return { workspace, claude: null, claudeError: null, setup, notes };
      return { ...(await this.launchClaude(workspace)), setup, notes };
    }
    return { ...(await this.launchClaude(workspace)), setup: null, notes };
  }

  /**
   * The project's git worktrees that no workspace uses (spec §13.6): not the
   * main checkout, not any workspace's main or linked worktree, not bare or
   * prunable ones, and none being created now.
   */
  async otherWorktrees(projectId: string): Promise<OtherWorktree[]> {
    const { project, git } = await this.context(projectId);
    const known = new Set(
      this.records
        .list()
        .flatMap((w) => w.repos.map((r) => realpathOr(r.worktreePath)))
        .concat([...this.creating].map(realpathOr)),
    );
    const main = realpathOr(expandHome(project.repoPath));
    return (await git.listWorktrees(main))
      .filter((w) => !w.bare && !w.prunable)
      .filter((w) => realpathOr(w.path) !== main && !known.has(realpathOr(w.path)))
      .map((w) => {
        const fromFile = w.branch ? this.adoptPrefill?.(projectId, w.path, w.branch) : null;
        const fromBranch = parseTask(w.branch ?? path.basename(w.path));
        return {
          path: w.path,
          branch: w.branch,
          taskId: fromFile?.taskId ?? fromBranch.id,
          title: fromFile?.title ?? fromBranch.title.replace(/[-_]+/g, ' ').trim(),
          titleFromField: fromFile?.titleFromField ?? false,
        };
      });
  }

  /**
   * Open as workspace (spec §13.6): records an existing worktree as a
   * workspace of the project, with a port block and its merge base as start
   * commit. Nothing is copied or written into it; setup runs only when asked,
   * and Claude doesn't start by itself.
   */
  async adopt(input: AdoptWorktreeInput): Promise<Workspace> {
    const { project, profile, git } = await this.context(input.projectId);
    const offered = (await this.otherWorktrees(project.id)).find(
      (w) => realpathOr(w.path) === realpathOr(input.worktreePath),
    );
    if (!offered)
      throw new Error(
        `${input.worktreePath} isn't a worktree of ${project.name} that can be opened`,
      );
    if (!offered.branch) throw new Error('Detached HEAD: check out a branch in it first');
    const title = input.title.trim();
    const taskId = input.taskId?.trim() || null;
    if (!title && !taskId) throw new Error('Enter a task');
    const base = input.baseBranch.trim() || this.projectBase(profile, project);
    const task: WorkspaceTask = { id: taskId, title, url: null };
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: `ws_${randomUUID()}`,
      profileId: profile.id,
      projectId: project.id,
      name: [task.id, task.title].filter(Boolean).join(' '),
      task,
      branch: offered.branch,
      baseBranch: base,
      worktreePath: offered.path,
      state: 'exited',
      unread: false,
      stateMessage: null,
      background: 0,
      unfinished: null,
      lastPrompt: null,
      keepRunning: false,
      claudeMayLink: true,
      stateSince: now,
      claudeSessionId: null,
      ports: await allocatePorts(
        setupPlan(project, offered.path).ports,
        this.portRange(),
        this.records.portBlocks(),
      ),
      pr: null,
      repos: [
        {
          projectId: project.id,
          primary: true,
          worktreePath: offered.path,
          baseBranch: base,
          pr: null,
          hasCommits: false,
          merged: null,
          setupError: null,
        },
      ],
      createdAt: now,
      lastActivityAt: now,
    };
    this.records.insert(workspace);
    // Spec §13.5: the status file's title field, once it has one, names the
    // task, unless it already did or the user typed their own.
    if (!offered.titleFromField && title === offered.title) {
      this.records.setTitleFromStatusPending(workspace.id, true);
    }
    const start = await git.mergeBase(
      offered.path,
      'HEAD',
      await baseRef(git, project, { worktreePath: offered.path, baseBranch: base }),
    );
    if (start) this.records.setStartCommit(workspace.id, start);
    const plan = setupPlan(project, offered.path);
    if (input.runSetup && plan.setup.length > 0 && !plan.error) {
      await this.startSetups(workspace, [{ projectId: project.id, plan }], {
        start: false,
        restart: false,
      });
    }
    return this.workspace(workspace.id);
  }

  /**
   * Asks each remote of New workspace's projects for its branches and fetches
   * its base (spec §7.3), without waiting: Create reuses the answers.
   */
  async prepareRemotes(
    projectId: string,
    linkedProjectIds: string[],
    baseBranch: string,
  ): Promise<void> {
    const { project, profile, git } = await this.context(projectId);
    const linked = linkedProjectIds.filter((id) => id !== project.id);
    const projects = [project, ...linked.map((id) => this.linkable(project, id))];
    for (const [i, p] of projects.entries()) {
      const base = i === 0 ? baseBranch.trim() : this.projectBase(profile, p);
      if (base) void this.askRemote(git, p, base, null);
    }
  }

  /**
   * The remote's branches, with `git fetch <remote> <base>` run at the same
   * time (network, spec §7.3), or why it couldn't be asked; null without a
   * remote. Each answer is reused while it runs and for 30 s after; Create
   * (with a timer) uses it up, New workspace (without) only starts it.
   */
  private async askRemote(
    git: Git,
    project: Project,
    base: string,
    timer: PhaseTimer | null,
  ): Promise<RemoteHeads> {
    const remote = project.remote;
    if (!remote) return null;
    const repo = expandHome(project.repoPath);
    const heads = this.remoteAnswers.get(
      `ls-remote\0${repo}\0${remote}`,
      () =>
        git.remoteHeads(repo, remote).then(
          (h): RemoteHeads => ({ heads: h }),
          (error): RemoteHeads => ({ error: gitReason(error) }),
        ),
      { take: timer !== null },
    );
    // A base the remote doesn't have fails here; the heads say so.
    const fetched = this.remoteAnswers.get(
      `fetch\0${repo}\0${remote}\0${base}`,
      () =>
        git.fetch(repo, remote, base).then(
          () => null,
          (error) => gitReason(error),
        ),
      { take: timer !== null },
    );
    const wait = <T>(phase: string, asked: { answer: Promise<T>; reused: boolean }) =>
      timer
        ? timer.time(
            `${phase} (${project.name})${asked.reused ? ', asked earlier' : ''}`,
            () => asked.answer,
          )
        : asked.answer;
    const [answer, fetchError] = await Promise.all([
      wait(`git ls-remote ${remote}`, heads),
      wait(`git fetch ${remote} ${base}`, fetched),
    ]);
    return answer && 'heads' in answer ? { heads: answer.heads, fetchError } : answer;
  }

  /**
   * `branch`, or the first of `branch-2`, `branch-3` … that is free in every
   * repository: no local branch, no remote-tracking ref, not on the remote as
   * asked, no worktree folder (spec §7.1).
   */
  private async freeBranch(
    git: Git,
    profile: Profile,
    targets: { project: Project; remote: RemoteHeads }[],
    branch: string,
  ): Promise<string> {
    const taken = async (name: string) => {
      for (const { project, remote } of targets) {
        const repo = expandHome(project.repoPath);
        if (await git.localBranchExists(repo, name)) return true;
        if (project.remote && (await git.trackingBranchExists(repo, project.remote, name)))
          return true;
        if (remote && 'heads' in remote && remote.heads.has(name)) return true;
        if (fs.existsSync(path.join(expandHome(projectWorktreeDir(profile, project)), name)))
          return true;
      }
      return false;
    };
    for (let n = 1; n <= 1000; n++) {
      const name = n === 1 ? branch : numberedBranch(branch, n);
      if (!(await taken(name))) return name;
    }
    throw new Error(`No free branch name like ${branch}`);
  }

  /**
   * One repository's worktree for a workspace (spec §7.3 steps 1–4), its base
   * fetched with the remote's answer: adds the worktree with its branch, copies
   * the .worktreeinclude files and writes the task file. A base that isn't on the remote yet, or a
   * fetch that fails, starts from the local base branch: the note says so.
   */
  private async addRepoWorktree(
    git: Git,
    project: Project,
    remoteHeads: RemoteHeads,
    worktreePath: string,
    branch: string,
    base: string,
    task: WorkspaceTask,
    { named, timer, onCreated }: { named: boolean; timer: PhaseTimer; onCreated: () => void },
  ): Promise<string | null> {
    const repo = expandHome(project.repoPath);
    const of = named ? ` (${project.name})` : '';
    let startPoint = base;
    let note: string | null = null;
    if (project.remote && remoteHeads) {
      const remote = project.remote;
      let reason = 'error' in remoteHeads ? remoteHeads.error : null;
      if ('heads' in remoteHeads && remoteHeads.heads.has(branch)) {
        throw new Error(
          `${remote}${named ? ` of ${project.name}` : ''} already has a branch named ${branch}`,
        );
      }
      if ('heads' in remoteHeads && remoteHeads.heads.has(base)) {
        if (remoteHeads.fetchError) reason = remoteHeads.fetchError;
        else startPoint = `${remote}/${base}`;
      }
      if (startPoint === base) {
        if (!(await timer.time(`local ${base}${of}`, () => git.localBranchExists(repo, base)))) {
          throw new Error(
            reason
              ? `Couldn't fetch ${remote}/${base}${of} (${reason}), and there is no local branch ${base}`
              : `${base} is neither on ${remote} nor a local branch${of}`,
          );
        }
        note = reason
          ? `Couldn't fetch ${remote}/${base}${of} (${reason}); the workspace starts from your local ${base}`
          : `${base} isn't on ${remote}${of} yet; the workspace starts from your local ${base}`;
      }
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const timed = <T>(name: string, run: () => Promise<T>) =>
      step(name, () => timer.time(name, run));
    await timed(`git worktree add${of}`, () =>
      git.addWorktree(repo, worktreePath, branch, startPoint),
    );
    onCreated();
    const copied = await timed(`Copying the .worktreeinclude files${of}`, () =>
      copyIncludedFiles(git, repo, worktreePath),
    );
    timer.note(`${copied.length} .worktreeinclude files copied${of}`);
    await timed(`Writing the task file${of}`, async () => {
      const dir = path.join(worktreePath, BRAND.repoDirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.md'), taskFile(task));
      await this.excludeRepoDir(git, worktreePath);
    });
    return note;
  }

  private async removeCreated(
    git: Git,
    created: { repo: string; worktreePath: string }[],
    branch: string,
  ): Promise<void> {
    for (const { repo, worktreePath } of created) {
      await git.removeWorktree(repo, worktreePath, true).catch(() => {});
      await git.deleteBranch(repo, branch).catch(() => {});
    }
  }

  /** A project that may be linked with `main`: another project of the same profile (R1, R2). */
  private linkable(main: Project, projectId: string): Project {
    const project = this.config.require().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown project "${projectId}"`);
    if (project.profileId !== main.profileId) {
      throw new Error(`${project.name} belongs to another profile and can't be linked`);
    }
    return project;
  }

  /** A project's base branch: its own, else the profile's default (spec §4.3). */
  private projectBase(profile: Profile, project: Project): string {
    return project.baseBranch ?? profile.defaults.baseBranch;
  }

  /**
   * A workspace's Claude reported SessionStart: for one just created, its
   * start and the whole Create are timed (spec §3.4).
   */
  sessionStarted(workspaceId: string): void {
    const timing = this.timings.get(workspaceId);
    if (timing?.claudeAt == null) return;
    this.timings.delete(workspaceId);
    timing.timer.since("Claude's session started", timing.claudeAt);
    timing.timer.total('total since Create');
  }

  /** Starts Claude in a new workspace; a failure leaves it in Error with the reason. */
  private async launchClaude(
    workspace: Workspace,
  ): Promise<{ workspace: Workspace; claude: SessionInfo | null; claudeError: string | null }> {
    const timing = this.timings.get(workspace.id);
    try {
      const current = this.records.get(workspace.id) ?? workspace;
      const spawning = performance.now();
      const claude = await this.terminals.startClaudeInWorkspace(
        current,
        this.settingsFile(workspace.profileId),
        this.startOptions(current),
      );
      if (timing) {
        timing.timer.since('Claude spawned', spawning);
        timing.claudeAt = performance.now();
      }
      return { workspace, claude, claudeError: null };
    } catch (error) {
      this.timings.delete(workspace.id);
      const message = error instanceof Error ? error.message : String(error);
      this.records.setState(workspace.id, 'error', { message });
      return { workspace, claude: null, claudeError: message };
    }
  }

  private claudeSession(workspaceId: string): SessionInfo | undefined {
    return this.terminals.host
      .list()
      .find((s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status === 'running');
  }

  /** The workspace's latest Claude tab whose Claude has exited. */
  private exitedClaude(workspaceId: string): SessionInfo | undefined {
    return this.terminals.host
      .list()
      .findLast(
        (s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status === 'exited',
      );
  }

  private suspendedClaude(workspaceId: string): SessionInfo | undefined {
    return this.terminals.host
      .list()
      .find(
        (s) => s.workspaceId === workspaceId && s.kind === 'claude' && s.status === 'suspended',
      );
  }

  /**
   * Runs setup in each given repository, in parallel, each in its own Setup
   * tab (spec §8.3, §21.3). `intent` says what follows once every setup of the
   * workspace has passed: start Claude, or restart it with the new folders.
   */
  private async startSetups(
    workspace: Workspace,
    runs: { projectId: string; plan: SetupPlan }[],
    intent: { start: boolean; restart: boolean },
  ): Promise<SessionInfo[]> {
    const before = this.afterSetup.get(workspace.id);
    this.afterSetup.set(workspace.id, {
      start: intent.start || (before?.start ?? false),
      restart: intent.restart || (before?.restart ?? false),
    });
    if (!this.claudeSession(workspace.id)) {
      this.records.setState(workspace.id, 'working', { message: 'Running setup' });
    }
    const sessions: SessionInfo[] = [];
    for (const run of runs)
      sessions.push(await this.startSetup(workspace, run.projectId, run.plan));
    return sessions;
  }

  /** One repository's Setup tab, replacing an earlier one; its result is recorded on exit. */
  private async startSetup(
    workspace: Workspace,
    projectId: string,
    plan: SetupPlan,
  ): Promise<SessionInfo> {
    const host = this.terminals.host;
    for (const old of host.list()) {
      if (old.workspaceId === workspace.id && old.kind === 'setup' && old.projectId === projectId)
        await host.remove(old.id);
    }
    this.records.setSetupError(workspace.id, projectId, null);
    const session = await this.terminals.workspaceSetup(
      workspace,
      commandScript(plan.setup, SETUP_FAILED_PREFIX),
      projectId,
    );
    let timedOut = false;
    const started = performance.now();
    const timer = setTimeout(() => {
      timedOut = true;
      void host.remove(session.id);
    }, plan.setupTimeoutSec * 1000);
    void host.waitForExit(session.id).then(async (exited) => {
      clearTimeout(timer);
      this.timings
        .get(workspace.id)
        ?.timer.since(`setup of ${projectId} ended (exit ${exited.exitCode ?? '?'})`, started);
      const current = this.records.get(workspace.id);
      // Deleted, or the repository unlinked, meanwhile.
      if (!current || !workspaceRepo(current, projectId)) return;
      const ok = exited.exitCode === 0 && !timedOut;
      this.records.setSetupError(
        workspace.id,
        projectId,
        ok
          ? null
          : timedOut
            ? `timed out after ${plan.setupTimeoutSec} s`
            : `exit ${exited.exitCode ?? exited.signal ?? '?'}`,
      );
      await this.setupFinished(workspace.id);
    });
    return session;
  }

  /**
   * After a setup exits: once none is running, either every repository passed
   * and what was waiting happens (Claude starts or restarts), or the
   * workspace is in Error naming the ones that failed (spec §21.3).
   */
  private async setupFinished(workspaceId: string): Promise<void> {
    const host = this.terminals.host;
    if (
      host
        .list()
        .some((s) => s.workspaceId === workspaceId && s.kind === 'setup' && s.status === 'running')
    )
      return;
    const workspace = this.records.get(workspaceId);
    if (!workspace) return;
    const failures = workspace.repos.filter((r) => r.setupError);
    if (failures.length > 0) {
      // What was waiting stays for Retry.
      this.records.setState(workspaceId, 'error', {
        message: setupFailureMessage(
          failures.map((r) => ({
            name: this.projectName(r.projectId),
            detail: r.setupError as string,
          })),
          workspace.repos.length > 1,
        ),
      });
      return;
    }
    const intent = this.afterSetup.get(workspaceId) ?? { start: false, restart: false };
    this.afterSetup.delete(workspaceId);
    const wasSettingUp =
      setupFailed(workspace) ||
      (workspace.state === 'working' && workspace.stateMessage === 'Running setup');
    if (this.claudeSession(workspaceId)) {
      if (intent.restart) {
        await this.restartClaude(workspaceId).catch((error: unknown) => {
          this.records.setState(workspaceId, 'error', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      } else if (wasSettingUp) this.records.setState(workspaceId, 'starting');
    } else if (intent.start) {
      await this.launchClaude(workspace);
    } else if (wasSettingUp) {
      this.records.setState(workspaceId, 'exited');
    }
  }

  private projectName(projectId: string): string {
    return this.config.get().config?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  /**
   * Retry after a failed setup (spec §7.3, §21.3): the repositories whose
   * setup failed run it again (all with setup, when none is marked), then
   * Claude starts once every one has passed.
   */
  async runSetup(workspaceId: string): Promise<SessionInfo> {
    const workspace = this.ensurePorts(this.workspace(workspaceId));
    const plans = await Promise.all(
      workspace.repos.map(async (repo) => ({
        repo,
        plan: setupPlan((await this.context(repo.projectId)).project, repo.worktreePath),
      })),
    );
    const broken = plans.find((p) => p.plan.error);
    if (broken) throw new Error(broken.plan.error as string);
    const withSetup = plans.filter((p) => p.plan.setup.length > 0);
    if (withSetup.length === 0) throw new Error('This project has no setup commands');
    const failed = withSetup.filter((p) => p.repo.setupError);
    const runs = (failed.length > 0 ? failed : withSetup).map((p) => ({
      projectId: p.repo.projectId,
      plan: p.plan,
    }));
    const sessions = await this.startSetups(workspace, runs, {
      start: !this.claudeSession(workspaceId),
      restart: false,
    });
    return sessions[0] as SessionInfo;
  }

  /** What sets up the project's workspaces, from its main checkout (spec §8.3). */
  async projectSetup(projectId: string): Promise<SetupPlan> {
    const { project } = await this.context(projectId);
    return setupPlan(project, expandHome(project.repoPath));
  }

  /** A workspace made before ports existed gets its block when it next starts something. */
  private ensurePorts(workspace: Workspace): Workspace {
    if (workspace.ports) return workspace;
    const project = this.config.require().projects.find((p) => p.id === workspace.projectId);
    const count = project ? setupPlan(project, workspace.worktreePath).ports : 10;
    const ports = allocatePorts(count, this.portRange(), this.records.portBlocks());
    this.records.setPorts(workspace.id, ports);
    return { ...workspace, ports };
  }

  private portRange(): { start: number; end: number } {
    return this.config.require().ports ?? DEFAULT_PORT_RANGE;
  }

  /**
   * Starts Claude again in a workspace whose Claude isn't running, resuming
   * its conversation (spec §9.4) with every linked worktree (§21.3).
   */
  async startClaude(workspaceId: string): Promise<SessionInfo> {
    const workspace = this.ensurePorts(this.workspace(workspaceId));
    const running = this.claudeSession(workspaceId);
    if (running) return running;
    // A suspended Claude resumes in its session, with what it had (spec §9.8).
    const suspended = this.suspendedClaude(workspaceId);
    if (suspended) {
      return this.terminals.startClaudeInWorkspace(
        workspace,
        this.settingsFile(workspace.profileId),
        {
          ...this.resumeOptions(workspace),
          into: suspended.id,
          restore: this.restoreArgs?.(suspended.id) ?? [],
        },
      );
    }
    // An exited Claude starts again in its own tab, not a new one (spec §9.8).
    return this.terminals.startClaudeInWorkspace(
      workspace,
      this.settingsFile(workspace.profileId),
      { ...this.startOptions(workspace), into: this.exitedClaude(workspaceId)?.id },
    );
  }

  /**
   * How Claude starts in a workspace: its first start (spec §13.5) begins a
   * new conversation with the Start prompt, every later one resumes (§9.4).
   */
  private startOptions(workspace: Workspace) {
    if (!this.records.startPromptPending(workspace.id)) return this.resumeOptions(workspace);
    return { prompt: this.firstPrompt(workspace), sessionId: this.newConversation(workspace) };
  }

  /**
   * Resuming its conversation (spec §9.4), unless Claude never saved it: a
   * start without a prompt writes no transcript, and `--resume` would fail.
   * Then a new conversation with the same id, and a note (spec §9.8).
   */
  private resumeOptions(workspace: Workspace) {
    const id = workspace.claudeSessionId;
    const transcript = this.records.transcriptPath(workspace.id);
    // Only the transcript Claude reported for this conversation tells (decision D12).
    if (id && transcript && path.basename(transcript) === `${id}.jsonl`) {
      if (!fs.existsSync(transcript)) return { sessionId: id, note: NEW_CONVERSATION_NOTE };
    }
    return { resume: true };
  }

  /**
   * The session id of a workspace's first conversation (spec §9.4), chosen
   * here and stored before Claude starts, so a restart resumes it even when
   * no hook has reported it yet.
   */
  private newConversation(workspace: Workspace): string {
    const id = randomUUID();
    this.records.setClaudeSession(workspace.id, id, null);
    return id;
  }

  /**
   * The Start prompt, once: at the first start of a workspace made with New
   * workspace (spec §13.5). Resume, restart and later starts get none.
   */
  private firstPrompt(workspace: Workspace): string | null {
    if (!this.records.startPromptPending(workspace.id)) return null;
    this.records.setStartPromptPending(workspace.id, false);
    return this.startPrompt?.(workspace) ?? null;
  }

  /**
   * Stops a running Claude and starts it again with `--resume` and the
   * current `--add-dir` arguments, so the conversation continues with the
   * workspace's repositories as they are now (spec §21.4).
   */
  async restartClaude(workspaceId: string): Promise<SessionInfo> {
    // A suspended one gets the new arguments when it resumes (spec §9.8).
    const suspended = this.suspendedClaude(workspaceId);
    if (suspended) return suspended;
    const running = this.claudeSession(workspaceId);
    if (running) await this.terminals.host.remove(running.id);
    return this.startClaude(workspaceId);
  }

  /**
   * At launch: resumes Claude in the workspaces where it was running when the
   * app quit (spec §9.4). A workspace that can't start (gated profile,
   * missing project) stays exited.
   */
  async resumeAtLaunch(): Promise<void> {
    for (const workspace of this.records.claudeWasRunning()) {
      // With suspension on, it starts suspended; opening it, or continuing
      // its interrupted work, resumes it (spec §9.8).
      if (this.suspendAtStart?.(workspace.profileId)) {
        this.terminals.host.addSuspended({
          kind: 'claude',
          title: `${workspace.name} · claude`,
          cwd: workspace.worktreePath,
          profileId: workspace.profileId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
        });
        if (workspace.state === 'exited') this.records.setState(workspace.id, 'starting');
        continue;
      }
      try {
        await this.startClaude(workspace.id);
      } catch {
        this.records.setClaudeRunning(workspace.id, false);
      }
    }
  }

  /** A shell in one of the workspace's worktrees (the main one by default). */
  shell(workspaceId: string, projectId: string | null = null): Promise<SessionInfo> {
    return this.terminals.workspaceShell(this.ensurePorts(this.workspace(workspaceId)), projectId);
  }

  /**
   * Link another repository… (spec §21.4): checks the branch is free there,
   * creates its worktree with the .worktreeinclude files and the task file,
   * and runs its setup in a new Setup tab. With `restart`, a running Claude
   * restarts with the new folder once that setup passed (at once without
   * setup); otherwise the result has the `/add-dir` line to paste.
   */
  async link(
    workspaceId: string,
    projectId: string,
    { restart, addedBy = null }: { restart: boolean; addedBy?: RepoAddedBy | null },
  ): Promise<LinkResult> {
    const workspace = this.workspace(workspaceId);
    const { project: main, profile, git } = await this.context(workspace.projectId);
    if (workspace.repos.some((r) => r.projectId === projectId)) {
      throw new Error('That project is already in this workspace');
    }
    const project = this.linkable(main, projectId);
    const branch = workspace.branch;
    const repo = expandHome(project.repoPath);
    if (await git.localBranchExists(repo, branch))
      throw new Error(`A branch named ${branch} already exists in ${project.name}`);
    if (project.remote && (await git.trackingBranchExists(repo, project.remote, branch))) {
      throw new Error(`${project.remote} of ${project.name} already has a branch named ${branch}`);
    }
    const worktreePath = path.join(expandHome(projectWorktreeDir(profile, project)), branch);
    if (fs.existsSync(worktreePath)) throw new Error(`${worktreePath} already exists`);
    const base = this.projectBase(profile, project);
    let created = false;
    const notes: string[] = [];
    const timer = new PhaseTimer(this.log, `link ${project.id} into ${branch}`);
    try {
      const note = await this.addRepoWorktree(
        git,
        project,
        await this.askRemote(git, project, base, timer),
        worktreePath,
        branch,
        base,
        workspace.task,
        {
          named: true,
          timer,
          onCreated: () => {
            created = true;
          },
        },
      );
      if (note) notes.push(note);
      this.records.addRepo(workspaceId, { projectId, worktreePath, baseBranch: base, addedBy });
    } catch (error) {
      if (created) await this.removeCreated(git, [{ repo, worktreePath }], branch);
      throw error;
    }
    const start = await git.revParse(worktreePath, 'HEAD');
    if (start) this.records.setStartCommit(workspaceId, start, projectId);

    const linked = this.workspace(workspaceId);
    const addDirLine = `/add-dir ${worktreePath}`;
    const plan = setupPlan(project, worktreePath);
    const claudeRunning = Boolean(this.claudeSession(workspaceId));
    if (plan.error) {
      this.records.setSetupError(workspaceId, projectId, plan.error);
      await this.setupFinished(workspaceId);
      return {
        workspace: this.workspace(workspaceId),
        setup: null,
        claude: null,
        addDirLine,
        notes,
      };
    }
    if (plan.setup.length > 0) {
      const [setup] = await this.startSetups(linked, [{ projectId, plan }], {
        start: false,
        restart: restart && claudeRunning,
      });
      return { workspace: linked, setup: setup ?? null, claude: null, addDirLine, notes };
    }
    const claude = restart && claudeRunning ? await this.restartClaude(workspaceId) : null;
    return { workspace: linked, setup: null, claude, addDirLine, notes };
  }

  /**
   * Waits for a repository's Setup tab to exit and gives its failure (as the
   * workspace records it: `exit 1`, `timed out after 900 s`), or null when it passed.
   */
  async setupOutcome(
    workspaceId: string,
    projectId: string,
    sessionId: string,
  ): Promise<string | null> {
    await this.terminals.host.waitForExit(sessionId);
    // The setup's own exit handler records the result first.
    await new Promise((resolve) => setImmediate(resolve));
    const workspace = this.records.get(workspaceId);
    if (!workspace) throw new Error('The workspace was deleted meanwhile');
    const repo = workspaceRepo(workspace, projectId);
    if (!repo) throw new Error('The repository was unlinked meanwhile');
    return repo.setupError ?? null;
  }

  /** What unlinking a repository would lose (spec §21.4). */
  async unlinkCheck(workspaceId: string, projectId: string): Promise<RepoDeleteCheck> {
    const workspace = this.workspace(workspaceId);
    const repo = workspaceRepo(workspace, projectId);
    if (!repo || repo.primary) throw new Error("That repository isn't linked to this workspace");
    return this.repoDeleteCheck(workspace, repo);
  }

  /**
   * Unlink <repo> (spec §21.4): stops that repository's sessions, runs its
   * teardown, removes its worktree (and branch, when asked) and the link,
   * then restarts a running Claude without it.
   */
  async unlink(
    workspaceId: string,
    projectId: string,
    choice: RepoDeleteChoice,
  ): Promise<{ teardown: CommandResult | null }> {
    const workspace = this.workspace(workspaceId);
    const repo = workspaceRepo(workspace, projectId);
    if (!repo || repo.primary) throw new Error("That repository isn't linked to this workspace");
    const host = this.terminals.host;
    await Promise.all(
      host
        .list()
        .filter((s) => s.workspaceId === workspaceId && s.projectId === projectId)
        .map((s) => host.remove(s.id)),
    );
    const teardown = await this.removeRepo(workspace, repo, choice);
    this.records.removeRepo(workspaceId, projectId);
    if (this.claudeSession(workspaceId)) await this.restartClaude(workspaceId);
    else await this.setupFinished(workspaceId);
    return { teardown };
  }

  /** What deleting would lose or interrupt, per repository (spec §14.2, §21.6). */
  async deleteCheck(workspaceId: string): Promise<WorkspaceDeleteCheck> {
    const workspace = this.workspace(workspaceId);
    const repos = await Promise.all(workspace.repos.map((r) => this.repoDeleteCheck(workspace, r)));
    const main = repos[0] as RepoDeleteCheck;
    return {
      repos,
      uncommitted: main.uncommitted,
      unpushed: main.unpushed,
      running: this.terminals.host
        .list()
        .filter((s) => s.workspaceId === workspaceId && s.status === 'running').length,
      worktreeMissing: main.worktreeMissing,
      prOpen: main.prOpen,
      merged: main.merged,
    };
  }

  private async repoDeleteCheck(
    workspace: Workspace,
    repo: WorkspaceRepo,
  ): Promise<RepoDeleteCheck> {
    const { project, git } = await this.context(repo.projectId);
    const repoPath = expandHome(project.repoPath);
    const worktreeMissing = !fs.existsSync(repo.worktreePath);
    const branchExists = await git.localBranchExists(repoPath, workspace.branch);
    // A merged branch's commits are safe in the base: none count as unpushed (§14.2).
    const merged = branchExists
      ? await refreshMerged(git, this.records, workspace, repo, project)
      : null;
    return {
      projectId: repo.projectId,
      primary: repo.primary,
      worktreePath: repo.worktreePath,
      uncommitted: worktreeMissing ? [] : await git.status(repo.worktreePath),
      unpushed:
        branchExists && !merged
          ? await git.unpushedCount(repoPath, workspace.branch, project.remote !== null)
          : 0,
      worktreeMissing,
      prOpen: repo.pr?.state === 'open' || repo.pr?.state === 'draft',
      merged,
    };
  }

  /**
   * One repository's part of deleting (spec §14.2 steps 2–4): teardown
   * (reported, never blocking), the worktree (`--force` only when the user
   * confirmed), the local branch when asked (never the remote one).
   */
  private async removeRepo(
    workspace: Workspace,
    repo: WorkspaceRepo,
    { force, deleteBranch }: RepoDeleteChoice,
  ): Promise<CommandResult | null> {
    const { project, git } = await this.context(repo.projectId);
    const repoPath = expandHome(project.repoPath);
    const of = workspace.repos.length > 1 ? ` (${project.name})` : '';
    let teardown: CommandResult | null = null;
    if (fs.existsSync(repo.worktreePath)) {
      const plan = setupPlan(project, repo.worktreePath);
      if (plan.teardown.length > 0) {
        const { shell, env } = await this.terminals.workspaceCommandEnv(workspace, repo.projectId);
        teardown = await runCommands({
          shell,
          commands: plan.teardown,
          cwd: repo.worktreePath,
          env,
          timeoutSec: plan.teardownTimeoutSec,
          label: `Teardown${of}`,
        });
      }
    }
    if (fs.existsSync(repo.worktreePath)) {
      await step(`git worktree remove${of}`, () =>
        git.removeWorktree(repoPath, repo.worktreePath, force),
      );
    } else {
      await git.pruneWorktrees(repoPath);
    }
    if (deleteBranch && (await git.localBranchExists(repoPath, workspace.branch))) {
      await step(`git branch -D${of}`, () => git.deleteBranch(repoPath, workspace.branch));
    }
    return teardown;
  }

  /**
   * Spec §14.2 for every repository (§21.6): stop the workspace's processes
   * (SIGTERM, SIGKILL after 5 s), then per repository teardown, worktree and
   * branch, then archive the record. `force` and `deleteBranch` apply to
   * every repository unless `repos` says otherwise for one.
   */
  async delete(
    workspaceId: string,
    {
      force,
      deleteBranch,
      repos = [],
    }: RepoDeleteChoice & { repos?: (RepoDeleteChoice & { projectId: string })[] },
  ): Promise<{ teardown: CommandResult | null; teardowns: CommandResult[] }> {
    const workspace = this.workspace(workspaceId);
    this.timings.delete(workspaceId);
    const host = this.terminals.host;
    await Promise.all(
      host
        .list()
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => host.remove(s.id)),
    );
    this.afterSetup.delete(workspaceId);
    const choices = new Map(repos.map((r) => [r.projectId, r]));
    const teardowns: CommandResult[] = [];
    // Linked repositories first, so the record keeps the main one until the end.
    for (const repo of [...linkedRepos(workspace), workspace.repos[0] as WorkspaceRepo]) {
      const teardown = await this.removeRepo(
        workspace,
        repo,
        choices.get(repo.projectId) ?? { force, deleteBranch },
      );
      if (teardown) teardowns.push(teardown);
      if (!repo.primary) this.records.removeRepo(workspaceId, repo.projectId);
    }
    this.records.archive(workspaceId);
    const failed = teardowns.filter((t) => !t.ok);
    return {
      teardown: failed[0] ?? teardowns[0] ?? null,
      teardowns,
    };
  }

  /** What removing a project would delete or stop (spec §14.3, §21.6). */
  async projectRemovalCheck(projectId: string): Promise<ProjectRemovalCheck> {
    const workspaces = this.records.forProject(projectId);
    return {
      workspaces: await Promise.all(
        workspaces.map(async (workspace) => ({
          workspace,
          check: await this.deleteCheck(workspace.id),
        })),
      ),
      linked: await Promise.all(
        this.records.linkedInto(projectId).map(async ({ workspace, repo }) => ({
          workspace,
          check: await this.repoDeleteCheck(workspace, repo),
        })),
      ),
      runningSessions: this.terminals.host
        .list()
        .filter((s) => s.projectId === projectId && s.status === 'running').length,
    };
  }

  /**
   * Spec §14.3, before the project leaves config.json: unlinks it from other
   * projects' workspaces (deleting only its worktree there, §21.6), stops all
   * of its sessions, deletes each of its workspaces as Delete workspace does,
   * then removes the worktree folders left empty. The main checkout is never
   * touched. If a workspace can't be deleted, stops there and says which
   * ones were.
   */
  async deleteProjectWorkspaces(
    projectId: string,
    choices: ({ workspaceId: string } & RepoDeleteChoice & {
        repos?: (RepoDeleteChoice & { projectId: string })[];
      })[],
    linkedChoices: ({ workspaceId: string } & RepoDeleteChoice)[] = [],
  ): Promise<{ teardownFailures: string[] }> {
    const { project, profile } = await this.context(projectId);
    const workspaces = this.records.forProject(projectId);
    const linkedIn = this.records.linkedInto(projectId);
    const chosen = new Map(choices.map((c) => [c.workspaceId, c]));
    const chosenLinked = new Map(linkedChoices.map((c) => [c.workspaceId, c]));
    const missing = [
      ...workspaces.filter((w) => !chosen.has(w.id)),
      ...linkedIn.map((l) => l.workspace).filter((w) => !chosenLinked.has(w.id)),
    ];
    if (missing.length > 0) {
      throw new Error(
        `The project has workspaces that weren't confirmed: ${missing.map((w) => w.name).join(', ')}`,
      );
    }
    const repo = realpathOr(expandHome(project.repoPath));
    const deleted: string[] = [];
    const teardownFailures: string[] = [];
    const stopped = (what: string, error: unknown) => {
      const done = deleted.length > 0 ? ` Already deleted: ${deleted.join(', ')}.` : '';
      return new Error(
        `Couldn't delete ${what}: ${error instanceof Error ? error.message : String(error)}.${done} The project was not removed.`,
      );
    };
    // Its worktrees in other projects' workspaces; those workspaces stay.
    for (const { workspace, repo: linkedRepo } of linkedIn) {
      const choice = chosenLinked.get(workspace.id) as RepoDeleteChoice;
      if (isInside(realpathOr(linkedRepo.worktreePath), repo)) {
        throw new Error(
          `${workspace.name}'s worktree is inside the main checkout; not deleting it`,
        );
      }
      try {
        const { teardown } = await this.unlink(workspace.id, projectId, choice);
        if (teardown && !teardown.ok)
          teardownFailures.push(`${workspace.name}: ${teardown.message}`);
      } catch (error) {
        throw stopped(`the worktree in ${workspace.name}`, error);
      }
      deleted.push(`the worktree in ${workspace.name}`);
    }

    const host = this.terminals.host;
    await Promise.all(
      host
        .list()
        .filter((s) => s.projectId === projectId)
        .map((s) => host.remove(s.id)),
    );
    // Its worktree folder now and its default one (if it had its own); emptied ones go.
    const folders = new Set(
      [project, { ...project, worktreeRoot: null }].map((p) =>
        expandHome(projectWorktreeDir(profile, p)),
      ),
    );
    for (const { worktreePath } of linkedIn.map((l) => l.repo)) {
      folders.add(path.dirname(worktreePath));
    }
    for (const workspace of workspaces) {
      const choice = chosen.get(workspace.id) as (typeof choices)[number];
      if (isInside(realpathOr(workspace.worktreePath), repo)) {
        throw new Error(
          `${workspace.name}'s worktree is inside the main checkout; not deleting it`,
        );
      }
      folders.add(path.dirname(workspace.worktreePath));
      try {
        const { teardowns } = await this.delete(workspace.id, choice);
        for (const t of teardowns) {
          if (!t.ok) teardownFailures.push(`${workspace.name}: ${t.message}`);
        }
      } catch (error) {
        throw stopped(workspace.name, error);
      }
      deleted.push(workspace.name);
    }
    // Then an emptied .worktrees in a chosen folder; never the chosen folder itself.
    for (const folder of [...folders]) {
      if (path.basename(path.dirname(folder)) === WORKTREES_DIR) folders.add(path.dirname(folder));
    }
    for (const folder of folders) {
      if (isInside(realpathOr(folder), repo)) continue;
      try {
        // Only an empty folder goes; never recursively.
        fs.rmdirSync(folder);
      } catch {
        // not empty, or already gone
      }
    }
    return { teardownFailures };
  }

  private workspace(id: string): Workspace {
    const workspace = this.records.get(id);
    if (!workspace) throw new Error(`Unknown workspace "${id}"`);
    return workspace;
  }

  private async context(
    projectId: string,
  ): Promise<{ project: Project; profile: Profile; git: Git }> {
    const project = this.config.require().projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown project "${projectId}"`);
    return {
      project,
      profile: this.env.profile(project.profileId),
      git: await this.env.git(project.profileId),
    };
  }

  /** The task file's folder stays out of git (spec §7.3 step 4). */
  private async excludeRepoDir(git: Git, worktreePath: string): Promise<void> {
    const exclude = path.join(await git.commonDir(worktreePath), 'info', 'exclude');
    const entry = `/${BRAND.repoDirName}/`;
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const lines = current.split('\n').map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(`${BRAND.repoDirName}/`)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(exclude, `${separator}${entry}\n`);
  }
}
