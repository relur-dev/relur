import { atMenu, needsYou, type WorkspaceState } from './status';
import { SUSPENDED_TOOLTIP } from './suspend';
import { unfinishedTooltip } from './unfinished';
import {
  mergedText,
  type PrStatus,
  prMerged,
  type Workspace,
  type WorkspaceRepo,
  workspaceMerged,
} from './workspaces';

/**
 * The Board (spec §6.7): which status a workspace's card shows, by the first
 * rule that applies: Needs you, Working, Merged (`clean`), Ready to ship; a
 * workspace in none of them is Idle.
 */
export type HomeSection = 'needs' | 'working' | 'clean' | 'ship';

/** What a Done workspace has left to ship, summed over its repositories. */
export interface ShipState {
  uncommitted: number;
  unpushed: number;
  /** Repositories that use pull requests, with commits of their own and no PR known (§6.7). */
  withoutPr: number;
  /** Repositories Merge into the base has something to do in (§14.4). */
  mergeable: number;
  /** What Merge does with a base first ("main is 3 behind origin/main; …", §14.4). */
  baseNotes?: string[];
}

/** What a Ready to ship row offers: the first of these that applies (spec §6.7). */
export type ShipStep =
  | { kind: 'commit'; files: number }
  | { kind: 'push'; commits: number }
  | { kind: 'create'; repos: number }
  | { kind: 'pr'; prs: RepoPr[] }
  | { kind: 'merge'; repos: number };

/** A repository's pull request, by its project. */
export interface RepoPr {
  projectId: string;
  pr: PrStatus;
}

/**
 * Whether a repository is waiting for its pull request (spec §6.7): its
 * project uses pull requests (a PR create or status command is set), and its
 * branch has commits of its own but no PR is known. Without the commands it
 * isn't, since some merge locally instead.
 */
export const waitsForPr = (s: {
  usesPrs: boolean;
  hasRemote: boolean;
  hasOwnCommits: boolean;
  pr: PrStatus | null;
}) => s.usesPrs && s.hasRemote && s.hasOwnCommits && !s.pr;

/** Every open or draft pull request of the workspace, the main repository's first. */
export function openPrs(w: Pick<Workspace, 'repos' | 'pr'>): RepoPr[] {
  const open = (pr: PrStatus | null | undefined): pr is PrStatus =>
    !!pr && (pr.state === 'open' || pr.state === 'draft');
  const repos = [...w.repos].sort((a, b) => Number(b.primary) - Number(a.primary));
  return repos.flatMap((r) => {
    const pr = r.primary ? (r.pr ?? w.pr) : r.pr;
    return open(pr) ? [{ projectId: r.projectId, pr }] : [];
  });
}

/**
 * Uncommitted files first, then unpushed commits, then repositories without
 * a PR, then open PRs, then branches to merge into their bases (§14.4).
 */
export function shipStep(
  w: Pick<Workspace, 'repos' | 'pr'>,
  state: ShipState | null,
): ShipStep | null {
  if (state && state.uncommitted > 0) return { kind: 'commit', files: state.uncommitted };
  if (state && state.unpushed > 0) return { kind: 'push', commits: state.unpushed };
  if (state && state.withoutPr > 0) return { kind: 'create', repos: state.withoutPr };
  const prs = openPrs(w);
  if (prs.length > 0) return { kind: 'pr', prs };
  return state && state.mergeable > 0 ? { kind: 'merge', repos: state.mergeable } : null;
}

/**
 * Whether a Ready to ship row offers Merge into <base> beside its main action
 * (spec §6.7, §14.4): everything committed and something to merge.
 */
export const offersMerge = (state: ShipState | null) =>
  !!state && state.uncommitted === 0 && state.mergeable > 0;

/** "Ready to merge into main", or "2 repositories ready to merge" in a linked workspace. */
export const readyToMergeText = (repos: number, base: string, linked: boolean) =>
  linked
    ? `${repos} ${repos === 1 ? 'repository' : 'repositories'} ready to merge`
    : `Ready to merge into ${base}`;

/**
 * The open pull requests' text (spec §6.7): one as prText ("PR #212 open"),
 * several counted ("2 PRs open", "3 PRs: 2 open, 1 draft").
 */
export function openPrsText(prs: RepoPr[]): string {
  const [first] = prs;
  if (!first) return '';
  if (prs.length === 1) return prText(first.pr);
  const drafts = prs.filter((p) => p.pr.state === 'draft').length;
  const open = prs.length - drafts;
  if (drafts === 0) return `${prs.length} PRs open`;
  if (open === 0) return `${prs.length} draft PRs`;
  return `${prs.length} PRs: ${open} open, ${drafts} draft`;
}

/** "Pushed, no PR yet", or "2 repositories without a PR" in a linked workspace (spec §6.7). */
export const withoutPrText = (repos: number, linked: boolean) =>
  linked
    ? `${repos} ${repos === 1 ? 'repository' : 'repositories'} without a PR`
    : 'Pushed, no PR yet';

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
 * The workspaces by section, each in its order: Needs you oldest first (as
 * ⌘J goes), Working longest first, the rest by last activity.
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

/**
 * What a project's Board shows (spec §6.10): the project's own workspaces, and
 * those of other projects linked into it (§21.1), which its cards mark.
 */
export function projectWorkspaces<W extends Pick<Workspace, 'projectId' | 'repos'>>(
  projectId: string,
  workspaces: W[],
): { own: W[]; linkedIn: W[] } {
  return {
    own: workspaces.filter((w) => w.projectId === projectId),
    linkedIn: workspaces.filter(
      (w) => w.projectId !== projectId && w.repos.some((r) => r.projectId === projectId),
    ),
  };
}

/**
 * The Board's columns (spec §6.7): a column for each section, and Idle for
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

/** The column a workspace belongs in: its section's, else Idle. */
export const boardColumn = (w: Workspace, ship: ShipState | null): BoardColumn => {
  const section = homeSection(w, ship);
  return section ? COLUMN_OF[section] : 'idle';
};

/**
 * The workspaces by column: the sections in their order (spec §6.7), and Idle (interrupted, suspended, exited, or Done with nothing to ship) by
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
   * Claude shows its prompt after its SessionStart (spec §9.8): in Starting,
   * a fresh or restarted Claude that waits there takes typed text.
   */
  atPrompt: boolean;
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
 * Claude waits at its prompt (also in Starting, once it shows it) or works,
 * or is suspended (it resumes first). Never on Merged, nor on an exited Claude.
 */
export function quickReply(
  w: Pick<Workspace, 'state' | 'unfinished'>,
  column: BoardColumn,
  facts: QuickReplyFacts,
): QuickReply {
  if (column === 'merged') return 'none';
  if (facts.question && facts.claude?.status === 'running') return 'question';
  if (atMenu(w.state) || w.unfinished?.kind === 'permission') return 'open';
  const { claude } = facts;
  if (!claude || claude.status === 'exited') return 'none';
  const waits = REPLY_STATES.includes(w.state) || (w.state === 'starting' && facts.atPrompt);
  const ready = claude.status === 'suspended' || (!claude.resuming && waits);
  if (!ready) return 'none';
  return facts.draft ? 'draft' : 'field';
}

/** A Board card's note over a draft (spec §6.7): it opens the workspace. */
export const DRAFT_NOTE = 'Has an unsent prompt; open it';

/**
 * Why text can't be typed into the workspace's Claude now (spec §6.7,
 * §6.15), for the main process's refusal of a quick reply or Send now; null
 * when it can. Each names its real reason.
 */
export function replyRefusal(
  w: Pick<Workspace, 'state' | 'unfinished'>,
  column: BoardColumn,
  facts: QuickReplyFacts,
): string | null {
  switch (quickReply(w, column, facts)) {
    case 'field':
      return null;
    case 'open':
      return 'Claude is asking for permission; answer it in the Claude tab';
    case 'question':
      return 'Claude is asking a question; pick an answer on the card or in the Claude tab';
    case 'draft':
      return "There may be text in Claude's prompt: send it or clear it with Ctrl+C";
  }
  const { claude } = facts;
  if (column === 'merged') return 'This workspace is merged';
  if (!claude || claude.status === 'exited') return "Claude isn't running in this workspace";
  if (claude.resuming) return 'Claude is resuming; try again in a moment';
  if (w.state === 'starting') return "Claude is starting and doesn't show its prompt yet";
  if (w.state === 'error') return 'Claude stopped with an error; look in the Claude tab';
  return "Claude isn't waiting for a message in this workspace";
}

/**
 * Why dropped or chosen files can't be added to Claude's prompt now (spec
 * §6.16); null when they can. The quick reply's facts, but the paths go in at
 * the cursor, so a draft doesn't stop them, nor does a merged workspace.
 */
export function insertRefusal(
  w: Pick<Workspace, 'state' | 'unfinished'>,
  facts: QuickReplyFacts,
): string | null {
  const asIf = { ...facts, draft: false };
  switch (quickReply(w, 'idle', asIf)) {
    case 'field':
      return null;
    case 'open':
      return 'Claude is asking for permission: answer it, then add the files';
    case 'question':
      return 'Claude is asking a question: answer it, then add the files';
  }
  return replyRefusal(w, 'idle', asIf);
}

/**
 * "Bash" from "Claude needs your permission to use Bash", else the message;
 * nothing for Claude Code's "Claude needs your permission" without a tool (its
 * question tool's notice, which the card shows as the question instead).
 */
export function permissionTool(message: string | null): string | null {
  if (!message || /^claude needs your permission\.?$/i.test(message.trim())) return null;
  return /permission to use (.+)$/i.exec(message)?.[1]?.trim() ?? message;
}

/** One line of a card's details, its kind for the popover's styling and the tests. */
export interface CardDetail {
  kind: 'linked' | 'branch' | 'state' | 'workflow' | 'memory' | 'active' | 'suspend';
  text: string;
}

/**
 * A card's details, behind its ⓘ (spec §6.7): its task, then what its card
 * leaves out: where it is linked in from (on a project's Board), its branch (on
 * Home; a project's Board shows it on the card), the whole of its state's
 * message, its workflow status (§13.5), memory (§6.14), last activity, and why
 * its Claude is or isn't suspended (§9.8).
 */
export function cardDetails(
  w: Workspace,
  o: {
    linkedFrom: string | null;
    branch: boolean;
    /** "1.2 GB · Claude 900 MB, other 300 MB" while a session runs. */
    memory: string | null;
    /** How long ago it was last active ("4m", "now"; ui/time `ago`). */
    active: string;
    suspended: boolean;
    /** `suspendClockNote`'s text, while it isn't suspended. */
    suspendNote: string | null;
  },
): { title: string; lines: CardDetail[] } {
  const lines: CardDetail[] = [];
  const add = (kind: CardDetail['kind'], text: string) => lines.push({ kind, text });
  if (o.linkedFrom) add('linked', `Linked in from ${o.linkedFrom}`);
  if (o.branch) add('branch', `Branch: ${w.branch}`);
  if (w.state === 'needs-permission' && w.stateMessage) add('state', w.stateMessage);
  else if (w.state === 'needs-input' && w.stateMessage) add('state', w.stateMessage);
  else if (w.unfinished) add('state', unfinishedTooltip(w.unfinished));
  const workflow = w.workflow?.label ?? w.workflow?.problem;
  if (workflow) add('workflow', `Workflow: ${workflow}`);
  if (o.memory) add('memory', `Memory: ${o.memory}`);
  if (o.active) add('active', o.active === 'now' ? 'Active just now' : `Active ${o.active} ago`);
  if (o.suspended) add('suspend', SUSPENDED_TOOLTIP);
  else if (o.suspendNote) add('suspend', o.suspendNote);
  return { title: `${w.task.id ? `${w.task.id} ` : ''}${w.task.title || w.name}`, lines };
}
