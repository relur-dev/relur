import {
  type BoardGroup as Group,
  parseBoardGroup,
  parseCollapsedLanes,
  serializeCollapsedLanes,
  toggleLane,
} from '@shared/board-group';
import { flaggedOnly } from '@shared/home';
import type { MemorySnapshot } from '@shared/memory';
import type { Profile, Project } from '@shared/schemas';
import { formatChord, SHORTCUTS } from '@shared/shortcuts';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { Workspace } from '@shared/workspaces';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { button, isMac, Kbd, keyHint } from '../ui/controls';
import { remember } from '../ui/remember';
import { Board, BoardEmpty } from './Board';
import { BoardColumns } from './BoardColumns';
import { BoardFlagged } from './BoardFlagged';
import { BoardGroup } from './BoardGroup';
import { stored, useBoardLayout, useFlaggedFilter } from './board-state';
import type { HomeActions } from './home-items';
import { TerminalView } from './TerminalView';

/** Home's tabs (spec §6.7): the Overview, and the profile's home shell. */
export type HomeTab = 'overview' | 'terminal';

const TABS: { id: HomeTab; name: string; icon: string; tip: string }[] = [
  { id: 'overview', name: 'Overview', icon: '≡', tip: 'What needs you, runs and is ready to ship' },
  { id: 'terminal', name: 'Terminal', icon: '›_', tip: 'The profile’s shell' },
];

/** The Board's grouping and its collapsed bands (spec §6.7), remembered per profile. */
const groupKey = (profileId: string) => `home-board-group:${profileId}`;
const lanesKey = (profileId: string) => `home-board-lanes:${profileId}`;

/** ⌃1 and ⌃2 on macOS, as a workspace's tabs; elsewhere Ctrl with a digit switches profiles. */
const tabKey = (index: number): string | null =>
  isMac
    ? formatChord({ ...SHORTCUTS.terminalTab.chords[0], code: `Digit${index + 1}` }, true)
    : null;

/**
 * A profile's Home (spec §6.7): two tabs in a workspace's tab strip, the
 * Overview of the profile's workspaces and the profile's home terminal.
 */
export function HomeView({
  profile,
  tab,
  onSelectTab,
  session,
  sessions,
  projects,
  workspaces,
  memory,
  actions,
  startClaude,
}: {
  profile: Profile;
  tab: HomeTab;
  onSelectTab: (tab: HomeTab) => void;
  /** The home shell. */
  session: SessionInfo | null;
  /** The profile's sessions, for the gates' answer buttons. */
  sessions: SessionInfo[];
  projects: Project[];
  /** The profile's workspaces. */
  workspaces: Workspace[];
  memory: MemorySnapshot | null;
  actions: HomeActions;
  /** Why Start Claude here didn't type into the shell, shown in the Terminal tab. */
  startClaude: { error: string | null };
}) {
  const trpc = useTRPC();
  const homeShell = useMutation(trpc.sessions.homeShell.mutationOptions());
  const restart = useMutation(trpc.sessions.restartHomeShell.mutationOptions());
  const { mutate: ensureHomeShell } = homeShell;

  // Every profile has a home shell; the main process starts it once.
  useEffect(() => ensureHomeShell({ profileId: profile.id }), [profile.id, ensureHomeShell]);

  // The Terminal tab puts its shell in focus, as a workspace's tabs do.
  const terminal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab !== 'terminal') return;
    const timer = setTimeout(
      () => terminal.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus(),
      50,
    );
    return () => clearTimeout(timer);
  }, [tab]);

  const [boardLayout, changeBoardLayout] = useBoardLayout(profile.id);
  const [flagged, setFlagged] = useFlaggedFilter(profile.id);
  // The Flagged filter (spec §6.7): only flagged workspaces on the Board.
  const onBoard = flaggedOnly(workspaces, flagged && workspaces.some((w) => w.flag));
  const [group, setGroup] = useState<Group>(() => parseBoardGroup(stored(groupKey(profile.id))));
  const chooseGroup = (next: Group) => {
    setGroup(next);
    // None, the default, is stored as nothing.
    remember(groupKey(profile.id), next === 'none' ? null : next);
  };
  const [collapsed, setCollapsed] = useState<string[]>(() =>
    parseCollapsedLanes(stored(lanesKey(profile.id))),
  );
  const changeCollapsed = (next: string[]) => {
    setCollapsed(next);
    remember(lanesKey(profile.id), serializeCollapsedLanes(next));
  };
  // The projects with a band: those with workspaces of their own.
  const banded = projects.filter((p) => onBoard.some((w) => w.projectId === p.id)).map((p) => p.id);
  // Without workspaces the Overview shows an empty state, with nothing to arrange.
  const board = tab === 'overview' && projects.length > 0 && workspaces.length > 0;

  const configDir = profile.env.CLAUDE_CONFIG_DIR;
  const error = (homeShell.error ?? restart.error)?.message ?? startClaude.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-term">
      <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-line bg-surface px-2">
        <div role="tablist" aria-label="Home" className="flex min-w-0 items-end gap-0.5">
          {TABS.map((t, index) => {
            const active = t.id === tab;
            const key = tabKey(index);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                data-home-tab={t.id}
                aria-selected={active}
                title={
                  t.id === 'terminal'
                    ? `Shell in ~${configDir ? ` · CLAUDE_CONFIG_DIR=${configDir}` : ''}`
                    : t.tip
                }
                className={`-mb-px flex h-7.5 items-center gap-2 rounded-t-md pr-3.5 pl-3 text-md ${
                  active
                    ? 'border border-b-0 border-line bg-term text-fg'
                    : 'border border-transparent border-b-0 text-fg-muted hover:text-fg'
                }`}
                onClick={() => onSelectTab(t.id)}
              >
                <span
                  className={`w-3.5 text-center font-mono ${t.id === 'terminal' ? 'text-2xs' : 'text-base'} ${active ? 'text-fg-muted' : 'text-fg-subtle'}`}
                >
                  {t.icon}
                </span>
                {t.name}
                {key ? <Kbd>{key}</Kbd> : null}
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        {board ? <BoardFlagged on={flagged} onChange={setFlagged} workspaces={workspaces} /> : null}
        {board ? (
          <BoardColumns layout={boardLayout} onLayout={changeBoardLayout} workspaces={workspaces} />
        ) : null}
        {board ? (
          <BoardGroup
            group={group}
            onGroup={chooseGroup}
            canExpand={banded.some((id) => collapsed.includes(id))}
            canCollapse={banded.some((id) => !collapsed.includes(id))}
            onExpandAll={() => changeCollapsed(collapsed.filter((id) => !banded.includes(id)))}
            onCollapseAll={() =>
              changeCollapsed([...collapsed, ...banded.filter((id) => !collapsed.includes(id))])
            }
          />
        ) : null}
      </div>

      {tab === 'overview' ? (
        // Home's quick actions (spec §6.7), always above the Board.
        <div data-home-quick-actions className="flex shrink-0 items-center gap-2 px-6 pt-3.5">
          <button
            type="button"
            data-home-quick="New workspace"
            className={button('primary')}
            disabled={!actions.newWorkspace}
            title={actions.newWorkspace ? undefined : 'Add a project first'}
            onClick={actions.newWorkspace ?? undefined}
          >
            New workspace <Kbd onFg>{keyHint('newWorkspace')}</Kbd>
          </button>
          <button
            type="button"
            data-home-quick="Add project"
            className={button('secondary')}
            onClick={actions.addProject}
          >
            Add project <Kbd>{keyHint('addProject')}</Kbd>
          </button>
        </div>
      ) : null}

      {tab !== 'overview' ? null : board ? (
        <Board
          profile={profile}
          projects={projects}
          workspaces={onBoard}
          sessions={sessions}
          memory={memory}
          actions={actions}
          layout={boardLayout}
          onLayout={changeBoardLayout}
          group={group}
          collapsed={collapsed}
          onToggleLane={(projectId) => changeCollapsed(toggleLane(collapsed, projectId))}
        />
      ) : (
        <BoardEmpty
          kind={projects.length === 0 ? 'no-projects' : 'no-workspaces'}
          onAddProject={actions.addProject}
          onNewWorkspace={actions.newWorkspace}
        />
      )}

      {/* Hidden, not removed, on the Overview: the terminal keeps its state. */}
      <div
        ref={terminal}
        className={`min-h-0 flex-1 flex-col ${tab === 'terminal' ? 'flex' : 'hidden'}`}
      >
        {session?.status === 'exited' ? (
          <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 text-md">
            <span className="text-fg-muted">The home shell has exited.</span>
            <button
              type="button"
              className={button('secondary', 'sm')}
              disabled={restart.isPending}
              onClick={() => restart.mutate({ profileId: profile.id })}
            >
              Start again
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 py-2 text-md text-st-error select-text">
            ✕ {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          {session ? (
            <TerminalView
              key={session.id}
              sessionId={session.id}
              files={session.kind === 'claude' ? 'claude' : 'shell'}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
