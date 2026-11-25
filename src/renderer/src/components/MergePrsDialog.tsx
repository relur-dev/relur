import {
  canMerge,
  MERGE_METHOD_LABEL,
  type MergePrsConfirmation,
  type MergePrsRun,
  mergeAllPrsBlocked,
  NO_UNDO_TEXT,
  type RepoMergeResult,
  type RepoPreflight,
  reportSummary,
} from '@shared/merge-prs';
import type { MergeMethod } from '@shared/schemas';
import type { Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton, Kbd, keyHint } from '../ui/controls';
import { PrimaryTag, Warning } from './DeleteWorkspaceDialog';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/** A bridge merge of the workspace waiting for its click, or expired (spec §21.10). */
export function useMergePrsConfirmation(workspaceId: string): MergePrsConfirmation | null {
  const trpc = useTRPC();
  const all = useQuery(trpc.changes.mergePrsConfirmations.queryOptions());
  return all.data?.find((c) => c.workspaceId === workspaceId) ?? null;
}

/** A workspace's Merge all PRs run (spec §21.10), kept fresh by App's subscription. */
export function useMergePrsRun(workspaceId: string): MergePrsRun | null {
  const trpc = useTRPC();
  const runs = useQuery(trpc.changes.mergePrsRuns.queryOptions());
  return runs.data?.find((r) => r.workspaceId === workspaceId) ?? null;
}

/**
 * The header's Merge all PRs (spec §6.2, §21.10), in a linked workspace:
 * enabled once every repository has a pull request (or one merged already);
 * while merging it shows the progress and opens the dialog again.
 */
export function MergePrsButton({
  workspace,
  name,
  onOpen,
}: {
  workspace: Workspace;
  name: (projectId: string) => string;
  onOpen: () => void;
}) {
  const run = useMergePrsRun(workspace.id);
  const blocked = mergeAllPrsBlocked(
    workspace.repos.map((r) => ({ name: name(r.projectId), pr: r.pr })),
  );
  const merged = run?.report?.repos.filter((r) => r.outcome !== 'skipped').length ?? 0;
  return (
    <button
      type="button"
      data-merge-prs-button
      className={`ml-3 align-middle font-sans ${button('secondary', 'sm')}`}
      disabled={!run?.running && blocked !== null}
      title={
        run?.running
          ? 'Merging the pull requests one by one'
          : (blocked ??
            "Merge every repository's pull request into its base, one after another, in an order you choose")
      }
      onClick={onOpen}
    >
      {run?.running ? `Merging PRs… ${merged} of ${run.order.length}` : 'Merge all PRs'}
    </button>
  );
}

const openUrl = (url: string) => void trpcClient.shell.openExternal.mutate({ url });

function PrLink({ url, label = 'PR' }: { url: string | null; label?: string }) {
  if (!url) return <span className="text-xs text-fg-subtle">No PR link</span>;
  return (
    <button
      type="button"
      title={url}
      className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
      onClick={() => openUrl(url)}
    >
      {label} ↗
    </button>
  );
}

/** A row's result once merging started: from the run's report, or waiting. */
function Outcome({ result, current }: { result: RepoMergeResult | null; current: boolean }) {
  if (current) return <span className="text-sm text-fg-muted">Merging…</span>;
  if (!result) return <span className="text-sm text-fg-subtle">Waiting</span>;
  switch (result.outcome) {
    case 'merged':
      return (
        <span className="text-sm text-st-approval">
          ✓ Merged
          {result.method ? ` · ${MERGE_METHOD_LABEL[result.method]}` : ''}
          {result.commitUrl || result.commit ? (
            <>
              {' · '}
              {result.commitUrl ? (
                <PrLink url={result.commitUrl} label={(result.commit ?? 'commit').slice(0, 9)} />
              ) : (
                <span className="font-mono">{result.commit?.slice(0, 9)}</span>
              )}
            </>
          ) : null}
          {result.warning ? (
            <span data-merge-warning className="block text-st-permission select-text">
              ⚠ {result.warning}
            </span>
          ) : null}
          {result.branchDeleted === false ? (
            <span className="block text-st-permission">
              Couldn't delete the remote branch: {result.deleteError}
            </span>
          ) : null}
        </span>
      );
    case 'already-merged':
      return <span className="text-sm text-st-approval">✓ Merged already</span>;
    case 'failed':
      return <span className="text-sm text-st-error">✕ {result.reason}</span>;
    case 'skipped':
      return <span className="text-sm text-fg-subtle">– Skipped</span>;
  }
}

/**
 * Merge all PRs (spec §21.10; design: components.md, Merge all PRs dialog):
 * every repository's pull request checked at once, one row each in the order
 * they will merge (↑↓ to reorder), its method, Delete remote branch after
 * merge, then the merges one by one with the report. Merge is disabled while
 * any row fails; Re-check runs the checks again. Opened for a merge asked
 * for over the bridge, it is that request's confirmation: it starts with
 * its order and methods, says who asked, and closing it cancels the request.
 */
export function MergePrsDialog({
  workspace,
  onClose,
  onDelete,
}: {
  workspace: Workspace;
  onClose: () => void;
  /** Delete workspace…, offered once every pull request is merged. */
  onDelete: () => void;
}) {
  const trpc = useTRPC();
  const run = useMergePrsRun(workspace.id);
  const preflight = useMutation(trpc.changes.mergePrsPreflight.mutationOptions());
  const merge = useMutation(trpc.changes.mergePrs.mutationOptions());
  const dismiss = useMutation(trpc.changes.dismissMergePrs.mutationOptions());
  const confirmMerge = useMutation(trpc.changes.confirmMergePrs.mutationOptions());
  const cancelRequest = useMutation(trpc.changes.cancelMergePrsConfirmation.mutationOptions());
  // The bridge request this dialog was opened for, if any, taken once.
  const confirmation = useMergePrsConfirmation(workspace.id);
  const [confirmId] = useState(confirmation?.state === 'pending' ? confirmation.id : null);
  const asking = confirmId && confirmation?.id === confirmId ? confirmation : null;
  const expired = asking?.state === 'expired';
  const [order, setOrder] = useState<string[]>(asking?.order ?? []);
  const [methods, setMethods] = useState<Record<string, MergeMethod>>(asking?.methods ?? {});
  const [deleteBranch, setDeleteBranch] = useState(asking?.deleteBranch ?? true);

  const recheck = () =>
    preflight.mutate(
      { workspaceId: workspace.id },
      {
        onSuccess: (p) => {
          // Keep the user's order; new repositories go last.
          setOrder((old) => [
            ...old.filter((id) => p.repos.some((r) => r.projectId === id)),
            ...p.repos.map((r) => r.projectId).filter((id) => !old.includes(id)),
          ]);
        },
      },
    );
  // Checked on opening; a run in progress (from the command line, say) shows as it goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the dialog opens
  useEffect(() => {
    if (run?.report && !run.running) dismiss.mutate({ workspaceId: workspace.id });
    recheck();
  }, []);

  const rows = new Map((preflight.data?.repos ?? []).map((r) => [r.projectId, r]));
  const started =
    merge.isPending ||
    merge.isSuccess ||
    confirmMerge.isPending ||
    confirmMerge.isSuccess ||
    Boolean(run?.running);
  const shownOrder = started && run ? run.order : order;
  const ordered = shownOrder.flatMap((id) => {
    const row = rows.get(id);
    return row ? [row] : [];
  });
  const results = new Map((run?.report?.repos ?? []).map((r) => [r.projectId, r]));
  const done = started && run && !run.running && run.report ? run.report : null;
  const ready = ordered.filter((r) => r.result === 'ready').length;
  const mergeable = canMerge(ordered) && !preflight.isPending && !expired;
  // Closing a request's dialog without Merge cancels it; the command line is told.
  const close = () => {
    if (confirmId && !started) cancelRequest.mutate({ workspaceId: workspace.id, id: confirmId });
    onClose();
  };

  const move = (index: number, by: -1 | 1) =>
    setOrder((o) => {
      const next = [...o];
      const [item] = next.splice(index, 1);
      if (item === undefined) return o;
      next.splice(index + by, 0, item);
      return next;
    });
  const methodOf = (r: RepoPreflight) => methods[r.projectId] ?? r.method;

  const submit = () => {
    if (done) {
      onClose();
      return;
    }
    if (!mergeable || started) return;
    const chosen: Record<string, MergeMethod> = {};
    for (const r of ordered) {
      const m = methodOf(r);
      if (m && r.result === 'ready') chosen[r.projectId] = m;
    }
    if (confirmId) {
      confirmMerge.mutate({
        workspaceId: workspace.id,
        id: confirmId,
        order,
        methods: chosen,
        deleteBranch,
      });
    } else merge.mutate({ workspaceId: workspace.id, order, methods: chosen, deleteBranch });
  };

  return (
    <Modal
      title="Merge all PRs"
      description={
        <>
          Merges the pull request of <span className="font-mono">{workspace.branch}</span> in each
          repository into its base, on the host.
        </>
      }
      onClose={close}
      wide
    >
      <form
        data-merge-prs
        className={`${modalForm} text-md`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ModalBody className="space-y-3">
          {confirmId ? (
            <p data-merge-requested-by className="text-sm text-fg-muted">
              {asking?.requestedBy ?? 'Requested from the command line'}. Nothing merges until you
              press Merge here.
            </p>
          ) : null}
          {expired && !started ? (
            <p data-merge-expired role="alert" className="text-sm text-st-error">
              This request expired: the command line stopped waiting after 10 minutes. Nothing was
              merged; run it again to merge.
            </p>
          ) : null}
          {preflight.isPending && !preflight.data ? (
            <p className="text-sm text-fg-muted">Checking every repository…</p>
          ) : null}
          <ol className="flex flex-col gap-px overflow-hidden rounded-md border border-line bg-line">
            {ordered.map((r, i) => (
              <li
                key={r.projectId}
                data-merge-row={r.projectId}
                data-merge-result={
                  started ? (results.get(r.projectId)?.outcome ?? 'waiting') : r.result
                }
                className="flex items-start gap-2.5 bg-raised px-2.5 py-2"
              >
                <span className="w-4 pt-0.5 text-right font-mono text-sm text-fg-subtle">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm">{r.name}</span>
                    {r.primary ? <PrimaryTag /> : null}
                    <span className="truncate font-mono text-xs text-fg-subtle">
                      {r.branch} → {r.baseBranch}
                    </span>
                    <PrLink url={r.prUrl} />
                  </span>
                  {started ? (
                    <Outcome
                      result={results.get(r.projectId) ?? null}
                      current={run?.current === r.projectId}
                    />
                  ) : r.result === 'failed' ? (
                    <ul data-merge-problems className="text-sm text-st-error select-text">
                      {r.problems.map((p) => (
                        <li key={p}>✕ {p}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="block text-sm text-st-approval">
                      {r.result === 'merged' ? '✓ Merged already: skipped' : '✓ Ready to merge'}
                    </span>
                  )}
                </span>
                {!started && r.result !== 'merged' && r.methods.length > 0 ? (
                  <select
                    aria-label={`Merge method for ${r.name}`}
                    className="h-6 rounded-md border border-line-strong bg-term px-1.5 text-sm"
                    value={methodOf(r) ?? ''}
                    onChange={(e) =>
                      setMethods((m) => ({ ...m, [r.projectId]: e.target.value as MergeMethod }))
                    }
                  >
                    {r.methods.map((m) => (
                      <option key={m} value={m}>
                        {MERGE_METHOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                ) : null}
                {started ? null : (
                  <span className="flex">
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${r.name} up`}
                      title="Merge earlier"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move ${r.name} down`}
                      title="Merge later"
                      disabled={i === ordered.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>

          {done ? (
            <p
              data-merge-summary
              role={done.stopped ? 'alert' : undefined}
              className={`text-sm select-text ${done.stopped ? 'text-st-error' : 'text-st-approval'}`}
            >
              {reportSummary(done)}
              {done.stopped && done.repos.some((r) => r.outcome === 'merged')
                ? '. The pull requests merged before it stay merged.'
                : ''}
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  disabled={started}
                  onChange={(e) => setDeleteBranch(e.target.checked)}
                />
                Delete remote branch after merge
              </label>
              <div
                data-no-undo
                className="rounded-lg border border-st-permission/50 bg-st-permission/8"
              >
                <Warning title="Merges can't be undone here">{NO_UNDO_TEXT}</Warning>
              </div>
            </>
          )}
          {preflight.error || merge.error || confirmMerge.error ? (
            <p role="alert" className="text-sm text-st-error select-text">
              ✕ {(preflight.error ?? merge.error ?? confirmMerge.error)?.message}
            </p>
          ) : null}
          <p className="flex items-center gap-1.5 text-sm text-fg-subtle">
            <GuideLink
              to="tasks-across-repositories#merging-every-pull-request"
              label="Tasks across repositories"
              before={close}
            />
            How Merge all PRs works
          </p>
        </ModalBody>
        <ModalFooter>
          {done ? (
            <>
              {!done.stopped ? (
                <button
                  type="button"
                  className={button('secondary', 'lg')}
                  onClick={() => {
                    onClose();
                    onDelete();
                  }}
                >
                  Delete workspace…
                </button>
              ) : null}
              <button type="submit" data-autofocus className={button('primary', 'lg')}>
                Close <Kbd onFg>{keyHint('confirm')}</Kbd>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-merge-cancel
                className={button('ghost', 'lg')}
                onClick={close}
              >
                {started ? 'Hide' : expired ? 'Close' : 'Cancel'} <Kbd>Esc</Kbd>
              </button>
              <button
                type="button"
                data-merge-recheck
                className={button('secondary', 'lg')}
                disabled={preflight.isPending || started || expired}
                onClick={recheck}
              >
                {preflight.isPending ? 'Checking…' : 'Re-check'}
              </button>
              <button
                type="submit"
                data-autofocus
                data-merge-submit
                className={button('primary', 'lg')}
                disabled={!mergeable || started}
              >
                {started ? 'Merging…' : `Merge ${ready} PR${ready === 1 ? '' : 's'}`}{' '}
                <Kbd onFg>{keyHint('confirm')}</Kbd>
              </button>
            </>
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
}
