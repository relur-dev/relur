import {
  HOME_SECTION_LIMIT,
  HOME_SECTION_TITLE,
  HOME_SECTIONS,
  type HomeSection,
  homeSections,
  projectCounts,
} from '@shared/home';
import type { MemorySnapshot } from '@shared/memory';
import type { Profile, Project } from '@shared/schemas';
import { SUSPENDED_TOOLTIP } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { Workspace } from '@shared/workspaces';
import { useEffect, useRef, useState } from 'react';
import { Kbd, keyHint } from '../ui/controls';
import { StatusGlyph } from '../ui/StatusGlyph';
import { useSuspended } from '../ui/suspended';
import {
  actionClass,
  type HomeActions,
  NotesMark,
  ring,
  Sep,
  TONE,
  useHomeItems,
  useNow,
  useShipStates,
} from './home-items';

export type { HomeActions } from './home-items';

/**
 * Home's Overview (spec §6.7): the profile's workspaces that need you, are
 * working, are ready to ship or can be cleaned up, then its projects and the
 * quick actions. Everything updates as states change, without animations.
 */
export function HomeOverview({
  profile,
  projects,
  workspaces,
  sessions,
  memory,
  actions,
}: {
  profile: Profile;
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  memory: MemorySnapshot | null;
  actions: HomeActions;
}) {
  const suspended = useSuspended();
  const ship = useShipStates(workspaces);
  const now = useNow();
  const item = useHomeItems({ profile, projects, sessions, memory, actions, ship, now });

  const sections = homeSections(workspaces, ship);
  const total = HOME_SECTIONS.reduce((n, s) => n + sections[s].length, 0);
  const [showAll, setShowAll] = useState<Partial<Record<HomeSection, boolean>>>({});

  // Keyboard (spec §6.7): ↑↓ move across the rows of all sections, ↵ opens.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-home-row]') ?? [])];
    if (rows.length === 0) return;
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-home-row]');
    const at = current ? rows.indexOf(current) : -1;
    const next =
      at === -1
        ? e.key === 'ArrowDown'
          ? rows[0]
          : rows[rows.length - 1]
        : rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '';

  const quick: QuickAction[] = [
    {
      icon: '+',
      label: 'New workspace',
      keys: keyHint('newWorkspace'),
      onClick: actions.newWorkspace,
    },
    { icon: '▢', label: 'Add project', keys: keyHint('addProject'), onClick: actions.addProject },
    { icon: '?', label: 'Guide', keys: keyHint('guide'), onClick: actions.guide },
  ];

  const row = (section: HomeSection, w: Workspace) => {
    const { glyph, parts, dotted, buttons, hover, meta, title, error } = item(section, w);
    return (
      // biome-ignore lint/a11y/useSemanticElements: a row holds its own buttons, so it can't be one
      <div
        key={w.id}
        role="button"
        tabIndex={0}
        data-home-row={w.id}
        data-home-section={section}
        title={`${w.task.id ? `${w.task.id} ` : ''}${w.task.title || w.name}`}
        className="group flex cursor-default items-center gap-3 rounded-md px-2.5 py-2 outline-none hover:bg-band focus-visible:bg-band focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)] focus-visible:outline-none"
        onClick={() => actions.open(w)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            e.preventDefault();
            actions.open(w);
          }
        }}
      >
        <span className="mt-[3px] flex self-start">
          {glyph ? <StatusGlyph glyph={glyph} /> : <span className="size-3" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {w.task.id ? (
              <span className="flex-none font-mono text-sm text-fg-subtle">{w.task.id}</span>
            ) : null}
            <span
              className={`min-w-0 truncate text-base ${
                title === 'bold' ? 'font-semibold' : 'font-medium'
              } ${title === 'muted' ? 'text-fg-muted' : 'text-fg'}`}
            >
              {w.task.title || w.name}
            </span>
            <NotesMark w={w} />
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden text-sm whitespace-nowrap text-fg-muted">
            <span className="flex-none font-mono text-[11.5px] text-fg-subtle">
              {projectName(w.projectId)}
            </span>
            {parts.map((p, i) => (
              // The project, then the parts; Needs you's run on after one separator.
              <span key={p.text} className="contents">
                {i === 0 || dotted ? <Sep /> : null}
                <span className={p.tone ? TONE[p.tone] : 'min-w-0 truncate'} title={p.title}>
                  {p.text}
                </span>
              </span>
            ))}
          </div>
          {error ? (
            <span role="alert" className="truncate text-sm text-st-error">
              ✕ {error}
            </span>
          ) : null}
        </div>
        {/* Suspended to save memory (spec §9.8), quiet as in the sidebar. */}
        {suspended.has(w.id) ? (
          <span
            data-suspended
            title={SUSPENDED_TOOLTIP}
            className="flex-none text-xs text-fg-subtle"
          >
            Suspended
          </span>
        ) : null}
        {meta ? (
          <span
            data-home-memory
            className="flex-none font-mono text-[11.5px] text-fg-subtle"
            title={meta.title}
          >
            {meta.text}
          </span>
        ) : null}
        {/* Hover actions show on hover and focus (components.md); hidden, they take no room. */}
        {buttons.length > 0 ? (
          <div className="flex flex-none items-center gap-1.5">{buttons}</div>
        ) : null}
        {hover.length > 0 ? (
          <div className="hidden flex-none items-center gap-1.5 group-focus-within:flex group-hover:flex">
            {hover}
          </div>
        ) : null}
      </div>
    );
  };

  if (projects.length === 0 || total === 0) {
    return (
      <div
        ref={root}
        tabIndex={-1}
        data-home-overview="empty"
        className="min-h-0 flex-1 overflow-auto bg-term outline-none"
      >
        <div className="box-border flex min-h-full flex-col items-center justify-center px-6 pt-10 pb-20">
          <div className="flex w-full max-w-[400px] flex-col gap-[22px]">
            {projects.length === 0 ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[17px] font-semibold">No projects yet</span>
                  <span className="text-base leading-normal text-pretty text-fg-muted">
                    A project is a git repository on disk. Add one, then start a workspace for each
                    task: its own worktree, branch and terminals.
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    data-home-action="add-first-project"
                    className={`${actionClass('primary')} h-7.5 self-start px-3`}
                    onClick={actions.addProject}
                  >
                    Add your first project <Kbd onFg>{keyHint('addProject')}</Kbd>
                  </button>
                  <QuickList actions={quick.filter((q) => q.label === 'Guide')} />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[17px] font-semibold">All clear</span>
                  <span className="text-base leading-normal text-pretty text-fg-muted">
                    Nothing needs you, nothing is running and nothing is waiting to ship. Start a
                    workspace when you have the next task.
                  </span>
                </div>
                <QuickList actions={quick} />
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const counts = projectCounts(
    projects.map((p) => p.id),
    workspaces,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ↑↓ between the rows inside it
    <div
      ref={root}
      tabIndex={-1}
      data-home-overview="sections"
      className="min-h-0 flex-1 overflow-auto bg-term outline-none"
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-start gap-x-14 gap-y-10 pt-[26px] pr-8 pb-10 pl-9">
        <div className="flex max-w-[860px] min-w-0 flex-[1_1_600px] flex-col gap-[30px]">
          {HOME_SECTIONS.map((section) => {
            const list = sections[section];
            if (list.length === 0) return null;
            const shown = showAll[section] ? list : list.slice(0, HOME_SECTION_LIMIT);
            return (
              <section
                key={section}
                data-home-list={section}
                aria-label={HOME_SECTION_TITLE[section]}
                className="flex flex-col gap-1.5"
              >
                <div className="flex h-7 items-center gap-2">
                  <h2 className="text-base font-semibold">{HOME_SECTION_TITLE[section]}</h2>
                  <span className="font-mono text-sm text-fg-subtle">{list.length}</span>
                  <span className="ml-2 h-px flex-1 bg-line" />
                  {section === 'clean' ? (
                    <button
                      type="button"
                      data-home-action="delete-merged"
                      className={actionClass('secondary')}
                      title="Deletes their worktrees and local branches"
                      onClick={() => actions.deleteMerged(list)}
                    >
                      Delete {list.length} merged {list.length === 1 ? 'workspace' : 'workspaces'}
                    </button>
                  ) : null}
                </div>
                <div className="-mx-2.5 flex flex-col gap-0.5">
                  {shown.map((w) => row(section, w))}
                </div>
                {list.length > HOME_SECTION_LIMIT ? (
                  <button
                    type="button"
                    data-home-action="show-all"
                    className={`${ring} self-start rounded-[5px] px-0 text-sm text-fg-muted hover:text-fg`}
                    onClick={() => setShowAll((all) => ({ ...all, [section]: !all[section] }))}
                  >
                    {showAll[section] ? 'Show fewer' : `Show all ${list.length}`}
                  </button>
                ) : null}
                {section === 'needs' ? (
                  <div className="flex items-center gap-[7px] pt-0.5 text-sm text-fg-subtle">
                    <kbd className="rounded border border-line-strong px-[5px] py-[3px] font-mono text-2xs leading-none text-fg-muted">
                      {keyHint('nextNeedingYou')}
                    </kbd>
                    jumps to the next one
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        <div className="grid flex-[1_0_232px] grid-cols-[repeat(auto-fit,minmax(232px,1fr))] gap-x-10 gap-y-[26px]">
          <div data-home-glance className="flex flex-col gap-1">
            <GroupLabel>At a glance</GroupLabel>
            {projects.map((p) => {
              const c = counts.find((x) => x.projectId === p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  data-home-project={p.id}
                  title={`Open ${p.name}`}
                  className={`${ring} -mx-2 flex h-7 items-center gap-2 rounded-[5px] px-2 text-sm text-fg-subtle hover:bg-band`}
                  onClick={() => actions.openProject(p)}
                >
                  <span className="min-w-0 flex-1 truncate text-left font-mono text-md text-fg">
                    {p.name}
                  </span>
                  <span className="font-mono text-sm text-fg-muted">{c?.count ?? 0}</span>
                  {c?.linked ? <span>+ {c.linked} linked</span> : null}
                </button>
              );
            })}
          </div>
          <div className="flex flex-col gap-1">
            <GroupLabel>Quick actions</GroupLabel>
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                data-home-quick={q.label}
                disabled={!q.onClick}
                className={`${ring} -mx-2 flex h-[30px] items-center gap-[9px] rounded-[5px] px-2 text-left text-md text-fg hover:bg-band-strong disabled:opacity-40 disabled:hover:bg-transparent`}
                onClick={q.onClick ?? undefined}
              >
                <span className="w-3 text-center text-fg-subtle">{q.icon}</span>
                <span className="flex-1">{q.label}</span>
                <Kbd>{q.keys}</Kbd>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface QuickAction {
  icon: string;
  label: string;
  keys: string;
  onClick: (() => void) | null;
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="flex h-7 items-center text-2xs font-medium tracking-[0.07em] text-fg-subtle uppercase">
      {children}
    </div>
  );
}

/** The empty state's quick actions: full-width rows between lines. */
function QuickList({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="flex flex-col border-t border-line">
      {actions.map((q) => (
        <button
          key={q.label}
          type="button"
          data-home-quick={q.label}
          disabled={!q.onClick}
          className="flex h-[38px] items-center gap-2.5 border-b border-line px-1 text-left text-base text-fg outline-none hover:bg-band focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)] focus-visible:outline-none disabled:opacity-40"
          onClick={q.onClick ?? undefined}
        >
          <span className="w-3.5 text-center text-fg-subtle">{q.icon}</span>
          <span className="flex-1">{q.label}</span>
          <span className="font-mono text-xs text-fg-subtle">{q.keys}</span>
        </button>
      ))}
    </div>
  );
}
