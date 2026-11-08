/**
 * What the window showed when the app quit, shown again at the next start
 * (spec §5, Reopening where you were): the profile (or the Guide over it) and,
 * within it, Home with its tab, a project's view with its tab, or a workspace
 * with its tab and its Changes and Responses panels. Kept in the window's
 * local storage; anything that no longer exists falls back a step.
 */
import { WORKSPACES_TAB } from './view';

/** A workspace's tab: Claude, a Setup tab, a shell (in which repository) or the spec view. */
export type ShownTab =
  | { kind: 'claude' }
  | { kind: 'setup' }
  | { kind: 'shell'; projectId: string }
  | { kind: 'spec' };

export type ShownView =
  | { kind: 'home'; tab: 'overview' | 'terminal' }
  | { kind: 'project'; projectId: string; tab: string }
  | {
      kind: 'workspace';
      projectId: string;
      workspaceId: string;
      tab: ShownTab;
      changes: boolean;
      responses: boolean;
    };

export interface LastShown {
  profileId: string;
  guide: boolean;
  view: ShownView;
}

export const LAST_SHOWN_KEY = 'last-shown';

const HOME_OVERVIEW: ShownView = { kind: 'home', tab: 'overview' };

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseTab(value: unknown): ShownTab {
  const tab = (value ?? {}) as Record<string, unknown>;
  if (tab.kind === 'setup' || tab.kind === 'spec') return { kind: tab.kind };
  if (tab.kind === 'shell' && isString(tab.projectId)) {
    return { kind: 'shell', projectId: tab.projectId };
  }
  return { kind: 'claude' };
}

function parseView(value: unknown): ShownView {
  const view = (value ?? {}) as Record<string, unknown>;
  if (view.kind === 'project' && isString(view.projectId)) {
    return {
      kind: 'project',
      projectId: view.projectId,
      tab: isString(view.tab) ? view.tab : WORKSPACES_TAB,
    };
  }
  if (view.kind === 'workspace' && isString(view.projectId) && isString(view.workspaceId)) {
    return {
      kind: 'workspace',
      projectId: view.projectId,
      workspaceId: view.workspaceId,
      tab: parseTab(view.tab),
      changes: view.changes === true,
      responses: view.responses === true,
    };
  }
  return { kind: 'home', tab: view.tab === 'terminal' ? 'terminal' : 'overview' };
}

/** The stored value, or null when there is none or it can't be read. */
export function parseLastShown(text: string | null): LastShown | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || !isString(value.profileId)) return null;
    return { profileId: value.profileId, guide: value.guide === true, view: parseView(value.view) };
  } catch {
    return null;
  }
}

/** What exists now, to check the stored view against. */
export interface ShownWorld {
  /** In tab order. */
  profiles: { id: string }[];
  projects: { id: string; profileId: string }[];
  workspaces: {
    id: string;
    profileId: string;
    projectId: string;
    repos: { projectId: string }[];
  }[];
}

/**
 * Where the window opens (spec §5): the stored view, falling back step by
 * step. A deleted workspace falls back to its project's Workspaces tab, a
 * removed project to Home's Overview, a removed profile to the first profile's
 * Home; a shell in a repository no longer linked to the workspace to its
 * Claude tab. Null without profiles.
 */
export function resolveLastShown(last: LastShown | null, world: ShownWorld): LastShown | null {
  const first = world.profiles[0];
  if (!first) return null;
  if (!last) return { profileId: first.id, guide: false, view: HOME_OVERVIEW };
  if (!world.profiles.some((p) => p.id === last.profileId)) {
    return { profileId: first.id, guide: last.guide, view: HOME_OVERVIEW };
  }
  const shown = { profileId: last.profileId, guide: last.guide };
  const view = last.view;
  if (view.kind === 'home') return { ...shown, view };
  const project = world.projects.find(
    (p) => p.id === view.projectId && p.profileId === last.profileId,
  );
  if (!project) return { ...shown, view: HOME_OVERVIEW };
  if (view.kind === 'project') return { ...shown, view };
  const workspace = world.workspaces.find(
    (w) => w.id === view.workspaceId && w.profileId === last.profileId,
  );
  if (!workspace || workspace.projectId !== project.id) {
    return { ...shown, view: { kind: 'project', projectId: project.id, tab: WORKSPACES_TAB } };
  }
  const shell = view.tab.kind === 'shell' ? view.tab.projectId : null;
  const tab: ShownTab =
    shell && shell !== workspace.projectId && !workspace.repos.some((r) => r.projectId === shell)
      ? { kind: 'claude' }
      : view.tab;
  return { ...shown, view: { ...view, tab } };
}
