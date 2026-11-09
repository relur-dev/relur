import { envVar } from '@shared/brand';
import {
  type BaseConflicts,
  type ChangeGroup,
  type FileDiff,
  PUSH_REJECTED,
  type WorkspaceChanges,
} from '@shared/changes';
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
  /** A PR create or status command is set: the repository uses pull requests (spec §6.7). */
  usesPrs: boolean;
  /** The branch has commits of its own (spec §14.2): Create PR has something to open. */
  hasOwnCommits: boolean;
  /** What the branch is compared with: `<remote>/<base>`, or the local base (spec §6.4). */
  baseRef: string;
  /** Commits of the base the branch doesn't have yet. */
  behind: number;
  /** Files merging the base in would conflict in; null when git can't tell. */
  conflicts: string[] | null;
  /** The remote branch it tracks (`origin/feature-x`), when it has one. */
  upstream: string | null;
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

/** A repository's createPrompt filled in with its own base (spec §14.1). */
function createPrompt(workspace: Workspace, repo: WorkspaceRepo, settings: PrSettings): string {
  return fillTemplate(settings.createPrompt ?? DEFAULT_CREATE_PR_PROMPT, {
    base: repo.baseBranch,
    branch: workspace.branch,
    id: workspace.task.id ?? '',
    title: workspace.task.title || workspace.name,
    url: workspace.task.url ?? '',
  });
}

/** Spec §7.6: a branch that existed before may have its pull request already. */
const existedNote = (repo: WorkspaceRepo) =>
  (repo.branchOrigin ?? 'new') === 'new'
    ? ''
    : " This branch existed before the workspace: if it already has a pull request, don't open another; tell me its URL.";

/** What Create PRs needs to know about one repository (spec §21.5). */
export interface RepoPrFacts {
  projectId: string;
  name: string;
  hasRemote: boolean;
  hasOwnCommits: boolean;
  pr: PrStatus | null;
  uncommitted: number;
  pushed: boolean;
  unpushed: number;
}

/** What Create PRs did (spec §21.5). */
export interface CreateAllResult {
  /** The repositories pushed first, by name. */
  pushed: string[];
  /** Each create command's result, by repository. */
  commands: { projectId: string; name: string; result: CommandResult }[];
  /** The repositories Claude was asked to open a pull request in. */
  claude: string[];
  /** The repositories left out, with why. */
  skipped: { name: string; reason: string }[];
}

/**
 * Which repositories Create PRs opens a pull request in (spec §21.5): those
 * with a remote, commits of their own and no known PR; the others are skipped.
 */
export function planPrs(repos: RepoPrFacts[]): {
  create: RepoPrFacts[];
  skipped: { name: string; reason: string }[];
} {
  const create: RepoPrFacts[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const r of repos) {
    if (!r.hasRemote) skipped.push({ name: r.name, reason: 'no remote' });
    else if (r.pr) skipped.push({ name: r.name, reason: 'has a pull request' });
    else if (!r.hasOwnCommits) skipped.push({ name: r.name, reason: 'no commits of its own' });
    else create.push(r);
  }
  return { create, skipped };
}

/**
 * Create PRs' one prompt to Claude (spec §21.5): each repository's own
 * create prompt with its name and worktree, the pull requests already
 * known, and to link them all to each other.
 */
export function allPrsPrompt({
  branch,
  repos,
  known,
}: {
  branch: string;
  repos: { name: string; worktreePath: string; prompt: string; existed: boolean }[];
  known: { name: string; url: string }[];
}): string {
  const each = repos
    .map(
      (r, i) =>
        `${i + 1}. In the ${r.name} repository, whose worktree is ${r.worktreePath}: ${r.prompt}${
          r.existed
            ? " This branch existed there before the workspace: if it already has a pull request, don't open another; use that one."
            : ''
        }`,
    )
    .join(' ');
  const already =
    known.length > 0
      ? ` These pull requests of the task are open already: ${known.map((k) => `${k.name} ${k.url}`).join('; ')}.`
      : '';
  const one = repos.length === 1;
  return `This task changes several repositories, all on the branch ${branch}. Open a pull request in ${
    one ? 'this one' : `each of these ${repos.length}`
  }, each from its own worktree: ${each}${already} Then link the pull requests to each other: add the URLs of the task's other pull requests to each one's description, so every pull request points to all the others. Tell me their URLs.`;
}

/** Whether the branch was pushed (it has an upstream), and its commits not on the remote. */
async function pushState(
  git: Git,
  workspace: Workspace,
  project: Project,
  dir: string,
): Promise<{ pushed: boolean; unpushed: number }> {
  if (!project.remote) return { pushed: false, unpushed: 0 };
  const upstream = await git.revParse(dir, `refs/remotes/${project.remote}/${workspace.branch}`);
  const pushed = Boolean(await git.tryRun(dir, ['config', `branch.${workspace.branch}.remote`]));
  const out = upstream
    ? await git.run(dir, ['rev-list', '--count', `${upstream}..HEAD`])
    : await git.run(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  return { pushed, unpushed: Number(out.trim()) };
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
    return `${remote} ${PUSH_REJECTED}: its branch has commits this one doesn't (someone else pushed?). Merge them in first: ask Claude to, or pull in a Shell tab. Don't force-push a branch others use.\n\n${detail}`;
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
  /** When each project's base was last fetched for behind and conflicts (spec §6.4). */
  private readonly lastBaseFetch = new Map<string, number>();
  /** The last conflict check per worktree, kept while HEAD and the base stay put. */
  private readonly conflictChecks = new Map<string, { key: string; conflicts: string[] | null }>();

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
    const { pushed, unpushed } = await pushState(git, workspace, project, dir);
    const tracks = await git.upstream(dir, workspace.branch);
    const settings = prSettings(profile, project);
    return {
      ...(await this.baseStatus(git, project, repo)),
      upstream: tracks ? `${tracks.remote}/${tracks.branch}` : null,
      hasRemote: project.remote !== null,
      remote: project.remote,
      uncommitted,
      unpushed,
      pushed,
      commitMessage: commitMessage(workspace),
      pr: project.remote ? repo.pr : null,
      createsWithCommand: Boolean(settings.createCommand),
      usesPrs: Boolean(settings.createCommand || settings.statusCommand),
      hasOwnCommits: await this.hasOwnCommits(git, workspace, repo, project),
    };
  }

  /** Whether a repository's branch has commits of its own (spec §14.2): its tip isn't its own start. */
  private async hasOwnCommits(
    git: Git,
    workspace: Workspace,
    repo: WorkspaceRepo,
    project: Project,
  ): Promise<boolean> {
    const dir = repo.worktreePath;
    const head = await git.revParse(dir, 'HEAD');
    const start = await git.ownStart(dir, {
      branch: workspace.branch,
      start: this.records.startCommit(workspace.id, repo.projectId),
      base: repo.baseBranch,
      remote: project.remote,
    });
    return head !== null && start !== null && head !== start;
  }

  /**
   * A PR command's shell and environment (spec §12.4, §21.5): the
   * workspace's, with the base branch and worktree of the repository it runs
   * for, since a linked repository's differ from the main one's.
   */
  private async prCommandEnv(workspace: Workspace, repo: WorkspaceRepo) {
    const { shell, env } = await this.terminals.workspaceCommandEnv(workspace, repo.projectId);
    env[envVar('BASE_BRANCH')] = repo.baseBranch;
    env[envVar('WORKTREE_PATH')] = repo.worktreePath;
    return { shell, env };
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

  /**
   * Behind and conflicts with the base (spec §6.4): how many commits the
   * base has that the branch doesn't, and the files a merge would conflict
   * in (checked again only when HEAD or the base moved). The base is fetched
   * in the background, at most once a minute per project.
   */
  private async baseStatus(
    git: Git,
    project: Project,
    repo: WorkspaceRepo,
  ): Promise<{ baseRef: string; behind: number; conflicts: string[] | null }> {
    const dir = repo.worktreePath;
    if (project.remote) {
      const key = `${project.id}\0${repo.baseBranch}`;
      if (Date.now() - (this.lastBaseFetch.get(key) ?? 0) > FETCH_EVERY_MS) {
        this.lastBaseFetch.set(key, Date.now());
        void git
          .fetch(expandHome(project.repoPath), project.remote, repo.baseBranch)
          .catch(() => {});
      }
    }
    const ref = await baseRef(git, project, repo);
    const [head, base] = await Promise.all([git.revParse(dir, 'HEAD'), git.revParse(dir, ref)]);
    if (!head || !base) return { baseRef: ref, behind: 0, conflicts: null };
    const behind = await git.behind(dir, ref);
    if (behind === 0) return { baseRef: ref, behind, conflicts: [] };
    const key = `${head}\0${base}`;
    const known = this.conflictChecks.get(dir);
    if (known?.key === key) return { baseRef: ref, behind, conflicts: known.conflicts };
    const conflicts = await git.mergeConflicts(dir, ref);
    this.conflictChecks.set(dir, { key, conflicts });
    return { baseRef: ref, behind, conflicts };
  }

  /** Each repository's conflicts with its base, for the header's mark (spec §6.2). */
  async conflicts(workspaceId: string): Promise<BaseConflicts[]> {
    const workspace = this.workspace(workspaceId);
    const out: BaseConflicts[] = [];
    for (const r of workspace.repos) {
      const { repo, project, git } = await this.context(workspaceId, r.projectId);
      const status = await this.baseStatus(git, project, repo).catch(() => null);
      if (status?.conflicts?.length) {
        out.push({
          projectId: r.projectId,
          name: project.name,
          baseBranch: repo.baseBranch,
          files: status.conflicts,
        });
      }
    }
    return out;
  }

  /**
   * Ask Claude to merge (spec §6.4, §14.1): the base, or the remote branch
   * the branch tracks after a rejected push, into the branch, resolving
   * conflicts; never a rebase or force-push, since others may use the branch.
   */
  async askClaudeToMerge(
    workspaceId: string,
    from: 'base' | 'upstream',
    projectId: string | null = null,
  ): Promise<void> {
    const { workspace, repo, project, git } = await this.context(workspaceId, projectId);
    let fetch: string | null = null;
    let target: string;
    if (from === 'base') {
      target = await baseRef(git, project, repo);
      if (project.remote && target !== repo.baseBranch) {
        fetch = `git fetch ${project.remote} ${repo.baseBranch}`;
      }
    } else {
      const up = await git.upstream(repo.worktreePath, workspace.branch);
      if (!up) throw new Error(`${workspace.branch} doesn't track a remote branch`);
      target = `${up.remote}/${up.branch}`;
      fetch = `git fetch ${up.remote} ${up.branch}`;
    }
    const linked = workspace.repos.length > 1;
    const at = shellQuote(repo.worktreePath);
    const g = linked ? `git -C ${at}` : 'git';
    const where = linked
      ? ` in the ${this.projectName(repo.projectId)} repository only, whose worktree is ${repo.worktreePath}`
      : '';
    const steps = fetch
      ? `run ${fetch.replace(/^git/, g)}, then ${g} merge ${target}`
      : `run ${g} merge ${target}`;
    await this.sendToClaude(
      workspace,
      `Merge ${target} into ${workspace.branch}${where}: ${steps}. Resolve any conflicts so that both sides' changes keep working, run the project's checks, and commit the merge.${
        from === 'upstream' ? ' Then push.' : ''
      } Don't rebase and don't force-push: others may have this branch checked out, and its pull request would lose its history.`,
    );
  }

  /**
   * Push (spec §14.1): to the remote branch the branch tracks, when it has
   * one (an existing branch, §7.6, may track another remote), else
   * `git push -u <remote> <branch>`; then the PR status is checked again.
   */
  async push(workspaceId: string, projectId: string | null = null): Promise<void> {
    await this.pushOnly(workspaceId, projectId);
    void this.refreshPr(workspaceId).catch(() => {});
  }

  /** Push without checking the PR status after it (Create PRs checks once at the end). */
  private async pushOnly(workspaceId: string, projectId: string | null): Promise<void> {
    const { workspace, repo, project, git } = await this.context(workspaceId, projectId);
    if (!project.remote) throw new Error('This project has no remote');
    const dir = repo.worktreePath;
    const up = await git.upstream(dir, workspace.branch);
    const tracked = up && (await git.remotes(dir)).includes(up.remote) ? up : null;
    const remote = tracked?.remote ?? project.remote;
    try {
      await git.run(
        dir,
        tracked
          ? ['push', tracked.remote, `${workspace.branch}:${tracked.branch}`]
          : ['push', '-u', project.remote, workspace.branch],
      );
    } catch (error) {
      const stderr = error instanceof GitError ? error.stderr : String(error);
      throw new Error(pushProblem(remote, stderr));
    }
  }

  /**
   * The pull request of a branch without a workspace yet (spec §7.6), from
   * the PR status command run in the main checkout with the branch's
   * variables; null without a command, a PR or an answer.
   */
  async branchPr(
    projectId: string,
    branch: string,
    baseBranch: string,
  ): Promise<{ title: string | null; url: string | null } | null> {
    const config = this.config.require();
    const project = config.projects.find((p) => p.id === projectId);
    const profile = config.profiles.find((p) => p.id === project?.profileId);
    if (!project || !profile || !project.remote) return null;
    const settings = prSettings(profile, project);
    if (!settings.statusCommand) return null;
    const { shell, env, cwd } = await this.terminals.branchCommandEnv(
      projectId,
      branch,
      baseBranch,
    );
    const out = await runJsonCommand(shell, settings.statusCommand, cwd, env, settings.timeoutSec);
    const { status, title } = parsePrOutput(out);
    return status ? { title, url: status.url } : null;
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
      const result = await this.runCreateCommand(workspace, repo, settings);
      void this.refreshAfter(workspaceId).catch(() => {});
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
    const filled = createPrompt(workspace, repo, settings);
    await this.sendToClaude(
      workspace,
      `${linked.before}${filled}${linked.after}${existedNote(repo)}`,
    );
    return { via: 'claude' };
  }

  private runCreateCommand(
    workspace: Workspace,
    repo: WorkspaceRepo,
    settings: PrSettings,
  ): Promise<CommandResult> {
    return this.prCommandEnv(workspace, repo).then(({ shell, env }) =>
      runCommands({
        shell,
        commands: [settings.createCommand ?? ''],
        cwd: repo.worktreePath,
        env,
        timeoutSec: settings.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
        label: 'Create PR',
      }),
    );
  }

  /**
   * Create PRs (spec §21.5): a pull request in every repository of the
   * workspace with commits of its own and none known yet, the others
   * skipped. Uncommitted files refuse it; unpushed commits are pushed first,
   * stopping at the first push that fails. Repositories with a create
   * command run it, one after another; the rest go to Claude in one prompt
   * that also asks it to link the pull requests to each other.
   */
  async createAllPrs(workspaceId: string): Promise<CreateAllResult> {
    const workspace = this.workspace(workspaceId);
    const facts: RepoPrFacts[] = [];
    for (const r of workspace.repos) {
      const { repo, project, git } = await this.context(workspaceId, r.projectId);
      const dir = repo.worktreePath;
      facts.push({
        projectId: repo.projectId,
        name: project.name,
        hasRemote: project.remote !== null,
        hasOwnCommits: await this.hasOwnCommits(git, workspace, repo, project),
        pr: project.remote ? repo.pr : null,
        uncommitted: (await git.status(dir)).length,
        ...(await pushState(git, workspace, project, dir)),
      });
    }
    const { create, skipped } = planPrs(facts);
    if (create.length === 0) throw new Error('No repository needs a pull request');
    const dirty = create.filter((f) => f.uncommitted > 0).map((f) => f.name);
    if (dirty.length > 0) throw new Error(`Commit first in ${dirty.join(', ')}`);
    const pushed: string[] = [];
    for (const f of create.filter((f) => !f.pushed || f.unpushed > 0)) {
      try {
        await this.pushOnly(workspaceId, f.projectId);
      } catch (error) {
        const done = pushed.length > 0 ? ` (${pushed.join(', ')} pushed)` : '';
        throw new Error(
          `Push failed in ${f.name}${done}: ${error instanceof Error ? error.message : error}`,
        );
      }
      pushed.push(f.name);
    }
    const commands: CreateAllResult['commands'] = [];
    const viaClaude: { repo: WorkspaceRepo; settings: PrSettings; name: string }[] = [];
    for (const f of create) {
      const { repo, profile, project } = await this.context(workspaceId, f.projectId);
      const settings = prSettings(profile, project);
      if (settings.createCommand) {
        const result = await this.runCreateCommand(workspace, repo, settings);
        commands.push({ projectId: f.projectId, name: f.name, result });
      } else viaClaude.push({ repo, settings, name: f.name });
    }
    if (viaClaude.length > 0) {
      // The PRs the commands just opened are known by then, for Claude to link.
      if (commands.length > 0) await this.refreshAfter(workspaceId).catch(() => {});
      const now = this.workspace(workspaceId);
      const asked = new Set(viaClaude.map((v) => v.repo.projectId));
      await this.sendToClaude(
        now,
        allPrsPrompt({
          branch: now.branch,
          repos: viaClaude.map((v) => ({
            name: v.name,
            worktreePath: v.repo.worktreePath,
            prompt: createPrompt(now, v.repo, v.settings),
            existed: (v.repo.branchOrigin ?? 'new') !== 'new',
          })),
          known: now.repos
            .filter((r) => !asked.has(r.projectId) && r.pr?.url)
            .map((r) => ({ name: this.projectName(r.projectId), url: r.pr?.url ?? '' })),
        }),
      );
    } else void this.refreshAfter(workspaceId).catch(() => {});
    return { pushed, commands, claude: viaClaude.map((v) => v.name), skipped };
  }

  /** A PR check that starts after any running one, so it sees what was just done. */
  private async refreshAfter(workspaceId: string): Promise<PrStatus | null> {
    await this.checking.get(workspaceId)?.catch(() => {});
    return this.refreshPr(workspaceId);
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
      const { shell, env } = await this.prCommandEnv(workspace, repo);
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
    const hasCommits = await this.hasOwnCommits(git, workspace, repo, project);
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
  return parsePrOutput(output).status;
}

/** The PR status command's output with its optional `title` (spec §12.3, §7.6). */
export function parsePrOutput(output: string): { status: PrStatus | null; title: string | null } {
  const status = parseStatus(output);
  if (!status) return { status, title: null };
  const title = (JSON.parse(output.trim()) as { title?: unknown }).title;
  return { status, title: typeof title === 'string' && title.trim() ? title.trim() : null };
}

function parseStatus(output: string): PrStatus | null {
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
