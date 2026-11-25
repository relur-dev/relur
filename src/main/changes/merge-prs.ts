import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { BRAND, envVar } from '@shared/brand';
import {
  allowedMethods,
  CONFIRM_TIMEOUT_MS,
  chooseMergeMethod,
  defaultOrder,
  type LocalFacts,
  localProblems,
  MERGE_METHOD_LABEL,
  type MergePrsConfirmation,
  type MergePrsPreflight,
  type MergePrsReport,
  type MergePrsRequest,
  type MergePrsRun,
  orderProblem,
  parseMergeOutput,
  prProblems,
  type RepoMergeResult,
  type RepoPreflight,
  requestedByText,
  runMerges,
} from '@shared/merge-prs';
import { type MergeMethod, MergeMethodSchema } from '@shared/schemas';
import type { Workspace } from '@shared/workspaces';
import type { MergeCliRequest, MergeCliResponse } from '../bridge/server';
import { GitError } from '../git/git';
import { type FinishService, parsePrDetails, prSettings, runJsonCommand } from './finish';

/** A merge on the host may take a while; never less than this. */
const MIN_MERGE_TIMEOUT_SEC = 120;

const message = (error: unknown) =>
  error instanceof GitError
    ? error.stderr.trim() || error.message
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Merge all PRs (spec §21.10): checks every repository's pull request and
 * local branch, then merges them on their hosts one after another with the
 * PR merge command (§12.5), stopping at the first failure. One run per
 * workspace at a time; the last run's report is kept until dismissed.
 */
export class MergePrsService {
  private readonly runs = new Map<string, MergePrsRun>();
  private readonly events = new EventEmitter();
  /** Bridge merges waiting for a click in the app, one per workspace (spec §21.10). */
  private readonly confirmations = new Map<
    string,
    {
      info: MergePrsConfirmation;
      answer: (confirmed: MergePrsRequest | 'cancelled' | 'timeout') => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly confirmTimeoutMs: number;
  /** Brings the window forward when a bridge merge waits for its confirmation. */
  private readonly onConfirmRequested: (workspaceId: string) => void;

  constructor(
    private readonly finish: FinishService,
    private readonly workspace: (workspaceId: string) => Workspace | null,
    options: {
      confirmTimeoutMs?: number;
      onConfirmRequested?: (workspaceId: string) => void;
    } = {},
  ) {
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    this.onConfirmRequested = options.onConfirmRequested ?? (() => {});
  }

  list(): MergePrsRun[] {
    return [...this.runs.values()];
  }

  /** The bridge merges waiting for confirmation, and expired ones not yet dismissed. */
  pendingConfirmations(): MergePrsConfirmation[] {
    return [...this.confirmations.values()].map((c) => c.info);
  }

  /**
   * The dialog's Merge on a bridge merge (spec §21.10): the human click it
   * waits for, with the order, methods and branch choice as finally shown.
   */
  confirm(workspaceId: string, id: string, request: MergePrsRequest): void {
    const waiting = this.confirmations.get(workspaceId);
    if (!waiting || waiting.info.id !== id || waiting.info.state !== 'pending') {
      throw new Error('This request is no longer waiting: the command line stopped waiting');
    }
    const workspace = this.require(workspaceId);
    const refused = orderProblem(
      request.order,
      workspace.repos.map((r) => r.projectId),
    );
    if (refused) throw new Error(refused);
    this.settle(workspaceId, request);
  }

  /** The dialog closed without Merge: the command line is told so. */
  cancelConfirmation(workspaceId: string, id: string): void {
    const waiting = this.confirmations.get(workspaceId);
    if (!waiting || waiting.info.id !== id) return;
    if (waiting.info.state === 'expired') {
      this.confirmations.delete(workspaceId);
      this.events.emit('change');
      return;
    }
    this.settle(workspaceId, 'cancelled');
  }

  private settle(workspaceId: string, answer: MergePrsRequest | 'cancelled' | 'timeout'): void {
    const waiting = this.confirmations.get(workspaceId);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    if (answer === 'timeout') {
      // Kept as expired, so the open dialog says so until it is closed.
      waiting.info = { ...waiting.info, state: 'expired' };
    } else this.confirmations.delete(workspaceId);
    waiting.answer(answer);
    this.events.emit('change');
  }

  /**
   * Waits for the click in the app (spec §21.10): the window comes forward
   * and the workspace's dialog opens in confirm mode. One per workspace.
   */
  private waitForConfirmation(
    workspace: Workspace,
    request: MergePrsRequest,
    byClaude: boolean,
  ): Promise<MergePrsRequest | 'cancelled' | 'timeout'> {
    const known = this.confirmations.get(workspace.id);
    if (known?.info.state === 'pending') {
      throw new Error(
        `Merge all PRs is already waiting for confirmation in ${BRAND.displayName} for this workspace: confirm or cancel it there first`,
      );
    }
    if (known) clearTimeout(known.timer);
    return new Promise((answer) => {
      const info: MergePrsConfirmation = {
        id: randomUUID(),
        workspaceId: workspace.id,
        order: request.order,
        methods: request.methods,
        deleteBranch: request.deleteBranch,
        requestedBy: requestedByText(byClaude, workspace.name),
        expiresAt: new Date(Date.now() + this.confirmTimeoutMs).toISOString(),
        state: 'pending',
      };
      const timer = setTimeout(() => this.settle(workspace.id, 'timeout'), this.confirmTimeoutMs);
      this.confirmations.set(workspace.id, { info, answer, timer });
      this.events.emit('change');
      this.onConfirmRequested(workspace.id);
    });
  }

  onChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  dismiss(workspaceId: string): void {
    if (this.runs.get(workspaceId)?.running) return;
    if (this.runs.delete(workspaceId)) this.events.emit('change');
  }

  /** Every repository checked at once, before anything is merged (spec §21.10). */
  async preflight(workspaceId: string): Promise<MergePrsPreflight> {
    const workspace = this.require(workspaceId);
    const order = defaultOrder(workspace.repos);
    const repos = await Promise.all(order.map((projectId) => this.check(workspaceId, projectId)));
    return { workspaceId, repos };
  }

  /**
   * One repository's preflight: its worktree clean and on the branch, the
   * branch level with its remote branch (after fetching it), and its pull
   * request open, into its base, at that commit and mergeable on the host.
   */
  async check(workspaceId: string, projectId: string): Promise<RepoPreflight> {
    const { workspace, repo, project, profile, git } = await this.finish.context(
      workspaceId,
      projectId,
    );
    const settings = prSettings(profile, project);
    const row: RepoPreflight = {
      projectId,
      name: project.name,
      primary: repo.primary,
      branch: workspace.branch,
      baseBranch: repo.baseBranch,
      prUrl: repo.pr?.url ?? null,
      result: 'failed',
      problems: [],
      methods: [],
      method: null,
      head: null,
    };
    const fail = (...problems: string[]) => ({ ...row, problems });
    if (!project.remote) return fail('No remote: its pull request needs one');
    const missing = [
      ...(settings.statusCommand ? [] : ['PR status command']),
      ...(settings.mergeCommand ? [] : ['PR merge command']),
    ];
    if (missing.length > 0) {
      return fail(
        `No ${missing.join(' or ')} is set: choose GitHub CLI in the project view, or set them in Edit profile`,
      );
    }
    const dir = repo.worktreePath;
    if (!fs.existsSync(dir)) return fail(`Its worktree is missing (${dir})`);

    // Fetched first: the pull request's head is compared with the remote branch.
    const local = await this.localFacts(workspace, repo.worktreePath, project.remote, git);
    const { shell, env } = await this.finish.prCommandEnv(workspace, repo);
    let pr: ReturnType<typeof parsePrDetails>;
    try {
      pr = parsePrDetails(
        await runJsonCommand(
          shell,
          settings.statusCommand ?? '',
          dir,
          env,
          settings.timeoutSec ?? undefined,
        ),
      );
    } catch (error) {
      return fail(message(error));
    }
    if (!pr) return fail(`No pull request found for ${workspace.branch}`);
    row.prUrl = pr.url ?? row.prUrl;
    if (pr.state === 'merged') return { ...row, result: 'merged' };
    row.head = local.remoteHead;
    row.methods = allowedMethods(pr);
    row.method = chooseMergeMethod(row.methods, settings.mergeMethod);
    const problems = [
      ...localProblems(workspace.branch, local),
      ...prProblems(pr, repo.baseBranch, local.remoteHead),
    ];
    if (!row.method) problems.push('The host allows no merge method (squash, merge or rebase)');
    return { ...row, problems, result: problems.length > 0 ? 'failed' : 'ready' };
  }

  /**
   * Its worktree and branch against the remote branch the pull request is
   * from: the branch's upstream when it tracks one, else
   * `<remote>/<branch>`, fetched first.
   */
  private async localFacts(
    workspace: Workspace,
    dir: string,
    projectRemote: string,
    git: Awaited<ReturnType<FinishService['context']>>['git'],
  ): Promise<LocalFacts & { remote: string; remoteBranch: string }> {
    const { remote, remoteBranch } = await this.remoteBranch(workspace, dir, projectRemote, git);
    const remoteRef = `${remote}/${remoteBranch}`;
    const uncommitted = (await git.status(dir)).length;
    const checkedOut =
      (await git.tryRun(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null;
    let fetchError: string | null = null;
    let gone = false;
    try {
      await git.run(dir, [
        'fetch',
        '--quiet',
        remote,
        `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`,
      ]);
    } catch (error) {
      // A branch that isn't on the remote (any more) isn't a fetch problem;
      // its remote-tracking ref may be stale, so it doesn't count.
      const text = message(error);
      if (/couldn't find remote ref/i.test(text)) gone = true;
      else fetchError = text;
    }
    const remoteHead = gone ? null : await git.revParse(dir, `refs/remotes/${remoteRef}`);
    const counts = remoteHead
      ? await git.aheadBehind(dir, `refs/heads/${workspace.branch}`, `refs/remotes/${remoteRef}`)
      : null;
    return {
      uncommitted,
      checkedOut,
      remoteRef,
      fetchError,
      remoteHead,
      ahead: counts?.ahead ?? 0,
      behind: counts?.behind ?? 0,
      remote,
      remoteBranch,
    };
  }

  private async remoteBranch(
    workspace: Workspace,
    dir: string,
    projectRemote: string,
    git: Awaited<ReturnType<FinishService['context']>>['git'],
  ) {
    const up = await git.upstream(dir, workspace.branch);
    const tracked = up && (await git.remotes(dir)).includes(up.remote) ? up : null;
    return {
      remote: tracked?.remote ?? projectRemote,
      remoteBranch: tracked?.branch ?? workspace.branch,
    };
  }

  /**
   * Merges in the order given (spec §21.10), each repository checked again
   * just before; the first failure stops it and skips the rest, and nothing
   * merged is undone. Afterwards the PR status is checked, so the workspace
   * shows Merged once every pull request is (§21.5).
   */
  async merge(workspaceId: string, request: MergePrsRequest): Promise<MergePrsReport> {
    const workspace = this.require(workspaceId);
    if (this.runs.get(workspaceId)?.running) {
      throw new Error('Merge all PRs is already running for this workspace');
    }
    const refused = orderProblem(
      request.order,
      workspace.repos.map((r) => r.projectId),
    );
    if (refused) throw new Error(refused);
    const run: MergePrsRun = {
      workspaceId,
      running: true,
      current: null,
      order: request.order,
      report: null,
    };
    this.runs.set(workspaceId, run);
    this.events.emit('change');
    try {
      const repos = request.order.map((projectId) => ({
        projectId,
        name: this.finish.projectNameOf(projectId),
      }));
      const report = await runMerges(repos, {
        check: (r) => this.check(workspaceId, r.projectId),
        merge: (r, check) =>
          this.mergeOne(workspaceId, r.projectId, check, request.methods[r.projectId], request),
        progress: (report, current) => {
          run.report = report;
          run.current = current;
          this.events.emit('change');
        },
      });
      await this.finish.refreshPr(workspaceId).catch(() => {});
      run.report = report;
      return report;
    } finally {
      run.running = false;
      run.current = null;
      this.events.emit('change');
    }
  }

  private async mergeOne(
    workspaceId: string,
    projectId: string,
    check: RepoPreflight,
    asked: MergeMethod | undefined,
    request: MergePrsRequest,
  ): Promise<
    Pick<
      RepoMergeResult,
      'commit' | 'commitUrl' | 'branchDeleted' | 'deleteError' | 'method' | 'warning'
    >
  > {
    const { workspace, repo, project, profile, git } = await this.finish.context(
      workspaceId,
      projectId,
    );
    const settings = prSettings(profile, project);
    const method = asked ?? check.method;
    if (!method) throw new Error('No merge method');
    if (!check.methods.includes(method)) {
      throw new Error(`The host doesn't allow ${MERGE_METHOD_LABEL[method].toLowerCase()} here`);
    }
    const { shell, env } = await this.finish.prCommandEnv(workspace, repo);
    env[envVar('MERGE_METHOD')] = method;
    env[envVar('PR_HEAD')] = check.head ?? '';
    env[envVar('PR_URL')] = check.prUrl ?? '';
    let out = '';
    let warning: string | null = null;
    try {
      out = await runJsonCommand(
        shell,
        settings.mergeCommand ?? '',
        repo.worktreePath,
        env,
        Math.max(settings.timeoutSec ?? 0, MIN_MERGE_TIMEOUT_SEC),
        'The PR merge command',
      );
    } catch (error) {
      // A command can fail after the host merged (a clean-up step of its
      // own, say): the PR's state decides (spec §21.10).
      if (!(await this.mergedOnHost(workspaceId, projectId))) throw error;
      warning = `Merged on the host, but the PR merge command failed afterwards: ${message(error).replace(/^The PR merge command failed: /, '')}`;
    }
    const done = {
      ...parseMergeOutput(out),
      method,
      branchDeleted: null,
      deleteError: null,
      warning,
    };
    if (!request.deleteBranch || !project.remote) return done;
    const { remote, remoteBranch } = await this.remoteBranch(
      workspace,
      repo.worktreePath,
      project.remote,
      git,
    );
    try {
      await git.run(repo.worktreePath, ['push', '--quiet', remote, '--delete', remoteBranch]);
      return { ...done, branchDeleted: true };
    } catch (error) {
      const text = message(error);
      // The host deleted it with the merge already.
      if (/remote ref does not exist/i.test(text)) return { ...done, branchDeleted: true };
      return { ...done, branchDeleted: false, deleteError: text };
    }
  }

  /** Whether the PR status command says the pull request is merged; false when it can't tell. */
  private async mergedOnHost(workspaceId: string, projectId: string): Promise<boolean> {
    try {
      const { workspace, repo, project, profile } = await this.finish.context(
        workspaceId,
        projectId,
      );
      const settings = prSettings(profile, project);
      const { shell, env } = await this.finish.prCommandEnv(workspace, repo);
      const pr = parsePrDetails(
        await runJsonCommand(
          shell,
          settings.statusCommand ?? '',
          repo.worktreePath,
          env,
          settings.timeoutSec ?? undefined,
        ),
      );
      return pr?.state === 'merged';
    } catch {
      return false;
    }
  }

  /**
   * `<slug> merge` (spec §21.10): the preflight in the order asked, with
   * the methods asked (one the host doesn't allow fails its row), or the
   * merge with them. Run in a workspace's terminals only.
   */
  async cli(request: MergeCliRequest): Promise<MergeCliResponse> {
    if (!request.workspaceId) {
      return {
        ok: false,
        error: `${BRAND.cliCommand} merge runs in a workspace: in its Claude or a terminal of it`,
      };
    }
    const workspace = this.require(request.workspaceId);
    const order = this.resolveOrder(workspace.id, request.order);
    const methods: Record<string, MergeMethod> = {};
    for (const [name, method] of Object.entries(request.methods)) {
      const parsed = MergeMethodSchema.safeParse(method);
      if (!parsed.success) {
        return { ok: false, error: `Unknown merge method ${method}: squash, merge or rebase` };
      }
      methods[this.resolveName(workspace, name)] = parsed.data;
    }
    if (request.action === 'merge') {
      // Never without a click in the app (spec §21.10, D13): the bridge's
      // token is in every session, so the command line alone proves nothing.
      if (this.runs.get(workspace.id)?.running) {
        return { ok: false, error: 'Merge all PRs is already running for this workspace' };
      }
      const answer = await this.waitForConfirmation(
        workspace,
        { order, methods, deleteBranch: request.deleteBranch },
        request.byClaude,
      );
      if (answer === 'cancelled' || answer === 'timeout') {
        return {
          ok: false,
          error: `Not confirmed in ${BRAND.displayName} (${answer === 'timeout' ? 'timed out' : 'cancelled in the app'})`,
        };
      }
      const report = await this.merge(workspace.id, answer);
      return { ok: true, branch: workspace.branch, preflight: null, report };
    }
    const { repos } = await this.preflight(workspace.id);
    const byId = new Map(repos.map((r) => [r.projectId, r]));
    const rows = order.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const asked = methods[id];
      if (!asked || row.result === 'merged') return [row];
      if (row.methods.includes(asked)) return [{ ...row, method: asked }];
      return [
        {
          ...row,
          method: asked,
          result: 'failed' as const,
          problems: [
            ...row.problems,
            `The host doesn't allow ${MERGE_METHOD_LABEL[asked].toLowerCase()} here (${row.methods.join(', ') || 'none'})`,
          ],
        },
      ];
    });
    return {
      ok: true,
      branch: workspace.branch,
      preflight: { workspaceId: workspace.id, repos: rows },
      report: null,
    };
  }

  /**
   * Project names or ids, as the command line tool takes them, to the
   * workspace's project ids (spec §21.10): the named ones first, in that
   * order, then the rest in the default order.
   */
  resolveOrder(workspaceId: string, names: string[]): string[] {
    const workspace = this.require(workspaceId);
    const ids = names.map((n) => this.resolveName(workspace, n));
    const rest = defaultOrder(workspace.repos).filter((id) => !ids.includes(id));
    return [...ids, ...rest];
  }

  resolveName(workspace: Workspace, name: string): string {
    const lower = name.toLowerCase();
    const match = workspace.repos.find(
      (r) =>
        r.projectId.toLowerCase() === lower ||
        this.finish.projectNameOf(r.projectId).toLowerCase() === lower,
    );
    if (!match) {
      const names = workspace.repos.map((r) => this.finish.projectNameOf(r.projectId));
      throw new Error(`${name} isn't a repository of this workspace (${names.join(', ')})`);
    }
    return match.projectId;
  }

  private require(workspaceId: string): Workspace {
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace "${workspaceId}"`);
    return workspace;
  }
}
