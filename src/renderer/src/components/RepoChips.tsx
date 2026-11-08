import type { SessionInfo } from '@shared/terminal-protocol';
import { PR_LABEL, type Workspace, type WorkspaceRepo } from '@shared/workspaces';
import { useLayoutEffect, useRef, useState } from 'react';
import { trpcClient } from '../trpc';
import { REVEAL_LABEL } from '../ui/controls';
import { PrimaryTag } from './DeleteWorkspaceDialog';

/** What a linked repository's chip menu can do (spec §21.4). */
export interface RepoActions {
  openInEditor: (repo: WorkspaceRepo) => void;
  newShell: (repo: WorkspaceRepo) => void;
  showChanges: (repo: WorkspaceRepo) => void;
  unlink: (repo: WorkspaceRepo) => void;
}

const GAP = 6;

/** The primary repository: name, primary tag, `branch ← base`, unpushed commits, a failed setup. */
function PrimaryChip({
  repo,
  name,
  branch,
  unpushed,
  copy = false,
}: {
  repo: WorkspaceRepo;
  name: string;
  branch: string;
  unpushed: number;
  /** The hidden copy that's only measured. */
  copy?: boolean;
}) {
  return (
    <span
      data-repo-chip={copy ? undefined : repo.projectId}
      title={repo.worktreePath}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-line bg-canvas px-2 font-mono text-sm select-text"
    >
      <span className="font-medium text-fg">{name}</span>
      <PrimaryTag />
      <span className="text-fg-muted">
        {branch} <span className="text-fg-subtle">←</span> {repo.baseBranch}
      </span>
      {unpushed > 0 ? <span className="text-fg-muted">↑{unpushed}</span> : null}
      {repo.setupError ? <span className="text-st-error">✕ setup failed</span> : null}
    </span>
  );
}

const prTone = (state: string) =>
  state === 'merged' || state === 'likely-merged'
    ? 'text-st-approval'
    : state === 'closed'
      ? 'text-fg-subtle'
      : 'text-diff-add';

/** Who linked it from the command line (spec §21.9), for its tooltip and the +n more menu. */
export const ADDED_BY_LABEL = { claude: 'Added by Claude', terminal: 'Added from a terminal' };

/** A linked repository's setup, as its chip and tooltip say it. */
function setupState(repo: WorkspaceRepo, running: boolean): string {
  if (running) return 'Setup running';
  return repo.setupError ? `Setup failed (${repo.setupError})` : 'Setup passed or not needed';
}

/** The marks after a linked repository's name: a failed or running setup, its PR. */
function Marks({ repo, running }: { repo: WorkspaceRepo; running: boolean }) {
  return (
    <>
      {repo.setupError ? (
        <span
          data-chip-mark="setup-failed"
          role="img"
          className="text-st-error"
          aria-label="setup failed"
        >
          ✕
        </span>
      ) : running ? (
        <span
          data-chip-mark="setup-running"
          role="img"
          className="animate-pulse text-fg-muted"
          aria-label="setup running"
        >
          ◌
        </span>
      ) : null}
      {repo.pr ? (
        <span
          data-chip-mark={`pr-${repo.pr.state}`}
          role="img"
          className={`text-xs ${prTone(repo.pr.state)}`}
          aria-label={PR_LABEL[repo.pr.state]}
        >
          PR
        </span>
      ) : null}
    </>
  );
}

/**
 * A linked repository: its name and marks. Hover or focus shows its branch,
 * base, worktree, setup and PR; a click or ↵ opens its menu.
 */
function LinkedChip({
  repo,
  name,
  branch,
  unpushed,
  running,
  onMenu,
}: {
  repo: WorkspaceRepo;
  name: string;
  branch: string;
  unpushed: number;
  running: boolean;
  onMenu: () => void;
}) {
  const [tip, setTip] = useState(false);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        data-repo-chip={repo.projectId}
        aria-haspopup="menu"
        aria-describedby={tip ? `repo-tip-${repo.projectId}` : undefined}
        className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-canvas px-2 font-mono text-sm hover:border-line-strong focus-visible:border-line-strong focus-visible:outline-none"
        onMouseEnter={() => setTip(true)}
        onMouseLeave={() => setTip(false)}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
        onClick={() => {
          setTip(false);
          onMenu();
        }}
      >
        <span className="font-medium text-fg">{name}</span>
        <Marks repo={repo} running={running} />
      </button>
      {tip ? (
        <span
          role="tooltip"
          id={`repo-tip-${repo.projectId}`}
          data-repo-tooltip={repo.projectId}
          className="pointer-events-none absolute top-full left-0 z-30 mt-1 w-max max-w-[480px] rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs leading-5 text-fg shadow-overlay"
        >
          <span className="block">
            {branch} <span className="text-fg-subtle">←</span> {repo.baseBranch}
            {unpushed > 0 ? <span className="text-fg-muted"> · ↑{unpushed}</span> : null}
          </span>
          <span className="block truncate text-fg-muted">{repo.worktreePath}</span>
          <span className={`block ${repo.setupError ? 'text-st-error' : 'text-fg-muted'}`}>
            {setupState(repo, running)}
          </span>
          <span className="block text-fg-muted">
            {repo.pr
              ? `${PR_LABEL[repo.pr.state]}${repo.pr.url ? ` · ${repo.pr.url}` : ''}`
              : 'No PR known'}
          </span>
          {repo.addedBy ? (
            <span data-added-by={repo.addedBy} className="block text-fg-muted">
              {ADDED_BY_LABEL[repo.addedBy]}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The repository chips of a linked workspace's header (spec §21.4): the
 * primary in full, then the linked ones by name on one line; the ones that
 * don't fit go under "+n more".
 */
export function RepoChips({
  workspace,
  sessions,
  projectName,
  unpushed,
  actions,
}: {
  workspace: Workspace;
  sessions: SessionInfo[];
  projectName: (id: string) => string;
  /** Unpushed commits per repository, in `workspace.repos` order. */
  unpushed: number[];
  actions: RepoActions;
}) {
  const primary = workspace.repos.find((r) => r.primary) ?? workspace.repos[0];
  const linked = workspace.repos.filter((r) => r !== primary);
  const unpushedOf = (repo: WorkspaceRepo) => unpushed[workspace.repos.indexOf(repo)] ?? 0;
  const running = (repo: WorkspaceRepo) =>
    sessions.some(
      (s) => s.kind === 'setup' && s.projectId === repo.projectId && s.status === 'running',
    );

  // How many linked chips fit on the line, measured on hidden copies.
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(linked.length);
  const signature = linked
    .map((r) => `${r.projectId}:${r.setupError ?? ''}:${r.pr?.state ?? ''}:${running(r)}`)
    .join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the chips change
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const compute = () => {
      const [first, ...rest] = [...measure.children] as HTMLElement[];
      const more = rest.pop();
      const widths = rest.map((el) => el.offsetWidth);
      const available = row.clientWidth - (first?.offsetWidth ?? 0) - GAP;
      const total = (n: number) => widths.slice(0, n).reduce((sum, w) => sum + w + GAP, 0);
      if (total(widths.length) <= available) {
        setFit(widths.length);
        return;
      }
      const moreWidth = (more?.offsetWidth ?? 0) + GAP;
      let n = widths.length;
      while (n > 0 && total(n) + moreWidth > available) n--;
      setFit(n);
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [signature]);

  const menu = async (repo: WorkspaceRepo) => {
    const name = projectName(repo.projectId);
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [
        { id: 'editor', label: 'Open in editor' },
        { id: 'shell', label: `New shell in ${name}` },
        { id: 'reveal', label: REVEAL_LABEL },
        { id: 'changes', label: 'Show in Changes' },
        { id: 'unlink', label: `Unlink ${name}…` },
      ],
    });
    if (choice === 'editor') actions.openInEditor(repo);
    else if (choice === 'shell') actions.newShell(repo);
    else if (choice === 'reveal') {
      void trpcClient.workspaces.revealWorktree.mutate({
        workspaceId: workspace.id,
        projectId: repo.projectId,
      });
    } else if (choice === 'changes') actions.showChanges(repo);
    else if (choice === 'unlink') actions.unlink(repo);
  };
  const hidden = linked.slice(fit);
  const moreMenu = async () => {
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: hidden.map((r) => ({
        id: r.projectId,
        label: [
          projectName(r.projectId),
          r.setupError ? '✕ setup failed' : running(r) ? 'setup running' : null,
          r.pr ? PR_LABEL[r.pr.state] : null,
          r.addedBy ? ADDED_BY_LABEL[r.addedBy] : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    });
    const repo = hidden.find((r) => r.projectId === choice);
    if (repo) void menu(repo);
  };
  if (!primary) return null;
  const chip = (repo: WorkspaceRepo) => (
    <LinkedChip
      key={repo.projectId}
      repo={repo}
      name={projectName(repo.projectId)}
      branch={workspace.branch}
      unpushed={unpushedOf(repo)}
      running={running(repo)}
      onMenu={() => void menu(repo)}
    />
  );
  const moreLabel = (n: number) => `+${n} more`;
  return (
    <div ref={rowRef} data-repo-chips className="relative mt-2 flex min-w-0 items-center gap-1.5">
      <PrimaryChip
        repo={primary}
        name={projectName(primary.projectId)}
        branch={workspace.branch}
        unpushed={unpushedOf(primary)}
      />
      {linked.slice(0, fit).map(chip)}
      {hidden.length > 0 ? (
        <button
          type="button"
          data-repo-more
          aria-haspopup="menu"
          title={hidden.map((r) => projectName(r.projectId)).join(', ')}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-line px-2 text-sm text-fg-muted hover:text-fg"
          onClick={() => void moreMenu()}
        >
          {moreLabel(hidden.length)}
          {hidden.some((r) => r.setupError) ? <span className="text-st-error">✕</span> : null}
        </button>
      ) : null}
      {/* Hidden copies, for how many fit. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible fixed top-0 -left-[10000px] flex gap-1.5 whitespace-nowrap"
      >
        <PrimaryChip
          repo={primary}
          name={projectName(primary.projectId)}
          branch={workspace.branch}
          unpushed={unpushedOf(primary)}
          copy
        />
        {linked.map((repo) => (
          <span
            key={repo.projectId}
            className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-sm"
          >
            <span className="font-medium">{projectName(repo.projectId)}</span>
            <Marks repo={repo} running={running(repo)} />
          </span>
        ))}
        <span className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-sm">
          {moreLabel(linked.length)} ✕
        </span>
      </div>
    </div>
  );
}
