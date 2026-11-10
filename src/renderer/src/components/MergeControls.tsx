import { BRAND } from '@shared/brand';
import {
  type MergeResult,
  type MergeStatus,
  mergeProgressText,
  mergeStoppedText,
} from '@shared/merge';
import { atMenu } from '@shared/status';
import type { Workspace } from '@shared/workspaces';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTRPC } from '../trpc';
import { button, Kbd } from '../ui/controls';
import { Modal, ModalFooter } from './Modal';

/** Every workspace's merge (spec §14.4), kept fresh by App's subscription. */
export function useMergeStatuses(): (workspaceId: string) => MergeStatus | null {
  const trpc = useTRPC();
  const statuses = useQuery(trpc.changes.mergeStatuses.queryOptions());
  return (workspaceId) => statuses.data?.find((s) => s.workspaceId === workspaceId) ?? null;
}

/** Why Merge can't start now, from Claude's state; null when it can. */
export function mergeBlocked(w: Pick<Workspace, 'state'>): string | null {
  if (w.state === 'working') {
    return "Claude is working in this workspace: merge once it's done";
  }
  if (atMenu(w.state)) return 'Claude is waiting for an answer: answer it first';
  return null;
}

/** The published branch's question, while it is open. */
interface Ask {
  workspaceId: string;
  projectId: string | null;
  result: Extract<MergeResult, { kind: 'ask' }>;
}

/**
 * Merge into the base (spec §14.4) for the Changes panel and Home: starts a
 * merge, asks first for a published branch (Merge <base> into the branch,
 * the default, or Rebase anyway), and keeps each workspace's refusal.
 */
export function useMerge() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const setError = (id: string, message: string | null) =>
    setErrors((e) => (e[id] === message ? e : { ...e, [id]: message }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.changes.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.workspaces.list.queryKey() });
  };
  const merge = useMutation(trpc.changes.merge.mutationOptions({ onSettled: refresh }));
  const cancel = useMutation(trpc.changes.cancelMerge.mutationOptions({ onSettled: refresh }));
  const dismiss = useMutation(trpc.changes.dismissMerge.mutationOptions({ onSettled: refresh }));

  const run = (
    workspaceId: string,
    projectId: string | null,
    diverged: 'rebase' | 'merge' | null,
  ) => {
    setError(workspaceId, null);
    merge.mutate(
      { workspaceId, ...(projectId ? { projectId } : {}), diverged },
      {
        onSuccess: (result) => {
          if (result.kind === 'ask') setAsk({ workspaceId, projectId, result });
          else if (result.kind === 'stopped') setError(workspaceId, result.reason);
        },
        onError: (error) => setError(workspaceId, error.message),
      },
    );
  };

  // Its keys and clicks stay inside: the Board and the List take them otherwise.
  const dialog: ReactNode = ask ? (
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops events from leaving the dialog
    <div
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <PublishedDialog
        ask={ask.result}
        onClose={() => setAsk(null)}
        onChoose={(mode) => {
          setAsk(null);
          run(ask.workspaceId, ask.projectId, mode);
        }}
      />
    </div>
  ) : null;

  return {
    start: (workspaceId: string, projectId: string | null = null) =>
      run(workspaceId, projectId, null),
    cancel: (workspaceId: string) => cancel.mutate({ workspaceId }),
    dismiss: (workspaceId: string) => {
      setError(workspaceId, null);
      dismiss.mutate({ workspaceId });
    },
    pending: (workspaceId: string) =>
      merge.isPending && merge.variables?.workspaceId === workspaceId,
    error: (workspaceId: string) => errors[workspaceId] ?? null,
    dialog,
  };
}

export type MergeApi = ReturnType<typeof useMerge>;

/**
 * A published branch whose base moved on (spec §14.4): a rebase would need a
 * force-push, which the app never does, so it asks. Merging the base in is
 * the default.
 */
function PublishedDialog({
  ask,
  onClose,
  onChoose,
}: {
  ask: Extract<MergeResult, { kind: 'ask' }>;
  onClose: () => void;
  onChoose: (mode: 'rebase' | 'merge') => void;
}) {
  const remoteBranch = ask.published.split(',')[0] ?? ask.published;
  return (
    <Modal
      title={`Merge into ${ask.base}`}
      description={`${ask.branch} is published (${ask.published}), and ${ask.base} has moved on.`}
      onClose={onClose}
    >
      <form
        data-merge-ask
        onSubmit={(e) => {
          e.preventDefault();
          onChoose('merge');
        }}
      >
        <p className="text-md text-fg-muted">
          Rebasing it would need a force-push, which {BRAND.displayName} never does. Claude can
          merge {ask.base} into the branch instead, so its history and pull request stay as they
          are; then {ask.base} is fast-forwarded to it.
        </p>
        <p className="mt-2 text-sm text-fg-subtle">
          Rebase anyway leaves {remoteBranch} behind: force-push it yourself, or delete it.
        </p>
        <ModalFooter>
          <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button
            type="button"
            data-merge-choice="rebase"
            className={button('secondary', 'lg')}
            onClick={() => onChoose('rebase')}
          >
            Rebase anyway
          </button>
          <button
            type="submit"
            data-merge-choice="merge"
            data-autofocus
            className={button('primary', 'lg')}
          >
            Merge {ask.base} into the branch
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * The Changes panel's Merge row (spec §6.4, §14.4): Merge into <base> with
 * what it does, "Rebasing for merge…" with Cancel while Claude works, and the
 * outcome until dismissed. `projectId` merges one repository of a linked
 * workspace; null merges all of them.
 */
export function MergeRow({
  workspace,
  projectId,
  base,
  mergeable,
  status,
  api,
  label,
}: {
  workspace: Workspace;
  projectId: string | null;
  base: string;
  mergeable: boolean;
  status: MergeStatus | null;
  api: MergeApi;
  /** The button's text; "Merge into <base>" by default. */
  label?: string;
}) {
  const error = api.error(workspace.id);
  // A linked section shows its own repository's part of the merge.
  const mine = projectId ? status?.repos.find((r) => r.projectId === projectId) : null;
  const waiting = status?.phase === 'waiting' && (!projectId || mine?.phase === 'waiting');
  if (!mergeable && !status && !error) return null;
  if (projectId && status && !mine && !mergeable) return null;
  const blocked = mergeBlocked(workspace);
  const pending = api.pending(workspace.id);
  return (
    <div data-merge-row={projectId ?? 'all'} className="space-y-1 text-sm">
      {waiting ? (
        <div className="flex items-center gap-2">
          <span data-merge-progress className="text-fg">
            {status && !projectId ? mergeProgressText(status) : 'Rebasing for merge…'}
          </span>
          {!projectId || workspace.repos.length === 1 ? (
            <button
              type="button"
              data-merge-cancel
              className={button('ghost', 'sm')}
              title="Stop waiting for Claude; Claude goes on with its turn"
              onClick={() => api.cancel(workspace.id)}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : mergeable && !(status?.phase === 'done' && (!projectId || mine?.phase === 'merged')) ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            data-merge={projectId ?? 'all'}
            className={button('secondary', 'sm')}
            disabled={pending || !!blocked || status?.phase === 'waiting'}
            title={blocked ?? `Fast-forwards your local ${base} to ${workspace.branch}`}
            onClick={() => api.start(workspace.id, projectId)}
          >
            {pending ? 'Merging…' : (label ?? `Merge into ${base}`)}
          </button>
          {workspace.repos.length === 1 ? (
            <span className="text-fg-subtle">
              Fast-forwards your local {base}; Claude rebases first if {base} moved on. Never
              pushes.
            </span>
          ) : null}
        </div>
      ) : null}
      <MergeOutcome
        workspace={workspace}
        status={status}
        projectId={projectId}
        error={error}
        api={api}
      />
    </div>
  );
}

/** What the last merge did: ✓ merged, or why it stopped; × dismisses it. */
function MergeOutcome({
  workspace,
  status,
  projectId,
  error,
  api,
}: {
  workspace: Workspace;
  status: MergeStatus | null;
  projectId: string | null;
  error: string | null;
  api: MergeApi;
}) {
  const linkedSection = projectId && workspace.repos.length > 1;
  let line: { ok: boolean; text: string } | null = null;
  if (error && !linkedSection) line = { ok: false, text: error };
  else if (linkedSection && status) {
    const r = status.repos.find((x) => x.projectId === projectId);
    if (r?.phase === 'merged') line = { ok: true, text: `Merged into your local ${r.base}` };
    else if (r?.phase === 'failed' && r.reason) line = { ok: false, text: r.reason };
  } else if (status?.phase === 'done') {
    const merged = status.repos.filter((r) => r.phase === 'merged');
    line = {
      ok: true,
      text:
        merged.length === 1 && merged[0]
          ? `Merged into your local ${merged[0].base}`
          : `Merged ${merged.length} repositories into their local bases`,
    };
  } else if (status?.phase === 'stopped') {
    line = { ok: false, text: `Merge stopped: ${mergeStoppedText(status)}` };
  }
  if (!line) return null;
  return (
    <div className="flex items-start gap-1.5">
      <p
        data-merge-outcome={line.ok ? 'merged' : 'stopped'}
        role={line.ok ? undefined : 'alert'}
        className={`min-w-0 flex-1 whitespace-pre-wrap select-text ${
          line.ok ? 'text-fg-muted' : 'text-st-permission'
        }`}
      >
        {line.ok ? '✓' : '✕'} {line.text}
      </p>
      {!linkedSection ? (
        <button
          type="button"
          data-merge-dismiss
          aria-label="Dismiss"
          title="Dismiss"
          className="shrink-0 px-1 text-fg-subtle hover:text-fg"
          onClick={() => api.dismiss(workspace.id)}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
