import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BRAND } from '@shared/brand';
import { prText } from '@shared/home';
import {
  type BaseCheckout,
  type DivergedMode,
  type MergeDecision,
  type MergeFacts,
  type MergeRepoStatus,
  type MergeResult,
  type MergeStatus,
  mergeDecision,
  NOT_READY_PREFIX,
  notReadyReason,
  READY_LINE,
} from '@shared/merge';
import { shellQuote } from '@shared/shell';
import { atMenu } from '@shared/status';
import type { Workspace, WorkspaceRepo } from '@shared/workspaces';
import type { WorkspaceRecords } from '../db/workspaces';
import { type Git, gitReason } from '../git/git';
import { expandHome } from '../paths';
import type { ConversationEvent } from '../status/service';
import { type FinishService, refreshMerged } from './finish';

/** One repository of a merge prompt. */
export interface PromptRepo {
  name: string;
  worktree: string;
  base: string;
}

const LAST_LINE = (done: string) =>
  `End your last message with one line: "${READY_LINE}" when ${done} and the checks pass, or "${NOT_READY_PREFIX} <reason>" otherwise.`;

/**
 * What Claude is asked when the base has moved on (spec §14.4): rebase the
 * branch onto the local base (or merge the base in, for a published branch),
 * resolve conflicts, run the checks, commit, and end with a line the app
 * reads. A linked workspace gets one prompt for every repository that needs it,
 * each named with its worktree (`git -C`), since Claude works in the main one.
 */
export function mergePrompt(
  branch: string,
  mode: DivergedMode,
  repos: PromptRepo[],
  linked: boolean,
): string {
  const app = BRAND.displayName;
  const [only] = repos;
  if (!linked && only) {
    const { base } = only;
    const local = `(the local branch: don't fetch, and don't use the remote's ${base})`;
    if (mode === 'rebase') {
      return `Rebase ${branch} onto the local ${base} branch so that ${base} can be fast-forwarded to it: run git rebase ${base} ${local}. Resolve any conflicts so that both sides' changes keep working, and continue until the rebase is done. Then run the project's checks as its CLAUDE.md says, fix what fails, and commit the fixes. Don't merge ${base} into the branch, don't push, and don't touch the main checkout or the ${base} branch: ${app} fast-forwards ${base} when you're done. ${LAST_LINE('the rebase is done')}`;
    }
    return `Merge the local ${base} branch into ${branch} so that ${base} can be fast-forwarded to it: run git merge ${base} ${local}. Resolve any conflicts so that both sides' changes keep working, and commit the merge. Then run the project's checks as its CLAUDE.md says, fix what fails, and commit the fixes. Don't rebase and don't push: the branch is published. Don't touch the main checkout or the ${base} branch: ${app} fast-forwards ${base} when you're done. ${LAST_LINE('the merge is committed')}`;
  }
  const verb = mode === 'rebase' ? 'rebase' : 'merge';
  const these = repos.length === 1 ? 'this repository' : 'these repositories';
  const list = repos
    .map(
      (r) =>
        `${r.name} (worktree ${r.worktree}): run git -C ${shellQuote(r.worktree)} ${verb} ${r.base}`,
    )
    .join('; ');
  const lead =
    mode === 'rebase'
      ? `Rebase ${branch} onto its local base branch in ${these}, so that each base can be fast-forwarded to it: ${list}.`
      : `Merge each repository's local base branch into ${branch} in ${these}, so that each base can be fast-forwarded to it: ${list}.`;
  const dont =
    mode === 'rebase'
      ? `Don't merge the bases into the branch, don't push`
      : `Don't rebase and don't push: the branch is published`;
  return `${lead} Use the local base branches: don't fetch, and don't use the remote's. Resolve any conflicts so that both sides' changes keep working, and ${
    mode === 'rebase' ? 'continue until each rebase is done' : 'commit each merge'
  }. Then run each repository's checks as its CLAUDE.md says, fix what fails, and commit the fixes in that repository. Don't change the workspace's other repositories. ${dont}, and don't touch the main checkouts or the base branches: ${app} fast-forwards them when you're done. ${LAST_LINE(
    mode === 'rebase' ? 'every rebase is done' : 'every merge is committed',
  )}`;
}

/** Where `base` is checked out among the repository's worktrees (spec §14.4). */
export async function baseCheckout(
  git: Git,
  repoPath: string,
  base: string,
): Promise<BaseCheckout> {
  const worktrees = await git.listWorktrees(repoPath);
  const at = worktrees.find((w) => w.branch === base && !w.prunable);
  if (!at) return { kind: 'none' };
  const main = worktrees[0];
  if (main && !main.bare && path.resolve(main.path) === path.resolve(at.path)) {
    // Untracked files don't count: git refuses by itself to overwrite one.
    const dirty = (await git.status(at.path)).some((l) => !l.startsWith('??'));
    return { kind: 'main', path: at.path, dirty };
  }
  return { kind: 'other', path: at.path };
}

/** A repository the app waits on while Claude brings its branch up to the base. */
interface WaitRepo {
  projectId: string;
  /** The local base's tip when Claude was asked: a move afterwards is named. */
  baseTip: string | null;
}

interface Wait {
  mode: DivergedMode;
  repos: WaitRepo[];
  /** Claude took the prompt (Working); Done before that is the old turn's. */
  sawWorking: boolean;
  /** Claude's last message at Stop. */
  lastMessage: string | null;
}

/** What the merge service needs from the status service. */
export interface ClaudeEvents {
  onConversation(listener: (event: ConversationEvent) => void): () => void;
}

/**
 * Merge into the base (spec §14.4): fast-forwards each repository's local
 * base, in the main checkout only when the base is checked out there and it
 * is clean, else by ref when it is checked out nowhere; never pushes. A
 * diverged branch goes to Claude, and the app tries once more when Claude's
 * turn ends, without looping.
 */
export class MergeService {
  private readonly events = new EventEmitter();
  private readonly statuses = new Map<string, MergeStatus>();
  private readonly waits = new Map<string, Wait>();
  /** Workspaces whose merge is being run (not waiting). */
  private readonly running = new Set<string>();

  constructor(
    private readonly records: WorkspaceRecords,
    private readonly finish: FinishService,
    private readonly send: (workspaceId: string, prompt: string) => Promise<void>,
    claude: ClaudeEvents,
  ) {
    records.onChange(() => this.followStates());
    claude.onConversation((e) => {
      const wait = this.waits.get(e.workspaceId);
      if (wait && e.event === 'Stop') wait.lastMessage = e.text;
    });
  }

  /** Every workspace's merge status, for the Changes panel and Home. */
  list(): MergeStatus[] {
    return [...this.statuses.values()];
  }

  onChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  /** Forgets a finished merge's outcome. */
  dismiss(workspaceId: string): void {
    if (this.waits.has(workspaceId)) return;
    if (this.statuses.delete(workspaceId)) this.changed();
  }

  /** Stops waiting for Claude (spec §14.4); Claude itself goes on with its turn. */
  cancel(workspaceId: string): void {
    this.waits.delete(workspaceId);
    if (this.statuses.delete(workspaceId)) this.changed();
  }

  /**
   * Merge (spec §14.4): every repository of the workspace, or the one of
   * `projectId`. Checks all of them first: a refusal anywhere changes
   * nothing. `diverged` is the user's answer for a published branch.
   */
  async merge(
    workspaceId: string,
    projectId: string | null = null,
    diverged: DivergedMode | null = null,
  ): Promise<MergeResult> {
    if (this.running.has(workspaceId) || this.waits.has(workspaceId)) {
      throw new Error('A merge is already under way in this workspace');
    }
    const workspace = this.workspace(workspaceId);
    if (workspace.state === 'working') {
      throw new Error("Claude is working in this workspace: merge once it's done");
    }
    if (atMenu(workspace.state)) {
      throw new Error('Claude is waiting for an answer in this workspace: answer it first');
    }
    this.running.add(workspaceId);
    // The last merge's outcome makes way for this one's.
    if (this.statuses.delete(workspaceId)) this.changed();
    try {
      return await this.run(workspace, projectId, diverged);
    } finally {
      this.running.delete(workspaceId);
    }
  }

  private async run(
    workspace: Workspace,
    projectId: string | null,
    diverged: DivergedMode | null,
  ): Promise<MergeResult> {
    const repos = projectId
      ? workspace.repos.filter((r) => r.projectId === projectId)
      : workspace.repos;
    const plans: { repo: WorkspaceRepo; facts: MergeFacts | null; decision: MergeDecision }[] = [];
    for (const repo of repos) {
      const facts = await this.facts(workspace, repo);
      plans.push({ repo, facts, decision: facts ? mergeDecision(facts, diverged) : noBase(repo) });
    }
    const status = (phase: MergeStatus['phase'], rs: MergeRepoStatus[]): MergeStatus => ({
      workspaceId: workspace.id,
      phase,
      mode: diverged ?? 'rebase',
      repos: rs,
    });
    const entry = (
      p: (typeof plans)[number],
      phase: MergeRepoStatus['phase'],
      reason: string | null = null,
    ): MergeRepoStatus => ({
      projectId: p.repo.projectId,
      name: p.facts?.name ?? p.repo.projectId,
      base: p.repo.baseBranch,
      phase,
      reason,
    });
    // A refusal anywhere changes nothing anywhere; the button shows why.
    const refused = plans.flatMap((p) =>
      p.decision.action === 'refuse' ? [p.decision.reason] : [],
    );
    if (refused.length > 0) return { kind: 'stopped', reason: refused.join('; ') };
    const todo = plans.filter((p) => p.decision.action !== 'skip');
    if (todo.length === 0) {
      const reason = plans.map((p) => (p.decision as { reason: string }).reason).join('; ');
      return { kind: 'stopped', reason: `Nothing to merge: ${reason}` };
    }
    const ask = todo.find((p) => p.decision.action === 'ask');
    if (ask && ask.decision.action === 'ask') {
      return {
        kind: 'ask',
        branch: workspace.branch,
        base: ask.repo.baseBranch,
        published: ask.decision.published,
      };
    }
    const results = new Map<string, MergeRepoStatus>();
    for (const p of plans) {
      if (p.decision.action === 'skip') results.set(p.repo.projectId, entry(p, 'skipped'));
    }
    for (const p of todo) {
      if (p.decision.action !== 'fast-forward') continue;
      const failure = await this.fastForward(workspace, p.repo, p.decision.via);
      results.set(p.repo.projectId, entry(p, failure ? 'failed' : 'merged', failure));
    }
    const toClaude = todo.filter((p) => p.decision.action === 'claude');
    const mode = diverged ?? 'rebase';
    if (toClaude.length > 0) {
      const tips: WaitRepo[] = [];
      for (const p of toClaude) {
        const { git, project } = await this.finish.context(workspace.id, p.repo.projectId);
        tips.push({
          projectId: p.repo.projectId,
          baseTip: await git.revParse(
            expandHome(project.repoPath),
            `refs/heads/${p.repo.baseBranch}`,
          ),
        });
      }
      const prompt = mergePrompt(
        workspace.branch,
        mode,
        toClaude.map((p) => ({
          name: p.facts?.name ?? p.repo.projectId,
          worktree: p.repo.worktreePath,
          base: p.repo.baseBranch,
        })),
        workspace.repos.length > 1,
      );
      try {
        // Waiting starts before the prompt goes out, so its Working is seen.
        this.waits.set(workspace.id, {
          mode,
          repos: tips,
          sawWorking: false,
          lastMessage: null,
        });
        for (const p of toClaude) results.set(p.repo.projectId, entry(p, 'waiting'));
        this.set({ ...status('waiting', ordered(plans, results)), mode });
        await this.send(workspace.id, prompt);
        return { kind: 'waiting' };
      } catch (error) {
        this.waits.delete(workspace.id);
        const reason = error instanceof Error ? error.message : String(error);
        for (const p of toClaude) results.set(p.repo.projectId, entry(p, 'failed', reason));
      }
    }
    const final = ordered(plans, results);
    const failed = final.filter((r) => r.phase === 'failed');
    this.set({ ...status(failed.length ? 'stopped' : 'done', final), mode });
    return failed.length
      ? { kind: 'stopped', reason: failed.map((r) => r.reason).join('; ') }
      : { kind: 'merged' };
  }

  /** One repository's facts for the rules; null without a local base branch. */
  private async facts(workspace: Workspace, repo: WorkspaceRepo): Promise<MergeFacts | null> {
    const { git, project } = await this.finish.context(workspace.id, repo.projectId);
    const repoPath = expandHome(project.repoPath);
    const base = repo.baseBranch;
    const [baseTip, branchTip] = await Promise.all([
      git.revParse(repoPath, `refs/heads/${base}`),
      git.revParse(repoPath, `refs/heads/${workspace.branch}`),
    ]);
    if (!baseTip || !branchTip) return null;
    const merged = await refreshMerged(git, this.records, workspace, repo, project).catch(
      () => repo.merged,
    );
    const upstream = await git.upstream(repo.worktreePath, workspace.branch);
    const remoteBranch = project.remote
      ? await git.revParse(repoPath, `refs/remotes/${project.remote}/${workspace.branch}`)
      : null;
    const pr = repo.pr && (repo.pr.state === 'open' || repo.pr.state === 'draft') ? repo.pr : null;
    const where = upstream
      ? `${upstream.remote}/${upstream.branch}`
      : remoteBranch
        ? `${project.remote}/${workspace.branch}`
        : null;
    return {
      name: project.name,
      branch: workspace.branch,
      base,
      uncommitted: (await git.status(repo.worktreePath)).length,
      hasOwnCommits: await this.finish.hasOwnCommits(git, workspace, repo, project),
      merged: merged !== null,
      canFastForward: await git.isAncestor(repoPath, baseTip, branchTip),
      checkout: await baseCheckout(git, repoPath, base),
      published: where && pr ? `${where}, ${prText(pr)}` : (where ?? (pr ? prText(pr) : null)),
    };
  }

  /** Fast-forwards one repository's local base; git's reason when it refuses. */
  private async fastForward(
    workspace: Workspace,
    repo: WorkspaceRepo,
    via: 'checkout' | 'ref',
  ): Promise<string | null> {
    const { git, project } = await this.finish.context(workspace.id, repo.projectId);
    const repoPath = expandHome(project.repoPath);
    const base = repo.baseBranch;
    try {
      if (via === 'checkout') {
        const at = await baseCheckout(git, repoPath, base);
        if (at.kind !== 'main')
          throw new Error(`${base} is no longer checked out in the main checkout`);
        await git.fastForward(at.path, workspace.branch);
      } else {
        const old = await git.revParse(repoPath, `refs/heads/${base}`);
        const next = await git.revParse(repoPath, `refs/heads/${workspace.branch}`);
        if (!old || !next) throw new Error(`${base} or ${workspace.branch} is gone`);
        await git.updateBranch(repoPath, base, next, old);
      }
    } catch (error) {
      return `git refused to fast-forward ${base}: ${gitReason(error)}`;
    }
    await refreshMerged(git, this.records, workspace, repo, project).catch(() => {});
    return null;
  }

  /** Follows the waiting workspaces' states: Done after the prompt tries again (spec §14.4). */
  private followStates(): void {
    for (const [id, wait] of this.waits) {
      const w = this.records.get(id);
      if (!w) {
        this.waits.delete(id);
        this.statuses.delete(id);
        this.changed();
        continue;
      }
      if (w.state === 'working') wait.sawWorking = true;
      else if (w.state === 'interrupted')
        this.stop(id, 'Claude was interrupted before it finished');
      else if (w.state === 'exited' || w.state === 'error') {
        this.stop(id, 'Claude exited before it finished');
      } else if (w.state === 'done' && wait.sawWorking) {
        this.waits.delete(id);
        void this.retry(w, wait);
      }
    }
  }

  /** Ends a wait with one reason for every repository still waiting. */
  private stop(workspaceId: string, reason: string): void {
    this.waits.delete(workspaceId);
    const status = this.statuses.get(workspaceId);
    if (!status) return;
    this.set({
      ...status,
      phase: 'stopped',
      repos: status.repos.map((r) =>
        r.phase === 'waiting' ? { ...r, phase: 'failed', reason } : r,
      ),
    });
  }

  /** The one try after Claude's turn: never loops (spec §14.4). */
  private async retry(workspace: Workspace, wait: Wait): Promise<void> {
    const status = this.statuses.get(workspace.id);
    if (!status) return;
    this.running.add(workspace.id);
    const repos = [...status.repos];
    try {
      const said = notReadyReason(wait.lastMessage);
      for (const [i, r] of repos.entries()) {
        if (r.phase !== 'waiting') continue;
        const reason = await this.retryRepo(workspace, r, wait, said).catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        );
        repos[i] = { ...r, phase: reason ? 'failed' : 'merged', reason };
      }
    } finally {
      this.running.delete(workspace.id);
    }
    const failed = repos.some((r) => r.phase === 'failed');
    this.set({ ...status, phase: failed ? 'stopped' : 'done', repos });
  }

  /** Why one repository can't merge after Claude's turn, or null once it merged. */
  private async retryRepo(
    workspace: Workspace,
    r: MergeRepoStatus,
    wait: Wait,
    said: string | null,
  ): Promise<string | null> {
    const fresh = this.workspace(workspace.id);
    const repo = fresh.repos.find((x) => x.projectId === r.projectId);
    if (!repo) return 'The repository is no longer part of the workspace';
    const { git, project } = await this.finish.context(workspace.id, repo.projectId);
    const operation = await git.operationInProgress(repo.worktreePath);
    if (operation) {
      const files = await git.conflictedFiles(repo.worktreePath);
      return files.length
        ? `Conflicts left in ${files.join(', ')}`
        : `The ${operation} in the worktree isn't finished`;
    }
    if (said) return `Claude says it isn't ready: ${said}`;
    const facts = await this.facts(fresh, repo);
    if (!facts) return `There's no local ${repo.baseBranch} branch to merge into`;
    const decision = mergeDecision(facts, wait.mode);
    if (decision.action === 'refuse') return decision.reason;
    if (decision.action === 'skip') return facts.merged ? null : decision.reason;
    if (decision.action === 'fast-forward') {
      return this.fastForward(fresh, repo, decision.via);
    }
    const tip = await git.revParse(expandHome(project.repoPath), `refs/heads/${repo.baseBranch}`);
    const before = wait.repos.find((x) => x.projectId === repo.projectId)?.baseTip;
    return tip !== before
      ? `${repo.baseBranch} moved again while Claude worked: merge again`
      : `${workspace.branch} still doesn't contain ${repo.baseBranch}`;
  }

  private set(status: MergeStatus): void {
    this.statuses.set(status.workspaceId, status);
    this.changed();
  }

  private changed(): void {
    this.events.emit('change');
  }

  private workspace(workspaceId: string): Workspace {
    const workspace = this.records.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace "${workspaceId}"`);
    return workspace;
  }
}

/** A repository whose local base branch (or branch) is missing. */
const noBase = (repo: WorkspaceRepo): MergeDecision => ({
  action: 'refuse',
  reason: `There's no local ${repo.baseBranch} branch to merge into`,
});

/** The repositories' statuses in the workspace's order. */
function ordered(
  plans: { repo: WorkspaceRepo }[],
  results: Map<string, MergeRepoStatus>,
): MergeRepoStatus[] {
  return plans.flatMap((p) => {
    const r = results.get(p.repo.projectId);
    return r ? [r] : [];
  });
}
