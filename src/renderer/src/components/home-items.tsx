import {
  type HomeSection,
  mergedLabel,
  offersMerge,
  openPrsText,
  permissionTool,
  prNumber,
  prText,
  type RepoPr,
  readyToMergeText,
  type ShipState,
  shipCandidates,
  shipStep,
  waitsForPr,
  withoutPrText,
  workingFor,
} from '@shared/home';
import { describeSplit, formatBytes, type MemorySnapshot, workspaceMemory } from '@shared/memory';
import { mergeProgressText, mergeStoppedText } from '@shared/merge';
import type { Profile, Project } from '@shared/schemas';
import { backgroundNote, type StatusGlyph as Glyph } from '@shared/status';
import type { SessionInfo } from '@shared/terminal-protocol';
import { canContinue, planLimitReached, workspaceGlyph } from '@shared/unfinished';
import { type Workspace, workspaceMerged } from '@shared/workspaces';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { trpcClient, useTRPC } from '../trpc';
import { NotesIcon } from '../ui/icons';
import { useLaunching } from '../ui/launching';
import { type MergeApi, useMergeStatuses } from './MergeControls';
import { GateAnswer } from './WorkflowViews';

/** What the Board's cards and Home's quick actions do; the app opens views and dialogs. */
export interface HomeActions {
  /** Opens the workspace, on its Claude tab when it has one. */
  open: (workspace: Workspace) => void;
  /** The workspace's Claude tab with its Responses panel open at `entry` (spec §6.7). */
  responses: (workspace: Workspace, entry: number | null) => void;
  /** Review at a gate: the workspace with its spec view (spec §13.8). */
  review: (workspace: Workspace) => void;
  /** Commit…: the workspace with the Changes panel and its commit box in focus. */
  commit: (workspace: Workspace) => void;
  /** Push in a linked workspace: the workspace with its Changes panel (§21.5). */
  openChanges: (workspace: Workspace) => void;
  /** The Delete workspace dialog (spec §14.2). */
  delete: (workspace: Workspace) => void;
  /** Delete n merged workspaces: one dialog for all of them. */
  deleteMerged: (workspaces: Workspace[]) => void;
  /** Null without projects. */
  newWorkspace: (() => void) | null;
  /** New workspace in that project: a grouped Board band's + (spec §6.7). */
  newWorkspaceIn: (project: Project) => void;
  addProject: () => void;
}

/** A card's action button (components.md, Board). */
export type ActionKind = 'primary' | 'secondary' | 'ghost';

const ACTION: Record<ActionKind, string> = {
  primary: 'bg-fg text-on-fg font-medium enabled:hover:opacity-[0.86]',
  secondary: 'border border-line-strong text-fg enabled:hover:bg-raised',
  ghost: 'text-fg-muted enabled:hover:bg-band-strong enabled:hover:text-fg',
};

/** A card's 24px action on `raised`; focus a gap in `raised`, then the focus ring. */
export const actionClass = (kind: ActionKind) =>
  `inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-[9px] text-sm whitespace-nowrap outline-none focus-visible:shadow-[0_0_0_2px_var(--color-raised),0_0_0_3.5px_var(--color-focus)] focus-visible:outline-none disabled:opacity-40 ${ACTION[kind]}`;

export function Action({
  kind,
  title,
  onClick,
  disabled,
  data,
  children,
}: {
  kind: ActionKind;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** `data-home-action`, for tests and the e2e checks. */
  data?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-home-action={data}
      className={actionClass(kind)}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export const Sep = () => <span className="flex-none text-fg-subtle">·</span>;

/** The detail line's parts after the project. */
export type Part = {
  text: string;
  tone?: 'perm' | 'input' | 'appr' | 'strong' | 'cmd' | 'quiet';
  /** A tooltip for the part. */
  title?: string;
};

export const TONE: Record<NonNullable<Part['tone']>, string> = {
  perm: 'flex-none font-medium text-st-permission',
  input: 'flex-none font-medium text-st-input',
  appr: 'flex-none font-medium text-st-approval',
  strong: 'flex-none font-medium text-fg',
  cmd: 'min-w-0 truncate font-mono text-[11.5px] text-fg-muted',
  quiet: 'flex-none text-fg-subtle',
};

/**
 * Done with commands Claude left running, such as a dev server (spec §10.2):
 * a quiet "n running" that keeps the workspace where it is; null otherwise.
 */
export function runningMark(w: Pick<Workspace, 'state' | 'background'>): Part | null {
  const note = w.state === 'done' ? backgroundNote(w.state, w.background) : null;
  return note ? { text: `${w.background} running`, tone: 'quiet', title: note } : null;
}

/**
 * A workspace with unsent notes (spec §6.15): a small notes mark with their
 * count beside its title on a Board card; nothing without any.
 */
export function NotesMark({ w }: { w: Pick<Workspace, 'notes'> }): ReactNode {
  const counts = w.notes;
  if (!counts || counts.unsent === 0) return null;
  const title = `${counts.unsent} unsent ${counts.unsent === 1 ? 'note' : 'notes'}${
    counts.held > 0 ? `, ${counts.held} queued for when Claude is done` : ''
  }`;
  return (
    <span
      data-notes-mark={counts.unsent}
      role="img"
      title={title}
      aria-label={title}
      className="inline-flex flex-none items-center gap-0.5 self-center font-mono text-2xs text-fg-subtle"
    >
      <NotesIcon />
      {counts.unsent}
    </span>
  );
}

/** What a Board card shows for a workspace in a section. */
export interface HomeItem {
  glyph: Glyph | null;
  parts: Part[];
  /** Parts are separated by `·` each (Working now), else after one `·`. */
  dotted: boolean;
  /** The card's main actions. */
  buttons: ReactNode[];
  meta: { text: string; title: string } | null;
  title: 'bold' | 'muted' | null;
  error: string | null;
}

/**
 * What Done workspaces have left to ship, summed over their repositories:
 * read when Home shows, when one becomes Done, and every 15 seconds.
 */
export function useShipStates(workspaces: Workspace[]) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const candidates = shipCandidates(workspaces);
  const repoQueries = candidates.flatMap((w) =>
    w.repos.map((r) => ({
      workspaceId: w.id,
      input: r.primary ? { workspaceId: w.id } : { workspaceId: w.id, projectId: r.projectId },
    })),
  );
  const states = useQueries({
    queries: repoQueries.map((q) =>
      trpc.changes.state.queryOptions(q.input, {
        refetchInterval: 15_000,
        staleTime: 0,
        retry: false,
      }),
    ),
  });
  // A workspace that becomes Done is checked again at once.
  const doneKey = candidates.map((w) => `${w.id}@${w.stateSince ?? ''}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when a workspace becomes Done
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.changes.state.pathKey() });
  }, [doneKey]);
  return (workspaceId: string): ShipState | null => {
    const mine = repoQueries.flatMap((q, i) => (q.workspaceId === workspaceId ? [states[i]] : []));
    if (mine.length === 0 || mine.some((s) => !s?.data)) return null;
    return mine.reduce<ShipState>(
      (sum, s) => ({
        uncommitted: sum.uncommitted + (s?.data?.uncommitted ?? 0),
        unpushed: sum.unpushed + (s?.data?.unpushed ?? 0),
        withoutPr: sum.withoutPr + (s?.data && waitsForPr(s.data) ? 1 : 0),
        mergeable: sum.mergeable + (s?.data?.mergeable ? 1 : 0),
      }),
      { uncommitted: 0, unpushed: 0, withoutPr: 0, mergeable: 0 },
    );
  };
}

/** The time, every 30 seconds: "working for n min" moves on by itself. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * What a Board card shows in its section (spec §6.7): one short status line
 * and its main actions: a gate's Review and answer, Unfinished's
 * Continue (or Open) and Dismiss, Working's Open, Merged none (Delete is on
 * every card).
 */
export function useHomeItems({
  profile,
  projects,
  sessions,
  memory,
  actions,
  ship,
  now,
  merge,
}: {
  profile: Profile;
  projects: Project[];
  sessions: SessionInfo[];
  memory: MemorySnapshot | null;
  actions: HomeActions;
  ship: (workspaceId: string) => ShipState | null;
  now: number;
  /** Merge into the base (spec §14.4); its dialog is rendered by the caller. */
  merge: MergeApi;
}) {
  const mergeStatus = useMergeStatuses();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const launching = useLaunching();
  const usage = useQuery(trpc.usage.all.queryOptions());
  const limit = planLimitReached(usage.data?.[profile.id]);
  const proceed = useMutation(trpc.unfinished.continue.mutationOptions());
  const dismiss = useMutation(trpc.unfinished.dismiss.mutationOptions());
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.changes.pathKey() });
  const push = useMutation(trpc.changes.push.mutationOptions({ onSettled: refresh }));
  const createPr = useMutation(trpc.changes.createPr.mutationOptions({ onSettled: refresh }));
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  // View PR with several (spec §6.7, §21.5): a menu with each repository's.
  const viewPrs = async (prs: RepoPr[]) => {
    const urls = prs.filter((p) => p.pr.url);
    const only = urls.length === 1 ? urls[0]?.pr.url : null;
    if (only) return void trpcClient.shell.openExternal.mutate({ url: only });
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: urls.map((p) => ({
        id: p.projectId,
        label: `${projectName(p.projectId)} · ${prText(p.pr)} ↗`,
      })),
    });
    const url = urls.find((p) => p.projectId === choice)?.pr.url;
    if (url) void trpcClient.shell.openExternal.mutate({ url });
  };
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const setError = (id: string) => (message: string | null) =>
    setErrors((e) => (e[id] === message ? e : { ...e, [id]: message }));

  return (section: HomeSection, w: Workspace): HomeItem => {
    const parts: Part[] = [];
    const buttons: ReactNode[] = [];
    let glyph: Glyph | null = workspaceGlyph(w, launching.has(w.id));
    let meta: HomeItem['meta'] = null;
    let title: HomeItem['title'] = null;
    const merging = mergeStatus(w.id);
    const error =
      errors[w.id] ??
      merge.error(w.id) ??
      (merging?.phase === 'stopped' ? `Merge stopped: ${mergeStoppedText(merging)}` : null) ??
      (push.variables?.workspaceId === w.id ? push.error?.message : null) ??
      (createPr.variables?.workspaceId === w.id ? createPr.error?.message : null) ??
      (createPr.variables?.workspaceId === w.id &&
      createPr.data?.via === 'command' &&
      !createPr.data.result.ok
        ? createPr.data.result.message
        : null) ??
      null;
    const open = (
      <Action
        key="open"
        kind="secondary"
        data="open"
        title="Open the Claude tab"
        onClick={() => actions.open(w)}
      >
        Open
      </Action>
    );
    if (section === 'needs') {
      if (w.state === 'needs-permission') {
        parts.push({ text: 'Needs permission', tone: 'perm' });
        const what = permissionTool(w.stateMessage);
        if (what) parts.push({ text: what, tone: 'cmd' });
        buttons.push(open);
      } else if (w.state === 'needs-input') {
        parts.push({ text: 'Waiting for input', tone: 'input' });
        buttons.push(open);
      } else if (w.state === 'needs-answer') {
        // Claude Code's notice names no tool, so nothing follows (spec §10.2).
        parts.push({ text: 'Asked a question', tone: 'input' });
        buttons.push(open);
      } else if (w.state === 'awaiting-approval') {
        parts.push({ text: 'At' }, { text: w.workflow?.label ?? 'a gate', tone: 'appr' });
        const answers = !!w.workflow?.statuses[w.workflow.index]?.answer;
        if (w.workflow?.file) {
          buttons.push(
            <Action
              key="review"
              kind="secondary"
              data="review"
              title="Open the spec"
              onClick={() => actions.review(w)}
            >
              Review
            </Action>,
          );
        }
        if (w.workflow) {
          buttons.push(
            <GateAnswer
              key="answer"
              workspaceId={w.id}
              workflow={w.workflow}
              state={w.state}
              claudeRunning={sessions.some(
                (s) => s.workspaceId === w.id && s.kind === 'claude' && s.status !== 'exited',
              )}
              className={(primary) => actionClass(primary ? 'primary' : 'secondary')}
              onError={setError(w.id)}
            />,
          );
        }
        if (!w.workflow?.file && !answers) buttons.unshift(open);
      } else if (w.unfinished) {
        parts.push({ text: 'Unfinished', tone: 'strong' });
        buttons.push(
          canContinue(w.unfinished.kind) ? (
            <Action
              key="continue"
              kind="secondary"
              data="continue"
              disabled={!!limit || proceed.isPending}
              title={limit ?? 'Sends the continue prompt from Edit profile'}
              onClick={() => proceed.mutate({ workspaceIds: [w.id] })}
            >
              Continue
            </Action>
          ) : (
            open
          ),
        );
        buttons.push(
          <Action
            key="dismiss"
            kind="ghost"
            data="dismiss"
            title="Mark as finished"
            onClick={() => dismiss.mutate({ workspaceId: w.id })}
          >
            Dismiss
          </Action>,
        );
      }
    } else if (section === 'working') {
      glyph = 'working';
      // Claude rebases for a merge (spec §14.4): said first, with Cancel.
      if (merging?.phase === 'waiting') {
        parts.push({ text: mergeProgressText(merging), tone: 'strong' });
        buttons.push(
          <Action
            key="cancel-merge"
            kind="ghost"
            data="cancel-merge"
            title="Stop waiting for Claude; Claude goes on with its turn"
            onClick={() => merge.cancel(w.id)}
          >
            Cancel
          </Action>,
        );
      }
      parts.push({ text: workingFor(w.stateSince, now) });
      const background = backgroundNote(w.state, w.background);
      if (background) parts.push({ text: background });
      const used = workspaceMemory(memory, w.id);
      if (used) meta = { text: formatBytes(used.total), title: describeSplit(used) };
      buttons.push(
        <Action
          key="open"
          kind="secondary"
          data="open"
          title="Open the workspace"
          onClick={() => actions.open(w)}
        >
          Open
        </Action>,
      );
    } else if (section === 'ship') {
      glyph = 'done';
      title = 'bold';
      const state = ship(w.id);
      const step = shipStep(w, state);
      const linked = w.repos.length > 1;
      const mergeButton = (kind: ActionKind) => (
        <Action
          key="merge"
          kind={kind}
          data="merge"
          disabled={merge.pending(w.id) || merging?.phase === 'waiting'}
          title={
            linked
              ? 'Fast-forwards each repository’s local base to the branch; never pushes'
              : `Fast-forwards your local ${w.baseBranch} to ${w.branch}; never pushes`
          }
          onClick={() => merge.start(w.id)}
        >
          {merge.pending(w.id)
            ? 'Merging…'
            : linked
              ? 'Merge into bases'
              : `Merge into ${w.baseBranch}`}
        </Action>
      );
      if (step?.kind === 'merge') {
        parts.push({ text: readyToMergeText(step.repos, w.baseBranch, linked) });
        buttons.push(mergeButton('secondary'));
      } else if (step?.kind === 'commit') {
        parts.push({ text: `${step.files} ${step.files === 1 ? 'file' : 'files'} not committed` });
        buttons.push(
          <Action
            key="commit"
            kind="secondary"
            data="commit"
            title={`Review and commit ${step.files} ${step.files === 1 ? 'file' : 'files'}`}
            onClick={() => actions.commit(w)}
          >
            Commit…
          </Action>,
        );
      } else if (step?.kind === 'push') {
        const pushing = push.isPending && push.variables?.workspaceId === w.id;
        parts.push({
          text: `${step.commits} ${step.commits === 1 ? 'commit' : 'commits'} not pushed`,
        });
        buttons.push(
          <Action
            key="push"
            kind="secondary"
            data="push"
            disabled={pushing}
            title={
              linked ? 'Push in the Changes panel, repository by repository' : `Push ${w.branch}`
            }
            onClick={() => (linked ? actions.openChanges(w) : push.mutate({ workspaceId: w.id }))}
          >
            {pushing ? 'Pushing…' : 'Push'}
          </Action>,
        );
      } else if (step?.kind === 'create') {
        // Spec §6.7: only where a PR command is set; a linked workspace goes to Changes (§21.5).

        const creating = createPr.isPending && createPr.variables?.workspaceId === w.id;
        parts.push({ text: withoutPrText(step.repos, linked) });
        buttons.push(
          <Action
            key="create-pr"
            kind="secondary"
            data="create-pr"
            disabled={creating}
            title={
              linked
                ? 'Create PRs in the Changes panel, one in every repository with commits'
                : `Open a pull request for ${w.branch}`
            }
            onClick={() =>
              linked ? actions.openChanges(w) : createPr.mutate({ workspaceId: w.id })
            }
          >
            {creating ? 'Creating…' : linked ? 'Create PRs…' : 'Create PR'}
          </Action>,
        );
      } else if (step?.kind === 'pr') {
        parts.push({ text: openPrsText(step.prs) });
        const withUrl = step.prs.filter((p) => p.pr.url);
        const [first] = withUrl;
        if (first) {
          const several = withUrl.length > 1;
          buttons.push(
            <Action
              key="pr"
              kind="secondary"
              data="pr"
              title={
                several
                  ? `Choose one of ${withUrl.length} pull requests to open in the browser`
                  : `Open ${prNumber(first.pr) ? `PR ${prNumber(first.pr)}` : 'the pull request'} in the browser`
              }
              onClick={() => void viewPrs(step.prs)}
            >
              View PR{several ? 's' : ''} <span aria-hidden>{several ? '▾' : '↗'}</span>
            </Action>,
          );
        }
      }
      // Beside the main action once everything is committed (spec §6.7, §14.4).
      if (step && step.kind !== 'merge' && offersMerge(state)) buttons.push(mergeButton('ghost'));
    } else {
      glyph = 'exited';
      title = 'muted';
      const merged = workspaceMerged(w);
      parts.push({ text: merged ? mergedLabel(merged) : 'Merged' });
    }
    // Ready to ship and Clean up keep a Done workspace whose dev server still runs.
    const mark = section === 'ship' || section === 'clean' ? runningMark(w) : null;
    if (mark) parts.push(mark);
    return {
      glyph,
      parts,
      dotted: section === 'working',
      buttons,
      meta,
      title,
      error,
    };
  };
}
