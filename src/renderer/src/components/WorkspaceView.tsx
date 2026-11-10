import type { Profile, Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { atMenu, glyphFor } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import {
  canContinue,
  planLimitReached,
  stoppedNote,
  UNFINISHED_TOOLTIP,
  type Unfinished,
} from '@shared/unfinished';
import { documentLabel, effectiveWorkflow } from '@shared/workflow';
import {
  linkedRepos,
  mergedLocally,
  setupFailed,
  type Workspace,
  type WorkspaceRepo,
  workspaceMerged,
} from '@shared/workspaces';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationAids, NavigatorState } from '../terminal/conversation';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton, isMac, Kbd, keyHint } from '../ui/controls';
import { ChangesIcon, EditorIcon, NotesIcon, ResponsesIcon, TrashIcon } from '../ui/icons';
import { takeRequest, takeResponseEntry } from '../ui/open-requests';
import { ChangesPanel, PrBadge } from './ChangesPanel';
import { UnlinkDialog } from './DeleteWorkspaceDialog';
import { OpenAllDialog, showAppNotice, useOpenInEditor } from './EditorPicker';
import { LinkRepositoryDialog } from './LinkRepositoryDialog';
import { NotesPanel } from './NotesPanel';
import { RepoChips } from './RepoChips';
import { ResponsesPanel } from './ResponsesPanel';
import { SessionNote } from './SessionNote';
import { useSkillsChanges } from './SkillSources';
import { SpecView } from './SpecView';
import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { WorkflowActions, WorkflowStepper } from './WorkflowViews';

/** Asks the shown workspace to put its Claude terminal in focus (detail: its id). */
export const FOCUS_CLAUDE_EVENT = 'focus-claude-terminal';

let watchLimitShown = false;

/** Once per run: Linux has no file watches left, so the Changes count is checked every few seconds (spec §6.4). */
function showWatchLimitNotice() {
  if (watchLimitShown) return;
  watchLimitShown = true;
  showAppNotice(
    'The system has no file watches left, so the Changes count is checked every few seconds. To raise the limit: sudo sysctl fs.inotify.max_user_watches=524288 (see the Guide, Linux).',
  );
}

/**
 * The Claude tab's bar (spec §6.8): the Responses toggle (⇧⌘R), and ⌥C,
 * which copies the latest entry (all of Claude's text since the last prompt),
 * read from the transcript, in both of Claude's display modes.
 */
function ResponsesControls({
  workspaceId,
  open,
  compact,
  onToggle,
  onToggleFull,
}: {
  workspaceId: string;
  open: boolean;
  /** A narrow window: the icon alone, its name in the tooltip. */
  compact: boolean;
  onToggle: () => void;
  /** Full view and back, while the panel is open. */
  onToggleFull: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied && !error) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setError(null);
    }, 1500);
    return () => clearTimeout(timer);
  }, [copied, error]);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const onToggleFullRef = useRef(onToggleFull);
  onToggleFullRef.current = onToggleFull;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('copyResponse', e, isMac) !== -1) {
        e.preventDefault();
        e.stopPropagation();
        trpcClient.conversation.copy.mutate({ workspaceId, index: null }).then(
          () => setCopied(true),
          (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
        );
      } else if (matchShortcut('responses', e, isMac) !== -1) {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        e.stopPropagation();
        onToggleRef.current();
      } else if (matchShortcut('responsesFullView', e, isMac) !== -1 && openRef.current) {
        if (document.querySelector('dialog[open]')) return;
        e.preventDefault();
        e.stopPropagation();
        onToggleFullRef.current();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [workspaceId]);
  return (
    <>
      {error ? <span className="text-xs text-st-error">{error}</span> : null}
      {copied ? <span className="text-xs text-fg-muted">Copied the last response</span> : null}
      <button
        type="button"
        data-responses-toggle
        className={compact ? `${iconButton} aria-pressed:bg-raised` : button('ghost', 'sm')}
        aria-pressed={open}
        aria-label="Responses"
        title={`${compact ? 'Responses: C' : 'C'}laude's text for each prompt of the conversation, each with Copy (${keyHint('responses')}); ${keyHint('copyResponse')} copies the latest`}
        onClick={onToggle}
      >
        {compact ? (
          <ResponsesIcon />
        ) : (
          <>
            Responses <Kbd>{keyHint('responses')}</Kbd>
          </>
        )}
      </button>
    </>
  );
}

/** A repository's query input: the main one keeps the plain workspace key. */
const repoInput = (workspaceId: string, repo: WorkspaceRepo) =>
  repo.primary ? { workspaceId } : { workspaceId, projectId: repo.projectId };

/**
 * A workspace (spec §6.2, §6.3): task id, title, `branch ← base` and its
 * ports, then its terminals: Claude, Setup, then Shell tabs. A failed setup
 * offers Retry, Start Claude anyway and Delete (§7.3).
 */
/** A repository just linked with the command line tool (spec §21.9), for the header's line. */
export interface LinkNotice {
  byClaude: boolean;
  repoName: string;
  worktreePath: string;
}

/**
 * The header's conflict mark (spec §6.2): shown only while merging the base
 * would conflict, in any of the workspace's repositories; it opens Changes,
 * where Ask Claude to merge is.
 */
function ConflictMark({
  workspace,
  onOpenChanges,
}: {
  workspace: Workspace;
  onOpenChanges: () => void;
}) {
  const trpc = useTRPC();
  const conflicts = useQuery(
    trpc.changes.conflicts.queryOptions(
      { workspaceId: workspace.id },
      { refetchInterval: 30_000, staleTime: 0 },
    ),
  );
  const found = conflicts.data ?? [];
  const first = found[0];
  if (!first) return null;
  const linked = workspace.repos.length > 1;
  const label =
    found.length > 1
      ? `Conflicts in ${found.length} repositories`
      : `Conflicts with ${first.baseBranch}${linked ? ` in ${first.name}` : ''}`;
  return (
    <button
      type="button"
      data-conflict-mark
      className="ml-3 inline-flex rounded-sm border border-st-permission/60 px-1.5 align-middle font-sans text-xs font-medium text-st-permission hover:bg-st-permission/10"
      title={`${found
        .map((f) => `${linked ? `${f.name}: ` : ''}${f.files.join(', ')}`)
        .join('\n')}\nOpen Changes to ask Claude to merge`}
      onClick={onOpenChanges}
    >
      {label}
    </button>
  );
}

export function WorkspaceView({
  profile,
  projects,
  workspace,
  sessions,
  activeId,
  notice,
  linkNotice,
  onDismissLinkNotice,
  onSelect: selectSession,
  onDelete,
  changesOpen,
  onToggleChanges,
  notesOpen,
  onNotesOpen,
  onPanels,
}: {
  profile: Profile;
  /** The profile's projects. */
  projects: Project[];
  workspace: Workspace;
  /** The workspace's sessions, Claude first. */
  sessions: SessionInfo[];
  activeId: string | null;
  /** Why Claude didn't start, from creating the workspace. */
  notice: string | null;
  /** A repository linked from the command line while this workspace was shown (spec §21.9). */
  linkNotice: LinkNotice | null;
  onDismissLinkNotice: () => void;
  onSelect: (session: SessionInfo) => void;
  onDelete: () => void;
  /** The Changes panel (spec §6.4), toggled with ⌘⇧D. */
  changesOpen: boolean;
  onToggleChanges: () => void;
  /** The Notes panel (spec §6.15), toggled with ⇧⌘K; kept open per workspace, as Changes. */
  notesOpen: boolean;
  onNotesOpen: (workspaceId: string, open: boolean) => void;
  /** Whether the spec view and the Responses panel are open, remembered for the next start (spec §5). */
  onPanels: (panels: { spec: boolean; responses: boolean }) => void;
}) {
  const trpc = useTRPC();
  // The spec view's tab (spec §13.8) replaces the terminal while shown.
  // Review at a gate on Home opens it straight away (spec §6.7).
  const [docShown, setDocShown] = useState(() => takeRequest(workspace.id, 'spec'));
  // The Responses panel (spec §6.8) and the Claude terminal it scrolls.
  // At start, open as it was when the app quit (spec §5).
  const [responsesOpen, setResponsesOpen] = useState(() => takeRequest(workspace.id, 'responses'));
  // From a Board card: the entry to show, expanded (spec §6.7); later, from a
  // note's View response (§6.15).
  const [responsesEntry, setResponsesEntry] = useState(() => {
    const index = takeResponseEntry(workspace.id);
    return index === null ? null : { index, at: Date.now() };
  });
  // The Notes panel (spec §6.15), on every tab; Add note's requests, and the
  // items a Responses entry's "from notes" label shows.
  const setNotesOpen = useCallback(
    (open: boolean) => onNotesOpen(workspace.id, open),
    [onNotesOpen, workspace.id],
  );
  // ⌥⌘N's request, by when it was made; cleared once the panel's box has the
  // focus, so the panel opening again later doesn't take it.
  const [noteFocus, setNoteFocus] = useState<number | null>(null);
  const noteFocusHandled = useCallback(() => setNoteFocus(null), []);
  const [notesHighlight, setNotesHighlight] = useState<{ ids: string[]; at: number } | null>(null);
  const [responsesFull, setResponsesFull] = useState(false);
  // The Changes panel's full view (spec §6.4), reset when the panel closes.
  const [changesFull, setChangesFull] = useState(false);
  useEffect(() => {
    if (!changesOpen) setChangesFull(false);
  }, [changesOpen]);
  const toggleChangesFull = useCallback(() => {
    setChangesFull((full) => !full);
    setResponsesFull(false);
  }, []);
  const changesOpenRef = useRef(changesOpen);
  changesOpenRef.current = changesOpen;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('changesFullView', e, isMac) === -1 || !changesOpenRef.current) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      toggleChangesFull();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [toggleChangesFull]);
  const [aids, setAids] = useState<ConversationAids | null>(null);
  const [alternate, setAlternate] = useState(false);
  const onNavigator = useCallback((state: NavigatorState) => setAlternate(state.alternate), []);
  const onSelect = useCallback(
    (session: SessionInfo) => {
      setDocShown(false);
      selectSession(session);
    },
    [selectSession],
  );
  const shell = useMutation(trpc.workspaces.shell.mutationOptions({ onSuccess: onSelect }));
  const startClaude = useMutation(
    trpc.workspaces.startClaude.mutationOptions({ onSuccess: onSelect }),
  );
  const close = useMutation(trpc.sessions.close.mutationOptions());
  const linked = workspace.repos.length > 1;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const mainName = projectName(workspace.projectId);
  // The file count on the Changes toggle, across repositories (spec §21.5):
  // refreshed when files change in the worktrees (in Claude or a shell), with
  // a slow check as a fallback while the panel is closed.
  const queryClient = useQueryClient();
  useSubscription(
    trpc.changes.watch.subscriptionOptions(
      { workspaceId: workspace.id, projectIds: workspace.repos.map((r) => r.projectId) },
      {
        onData: (what) => {
          void queryClient.invalidateQueries(trpc.changes.pathFilter());
          if (what === 'limit') showWatchLimitNotice();
        },
      },
    ),
  );
  const changes = useQueries({
    queries: workspace.repos.map((r) =>
      trpc.changes.list.queryOptions(repoInput(workspace.id, r), {
        refetchInterval: changesOpen ? 3000 : 30_000,
        staleTime: 0,
        retry: false,
      }),
    ),
  });
  const changesLoaded = changes.every((c) => c.data);
  const changedFiles = changes.reduce(
    (n, c) => n + (c.data?.committed.length ?? 0) + (c.data?.uncommitted.length ?? 0),
    0,
  );
  // Unpushed commits per repository, for the chips.
  const states = useQueries({
    queries: (linked ? workspace.repos : []).map((r) =>
      trpc.changes.state.queryOptions(repoInput(workspace.id, r), {
        refetchInterval: 10_000,
        staleTime: 0,
        retry: false,
      }),
    ),
  });
  const [linking, setLinking] = useState(false);
  // Open in editor (spec §6.13): a repository in its project's editor; Open all.
  const editorOpen = useOpenInEditor();
  const [openAll, setOpenAll] = useState(false);
  const openRepoInEditor = (r: WorkspaceRepo) =>
    void editorOpen.run(
      () =>
        trpcClient.editor.openWorktree.mutate({
          workspaceId: workspace.id,
          projectId: r.primary ? null : r.projectId,
        }),
      {
        profileId: workspace.profileId,
        project: { id: r.projectId, name: projectName(r.projectId) },
      },
    );
  const primaryRepo = workspace.repos.find((r) => r.primary) ?? workspace.repos[0];
  const openMainInEditor = () => {
    if (primaryRepo) openRepoInEditor(primaryRepo);
  };
  const openMainRef = useRef(openMainInEditor);
  openMainRef.current = openMainInEditor;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('openInEditor', e, isMac) === -1) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      openMainRef.current();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
  // Show in Changes from a repository chip: that repository's section.
  const [changesFocus, setChangesFocus] = useState<{ projectId: string; at: number } | null>(null);
  const [unlinking, setUnlinking] = useState<Project | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const mergedRepo = workspaceMerged(workspace);
  const merged = mergedRepo !== null;
  const runSetup = useMutation(trpc.workspaces.runSetup.mutationOptions({ onSuccess: onSelect }));
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null;
  const mainProject = projects.find((p) => p.id === workspace.projectId);
  const workflowSettings = mainProject ? effectiveWorkflow(profile, mainProject) : null;
  const showDoc = docShown && !!workspace.workflow?.file;
  const responsesShown = responsesOpen && active?.kind === 'claude' && !showDoc;
  useEffect(
    () => onPanels({ spec: showDoc, responses: responsesOpen }),
    [onPanels, showDoc, responsesOpen],
  );
  // In a narrow window the Notes and Responses panels replace each other (spec §6.15).
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const notesOpenRef = useRef(notesOpen);
  notesOpenRef.current = notesOpen;
  const toggleNotes = useCallback(() => {
    const open = !notesOpenRef.current;
    if (open && narrowRef.current) setResponsesOpen(false);
    setNotesOpen(open);
  }, [setNotesOpen]);
  // ⇧⌘K shows or hides the Notes panel; ⌥⌘N opens it with its box in focus (spec §6.6).
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      const toggle = matchShortcut('notes', e, isMac) !== -1;
      const add = matchShortcut('addNote', e, isMac) !== -1;
      if (!toggle && !add) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (toggle) {
        toggleNotes();
        return;
      }
      if (narrowRef.current) setResponsesOpen(false);
      setNotesOpen(true);
      setNoteFocus(Date.now());
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [toggleNotes, setNotesOpen]);
  // A sent note's View response: the Claude tab with the Responses panel at its entry.
  const claudeSession = sessions.find((s) => s.kind === 'claude') ?? null;
  const viewResponse = (index: number) => {
    if (claudeSession && active?.id !== claudeSession.id) onSelect(claudeSession);
    setDocShown(false);
    if (narrow) setNotesOpen(false);
    setResponsesOpen(true);
    setResponsesFull(false);
    setChangesFull(false);
    setResponsesEntry({ index, at: Date.now() });
  };
  // A Responses entry's "from notes" label: the Notes panel at its items.
  const showNotes = useCallback(
    (ids: string[]) => {
      if (narrowRef.current) setResponsesOpen(false);
      setNotesOpen(true);
      setNotesHighlight({ ids, at: Date.now() });
    },
    [setNotesOpen],
  );
  // ⌘⇧↵ at a gate (spec §13.5): the Claude terminal, for the answer the gate waits for.
  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== workspace.id) return;
      setDocShown(false);
      setTimeout(
        () =>
          document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus(),
        50,
      );
    };
    window.addEventListener(FOCUS_CLAUDE_EVENT, focus);
    return () => window.removeEventListener(FOCUS_CLAUDE_EVENT, focus);
  }, [workspace.id]);
  // A suspended Claude counts: opening the workspace resumes it (spec §9.8).
  const claudeRunning = sessions.some((s) => s.kind === 'claude' && s.status !== 'exited');
  const setupRunning = sessions.some((s) => s.kind === 'setup' && s.status === 'running');
  const failedRepos = workspace.repos.filter((r) => r.setupError);
  // Until Claude takes over (Start Claude anyway); the chips keep showing which failed.
  const failed = setupFailed(workspace);
  // The failed repository's Setup tab opens itself once (spec §21.3).
  const shownFailure = useRef<string | null>(null);
  const failedSetup = linked
    ? sessions.find(
        (s) =>
          s.kind === 'setup' &&
          s.status === 'exited' &&
          s.exitCode !== 0 &&
          failedRepos.some((r) => r.projectId === s.projectId),
      )
    : undefined;
  useEffect(() => {
    if (!failedSetup || shownFailure.current === failedSetup.id) return;
    shownFailure.current = failedSetup.id;
    onSelect(failedSetup);
  }, [failedSetup, onSelect]);
  const glyphs = Object.fromEntries(
    sessions
      .filter((s) => s.kind === 'claude')
      .map((s) => [
        s.id,
        s.status !== 'exited' ? glyphFor(workspace.state, workspace.unread, s.launching) : 'exited',
      ]),
  );
  // ⌘R is Retry while setup has failed (spec §6.6); F5 on Linux and Windows, which a focused
  // terminal keeps (programs there use it).
  const retry = failed && !runSetup.isPending && !setupRunning;
  const retryRef = useRef(() => {});
  retryRef.current = () => {
    if (retry) runSetup.mutate({ workspaceId: workspace.id });
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('checkAgain', e, isMac) === -1) return;
      if (document.querySelector('dialog[open]')) return;
      if (!isMac && document.activeElement?.closest('.xterm')) return;
      e.preventDefault();
      e.stopPropagation();
      retryRef.current();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
  const error =
    (shell.error ?? startClaude.error ?? close.error ?? runSetup.error)?.message ?? notice;
  // An exited Claude tab restarts with ↵ (components.md, Terminal tab).
  const restartable = active?.kind === 'claude' && active.status === 'exited' && !claudeRunning;
  useEffect(() => {
    if (!restartable) return;
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('restartClaude', e, isMac) === -1) return;
      if (document.querySelector('dialog[open]')) return;
      // ↵ in a text field beside the terminal (a note, the Notes box) is that field's.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        target?.matches('input, textarea, [contenteditable="true"]') &&
        !target.closest('[data-terminal]')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      startClaude.mutate({ workspaceId: workspace.id });
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, [restartable, startClaude, workspace.id]);

  // Link another repository…, Unlink <repo>… per linked one, Delete (spec §21.4).
  const menu = async () => {
    const linkable = projects.filter((p) => !workspace.repos.some((r) => r.projectId === p.id));
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [
        {
          id: 'link',
          label:
            linkable.length > 0
              ? 'Link another repository…'
              : projects.length > 1
                ? 'Link another repository… (every project is in)'
                : `Link another repository… (${profile.name} has no other projects)`,
          enabled: linkable.length > 0,
        },
        ...linkedRepos(workspace).map((r) => ({
          id: `unlink:${r.projectId}`,
          label: `Unlink ${projectName(r.projectId)}…`,
        })),
        { id: 'mayLink', label: 'Let Claude Add Repositories', checked: workspace.claudeMayLink },
        { id: 'delete', label: 'Delete workspace…' },
      ],
    });
    if (choice === 'delete') onDelete();
    else if (choice === 'mayLink') {
      void trpcClient.workspaces.setClaudeMayLink.mutate({
        workspaceId: workspace.id,
        on: !workspace.claudeMayLink,
      });
    } else if (choice === 'link') setLinking(true);
    else if (choice?.startsWith('unlink:')) {
      const project = projects.find((p) => p.id === choice.slice('unlink:'.length));
      if (project) setUnlinking(project);
    }
  };
  // + in a linked workspace: New shell in… one row per repository (components.md).
  const newShell = async () => {
    if (!linked) {
      shell.mutate({ workspaceId: workspace.id });
      return;
    }
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: workspace.repos.map((r) => ({
        id: r.projectId,
        label: `$ ${projectName(r.projectId)} — ${r.worktreePath}`,
      })),
    });
    if (choice)
      shell.mutate(
        repoInput(
          workspace.id,
          workspace.repos.find((r) => r.projectId === choice) as WorkspaceRepo,
        ),
      );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-surface px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2.5">
          {workspace.task.id ? (
            <span className="rounded-sm border border-line bg-raised px-1.5 py-px font-mono text-sm">
              {workspace.task.id}
            </span>
          ) : null}
          <h1 className="min-w-0 truncate text-lg font-semibold">
            {workspace.task.title || workspace.name}
          </h1>
          <button
            type="button"
            data-delete-workspace
            className={`${iconButton} -ml-1 text-fg-subtle`}
            title="Delete workspace…"
            aria-label="Delete workspace"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className={iconButton}
            title="Workspace menu"
            aria-label="Workspace menu"
            onClick={() => void menu()}
          >
            ⋯
          </button>
        </div>
        {linked ? (
          <RepoChips
            workspace={workspace}
            sessions={sessions}
            projectName={projectName}
            unpushed={workspace.repos.map((_r, i) => states[i]?.data?.unpushed ?? 0)}
            actions={{
              openInEditor: (r) => openRepoInEditor(r),
              newShell: (r) => shell.mutate(repoInput(workspace.id, r)),
              showChanges: (r) => {
                setChangesFocus({ projectId: r.projectId, at: Date.now() });
                if (!changesOpen) onToggleChanges();
              },
              unlink: (r) => {
                const project = projects.find((p) => p.id === r.projectId);
                if (project) setUnlinking(project);
              },
            }}
          />
        ) : null}
        {linkNotice ? (
          <div
            role="status"
            data-link-notice
            className="mt-2 flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1 text-sm"
          >
            <span className="text-fg-subtle">↗</span>
            <span className="min-w-0 flex-1 truncate select-text">
              {linkNotice.byClaude
                ? `Claude added ${linkNotice.repoName}`
                : `${linkNotice.repoName} was linked from a terminal`}
              <span className="font-mono text-fg-muted"> · {linkNotice.worktreePath}</span>
            </span>
            <button
              type="button"
              className={iconButton}
              title="Dismiss"
              aria-label="Dismiss"
              onClick={onDismissLinkNotice}
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="mt-1.5 font-mono text-sm text-fg-muted select-text">
          {linked ? null : (
            <>
              {workspace.branch} <span className="text-fg-subtle">←</span> {workspace.baseBranch}
            </>
          )}
          {workspace.ports ? (
            <span
              className={`${linked ? '' : 'ml-3 '}text-fg-subtle`}
              title="Its ports (spec §8.4): $PORT is the first"
            >
              ports {workspace.ports.base}–{workspace.ports.base + workspace.ports.count - 1}
            </span>
          ) : null}
          {workspace.pr && !linked ? (
            <span className="ml-3 inline-flex align-middle">
              <PrBadge pr={workspace.pr} />
            </span>
          ) : null}
          <ConflictMark
            workspace={workspace}
            onOpenChanges={() => {
              if (!changesOpen) onToggleChanges();
            }}
          />
        </div>
        {workspace.workflow ? (
          <div data-workflow className="mt-2 flex min-w-0 items-center gap-3">
            <WorkflowStepper workflow={workspace.workflow} />
            <WorkflowActions
              workspaceId={workspace.id}
              workflow={workspace.workflow}
              state={workspace.state}
              claudeRunning={sessions.some((s) => s.kind === 'claude' && s.status !== 'exited')}
              onReview={() => setDocShown(true)}
            />
          </div>
        ) : null}
        <SkillsChanged workspaceId={workspace.id} />
      </header>
      {/* The workspace's identity above, its views below (spec §6.2). */}
      <hr data-header-separator className="h-px shrink-0 border-0 bg-line" />

      <TerminalTabs
        sessions={sessions}
        activeId={showDoc ? null : (active?.id ?? null)}
        document={
          workspace.workflow?.file
            ? {
                label: documentLabel(workflowSettings ?? {}, workspace.workflow.file),
                active: showDoc,
                onSelect: () => setDocShown(true),
              }
            : null
        }
        glyphs={glyphs}
        onSelect={onSelect}
        onClose={(session) => () => close.mutate({ sessionId: session.id })}
        onNew={() => void newShell()}
        repoName={
          linked ? (session) => projectName(session.projectId ?? workspace.projectId) : undefined
        }
        actions={
          // The workspace's views (spec §6.2): Responses on a Claude tab, Open in
          // editor and Changes; icons with tooltips in a narrow window.
          <div data-view-buttons className="flex items-center gap-1">
            <button
              type="button"
              data-notes-toggle
              className={
                narrow
                  ? `${iconButton} w-auto gap-1 px-1 aria-pressed:bg-raised`
                  : button('ghost', 'sm')
              }
              aria-pressed={notesOpen}
              aria-label={`Notes${workspace.notes?.unsent ? `, ${workspace.notes.unsent} unsent` : ''}`}
              title={`Notes: thoughts for Claude, sent when you're ready (${keyHint('notes')}; ${keyHint('addNote')} to write one)`}
              onClick={toggleNotes}
            >
              {narrow ? <NotesIcon /> : 'Notes'}
              <span className="font-mono text-xs text-fg-subtle">
                {workspace.notes?.unsent ? workspace.notes.unsent : ''}
              </span>
              {narrow ? null : <Kbd>{keyHint('notes')}</Kbd>}
            </button>
            {active?.kind === 'claude' && !showDoc ? (
              <ResponsesControls
                workspaceId={workspace.id}
                open={responsesOpen}
                compact={narrow}
                onToggle={() => {
                  if (!responsesOpen && narrow) setNotesOpen(false);
                  setResponsesOpen(!responsesOpen);
                  setResponsesFull(false);
                }}
                onToggleFull={() => {
                  setResponsesFull((full) => !full);
                  setChangesFull(false);
                }}
              />
            ) : null}
            <span className="flex items-center">
              <button
                type="button"
                data-open-editor
                className={narrow ? iconButton : button('ghost', 'sm')}
                aria-label="Open in editor"
                title={`Open ${linked ? `${mainName} ` : ''}in its editor (${keyHint('openInEditor')})`}
                onClick={openMainInEditor}
              >
                {narrow ? (
                  <EditorIcon />
                ) : (
                  <>
                    Open in editor <Kbd>{keyHint('openInEditor')}</Kbd>
                  </>
                )}
              </button>
              {linked ? (
                <button
                  type="button"
                  data-open-editor-menu
                  className={`${iconButton} w-4`}
                  title="Open all repositories in their editors"
                  aria-label="More ways to open in editor"
                  onClick={() =>
                    void trpcClient.ui.contextMenu
                      .mutate({ items: [{ id: 'all', label: 'Open all…' }] })
                      .then((choice) => choice === 'all' && setOpenAll(true))
                  }
                >
                  ▾
                </button>
              ) : null}
            </span>
            <button
              type="button"
              data-changes-toggle
              className={narrow ? `${iconButton} w-auto gap-1 px-1` : button('ghost', 'sm')}
              aria-pressed={changesOpen}
              aria-label={`Changes${changesLoaded ? `, ${changedFiles} files` : ''}`}
              title={`Changes against ${workspace.baseBranch} (${keyHint('changes')})`}
              onClick={onToggleChanges}
            >
              {narrow ? <ChangesIcon /> : 'Changes'}
              <span className="font-mono text-xs text-fg-subtle">
                {changesLoaded ? changedFiles : ''}
              </span>
              {narrow ? null : <Kbd>{keyHint('changes')}</Kbd>}
            </button>
          </div>
        }
      />
      {merged ? (
        <div
          data-merged
          className="flex items-center gap-2 border-b border-st-error/40 bg-st-error/9 px-4 py-2 text-md"
        >
          <span className="min-w-0 flex-1 truncate text-fg-muted">
            {linked
              ? `${workspace.branch} is merged in every repository with commits.`
              : mergedRepo?.pr?.state === 'likely-merged' && !mergedRepo.merged
                ? `${workspace.branch} was deleted on the remote, so it was likely merged.`
                : mergedLocally(mergedRepo?.merged ?? null) && mergedRepo?.pr?.state !== 'merged'
                  ? `${workspace.branch} is merged into your local ${workspace.baseBranch} (not pushed yet).`
                  : `${workspace.branch} is merged into ${workspace.baseBranch}.`}{' '}
            Delete workspace?
          </span>
          <button type="button" className={button('secondary', 'sm')} onClick={onDelete}>
            Delete…
          </button>
        </div>
      ) : null}
      {workspace.unfinished ? (
        <UnfinishedBar
          workspaceId={workspace.id}
          profileId={workspace.profileId}
          unfinished={workspace.unfinished}
        />
      ) : null}
      {failed ? (
        <div
          role="alert"
          data-setup-failed
          className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-md"
        >
          <span className="min-w-0 flex-1 select-text">
            <span className="block truncate text-st-error">✕ {workspace.stateMessage}</span>
            {linked && failedRepos.length > 0 ? (
              <span className="block truncate text-sm text-fg-muted">
                {failedRepos.length < workspace.repos.length
                  ? `${workspace.repos
                      .filter((r) => !r.setupError)
                      .map((r) => projectName(r.projectId))
                      .join(
                        ', ',
                      )} ${workspace.repos.length - failedRepos.length === 1 ? 'is' : 'are'} ready; `
                  : ''}
                Claude starts when every repository is.
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className={button('secondary', 'sm')}
            title={
              failedRepos.length > 0
                ? `Runs setup again in ${failedRepos.map((r) => projectName(r.projectId)).join(', ')}`
                : undefined
            }
            disabled={!retry}
            onClick={() => runSetup.mutate({ workspaceId: workspace.id })}
          >
            Retry <Kbd>{keyHint('checkAgain')}</Kbd>
          </button>
          <button
            type="button"
            className={button('secondary', 'sm')}
            disabled={startClaude.isPending || claudeRunning}
            onClick={() => startClaude.mutate({ workspaceId: workspace.id })}
          >
            Start Claude anyway
          </button>
          <button type="button" className={button('danger-quiet', 'sm')} onClick={onDelete}>
            Delete…
          </button>
        </div>
      ) : setupRunning && !claudeRunning ? (
        <div className="border-b border-line bg-surface px-4 py-2 text-md text-fg-muted">
          Running setup. Claude starts when it finishes.
        </div>
      ) : claudeRunning ? null : (
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 text-md">
          <span className="text-fg-muted">
            Claude isn't running in this workspace.
            {active?.kind === 'claude'
              ? ` ${keyHint('restartClaude')} restart · ${keyHint('closeTab')} close`
              : ''}
          </span>
          <button
            type="button"
            className={button('secondary', 'sm')}
            disabled={startClaude.isPending}
            onClick={() => startClaude.mutate({ workspaceId: workspace.id })}
          >
            Start Claude
          </button>
        </div>
      )}
      <SessionNote session={active} className="px-4" />
      {error ? (
        <p role="alert" className="px-4 py-2 text-md text-st-error select-text">
          ✕ {error}
        </p>
      ) : null}
      <div data-workspace-area className="relative flex min-h-0 flex-1">
        {/* Hidden, not removed, in the Responses panel's full view: the terminal keeps its state. */}
        <div
          className={`min-h-0 min-w-0 flex-1 flex-col bg-term ${(responsesShown && responsesFull) || (changesOpen && changesFull) ? 'hidden' : 'flex'}`}
        >
          {showDoc && workspace.workflow ? (
            <SpecView
              workspaceId={workspace.id}
              workflow={workspace.workflow}
              idField={workflowSettings?.idField ?? null}
            />
          ) : active ? (
            <TerminalView
              key={`${active.id}:${active.generation}`}
              sessionId={active.id}
              resuming={active.status === 'suspended' || active.resuming}
              conversation={
                active.kind === 'claude'
                  ? { workspaceId: workspace.id, onState: onNavigator, onAids: setAids }
                  : undefined
              }
            />
          ) : null}
        </div>
        {responsesShown && !(changesOpen && changesFull) ? (
          <ResponsesPanel
            workspaceId={workspace.id}
            entry={responsesEntry}
            aids={aids}
            alternate={alternate}
            narrow={narrow}
            running={workspace.state === 'working' || atMenu(workspace.state)}
            asking={workspace.state === 'needs-permission'}
            full={responsesFull}
            onToggleFull={() => {
              setResponsesFull((full) => !full);
              setChangesFull(false);
            }}
            onClose={() => {
              setResponsesOpen(false);
              setResponsesFull(false);
            }}
            onShowNotes={showNotes}
          />
        ) : null}
        {notesOpen && !(responsesShown && responsesFull) && !(changesOpen && changesFull) ? (
          <NotesPanel
            workspaceId={workspace.id}
            narrow={narrow}
            focusRequest={noteFocus}
            onFocusHandled={noteFocusHandled}
            highlight={notesHighlight}
            onViewResponse={viewResponse}
            onClose={() => setNotesOpen(false)}
          />
        ) : null}
        {changesOpen && !(responsesShown && responsesFull) ? (
          <ChangesPanel
            workspace={workspace}
            projects={projects}
            narrow={narrow}
            full={changesFull}
            onToggleFull={toggleChangesFull}
            focus={changesFocus}
            onClose={onToggleChanges}
          />
        ) : null}
      </div>
      {editorOpen.dialog}
      {openAll ? (
        <OpenAllDialog workspaceId={workspace.id} onClose={() => setOpenAll(false)} />
      ) : null}
      {linking ? (
        <LinkRepositoryDialog
          profile={profile}
          projects={projects}
          workspace={workspace}
          mainName={mainName}
          onClose={() => setLinking(false)}
          onLinked={(session) => {
            if (session) onSelect(session);
          }}
        />
      ) : null}
      {unlinking ? (
        <UnlinkDialog
          workspace={workspace}
          project={unlinking}
          mainName={mainName}
          onClose={() => setUnlinking(null)}
          onDone={() => setUnlinking(null)}
        />
      ) : null}
    </div>
  );
}

/** The bar's text after "Claude didn't finish when … closed:" (spec §9.7). */
function unfinishedBarText({ kind, stopped }: Unfinished): string {
  switch (kind) {
    case 'working':
      return 'it was working.';
    case 'interrupted':
      return 'you had interrupted it with Esc.';
    case 'permission':
      return 'it was asking for permission. Give it again in the Claude tab.';
    case 'question':
      return 'it was asking you a question.';
    case 'commands':
      return `${stoppedNote(stopped)}.`;
  }
}

/**
 * The Unfinished marker's bar (spec §9.7): Continue sends the profile's
 * continue prompt (never while plan usage is at its limit), Dismiss drops
 * the marker. A permission can't be continued, only given again.
 */
function UnfinishedBar({
  workspaceId,
  profileId,
  unfinished,
}: {
  workspaceId: string;
  profileId: string;
  unfinished: Unfinished;
}) {
  const { kind } = unfinished;
  const trpc = useTRPC();
  const usage = useQuery(trpc.usage.all.queryOptions());
  const limit = planLimitReached(usage.data?.[profileId]);
  const proceed = useMutation(trpc.unfinished.continue.mutationOptions());
  const dismiss = useMutation(trpc.unfinished.dismiss.mutationOptions());
  return (
    <div
      data-unfinished-bar={kind}
      className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-md"
    >
      <span className="min-w-0 flex-1 truncate text-fg-muted">
        {UNFINISHED_TOOLTIP}: {unfinishedBarText(unfinished)}
      </span>
      {canContinue(kind) ? (
        <button
          type="button"
          className={button('secondary', 'sm')}
          disabled={!!limit || proceed.isPending}
          title={limit ?? 'Sends the continue prompt from Edit profile'}
          onClick={() => proceed.mutate({ workspaceIds: [workspaceId] })}
        >
          Continue
        </button>
      ) : null}
      <button
        type="button"
        className={button('ghost', 'sm')}
        onClick={() => dismiss.mutate({ workspaceId })}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * Skills changed, with Restart Claude (spec §13.3): the workspace's Claude started
 * with other skills than it would get now. Restarting resumes the conversation.
 */
function SkillsChanged({ workspaceId }: { workspaceId: string }) {
  const trpc = useTRPC();
  useSkillsChanges();
  const changed = useQuery(trpc.skills.changedWorkspaces.queryOptions(undefined, { staleTime: 0 }));
  const restart = useMutation(trpc.workspaces.restartClaude.mutationOptions());
  if (!changed.data?.includes(workspaceId)) return null;
  return (
    <div data-skills-changed className="mt-2 flex items-center gap-2 text-sm">
      <span className="text-fg-muted">Skills changed since Claude started.</span>
      <button
        type="button"
        className={button('secondary', 'sm')}
        disabled={restart.isPending}
        onClick={() => restart.mutate({ workspaceId })}
      >
        Restart Claude
      </button>
      {restart.error ? <span className="text-st-error">✕ {restart.error.message}</span> : null}
    </div>
  );
}
