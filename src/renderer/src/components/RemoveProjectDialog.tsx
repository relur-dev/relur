import { BRAND } from '@shared/brand';
import { projectWorktreeDir } from '@shared/projects';
import type { Profile, Project } from '@shared/schemas';
import { glyphFor } from '@shared/status';
import {
  branchChoice,
  hasWork,
  needsForce,
  type RepoDeleteCheck,
  type WorkspaceDeleteCheck,
} from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../trpc';
import { button, Kbd } from '../ui/controls';
import { StatusGlyph } from '../ui/StatusGlyph';
import {
  CheckedOutWarning,
  plural,
  RepoCard,
  repoChoice,
  SubmoduleWarnings,
  TrackedBranch,
  Warning,
} from './DeleteWorkspaceDialog';
import { Modal, ModalFooter } from './Modal';

/** The main repository's part of a workspace's delete check. */
const mainCheck = (c: WorkspaceDeleteCheck) =>
  c.repos.find((r) => r.primary) ?? (c.repos[0] as RepoDeleteCheck);

/**
 * Remove project (spec §14.3). Without workspaces only the app's entry goes.
 * With workspaces, they are listed with Delete workspace's checks and deleted
 * with their worktrees after confirmation; a branch with unpushed commits is
 * kept unless its box is ticked. The main checkout is never touched. Where
 * the project is linked into other projects' workspaces, only its worktrees
 * there go; those workspaces stay (spec §21.6).
 */
export function RemoveProjectDialog({
  project,
  profile,
  projects = [],
  onClose,
  onRemoved,
}: {
  project: Project;
  profile: Profile;
  /** Every project, for the names of linked repositories and main projects. */
  projects?: Project[];
  onClose: () => void;
  /** Teardown failures don't stop the removal; they are shown afterwards (spec §8.3). */
  onRemoved: (result: { teardownFailures: string[] }) => void;
}) {
  const trpc = useTRPC();
  const check = useQuery(
    trpc.projects.removalCheck.queryOptions({ projectId: project.id }, { staleTime: 0 }),
  );
  const remove = useMutation(trpc.projects.remove.mutationOptions({ onSuccess: onRemoved }));
  // Workspaces whose local branch (with unpushed commits) should go too.
  // Undefined until ticked or unticked: the checkbox's default (spec §14.2, §7.6).
  const [deleteBranch, setDeleteBranch] = useState<Record<string, boolean | undefined>>({});
  // A removal that a worktree refused (spec §14.3) can be forced after confirming.
  const [refused, setRefused] = useState(false);
  const data = check.data;
  const workspaces = data?.workspaces ?? [];
  const linked = data?.linked ?? [];
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const remoteOf = (id: string) => projects.find((p) => p.id === id)?.remote ?? null;
  const warnings =
    workspaces.some(({ check: c }) => c.repos.some(hasWork)) ||
    linked.some(({ check: c }) => hasWork(c)) ||
    (data?.runningSessions ?? 0) > 0 ||
    refused;
  const error = check.error ?? remove.error;

  return (
    <Modal
      title={`Remove ${project.name} from ${profile.name}?`}
      description={
        linked.length > 0 && workspaces.length === 0 ? (
          <>
            It is linked into {plural(linked.length, 'workspace')} of other projects. Its{' '}
            {linked.length === 1 ? 'worktree there is' : 'worktrees there are'} deleted; those
            workspaces stay in their main project with their other repositories, and Claude restarts
            without {project.name}. The repository itself isn't touched.
          </>
        ) : workspaces.length > 0 ? (
          <>
            Deletes {plural(workspaces.length, 'workspace')} with{' '}
            {workspaces.length === 1 ? 'its worktree' : 'their worktrees'}, then removes the project
            from {BRAND.displayName}. The repository itself isn't touched.
          </>
        ) : (
          <>
            {BRAND.displayName} stops tracking this project. Nothing is deleted on disk, and you can
            add the project back any time.
          </>
        )
      }
      onClose={onClose}
    >
      <form
        className="text-md"
        onSubmit={(event) => {
          event.preventDefault();
          remove.mutate(
            {
              projectId: project.id,
              workspaces: workspaces.map(({ workspace, check: c }) => ({
                workspaceId: workspace.id,
                force: needsForce(c) || refused,
                deleteBranch: repoChoice(mainCheck(c), deleteBranch[workspace.id], refused)
                  .deleteBranch,
                repos: c.repos.map((r) =>
                  repoChoice(
                    r,
                    deleteBranch[r.primary ? workspace.id : `${workspace.id}:${r.projectId}`],
                    refused,
                  ),
                ),
              })),
              linked: linked.map(({ workspace, check: c }) => ({
                workspaceId: workspace.id,
                ...repoChoice(c, deleteBranch[`linked:${workspace.id}`], refused),
              })),
            },
            { onError: () => setRefused(true) },
          );
        }}
      >
        <div className="rounded-lg border border-line bg-surface px-3 py-2.5 font-mono text-sm leading-relaxed select-text">
          <div>{project.repoPath}</div>
          <div className="text-fg-muted">{projectWorktreeDir(profile, project)}/</div>
        </div>
        {check.isPending ? (
          <p className="mt-3 text-sm text-fg-subtle">Checking the worktrees…</p>
        ) : null}

        {workspaces.length > 0 ? (
          <ul
            data-removal-workspaces
            className="mt-3 flex max-h-[320px] flex-col gap-2 overflow-y-auto"
          >
            {workspaces.map(({ workspace, check: c }) => {
              const shown = c.uncommitted.slice(0, 8);
              const main = mainCheck(c);
              const mainBox = branchChoice(main);
              return (
                <li key={workspace.id} className="rounded-lg border border-line">
                  <div className="px-3 py-2">
                    <div className="font-medium">{workspace.name}</div>
                    <div className="truncate font-mono text-xs text-fg-muted">
                      {workspace.worktreePath}
                    </div>
                    {c.worktreeMissing ? (
                      <div className="text-xs text-fg-subtle">
                        The worktree folder is already gone.
                      </div>
                    ) : null}
                  </div>
                  {hasWork(c) || c.checkedOut ? (
                    <div className="divide-y divide-st-permission/30 border-t border-st-permission/40 bg-st-permission/8">
                      {c.uncommitted.length > 0 ? (
                        <Warning title={plural(c.uncommitted.length, 'uncommitted change')}>
                          {shown.join(' · ')}
                          {c.uncommitted.length > shown.length
                            ? ` · ${c.uncommitted.length - shown.length} more`
                            : ''}
                        </Warning>
                      ) : null}
                      {c.unpushed > 0 ? (
                        <Warning title={`${plural(c.unpushed, 'commit')} not pushed`}>
                          {project.remote
                            ? `${workspace.branch} has commits that aren't on ${project.remote}`
                            : `${workspace.branch} has commits that aren't on any other branch`}
                        </Warning>
                      ) : null}
                      <SubmoduleWarnings submodules={c.submodules} />
                      <CheckedOutWarning
                        name={project.name}
                        checkedOut={c.checkedOut}
                        branch={workspace.branch}
                        remote={project.remote}
                      />
                    </div>
                  ) : null}
                  <TrackedBranch check={main} branch={workspace.branch} className="m-2" />
                  {mainBox.shown ? (
                    <label className="flex items-center gap-2 border-t border-line px-3 py-2 text-md">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-fg"
                        checked={deleteBranch[workspace.id] ?? mainBox.ticked}
                        onChange={(e) =>
                          setDeleteBranch((d) => ({ ...d, [workspace.id]: e.target.checked }))
                        }
                      />
                      Also delete the local branch{' '}
                      <span className="font-mono">{workspace.branch}</span>
                    </label>
                  ) : null}
                  {c.repos.length > 1 ? (
                    <div className="space-y-2 border-t border-line p-2">
                      {c.repos
                        .filter((r) => !r.primary)
                        .map((r) => {
                          const key = `${workspace.id}:${r.projectId}`;
                          return (
                            <RepoCard
                              key={r.projectId}
                              name={name(r.projectId)}
                              check={r}
                              branch={workspace.branch}
                              base={
                                workspace.repos.find((x) => x.projectId === r.projectId)
                                  ?.baseBranch ?? workspace.baseBranch
                              }
                              remote={remoteOf(r.projectId)}
                              alsoDeleteBranch={deleteBranch[key]}
                              onAlsoDeleteBranch={(value) =>
                                setDeleteBranch((d) => ({ ...d, [key]: value }))
                              }
                            />
                          );
                        })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {linked.length > 0 ? (
          <ul
            data-removal-linked
            className="mt-3 flex max-h-[240px] flex-col gap-2 overflow-y-auto"
          >
            {linked.map(({ workspace, check: c }) => {
              const glyph = glyphFor(workspace.state, workspace.unread, false);
              const dirty = needsForce(c);
              const key = `linked:${workspace.id}`;
              return (
                <li key={workspace.id} className="rounded-lg border border-line px-3 py-2">
                  <div className="flex items-center gap-2">
                    {glyph ? <StatusGlyph glyph={glyph} /> : <span className="size-3" />}
                    {workspace.task.id ? (
                      <span className="font-mono text-sm">{workspace.task.id}</span>
                    ) : null}
                    <span className="min-w-0 truncate">
                      {workspace.task.title || workspace.name}
                    </span>
                    <span className="shrink-0 text-fg-subtle">
                      · in {name(workspace.projectId)}
                    </span>
                    <span className="flex-1" />
                    <span
                      className={`shrink-0 text-sm ${dirty ? 'text-st-permission' : 'text-fg-muted'}`}
                    >
                      {c.submodules.length > 0
                        ? 'Changes in a submodule'
                        : dirty
                          ? 'Uncommitted changes'
                          : 'No uncommitted changes'}
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs text-fg-muted">
                    Deleted {c.worktreePath}
                  </div>
                  {c.checkedOut ? (
                    <div className="mt-1.5 rounded-md border border-st-permission/50 bg-st-permission/8">
                      <CheckedOutWarning
                        name={project.name}
                        checkedOut={c.checkedOut}
                        branch={workspace.branch}
                        remote={project.remote}
                      />
                    </div>
                  ) : null}
                  {branchChoice(c).shown ? (
                    <label className="mt-1.5 flex items-center gap-2 text-md">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-fg"
                        checked={deleteBranch[key] ?? branchChoice(c).ticked}
                        onChange={(e) =>
                          setDeleteBranch((d) => ({ ...d, [key]: e.target.checked }))
                        }
                      />
                      Also delete the local branch{' '}
                      <span className="font-mono">{workspace.branch}</span>
                      {c.unpushed > 0 ? (
                        <span className="text-fg-subtle">
                          ({plural(c.unpushed, 'commit')} not pushed)
                        </span>
                      ) : null}
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {(data?.runningSessions ?? 0) > 0 ? (
          <div className="mt-3 rounded-lg border border-st-permission/50 bg-st-permission/8">
            <Warning
              title={`${plural(data?.runningSessions ?? 0, 'running session')} will be stopped`}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-st-error select-text">
            ✕ {error.message}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            data-autofocus
            className={button('secondary', 'lg')}
            onClick={onClose}
          >
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button
            type="submit"
            className={button(
              workspaces.length > 0 || linked.length > 0 || warnings ? 'danger' : 'secondary',
              'lg',
            )}
            disabled={!data || remove.isPending}
          >
            {remove.isPending
              ? 'Removing…'
              : workspaces.length > 0
                ? warnings
                  ? 'Delete anyway and remove'
                  : 'Delete and remove'
                : linked.length > 0
                  ? refused
                    ? 'Delete anyway and remove'
                    : `Remove and delete ${plural(linked.length, 'worktree')}`
                  : `Remove from ${profile.name}`}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
