import { EventEmitter } from 'node:events';
import type { WorkspaceState } from '@shared/status';
import { type UnfinishedKind, unfinishedKind } from '@shared/unfinished';
import type {
  BranchOrigin,
  MergedInto,
  PrStatus,
  RepoAddedBy,
  Workspace,
  WorkspaceRepo,
} from '@shared/workspaces';
import { prepareOrSkip, type StateDb } from './state-db';

interface Row {
  id: string;
  profile_id: string;
  project_id: string;
  name: string;
  task_id: string | null;
  task_title: string;
  task_url: string | null;
  branch: string;
  base_branch: string;
  worktree_path: string;
  status: string;
  unread: number;
  created_at: string;
  last_activity_at: string | null;
  claude_session_id: string | null;
  transcript_path: string | null;
  state_message: string | null;
  state_since: string | null;
  background: number;
  claude_running: number;
  port_base: number | null;
  port_count: number | null;
  start_commit: string | null;
  pr_state: string | null;
  pr_url: string | null;
  pr_source: string | null;
  setup_error: string | null;
  has_commits: number;
  merged_into: string | null;
  unfinished: string | null;
  unfinished_at: string | null;
  unfinished_stopped: number;
  last_prompt: string | null;
  keep_running: number;
  claude_may_link: number;
  branch_origin: string | null;
}

interface RepoRow {
  workspace_id: string;
  project_id: string;
  position: number;
  worktree_path: string;
  base_branch: string;
  setup_error: string | null;
  has_commits: number;
  merged_into: string | null;
  pr_state: string | null;
  pr_url: string | null;
  pr_source: string | null;
  added_by: string | null;
  branch_origin: string | null;
}

const toPr = (row: {
  pr_state: string | null;
  pr_url: string | null;
  pr_source: string | null;
}): PrStatus | null =>
  row.pr_state
    ? {
        state: row.pr_state as PrStatus['state'],
        url: row.pr_url,
        source: row.pr_source === 'command' ? 'command' : 'git',
      }
    : null;

const toMerged = (value: string | null): MergedInto | null =>
  value === 'base' || value === 'local' ? value : null;

/** Rows made before spec §7.6 have none: their branch was new. */
const toOrigin = (value: string | null): BranchOrigin =>
  value === 'remote' || value === 'local' ? value : 'new';

const toRepo = (row: RepoRow): WorkspaceRepo => ({
  projectId: row.project_id,
  primary: false,
  worktreePath: row.worktree_path,
  baseBranch: row.base_branch,
  pr: toPr(row),
  hasCommits: row.has_commits === 1,
  merged: toMerged(row.merged_into),
  setupError: row.setup_error,
  addedBy: row.added_by === 'claude' || row.added_by === 'terminal' ? row.added_by : null,
  branchOrigin: toOrigin(row.branch_origin),
});

/** A linked repository to record (spec §21.1), and who linked it (§21.9). */
export type NewLinkedRepo = Pick<WorkspaceRepo, 'projectId' | 'worktreePath' | 'baseBranch'> & {
  addedBy?: RepoAddedBy | null;
};

const STATES: readonly string[] = [
  'starting',
  'working',
  'needs-permission',
  'needs-input',
  'needs-answer',
  'awaiting-approval',
  'done',
  'interrupted',
  'exited',
  'error',
] satisfies WorkspaceState[];

const UNFINISHED_KINDS: readonly string[] = [
  'working',
  'interrupted',
  'permission',
  'question',
  'commands',
] satisfies UnfinishedKind[];

const toWorkspace = (row: Row, linked: WorkspaceRepo[] = []): Workspace => ({
  id: row.id,
  profileId: row.profile_id,
  projectId: row.project_id,
  name: row.name,
  task: { id: row.task_id, title: row.task_title, url: row.task_url },
  branch: row.branch,
  baseBranch: row.base_branch,
  worktreePath: row.worktree_path,
  state: (STATES.includes(row.status) ? row.status : 'exited') as WorkspaceState,
  unread: row.unread === 1,
  stateMessage: row.state_message,
  stateSince: row.state_since,
  background: row.background,
  unfinished:
    row.unfinished && UNFINISHED_KINDS.includes(row.unfinished)
      ? {
          kind: row.unfinished as UnfinishedKind,
          since: row.unfinished_at ?? row.created_at,
          stopped: row.unfinished_stopped ?? 0,
        }
      : null,
  lastPrompt: row.last_prompt,
  keepRunning: row.keep_running === 1,
  claudeMayLink: row.claude_may_link !== 0,
  claudeSessionId: row.claude_session_id,
  ports:
    row.port_base !== null && row.port_count !== null
      ? { base: row.port_base, count: row.port_count }
      : null,
  pr: toPr(row),
  repos: [
    {
      projectId: row.project_id,
      primary: true,
      worktreePath: row.worktree_path,
      baseBranch: row.base_branch,
      pr: toPr(row),
      hasCommits: row.has_commits === 1,
      merged: toMerged(row.merged_into),
      setupError: row.setup_error,
      branchOrigin: toOrigin(row.branch_origin),
    },
    ...linked,
  ],
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
});

/** Workspace records in state.db. Deleted workspaces are archived, not removed (spec §14.2). */
export class WorkspaceRecords {
  private readonly events = new EventEmitter();

  constructor(private readonly db: StateDb) {}

  /** A statement, or one that does nothing once state.db is closed (spec §5). */
  private prepare(sql: string) {
    return prepareOrSkip(this.db, sql);
  }

  /** Called after every insert, state change and archive. */
  onChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  /** Records a new workspace with its linked repositories (`repos` after the main one). */
  insert(
    workspace: Omit<
      Workspace,
      'repos' | 'background' | 'unfinished' | 'lastPrompt' | 'keepRunning' | 'claudeMayLink'
    > & {
      repos?: NewLinkedRepo[] | WorkspaceRepo[];
      background?: number;
      unfinished?: Workspace['unfinished'];
      lastPrompt?: string | null;
      keepRunning?: boolean;
      claudeMayLink?: boolean;
    },
  ): void {
    const linked = (workspace.repos ?? []).filter((r) => !('primary' in r) || !r.primary);
    if (!this.db.open) {
      console.warn(`state.db is closed; workspace ${workspace.id} not recorded`);
      return;
    }
    this.db.transaction(() => {
      this.insertRow(workspace);
      for (const [index, repo] of linked.entries()) this.insertRepo(workspace.id, repo, index + 1);
    })();
    this.events.emit('change');
  }

  /** Links another repository to a workspace (spec §21.4), after the others. */
  addRepo(workspaceId: string, repo: NewLinkedRepo): void {
    const row = this.prepare(
      'SELECT MAX(position) AS last FROM workspace_repos WHERE workspace_id = ?',
    ).get(workspaceId) as { last: number | null };
    this.insertRepo(workspaceId, repo, (row.last ?? 0) + 1);
    this.events.emit('change');
  }

  /** Unlinks a repository; the main one can't be. */
  removeRepo(workspaceId: string, projectId: string): void {
    this.prepare('DELETE FROM workspace_repos WHERE workspace_id = ? AND project_id = ?').run(
      workspaceId,
      projectId,
    );
    this.events.emit('change');
  }

  /** Linked repositories of `projectId` in other projects' workspaces. */
  linkedInto(projectId: string): { workspace: Workspace; repo: WorkspaceRepo }[] {
    return this.list().flatMap((workspace) =>
      workspace.repos
        .filter((r) => !r.primary && r.projectId === projectId)
        .map((repo) => ({ workspace, repo })),
    );
  }

  private insertRepo(workspaceId: string, repo: NewLinkedRepo, position: number): void {
    this.prepare(
      `INSERT INTO workspace_repos
           (workspace_id, project_id, position, worktree_path, base_branch, added_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      repo.projectId,
      position,
      repo.worktreePath,
      repo.baseBranch,
      repo.addedBy ?? null,
    );
  }

  private insertRow(
    workspace: Omit<
      Workspace,
      'repos' | 'background' | 'unfinished' | 'lastPrompt' | 'keepRunning' | 'claudeMayLink'
    > & { claudeMayLink?: boolean },
  ): void {
    this.prepare(
      `INSERT INTO workspaces
           (id, profile_id, project_id, name, task_id, task_title, task_url, branch, base_branch,
            worktree_path, status, unread, created_at, last_activity_at, state_message, state_since,
            claude_session_id, port_base, port_count, claude_may_link)
         VALUES (@id, @profileId, @projectId, @name, @taskId, @taskTitle, @taskUrl, @branch,
            @baseBranch, @worktreePath, @state, @unread, @createdAt, @lastActivityAt, @stateMessage,
            @stateSince, @claudeSessionId, @portBase, @portCount, @claudeMayLink)`,
    ).run({
      ...workspace,
      ports: undefined,
      pr: undefined,
      portBase: workspace.ports?.base ?? null,
      portCount: workspace.ports?.count ?? null,
      taskId: workspace.task.id,
      taskTitle: workspace.task.title,
      taskUrl: workspace.task.url,
      unread: workspace.unread ? 1 : 0,
      claudeMayLink: workspace.claudeMayLink === false ? 0 : 1,
    });
  }

  /** Workspaces that haven't been deleted, oldest first. */
  list(): Workspace[] {
    const rows = this.prepare(
      'SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at, id',
    ).all() as Row[];
    return this.withRepos(rows);
  }

  get(id: string): Workspace | null {
    const row = this.prepare('SELECT * FROM workspaces WHERE id = ? AND archived_at IS NULL').get(
      id,
    ) as Row | undefined;
    return row ? (this.withRepos([row])[0] ?? null) : null;
  }

  private withRepos(rows: Row[]): Workspace[] {
    const linked = new Map<string, WorkspaceRepo[]>();
    const repoRows = this.prepare(
      `SELECT r.* FROM workspace_repos r JOIN workspaces w ON w.id = r.workspace_id
         WHERE w.archived_at IS NULL ORDER BY r.position`,
    ).all() as RepoRow[];
    for (const r of repoRows) {
      const list = linked.get(r.workspace_id) ?? [];
      list.push(toRepo(r));
      linked.set(r.workspace_id, list);
    }
    return rows.map((row) => toWorkspace(row, linked.get(row.id)));
  }

  forProject(projectId: string): Workspace[] {
    return this.list().filter((w) => w.projectId === projectId);
  }

  /**
   * Records a state change (spec §10.2) as the latest activity. `since` moves
   * only when the state changes; `unread` is set when given. `background` is
   * how many of Claude's background tasks still run (0 unless given).
   */
  setState(
    id: string,
    state: WorkspaceState,
    {
      message = null,
      unread,
      background = 0,
      at = new Date(),
    }: { message?: string | null; unread?: boolean; background?: number; at?: Date } = {},
  ): void {
    const now = at.toISOString();
    this.prepare(
      `UPDATE workspaces SET
           state_since = CASE WHEN status = @state AND state_since IS NOT NULL THEN state_since ELSE @now END,
           status = @state, state_message = @message, background = @background,
           last_activity_at = @now,
           unread = COALESCE(@unread, unread)
         WHERE id = @id AND archived_at IS NULL`,
    ).run({
      id,
      state,
      now,
      message,
      background,
      unread: unread === undefined ? null : unread ? 1 : 0,
    });
    this.events.emit('change');
  }

  /** Viewing a workspace clears its unread marker (spec §10.2). */
  markRead(id: string): void {
    const result = this.prepare('UPDATE workspaces SET unread = 0 WHERE id = ? AND unread = 1').run(
      id,
    );
    if (result.changes > 0) this.events.emit('change');
  }

  /** Claude's session id and transcript path, from hook payloads. */
  setClaudeSession(id: string, sessionId: string | null, transcriptPath: string | null): void {
    const result = this.prepare(
      `UPDATE workspaces SET
           claude_session_id = COALESCE(@sessionId, claude_session_id),
           transcript_path = COALESCE(@transcriptPath, transcript_path)
         WHERE id = @id AND (COALESCE(@sessionId, claude_session_id) IS NOT claude_session_id
           OR COALESCE(@transcriptPath, transcript_path) IS NOT transcript_path)`,
    ).run({ id, sessionId, transcriptPath });
    if (result.changes > 0) this.events.emit('change');
  }

  /** The transcript path Claude Code reported (read-only use, decision D12). */
  transcriptPath(id: string): string | null {
    const row = this.prepare('SELECT transcript_path FROM workspaces WHERE id = ?').get(id) as
      | { transcript_path: string | null }
      | undefined;
    return row?.transcript_path ?? null;
  }

  /**
   * Whether the project's Start prompt still has to go out at Claude's first
   * start (spec §13.5): set for workspaces made with New workspace.
   */
  startPromptPending(id: string): boolean {
    const row = this.prepare('SELECT start_prompt_sent FROM workspaces WHERE id = ?').get(id) as
      | { start_prompt_sent: number }
      | undefined;
    return row?.start_prompt_sent === 0;
  }

  setStartPromptPending(id: string, pending: boolean): void {
    this.prepare('UPDATE workspaces SET start_prompt_sent = ? WHERE id = ?').run(
      pending ? 0 : 1,
      id,
    );
  }

  /**
   * Whether the title is still to come from the status file's title field
   * (spec §13.5): set for a workspace made without a title, or adopted.
   */
  titleFromStatusPending(id: string): boolean {
    const row = this.prepare('SELECT title_from_status FROM workspaces WHERE id = ?').get(id) as
      | { title_from_status: number }
      | undefined;
    return row?.title_from_status === 1;
  }

  setTitleFromStatusPending(id: string, pending: boolean): void {
    this.prepare('UPDATE workspaces SET title_from_status = ? WHERE id = ?').run(
      pending ? 1 : 0,
      id,
    );
  }

  /**
   * A new task title; the name follows when it was made from the task
   * (`<id> <title>`), not when the user named the workspace otherwise.
   */
  setTaskTitle(id: string, title: string): void {
    const workspace = this.get(id);
    if (!workspace) return;
    const named = (t: string) => [workspace.task.id, t].filter(Boolean).join(' ');
    const name =
      workspace.name === named(workspace.task.title) || workspace.name === workspace.branch
        ? named(title)
        : workspace.name;
    this.prepare('UPDATE workspaces SET task_title = ?, name = ? WHERE id = ?').run(
      title,
      name,
      id,
    );
    this.events.emit('change');
  }

  /** Whether its Claude runs; kept so the next launch can resume it (spec §9.4). */
  /** Keep running (spec §9.8): its Claude is never suspended when idle. */
  setKeepRunning(id: string, on: boolean): void {
    const result = this.prepare('UPDATE workspaces SET keep_running = ? WHERE id = ?').run(
      on ? 1 : 0,
      id,
    );
    if (result.changes > 0) this.events.emit('change');
  }

  /** Let Claude add repositories (spec §21.9); the next SessionStart follows it. */
  setClaudeMayLink(id: string, on: boolean): void {
    const result = this.prepare('UPDATE workspaces SET claude_may_link = ? WHERE id = ?').run(
      on ? 1 : 0,
      id,
    );
    if (result.changes > 0) this.events.emit('change');
  }

  /** The projects whose main-checkout Claude is kept running (spec §9.8). */
  keptMainCheckouts(): string[] {
    const rows = this.prepare('SELECT project_id FROM kept_main_checkouts').all() as {
      project_id: string;
    }[];
    return rows.map((r) => r.project_id);
  }

  setMainCheckoutKept(projectId: string, on: boolean): void {
    this.prepare(
      on
        ? 'INSERT OR IGNORE INTO kept_main_checkouts (project_id) VALUES (?)'
        : 'DELETE FROM kept_main_checkouts WHERE project_id = ?',
    ).run(projectId);
    this.events.emit('change');
  }

  setClaudeRunning(id: string, running: boolean): void {
    this.prepare('UPDATE workspaces SET claude_running = ? WHERE id = ?').run(running ? 1 : 0, id);
  }

  /** Workspaces whose Claude was running when the app last quit. */
  claudeWasRunning(): Workspace[] {
    const rows = this.prepare(
      'SELECT * FROM workspaces WHERE archived_at IS NULL AND claude_running = 1',
    ).all() as Row[];
    return this.withRepos(rows);
  }

  /**
   * A prompt went to the workspace's Claude (UserPromptSubmit): it is the last
   * prompt, and Claude is at work again, so it is no longer unfinished (spec §9.7).
   */
  promptSent(id: string, prompt: string | null): void {
    this.prepare(
      `UPDATE workspaces SET last_prompt = COALESCE(@prompt, last_prompt),
           unfinished = NULL, unfinished_at = NULL, unfinished_new = 0
         WHERE id = @id`,
    ).run({ id, prompt });
    this.events.emit('change');
  }

  /**
   * Marks the workspace unfinished (spec §9.7), as new for the next start; a
   * workspace already marked keeps its marker and time. Null clears it
   * (Continue, Dismiss). `stopped` counts the background commands the stop ended.
   */
  setUnfinished(
    id: string,
    kind: UnfinishedKind | null,
    { stopped = 0, at = new Date() }: { stopped?: number; at?: Date } = {},
  ): void {
    const result =
      kind === null
        ? this.prepare(
            `UPDATE workspaces SET unfinished = NULL, unfinished_at = NULL, unfinished_new = 0,
                 unfinished_stopped = 0
               WHERE id = ? AND unfinished IS NOT NULL`,
          ).run(id)
        : this.prepare(
            `UPDATE workspaces SET unfinished = ?, unfinished_at = ?, unfinished_new = 1,
                 unfinished_stopped = ?
               WHERE id = ? AND archived_at IS NULL`,
          ).run(kind, at.toISOString(), kind === 'commands' ? stopped : 0, id);
    if (result.changes > 0) this.events.emit('change');
  }

  /**
   * At app start, before states are reset (spec §9.7): a quit marks the
   * workspaces Claude was working in, interrupted, asking for permission or
   * Done in with background commands running, so one whose stored state
   * still says so without a marker was left by a crash. It counts the same,
   * since its last activity.
   */
  markUnfinishedAfterCrash(): void {
    const rows = this.prepare(
      `SELECT id, status, background, last_activity_at, created_at FROM workspaces
         WHERE archived_at IS NULL AND unfinished IS NULL`,
    ).all() as Pick<Row, 'id' | 'status' | 'background' | 'last_activity_at' | 'created_at'>[];
    const mark = this.prepare(
      `UPDATE workspaces SET unfinished = ?, unfinished_at = ?, unfinished_new = 1,
         unfinished_stopped = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const kind = STATES.includes(row.status)
        ? unfinishedKind(row.status as WorkspaceState, row.background)
        : null;
      if (kind) {
        const stopped = kind === 'commands' ? row.background : 0;
        mark.run(kind, row.last_activity_at ?? row.created_at, stopped, row.id);
      }
    }
  }

  /**
   * The workspaces marked unfinished since the last start, which this start
   * offers to continue (spec §9.7); they stay marked but aren't new any more.
   */
  takeNewUnfinished(): Workspace[] {
    const rows = this.prepare(
      `SELECT * FROM workspaces
         WHERE archived_at IS NULL AND unfinished IS NOT NULL AND unfinished_new = 1`,
    ).all() as Row[];
    this.prepare('UPDATE workspaces SET unfinished_new = 0 WHERE unfinished_new = 1').run();
    return this.withRepos(rows);
  }

  /**
   * On app start no Claude is running yet, so a state that implies one
   * becomes Exited; last activity stays as it was.
   */
  resetRunningStates(): void {
    this.prepare(
      `UPDATE workspaces SET status = 'exited'
         WHERE archived_at IS NULL AND status NOT IN ('exited', 'error', 'done')`,
    ).run();
  }

  setPorts(id: string, ports: { base: number; count: number }): void {
    this.prepare('UPDATE workspaces SET port_base = ?, port_count = ? WHERE id = ?').run(
      ports.base,
      ports.count,
      id,
    );
    this.events.emit('change');
  }

  /**
   * Where a repository's per-repository columns live: the workspace row for
   * the main one (`projectId` null or the main project), else its link row.
   */
  private repoTarget(id: string, projectId: string | null): { table: string; where: string } {
    const main = this.prepare('SELECT project_id FROM workspaces WHERE id = ?').get(id) as
      | { project_id: string }
      | undefined;
    if (projectId === null || main?.project_id === projectId) {
      return { table: 'workspaces', where: 'id = @id' };
    }
    return { table: 'workspace_repos', where: 'workspace_id = @id AND project_id = @projectId' };
  }

  /** The commit a repository's branch started from (for the git-only PR check, spec §12.3). */
  setStartCommit(id: string, commit: string, projectId: string | null = null): void {
    const { table, where } = this.repoTarget(id, projectId);
    this.prepare(`UPDATE ${table} SET start_commit = @commit WHERE ${where}`).run({
      id,
      projectId,
      commit,
    });
  }

  startCommit(id: string, projectId: string | null = null): string | null {
    const { table, where } = this.repoTarget(id, projectId);
    const row = this.prepare(`SELECT start_commit FROM ${table} WHERE ${where}`).get({
      id,
      projectId,
    }) as { start_commit: string | null } | undefined;
    return row?.start_commit ?? null;
  }

  /** Where a repository's branch came from (spec §7.6); new unless set. */
  setBranchOrigin(id: string, origin: BranchOrigin, projectId: string | null = null): void {
    const { table, where } = this.repoTarget(id, projectId);
    this.prepare(`UPDATE ${table} SET branch_origin = @origin WHERE ${where}`).run({
      id,
      projectId,
      origin,
    });
    this.events.emit('change');
  }

  /** A repository's pull request as last checked (null clears it), and whether it has commits. */
  setPr(
    id: string,
    pr: PrStatus | null,
    { projectId = null, hasCommits }: { projectId?: string | null; hasCommits?: boolean } = {},
  ): void {
    const { table, where } = this.repoTarget(id, projectId);
    const result = this.prepare(
      `UPDATE ${table} SET pr_state = @state, pr_url = @url, pr_source = @source,
           has_commits = COALESCE(@hasCommits, has_commits)
         WHERE ${where} AND (pr_state IS NOT @state OR pr_url IS NOT @url OR pr_source IS NOT @source
           OR has_commits IS NOT COALESCE(@hasCommits, has_commits))`,
    ).run({
      id,
      projectId,
      state: pr?.state ?? null,
      url: pr?.url ?? null,
      source: pr?.source ?? null,
      hasCommits: hasCommits === undefined ? null : hasCommits ? 1 : 0,
    });
    if (result.changes > 0) this.events.emit('change');
  }

  /** Where a repository's branch is merged, as last checked (null: not), and whether it has commits. */
  setMerged(
    id: string,
    projectId: string | null,
    merged: MergedInto | null,
    hasCommits: boolean,
  ): void {
    const { table, where } = this.repoTarget(id, projectId);
    const result = this.prepare(
      `UPDATE ${table} SET merged_into = @merged, has_commits = @hasCommits
         WHERE ${where} AND (merged_into IS NOT @merged OR has_commits IS NOT @hasCommits)`,
    ).run({ id, projectId, merged, hasCommits: hasCommits ? 1 : 0 });
    if (result.changes > 0) this.events.emit('change');
  }

  /** Why a repository's setup failed, or null once it passed (spec §21.3). */
  setSetupError(id: string, projectId: string | null, error: string | null): void {
    const { table, where } = this.repoTarget(id, projectId);
    const result = this.prepare(
      `UPDATE ${table} SET setup_error = @error WHERE ${where} AND setup_error IS NOT @error`,
    ).run({ id, projectId, error });
    if (result.changes > 0) this.events.emit('change');
  }

  /** Port blocks in use by workspaces that haven't been deleted. */
  portBlocks(): { base: number; count: number }[] {
    return this.list().flatMap((w) => (w.ports ? [w.ports] : []));
  }

  /** Archiving releases its ports (spec §8.4, §14.2). */
  archive(id: string, at = new Date()): void {
    this.prepare(
      `UPDATE workspaces SET archived_at = ?, status = 'deleted', port_base = NULL, port_count = NULL WHERE id = ?`,
    ).run(at.toISOString(), id);
    this.events.emit('change');
  }
}
