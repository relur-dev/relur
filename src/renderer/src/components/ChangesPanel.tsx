import { BRAND } from '@shared/brand';
import {
  type ChangedFile,
  type ChangeGroup,
  diffFirstLine,
  type FileDiff,
  PUSH_REJECTED,
} from '@shared/changes';
import type { MergeStatus } from '@shared/merge';
import type { Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { PR_LABEL, type PrStatus, type Workspace, type WorkspaceRepo } from '@shared/workspaces';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type AppRouterOutputs, trpcClient, useTRPC } from '../trpc';
import { button, iconButton, inputClass, isMac, keyHint } from '../ui/controls';
import { takeRequest } from '../ui/open-requests';
import { remember } from '../ui/remember';
import { PrimaryTag } from './DeleteWorkspaceDialog';
import { useOpenInEditor } from './EditorPicker';
import { type MergeApi, MergeRow, useMerge, useMergeStatuses } from './MergeControls';

type Monaco = typeof import('../monaco');
let loading: Promise<Monaco> | null = null;
/** Monaco loads on first use, so the app starts without it. */
const loadMonaco = () => {
  loading ??= import('../monaco');
  return loading;
};

/** A command's own output, without the lines the app's script prints around it. */
const commandOutput = (output: string) =>
  output
    .split('\n')
    .filter((l) => !/^\$ |^[✓✕] /.test(l))
    .join('\n')
    .trim();

const KIND_COLOR: Record<ChangedFile['kind'], string> = {
  M: 'text-st-permission',
  A: 'text-diff-add',
  D: 'text-diff-del',
  R: 'text-st-permission',
};

/** Read-only diff of one file in Monaco's diff editor, inline or side by side. */
/**
 * Until when a diff about to be created takes the focus: the previous or next
 * file was picked with the keys from inside the diff (⌥⌘↑ / ⌥⌘↓), and the
 * diff of the new file replaces the focused one.
 */
let refocusDiffUntil = 0;

function DiffView({
  diff,
  path,
  split,
  cursorLine,
}: {
  diff: FileDiff;
  path: string;
  split: boolean;
  /** Where the cursor was last put in the new side, for Open in editor (spec §6.13). */
  cursorLine?: { current: number | null };
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (diff.binary || !host.current) return;
    let disposed = false;
    let cleanup = () => {};
    void loadMonaco().then(
      ({ monaco, applyMonacoTheme, languageFor }) => {
        if (disposed || !host.current) return;
        applyMonacoTheme();
        const language = languageFor(path);
        const original = monaco.editor.createModel(diff.original ?? '', language);
        const modified = monaco.editor.createModel(diff.modified ?? '', language);
        const editor = monaco.editor.createDiffEditor(host.current, {
          readOnly: true,
          originalEditable: false,
          renderSideBySide: split,
          useInlineViewWhenSpaceIsLimited: false,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderOverviewRuler: false,
          hideUnchangedRegions: { enabled: true },
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11.5,
          lineHeight: 18,
          lineNumbersMinChars: 3,
          glyphMargin: false,
          folding: false,
          contextmenu: false,
          links: false,
          renderLineHighlight: 'none',
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        });
        editor.setModel({ original, modified });
        if (Date.now() < refocusDiffUntil) {
          refocusDiffUntil = 0;
          editor.getModifiedEditor().focus();
        }
        if (cursorLine) cursorLine.current = null;
        const cursor = editor.getModifiedEditor().onDidChangeCursorPosition((e) => {
          if (cursorLine && e.source !== 'api') cursorLine.current = e.position.lineNumber;
        });
        // Follows the app's light and dark appearance.
        const observer = new MutationObserver(() => applyMonacoTheme());
        observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
        cleanup = () => {
          observer.disconnect();
          cursor.dispose();
          editor.dispose();
          original.dispose();
          modified.dispose();
        };
      },
      (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      disposed = true;
      cleanup();
    };
  }, [diff, path, split, cursorLine]);
  if (diff.binary) {
    return (
      <p className="p-4 text-sm text-fg-muted">
        {diff.tooLarge ? 'Too large to show here.' : 'Binary file: no text to compare.'}
      </p>
    );
  }
  if (failed) return <p className="p-4 text-sm text-st-error">✕ {failed}</p>;
  return <div ref={host} data-diff-editor className="h-full w-full" />;
}

/**
 * Open in editor from the Changes panel (spec §6.13): a file of one
 * repository at a line, in that repository's project's editor; `line` null
 * is its first change.
 */
function useOpenChangedFile(workspace: Workspace, projects: Project[]) {
  const { run, dialog } = useOpenInEditor();
  const open = (
    repo: Pick<WorkspaceRepo, 'projectId' | 'primary'>,
    file: ChangedFile,
    group: ChangeGroup,
    line: number | null,
  ) => {
    const projectId = repo.primary ? null : repo.projectId;
    const project = projects.find((p) => p.id === repo.projectId);
    void run(
      async () => {
        const at =
          line ??
          (await trpcClient.changes.diff
            .query({
              workspaceId: workspace.id,
              projectId,
              group,
              path: file.path,
              oldPath: file.oldPath ?? null,
            })
            .then(diffFirstLine));
        return trpcClient.editor.openWorktree.mutate({
          workspaceId: workspace.id,
          projectId,
          file: file.path,
          line: at ?? undefined,
        });
      },
      {
        profileId: workspace.profileId,
        project: { id: repo.projectId, name: project?.name ?? repo.projectId },
      },
    );
  };
  return { open, dialog };
}

function FileRow({
  file,
  selected,
  onSelect,
  onOpen,
}: {
  file: ChangedFile;
  selected: boolean;
  onSelect: () => void;
  /** Open in editor at its first change; none for a deleted file. */
  onOpen?: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-change-file={file.path}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        onClick={onSelect}
        className={`flex h-6.5 w-full items-center gap-2 rounded-sm px-2 font-mono text-sm ${
          selected ? 'bg-selected' : 'hover:bg-raised'
        }`}
      >
        <span className={`w-3 shrink-0 font-semibold ${KIND_COLOR[file.kind]}`}>{file.kind}</span>
        {/* Ellipsized from the left, so the file name stays visible. */}
        <span className="min-w-0 flex-1 truncate text-left [direction:rtl]">
          <bdi>{file.path}</bdi>
        </span>
        {file.binary ? (
          <span className="text-xs text-fg-subtle">bin</span>
        ) : (
          <>
            <span className="text-diff-add">{file.added ? `+${file.added}` : ''}</span>
            <span className="min-w-6 text-right text-diff-del">
              {file.removed ? `−${file.removed}` : ''}
            </span>
          </>
        )}
      </button>
      {onOpen && file.kind !== 'D' ? (
        <button
          type="button"
          data-open-file={file.path}
          title="Open in editor, at its first change"
          aria-label={`Open ${file.path} in editor`}
          className="absolute top-0.5 right-1 hidden h-5.5 rounded-sm border border-line-strong bg-raised px-1.5 text-xs text-fg-muted group-focus-within:block group-hover:block hover:text-fg"
          onClick={onOpen}
        >
          Open
        </button>
      ) : null}
    </div>
  );
}

export function PrBadge({ pr }: { pr: PrStatus }) {
  const tone =
    pr.state === 'merged' || pr.state === 'likely-merged'
      ? 'text-st-approval border-st-approval/40'
      : pr.state === 'closed'
        ? 'text-fg-subtle border-line'
        : 'text-diff-add border-diff-add/40';
  const label = PR_LABEL[pr.state];
  return pr.url ? (
    <button
      type="button"
      data-pr-badge={pr.state}
      title={`${pr.url} (${pr.source === 'git' ? 'from git' : 'from the PR status command'})`}
      onClick={() => void trpcClient.shell.openExternal.mutate({ url: pr.url ?? '' })}
      className={`rounded-sm border px-1.5 text-xs font-medium hover:bg-raised ${tone}`}
    >
      {label} ↗
    </button>
  ) : (
    <span
      data-pr-badge={pr.state}
      title={pr.source === 'git' ? 'From git: no PR status command is set' : undefined}
      className={`rounded-sm border px-1.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * Home's Commit… (spec §6.7) opens the workspace with the commit box in
 * focus: the first commit box to show takes the request. Later, so the
 * terminal that comes up with the workspace doesn't take the focus back.
 */
const commitFocus = (workspaceId: string) => (box: HTMLTextAreaElement | null) => {
  if (box && takeRequest(workspaceId, 'commit')) setTimeout(() => box.focus(), 150);
};

/** The base branch's name in a base ref (`origin/develop` → `develop`). */
const baseName = (ref: string, remote: string | null) =>
  remote && ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;

/**
 * Behind and conflicts with the base (spec §6.4): "↓12 behind origin/develop
 * · conflicts in 3 files", with Ask Claude to merge; and after a push the
 * remote refused, Ask Claude to merge the remote branch (spec §14.1).
 */
function MergeLine({
  state,
  input,
  pushError,
}: {
  state: {
    behind: number;
    conflicts: string[] | null;
    baseRef: string;
    remote: string | null;
    upstream: string | null;
  };
  input: { workspaceId: string; projectId?: string };
  pushError: string | null;
}) {
  const trpc = useTRPC();
  const [sent, setSent] = useState<string | null>(null);
  const merge = useMutation(trpc.changes.askClaudeToMerge.mutationOptions());
  const rejected = Boolean(pushError?.includes(PUSH_REJECTED) && state.upstream);
  if (state.behind === 0 && !rejected && !sent) return null;
  const conflicts = state.conflicts ?? [];
  const ask = (from: 'base' | 'upstream', what: string) =>
    merge.mutate(
      { ...input, from },
      { onSuccess: () => setSent(`Sent to Claude: it merges ${what} and resolves any conflicts.`) },
    );
  const base = baseName(state.baseRef, state.remote);
  return (
    <div data-merge-line className="space-y-1 text-sm">
      {state.behind > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span data-behind className="font-mono text-fg-muted">
            ↓{state.behind} behind {state.baseRef}
          </span>
          {conflicts.length > 0 ? (
            <span data-conflicts className="text-st-permission" title={conflicts.join('\n')}>
              · conflicts in {conflicts.length} {conflicts.length === 1 ? 'file' : 'files'}
            </span>
          ) : null}
          <button
            type="button"
            data-ask-merge="base"
            className={button(conflicts.length > 0 ? 'secondary' : 'ghost', 'sm')}
            disabled={merge.isPending}
            onClick={() => ask('base', base)}
          >
            Ask Claude to merge {base}
          </button>
        </div>
      ) : null}
      {rejected && state.upstream ? (
        <button
          type="button"
          data-ask-merge="upstream"
          className={button('secondary', 'sm')}
          disabled={merge.isPending}
          onClick={() => ask('upstream', state.upstream ?? '')}
        >
          Ask Claude to merge {state.upstream}
        </button>
      ) : null}
      {sent ? <p className="text-fg-muted">{sent}</p> : null}
      {merge.error ? (
        <p role="alert" className="text-st-error select-text">
          ✕ {merge.error.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Commit → Push → Create PR → PR badge (spec §14.1), one step at a time.
 * Projects without a remote only commit.
 */
function FinishControls({ workspace }: { workspace: Workspace }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useQuery(
    trpc.changes.state.queryOptions(
      { workspaceId: workspace.id },
      { refetchInterval: 3000, staleTime: 0 },
    ),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.changes.pathKey() });
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const done = (text: string | null) => () => {
    setNote(text);
    refresh();
  };
  const commit = useMutation(
    trpc.changes.commit.mutationOptions({
      onSuccess: () => {
        setMessage(null);
        refresh();
      },
    }),
  );
  const ask = useMutation(
    trpc.changes.askClaudeToCommit.mutationOptions({
      onSuccess: done('Sent to Claude: it writes the message and commits.'),
    }),
  );
  const push = useMutation(trpc.changes.push.mutationOptions({ onSuccess: done(null) }));
  const createPr = useMutation(
    trpc.changes.createPr.mutationOptions({
      onSuccess: (result) => {
        if (result.via === 'claude') setNote('Sent to Claude: it opens the pull request.');
        else if (result.result.ok)
          setNote(commandOutput(result.result.output) || 'Create PR finished.');
        else setNote(null);
        refresh();
      },
    }),
  );
  const check = useMutation(trpc.changes.refreshPr.mutationOptions({ onSuccess: refresh }));
  const mergeApi = useMerge();
  const mergeStatus = useMergeStatuses()(workspace.id);
  const s = state.data;
  if (!s) return null;
  const busy = commit.isPending || push.isPending || createPr.isPending || ask.isPending;
  const failed =
    createPr.data?.via === 'command' && !createPr.data.result.ok
      ? `${createPr.data.result.message}\n${createPr.data.result.output}`
      : null;
  const error =
    (commit.error ?? ask.error ?? push.error ?? createPr.error ?? check.error)?.message ?? failed;

  return (
    <div data-finish className="shrink-0 space-y-2 border-t border-line bg-surface p-3 text-md">
      <MergeLine
        state={s}
        input={{ workspaceId: workspace.id }}
        pushError={push.error?.message ?? null}
      />
      {s.uncommitted > 0 ? (
        <>
          <textarea
            ref={commitFocus(workspace.id)}
            aria-label="Commit message"
            className={`${inputClass} h-auto min-h-14 py-1.5 text-sm`}
            spellCheck={false}
            value={message ?? s.commitMessage}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={button('primary', 'sm')}
              disabled={busy || !(message ?? s.commitMessage).trim()}
              onClick={() =>
                commit.mutate({ workspaceId: workspace.id, message: message ?? s.commitMessage })
              }
            >
              Commit {s.uncommitted} {s.uncommitted === 1 ? 'file' : 'files'}
            </button>
            <button
              type="button"
              className={button('ghost', 'sm')}
              disabled={busy}
              onClick={() => ask.mutate({ workspaceId: workspace.id })}
            >
              Ask Claude to write it
            </button>
          </div>
        </>
      ) : null}
      {s.hasRemote && s.uncommitted === 0 && s.unpushed > 0 ? (
        <button
          type="button"
          className={button('primary', 'sm')}
          disabled={busy}
          onClick={() => push.mutate({ workspaceId: workspace.id })}
        >
          {push.isPending
            ? 'Pushing…'
            : `Push ${s.unpushed} ${s.unpushed === 1 ? 'commit' : 'commits'} to ${s.remote}`}
        </button>
      ) : null}
      {s.hasRemote && s.uncommitted === 0 && s.unpushed === 0 && s.pushed && !s.pr ? (
        <button
          type="button"
          className={button('primary', 'sm')}
          disabled={busy}
          title={
            s.createsWithCommand
              ? 'Runs the PR create command in the worktree'
              : 'Sends the create prompt to the Claude tab'
          }
          onClick={() => createPr.mutate({ workspaceId: workspace.id })}
        >
          {createPr.isPending
            ? 'Creating…'
            : s.createsWithCommand
              ? 'Create PR'
              : 'Create PR with Claude'}
        </button>
      ) : null}
      {s.hasRemote && (s.pr || s.pushed) ? (
        <div className="flex items-center gap-2 text-sm">
          {s.pr ? <PrBadge pr={s.pr} /> : <span className="text-fg-subtle">No PR known</span>}
          <button
            type="button"
            className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            disabled={check.isPending}
            onClick={() => check.mutate({ workspaceId: workspace.id })}
          >
            {check.isPending ? 'Checking…' : 'Check again'}
          </button>
        </div>
      ) : null}
      <MergeRow
        workspace={workspace}
        projectId={null}
        base={workspace.baseBranch}
        mergeable={s.mergeable}
        status={mergeStatus}
        api={mergeApi}
      />
      {mergeApi.dialog}
      {!s.hasRemote ? (
        <p data-no-remote className="text-sm text-fg-subtle">
          No remote: Push and Create PR need one. Add it in a Shell tab with{' '}
          <span className="font-mono select-text">git remote add origin &lt;url&gt;</span>;{' '}
          {BRAND.displayName} picks up <span className="font-mono">origin</span> by itself, or
          choose another under Remote in the project view.
        </p>
      ) : null}
      {s.uncommitted === 0 && s.unpushed === 0 && !s.pushed && s.hasRemote ? (
        <p className="text-sm text-fg-subtle">Nothing to commit or push yet.</p>
      ) : null}
      {note ? (
        <p className="text-sm whitespace-pre-wrap text-fg-muted select-text">{note}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm whitespace-pre-wrap text-st-error select-text">
          ✕ {error}
        </p>
      ) : null}
    </div>
  );
}

/** A repository's query input: the main one keeps the plain workspace key. */
const repoInput = (workspaceId: string, repo: WorkspaceRepo) =>
  repo.primary ? { workspaceId } : { workspaceId, projectId: repo.projectId };

/** "PR #318 · open" from a PR's URL and state (components.md, linked sections). */
function prLabel(pr: PrStatus): string {
  const number = pr.url?.match(/(\d+)\/?$/)?.[1];
  return number ? `PR #${number} · ${PR_LABEL[pr.state].replace(/^PR /, '')}` : PR_LABEL[pr.state];
}

/**
 * One repository's commit message (prefilled, editable, or written by Claude
 * for that repository only) and Commit n → Push ↑n → Create PR (View PR #n
 * once known), each enabled only when it has something to do (spec §21.5).
 */
function RepoControls({
  workspace,
  repo,
  name,
  merge,
  mergeStatus,
}: {
  workspace: Workspace;
  repo: WorkspaceRepo;
  /** The repository's project name. */
  name: string;
  /** Merge into the base, shared with the panel's header strip (spec §14.4). */
  merge: MergeApi;
  mergeStatus: MergeStatus | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = repoInput(workspace.id, repo);
  const state = useQuery(
    trpc.changes.state.queryOptions(input, { refetchInterval: 3000, staleTime: 0 }),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.changes.pathKey() });
  const [note, setNote] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const commit = useMutation(
    trpc.changes.commit.mutationOptions({
      onSuccess: () => {
        setMessage(null);
        refresh();
      },
    }),
  );
  const ask = useMutation(
    trpc.changes.askClaudeToCommit.mutationOptions({
      onSuccess: () => {
        setNote('Sent to Claude: it writes the message and commits in this repository.');
        refresh();
      },
    }),
  );
  const push = useMutation(trpc.changes.push.mutationOptions({ onSuccess: refresh }));
  const createPr = useMutation(
    trpc.changes.createPr.mutationOptions({
      onSuccess: (result) => {
        if (result.via === 'claude') setNote('Sent to Claude: it opens the pull request.');
        else
          setNote(
            result.result.ok ? commandOutput(result.result.output) || 'Create PR finished.' : null,
          );
        refresh();
      },
    }),
  );
  const s = state.data;
  if (!s) return null;
  const busy = commit.isPending || push.isPending || createPr.isPending || ask.isPending;
  const failed =
    createPr.data?.via === 'command' && !createPr.data.result.ok
      ? `${createPr.data.result.message}\n${createPr.data.result.output}`
      : null;
  const error = (commit.error ?? ask.error ?? push.error ?? createPr.error)?.message ?? failed;
  const arrow = <span className="text-fg-subtle">→</span>;
  const pr = s.pr;
  const text = message ?? s.commitMessage;
  return (
    <div data-repo-controls={repo.projectId} className="space-y-1.5 px-2 pt-1 pb-2">
      <MergeLine state={s} input={input} pushError={push.error?.message ?? null} />
      {s.uncommitted > 0 ? (
        <>
          <textarea
            ref={commitFocus(workspace.id)}
            aria-label={`Commit message for ${name}`}
            className={`${inputClass} h-auto min-h-14 py-1.5 text-sm`}
            spellCheck={false}
            value={text}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            type="button"
            className={button('ghost', 'sm')}
            disabled={busy}
            title={`Claude writes the message and commits in ${name} only`}
            onClick={() => ask.mutate(input)}
          >
            Ask Claude to write it
          </button>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={button('secondary', 'sm')}
          disabled={busy || s.uncommitted === 0 || !text.trim()}
          title={s.uncommitted === 0 ? 'Nothing to commit' : undefined}
          onClick={() => commit.mutate({ ...input, message: text })}
        >
          Commit {s.uncommitted}
        </button>
        {s.hasRemote ? (
          <>
            {arrow}
            <button
              type="button"
              className={button('secondary', 'sm')}
              disabled={busy || s.unpushed === 0 || s.uncommitted > 0}
              title={
                s.uncommitted > 0
                  ? 'Commit first'
                  : s.unpushed === 0
                    ? 'Nothing to push'
                    : `Push to ${s.remote}`
              }
              onClick={() => push.mutate(input)}
            >
              {push.isPending ? 'Pushing…' : `Push ↑${s.unpushed}`}
            </button>
            {arrow}
            {pr?.url ? (
              <button
                type="button"
                className={button('secondary', 'sm')}
                onClick={() => void trpcClient.shell.openExternal.mutate({ url: pr.url ?? '' })}
              >
                View {prLabel(pr).split(' · ')[0]}
              </button>
            ) : !pr && !s.hasOwnCommits ? (
              // Create PRs skips it too (spec §21.5).
              <span data-no-own-commits className="text-sm text-fg-subtle">
                No commits of its own
              </span>
            ) : (
              <button
                type="button"
                className={button('secondary', 'sm')}
                disabled={busy || !s.pushed || s.unpushed > 0 || s.uncommitted > 0 || Boolean(pr)}
                title={
                  pr
                    ? 'A pull request is known'
                    : !s.pushed || s.unpushed > 0 || s.uncommitted > 0
                      ? 'Push first'
                      : s.createsWithCommand
                        ? 'Runs the PR create command in the worktree'
                        : 'Sends the create prompt to the Claude tab'
                }
                onClick={() => createPr.mutate(input)}
              >
                {createPr.isPending ? 'Creating…' : 'Create PR'}
              </button>
            )}
          </>
        ) : null}
      </div>
      <MergeRow
        workspace={workspace}
        projectId={repo.projectId}
        base={repo.baseBranch}
        mergeable={s.mergeable}
        status={mergeStatus}
        api={merge}
      />
      {note ? (
        <p className="text-sm whitespace-pre-wrap text-fg-muted select-text">{note}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm whitespace-pre-wrap text-st-error select-text">
          ✕ {error}
        </p>
      ) : null}
    </div>
  );
}

/** What Create PRs did, or why it failed (spec §21.5). */
type CreateAllOutcome =
  | { ok: true; result: AppRouterOutputs['changes']['createAllPrs'] }
  | { ok: false; message: string };

/**
 * Create n PRs in a linked panel's header (spec §21.5): one pull request in
 * every repository with a remote, commits of its own and no PR known; shown
 * while there is one. Uncommitted files there disable it.
 */
function CreateAllButton({
  workspaceId,
  states,
  onResult,
}: {
  workspaceId: string;
  states: {
    name: string;
    state:
      | { hasRemote: boolean; hasOwnCommits: boolean; pr: PrStatus | null; uncommitted: number }
      | undefined;
  }[];
  onResult: (outcome: CreateAllOutcome) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.changes.createAllPrs.mutationOptions({
      onSuccess: (result) => onResult({ ok: true, result }),
      onError: (error) => onResult({ ok: false, message: error.message }),
      onSettled: () => void queryClient.invalidateQueries({ queryKey: trpc.changes.pathKey() }),
    }),
  );
  const wanted = states.filter((r) => r.state?.hasRemote && r.state.hasOwnCommits && !r.state.pr);
  if (wanted.length === 0) return null;
  const dirty = wanted.filter((r) => (r.state?.uncommitted ?? 0) > 0).map((r) => r.name);
  const n = wanted.length;
  return (
    <button
      type="button"
      data-create-all-prs={n}
      className={button('secondary', 'sm')}
      disabled={create.isPending || dirty.length > 0}
      title={
        dirty.length > 0
          ? `Commit first in ${dirty.join(', ')}`
          : `Pushes where needed, then opens a pull request in ${wanted.map((r) => r.name).join(', ')}`
      }
      onClick={() => create.mutate({ workspaceId })}
    >
      {create.isPending ? 'Creating…' : `Create ${n} ${n === 1 ? 'PR' : 'PRs'}`}
    </button>
  );
}

/** Create PRs' outcome under the linked panel's header: what was pushed, run, sent and skipped. */
function CreateAllNote({
  result: outcome,
  onDismiss,
}: {
  result: CreateAllOutcome;
  onDismiss: () => void;
}) {
  const lines: { text: string; error?: boolean }[] = [];
  if (!outcome.ok) lines.push({ text: outcome.message, error: true });
  else {
    const r = outcome.result;
    if (r.pushed.length > 0) lines.push({ text: `Pushed ${r.pushed.join(', ')}.` });
    for (const c of r.commands) {
      lines.push(
        c.result.ok
          ? { text: `${c.name}: ${commandOutput(c.result.output) || 'Create PR finished.'}` }
          : { text: `${c.name}: ${c.result.message}\n${c.result.output}`, error: true },
      );
    }
    if (r.claude.length > 0) {
      lines.push({
        text: `Sent to Claude: it opens the pull request${r.claude.length === 1 ? '' : 's'} in ${r.claude.join(', ')} and links them to each other.`,
      });
    }
    if (r.skipped.length > 0) {
      lines.push({
        text: `Skipped ${r.skipped.map((k) => `${k.name} (${k.reason})`).join(', ')}.`,
      });
    }
  }
  return (
    <div
      data-create-all-note
      className="flex shrink-0 items-start gap-2 border-b border-line bg-surface px-3.5 py-1.5"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        {lines.map((l) => (
          <p
            key={l.text}
            role={l.error ? 'alert' : undefined}
            className={`text-sm whitespace-pre-wrap select-text ${l.error ? 'text-st-error' : 'text-fg-muted'}`}
          >
            {l.error ? '✕ ' : ''}
            {l.text}
          </p>
        ))}
      </div>
      <button type="button" className={iconButton} aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

const WIDTH_KEY = 'changes-panel-width';
const STYLE_KEY = 'changes-diff-style';
/** Its width beside the terminal (spec §6.4): from MIN_WIDTH to MAX_SHARE of the workspace area. */
const MIN_WIDTH = 360;
const MAX_SHARE = 0.75;
const defaultWidth = (narrow: boolean) => (narrow ? MIN_WIDTH : 380);
/** The diff's width side by side needs; below it the diff is unified, with a hint. */
const SPLIT_MIN_WIDTH = 640;
/**
 * The file list (spec §6.4): beside the terminal its height, in Full view its
 * column's width, and whether it is collapsed to one line, all kept across
 * restarts. Without a dragged height it is as tall as its files, up to about
 * five rows (and a linked workspace's repository headers), then scrolls.
 */
const LIST_HEIGHT_KEY = 'changes-list-height';
const LIST_WIDTH_KEY = 'changes-list-width';
const LIST_COLLAPSED_KEY = 'changes-list-collapsed';
const FILE_ROW = 26;
const listAutoMax = (linked: boolean) => FILE_ROW * 5 + (linked ? 96 : 34);
const LIST_MIN_HEIGHT = 56;
/** What the diff keeps below a dragged list. */
const DIFF_MIN_HEIGHT = 120;
const LIST_DEFAULT_WIDTH = 280;
const LIST_MIN_WIDTH = 180;
const LIST_MAX_SHARE = 0.5;

type DiffStyle = 'unified' | 'split';

/** Local storage may be unavailable (a private profile): the defaults apply then. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const storedStyle = (): DiffStyle => (stored(STYLE_KEY) === 'split' ? 'split' : 'unified');

/** Unified or Side by side: one setting for the whole app, kept across restarts (spec §6.4). */
function useDiffStyle(): [DiffStyle, (style: DiffStyle) => void] {
  const [style, setStyle] = useState<DiffStyle>(storedStyle);
  useEffect(() => {
    // Another window's panel changed it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STYLE_KEY) setStyle(storedStyle());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [
    style,
    (next) => {
      setStyle(next);
      remember(STYLE_KEY, next);
    },
  ];
}

/** An element's width, followed as it changes. */
function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** A size in local storage, or null for the default. */
function useStoredSize(key: string): [number | null, (size: number | null) => void] {
  const [size, setSize] = useState<number | null>(() => {
    const value = Number(stored(key));
    return stored(key) !== null && Number.isFinite(value) && value > 0 ? value : null;
  });
  return [
    size,
    (next) => {
      setSize(next);
      remember(key, next === null ? null : String(Math.round(next)));
    },
  ];
}

/** Whether the file list is collapsed to one line (spec §6.4), kept across restarts. */
export function useListCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => stored(LIST_COLLAPSED_KEY) === '1');
  return [
    collapsed,
    () =>
      setCollapsed((current) => {
        remember(LIST_COLLAPSED_KEY, current ? null : '1');
        return !current;
      }),
  ];
}

/**
 * A divider that drags: between the file list and the diff (rows), or the
 * list's column and the diff in Full view (columns). The size goes to
 * `onSize` while dragging and is saved on release; double-click resets it.
 */
function Divider({
  axis,
  measure,
  clamp,
  onSize,
  onReset,
  title,
  data,
}: {
  axis: 'rows' | 'columns';
  /** The list's size now, where the drag starts from. */
  measure: () => number;
  clamp: (size: number) => number;
  onSize: (size: number, save: boolean) => void;
  onReset: () => void;
  title: string;
  data: string;
}) {
  const drag = useRef<{ at: number; size: number; now: number } | null>(null);
  const pos = (e: PointerEvent) => (axis === 'rows' ? e.clientY : e.clientX);
  const rows = axis === 'rows';
  return (
    <div className={`relative shrink-0 bg-line ${rows ? 'h-px' : 'w-px'}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only drag edge; the list also collapses from its header */}
      <div
        {...{ [data]: '' }}
        title={title}
        className={`absolute z-10 hover:bg-line-strong/60 ${rows ? 'inset-x-0 -top-1 h-2 cursor-row-resize' : 'inset-y-0 -left-1 w-2 cursor-col-resize'}`}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const size = measure();
          drag.current = { at: pos(e), size, now: size };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          drag.current.now = clamp(drag.current.size + pos(e) - drag.current.at);
          onSize(drag.current.now, false);
        }}
        onPointerUp={() => {
          if (drag.current) onSize(drag.current.now, true);
          drag.current = null;
        }}
        onPointerCancel={() => {
          if (drag.current) onSize(drag.current.now, true);
          drag.current = null;
        }}
        onDoubleClick={onReset}
      />
    </div>
  );
}

/**
 * The file list and the diff (spec §6.4). Beside the terminal the list sits
 * above the diff, as tall as its files up to about five rows, or as dragged;
 * in Full view it is a column on the left, as wide as dragged. Collapsed, the
 * one-line `collapsedLine` stands in for the list, above the diff.
 */
function FilesAndDiff({
  full,
  linked,
  collapsed,
  listClass,
  list,
  collapsedLine,
  diff,
}: {
  full: boolean;
  linked: boolean;
  collapsed: boolean;
  listClass: string;
  list: ReactNode;
  collapsedLine: ReactNode;
  diff: ReactNode;
}) {
  const [height, setHeight] = useStoredSize(LIST_HEIGHT_KEY);
  const [width, setWidth] = useStoredSize(LIST_WIDTH_KEY);
  // While dragging: shown at once, saved on release.
  const [dragged, setDragged] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shownHeight = full ? null : (dragged ?? height);
  const shownWidth = full ? (dragged ?? width ?? LIST_DEFAULT_WIDTH) : null;
  const listbox = (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Changed files"
      tabIndex={0}
      data-changes-list={full ? 'column' : shownHeight === null ? 'auto' : 'sized'}
      style={
        full
          ? { width: shownWidth ?? undefined, maxWidth: `${LIST_MAX_SHARE * 100}%` }
          : shownHeight === null
            ? { maxHeight: listAutoMax(linked) }
            : { height: shownHeight, maxHeight: `calc(100% - ${DIFF_MIN_HEIGHT}px)` }
      }
      className={`shrink-0 overflow-y-auto outline-none ${listClass}`}
    >
      {list}
    </div>
  );
  const size = (value: number, save: boolean) => {
    setDragged(save ? null : value);
    if (save) (full ? setWidth : setHeight)(value);
  };
  if (full) {
    return (
      <div ref={box} className="flex min-h-0 flex-1">
        {collapsed ? null : (
          <>
            {listbox}
            <Divider
              axis="columns"
              data="data-changes-column-resize"
              title="Drag to resize the file list; double-click for its default width"
              measure={() => listRef.current?.offsetWidth ?? LIST_DEFAULT_WIDTH}
              clamp={(v) =>
                Math.max(
                  LIST_MIN_WIDTH,
                  Math.min(v, (box.current?.clientWidth ?? v / LIST_MAX_SHARE) * LIST_MAX_SHARE),
                )
              }
              onSize={size}
              onReset={() => setWidth(null)}
            />
          </>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {collapsed ? collapsedLine : null}
          {diff}
        </div>
      </div>
    );
  }
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      {collapsed ? (
        collapsedLine
      ) : (
        <>
          {listbox}
          <Divider
            axis="rows"
            data="data-changes-list-resize"
            title="Drag to resize the file list; double-click for its default height"
            measure={() => listRef.current?.offsetHeight ?? LIST_MIN_HEIGHT}
            clamp={(v) =>
              Math.max(
                LIST_MIN_HEIGHT,
                Math.min(v, (box.current?.clientHeight ?? v + DIFF_MIN_HEIGHT) - DIFF_MIN_HEIGHT),
              )
            }
            onSize={size}
            onReset={() => setHeight(null)}
          />
        </>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{diff}</div>
    </div>
  );
}

/** A file group's header ("Uncommitted · n"): a click collapses the whole list (spec §6.4). */
function ListToggle({ onToggle, children }: { onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-changes-list-toggle
      aria-expanded
      title="Collapse the file list to one line"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 text-left hover:text-fg-muted"
    >
      <span className="text-[9px]">▼</span>
      {children}
    </button>
  );
}

/**
 * The collapsed file list (spec §6.4): one line with the current file, its
 * place in the list, and previous and next (also ⌥⌘↑ / ⌥⌘↓).
 */
function CollapsedFileLine({
  file,
  label,
  index,
  count,
  onExpand,
  onStep,
}: {
  file: ChangedFile | null;
  /** Before the path, e.g. the repository in a linked workspace. */
  label?: string;
  index: number;
  count: number;
  onExpand: () => void;
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <div
      data-changes-list-collapsed
      className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface pr-1.5 pl-2"
    >
      <button
        type="button"
        data-changes-list-toggle
        aria-expanded={false}
        title="Show the file list"
        onClick={onExpand}
        className="flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-sm"
      >
        <span className="text-[9px] text-fg-muted">▶</span>
        {file ? (
          <>
            <span className={`w-3 shrink-0 font-semibold ${KIND_COLOR[file.kind]}`}>
              {file.kind}
            </span>
            <span data-changes-current className="min-w-0 flex-1 truncate [direction:rtl]">
              <bdi>{label ? `${label} · ${file.path}` : file.path}</bdi>
            </span>
          </>
        ) : (
          <span className="text-fg-subtle">No changes yet</span>
        )}
      </button>
      <span className="shrink-0 font-mono text-xs text-fg-subtle">
        {count > 0 ? `${index + 1}/${count}` : ''}
      </span>
      <button
        type="button"
        data-changes-prev
        className={iconButton}
        disabled={index <= 0}
        title={`Previous file (${keyHint('changesFileStep', 0)})`}
        aria-label="Previous file"
        onClick={() => onStep(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        data-changes-next
        className={iconButton}
        disabled={index >= count - 1}
        title={`Next file (${keyHint('changesFileStep', 1)})`}
        aria-label="Next file"
        onClick={() => onStep(1)}
      >
        ›
      </button>
    </div>
  );
}

/** The diff header's style switch, like a segmented control (components.md: Changes panel). */
function DiffStyleSwitch({
  style,
  onChange,
}: {
  style: DiffStyle;
  onChange: (style: DiffStyle) => void;
}) {
  const option = (value: DiffStyle, label: string, title: string) => (
    <button
      type="button"
      data-diff-style={value}
      aria-pressed={style === value}
      title={title}
      className={`h-5 rounded-sm px-1.5 text-xs whitespace-nowrap transition-colors duration-120 ease-out-quiet ${
        style === value ? 'bg-raised font-medium text-fg' : 'text-fg-muted hover:text-fg'
      }`}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
  return (
    <fieldset
      aria-label="Diff style"
      className="m-0 flex min-w-0 shrink-0 items-center gap-px rounded-md border border-line-strong p-px"
    >
      {option('unified', 'Unified', 'One column, removed lines above added ones')}
      {option('split', 'Side by side', 'The old version on the left, the new one on the right')}
    </fieldset>
  );
}

/**
 * The selected file's diff (spec §6.4): its header (path, Open in editor, the
 * style switch) and Monaco's diff. Side by side falls back to unified while
 * the diff is narrower than SPLIT_MIN_WIDTH, saying how to get room.
 */
function DiffPane({
  label,
  openButton,
  diff,
  path,
  cursorLine,
}: {
  label: ReactNode;
  openButton: ReactNode;
  /** The diff to show, once loaded for the selected file. */
  diff: FileDiff | null;
  path: string;
  cursorLine: { current: number | null };
}) {
  const [style, setStyle] = useDiffStyle();
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const width = useWidth(area);
  const tooNarrow = style === 'split' && width > 0 && width < SPLIT_MIN_WIDTH;
  return (
    <>
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-3.5">
        {label}
        {openButton}
        <DiffStyleSwitch style={style} onChange={setStyle} />
      </div>
      {tooNarrow ? (
        <div
          data-split-fallback
          className="shrink-0 border-b border-line bg-surface px-3.5 py-1 text-xs text-fg-subtle"
        >
          Too narrow for side by side: widen the panel or use Full view (
          {keyHint('changesFullView')}).
        </div>
      ) : null}
      <div ref={setArea} data-diff-area className="min-h-0 flex-1 bg-term">
        {diff ? (
          <DiffView
            diff={diff}
            path={path}
            split={style === 'split' && !tooNarrow}
            cursorLine={cursorLine}
          />
        ) : null}
      </div>
    </>
  );
}

/** Full view and back, in the panel's header (like the Responses panel's). */
function FullViewButton({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-changes-full
      className={button('ghost', 'sm')}
      aria-pressed={full}
      title={
        full
          ? `Back to the side panel (Esc, ${keyHint('changesFullView')})`
          : `Over the whole workspace (${keyHint('changesFullView')})`
      }
      onClick={onToggle}
    >
      {full ? 'Side panel' : 'Full view'}
    </button>
  );
}

/**
 * The panel's frame (spec §6.4): beside the terminal its left edge drags to
 * resize it (double-click resets it), the width kept across restarts; in
 * Full view it takes the whole workspace area. Esc leaves Full view first.
 */
function ChangesFrame({
  narrow,
  full,
  onToggleFull,
  onKeyDown,
  onStep,
  children,
}: {
  narrow: boolean;
  full: boolean;
  onToggleFull: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  /** Previous or next file (⌥⌘↑ / ⌥⌘↓), also from inside the diff. */
  onStep: (delta: 1 | -1) => void;
  children: ReactNode;
}) {
  const asideRef = useRef<HTMLElement>(null);
  // In focus when it changes size, so Esc reaches it (the terminal may be hidden).
  const sized = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when full view changes
  useEffect(() => {
    if (sized.current) asideRef.current?.focus();
    sized.current = true;
  }, [full]);
  const saved = Number(stored(WIDTH_KEY));
  const [width, setWidth] = useState(() =>
    Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : defaultWidth(narrow),
  );
  const [area, setArea] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setArea(asideRef.current?.parentElement ?? null), []);
  const areaWidth = useWidth(area);
  const clamp = (value: number) =>
    Math.max(MIN_WIDTH, Math.min(value, areaWidth > 0 ? areaWidth * MAX_SHARE : value));
  const shown = clamp(width);
  // The drag's latest width, saved on release (the render may not have caught up yet).
  const drag = useRef<{ x: number; width: number; now: number } | null>(null);
  const onDragStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: shown, now: shown };
  };
  const onDragMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.now = clamp(drag.current.width + drag.current.x - event.clientX);
    setWidth(drag.current.now);
  };
  const onDragEnd = () => {
    if (!drag.current) return;
    remember(WIDTH_KEY, String(Math.round(drag.current.now)));
    drag.current = null;
  };
  const reset = () => {
    remember(WIDTH_KEY, null);
    setWidth(defaultWidth(narrow));
  };
  return (
    <aside
      ref={asideRef}
      data-changes-panel
      data-full={full ? 'true' : 'false'}
      aria-label="Changes"
      tabIndex={-1}
      // Before Monaco, which would take the keys in the diff.
      onKeyDownCapture={(e) => {
        const at = matchShortcut('changesFileStep', e.nativeEvent, isMac);
        if (at === -1) return;
        e.preventDefault();
        e.stopPropagation();
        // The diff is replaced: the keys stay in the panel meanwhile, then go to the new diff.
        if ((e.target as HTMLElement).closest('[data-diff-editor]')) {
          refocusDiffUntil = Date.now() + 3000;
          asideRef.current?.focus();
        }
        onStep(at === 0 ? -1 : 1);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && full) {
          e.preventDefault();
          e.stopPropagation();
          onToggleFull();
          return;
        }
        onKeyDown(e);
      }}
      style={full ? undefined : { width: shown }}
      className={`relative flex min-h-0 flex-col bg-canvas outline-none ${full ? 'min-w-0 flex-1' : 'shrink-0 border-l border-line'}`}
    >
      {full ? null : (
        // biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only drag edge; Full view is the keyboard's way to more room
        <div
          data-changes-resize
          title="Drag to resize; double-click for the default width"
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-line-strong/60"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={reset}
        />
      )}
      {children}
    </aside>
  );
}

/**
 * The Changes panel of a linked workspace (spec §21.5): one collapsible
 * section per repository, main first, each with its groups, PR badge and
 * its own Commit → Push → Create PR. ↑↓ move across sections.
 */
function LinkedChangesPanel({
  workspace,
  projects,
  onClose,
  narrow,
  full,
  onToggleFull,
  focus,
}: {
  workspace: Workspace;
  projects: Project[];
  onClose: () => void;
  narrow: boolean;
  full: boolean;
  onToggleFull: () => void;
  focus?: ChangesFocus | null;
}) {
  const trpc = useTRPC();
  const repos = workspace.repos;
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const lists = useQueries({
    queries: repos.map((r) =>
      trpc.changes.list.queryOptions(repoInput(workspace.id, r), {
        refetchInterval: 3000,
        staleTime: 0,
      }),
    ),
  });
  const states = useQueries({
    queries: repos.map((r) =>
      trpc.changes.state.queryOptions(repoInput(workspace.id, r), {
        refetchInterval: 3000,
        staleTime: 0,
      }),
    ),
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [allResult, setAllResult] = useState<CreateAllOutcome | null>(null);
  const merge = useMerge();
  const mergeStatus = useMergeStatuses()(workspace.id);
  const mergeable = states.filter((q) => q.data?.mergeable).length;
  // Show in Changes (a repository chip, spec §21.4): that section expanded, scrolled to.
  useEffect(() => {
    if (!focus) return;
    setCollapsed((c) => ({ ...c, [focus.projectId]: false }));
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-changes-repo="${CSS.escape(focus.projectId)}"]`)
        ?.scrollIntoView({ block: 'start' }),
    );
  }, [focus]);
  const [selected, setSelected] = useState<{
    projectId: string;
    group: ChangeGroup;
    path: string;
  } | null>(null);
  const rows = repos.flatMap((repo, i) =>
    collapsed[repo.projectId]
      ? []
      : [
          ...(lists[i]?.data?.committed ?? []).map((file) => ({
            repo,
            group: 'committed' as const,
            file,
          })),
          ...(lists[i]?.data?.uncommitted ?? []).map((file) => ({
            repo,
            group: 'uncommitted' as const,
            file,
          })),
        ],
  );
  const same = (r: (typeof rows)[number], s: typeof selected) =>
    s !== null && r.repo.projectId === s.projectId && r.group === s.group && r.file.path === s.path;
  const current = rows.find((r) => same(r, selected)) ?? rows[0] ?? null;
  const diff = useQuery(
    trpc.changes.diff.queryOptions(
      {
        workspaceId: workspace.id,
        projectId: current && !current.repo.primary ? current.repo.projectId : null,
        group: current?.group ?? 'uncommitted',
        path: current?.file.path ?? '-',
        oldPath: current?.file.oldPath ?? null,
      },
      { enabled: current !== null, staleTime: 0, refetchInterval: 3000 },
    ),
  );
  const keyOf = (r: (typeof rows)[number]) => `${r.repo.projectId}:${r.group}:${r.file.path}:`;
  const shown = useRef<{ key: string; diff: FileDiff } | null>(null);
  const cursorLine = useRef<number | null>(null);
  const editorOpen = useOpenChangedFile(workspace, projects);
  if (diff.data && current) {
    const key = `${keyOf(current)}${JSON.stringify(diff.data)}`;
    if (shown.current?.key !== key) shown.current = { key, diff: diff.data };
  }
  const added = lists.reduce((n, l) => n + (l.data?.added ?? 0), 0);
  const removed = lists.reduce((n, l) => n + (l.data?.removed ?? 0), 0);

  const [listCollapsed, toggleList] = useListCollapsed();
  const at = current ? rows.indexOf(current) : -1;
  const step = (delta: 1 | -1) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
    if (next)
      setSelected({ projectId: next.repo.projectId, group: next.group, path: next.file.path });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus();
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  };

  return (
    <ChangesFrame
      narrow={narrow}
      full={full}
      onToggleFull={onToggleFull}
      onKeyDown={onKeyDown}
      onStep={step}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-3.5">
        <span className="text-md font-semibold">Changes</span>
        <span className="truncate text-xs text-fg-subtle">· {repos.length} repositories</span>
        <span className="flex-1" />
        <CreateAllButton
          workspaceId={workspace.id}
          states={repos.map((r, i) => ({ name: name(r.projectId), state: states[i]?.data }))}
          onResult={setAllResult}
        />
        <span className="font-mono text-xs font-medium text-diff-add">+{added}</span>
        <span className="font-mono text-xs font-medium text-diff-del">−{removed}</span>
        <FullViewButton full={full} onToggle={onToggleFull} />
        <button
          type="button"
          className={iconButton}
          title={`Close ${keyHint('changes')}`}
          aria-label="Close changes"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {allResult ? <CreateAllNote result={allResult} onDismiss={() => setAllResult(null)} /> : null}
      {mergeable > 1 || mergeStatus || merge.error(workspace.id) ? (
        // Merge every repository into its own base (spec §21.5, §14.4).
        <div data-merge-all className="shrink-0 border-b border-line bg-surface px-3.5 py-2">
          <MergeRow
            workspace={workspace}
            projectId={null}
            base="their bases"
            mergeable={mergeable > 1}
            status={mergeStatus}
            api={merge}
            label={`Merge ${mergeable} into their bases`}
          />
        </div>
      ) : null}
      {merge.dialog}
      <FilesAndDiff
        full={full}
        linked
        collapsed={listCollapsed}
        listClass=""
        collapsedLine={
          <CollapsedFileLine
            file={current?.file ?? null}
            label={current ? name(current.repo.projectId) : undefined}
            index={at}
            count={rows.length}
            onExpand={toggleList}
            onStep={step}
          />
        }
        list={repos.map((repo, i) => {
          const data = lists[i]?.data;
          const state = states[i]?.data;
          const open = !collapsed[repo.projectId];
          const group = (g: ChangeGroup, label: string, files: ChangedFile[], right?: string) =>
            files.length > 0 ? (
              <div>
                <div className="flex h-6 items-center px-2 text-xs font-semibold text-fg-subtle">
                  <ListToggle onToggle={toggleList}>
                    {label} {files.length}
                  </ListToggle>
                  {right ? <span className="shrink-0 font-normal">{right}</span> : null}
                </div>
                {files.map((file) => (
                  <FileRow
                    key={`${g}:${file.path}`}
                    file={file}
                    selected={
                      current?.repo.projectId === repo.projectId &&
                      current.group === g &&
                      current.file.path === file.path
                    }
                    onSelect={() =>
                      setSelected({ projectId: repo.projectId, group: g, path: file.path })
                    }
                    onOpen={() => editorOpen.open(repo, file, g, null)}
                  />
                ))}
              </div>
            ) : null;
          return (
            <section key={repo.projectId} data-changes-repo={repo.projectId}>
              <div className="flex h-8 items-center gap-2 border-b border-line bg-surface px-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={
                    open ? `Collapse ${name(repo.projectId)}` : `Expand ${name(repo.projectId)}`
                  }
                  className="w-3 text-[9px] text-fg-muted"
                  onClick={() => setCollapsed((c) => ({ ...c, [repo.projectId]: open }))}
                >
                  {open ? '▼' : '▶'}
                </button>
                <span className="font-mono text-sm">{name(repo.projectId)}</span>
                {repo.primary ? <PrimaryTag /> : null}
                {state?.pr ? (
                  <button
                    type="button"
                    data-pr-badge={state.pr.state}
                    disabled={!state.pr.url}
                    onClick={() =>
                      void trpcClient.shell.openExternal.mutate({ url: state.pr?.url ?? '' })
                    }
                    className="h-[18px] rounded-full border border-diff-add/50 px-1.5 font-mono text-2xs text-diff-add"
                  >
                    {prLabel(state.pr)}
                  </button>
                ) : null}
                <span className="flex-1" />
                {data ? (
                  <>
                    <span className="font-mono text-xs text-diff-add">+{data.added}</span>
                    <span className="font-mono text-xs text-diff-del">−{data.removed}</span>
                  </>
                ) : null}
              </div>
              {open ? (
                <div className="p-1">
                  {lists[i]?.error ? (
                    <p role="alert" className="px-2 text-sm text-st-error select-text">
                      ✕ {lists[i]?.error?.message}
                    </p>
                  ) : null}
                  {data && data.committed.length + data.uncommitted.length === 0 ? (
                    <p className="px-2 py-1 text-sm text-fg-subtle">No changes yet</p>
                  ) : null}
                  {group(
                    'committed',
                    'Committed',
                    data?.committed ?? [],
                    state?.hasRemote
                      ? state.unpushed > 0
                        ? `↑${state.unpushed} not pushed`
                        : state.pushed
                          ? 'pushed'
                          : undefined
                      : undefined,
                  )}
                  {group('uncommitted', 'Uncommitted', data?.uncommitted ?? [])}
                  <RepoControls
                    workspace={workspace}
                    repo={repo}
                    name={name(repo.projectId)}
                    merge={merge}
                    mergeStatus={mergeStatus}
                  />
                </div>
              ) : null}
            </section>
          );
        })}
        diff={
          current ? (
            <DiffPane
              label={
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg-muted">
                  {name(current.repo.projectId)} · {current.file.path}
                </span>
              }
              openButton={
                current.file.kind !== 'D' ? (
                  <button
                    type="button"
                    data-open-diff
                    className={button('ghost', 'sm')}
                    title="Open in editor, at the line of the cursor in the diff, else the first change"
                    onClick={() =>
                      editorOpen.open(
                        current.repo,
                        current.file,
                        current.group,
                        cursorLine.current ??
                          (shown.current?.key.startsWith(keyOf(current))
                            ? diffFirstLine(shown.current.diff)
                            : null),
                      )
                    }
                  >
                    Open in editor
                  </button>
                ) : null
              }
              diff={shown.current?.key.startsWith(keyOf(current)) ? shown.current.diff : null}
              path={current.file.path}
              cursorLine={cursorLine}
            />
          ) : (
            <div className="flex-1" />
          )
        }
      />
      {editorOpen.dialog}
    </ChangesFrame>
  );
}

/**
 * The Changes panel (spec §6.4, components.md): what the workspace changed
 * against its base, committed since the merge base and uncommitted, with a
 * read-only diff and the finish controls. ⌘⇧D toggles it; Esc returns to the
 * terminal. A linked workspace gets a section per repository (§21.5).
 */
/** A repository whose section the linked Changes panel shows; `at` repeats the request. */
export interface ChangesFocus {
  projectId: string;
  at: number;
}

export function ChangesPanel({
  workspace,
  projects = [],
  onClose,
  narrow,
  full,
  onToggleFull,
  focus = null,
}: {
  workspace: Workspace;
  projects?: Project[];
  onClose: () => void;
  narrow: boolean;
  /** It fills the workspace area, the terminal hidden (⇧⌘M). */
  full: boolean;
  onToggleFull: () => void;
  focus?: ChangesFocus | null;
}) {
  if (workspace.repos.length > 1) {
    return (
      <LinkedChangesPanel
        workspace={workspace}
        projects={projects}
        onClose={onClose}
        narrow={narrow}
        full={full}
        onToggleFull={onToggleFull}
        focus={focus}
      />
    );
  }
  return (
    <SingleChangesPanel
      workspace={workspace}
      projects={projects}
      onClose={onClose}
      narrow={narrow}
      full={full}
      onToggleFull={onToggleFull}
    />
  );
}

function SingleChangesPanel({
  workspace,
  projects,
  onClose,
  narrow,
  full,
  onToggleFull,
}: {
  workspace: Workspace;
  projects: Project[];
  onClose: () => void;
  narrow: boolean;
  full: boolean;
  onToggleFull: () => void;
}) {
  const trpc = useTRPC();
  const changes = useQuery(
    trpc.changes.list.queryOptions(
      { workspaceId: workspace.id },
      { refetchInterval: 3000, staleTime: 0 },
    ),
  );
  const [selected, setSelected] = useState<{ group: ChangeGroup; path: string } | null>(null);
  const data = changes.data;
  const rows: { group: ChangeGroup; file: ChangedFile }[] = [
    ...(data?.committed ?? []).map((file) => ({ group: 'committed' as const, file })),
    ...(data?.uncommitted ?? []).map((file) => ({ group: 'uncommitted' as const, file })),
  ];
  const current =
    rows.find((r) => r.group === selected?.group && r.file.path === selected.path) ??
    rows[0] ??
    null;
  const diff = useQuery(
    trpc.changes.diff.queryOptions(
      {
        workspaceId: workspace.id,
        group: current?.group ?? 'uncommitted',
        path: current?.file.path ?? '-',
        oldPath: current?.file.oldPath ?? null,
      },
      { enabled: current !== null, staleTime: 0, refetchInterval: 3000 },
    ),
  );
  // Keep the editor when a refetch brings the same content.
  const shown = useRef<{ key: string; diff: FileDiff } | null>(null);
  const cursorLine = useRef<number | null>(null);
  const editorOpen = useOpenChangedFile(workspace, projects);
  const mainRepo = { projectId: workspace.projectId, primary: true };
  if (diff.data && current) {
    const key = `${current.group}:${current.file.path}:${JSON.stringify(diff.data)}`;
    if (shown.current?.key !== key) shown.current = { key, diff: diff.data };
  }

  const [collapsed, toggleCollapsed] = useListCollapsed();
  const at = current ? rows.indexOf(current) : -1;
  const step = (delta: 1 | -1) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
    if (next) setSelected({ group: next.group, path: next.file.path });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus();
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  };

  const group = (name: ChangeGroup, label: string, files: ChangedFile[]) =>
    files.length > 0 ? (
      <div>
        <div className="px-2 pt-1 pb-0.5 text-xs text-fg-subtle">
          <ListToggle onToggle={toggleCollapsed}>
            {label} · {files.length}
          </ListToggle>
        </div>
        {files.map((file) => (
          <FileRow
            key={`${name}:${file.path}`}
            file={file}
            selected={current?.group === name && current.file.path === file.path}
            onSelect={() => setSelected({ group: name, path: file.path })}
            onOpen={() => editorOpen.open(mainRepo, file, name, null)}
          />
        ))}
      </div>
    ) : null;

  return (
    <ChangesFrame
      narrow={narrow}
      full={full}
      onToggleFull={onToggleFull}
      onKeyDown={onKeyDown}
      onStep={step}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-3.5">
        <span className="text-md font-semibold">Changes</span>
        <span className="truncate font-mono text-xs text-fg-subtle">vs {data?.base ?? '…'}</span>
        <span className="flex-1" />
        {data ? (
          <>
            <span className="font-mono text-xs font-medium text-diff-add">+{data.added}</span>
            <span className="font-mono text-xs font-medium text-diff-del">−{data.removed}</span>
          </>
        ) : null}
        <FullViewButton full={full} onToggle={onToggleFull} />
        <button
          type="button"
          className={iconButton}
          title={`Close ${keyHint('changes')}`}
          aria-label="Close changes"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {changes.error ? (
        <p role="alert" className="p-3 text-sm text-st-error select-text">
          ✕ {changes.error.message}
        </p>
      ) : null}
      {data && rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
          <div className="font-medium">No changes yet</div>
          <div className="max-w-[220px] text-sm text-fg-subtle">
            Files that differ from {data.base} appear here as Claude edits the worktree.
          </div>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <FilesAndDiff
          full={full}
          linked={false}
          collapsed={collapsed}
          listClass="p-1.5"
          list={
            <>
              {group('committed', 'Committed', data?.committed ?? [])}
              {group('uncommitted', 'Uncommitted', data?.uncommitted ?? [])}
            </>
          }
          collapsedLine={
            <CollapsedFileLine
              file={current?.file ?? null}
              index={at}
              count={rows.length}
              onExpand={toggleCollapsed}
              onStep={step}
            />
          }
          diff={
            <DiffPane
              label={
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg-muted [direction:rtl]">
                  <bdi>{current?.file.path}</bdi>
                </span>
              }
              openButton={
                current && current.file.kind !== 'D' ? (
                  <button
                    type="button"
                    data-open-diff
                    className={button('ghost', 'sm')}
                    title="Open in editor, at the line of the cursor in the diff, else the first change"
                    onClick={() =>
                      editorOpen.open(
                        mainRepo,
                        current.file,
                        current.group,
                        cursorLine.current ??
                          (shown.current?.key.startsWith(`${current.group}:${current.file.path}:`)
                            ? diffFirstLine(shown.current.diff)
                            : null),
                      )
                    }
                  >
                    Open in editor
                  </button>
                ) : null
              }
              diff={
                shown.current &&
                current &&
                shown.current.key.startsWith(`${current.group}:${current.file.path}:`)
                  ? shown.current.diff
                  : null
              }
              path={current?.file.path ?? ''}
              cursorLine={cursorLine}
            />
          }
        />
      ) : (
        <div className="flex-1" />
      )}
      <FinishControls workspace={workspace} />
      {editorOpen.dialog}
    </ChangesFrame>
  );
}
