import { BRAND } from '@shared/brand';
import type { Profile, Project } from '@shared/schemas';
import { accountFolder, setupPassed, setupWarning } from '@shared/setup';
import { matchShortcut, type ShortcutId } from '@shared/shortcuts';
import { needsYou, soundKey } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import type { OtherWorktree, Workspace } from '@shared/workspaces';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AddProjectDialog } from './components/AddProjectDialog';
import { AdoptWorktreeDialog } from './components/AdoptWorktreeDialog';
import { CloseNotice } from './components/CloseNotice';
import { ConfigError } from './components/ConfigError';
import { DeleteWorkspaceDialog, DeleteWorkspacesDialog } from './components/DeleteWorkspaceDialog';
import { APP_NOTICE_EVENT } from './components/EditorPicker';
import { EditProfileDialog } from './components/EditProfileDialog';
import { FirstLaunch } from './components/FirstLaunch';
import { type HomeTab, HomeView } from './components/HomeView';
import { InstallCliDialog } from './components/InstallCliDialog';
import { Modal, ModalFooter } from './components/Modal';
import { NewProfileWizard } from './components/NewProfileWizard';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog';
import { ProfileTabs } from './components/ProfileTabs';
import { ProjectView } from './components/ProjectView';
import { QuitDialog } from './components/QuitDialog';
import { RemoveProfileDialog } from './components/RemoveProfileDialog';
import { RemoveProjectDialog } from './components/RemoveProjectDialog';
import { SandboxWarning } from './components/SandboxWarning';
import { SetupCheckPanel } from './components/SetupCheck';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { SuspendDefaultNotice } from './components/SuspendDefaultNotice';
import { ContinueNotice, UnfinishedDialog } from './components/UnfinishedDialog';
import { UpdateNotice } from './components/UpdateNotice';
import { FOCUS_CLAUDE_EVENT, type LinkNotice, WorkspaceView } from './components/WorkspaceView';
import { type GuideTarget, GuideView, target } from './guide/GuideView';
import { GuideContext } from './guide/link';
import { LAST_SHOWN_KEY, type LastShown, parseLastShown, resolveLastShown } from './last-shown';
import { trpcClient, useTRPC } from './trpc';
import { button, iconButton, isMac, Kbd } from './ui/controls';
import { requestOnOpen } from './ui/open-requests';
import { useProjectDisclosure } from './ui/project-disclosure';
import { remember } from './ui/remember';
import { playAlert } from './ui/sounds';
import { SessionMarks, type SuspendedSession } from './ui/suspended';
import { useNativeTheme } from './ui/theme';
import {
  type AfterSetup,
  HOME,
  PROJECT_TABS,
  sessionsOf,
  type View,
  viewKey,
  viewOf,
  WORKSPACES_TAB,
} from './view';

export function App() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  useNativeTheme();
  const info = useQuery(trpc.app.info.queryOptions());
  const config = useQuery(trpc.config.get.queryOptions());
  const sessions = useQuery(trpc.sessions.list.queryOptions());
  const usage = useQuery(trpc.usage.all.queryOptions());
  useSubscription(
    trpc.usage.changes.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries({ queryKey: trpc.usage.all.queryKey() }),
    }),
  );
  // Memory of Claude sessions and the app (spec §6.14), measured by the main process.
  const memory = useQuery(trpc.memory.current.queryOptions());
  useSubscription(
    trpc.memory.changes.subscriptionOptions(undefined, {
      onData: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.memory.current.queryKey() }),
    }),
  );
  const workspaces = useQuery(trpc.workspaces.list.queryOptions());
  // Continuing interrupted work (spec §9.7): the notice and the start's overview.
  const unfinished = useQuery(trpc.unfinished.state.queryOptions());
  useSubscription(
    trpc.unfinished.changes.subscriptionOptions(undefined, {
      onData: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.unfinished.state.queryKey() }),
    }),
  );
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  // Whether the window is back where it was when the app quit (spec §5).
  const [restored, setRestored] = useState(false);
  // What each profile shows, and the selected tab of each view (by profile and view key).
  const [views, setViews] = useState<Record<string, View>>({});
  const [selectedTab, setSelectedTab] = useState<Record<string, string>>({});
  const disclosure = useProjectDisclosure();
  // Home's tab per profile (spec §6.7): the Overview until the Terminal is chosen.
  const [homeTabs, setHomeTabs] = useState<Record<string, HomeTab>>({});
  const [addingProject, setAddingProject] = useState(false);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [homeNotice, setHomeNotice] = useState<string | null>(null);
  // The Guide (components.md, Guide): replaces the sidebar and main area while open.
  const [guide, setGuide] = useState<{
    open: boolean;
    at: GuideTarget;
    linked: number;
    from: string | null;
  }>({ open: false, at: { page: 'what-it-is' }, linked: 0, from: null });
  const guideOpen = guide.open;
  const selectProfile = (id: string) => {
    setGuide((g) => (g.open ? { ...g, open: false } : g));
    setSelectedProfile(id);
  };
  const closeGuide = () => setGuide((g) => ({ ...g, open: false }));
  // Reorders the profile tabs (and ⌘1…⌘9): config.json's list, spec §6.
  const moveProfile = (profileId: string, index: number) =>
    void trpcClient.profiles.move.mutate({ profileId, index });
  // Workspaces whose Changes panel is open (spec §6.4); off by default.
  const [changesOpen, setChangesOpen] = useState<Set<string>>(new Set());
  const toggleChanges = (workspaceId: string, open?: boolean) =>
    setChangesOpen((current) => {
      const next = new Set(current);
      if (open ?? !next.has(workspaceId)) next.add(workspaceId);
      else next.delete(workspaceId);
      return next;
    });
  // Workspaces whose Notes panel is open (spec §6.15); off by default.
  const [notesOpen, setNotesOpen] = useState<Set<string>>(new Set());
  const showNotes = useCallback(
    (workspaceId: string, open: boolean) =>
      setNotesOpen((current) => {
        if (current.has(workspaceId) === open) return current;
        const next = new Set(current);
        if (open) next.add(workspaceId);
        else next.delete(workspaceId);
        return next;
      }),
    [],
  );
  // Something that happened and needs reading, such as a teardown that failed;
  // `info` for news that isn't a problem, which goes away by itself.
  // An `action` (such as Open as workspace) keeps it until used or dismissed.
  const [appNotice, setAppNotice] = useState<{
    text: string;
    info?: boolean;
    action?: { label: string; run: () => void };
  } | null>(null);
  // Messages from deeper down, such as an editor that didn't open (spec §6.13).
  useEffect(() => {
    const listener = (event: Event) =>
      setAppNotice((event as CustomEvent<{ text: string; info: boolean }>).detail);
    window.addEventListener(APP_NOTICE_EVENT, listener);
    return () => window.removeEventListener(APP_NOTICE_EVENT, listener);
  }, []);
  useEffect(() => {
    if (!appNotice?.info || appNotice.action) return;
    const timer = setTimeout(() => setAppNotice((n) => (n === appNotice ? null : n)), 10_000);
    return () => clearTimeout(timer);
  }, [appNotice]);
  // Says why a workspace key did nothing (one workspace, nothing waiting).
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const keyNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showKeyNotice = (text: string) => {
    setKeyNotice(text);
    clearTimeout(keyNoticeTimer.current);
    keyNoticeTimer.current = setTimeout(() => setKeyNotice(null), 2500);
  };
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [removingProfile, setRemovingProfile] = useState<string | null>(null);
  const [installingCli, setInstallingCli] = useState(false);
  const closeTabRef = useRef<() => void>(() => {});
  const [closingClaude, setClosingClaude] = useState<SessionInfo | null>(null);
  const closeSession = useMutation(trpc.sessions.close.mutationOptions());
  // Quitting would interrupt these sessions (spec §5); null while not asking.
  const [quitting, setQuitting] = useState<string[] | null>(null);
  useSubscription(trpc.app.quitRequests.subscriptionOptions(undefined, { onData: setQuitting }));
  // The window is closing for the first time ever and the app keeps running (spec §5).
  const [closeNotice, setCloseNotice] = useState(false);
  useSubscription(
    trpc.app.closeNoticeRequests.subscriptionOptions(undefined, {
      onData: () => setCloseNotice(true),
    }),
  );
  useSubscription(
    trpc.ui.menuRequests.subscriptionOptions(undefined, {
      onData: (what) => {
        if (what === 'install-cli') setInstallingCli(true);
        if (what === 'close-tab') closeTabRef.current();
        if (what === 'guide') openGuideRef.current(null);
      },
    }),
  );

  // Config changes (reload, app edits) can affect anything on screen.
  useSubscription(
    trpc.config.changes.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries(),
    }),
  );
  useSubscription(
    trpc.sessions.changes.subscriptionOptions(undefined, {
      onData: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.sessions.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.sessions.suspendClocks.queryKey() });
      },
    }),
  );
  // Alert sounds per profile and event, silenced by Do Not Disturb (spec §10.3).
  const profilesRef = useRef<typeof profiles>([]);
  useSubscription(
    trpc.status.alerts.subscriptionOptions(undefined, {
      onData: (alert) => {
        const alerted = profilesRef.current.find((p) => p.id === alert.profileId);
        const key = soundKey(alert.state);
        if (alerted && key && alerted.alerts.sounds[key] && !alerted.alerts.doNotDisturb) {
          playAlert(alert.state);
        }
      },
    }),
  );
  // Opens a workspace's Claude tab (⌘J, Home, a clicked notification).
  const openRequest = useRef<(workspaceId: string) => void>(() => {});
  // A clicked notification (spec §10.3), until the workspaces and sessions
  // are loaded: a window just opened for the click has none yet.
  const [notificationClick, setNotificationClick] = useState<string | null>(null);
  useSubscription(
    trpc.status.openRequests.subscriptionOptions(undefined, {
      onData: setNotificationClick,
    }),
  );
  // A click that came while no window was open waits in the main process.
  useEffect(() => {
    void trpcClient.status.takeOpenRequest.mutate().then((workspaceId) => {
      if (workspaceId) setNotificationClick(workspaceId);
    });
  }, []);
  // The workspace whose Claude terminal takes the focus once it is shown.
  const [focusClaudeOf, setFocusClaudeOf] = useState<string | null>(null);
  useSubscription(
    trpc.setup.changes.subscriptionOptions(undefined, {
      onData: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.setup.all.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.setup.get.pathKey() });
      },
    }),
  );
  useSubscription(
    trpc.workspaces.changes.subscriptionOptions(undefined, {
      onData: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.workspaces.list.queryKey() }),
    }),
  );
  // A remote added to a project that had none (spec §6.10).
  useSubscription(
    trpc.projects.remoteFound.subscriptionOptions(undefined, {
      onData: (found) =>
        setAppNotice({
          text: `${found.projectName} now uses the remote ${found.remote}: Push and Create PR are available`,
          info: true,
        }),
    }),
  );
  // Open as workspace for a worktree made outside the app (spec §13.6).
  const [adopting, setAdopting] = useState<{ projectId: string; worktree: OtherWorktree } | null>(
    null,
  );
  useSubscription(
    trpc.workspaces.newWorktrees.subscriptionOptions(undefined, {
      onData: (found) =>
        setAppNotice({
          text: `New worktree ${found.branch ?? found.path} in ${found.projectName}`,
          info: true,
          action: found.branch
            ? {
                label: 'Open as workspace',
                run: () =>
                  setAdopting({
                    projectId: found.projectId,
                    worktree: {
                      path: found.path,
                      branch: found.branch,
                      taskId: null,
                      title: '',
                      titleFromField: false,
                    },
                  }),
              }
            : undefined,
        }),
    }),
  );
  // A repository linked with `<slug> link` (spec §21.9): a line in that
  // workspace's header while it's shown, the window's notice otherwise.
  const [linkNotices, setLinkNotices] = useState<Record<string, LinkNotice>>({});
  const shownWorkspace = useRef<string | null>(null);
  useSubscription(
    trpc.workspaces.linkedFromCli.subscriptionOptions(undefined, {
      onData: ({ byClaude, repoName, workspaceName, workspaceId, worktreePath }) => {
        if (shownWorkspace.current === workspaceId) {
          setLinkNotices((n) => ({ ...n, [workspaceId]: { byClaude, repoName, worktreePath } }));
          return;
        }
        setAppNotice({
          text: byClaude
            ? `Claude linked ${repoName} to ${workspaceName}`
            : `${repoName} was linked to ${workspaceName} from a terminal`,
          info: true,
        });
      },
    }),
  );

  const currentConfig = config.data?.config ?? null;
  const profiles = currentConfig?.profiles ?? [];
  profilesRef.current = profiles;
  // A new install opens the wizard by itself, once (spec §6.11).
  const firstLaunchHandled = useRef(false);
  useEffect(() => {
    if (!currentConfig || firstLaunchHandled.current) return;
    firstLaunchHandled.current = true;
    if (currentConfig.profiles.length === 0) setCreatingProfile(true);
  }, [currentConfig]);
  // On launch, the profile shown when the app quit (spec §5), else the first.
  const profile = profiles.find((p) => p.id === selectedProfile) ?? profiles[0] ?? null;
  const profileId = profile?.id ?? null;
  const profileProjects = (currentConfig?.projects ?? []).filter((p) => p.profileId === profileId);
  const profileWorkspaces = (workspaces.data ?? []).filter((w) => w.profileId === profileId);

  // The profile's setup check (spec §6.11); until it passes, projects and Claude are gated.
  // All profiles at once, so switching profiles never waits for a result.
  const setupChecks = useQuery(trpc.setup.all.queryOptions());
  const setupCheck = profileId ? (setupChecks.data?.[profileId] ?? null) : null;
  const setupOk = setupPassed(setupCheck);

  const chosen = (profileId && views[profileId]) || HOME;
  // A removed project falls back to the home terminal, a deleted workspace to its project.
  const project =
    chosen.kind === 'home' || chosen.kind === 'setup'
      ? null
      : (currentConfig?.projects.find((p) => p.id === chosen.projectId) ?? null);
  const workspace =
    chosen.kind === 'workspace'
      ? (profileWorkspaces.find((w) => w.id === chosen.workspaceId) ?? null)
      : null;
  const view: View =
    chosen.kind === 'setup'
      ? chosen
      : !project
        ? HOME
        : chosen.kind === 'workspace' && !workspace
          ? { kind: 'project', projectId: project.id }
          : chosen;
  shownWorkspace.current = view.kind === 'workspace' ? (workspace?.id ?? null) : null;

  const homeTab: HomeTab = (profileId && homeTabs[profileId]) || 'overview';

  const showView = (id: string, next: View, tab?: string) => {
    selectProfile(id);
    const shown = views[id];
    setViews((current) => ({ ...current, [id]: next }));
    // However a workspace is opened, its project expands in the sidebar (spec §6.1);
    // switching its terminal tabs doesn't undo a collapse.
    if (
      next.kind === 'workspace' &&
      (shown?.kind !== 'workspace' || shown.workspaceId !== next.workspaceId)
    ) {
      disclosure.opened(id, next.workspaceId, next.projectId);
    }
    if (tab) setSelectedTab((current) => ({ ...current, [`${id}/${viewKey(next)}`]: tab }));
  };
  // A linked repository's sessions carry its project (spec §21.1); the view is the workspace's.
  const showSession = (session: SessionInfo) => {
    const owner = session.workspaceId
      ? workspaces.data?.find((w) => w.id === session.workspaceId)
      : undefined;
    const next: View = owner
      ? { kind: 'workspace', projectId: owner.projectId, workspaceId: owner.id }
      : viewOf(session);
    showView(session.profileId, next, session.id);
  };
  // Adding or clicking a project lands on its Workspaces tab.
  const openProject = (p: Project) =>
    showView(p.profileId, { kind: 'project', projectId: p.id }, WORKSPACES_TAB);
  const openWorkspace = (w: Workspace) => {
    showView(w.profileId, { kind: 'workspace', projectId: w.projectId, workspaceId: w.id });
    disclosure.opened(w.profileId, w.id, w.projectId);
  };
  openRequest.current = (workspaceId) => {
    const target = workspaces.data?.find((w) => w.id === workspaceId);
    if (!target) return;
    disclosure.opened(target.profileId, target.id, target.projectId);
    const claude = (sessions.data ?? []).find(
      (s) => s.workspaceId === workspaceId && s.kind === 'claude',
    );
    if (claude) showSession(claude);
    else openWorkspace(target);
  };
  // A workspace that no longer exists (deleted since, or the notification is
  // from before a restart) leaves the app as it is.
  // It waits for the window to be back where it was, then takes over.
  useEffect(() => {
    if (!restored || !notificationClick || !workspaces.data || !sessions.data) return;
    setNotificationClick(null);
    if (!workspaces.data.some((w) => w.id === notificationClick)) return;
    openRequest.current(notificationClick);
    setFocusClaudeOf(notificationClick);
  }, [restored, notificationClick, workspaces.data, sessions.data]);
  const [newWorkspace, setNewWorkspace] = useState<{ project: Project | null } | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  // Home's Delete n merged workspaces (spec §6.7): one dialog for all of them.
  const [deletingMerged, setDeletingMerged] = useState<Workspace[] | null>(null);
  // Why Claude didn't start in a new workspace, by workspace id.
  const [claudeNotices, setClaudeNotices] = useState<Record<string, string>>({});
  // `then` is what was asked for; it opens once the check passes (spec §6.11).
  const openSetup = (then?: AfterSetup) => {
    if (profileId) showView(profileId, { kind: 'setup', then });
  };
  // New workspace and Start Claude here show the setup check until it passes.
  const startNewWorkspace = (p: Project | null) => {
    if (!setupOk) openSetup({ open: 'newWorkspace', from: view, projectId: p?.id ?? null });
    else if (profileProjects.length > 0) setNewWorkspace({ project: p });
  };
  const workspaceShell = useMutation(
    trpc.workspaces.shell.mutationOptions({ onSuccess: showSession }),
  );

  const projectShell = useMutation(
    trpc.sessions.projectShell.mutationOptions({ onSuccess: showSession }),
  );
  const projectClaude = useMutation(
    trpc.sessions.startClaudeInProject.mutationOptions({ onSuccess: showSession }),
  );
  const homeClaude = useMutation(
    trpc.sessions.startClaudeInHome.mutationOptions({
      onMutate: () => setHomeNotice(null),
      onError: (error) => setHomeNotice(error.message),
    }),
  );
  const showHomeTab = (id: string, tab: HomeTab) => setHomeTabs((t) => ({ ...t, [id]: tab }));

  // At start, the window shows what it showed when the app quit (spec §5),
  // falling back a step for whatever no longer exists. Once, when the
  // profiles, workspaces and sessions are known; the main area waits for it.
  const restoreDone = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when loaded
  useEffect(() => {
    if (restoreDone.current || !currentConfig || !workspaces.isFetched || !sessions.isFetched) {
      return;
    }
    restoreDone.current = true;
    setRestored(true);
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LAST_SHOWN_KEY);
    } catch {
      // no local storage: the first profile
    }
    const at = resolveLastShown(parseLastShown(stored), {
      profiles: currentConfig.profiles,
      projects: currentConfig.projects,
      workspaces: workspaces.data ?? [],
    });
    if (!at) return;
    const shown = at.view;
    if (shown.kind === 'home') {
      selectProfile(at.profileId);
      showHomeTab(at.profileId, shown.tab);
    } else if (shown.kind === 'project') {
      showView(at.profileId, { kind: 'project', projectId: shown.projectId }, shown.tab);
    } else {
      const { workspaceId, tab } = shown;
      const next: View = { kind: 'workspace', projectId: shown.projectId, workspaceId };
      const session =
        tab.kind === 'claude' || tab.kind === 'setup'
          ? sessions.data?.find((s) => s.workspaceId === workspaceId && s.kind === tab.kind)
          : undefined;
      showView(at.profileId, next, session?.id);
      if (shown.changes) toggleChanges(workspaceId, true);
      if (shown.responses) requestOnOpen(workspaceId, 'responses');
      if (shown.notes) showNotes(workspaceId, true);
      if (tab.kind === 'spec') requestOnOpen(workspaceId, 'spec');
      // Shells end with the app: a new one in the same repository.
      if (tab.kind === 'shell') {
        workspaceShell.mutate({
          workspaceId,
          projectId: tab.projectId === shown.projectId ? null : tab.projectId,
        });
      }
    }
    if (at.guide) setGuide((g) => ({ ...g, open: true, from: null }));
  }, [currentConfig, workspaces.isFetched, sessions.isFetched]);
  // Start Claude here on Home types into the home shell, on the Terminal tab (spec §6.7).
  const startClaudeIn = (v: View) => {
    if (v.kind === 'home' && profileId) {
      showHomeTab(profileId, 'terminal');
      homeClaude.mutate({ profileId });
    } else if (v.kind === 'project') projectClaude.mutate({ projectId: v.projectId });
  };
  // When the check passes, the gate lifts in place and the requested view opens (spec §6.11).
  const afterSetup = setupOk && profileId && view.kind === 'setup' ? view.then : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per passed check
  useEffect(() => {
    if (!afterSetup || !profileId) return;
    showView(profileId, afterSetup.from);
    if (afterSetup.open === 'startClaude') startClaudeIn(afterSetup.from);
    else {
      const p = currentConfig?.projects.find((q) => q.id === afterSetup.projectId) ?? null;
      setNewWorkspace({ project: p });
    }
  }, [afterSetup]);
  // A refused Start Claude here explains itself for a few seconds.
  useEffect(() => {
    if (!homeNotice) return;
    const timer = setTimeout(() => setHomeNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [homeNotice]);

  // Workspaces whose Claude is launching show the spinner (spec §6.3).
  const launching = new Set(
    (sessions.data ?? []).flatMap((s) =>
      s.kind === 'claude' && s.launching && s.workspaceId ? [s.workspaceId] : [],
    ),
  );
  // Suspended sessions by name, in every profile, for the memory panel (spec §6.14):
  // a workspace's title with its project, or "<project> (main checkout)", and
  // the profile when it isn't the shown one.
  const suspendedSessions: SuspendedSession[] = (sessions.data ?? []).flatMap((s) => {
    if (s.kind !== 'claude' || s.status !== 'suspended') return [];
    const w = s.workspaceId ? workspaces.data?.find((x) => x.id === s.workspaceId) : undefined;
    const project = currentConfig?.projects.find((p) => p.id === s.projectId);
    const name = w ? w.task.title || w.name : project ? `${project.name} (main checkout)` : s.title;
    const other =
      s.profileId !== profileId ? profiles.find((p) => p.id === s.profileId)?.name : undefined;
    const where = [w ? project?.name : undefined, other].filter(Boolean).join(' · ');
    return [{ id: s.id, name, where }];
  });
  // Workspaces whose Claude is suspended show the mark (spec §9.8).
  const suspended = new Set(
    (sessions.data ?? []).flatMap((s) =>
      s.kind === 'claude' && s.status === 'suspended' && s.workspaceId ? [s.workspaceId] : [],
    ),
  );
  const ready =
    info.isSuccess &&
    config.isSuccess &&
    sessions.isSuccess &&
    workspaces.isSuccess &&
    setupChecks.isSuccess;
  const profileSessions = (sessions.data ?? []).filter((s) => s.profileId === profileId);
  const viewSessions = sessionsOf(view, profileSessions);
  const tabKey = `${profileId}/${viewKey(view)}`;
  const projectTab =
    viewSessions.some((s) => s.id === selectedTab[tabKey]) ||
    PROJECT_TABS.includes(selectedTab[tabKey] ?? '')
      ? (selectedTab[tabKey] as string)
      : WORKSPACES_TAB;

  // What this window shows: alerts skip a Claude tab visible in the focused
  // window, and viewing a workspace clears its unread marker (spec §10.2, §10.3).
  const visibleWorkspace = workspace?.id ?? null;
  const shownSession =
    viewSessions.find((s) => s.id === selectedTab[tabKey]) ?? viewSessions[0] ?? null;
  const claudeTabShown = Boolean(workspace && shownSession?.kind === 'claude');

  // What the window shows, remembered for the next start (spec §5).
  const [panels, setPanels] = useState({ spec: false, responses: false });
  const onPanels = useCallback(
    (next: { spec: boolean; responses: boolean }) =>
      setPanels((current) =>
        current.spec === next.spec && current.responses === next.responses ? current : next,
      ),
    [],
  );
  const shownNow: LastShown | null = profileId
    ? {
        profileId,
        guide: guideOpen,
        view:
          view.kind === 'workspace' && workspace
            ? {
                kind: 'workspace',
                projectId: workspace.projectId,
                workspaceId: workspace.id,
                tab: panels.spec
                  ? { kind: 'spec' }
                  : shownSession?.kind === 'shell'
                    ? { kind: 'shell', projectId: shownSession.projectId ?? workspace.projectId }
                    : shownSession?.kind === 'setup'
                      ? { kind: 'setup' }
                      : { kind: 'claude' },
                changes: changesOpen.has(workspace.id),
                responses: panels.responses,
                notes: notesOpen.has(workspace.id),
              }
            : view.kind === 'project' && project
              ? {
                  kind: 'project',
                  projectId: project.id,
                  tab: PROJECT_TABS.includes(projectTab) ? projectTab : WORKSPACES_TAB,
                }
              : { kind: 'home', tab: homeTab },
      }
    : null;
  const shownJson = shownNow && JSON.stringify(shownNow);
  useEffect(() => {
    if (restored && shownJson) remember(LAST_SHOWN_KEY, shownJson);
  }, [restored, shownJson]);
  // A main checkout's Claude tab, shown in a project view, isn't suspended (spec §9.8).
  const shownSessionId = !workspace && projectTab === shownSession?.id ? shownSession.id : null;
  // What is shown changes the idle clocks (spec §9.8): the table's tooltips read them again.
  const setVisible = useMutation(
    trpc.status.setVisible.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.sessions.suspendClocks.queryKey() }),
    }),
  );
  // A clicked notification's workspace is shown: its Claude terminal takes the
  // focus (spec §10.3). The workspace view listens by then (children's effects run first).
  useEffect(() => {
    if (!focusClaudeOf || visibleWorkspace !== focusClaudeOf) return;
    setFocusClaudeOf(null);
    window.dispatchEvent(new CustomEvent(FOCUS_CLAUDE_EVENT, { detail: focusClaudeOf }));
  }, [focusClaudeOf, visibleWorkspace]);
  const markRead = useMutation(trpc.status.markRead.mutationOptions());
  // biome-ignore lint/correctness/useExhaustiveDependencies: report changes only
  useEffect(() => {
    setVisible.mutate({
      workspaceId: visibleWorkspace,
      claudeTab: claudeTabShown,
      sessionId: shownSessionId,
    });
  }, [visibleWorkspace, claudeTabShown, shownSessionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear once per unread
  useEffect(() => {
    if (workspace?.unread) markRead.mutate({ workspaceId: workspace.id });
  }, [workspace?.id, workspace?.unread]);

  // When setup succeeds Claude starts (spec §8.3): the finished Setup tab
  // makes way for it once; clicking Setup again later keeps it shown.
  const leftSetup = useRef(new Set<string>());
  const claudeAfterSetup = viewSessions.find((s) => s.kind === 'claude' && s.status === 'running');
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per finished setup
  useEffect(() => {
    const setup = shownSession;
    if (setup?.kind !== 'setup' || !setup.workspaceId || leftSetup.current.has(setup.id)) return;
    if (setup.status !== 'exited' || setup.exitCode !== 0 || !claudeAfterSetup) return;
    leftSetup.current.add(setup.id);
    showSession(claudeAfterSetup);
  }, [shownSession?.id, shownSession?.status, claudeAfterSetup?.id]);

  // ⌘W closes the shown terminal tab; a running Claude asks first (components.md).
  // The home terminal can't be closed from its tab (spec §6.7).
  closeTabRef.current = () => {
    if (document.querySelector('dialog[open]') || !shownSession || shownSession.kind === 'home') {
      return;
    }
    if (shownSession.kind === 'claude' && shownSession.status === 'running') {
      setClosingClaude(shownSession);
    } else {
      closeSession.mutate({ sessionId: shownSession.id });
    }
  };

  // The theme reads the active profile's color name (theme.css: [data-profile-color]).
  useEffect(() => {
    if (profile) document.documentElement.dataset.profileColor = profile.color;
    document.title = profile ? `${profile.name} — ${BRAND.displayName}` : BRAND.displayName;
  }, [profile]);

  // Window-wide shortcuts (components.md). Capturing runs before the terminal sees the key.
  const onShortcut = useRef<(e: KeyboardEvent) => boolean>(() => false);
  onShortcut.current = (e) => {
    if (document.querySelector('dialog[open]')) return false;
    const is = (id: ShortcutId) => matchShortcut(id, e, isMac);
    // The Guide opens from anywhere, even before there is a profile.
    if (is('guide') !== -1) {
      openGuide(null);
      return true;
    }
    if (!profile) return false;
    const profileDigit = is('profile');
    if (profileDigit !== -1) {
      const target = profiles[profileDigit - 1];
      if (target) selectProfile(target.id);
      return true;
    }
    if (is('home') !== -1) {
      selectProfile(profile.id);
      showView(profile.id, HOME);
      return true;
    }
    if (is('addProject') !== -1) {
      setAddingProject(true);
      return true;
    }
    if (is('newWorkspace') !== -1) {
      startNewWorkspace(project);
      return true;
    }
    // ⌘J: the next workspace that needs you, across profiles (spec §10.3).
    if (is('nextNeedingYou') !== -1) {
      const waiting = (workspaces.data ?? [])
        .filter((w) => needsYou(w.state))
        .sort((a, b) => (a.stateSince ?? '').localeCompare(b.stateSince ?? ''));
      const current = waiting.findIndex((w) => w.id === workspace?.id);
      const next = waiting[(current + 1) % Math.max(waiting.length, 1)];
      if (!next) showKeyNotice('No workspace needs you');
      else if (next.id === workspace?.id && shownSession?.kind === 'claude' && !guideOpen) {
        showKeyNotice('Nothing else needs you');
      } else openRequest.current(next.id);
      return true;
    }
    // In the Guide, the keys below belong to the profile's views.
    if (guideOpen) return false;
    if (is('startClaude') !== -1) {
      if (view.kind === 'workspace' || view.kind === 'setup') return false;
      if (!setupOk) openSetup({ open: 'startClaude', from: view });
      else startClaudeIn(view);
      return true;
    }
    if (is('newShell') !== -1) {
      if (!setupOk) return false;
      if (view.kind === 'project') {
        projectShell.mutate({ projectId: view.projectId, reuse: false });
      } else if (view.kind === 'workspace') {
        workspaceShell.mutate({ workspaceId: view.workspaceId });
      }
      return view.kind === 'project' || view.kind === 'workspace';
    }
    // The workspace's Changes panel (spec §6.4).
    if (is('changes') !== -1 && workspace) {
      toggleChanges(workspace.id);
      return true;
    }
    // Continue the workflow (spec §13.5), as the header's button; at a gate,
    // which waits for a person's answer, it puts the Claude terminal in focus.
    if (is('continueWorkflow') !== -1 && workspace?.workflow?.kind === 'gate') {
      const claude = (sessions.data ?? []).find(
        (s) => s.workspaceId === workspace.id && s.kind === 'claude',
      );
      if (claude) showSession(claude);
      window.dispatchEvent(new CustomEvent(FOCUS_CLAUDE_EVENT, { detail: workspace.id }));
      return true;
    }
    if (is('continueWorkflow') !== -1 && workspace?.workflow?.status) {
      trpcClient.workflow.continue
        .mutate({ workspaceId: workspace.id })
        .catch((e: unknown) => showKeyNotice(e instanceof Error ? e.message : String(e)));
      return true;
    }
    // Next and previous workspace of this profile, in sidebar order.
    const workspaceStep = is('workspaceStep');
    if (workspaceStep !== -1) {
      const order = profileProjects.flatMap((p) =>
        profileWorkspaces.filter((w) => w.projectId === p.id),
      );
      if (order.length === 0) {
        showKeyNotice(`No workspaces in ${profile.name} yet`);
        return true;
      }
      const at = order.findIndex((w) => w.id === workspace?.id);
      if (at !== -1 && order.length === 1) {
        showKeyNotice(`This is the only workspace in ${profile.name}`);
        return true;
      }
      const step = workspaceStep === 1 ? 1 : -1;
      const next =
        order[
          at === -1
            ? step === 1
              ? 0
              : order.length - 1
            : (at + step + order.length) % order.length
        ];
      if (next) openWorkspace(next);
      return true;
    }
    // Home's two tabs (spec §6.7): ⌃1 Overview, ⌃2 Terminal, ⌃Tab between them.
    if (view.kind === 'home') {
      const digit = is('terminalTab');
      if (digit === 1 || digit === 2) {
        showHomeTab(profile.id, digit === 1 ? 'overview' : 'terminal');
        return true;
      }
      if (is('cycleTabs') !== -1) {
        showHomeTab(profile.id, homeTab === 'overview' ? 'terminal' : 'overview');
        return true;
      }
      return digit !== -1;
    }
    // Cycle the view's terminal tabs.
    const cycle = is('cycleTabs');
    if (cycle !== -1 && viewSessions.length > 1) {
      const at = viewSessions.findIndex((s) => s.id === shownSession?.id);
      const step = cycle === 1 ? -1 : 1;
      const next = viewSessions[(at + step + viewSessions.length) % viewSessions.length];
      if (next) showSession(next);
      return true;
    }
    // Terminal tabs by number (macOS; elsewhere Ctrl+digit is the profile shortcut).
    const tabDigit = is('terminalTab');
    if (tabDigit !== -1) {
      const target = viewSessions[tabDigit - 1];
      if (target) showSession(target);
      return Boolean(target);
    }
    return false;
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (onShortcut.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  const location = workspace
    ? `${project?.name} › ${workspace.task.id ?? workspace.branch}`
    : project
      ? project.repoPath
      : profile
        ? homeTab === 'terminal'
          ? 'Home › Terminal'
          : 'Home'
        : '';

  // Opens the Guide: at a page and section for a deep link (remembering where
  // it came from, for Back), or where it was left.
  const origin = guideOpen
    ? guide.from
    : view.kind === 'workspace' && workspace
      ? workspace.name
      : view.kind === 'project' && project
        ? project.name
        : view.kind === 'setup'
          ? 'the setup check'
          : profile
            ? `${profile.name} Home`
            : null;
  const openGuide = (href: string | null) =>
    setGuide((g) => {
      if (!href) return { ...g, open: true, from: g.open ? g.from : null };
      const at = target(href);
      return { open: true, at, linked: at.section ? g.linked + 1 : g.linked, from: origin };
    });
  const openGuideRef = useRef(openGuide);
  openGuideRef.current = openGuide;

  return (
    // data-app-ready marks a completed round trip to the main process (--self-test waits for it).
    <SessionMarks launching={launching} suspended={suspended}>
      <GuideContext value={openGuide}>
        <div data-app-ready={ready || undefined} className="flex h-full flex-col bg-chrome text-fg">
          <ProfileTabs
            profiles={profiles}
            activeId={guideOpen || !restored ? null : profileId}
            attention={Object.fromEntries(
              profiles.map((p) => [
                p.id,
                (workspaces.data ?? []).filter((w) => w.profileId === p.id && needsYou(w.state))
                  .length,
              ]),
            )}
            onSelect={selectProfile}
            guideActive={guideOpen}
            onGuide={() => openGuide(null)}
            onNewProfile={currentConfig ? () => setCreatingProfile(true) : null}
            onMove={moveProfile}
            onContextMenu={async (p) => {
              const refusal = await trpcClient.profiles.removalRefusal.query({ profileId: p.id });
              const index = profiles.findIndex((other) => other.id === p.id);
              const choice = await trpcClient.ui.contextMenu.mutate({
                items: [
                  { id: 'edit', label: 'Edit profile…' },
                  { id: 'check', label: 'Check setup' },
                  { id: 'left', label: 'Move Left', enabled: index > 0 },
                  { id: 'right', label: 'Move Right', enabled: index < profiles.length - 1 },
                  { id: 'remove', label: 'Remove profile…', enabled: refusal === null },
                  ...(refusal ? [{ id: 'reason', label: refusal, enabled: false }] : []),
                ],
              });
              if (choice === 'edit') setEditingProfile(p.id);
              if (choice === 'remove') setRemovingProfile(p.id);
              if (choice === 'left' || choice === 'right') {
                moveProfile(p.id, index + (choice === 'left' ? -1 : 1));
              }
              if (choice === 'check') {
                showView(p.id, { kind: 'setup' });
                void trpcClient.setup.check.mutate({ profileId: p.id });
              }
            }}
          />
          {config.data?.error ? <ConfigError error={config.data.error} /> : null}
          <SandboxWarning />
          <UpdateNotice />
          {profile ? (
            <SuspendDefaultNotice onSettings={() => setEditingProfile(profile.id)} />
          ) : null}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {guide.open ? (
              <GuideView
                at={guide.at}
                linked={guide.linked}
                from={guide.from}
                onNavigate={(at, deep) =>
                  setGuide((g) => ({ ...g, at, linked: deep ? g.linked + 1 : g.linked }))
                }
                onBack={guide.from ? closeGuide : null}
              />
            ) : currentConfig && !restored ? null : (
              <>
                {currentConfig && profile ? (
                  <Sidebar
                    config={currentConfig}
                    profile={profile}
                    workspaces={profileWorkspaces}
                    view={view}
                    selectedWorkspaceId={workspace?.id ?? null}
                    onShowView={(id, next) =>
                      next.kind === 'project'
                        ? showView(id, next, WORKSPACES_TAB)
                        : showView(id, next)
                    }
                    onOpenWorkspace={openWorkspace}
                    isExpanded={(p) => disclosure.isOpen(p.profileId, p.id)}
                    onToggleProject={(p) => disclosure.toggle(p.profileId, p.id)}
                    onAddProject={() => setAddingProject(true)}
                    onRemoveProject={setRemoving}
                    onNewWorkspace={startNewWorkspace}
                    onDeleteWorkspace={setDeleting}
                  />
                ) : null}
                <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-term">
                  {unfinished.data?.run.running ? (
                    <ContinueNotice
                      run={unfinished.data.run}
                      workspaces={workspaces.data ?? []}
                      profiles={profiles}
                      onStop={() => void trpcClient.unfinished.stop.mutate()}
                    />
                  ) : null}
                  {appNotice ? (
                    <div
                      role={appNotice.info ? 'status' : 'alert'}
                      data-app-notice
                      className="flex shrink-0 items-start gap-3 border-b border-line bg-surface px-4 py-2 text-md"
                    >
                      {appNotice.info ? (
                        <span className="text-fg-subtle">↗</span>
                      ) : (
                        <span className="text-st-permission">▲</span>
                      )}
                      <span className="min-w-0 flex-1 whitespace-pre-wrap select-text">
                        {appNotice.text}
                      </span>
                      {appNotice.action ? (
                        <button
                          type="button"
                          data-notice-action
                          className={button('secondary', 'sm')}
                          onClick={() => {
                            appNotice.action?.run();
                            setAppNotice(null);
                          }}
                        >
                          {appNotice.action.label}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={iconButton}
                        title="Dismiss"
                        aria-label="Dismiss"
                        onClick={() => setAppNotice(null)}
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  {profile && (view.kind === 'setup' || (!setupOk && project)) ? (
                    <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
                      <div className="mx-auto max-w-[680px] px-6 py-8">
                        <SetupCheckPanel
                          key={profile.id}
                          profile={profile}
                          header={
                            view.kind === 'setup' && view.then
                              ? {
                                  title: `Finish setting up ${profile.name} to ${view.then.open === 'newWorkspace' ? 'open New workspace' : 'start Claude'}`,
                                  subtitle: `It opens as soon as all three checks pass. The Home terminal of ${profile.name} still works.`,
                                }
                              : view.kind === 'setup' || !project
                                ? {
                                    title: `Set up ${profile.name}`,
                                    subtitle: `Claude Code for ${profile.name} uses ${accountFolder(profile)}.`,
                                  }
                                : {
                                    title: `Finish setting up ${profile.name} to open ${workspace ? (workspace.task.id ?? workspace.name) : project.name}`,
                                    subtitle: `It opens as soon as all three checks pass. The Home terminal of ${profile.name} still works.`,
                                  }
                          }
                        />
                      </div>
                    </div>
                  ) : profile && workspace ? (
                    <WorkspaceView
                      key={tabKey}
                      profile={profile}
                      projects={(currentConfig?.projects ?? []).filter(
                        (p) => p.profileId === profile.id,
                      )}
                      workspace={workspace}
                      sessions={viewSessions}
                      activeId={selectedTab[tabKey] ?? null}
                      notice={claudeNotices[workspace.id] ?? workspaceShell.error?.message ?? null}
                      linkNotice={linkNotices[workspace.id] ?? null}
                      onDismissLinkNotice={() =>
                        setLinkNotices(({ [workspace.id]: _gone, ...rest }) => rest)
                      }
                      onSelect={showSession}
                      onDelete={() => setDeleting(workspace)}
                      changesOpen={changesOpen.has(workspace.id)}
                      onToggleChanges={() => toggleChanges(workspace.id)}
                      notesOpen={notesOpen.has(workspace.id)}
                      onNotesOpen={showNotes}
                      onPanels={onPanels}
                    />
                  ) : profile && project ? (
                    <ProjectView
                      key={tabKey}
                      profile={profile}
                      project={project}
                      workspaces={profileWorkspaces.filter((w) => w.projectId === project.id)}
                      sessions={viewSessions}
                      tab={projectTab}
                      onSelectTab={(tab) => showView(profile.id, view, tab)}
                      onSessionOpened={showSession}
                      onNewWorkspace={() => startNewWorkspace(project)}
                      onOpenWorkspace={openWorkspace}
                      onRemove={() => setRemoving(project)}
                      onAdopt={(worktree) => setAdopting({ projectId: project.id, worktree })}
                      shortcutError={(projectShell.error ?? projectClaude.error)?.message ?? null}
                      memory={memory.data ?? null}
                    />
                  ) : profile ? (
                    <HomeView
                      key={tabKey}
                      profile={profile}
                      tab={homeTab}
                      onSelectTab={(tab) => showHomeTab(profile.id, tab)}
                      session={viewSessions[0] ?? null}
                      sessions={profileSessions}
                      projects={profileProjects}
                      workspaces={profileWorkspaces}
                      memory={memory.data ?? null}
                      startClaude={{ error: homeNotice }}
                      actions={{
                        open: (w) => openRequest.current(w.id),
                        responses: (w, entry) => {
                          requestOnOpen(w.id, 'responses', entry ?? undefined);
                          openRequest.current(w.id);
                        },
                        openProject,
                        review: (w) => {
                          requestOnOpen(w.id, 'spec');
                          openWorkspace(w);
                        },
                        commit: (w) => {
                          requestOnOpen(w.id, 'commit');
                          toggleChanges(w.id, true);
                          openWorkspace(w);
                        },
                        openChanges: (w) => {
                          toggleChanges(w.id, true);
                          openWorkspace(w);
                        },
                        delete: setDeleting,
                        deleteMerged: setDeletingMerged,
                        newWorkspace:
                          profileProjects.length > 0 ? () => startNewWorkspace(null) : null,
                        newWorkspaceIn: startNewWorkspace,
                        addProject: () => setAddingProject(true),
                        guide: () => openGuide(null),
                      }}
                    />
                  ) : currentConfig ? (
                    <FirstLaunch onCreateProfile={() => setCreatingProfile(true)} />
                  ) : null}
                </main>
              </>
            )}
          </div>
          <StatusBar
            profile={profile}
            location={location}
            setupWarning={setupWarning(setupCheck)}
            onOpenSetup={() => openSetup()}
            usage={{ snapshot: (profileId && usage.data?.[profileId]) || null, show: setupOk }}
            notice={keyNotice}
            workspaces={profileWorkspaces}
            memory={memory.data ?? null}
            suspendedSessions={suspendedSessions}
          />

          {editingProfile && profiles.some((p) => p.id === editingProfile) ? (
            <EditProfileDialog
              profile={profiles.find((p) => p.id === editingProfile) as (typeof profiles)[number]}
              profiles={profiles}
              onClose={() => setEditingProfile(null)}
              onCheckSetup={() => {
                setEditingProfile(null);
                showView(editingProfile, { kind: 'setup' });
                void trpcClient.setup.check.mutate({ profileId: editingProfile });
              }}
            />
          ) : null}
          {removingProfile && profiles.some((p) => p.id === removingProfile) ? (
            <RemoveProfileDialog
              profile={profiles.find((p) => p.id === removingProfile) as (typeof profiles)[number]}
              onClose={() => setRemovingProfile(null)}
            />
          ) : null}
          {installingCli ? <InstallCliDialog onClose={() => setInstallingCli(false)} /> : null}
          {adopting ? (
            <AdoptFor
              adopting={adopting}
              profiles={profiles}
              projects={currentConfig?.projects ?? []}
              onClose={() => setAdopting(null)}
              onAdopted={(workspace) => {
                setAdopting(null);
                openWorkspace(workspace);
              }}
            />
          ) : null}
          {closingClaude ? (
            <Modal
              title="Close Claude?"
              description="Closing the tab stops this Claude session. Its conversation can be resumed with Start Claude."
              onClose={() => setClosingClaude(null)}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  closeSession.mutate({ sessionId: closingClaude.id });
                  setClosingClaude(null);
                }}
              >
                <ModalFooter>
                  {/* The dialog focuses this first button: Cancel. */}
                  <button
                    type="button"
                    className={button('secondary', 'lg')}
                    onClick={() => setClosingClaude(null)}
                  >
                    Cancel <Kbd>Esc</Kbd>
                  </button>
                  <button type="submit" className={button('danger', 'lg')}>
                    Close Claude
                  </button>
                </ModalFooter>
              </form>
            </Modal>
          ) : null}
          {quitting ? (
            <QuitDialog
              sessionIds={quitting}
              sessions={sessions.data ?? []}
              workspaces={workspaces.data ?? []}
              profiles={profiles}
              onAnswer={(quit) => {
                setQuitting(null);
                void trpcClient.app.answerQuit.mutate({ quit });
              }}
            />
          ) : null}
          {unfinished.data?.overview && workspaces.data && !quitting ? (
            <UnfinishedDialog
              workspaceIds={unfinished.data.overview}
              workspaces={workspaces.data}
              profiles={profiles}
              projects={currentConfig?.projects ?? []}
              usage={usage.data ?? {}}
              onContinue={(workspaceIds) => {
                void trpcClient.unfinished.closeOverview.mutate();
                void trpcClient.unfinished.continue.mutate({ workspaceIds });
              }}
              onClose={() => void trpcClient.unfinished.closeOverview.mutate()}
              onOpen={(w) => {
                void trpcClient.unfinished.closeOverview.mutate();
                openWorkspace(w);
              }}
            />
          ) : null}
          {closeNotice ? (
            <CloseNotice
              onAnswer={(close) => {
                setCloseNotice(false);
                void trpcClient.app.answerCloseNotice.mutate({ close });
              }}
            />
          ) : null}
          {creatingProfile && currentConfig ? (
            <NewProfileWizard
              profiles={profiles}
              onClose={() => setCreatingProfile(false)}
              onOpen={(created) => {
                setCreatingProfile(false);
                setSelectedProfile(created.id);
              }}
            />
          ) : null}
          {addingProject && profile ? (
            <AddProjectDialog
              profile={profile}
              projects={profileProjects}
              onClose={() => setAddingProject(false)}
              onAdded={(added) => {
                setAddingProject(false);
                openProject(added);
              }}
            />
          ) : null}
          {newWorkspace && profile ? (
            <NewWorkspaceDialog
              profile={profile}
              projects={profileProjects}
              initialProject={newWorkspace.project}
              onClose={() => setNewWorkspace(null)}
              onOpenElsewhere={(at, project) => {
                // Spec §7.6: the branch's workspace, Open as workspace for its
                // worktree, or the project for its main checkout.
                setNewWorkspace(null);
                if (at.kind === 'workspace') {
                  const found = workspaces.data?.find((w) => w.id === at.workspaceId);
                  if (found) openWorkspace(found);
                } else if (at.kind === 'worktree') {
                  setAdopting({
                    projectId: project.id,
                    worktree: {
                      path: at.path,
                      branch: null,
                      taskId: null,
                      title: '',
                      titleFromField: false,
                    },
                  });
                } else openProject(project);
              }}
              onCreated={({ workspace: created, claude, claudeError, setup, notes }) => {
                setNewWorkspace(null);
                // A renamed branch, a local base, a task not found (spec §7.1, §7.3).
                if (notes.length > 0) setAppNotice({ text: notes.join('\n'), info: true });
                if (claudeError) setClaudeNotices((n) => ({ ...n, [created.id]: claudeError }));
                // Setup first: its tab shows until Claude starts (spec §8.3). The
                // view comes from the new workspace, which the list may not have yet,
                // so a linked repository's Setup tab doesn't open that repository's project.
                const session = setup ?? claude;
                if (session) {
                  showView(
                    created.profileId,
                    { kind: 'workspace', projectId: created.projectId, workspaceId: created.id },
                    session.id,
                  );
                } else openWorkspace(created);
              }}
            />
          ) : null}
          {deleting ? (
            <DeleteWorkspaceDialog
              workspace={deleting}
              projects={currentConfig?.projects ?? []}
              remote={
                currentConfig?.projects.find((p) => p.id === deleting.projectId)?.remote ?? null
              }
              onClose={() => setDeleting(null)}
              onCommitFirst={() => {
                toggleChanges(deleting.id, true);
                setDeleting(null);
              }}
              onDeleted={({ teardown }) => {
                setDeleting(null);
                if (teardown && !teardown.ok) {
                  setAppNotice({
                    text: `${deleting.name} was deleted, but its teardown didn't finish: ${teardown.message}.${teardown.output ? `\n${teardown.output}` : ''}`,
                  });
                }
              }}
            />
          ) : null}
          {deletingMerged ? (
            <DeleteWorkspacesDialog
              workspaces={deletingMerged}
              projects={currentConfig?.projects ?? []}
              onClose={() => setDeletingMerged(null)}
              onDeleted={({ teardownFailures }) => {
                setDeletingMerged(null);
                if (teardownFailures.length > 0) {
                  setAppNotice({
                    text: `Deleted, but teardown didn't finish for ${teardownFailures.join('; ')}.`,
                  });
                }
              }}
            />
          ) : null}
          {removing && profile ? (
            <RemoveProjectDialog
              projects={currentConfig?.projects ?? []}
              project={removing}
              profile={profile}
              onClose={() => setRemoving(null)}
              onRemoved={({ teardownFailures }) => {
                setRemoving(null);
                if (teardownFailures.length > 0) {
                  setAppNotice({
                    text: `${removing.name} was removed, but teardown didn't finish for ${teardownFailures.join('; ')}.`,
                  });
                }
              }}
            />
          ) : null}
        </div>
      </GuideContext>
    </SessionMarks>
  );
}

/**
 * Open as workspace (spec §13.6) for a worktree from the project view or the
 * notice; the notice's worktree is prefilled here from the project's list.
 */
function AdoptFor({
  adopting,
  profiles,
  projects,
  onClose,
  onAdopted,
}: {
  adopting: { projectId: string; worktree: OtherWorktree };
  profiles: Profile[];
  projects: Project[];
  onClose: () => void;
  onAdopted: (workspace: Workspace) => void;
}) {
  const trpc = useTRPC();
  const others = useQuery(
    trpc.workspaces.otherWorktrees.queryOptions(
      { projectId: adopting.projectId },
      { staleTime: 0 },
    ),
  );
  const project = projects.find((p) => p.id === adopting.projectId);
  const profile = profiles.find((p) => p.id === project?.profileId);
  if (!project || !profile) return null;
  const listed = others.data?.find((w) => w.path === adopting.worktree.path);
  // The notice has no prefill: wait for a fresh list, which has it.
  if (!listed && adopting.worktree.title === '' && !others.isFetchedAfterMount) return null;
  return (
    <AdoptWorktreeDialog
      profile={profile}
      project={project}
      worktree={listed ?? adopting.worktree}
      onClose={onClose}
      onAdopted={onAdopted}
    />
  );
}
