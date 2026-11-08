import { needsYou, type WorkspaceState } from './status';
import {
  mergedText,
  type PrStatus,
  prMerged,
  type Workspace,
  type WorkspaceRepo,
  workspaceMerged,
} from './workspaces';

/**
 * Home's Overview (spec §6.7): which of a profile's workspaces show in which
 * section. A workspace shows in one section at most, the first that applies:
 * Needs you, Working now, Clean up, Ready to ship.
 */
export type HomeSection = 'needs' | 'working' | 'clean' | 'ship';

export const HOME_SECTIONS: readonly HomeSection[] = ['needs', 'working', 'ship', 'clean'];

export const HOME_SECTION_TITLE: Record<HomeSection, string> = {
  needs: 'Needs you',
  working: 'Working now',
  ship: 'Ready to ship',
  clean: 'Clean up',
};

/** Rows a section shows before "Show all n" (spec §6.7). */
export const HOME_SECTION_LIMIT = 5;

/** What a Done workspace has left to ship, summed over its repositories. */
export interface ShipState {
  uncommitted: number;
  unpushed: number;
}

/** What a Ready to ship row offers: the first of these that applies (spec §6.7). */
export type ShipStep =
  | { kind: 'commit'; files: number }
  | { kind: 'push'; commits: number }
  | { kind: 'pr'; pr: PrStatus };

/** The main repository's open or draft PR, else the first linked one's. */
export function openPr(w: Pick<Workspace, 'repos' | 'pr'>): PrStatus | null {
  const open = (pr: PrStatus | null | undefined) =>
    pr && (pr.state === 'open' || pr.state === 'draft') ? pr : null;
  return (
    open(w.repos.find((r) => r.primary)?.pr ?? w.pr) ??
    w.repos.map((r) => open(r.pr)).find(Boolean) ??
    null
  );
}

/** Uncommitted files first, then unpushed commits, then an open pull request. */
export function shipStep(
  w: Pick<Workspace, 'repos' | 'pr'>,
  state: ShipState | null,
): ShipStep | null {
  if (state && state.uncommitted > 0) return { kind: 'commit', files: state.uncommitted };
  if (state && state.unpushed > 0) return { kind: 'push', commits: state.unpushed };
  const pr = openPr(w);
  return pr ? { kind: 'pr', pr } : null;
}

/** When the workspace began needing you: its state's start, or when Claude was cut off. */
export const needsSince = (w: Pick<Workspace, 'state' | 'stateSince' | 'unfinished'>) =>
  (needsYou(w.state) ? w.stateSince : w.unfinished?.since) ?? '';

/**
 * The section a workspace belongs in, or null for none. `ship` is what its
 * repositories have left to ship; null while unknown.
 */
export function homeSection(w: Workspace, ship: ShipState | null): HomeSection | null {
  if (needsYou(w.state) || w.unfinished) return 'needs';
  if (w.state === 'working') return 'working';
  if (workspaceMerged(w)) return 'clean';
  if (w.state === 'done' && shipStep(w, ship)) return 'ship';
  return null;
}

/**
 * The profile's workspaces by section, each in its order: Needs you oldest
 * first (as ⌘J goes), Working now longest first, the rest by last activity.
 */
export function homeSections(
  workspaces: Workspace[],
  ship: (workspaceId: string) => ShipState | null,
): Record<HomeSection, Workspace[]> {
  const out: Record<HomeSection, Workspace[]> = { needs: [], working: [], ship: [], clean: [] };
  for (const w of workspaces) {
    const section = homeSection(w, ship(w.id));
    if (section) out[section].push(w);
  }
  const activity = (w: Workspace) => w.lastActivityAt ?? w.createdAt;
  out.needs.sort((a, b) => needsSince(a).localeCompare(needsSince(b)));
  out.working.sort((a, b) => (a.stateSince ?? '').localeCompare(b.stateSince ?? ''));
  out.ship.sort((a, b) => activity(b).localeCompare(activity(a)));
  out.clean.sort((a, b) => activity(b).localeCompare(activity(a)));
  return out;
}

/** The workspaces that may be Ready to ship: their git state is worth asking for. */
export const shipCandidates = (workspaces: Workspace[]) =>
  workspaces.filter(
    (w) => !needsYou(w.state) && !w.unfinished && w.state === 'done' && !workspaceMerged(w),
  );

/** "#212" from a pull request's address, or null. */
export function prNumber(pr: Pick<PrStatus, 'url'>): string | null {
  const n = pr.url ? /\/(\d+)\/?$/.exec(pr.url)?.[1] : null;
  return n ? `#${n}` : null;
}

/** "PR #212 open", "PR draft", "PR #198 merged", "Likely merged" (spec §6.7). */
export function prText(pr: PrStatus): string {
  const n = prNumber(pr);
  const pull = n ? `PR ${n}` : 'PR';
  switch (pr.state) {
    case 'open':
      return `${pull} open`;
    case 'draft':
      return `${pull} draft`;
    case 'merged':
      return `${pull} merged`;
    case 'closed':
      return `${pull} closed`;
    case 'likely-merged':
      return 'Likely merged: the branch is gone from the remote';
  }
}

/** A merged repository's row text: its merged PR's, else where its branch is merged (§14.2). */
export const mergedLabel = (repo: WorkspaceRepo): string =>
  repo.pr && prMerged(repo.pr)
    ? prText(repo.pr)
    : mergedText(repo.merged ?? 'base', repo.baseBranch);

/** "working for 4 min", "working for 1 h 5 min", "working for less than a minute". */
export function workingFor(since: string | null, now = Date.now()): string {
  if (!since) return 'working';
  const minutes = Math.floor(Math.max(0, now - Date.parse(since)) / 60_000);
  if (minutes < 1) return 'working for less than a minute';
  if (minutes < 60) return `working for ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `working for ${h} h${m ? ` ${m} min` : ''}`;
}

/** The profile's projects with their own workspaces and those they are linked into (§21.1). */
export function projectCounts(
  projectIds: string[],
  workspaces: Pick<Workspace, 'projectId' | 'repos'>[],
): { projectId: string; count: number; linked: number }[] {
  return projectIds.map((projectId) => ({
    projectId,
    count: workspaces.filter((w) => w.projectId === projectId).length,
    linked: workspaces.filter(
      (w) => w.projectId !== projectId && w.repos.some((r) => r.projectId === projectId),
    ).length,
  }));
}

/**
 * Home's Board (spec §6.7): the List's sections as columns, and Idle for
 * every workspace that is in none of them.
 */
export type BoardColumn = 'needs' | 'working' | 'idle' | 'ship' | 'merged';

export const BOARD_COLUMNS: readonly BoardColumn[] = ['working', 'idle', 'needs', 'ship', 'merged'];

export const BOARD_COLUMN_TITLE: Record<BoardColumn, string> = {
  needs: 'Needs you',
  working: 'Working',
  idle: 'Idle',
  ship: 'Ready to ship',
  merged: 'Merged',
};

const COLUMN_OF: Record<HomeSection, BoardColumn> = {
  needs: 'needs',
  working: 'working',
  ship: 'ship',
  clean: 'merged',
};

/** The column a workspace belongs in: its List section's, else Idle. */
export const boardColumn = (w: Workspace, ship: ShipState | null): BoardColumn => {
  const section = homeSection(w, ship);
  return section ? COLUMN_OF[section] : 'idle';
};

/**
 * The profile's workspaces by column: the List's sections in their order,
 * and Idle (interrupted, suspended, exited, or Done with nothing to ship) by
 * last activity.
 */
export function boardColumns(
  workspaces: Workspace[],
  ship: (workspaceId: string) => ShipState | null,
): Record<BoardColumn, Workspace[]> {
  const sections = homeSections(workspaces, ship);
  const activity = (w: Workspace) => w.lastActivityAt ?? w.createdAt;
  const idle = workspaces
    .filter((w) => homeSection(w, ship(w.id)) === null)
    .sort((a, b) => activity(b).localeCompare(activity(a)));
  return {
    needs: sections.needs,
    working: sections.working,
    idle,
    ship: sections.ship,
    merged: sections.clean,
  };
}

/**
 * What a card offers for a quick reply (spec §6.7): `field` to type into,
 * `open` where Claude shows its permission menu (typed text would answer it),
 * `question` where Claude waits on its question tool (the card shows the
 * options instead), `draft` where its prompt holds unsent text, or `none`.
 */
export type QuickReply = 'field' | 'open' | 'question' | 'draft' | 'none';

/** States in which a running Claude waits at its prompt or works (and queues input). */
const REPLY_STATES: readonly WorkspaceState[] = [
  'working',
  'needs-input',
  'awaiting-approval',
  'done',
  'interrupted',
];

export interface QuickReplyFacts {
  /** The workspace's Claude session: null when it has none. */
  claude: { status: 'running' | 'suspended' | 'exited'; resuming: boolean } | null;
  /** Text typed into Claude's prompt and not sent (spec §9.8). */
  draft: boolean;
  /**
   * Claude waits on its question tool (from the transcript): its menu takes
   * typed text as an answer, so the card offers the options instead.
   */
  question: boolean;
}

/**
 * Whether a quick reply may be typed into the workspace's Claude: never at
 * Claude's question menu (Claude Code reads its state as Working, then as a
 * permission request) nor on a permission request (also an Unfinished one),
 * nor over a draft; only where
 * Claude waits at its prompt or works, or is suspended (it resumes first).
 * Never on Merged, nor on an exited Claude.
 */
export function quickReply(
  w: Pick<Workspace, 'state' | 'unfinished'>,
  column: BoardColumn,
  facts: QuickReplyFacts,
): QuickReply {
  if (column === 'merged') return 'none';
  if (facts.question && facts.claude?.status === 'running') return 'question';
  if (w.state === 'needs-permission' || w.unfinished?.kind === 'permission') return 'open';
  const { claude } = facts;
  if (!claude || claude.status === 'exited') return 'none';
  const ready =
    claude.status === 'suspended' || (!claude.resuming && REPLY_STATES.includes(w.state));
  if (!ready) return 'none';
  return facts.draft ? 'draft' : 'field';
}

/** Why the main process refuses a quick reply, by what `quickReply` says. */
export const QUICK_REPLY_REFUSAL: Record<Exclude<QuickReply, 'field'>, string> = {
  open: 'Claude is asking for permission; answer it in the Claude tab',
  question: 'Claude is asking a question; pick an answer on the card or in the Claude tab',
  draft: 'Has an unsent prompt; open it',
  none: "Claude isn't waiting for a message in this workspace",
};

/**
 * "Bash" from "Claude needs your permission to use Bash", else the message;
 * nothing for Claude Code's "Claude needs your permission" without a tool (its
 * question tool's notice, which the card shows as the question instead).
 */
export function permissionTool(message: string | null): string | null {
  if (!message || /^claude needs your permission\.?$/i.test(message.trim())) return null;
  return /permission to use (.+)$/i.exec(message)?.[1]?.trim() ?? message;
}
