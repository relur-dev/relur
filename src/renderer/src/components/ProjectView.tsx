import { projectWorkspaces } from '@shared/home';
import { formatBytes, type MemorySnapshot, projectMemory } from '@shared/memory';
import { projectWorktreeDir } from '@shared/projects';
import type { Profile, Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { suspendedNote } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { OtherWorktree, Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, inputClass, isMac, Kbd, keyHint } from '../ui/controls';
import { useSuspended } from '../ui/suspended';
import { SETUP_TAB, SKILLS_TAB, WORKFLOW_TAB, WORKSPACES_TAB } from '../view';
import { Board, BoardEmpty } from './Board';
import { BoardColumns } from './BoardColumns';
import { useBoardLayout } from './board-state';
import { ProjectEditor, useOpenInEditor } from './EditorPicker';
import type { HomeActions } from './home-items';
import { ProjectSetup } from './ProjectSetup';
import { SessionNote } from './SessionNote';
import { ProjectSkills } from './SkillSources';
import { SessionTab, sessionTabNames } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { ProjectWorkflowEditor } from './WorkflowViews';

/**
 * A project's landing page (spec §6.10): its workspaces on the Board, with New
 * workspace as the main action, and the main checkout's own sessions (Open
 * shell, Start Claude here) as tabs next to the Workspaces tab.
 */
export function ProjectView({
  profile,
  project,
  projects,
  workspaces: profileWorkspaces,
  sessions,
  profileSessions,
  actions,
  tab,
  onSelectTab,
  onSessionOpened,
  onNewWorkspace,
  onRemove,
  onAdopt,
  shortcutError,
  memory,
}: {
  profile: Profile;
  project: Project;
  /** The profile's projects, for the linked-in cards' names. */
  projects: Project[];
  /** The profile's workspaces: the Board shows the project's and those linked into it. */
  workspaces: Workspace[];
  /** Main-checkout sessions of the project. */
  sessions: SessionInfo[];
  /** The profile's sessions, for the cards' quick reply and gate answers. */
  profileSessions: SessionInfo[];
  /** What the Board's cards do, as on Home. */
  actions: HomeActions;
  /** a tab of PROJECT_TABS, WORKSPACES_TAB or a session id. */
  tab: string;
  onSelectTab: (tab: string) => void;
  onSessionOpened: (session: SessionInfo) => void;
  onNewWorkspace: (() => void) | null;
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
  const { own: workspaces, linkedIn } = projectWorkspaces(project.id, profileWorkspaces);
  const shown = [...workspaces, ...linkedIn];
  // The profile's one column layout, shared with Home (spec §6.7).
  const [boardLayout, changeBoardLayout] = useBoardLayout(profile.id);
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
            {linkedIn.length > 0 ? (
              <span
                data-linked-in-count={linkedIn.length}
                className="text-xs text-fg-subtle"
                title={`${linkedIn.length} ${linkedIn.length === 1 ? 'workspace' : 'workspaces'} of other projects linked into ${project.name}`}
              >
                + {linkedIn.length} linked
              </span>
            ) : null}
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
        <span className="flex-1" />
        {tab === WORKSPACES_TAB && shown.length > 0 ? (
          <BoardColumns layout={boardLayout} onLayout={changeBoardLayout} workspaces={shown} />
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
        <div className="flex min-h-0 flex-1 flex-col bg-term">
          {shown.length > 0 ? (
            <Board
              profile={profile}
              inProject={project}
              projects={projects}
              workspaces={shown}
              sessions={profileSessions}
              memory={memory}
              actions={actions}
              layout={boardLayout}
              onLayout={changeBoardLayout}
              group="none"
              collapsed={[]}
              onToggleLane={() => {}}
            />
          ) : (
            <BoardEmpty kind="no-workspaces" onNewWorkspace={onNewWorkspace} />
          )}
          <OtherWorktrees projectId={project.id} onAdopt={onAdopt} />
        </div>
      )}
    </div>
  );
}

/**
 * Other worktrees (spec §13.6): the repository's git worktrees no workspace
 * uses, made by a skill or by hand, each with Open as workspace. A strip under
 * the Board while there are any (§6.10), folded until clicked.
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
  const [open, setOpen] = useState(false);
  if (!others.data || others.data.length === 0) return null;
  return (
    <section
      className="shrink-0 border-t border-line bg-canvas px-6"
      data-other-worktrees={open ? 'open' : 'folded'}
    >
      <div className="flex h-9 items-center gap-1.5">
        <button
          type="button"
          data-other-worktrees-toggle
          aria-expanded={open}
          title="Worktrees of this repository that aren't workspaces, made by a skill or by hand"
          className="-ml-1.5 flex h-7 items-center gap-2 rounded-[5px] px-1.5 text-sm text-fg-muted outline-none hover:bg-band-strong hover:text-fg focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden className="w-3 text-center text-2xs text-fg-subtle">
            {open ? '▾' : '▸'}
          </span>
          Other worktrees
          <span className="font-mono text-xs text-fg-subtle">{others.data.length}</span>
        </button>
        <GuideLink to="adopting-worktrees" label="Adopting worktrees" />
      </div>
      {open ? (
        <ul className="mb-2 max-h-48 divide-y divide-line overflow-y-auto border-y border-line">
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
      ) : null}
    </section>
  );
}
