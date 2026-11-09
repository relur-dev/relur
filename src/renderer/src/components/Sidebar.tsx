import type { Config, Profile, Project } from '@shared/schemas';
import {
  backgroundNote,
  GLYPH_LABEL,
  GLYPH_ROW_LABEL,
  type StatusGlyph as Glyph,
  glyphFor,
  STATE_LABEL,
} from '@shared/status';
import { SUSPENDED_TOOLTIP } from '@shared/suspend';
import { unfinishedTooltip, workspaceGlyph } from '@shared/unfinished';
import { linkedRepos, type Workspace } from '@shared/workspaces';
import { type KeyboardEvent, useRef, useState } from 'react';
import { trpcClient } from '../trpc';
import { iconButton, Kbd, keyHint, REVEAL_LABEL } from '../ui/controls';
import { useLaunching } from '../ui/launching';
import { useLinkedDisclosure } from '../ui/linked-disclosure';
import { useNow } from '../ui/now';
import { ProfileDot } from '../ui/profile-color';
import { StatusGlyph } from '../ui/StatusGlyph';
import { useSuspended } from '../ui/suspended';
import { elapsed } from '../ui/time';
import { HOME, type View } from '../view';
import { useOpenInEditor } from './EditorPicker';

const row =
  'group mx-1.5 flex h-7 items-center gap-2 rounded-md px-2 transition-colors duration-120 ease-out-quiet';
const rowState = (selected: boolean) =>
  selected ? 'bg-selected font-medium text-fg' : 'text-fg hover:bg-raised';

/** The glyphs a collapsed project shows, most urgent first (spec §6.1). */
const URGENCY: Glyph[] = ['permission', 'input', 'question', 'approval', 'error', 'working'];

const LABEL_COLOR: Partial<Record<Workspace['state'], string>> = {
  'needs-permission': 'text-st-permission',
  'needs-input': 'text-st-input',
  'needs-answer': 'text-st-input',
  'awaiting-approval': 'text-st-approval',
  error: 'text-st-error',
};

/**
 * A workspace row's tooltip (spec §6.1): its name (task id and title), then
 * its state, at a gate with the gate's label, with its background work
 * (§10.2), and its branch.
 */
function rowTooltip(w: Workspace, glyph: Glyph | null, suspended: boolean): string {
  // Suspended to save memory (spec §9.8), on a line of its own.
  const tail = suspended ? `\n${SUSPENDED_TOOLTIP}` : '';
  // The Unfinished marker (spec §9.7) says why instead.
  if (glyph === 'unfinished') {
    return `${w.name}\n${unfinishedTooltip(w.unfinished)} · ${w.branch}${tail}`;
  }
  const state =
    w.state === 'awaiting-approval' && w.workflow?.label
      ? `${STATE_LABEL[w.state]}: ${w.workflow.label}`
      : w.state === 'done' && w.unread
        ? 'Done (unread)'
        : STATE_LABEL[w.state];
  const note = backgroundNote(w.state, w.background);
  return `${w.name}\n${note ? `${state} · ${note}` : state} · ${w.branch}${tail}`;
}

/** The active profile's tree: Home, then projects with their workspaces. */
export function Sidebar({
  config,
  profile,
  workspaces,
  view,
  selectedWorkspaceId,
  onShowView,
  onOpenWorkspace,
  isExpanded,
  onToggleProject,
  onAddProject,
  onRemoveProject,
  onNewWorkspace,
  onDeleteWorkspace,
}: {
  config: Config;
  profile: Profile;
  /** The profile's workspaces. */
  workspaces: Workspace[];
  view: View;
  selectedWorkspaceId: string | null;
  onShowView: (profileId: string, view: View) => void;
  onOpenWorkspace: (workspace: Workspace) => void;
  isExpanded: (project: Project) => boolean;
  onToggleProject: (project: Project) => void;
  onAddProject: () => void;
  onRemoveProject: (project: Project) => void;
  /** Null until workspaces can be created from here. */
  onNewWorkspace: ((project: Project | null) => void) | null;
  onDeleteWorkspace: (workspace: Workspace) => void;
}) {
  const launching = useLaunching();
  const suspended = useSuspended();
  // Working rows show their elapsed time (components.md, Status glyph).
  const now = useNow(workspaces.some((w) => w.state === 'working'));
  const projects = config.projects.filter((p) => p.profileId === profile.id);
  // Other projects' workspaces linked into a project sit in its Linked group (spec §6.1, §21.1).
  const linkedGroups = useLinkedDisclosure();
  const linkedInto = (project: Project) =>
    workspaces.filter(
      (w) => w.projectId !== project.id && w.repos.some((r) => r.projectId === project.id),
    );

  const projectMenu = async (project: Project) => {
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [{ id: 'remove', label: `Remove from ${profile.name}…` }],
    });
    if (choice === 'remove') onRemoveProject(project);
  };

  // Open in editor (spec §6.13): the primary repository, asking for an editor the first time.
  const editorOpen = useOpenInEditor();
  // Spec §6.1: Open in editor, Reveal in Finder, Copy path, Copy branch name,
  // Keep Claude Running (§9.8), Delete….
  const workspaceMenu = async (workspace: Workspace) => {
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [
        { id: 'editor', label: 'Open in editor' },
        { id: 'reveal', label: REVEAL_LABEL },
        { id: 'copyPath', label: 'Copy path' },
        { id: 'copyBranch', label: 'Copy branch name' },
        { id: 'keepRunning', label: 'Keep Claude Running', checked: workspace.keepRunning },
        { id: 'delete', label: 'Delete workspace…' },
      ],
    });
    if (choice === 'keepRunning') {
      void trpcClient.workspaces.setKeepRunning.mutate({
        workspaceId: workspace.id,
        on: !workspace.keepRunning,
      });
    } else if (choice === 'editor') {
      const project = config.projects.find((p) => p.id === workspace.projectId);
      void editorOpen.run(
        () => trpcClient.editor.openWorktree.mutate({ workspaceId: workspace.id, projectId: null }),
        {
          profileId: workspace.profileId,
          project: project ? { id: project.id, name: project.name } : null,
        },
      );
    } else if (choice === 'reveal') {
      void trpcClient.workspaces.revealWorktree.mutate({
        workspaceId: workspace.id,
        projectId: null,
      });
    } else if (choice === 'copyPath') {
      void trpcClient.clipboard.writeText.mutate({ text: workspace.worktreePath });
    } else if (choice === 'copyBranch') {
      void trpcClient.clipboard.writeText.mutate({ text: workspace.branch });
    } else if (choice === 'delete') onDeleteWorkspace(workspace);
  };

  const mostUrgent = (list: Workspace[]) =>
    list
      .map((w) => ({ w, glyph: glyphFor(w.state, w.unread, launching.has(w.id)) }))
      .filter((u): u is { w: Workspace; glyph: Glyph } => URGENCY.includes(u.glyph as Glyph))
      .sort(
        (a, b) =>
          URGENCY.indexOf(a.glyph) - URGENCY.indexOf(b.glyph) ||
          (a.w.stateSince ?? '').localeCompare(b.w.stateSince ?? ''),
      )[0] ?? null;

  const isSelected = (project: Project) =>
    view.kind === 'project' && view.projectId === project.id && !selectedWorkspaceId;

  // Keyboard (spec §6.1): one Tab stop with a roving tabindex over Home, the projects and
  // the workspace rows shown; ↑↓ move, → expands or enters, ← collapses or goes up.
  const navRef = useRef<HTMLElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const keys = ['home'];
  for (const project of projects) {
    keys.push(`p:${project.id}`);
    if (!isExpanded(project)) continue;
    // In the order they're listed: its own workspaces, then its Linked group and,
    // when that's expanded, the workspaces linked into it.
    for (const w of workspaces) if (w.projectId === project.id) keys.push(`w:${w.id}`);
    const linked = linkedInto(project);
    if (linked.length === 0) continue;
    keys.push(`g:${project.id}`);
    if (linkedGroups.isOpen(project.id)) {
      for (const w of linked) keys.push(`l:${project.id}:${w.id}`);
    }
  }
  const selectedKey = selectedWorkspaceId
    ? `w:${selectedWorkspaceId}`
    : view.kind === 'project'
      ? `p:${view.projectId}`
      : 'home';
  const roving =
    focusKey && keys.includes(focusKey)
      ? focusKey
      : keys.includes(selectedKey)
        ? selectedKey
        : 'home';
  const tabFor = (key: string) => (key === roving ? 0 : -1);
  const focusRow = (key: string) => {
    const row = navRef.current?.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(key)}"]`);
    const target = row?.matches('button')
      ? row
      : row?.querySelector<HTMLElement>('[data-nav-focus]');
    if (!target) return;
    setFocusKey(key);
    target.focus();
  };
  const onNavKey = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-nav-key]');
    const key = row?.dataset.navKey;
    if (!row || !key) return;
    const at = keys.indexOf(key);
    const project = key.startsWith('p:') ? projects.find((p) => `p:${p.id}` === key) : undefined;
    const group = key.startsWith('g:') ? key.slice(2) : undefined;
    let next: string | undefined;
    if (event.key === 'ArrowDown') next = keys[Math.min(at + 1, keys.length - 1)];
    else if (event.key === 'ArrowUp') next = keys[Math.max(at - 1, 0)];
    else if (event.key === 'Home') next = keys[0];
    else if (event.key === 'End') next = keys.at(-1);
    else if (event.key === 'ArrowRight' && project) {
      if (!isExpanded(project)) onToggleProject(project);
      else if (keys[at + 1] && !keys[at + 1]?.startsWith('p:')) next = keys[at + 1];
    } else if (event.key === 'ArrowRight' && group) {
      if (!linkedGroups.isOpen(group)) linkedGroups.toggle(group);
      else if (keys[at + 1]?.startsWith('l:')) next = keys[at + 1];
    } else if (event.key === 'ArrowLeft') {
      if (project && isExpanded(project)) onToggleProject(project);
      else if (group && linkedGroups.isOpen(group)) linkedGroups.toggle(group);
      else if (row.dataset.navParent) next = row.dataset.navParent;
    } else return;
    event.preventDefault();
    if (next) focusRow(next);
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-canvas max-[900px]:w-52">
      <header className="flex h-10 shrink-0 items-center gap-2 px-4">
        <ProfileDot color={profile.color} />
        <span className="font-semibold">{profile.name}</span>
        <span className="truncate text-sm text-fg-muted">
          {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}
        </span>
      </header>

      <nav
        ref={navRef}
        aria-label="Projects and workspaces"
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        onKeyDown={onNavKey}
        onFocus={(event) => {
          const key = (event.target as HTMLElement).closest<HTMLElement>('[data-nav-key]')?.dataset
            .navKey;
          if (key) setFocusKey(key);
        }}
      >
        <button
          type="button"
          data-nav-key="home"
          tabIndex={tabFor('home')}
          aria-current={view.kind === 'home' || undefined}
          className={`${row} ${rowState(view.kind === 'home')} w-[calc(100%-0.75rem)] text-left`}
          onClick={() => onShowView(profile.id, HOME)}
        >
          <span className="w-3 text-center font-mono text-fg-muted">~</span>
          <span className="flex-1">Home</span>
          <Kbd>{keyHint('home')}</Kbd>
        </button>

        <div className="mt-4 mb-1 px-4 text-xs font-medium tracking-wider text-fg-subtle uppercase">
          Projects
        </div>
        {projects.length === 0 ? (
          <p className="mx-3.5 mt-1 rounded-md border border-dashed border-line-strong px-3 py-2.5 text-sm text-fg-muted">
            No projects yet. Add a git repository to start.
          </p>
        ) : null}
        <ul>
          {projects.map((project) => {
            const projectWorkspaces = workspaces.filter((w) => w.projectId === project.id);
            // Other projects' workspaces this one is linked into (spec §21.1); not counted.
            const linkedHere = linkedInto(project);
            const linkedOpen = linkedGroups.isOpen(project.id);
            const projectName = (id: string) =>
              config.projects.find((p) => p.id === id)?.name ?? id;
            const open = isExpanded(project);
            // Collapsed, the project still shows its most urgent workspace, the oldest first;
            // so does a collapsed Linked group.
            const urgent = open ? null : mostUrgent([...projectWorkspaces, ...linkedHere]);
            const linkedUrgent = open && !linkedOpen ? mostUrgent(linkedHere) : null;
            return (
              <li key={project.id} className="mb-1.5">
                <div
                  title={project.repoPath}
                  data-project={project.id}
                  data-nav-key={`p:${project.id}`}
                  className={`group ${row} ${rowState(isSelected(project))}`}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={open ? 'Collapse' : 'Expand'}
                    aria-expanded={open}
                    className="w-3 text-[9px] text-fg-muted"
                    onClick={() => onToggleProject(project)}
                  >
                    {open ? '▼' : '▶'}
                  </button>
                  <button
                    type="button"
                    data-nav-focus
                    tabIndex={tabFor(`p:${project.id}`)}
                    aria-expanded={open}
                    aria-current={isSelected(project) || undefined}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void projectMenu(project);
                    }}
                    className="min-w-0 flex-1 self-stretch truncate text-left font-mono text-sm"
                    onClick={() =>
                      onShowView(project.profileId, { kind: 'project', projectId: project.id })
                    }
                  >
                    {project.name}
                  </button>
                  {urgent ? (
                    <button
                      type="button"
                      data-project-glyph={urgent.w.id}
                      tabIndex={tabFor(`p:${project.id}`)}
                      aria-label={`Open ${urgent.w.name} (${GLYPH_LABEL[urgent.glyph]})`}
                      className={`${iconButton} size-5`}
                      onClick={() => onOpenWorkspace(urgent.w)}
                    >
                      <StatusGlyph
                        glyph={urgent.glyph}
                        title={`${urgent.w.task.title || urgent.w.name} · ${GLYPH_LABEL[urgent.glyph]}`}
                      />
                    </button>
                  ) : null}
                  {linkedHere.length > 0 ? (
                    <span
                      data-linked-count
                      title={
                        linkedHere.length === 1
                          ? 'Linked into 1 workspace of another project'
                          : `Linked into ${linkedHere.length} workspaces of other projects`
                      }
                      className="font-mono text-xs text-fg-subtle"
                    >
                      ↗ {linkedHere.length}
                    </span>
                  ) : null}
                  {projectWorkspaces.length > 0 ? (
                    <span
                      data-workspace-count
                      title={`${projectWorkspaces.length} ${projectWorkspaces.length === 1 ? 'workspace' : 'workspaces'}`}
                      className="min-w-3 text-right font-mono text-sm text-fg-subtle"
                    >
                      {projectWorkspaces.length}
                    </span>
                  ) : null}
                  {/* New workspace in this project, always shown, last in the row so the +s line up (§6.1). */}
                  <button
                    type="button"
                    className={`${iconButton} size-5 text-md`}
                    // Tab reaches it from its project's row only (spec §6.1).
                    tabIndex={tabFor(`p:${project.id}`)}
                    disabled={!onNewWorkspace}
                    title={`New workspace in ${project.name} (${keyHint('newWorkspace')})`}
                    aria-label={`New workspace in ${project.name}`}
                    onClick={() => onNewWorkspace?.(project)}
                  >
                    +
                  </button>
                </div>
                {open
                  ? projectWorkspaces.map((w) => {
                      const glyph = workspaceGlyph(w, launching.has(w.id));
                      const selected = w.id === selectedWorkspaceId;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          data-nav-key={`w:${w.id}`}
                          data-nav-parent={`p:${project.id}`}
                          tabIndex={tabFor(`w:${w.id}`)}
                          title={rowTooltip(w, glyph, suspended.has(w.id))}
                          data-unfinished={w.unfinished?.kind}
                          data-suspended={suspended.has(w.id) || undefined}
                          aria-current={selected || undefined}
                          onClick={() => onOpenWorkspace(w)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void workspaceMenu(w);
                          }}
                          className={`${row} ${rowState(selected)} w-[calc(100%-0.75rem)] pl-[26px] text-left`}
                        >
                          {glyph ? <StatusGlyph glyph={glyph} /> : <span className="size-3" />}
                          <span
                            className={`min-w-0 flex-1 truncate ${glyph === 'done' ? 'font-semibold' : ''}`}
                          >
                            {w.task.title || w.name}
                          </span>
                          {linkedRepos(w).length > 0 ? (
                            <span
                              data-linked-chip
                              title={`Also in ${linkedRepos(w)
                                .map((r) => projectName(r.projectId))
                                .join(', ')}`}
                              className="rounded-xs border border-line-strong px-1 font-mono text-2xs text-fg-muted"
                            >
                              +{linkedRepos(w).length}
                            </span>
                          ) : null}
                          {glyph === 'working' && w.state === 'working' && w.background > 0 ? (
                            // Waiting for background agents (spec §10.2).
                            <span
                              data-background={w.background}
                              className="max-w-24 truncate text-xs text-fg-subtle"
                            >
                              {w.background} in background
                            </span>
                          ) : suspended.has(w.id) && glyph !== 'unfinished' ? (
                            // Suspended to save memory (spec §9.8); the state's glyph stays.
                            <span className="max-w-24 truncate text-xs text-fg-subtle">
                              Suspended
                            </span>
                          ) : glyph === 'working' && w.state === 'working' ? (
                            <span className="font-mono text-xs text-fg-subtle">
                              {elapsed(w.stateSince, now)}
                            </span>
                          ) : w.state === 'done' && w.background > 0 ? (
                            // Done, with commands Claude left running (spec §10.2).
                            <span
                              data-background={w.background}
                              className="max-w-24 truncate text-xs text-fg-subtle"
                            >
                              {glyph === 'done' ? 'Done · ' : ''}
                              {w.background} running
                            </span>
                          ) : glyph && glyph !== 'working' ? (
                            <span
                              className={`max-w-24 truncate text-xs font-medium ${glyph === 'unfinished' ? 'text-st-input' : (LABEL_COLOR[w.state] ?? 'text-fg')}`}
                            >
                              {/* At a gate, the gate's own label (spec §13.5). */}
                              {glyph === 'approval' && w.workflow?.label
                                ? w.workflow.label
                                : GLYPH_ROW_LABEL[glyph]}
                            </span>
                          ) : w.workflow?.label ? (
                            <span
                              data-workflow-label
                              className="max-w-24 truncate text-xs text-fg-muted"
                            >
                              {w.workflow.label}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  : null}
                {open && linkedHere.length > 0 ? (
                  <div
                    data-linked-group={project.id}
                    data-nav-key={`g:${project.id}`}
                    data-nav-parent={`p:${project.id}`}
                    className={`${row} text-fg-subtle hover:bg-raised`}
                  >
                    <button
                      type="button"
                      data-nav-focus
                      tabIndex={tabFor(`g:${project.id}`)}
                      aria-expanded={linkedOpen}
                      title={
                        linkedHere.length === 1
                          ? '1 workspace of another project is linked here'
                          : `${linkedHere.length} workspaces of other projects are linked here`
                      }
                      onClick={() => linkedGroups.toggle(project.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-[18px] text-left text-sm"
                    >
                      <span className="w-3 text-[9px] text-fg-muted">{linkedOpen ? '▼' : '▶'}</span>
                      <span className="min-w-0 flex-1 truncate">↗ Linked</span>
                      <span className="font-mono text-xs">{linkedHere.length}</span>
                    </button>
                    {linkedUrgent ? (
                      <button
                        type="button"
                        data-linked-glyph={linkedUrgent.w.id}
                        tabIndex={tabFor(`g:${project.id}`)}
                        aria-label={`Open ${linkedUrgent.w.name} (${GLYPH_LABEL[linkedUrgent.glyph]})`}
                        className={`${iconButton} size-5`}
                        onClick={() => onOpenWorkspace(linkedUrgent.w)}
                      >
                        <StatusGlyph
                          glyph={linkedUrgent.glyph}
                          title={`${linkedUrgent.w.task.title || linkedUrgent.w.name} · ${GLYPH_LABEL[linkedUrgent.glyph]}`}
                        />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {open && linkedOpen
                  ? linkedHere.map((w) => (
                      <button
                        key={`linked-${w.id}`}
                        type="button"
                        data-linked-row={w.id}
                        data-nav-key={`l:${project.id}:${w.id}`}
                        data-nav-parent={`g:${project.id}`}
                        tabIndex={tabFor(`l:${project.id}:${w.id}`)}
                        title={`${w.name} · in ${projectName(w.projectId)}`}
                        aria-current={w.id === selectedWorkspaceId || undefined}
                        onClick={() => onOpenWorkspace(w)}
                        className={`${row} ${
                          w.id === selectedWorkspaceId ? 'bg-band-strong' : 'hover:bg-raised'
                        } w-[calc(100%-0.75rem)] pl-[46px] text-left text-fg-subtle`}
                      >
                        <span className="w-3 text-center">↗</span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-mono text-sm">{w.task.id ?? w.task.title}</span> ·
                          in {projectName(w.projectId)}
                        </span>
                      </button>
                    ))
                  : null}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-line py-1.5">
        <button
          type="button"
          aria-label={`Add project to ${profile.name}`}
          className={`${row} ${rowState(false)} w-[calc(100%-0.75rem)] text-left`}
          onClick={onAddProject}
        >
          <span className="w-3 text-center text-fg-muted">+</span>
          <span className="flex-1">Add project</span>
          <Kbd>{keyHint('addProject')}</Kbd>
        </button>
      </div>
      {editorOpen.dialog}
    </aside>
  );
}
