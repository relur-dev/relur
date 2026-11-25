import { mergeProgressText } from '@shared/merge';
import type { Workspace, WorkspaceRepo } from '@shared/workspaces';
import { useQueries } from '@tanstack/react-query';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton } from '../ui/controls';
import { mergeBlocked, useMerge, useMergeStatuses } from './MergeControls';
import { MergePrsButton } from './MergePrsDialog';

const repoInput = (workspaceId: string, repo: WorkspaceRepo) =>
  repo.primary ? { workspaceId } : { workspaceId, projectId: repo.projectId };

/**
 * The header's merge control (spec §6.2): in a linked workspace a split
 * button, **Merge all PRs** (§21.10) with ▾ › **Merge into bases (local)**;
 * in a single repository **Merge into <base>**. The local entry starts
 * Merge into the base (§14.4) for every repository, exactly as the Changes
 * panel's Merge n into their bases does: the same hook, the same main-process
 * flow, its published-branch question and its refusals.
 */
export function HeaderMerge({
  workspace,
  name,
  onOpenPrs,
}: {
  workspace: Workspace;
  name: (projectId: string) => string;
  onOpenPrs: () => void;
}) {
  const trpc = useTRPC();
  const merge = useMerge();
  const status = useMergeStatuses()(workspace.id);
  const states = useQueries({
    queries: workspace.repos.map((r) =>
      trpc.changes.state.queryOptions(repoInput(workspace.id, r), { refetchInterval: 15_000 }),
    ),
  });
  const linked = workspace.repos.length > 1;
  const mergeable = states.filter((q) => q.data?.mergeable).length;
  const waiting = status?.phase === 'waiting';
  const pending = merge.pending(workspace.id);
  const blocked = mergeBlocked(workspace);
  const primary = states[0]?.data;
  // Why there's nothing to merge, from the repository's own state (§14.4).
  const nothing = !primary
    ? 'Checking…'
    : primary.uncommitted > 0
      ? `Commit first: ${primary.uncommitted} uncommitted ${primary.uncommitted === 1 ? 'file' : 'files'}`
      : !primary.hasOwnCommits
        ? `Nothing to merge: ${workspace.branch} has no commits of its own`
        : `${workspace.branch} is merged into ${workspace.baseBranch} already`;
  const localReason =
    blocked ?? (waiting ? 'Claude is rebasing for the merge' : mergeable === 0 ? nothing : null);
  const localTitle = linked
    ? 'Fast-forwards each repository’s local base to the branch; never pushes'
    : `Fast-forwards your local ${workspace.baseBranch} to ${workspace.branch}; never pushes`;
  const error = merge.error(workspace.id);

  return (
    <span data-header-merge className="ml-3 inline-flex items-center gap-2 align-middle font-sans">
      {linked ? (
        <span className="inline-flex">
          <MergePrsButton workspace={workspace} name={name} onOpen={onOpenPrs} split />
          <button
            type="button"
            data-header-merge-menu
            className={`${button('secondary', 'sm')} -ml-px rounded-l-none px-1.5`}
            aria-label="More ways to merge"
            title="Merge into bases (local): fast-forward each local base; never pushes"
            onClick={() =>
              void trpcClient.ui.contextMenu
                .mutate({
                  items: [
                    {
                      id: 'local',
                      label: pending
                        ? 'Merging into bases…'
                        : waiting && status
                          ? mergeProgressText(status)
                          : 'Merge into bases (local)',
                      enabled: !pending && localReason === null,
                    },
                  ],
                })
                .then((choice) => {
                  if (choice === 'local') merge.start(workspace.id);
                })
            }
          >
            ▾
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-header-merge-local
          className={button('secondary', 'sm')}
          disabled={pending || localReason !== null}
          title={localReason ?? localTitle}
          onClick={() => merge.start(workspace.id)}
        >
          {pending
            ? 'Merging…'
            : waiting
              ? 'Rebasing for merge…'
              : `Merge into ${workspace.baseBranch}`}
        </button>
      )}
      {error ? (
        <span data-header-merge-error className="inline-flex items-center gap-1 text-xs">
          <span role="alert" className="text-st-error select-text">
            ✕ {error}
          </span>
          <button
            type="button"
            className={`${iconButton} size-4`}
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => merge.dismiss(workspace.id)}
          >
            ×
          </button>
        </span>
      ) : null}
      {merge.dialog}
    </span>
  );
}
