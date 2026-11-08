import type { ChangeGroup, FileDiff, WorkspaceChanges } from '@shared/changes';
import {
  DEFAULT_CREATE_PR_PROMPT,
  type Profile,
  type Project,
  type PrSettings,
} from '@shared/schemas';
import { shellQuote } from '@shared/shell';
import {
  type MergedInto,
  type PrStatus,
  type Workspace,
  type WorkspaceRepo,
  workspaceRepo,
} from '@shared/workspaces';
import type { ConfigStore } from '../config/store';
import type { WorkspaceRecords } from '../db/workspaces';
import { resolveExecutable } from '../env/which';
import { Git, GitError } from '../git/git';
import { expandHome } from '../paths';
import type { TerminalService } from '../services/terminals';
import { type CommandResult, runCommands } from '../worktrees/setup';
import { baseRef, fileDiff, workspaceChanges } from './service';

const DEFAULT_COMMAND_TIMEOUT_SEC = 15;
/** How often PR status is checked while a workspace exists (spec §12.4). */
export const PR_POLL_MS = 5 * 60 * 1000;
/** A repository is fetched for the git-only check at most this often. */
const FETCH_EVERY_MS = 60 * 1000;

/** What the finish control shows (spec §14.1). */
export interface FinishState {
  hasRemote: boolean;
  remote: string | null;
  /** Uncommitted files (`git status --porcelain` lines). */
  uncommitted: number;
  /** Commits not on the remote yet. */
  unpushed: number;
  /** The branch has been pushed (it has an upstream). */
  pushed: boolean;
  /** `{id}: {title}`, or the title alone. */
  commitMessage: string;
  pr: PrStatus | null;
  /** Create PR runs a command (true) or asks Claude (false). */
  createsWithCommand: boolean;
}

/** The project's PR settings over its profile's, field by field. */
export function prSettings(profile: Profile, project: Project): PrSettings {
  const own = project.pr ?? {};
  const base = profile.pr ?? {};
  return {
    statusCommand: own.statusCommand ?? base.statusCommand ?? null,
    createCommand: own.createCommand ?? base.createCommand ?? null,
    createPrompt: own.createPrompt ?? base.createPrompt ?? DEFAULT_CREATE_PR_PROMPT,
    timeoutSec: own.timeoutSec ?? base.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
  };
}

/**
 * A prompt template with `{base}`, `{id}`, `{title}`, `{url}` and `{branch}`
 * filled in. An empty `{id}` drops its separator ("{id}: "), and a sentence
 * whose only content was an empty token goes, so no "Link the task: ." is left.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    if (value) continue;
    // "{id}: {title}" without an id is just the title.
    if (key === 'id') text = text.replace(/\{id\}[:-]?\s*/g, '');
    // Any other empty token takes its sentence with it.
    else
      text = text.replace(
        new RegExp(`(^|(?<=[.!?]\\s))[^.!?]*\\{${key}\\}[^.!?]*[.!?]?\\s*`, 'g'),
        '',
      );
  }
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, value);
  return text.trim();
}

/** The commit message the editor starts with (spec §14.1). */
export const commitMessage = (w: Workspace) =>
  w.task.id
    ? `${w.task.id}: ${w.task.title || w.name}`.replace(/:\s*$/, '')
    : w.task.title || w.name;

/**
 * What a Create PR prompt adds in a linked workspace (spec §21.5): which
 * folder the PR is for, and the other repositories with their branches and
 * known PRs, so each PR mentions the others. Empty without links.
 */
export function linkedPrContext(
  repo: { name: string; worktreePath: string },
  others: { name: string; branch: string; prUrl: string | null }[],
): { before: string; after: string } {
  if (others.length === 0) return { before: '', after: '' };
  const list = others
    .map((o) => `${o.name} (branch ${o.branch}${o.prUrl ? `, PR ${o.prUrl}` : ''})`)
    .join('; ');
  return {
    before: `This is for the ${repo.name} repository, in ${repo.worktreePath}. `,
    after: ` This task also changes other repositories: ${list}. Mention them in the pull request description.`,
  };
}

/** A push failure in words the user can act on (missing credentials can't be asked for). */
export function pushProblem(remote: string, stderr: string): string {
  const detail = stderr.trim();
  if (
    /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|invalid credentials|403/i.test(
      detail,
    )
  ) {
    return `git couldn't sign in to ${remote}. The app can't ask for a password, so push needs credentials git already has: a credential helper, an SSH key loaded in ssh-agent, or a CLI login such as gh auth login. Set them up and push once from a Shell tab, then try again.\n\n${detail}`;
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(detail)) {
    return `${remote} rejected the push: its branch has commits this one doesn't. Pull or rebase in a Shell tab first.\n\n${detail}`;
  }
  return detail || 'git push failed';
}

/**
 * Commit, Push, Create PR and the PR badge (spec §14.1, §12.3). git runs with
 * the workspace environment, so the profile's commit identity applies and
 * no prompt can appear (GIT_TERMINAL_PROMPT=0).
 */
export class FinishService {
  private readonly lastFetch = new Map<string, number>();
  private readonly checking = new Map<string, Promise<PrStatus | null>>();

  constructor(
    private readonly config: ConfigStore,
    private readonly records: WorkspaceRecords,
    private readonly terminals: TerminalService,
  ) {}

  /** One repository's changes (the main one for null, spec §21.5). */
  async changes(workspaceId: string, projectId: string | null = null): Promise<WorkspaceChanges> {
    const { repo, project, git } = await this.context(workspaceId, projectId);
    return workspaceChanges(git, project, repo);
  }

  async diff(
    workspaceId: string,
    group: ChangeGroup,
    file: { path: string; oldPath: string | null },
    projectId: string | null = null,
  ): Promise<FileDiff> {
    const { repo, project, git } = await this.context(workspaceId, projectId);
    const mergeBase =
      group === 'committed'
        ? await git.mergeBase(repo.worktreePath, await baseRef(git, project, repo), 'HEAD')
        : null;
    return fileDiff(git, repo, group, file, mergeBase);
  }

  async state(workspaceId: string, projectId: string | null = null): Promise<FinishState> {
    const { workspace, repo, project, profile, git } = await this.context(workspaceId, projectId);
    const dir = repo.worktreePath;
    // Home reads this every 15 s: a local merge moves the workspace to Clean up (§6.7, §14.2).
    await refreshMerged(git, this.records, workspace, repo, project).catch(() => {});
    const uncommitted = (await git.status(dir)).length;
    const upstream = project.remote
      ? await git.revParse(dir, `refs/remotes/${project.remote}/${workspace.branch}`)
      : null;
    const pushed = Boolean(
      project.remote && (await git.tryRun(dir, ['config', `branch.${workspace.branch}.remote`])),
    );
    let unpushed = 0;
    if (project.remote) {
      const out = upstream
        ? await git.run(dir, ['rev-list', '--count', `${upstream}..HEAD`])
        : await git.run(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      unpushed = Number(out.trim());
    }
    return {
      hasRemote: project.remote !== null,
      remote: project.remote,
      uncommitted,
      unpushed,
      pushed,
      commitMessage: commitMessage(workspace),
      pr: project.remote ? repo.pr : null,
      createsWithCommand: Boolean(prSettings(profile, project).createCommand),
    };
  }

  /** Commits everything in one worktree (`git add -A`, then `git commit`). */
  async commit(
    workspaceId: string,
    message: string,
    projectId: string | null = null,
  ): Promise<void> {
    const { repo, git } = await this.context(workspaceId, projectId);
    if (!message.trim()) throw new Error('Write a commit message');
    const dir = repo.worktreePath;
    if ((await git.status(dir)).length === 0) throw new Error('There is nothing to commit');
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', message.trim()]);
  }

  /** `git push -u <remote> <branch>`; then the PR status is checked again. */
  async push(workspaceId: string, projectId: string | null = null): Promise<void> {
    const { workspace, repo, project, git } = await this.context(workspaceId, projectId);
    if (!project.remote) throw new Error('This project has no remote');
    try {
      await git.run(repo.worktreePath, ['push', '-u', project.remote, workspace.branch]);
    } catch (error) {
      const stderr = error instanceof GitError ? error.stderr : String(error);
      throw new Error(pushProblem(project.remote, stderr));
    }
    void this.refreshPr(workspaceId).catch(() => {});
  }

  /**
   * Create PR (spec §14.1): the PR create command in the worktree when one is
   * set, otherwise the create prompt sent to the Claude tab.
   */
  async createPr(
    workspaceId: string,
    projectId: string | null = null,
  ): Promise<{ via: 'command'; result: CommandResult } | { via: 'claude' }> {
    const { workspace, repo, project, profile } = await this.context(workspaceId, projectId);
    if (!project.remote) throw new Error('This project has no remote');
    const settings = prSettings(profile, project);
    if (settings.createCommand) {
      const { shell, env } = await this.terminals.workspaceCommandEnv(workspace, repo.projectId);
      const result = await runCommands({
        shell,
        commands: [settings.createCommand],
        cwd: repo.worktreePath,
        env,
        timeoutSec: settings.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
        label: 'Create PR',
      });
      void this.refreshPr(workspaceId).catch(() => {});
      return { via: 'command', result };
    }
    const linked = linkedPrContext(
      { name: project.name, worktreePath: repo.worktreePath },
      workspace.repos
        .filter((r) => r !== repo)
        .map((r) => ({
          name: this.projectName(r.projectId),
          branch: workspace.branch,
          prUrl: r.pr?.url ?? null,
        })),
    );
    const filled = fillTemplate(settings.createPrompt ?? DEFAULT_CREATE_PR_PROMPT, {
      base: repo.baseBranch,
      branch: workspace.branch,
      id: workspace.task.id ?? '',
      title: workspace.task.title || workspace.name,
      url: workspace.task.url ?? '',
    });
    await this.sendToClaude(workspace, `${linked.before}${filled}${linked.after}`);
    return { via: 'claude' };
  }

  /** "Ask Claude to write it" (spec §14.1): Claude writes the message and commits. */
  askClaudeToCommit(workspaceId: string, projectId: string | null = null): Promise<void> {
    const workspace = this.workspace(workspaceId);
    const repo = this.repoOf(workspace, projectId);
    const prefix = workspace.task.id
      ? ` Start the subject line with "${workspace.task.id}: ".`
      : '';
    if (workspace.repos.length === 1) {
      return this.sendToClaude(
        workspace,
        `Commit the uncommitted changes in this worktree: stage them with git add -A and run git commit with a message you write from the changes.${prefix}`,
      );
    }
    // Spec §21.5: that repository only, named with its worktree path.
    const name = this.projectName(repo.projectId);
    const at = shellQuote(repo.worktreePath);
    return this.sendToClaude(
      workspace,
      `Commit the uncommitted changes in the ${name} repository only, whose worktree is ${repo.worktreePath}: stage them with git -C ${at} add -A and run git -C ${at} commit with a message you write from that repository's changes.${prefix} Don't commit in the workspace's other repositories.`,
    );
  }

  /** A suspended Claude resumes first (spec §9.8). */
  private sendToClaude(workspace: Workspace, prompt: string): Promise<void> {
    return this.terminals.sendToClaude(workspace.id, prompt);
  }

  /**
   * Checks the PR state of every repository (spec §12.3, §21.5): the PR
   * status command when set, otherwise git alone after `git fetch --prune`.
   * Stores them and returns the main repository's.
   */
  refreshPr(workspaceId: string): Promise<PrStatus | null> {
    let running = this.checking.get(workspaceId);
    if (!running) {
      running = this.checkPr(workspaceId).finally(() => this.checking.delete(workspaceId));
      this.checking.set(workspaceId, running);
    }
    return running;
  }

  /**
   * Every workspace, one after another (the 5-minute round and focus): its
   * PRs where it has a remote, and where each branch is merged (§14.2).
   */
  async refreshAll(): Promise<void> {
    for (const workspace of this.records.list()) {
      await this.refreshPr(workspace.id).catch(() => {});
    }
  }

  private async checkPr(workspaceId: string): Promise<PrStatus | null> {
    const workspace = this.workspace(workspaceId);
    let main: PrStatus | null = null;
    let failure: unknown = null;
    for (const repo of workspace.repos) {
      try {
        const pr = await this.checkRepoPr(workspaceId, repo.projectId);
        if (repo.primary) main = pr;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return main;
  }

  private async checkRepoPr(workspaceId: string, projectId: string): Promise<PrStatus | null> {
    const { workspace, repo, project, profile, git } = await this.context(workspaceId, projectId);
    if (!project.remote) {
      // Where its branch is merged, for Home, also without a remote (§14.2).
      await refreshMerged(git, this.records, workspace, repo, project).catch(() => {});
      return null;
    }
    const settings = prSettings(profile, project);
    const dir = repo.worktreePath;
    let pr: PrStatus | null;
    if (settings.statusCommand) {
      const { shell, env } = await this.terminals.workspaceCommandEnv(workspace, projectId);
      const out = await runJsonCommand(
        shell,
        settings.statusCommand,
        dir,
        env,
        settings.timeoutSec,
      );
      pr = parsePrStatus(out);
    } else {
      pr = await this.gitPrStatus(git, project.remote, workspace, repo);
    }
    const head = await git.revParse(dir, 'HEAD');
    const start = await git.ownStart(dir, {
      branch: workspace.branch,
      start: this.records.startCommit(workspace.id, projectId),
      base: repo.baseBranch,
      remote: project.remote,
    });
    const hasCommits = head !== null && start !== null && head !== start;
    // After the PR check's fetch, so `<remote>/<base>` is fresh (§14.2); before
    // the PR is stored, so a check joined once the badge changes is a new one.
    await refreshMerged(git, this.records, workspace, repo, project).catch(() => {});
    this.records.setPr(workspace.id, pr, { projectId, hasCommits });
    return pr;
  }

  /**
   * The git-only fallback (spec §12.3): a pushed branch whose remote branch is
   * gone is Likely merged; a branch with its own commits that is contained in
   * `<remote>/<base>` is Merged; otherwise nothing is known.
   */
  private async gitPrStatus(
    git: Git,
    remote: string,
    workspace: Workspace,
    repo: WorkspaceRepo,
  ): Promise<PrStatus | null> {
    const dir = repo.worktreePath;
    const repoKey = repo.projectId;
    if (Date.now() - (this.lastFetch.get(repoKey) ?? 0) > FETCH_EVERY_MS) {
      await git.run(dir, ['fetch', '--quiet', '--prune', remote]);
      this.lastFetch.set(repoKey, Date.now());
    }
    const head = await git.revParse(dir, 'HEAD');
    const pushed = Boolean(await git.tryRun(dir, ['config', `branch.${workspace.branch}.remote`]));
    const remoteBranch = await git.revParse(dir, `refs/remotes/${remote}/${workspace.branch}`);
    if (pushed && !remoteBranch) return { state: 'likely-merged', url: null, source: 'git' };
    // Its own commits only: not those it caught up with from the base (§14.2).
    const start = await git.ownStart(dir, {
      branch: workspace.branch,
      start: this.records.startCommit(workspace.id, repo.projectId),
      base: repo.baseBranch,
      remote,
    });
    const hasOwnCommits = head !== null && (start ? head !== start : pushed);
    const base = `refs/remotes/${remote}/${repo.baseBranch}`;
    if (head && hasOwnCommits && (await git.revParse(dir, base))) {
      const contained = await git.tryRun(dir, ['merge-base', '--is-ancestor', head, base]);
      if (contained !== null) return { state: 'merged', url: null, source: 'git' };
    }
    return null;
  }

  private workspace(workspaceId: string): Workspace {
    const workspace = this.records.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace "${workspaceId}"`);
    return workspace;
  }

  private repoOf(workspace: Workspace, projectId: string | null): WorkspaceRepo {
    const repo = workspaceRepo(workspace, projectId);
    if (!repo) throw new Error(`${projectId} isn't part of this workspace`);
    return repo;
  }

  private projectName(projectId: string): string {
    return this.config.get().config?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  /** A workspace and one of its repositories (the main one for null), with git for it. */
  private async context(workspaceId: string, projectId: string | null = null) {
    const workspace = this.workspace(workspaceId);
    const repo = this.repoOf(workspace, projectId);
    const config = this.config.require();
    const project = config.projects.find((p) => p.id === repo.projectId);
    if (!project) throw new Error(`Unknown project "${repo.projectId}"`);
    const profile = config.profiles.find((p) => p.id === workspace.profileId);
    if (!profile) throw new Error(`Unknown profile "${workspace.profileId}"`);
    // The workspace environment: that project's (or the profile's) commit identity applies.
    const { env } = await this.terminals.workspaceCommandEnv(workspace, repo.projectId);
    const gitPath = resolveExecutable('git', env);
    if (!gitPath) throw new Error('git was not found on the PATH of your login shell');
    return { workspace, repo, project, profile, env, git: new Git({ gitPath, env }) };
  }
}

/** Runs a command that prints JSON; a failure, timeout or bad JSON throws with its output. */
async function runJsonCommand(
  shell: string,
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutSec = DEFAULT_COMMAND_TIMEOUT_SEC,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-c', command],
      { cwd, env, timeout: timeoutSec * 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = (error as { killed?: boolean }).killed;
          reject(
            new Error(
              timedOut
                ? `The PR status command timed out after ${timeoutSec} s`
                : `The PR status command failed: ${stderr.trim() || error.message}`,
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

/** The PR status command's output (spec §12.3): one JSON object, or nothing / `null`. */
export function parsePrStatus(output: string): PrStatus | null {
  const text = output.trim();
  if (!text || text === 'null') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The PR status command didn't print JSON: ${text.slice(0, 200)}`);
  }
  if (value === null) return null;
  const v = value as { state?: unknown; url?: unknown };
  const states = ['open', 'draft', 'merged', 'closed'];
  if (typeof v.state !== 'string' || !states.includes(v.state)) {
    throw new Error(`The PR status command printed an unknown state: ${JSON.stringify(v.state)}`);
  }
  return {
    state: v.state as PrStatus['state'],
    url: typeof v.url === 'string' ? v.url : null,
    source: 'command',
  };
}

/**
 * Checks where a repository's branch is merged (spec §14.2) and stores it
 * with whether the branch has commits of its own; returns it.
 */
export async function refreshMerged(
  git: Git,
  records: WorkspaceRecords,
  workspace: Workspace,
  repo: WorkspaceRepo,
  project: Project,
): Promise<MergedInto | null> {
  const repoPath = expandHome(project.repoPath);
  const refs = { branch: workspace.branch, base: repo.baseBranch, remote: project.remote };
  const recorded = records.startCommit(workspace.id, repo.projectId);
  const head = await git.revParse(repoPath, `refs/heads/${workspace.branch}`);
  const merged = await git.mergedInto(repoPath, { ...refs, start: recorded });
  // Its own commits only, not those it caught up with from the base (§14.2).
  const start = await git.ownStart(repoPath, { ...refs, start: recorded });
  // Without a remote, nothing else records whether it has commits (§21.5).
  const hasCommits = head === null || start === null ? repo.hasCommits : head !== start;
  records.setMerged(workspace.id, repo.projectId, merged, hasCommits);
  return merged;
}
