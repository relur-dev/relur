import {
  describeSplit,
  formatBytes,
  type MemorySnapshot,
  projectMemory,
  workspaceMemory,
} from '@shared/memory';
import { projectWorktreeDir } from '@shared/projects';
import type { Profile, Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { backgroundNote, GLYPH_LABEL, glyphFor } from '@shared/status';
import { SUSPENDED_TOOLTIP, suspendClockNote, suspendedNote } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { OtherWorktree, Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, inputClass, isMac, Kbd, keyHint } from '../ui/controls';
import { useLaunching } from '../ui/launching';
import { StatusGlyph } from '../ui/StatusGlyph';
import { useSuspended } from '../ui/suspended';
import { ago } from '../ui/time';
import { SETUP_TAB, SKILLS_TAB, WORKFLOW_TAB, WORKSPACES_TAB } from '../view';
import { ProjectEditor, useOpenInEditor } from './EditorPicker';
import { ProjectSetup } from './ProjectSetup';
import { SessionNote } from './SessionNote';
import { ProjectSkills } from './SkillSources';
import { SessionTab, sessionTabNames } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { ProjectWorkflowEditor } from './WorkflowViews';

const STATE_TEXT: Partial<Record<Workspace['state'], string>> = {
  'needs-permission': 'text-st-permission',
  'needs-input': 'text-st-input',
  'needs-answer': 'text-st-input',
  'awaiting-approval': 'text-st-approval',
  error: 'text-st-error',
};

/**
 * A project's landing page (spec §6.10): its workspaces, with New workspace as
 * the main action, and the main checkout's own sessions (Open shell, Start
 * Claude here) as tabs next to the Workspaces tab.
 */
export function ProjectView({
  profile,
  project,
  workspaces,
  sessions,
  tab,
  onSelectTab,
  onSessionOpened,
  onNewWorkspace,
  onOpenWorkspace,
  onRemove,
  onAdopt,
  shortcutError,
  memory,
}: {
  profile: Profile;
  project: Project;
  workspaces: Workspace[];
  /** Main-checkout sessions of the project. */
  sessions: SessionInfo[];
  /** a tab of PROJECT_TABS, WORKSPACES_TAB or a session id. */
  tab: string;
  onSelectTab: (tab: string) => void;
  onSessionOpened: (session: SessionInfo) => void;
  onNewWorkspace: (() => void) | null;
  onOpenWorkspace: (workspace: Workspace) => void;
  onRemove: () => void;
  /** Open as workspace for one of the project's other worktrees (spec §13.6). */
  onAdopt: (worktree: OtherWorktree) => void;
  /** An error from the view's keyboard shortcuts (⌘T, ⌘L), which the app runs. */
  shortcutError: string | null;
  /** Memory of the running Claude sessions (spec §6.14). */
  memory: MemorySnapshot | null;
}) {
  // Open in editor (spec §6.13): the main checkout, ⌘E.
  const editorOpen = useOpenInEditor();
  const openInEditor = () =>
    void editorOpen.run(() => trpcClient.editor.openProject.mutate({ projectId: project.id }), {
      profileId: profile.id,
      project: { id: project.id, name: project.name },
    });
  const openRef = useRef(openInEditor);
  openRef.current = openInEditor;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut('openInEditor', e, isMac) === -1) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      openRef.current();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);
  const trpc = useTRPC();
  const suspendedWorkspaces = useSuspended();
  const projectShell = useMutation(
    trpc.sessions.projectShell.mutationOptions({ onSuccess: onSessionOpened }),
  );
  const startClaude = useMutation(
    trpc.sessions.startClaudeInProject.mutationOptions({ onSuccess: onSessionOpened }),
  );
  const close = useMutation(trpc.sessions.close.mutationOptions());
  // The project's worktree folder (§8.1): Change… picks one, Use default clears it.
  const pickWorktrees = useMutation(trpc.projects.pickWorktreeFolder.mutationOptions());
  const setWorktreeRoot = useMutation(trpc.projects.setWorktreeRoot.mutationOptions());
  const changeWorktrees = async () => {
    try {
      const picked = await pickWorktrees.mutateAsync();
      if (picked) setWorktreeRoot.mutate({ projectId: project.id, worktreeRoot: picked });
    } catch {
      // Shown below from pickWorktrees.error.
    }
  };
  // The project's remote (§6.10): Change… lists the repository's remotes, and None.
  const [choosingRemote, setChoosingRemote] = useState(false);
  const remotes = useQuery({
    ...trpc.projects.remotes.queryOptions({ projectId: project.id }),
    enabled: choosingRemote,
  });
  const setRemote = useMutation(
    trpc.projects.setRemote.mutationOptions({ onSuccess: () => setChoosingRemote(false) }),
  );
  const active = sessions.find((s) => s.id === tab) ?? null;
  const names = sessionTabNames(sessions);
  const error =
    (
      projectShell.error ??
      startClaude.error ??
      close.error ??
      pickWorktrees.error ??
      setWorktreeRoot.error ??
      remotes.error ??
      setRemote.error
    )?.message ?? shortcutError;

  const details: [string, string][] = [
    ['Path', project.repoPath],
    ['Base branch', project.baseBranch ?? profile.defaults.baseBranch],
    ['Remote', project.remote ?? 'none'],
    ['Worktrees', `${projectWorktreeDir(profile, project)}/`],
  ];
  // The project's running Claude sessions (spec §6.14), only while any runs,
  // and how many are suspended (§9.8), which use none.
  const used = projectMemory(memory, project.id);
  const suspendedCount =
    workspaces.filter((w) => suspendedWorkspaces.has(w.id)).length +
    sessions.filter((s) => s.kind === 'claude' && s.status === 'suspended').length;
  if (used || suspendedCount > 0) {
    details.push([
      'Memory',
      [
        used
          ? `${formatBytes(used.bytes)} · ${used.sessions} ${used.sessions === 1 ? 'session' : 'sessions'}`
          : 'None running',
        ...(suspendedCount > 0 ? [suspendedNote(suspendedCount)] : []),
      ].join(' · '),
    ]);
  }
  // A main checkout's Claude tab: Keep Claude Running, remembered per project (spec §9.8).
  const kept = useQuery(trpc.sessions.keptMainCheckouts.queryOptions());
  const keptHere = kept.data?.includes(project.id) ?? false;
  const claudeTabMenu = async () => {
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [{ id: 'keepRunning', label: 'Keep Claude Running', checked: keptHere }],
    });
    if (choice !== 'keepRunning') return;
    await trpcClient.sessions.setMainCheckoutKept.mutate({
      projectId: project.id,
      on: !keptHere,
    });
    void kept.refetch();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {editorOpen.dialog}
      <header className="shrink-0 px-6 pt-5">
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate font-mono text-xl font-semibold">
            {project.name}
          </h1>
          <button type="button" className={button('danger-quiet')} onClick={onRemove}>
            Remove…
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={button('primary', 'lg')}
            disabled={!onNewWorkspace}
            onClick={onNewWorkspace ?? undefined}
          >
            New workspace <Kbd onFg>{keyHint('newWorkspace')}</Kbd>
          </button>
          <button
            type="button"
            className={button('secondary', 'lg')}
            disabled={projectShell.isPending}
            onClick={() => projectShell.mutate({ projectId: project.id, reuse: false })}
          >
            Open shell <Kbd>{keyHint('newShell')}</Kbd>
          </button>
          <button
            type="button"
            className={button('secondary', 'lg')}
            disabled={startClaude.isPending}
            onClick={() => startClaude.mutate({ projectId: project.id })}
          >
            Start Claude here <Kbd>{keyHint('startClaude')}</Kbd>
          </button>
          <button
            type="button"
            data-open-editor
            className={button('secondary', 'lg')}
            title="Open the main checkout in the project's editor"
            onClick={openInEditor}
          >
            Open in editor <Kbd>{keyHint('openInEditor')}</Kbd>
          </button>
          <span className="text-sm text-fg-subtle">
            Runs in the main checkout at <span className="font-mono">{project.repoPath}</span>, not
            in a workspace.
          </span>
        </div>
        <dl className="mt-4 flex flex-wrap gap-x-9 gap-y-2">
          {details.map(([label, value]) => (
            <div key={label} data-detail={label} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-sm text-fg-muted">
                {label}
                {label === 'Worktrees' ? (
                  <GuideLink to="worktrees#a-folder-you-choose" label="Where worktrees go" />
                ) : null}
                {label === 'Memory' ? (
                  <GuideLink to="memory" label="What the memory counts" />
                ) : null}
              </dt>
              {label === 'Remote' && choosingRemote ? (
                <dd className="mt-0.5">
                  <select
                    aria-label="Remote"
                    // biome-ignore lint/a11y/noAutofocus: opened by Change…, which it replaces.
                    autoFocus
                    className={`${inputClass} h-6.5 font-mono text-sm`}
                    value={project.remote ?? ''}
                    disabled={!remotes.data}
                    onChange={(e) =>
                      setRemote.mutate({ projectId: project.id, remote: e.target.value || null })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setChoosingRemote(false);
                      }
                    }}
                    onBlur={() => setChoosingRemote(false)}
                  >
                    {(remotes.data ?? (project.remote ? [project.remote] : [])).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    <option value="">none</option>
                  </select>
                </dd>
              ) : (
                <dd className="mt-0.5 truncate font-mono text-sm select-text">{value}</dd>
              )}
              {label === 'Remote' && !choosingRemote ? (
                <dd className="mt-0.5 flex gap-1">
                  <button
                    type="button"
                    data-change-remote
                    className={button('ghost', 'sm')}
                    onClick={() => setChoosingRemote(true)}
                  >
                    Change…
                  </button>
                </dd>
              ) : null}
              {label === 'Worktrees' ? (
                <dd className="mt-0.5 flex gap-1">
                  <button
                    type="button"
                    className={button('ghost', 'sm')}
                    onClick={() => void changeWorktrees()}
                  >
                    Change…
                  </button>
                  {project.worktreeRoot ? (
                    <button
                      type="button"
                      className={button('ghost', 'sm')}
                      onClick={() =>
                        setWorktreeRoot.mutate({ projectId: project.id, worktreeRoot: null })
                      }
                    >
                      Use default
                    </button>
                  ) : null}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </header>

      <div className="mt-4 flex h-9 shrink-0 items-end gap-0.5 border-b border-line px-4">
        <div role="tablist" aria-label="Project" className="flex min-w-0 items-end gap-0.5">
          <button
            type="button"
            role="tab"
            aria-selected={tab === WORKSPACES_TAB}
            onClick={() => onSelectTab(WORKSPACES_TAB)}
            className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-md ${
              tab === WORKSPACES_TAB
                ? 'border-fg font-medium text-fg'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            Workspaces <span className="font-mono text-xs text-fg-subtle">{workspaces.length}</span>
          </button>
          {(
            [
              [SETUP_TAB, 'Setup'],
              [SKILLS_TAB, 'Skills'],
              [WORKFLOW_TAB, 'Workflow'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-project-tab={id}
              onClick={() => onSelectTab(id)}
              className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-md ${
                tab === id
                  ? 'border-fg font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {sessions.length > 0 ? (
          <div
            role="tablist"
            aria-label="Terminals"
            className="ml-3 flex min-w-0 items-end gap-0.5 border-l border-line pl-3"
          >
            {sessions.map((session, index) => (
              <SessionTab
                key={session.id}
                session={session}
                name={names.get(session.id) ?? session.title}
                index={index}
                active={session.id === tab}
                onSelect={() => onSelectTab(session.id)}
                onClose={() => close.mutate({ sessionId: session.id })}
                onContextMenu={session.kind === 'claude' ? () => void claudeTabMenu() : undefined}
              />
            ))}
          </div>
        ) : null}
      </div>
      <SessionNote session={active} className="px-6" />
      {error ? (
        <p role="alert" className="px-6 py-2 text-md text-st-error select-text">
          ✕ {error}
        </p>
      ) : null}

      {active ? (
        <div className="min-h-0 flex-1 bg-term">
          <TerminalView
            key={`${active.id}:${active.generation}`}
            sessionId={active.id}
            resuming={active.status === 'suspended' || active.resuming}
          />
        </div>
      ) : tab === WORKFLOW_TAB ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <ProjectWorkflowEditor
            key={project.id}
            profile={profile}
            project={project}
            workspaces={workspaces}
          />
        </div>
      ) : tab === SKILLS_TAB ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <ProjectSkills key={project.id} project={project} />
        </div>
      ) : tab === SETUP_TAB ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <ProjectEditor key={`editor-${project.id}`} project={project} profile={profile} />
          <ProjectSetup key={project.id} project={project} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <WorkspaceTable
            workspaces={workspaces}
            memory={memory}
            onOpen={onOpenWorkspace}
            onNewWorkspace={onNewWorkspace}
          />
          <OtherWorktrees projectId={project.id} onAdopt={onAdopt} />
        </div>
      )}
    </div>
  );
}

type MemorySort = 'none' | 'descending' | 'ascending';
const NEXT_SORT: Record<MemorySort, MemorySort> = {
  none: 'descending',
  descending: 'ascending',
  ascending: 'none',
};

function WorkspaceTable({
  workspaces: unsorted,
  memory,
  onOpen,
  onNewWorkspace,
}: {
  workspaces: Workspace[];
  memory: MemorySnapshot | null;
  onOpen: (workspace: Workspace) => void;
  onNewWorkspace: (() => void) | null;
}) {
  const launching = useLaunching();
  const suspended = useSuspended();
  // Why a running Claude isn't suspended, or when it will be (spec §9.8): the
  // Status cell's tooltip, read again as often as the app checks.
  const trpc = useTRPC();
  const clocks = useQuery(
    trpc.sessions.suspendClocks.queryOptions(undefined, { refetchInterval: 15_000 }),
  );
  const clockNote = (workspaceId: string) => {
    const clock = clocks.data?.find((c) => c.workspaceId === workspaceId);
    return clock ? (suspendClockNote(clock, Date.now()) ?? undefined) : undefined;
  };
  // The Memory column sorts (spec §6.14): largest first, smallest first, then as listed.
  // Workspaces without a running session stay last.
  const [sort, setSort] = useState<MemorySort>('none');
  const used = new Map(unsorted.map((w) => [w.id, workspaceMemory(memory, w.id)]));
  const workspaces =
    sort === 'none'
      ? unsorted
      : [...unsorted].sort((a, b) => {
          const x = used.get(a.id)?.total;
          const y = used.get(b.id)?.total;
          if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
          return sort === 'descending' ? y - x : x - y;
        });
  // Keyboard (spec §6.10): one Tab stop on the rows; ↑↓ move, ↵ opens.
  const [focused, setFocused] = useState(0);
  const tbody = useRef<HTMLTableSectionElement>(null);
  const onRowKey = (event: ReactKeyboardEvent, index: number, w: Workspace) => {
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, workspaces.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? workspaces.length - 1
              : null;
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(w);
    } else if (next !== null) {
      event.preventDefault();
      setFocused(next);
      tbody.current?.querySelectorAll<HTMLElement>('tr')[next]?.focus();
    }
  };
  if (workspaces.length === 0) {
    return (
      <div className="px-2 py-6">
        <p className="font-medium">No workspaces yet</p>
        <p className="mt-1 text-md text-fg-muted">
          A workspace is one task in its own worktree and branch, with Claude and shells running
          there.
        </p>
        <button
          type="button"
          className={`${button('secondary')} mt-3`}
          disabled={!onNewWorkspace}
          onClick={onNewWorkspace ?? undefined}
        >
          New workspace <Kbd>{keyHint('newWorkspace')}</Kbd>
        </button>
      </div>
    );
  }
  const cell = 'px-2 py-2.5 text-left';
  // The workflow status (spec §13.5), when any workspace has one.
  const withWorkflow = workspaces.some((w) => w.workflow);
  return (
    <table className="w-full table-fixed text-md">
      <thead>
        <tr className="border-b border-line text-sm text-fg-muted">
          <th className={`${cell} w-44 font-normal`}>Status</th>
          {withWorkflow ? <th className={`${cell} w-32 font-normal`}>Workflow</th> : null}
          <th className={`${cell} w-24 font-normal`}>Task</th>
          <th className={`${cell} font-normal`}>Title</th>
          <th className={`${cell} w-[30%] font-normal`}>Branch</th>
          <th
            className={`${cell} w-28 text-right font-normal`}
            aria-sort={sort === 'none' ? undefined : sort}
          >
            <button
              type="button"
              data-sort-memory
              title="Sort by memory"
              className="inline-flex items-center gap-1 hover:text-fg"
              onClick={() => setSort(NEXT_SORT[sort])}
            >
              Memory
              <span aria-hidden className="w-2 text-xs">
                {sort === 'descending' ? '↓' : sort === 'ascending' ? '↑' : ''}
              </span>
            </button>
            <span className="ml-1 inline-flex align-middle">
              <GuideLink to="memory" label="What the memory counts" />
            </span>
          </th>
          <th className={`${cell} w-16 text-right font-normal`}>Active</th>
        </tr>
      </thead>
      <tbody ref={tbody}>
        {workspaces.map((w, index) => {
          const glyph = glyphFor(w.state, w.unread, launching.has(w.id));
          const mem = used.get(w.id);
          return (
            <tr
              key={w.id}
              data-workspace-row={w.id}
              tabIndex={index === Math.min(focused, workspaces.length - 1) ? 0 : -1}
              onFocus={() => setFocused(index)}
              onKeyDown={(event) => onRowKey(event, index, w)}
              onClick={() => onOpen(w)}
              className="cursor-default border-b border-line hover:bg-raised focus-visible:bg-raised focus-visible:-outline-offset-2"
            >
              <td
                className={cell}
                data-suspend-note={clockNote(w.id)}
                title={suspended.has(w.id) ? undefined : clockNote(w.id)}
              >
                <span
                  className={`flex items-center gap-2 ${STATE_TEXT[w.state] ?? 'text-fg-muted'}`}
                >
                  {glyph ? <StatusGlyph glyph={glyph} /> : <span className="size-3" />}
                  {glyph ? GLYPH_LABEL[glyph] : w.state === 'done' ? 'Done' : 'Idle'}
                  {/* Background work (spec §10.2). */}
                  {backgroundNote(w.state, w.background) ? (
                    <span data-background className="text-fg-subtle">
                      · {backgroundNote(w.state, w.background)}
                    </span>
                  ) : null}
                  {/* Suspended to save memory (spec §9.8). */}
                  {suspended.has(w.id) ? (
                    <span data-suspended title={SUSPENDED_TOOLTIP} className="text-fg-subtle">
                      · Suspended
                    </span>
                  ) : null}
                </span>
              </td>
              {withWorkflow ? (
                <td
                  data-workflow-cell
                  className={`${cell} truncate text-sm ${w.workflow?.kind === 'unknown' ? 'text-st-permission' : 'text-fg-muted'}`}
                  title={w.workflow?.problem ?? w.workflow?.file ?? undefined}
                >
                  {w.workflow?.label ?? '—'}
                </td>
              ) : null}
              <td className={`${cell} truncate font-mono text-sm text-fg-muted`}>{w.task.id}</td>
              <td className={`${cell} truncate`}>
                <button
                  type="button"
                  tabIndex={-1}
                  className="truncate text-left"
                  onClick={() => onOpen(w)}
                >
                  {w.task.title || w.name}
                </button>
              </td>
              <td className={`${cell} truncate font-mono text-sm`}>{w.branch}</td>
              <td
                data-memory-cell
                className={`${cell} truncate text-right font-mono text-sm text-fg-muted`}
                title={mem ? describeSplit(mem) : undefined}
              >
                {mem ? formatBytes(mem.total) : ''}
              </td>
              <td className={`${cell} text-right font-mono text-sm text-fg-subtle`}>
                {ago(w.lastActivityAt ?? w.createdAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Other worktrees (spec §13.6): the repository's git worktrees no workspace
 * uses, made by a skill or by hand, each with Open as workspace.
 */
function OtherWorktrees({
  projectId,
  onAdopt,
}: {
  projectId: string;
  onAdopt: (worktree: OtherWorktree) => void;
}) {
  const trpc = useTRPC();
  const others = useQuery(
    trpc.workspaces.otherWorktrees.queryOptions(
      { projectId },
      { staleTime: 0, refetchInterval: 15_000 },
    ),
  );
  if (!others.data || others.data.length === 0) return null;
  return (
    <section className="px-2 py-4" data-other-worktrees>
      <h2 className="flex items-center gap-1.5 text-sm text-fg-muted">
        Other worktrees
        <GuideLink to="adopting-worktrees" label="Adopting worktrees" />
      </h2>
      <p className="mt-0.5 text-sm text-fg-subtle">
        Worktrees of this repository that aren't workspaces, made by a skill or by hand.
      </p>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {others.data.map((w) => (
          <li
            key={w.path}
            className="flex items-center gap-3 py-2"
            data-other-worktree={w.branch ?? ''}
          >
            <span className="w-[30%] truncate font-mono text-sm">
              {w.branch ?? 'detached HEAD'}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-sm text-fg-muted"
              title={w.path}
            >
              {w.path}
            </span>
            {w.branch ? (
              <button
                type="button"
                className={button('secondary', 'sm')}
                onClick={() => onAdopt(w)}
              >
                Open as workspace
              </button>
            ) : (
              <span className="text-sm text-fg-subtle">
                Detached HEAD: check out a branch first
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
