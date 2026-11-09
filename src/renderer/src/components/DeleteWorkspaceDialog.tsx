import type { Project } from '@shared/schemas';
import {
  branchChoice,
  hasWork,
  mergedText,
  needsForce,
  type RepoDeleteCheck,
  type SubmoduleWork,
  type Workspace,
  type WorktreeCheckout,
} from '@shared/workspaces';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, Kbd } from '../ui/controls';
import { Modal, ModalFooter } from './Modal';

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Warning({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 px-3 py-2.5">
      <span className="mt-[3px] inline-block h-[10px] w-[11px] shrink-0 bg-st-permission [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
      <div className="min-w-0">
        <div className="font-semibold text-fg">{title}</div>
        {children ? (
          <div className="mt-0.5 font-mono text-xs break-words text-fg-muted select-text">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One amber block per submodule with work of its own (spec §14.2): its git
 * folder is inside the worktree's, so that work goes with the worktree.
 */
export function SubmoduleWarnings({ submodules }: { submodules: SubmoduleWork[] }) {
  return (
    <>
      {submodules.map((sub) => {
        const shown = sub.uncommitted.slice(0, 6);
        const parts = [
          sub.uncommitted.length > 0 ? plural(sub.uncommitted.length, 'uncommitted change') : null,
          sub.unpushed > 0 ? `${plural(sub.unpushed, 'commit')} not pushed` : null,
        ].filter(Boolean);
        return (
          <div key={sub.path} data-submodule={sub.path}>
            <Warning title={`Submodule ${sub.path}: ${parts.join(', ')}`}>
              {shown.length > 0
                ? `${shown.join(' · ')}${
                    sub.uncommitted.length > shown.length
                      ? ` · ${sub.uncommitted.length - shown.length} more`
                      : ''
                  }`
                : `${sub.path} has commits that aren't on its remote`}
            </Warning>
          </div>
        );
      })}
    </>
  );
}

/**
 * The worktree is on another branch than the workspace's (spec §14.2):
 * "frontend is on fix-x, not task-1", with that branch's unpushed commits,
 * or a detached HEAD's commits on no branch.
 */
export function CheckedOutWarning({
  name,
  checkedOut,
  branch,
  remote,
}: {
  name: string;
  checkedOut: WorktreeCheckout | null;
  /** The workspace's branch. */
  branch: string;
  remote: string | null;
}) {
  if (!checkedOut) return null;
  const { branch: other, unpushed } = checkedOut;
  const commits = plural(unpushed, 'commit');
  return (
    <div data-checked-out={other ?? ''}>
      <Warning title={`${name} is on ${other ?? 'a detached HEAD'}, not ${branch}`}>
        {unpushed === 0
          ? 'Nothing on it is unpushed'
          : other === null
            ? `${commits} on no branch go with the worktree`
            : `${commits} on ${other} ${unpushed === 1 ? "isn't" : "aren't"} on ${
                remote ?? 'any other branch'
              }; that branch is kept`}
      </Warning>
    </div>
  );
}

/** The "primary" tag of a linked workspace's main repository (components.md). */
export function PrimaryTag() {
  return (
    <span
      title="Claude starts here"
      className="rounded-xs border border-line-strong bg-raised px-1 text-2xs text-fg-muted"
    >
      primary
    </span>
  );
}

/**
 * "✓ Merged into main" (spec §14.2): the branch's commits are in its base,
 * so none are unpushed; "Merged into your local main (not pushed yet)" when
 * only the local base has them.
 */
export function MergedNote({
  merged,
  base,
  className = '',
}: {
  merged: RepoDeleteCheck['merged'];
  base: string;
  className?: string;
}) {
  if (!merged) return null;
  return (
    <p data-merged-note={merged} className={`text-sm text-fg-muted ${className}`}>
      <span className="text-diff-add">✓</span> {mergedText(merged, base)}
    </p>
  );
}

/**
 * An existing branch's remote branch (spec §14.2, §7.6): it stays, and when
 * others committed to it, a warning names them before its local branch goes.
 */
export function TrackedBranch({
  check,
  branch,
  className = '',
}: {
  check: RepoDeleteCheck;
  branch: string;
  className?: string;
}) {
  if (!check.upstream || check.branchOrigin === 'new') return null;
  if (check.otherAuthors.length === 0) {
    return (
      <p data-remote-kept className={`text-sm text-fg-muted ${className}`}>
        <span className="font-mono">{check.upstream}</span> stays on the remote.
      </p>
    );
  }
  const names = check.otherAuthors.slice(0, 3).join(', ');
  const more = check.otherAuthors.length > 3 ? ` and ${check.otherAuthors.length - 3} more` : '';
  return (
    <div
      data-others-branch
      className={`rounded-lg border border-st-permission/50 bg-st-permission/8 ${className}`}
    >
      <Warning title={`${branch} tracks ${check.upstream}, with commits by ${names}${more}`}>
        Deleting the local branch keeps {check.upstream} and its pull request on the remote.
      </Warning>
    </div>
  );
}

/**
 * One repository's card in Delete workspace, Unlink and Remove project
 * (spec §21.6): its warnings, or that it is clean, and its own "Also delete
 * the local branch" when it has unpushed commits or is an existing branch
 * (spec §7.6). `alsoDeleteBranch` is undefined until the user chooses.
 */
export function RepoCard({
  name,
  check,
  branch,
  base,
  remote,
  alsoDeleteBranch,
  onAlsoDeleteBranch,
}: {
  name: string;
  check: RepoDeleteCheck;
  branch: string;
  /** Its base branch, for "Merged into <base>". */
  base: string;
  remote: string | null;
  alsoDeleteBranch: boolean | undefined;
  onAlsoDeleteBranch: (value: boolean) => void;
}) {
  const shown = check.uncommitted.slice(0, 6);
  const choice = branchChoice(check);
  const clean =
    check.uncommitted.length === 0 &&
    check.unpushed === 0 &&
    !check.prOpen &&
    check.submodules.length === 0 &&
    check.checkedOut === null;
  return (
    <div
      data-repo-card={check.projectId}
      className="overflow-hidden rounded-lg border border-line-strong"
    >
      <div className="flex h-8 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="font-mono text-sm font-medium">{name}</span>
        {check.primary ? <PrimaryTag /> : null}
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-xs text-fg-subtle"
          title={check.worktreePath}
        >
          {check.worktreePath}
        </span>
      </div>
      {check.merged ? <MergedNote merged={check.merged} base={base} className="px-3 py-2" /> : null}
      {clean ? (
        check.merged ? null : (
          <p className="px-3 py-2 text-sm text-fg-muted">
            <span className="text-diff-add">✓</span> No uncommitted changes or unpushed commits
          </p>
        )
      ) : (
        <div className="divide-y divide-st-permission/30 bg-st-permission/8">
          {check.uncommitted.length > 0 ? (
            <Warning title={plural(check.uncommitted.length, 'uncommitted change')}>
              {shown.join(' · ')}
              {check.uncommitted.length > shown.length
                ? ` · ${check.uncommitted.length - shown.length} more`
                : ''}
            </Warning>
          ) : null}
          {check.unpushed > 0 ? (
            <Warning title={`${plural(check.unpushed, 'commit')} not pushed`}>
              {remote
                ? `${branch} has commits that aren't on ${remote}`
                : `${branch} has commits that aren't on any other branch`}
            </Warning>
          ) : null}
          <SubmoduleWarnings submodules={check.submodules} />
          <CheckedOutWarning
            name={name}
            checkedOut={check.checkedOut}
            branch={branch}
            remote={remote}
          />
          {check.prOpen ? <Warning title="Its pull request isn't merged" /> : null}
        </div>
      )}
      <TrackedBranch check={check} branch={branch} className="mx-3 mb-2" />
      {choice.shown ? (
        <label className="flex items-center gap-2 border-t border-line px-3 py-2 text-md text-fg">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            checked={alsoDeleteBranch ?? choice.ticked}
            onChange={(e) => onAlsoDeleteBranch(e.target.checked)}
          />
          Also delete the local branch <span className="font-mono">{branch}</span>
        </label>
      ) : null}
    </div>
  );
}

/** A repository's base branch in the workspace (the workspace's own as a fallback). */
const repoBase = (w: Workspace, projectId: string) =>
  w.repos.find((r) => r.projectId === projectId)?.baseBranch ?? w.baseBranch;

/**
 * What deleting one repository's worktree does, from its check and the
 * user's choices: the local branch goes unless its checkbox is shown and
 * unticked (spec §14.2, §7.6); undefined is the checkbox's default.
 */
export const repoChoice = (
  check: RepoDeleteCheck,
  alsoDeleteBranch: boolean | undefined,
  refused: boolean,
) => {
  const choice = branchChoice(check);
  return {
    projectId: check.projectId,
    force: needsForce(check) || refused,
    deleteBranch: choice.shown ? (alsoDeleteBranch ?? choice.ticked) : true,
  };
};

/**
 * Unlink <repo> (spec §21.4): that repository's card as in Delete, Cancel
 * focused, then its worktree goes and Claude restarts without it.
 */
export function UnlinkDialog({
  workspace,
  project,
  mainName,
  onClose,
  onDone,
}: {
  workspace: Workspace;
  project: Project;
  mainName: string;
  onClose: () => void;
  onDone: (result: { teardown: { ok: boolean; message: string; output: string } | null }) => void;
}) {
  const trpc = useTRPC();
  const check = useQuery(
    trpc.workspaces.unlinkCheck.queryOptions(
      { workspaceId: workspace.id, projectId: project.id },
      { staleTime: 0 },
    ),
  );
  const unlink = useMutation(trpc.workspaces.unlink.mutationOptions({ onSuccess: onDone }));
  const [refused, setRefused] = useState(false);
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState<boolean | undefined>(undefined);
  const data = check.data;
  return (
    <Modal
      title={`Unlink ${project.name} from ${workspace.task.id ?? workspace.name}?`}
      description={`Deletes its worktree and closes its Setup and Shell tabs. Claude restarts in ${mainName} without it; the conversation continues.`}
      onClose={onClose}
    >
      <form
        className="text-md"
        onSubmit={(event) => {
          event.preventDefault();
          if (!data) return;
          unlink.mutate(
            { workspaceId: workspace.id, ...repoChoice(data, alsoDeleteBranch, refused) },
            { onError: () => setRefused(true) },
          );
        }}
      >
        {check.isPending ? <p className="text-sm text-fg-subtle">Checking the worktree…</p> : null}
        {data ? (
          <RepoCard
            name={project.name}
            check={data}
            branch={workspace.branch}
            base={repoBase(workspace, project.id)}
            remote={project.remote}
            alsoDeleteBranch={alsoDeleteBranch}
            onAlsoDeleteBranch={setAlsoDeleteBranch}
          />
        ) : null}
        {(check.error ?? unlink.error) ? (
          <p role="alert" className="mt-3 text-sm text-st-error select-text">
            ✕ {(check.error ?? unlink.error)?.message}
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
            className={button('danger', 'lg')}
            disabled={!data || unlink.isPending}
          >
            {unlink.isPending ? 'Unlinking…' : refused ? 'Unlink anyway' : `Unlink ${project.name}`}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * Delete workspace (spec §14.2): lists what would be lost or interrupted,
 * with Cancel focused first. `--force` is used for the worktree only after
 * "Delete anyway". The local branch is deleted with it unless it has unpushed
 * commits; then an unchecked "Also delete the local branch" keeps them unless
 * ticked. The remote branch is never touched. A linked workspace shows one
 * card per repository, each with its own branch checkbox (§21.6).
 */
export function DeleteWorkspaceDialog({
  workspace,
  remote,
  projects = [],
  onClose,
  onDeleted,
  onCommitFirst,
}: {
  workspace: Workspace;
  remote: string | null;
  /** The profile's projects, for a linked workspace's repository names and remotes. */
  projects?: Project[];
  onClose: () => void;
  /** "Commit and push first": opens the Changes panel instead (spec §14.2, M4). */
  onCommitFirst: () => void;
  onDeleted: (result: {
    teardown: { ok: boolean; message: string; output: string } | null;
  }) => void;
}) {
  const trpc = useTRPC();
  const check = useQuery(
    trpc.workspaces.deleteCheck.queryOptions({ workspaceId: workspace.id }, { staleTime: 0 }),
  );
  const remove = useMutation(trpc.workspaces.delete.mutationOptions({ onSuccess: onDeleted }));
  // A plain delete that git refused (e.g. a locked worktree) can be forced after confirming.
  const [refused, setRefused] = useState(false);
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState<boolean | undefined>(undefined);
  const data = check.data;
  const main = data?.repos.find((r) => r.primary) ?? null;
  const warnings = data
    ? hasWork(data) || data.checkedOut !== null || data.running > 0 || data.prOpen
    : false;
  const force = (data ? needsForce(data) : false) || refused;
  // Another branch checked out with nothing unpushed is only said.
  const danger = (data ? hasWork(data) || data.running > 0 || data.prOpen : false) || refused;
  const branchBox = main ? branchChoice(main) : { shown: false, ticked: true };
  const deleteBranch = main ? repoChoice(main, alsoDeleteBranch, false).deleteBranch : true;

  const changes = data?.uncommitted ?? [];
  const shown = changes.slice(0, 8);
  const linked = workspace.repos.length > 1;
  const [alsoDeleteBranches, setAlsoDeleteBranches] = useState<Record<string, boolean | undefined>>(
    {},
  );
  const repoName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const repoRemote = (id: string) => projects.find((p) => p.id === id)?.remote ?? null;
  const dirty = (data?.repos ?? []).some(hasWork);
  const linkedDanger =
    (data?.repos ?? []).some((r) => hasWork(r) || r.prOpen) || (data?.running ?? 0) > 0 || refused;

  if (linked) {
    return (
      <Modal
        title={`Delete ${workspace.name}?`}
        description={`Removes its ${workspace.repos.length} worktrees and ends its terminals.${
          remote ? ' Branches on the remotes are kept.' : ''
        }`}
        onClose={onClose}
      >
        <form
          className="space-y-2.5 text-md"
          onSubmit={(event) => {
            event.preventDefault();
            if (!data) return;
            remove.mutate(
              {
                workspaceId: workspace.id,
                force: refused,
                deleteBranch: false,
                repos: data.repos.map((r) =>
                  repoChoice(r, alsoDeleteBranches[r.projectId], refused),
                ),
              },
              { onError: () => setRefused(true) },
            );
          }}
        >
          {check.isPending ? (
            <p className="text-sm text-fg-subtle">Checking the worktrees…</p>
          ) : null}
          {data && data.running > 0 ? (
            <div className="rounded-lg border border-st-permission/50 bg-st-permission/8">
              <Warning title={`${plural(data.running, 'running session')} will be stopped`} />
            </div>
          ) : null}
          {(data?.repos ?? []).map((r) => (
            <RepoCard
              key={r.projectId}
              name={repoName(r.projectId)}
              check={r}
              branch={workspace.branch}
              base={repoBase(workspace, r.projectId)}
              remote={repoRemote(r.projectId)}
              alsoDeleteBranch={alsoDeleteBranches[r.projectId]}
              onAlsoDeleteBranch={(value) =>
                setAlsoDeleteBranches((all) => ({ ...all, [r.projectId]: value }))
              }
            />
          ))}
          <p className="flex items-center gap-1.5 text-sm text-fg-subtle">
            <GuideLink to="delete-workspace" label="Deleting a workspace" before={onClose} />
            What is kept and what goes
          </p>
          {(check.error ?? remove.error) ? (
            <p role="alert" className="text-sm text-st-error select-text">
              ✕ {(check.error ?? remove.error)?.message}
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
            {dirty ? (
              <button type="button" className={button('secondary', 'lg')} onClick={onCommitFirst}>
                {remote ? 'Commit and push first' : 'Commit first'}
              </button>
            ) : null}
            <button
              type="submit"
              className={button('danger', 'lg')}
              disabled={!data || remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : linkedDanger ? 'Delete anyway' : 'Delete'}
            </button>
          </ModalFooter>
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Delete ${workspace.name}?`}
      description={
        <>
          Removes the worktree at <span className="font-mono">{workspace.worktreePath}</span>
          {deleteBranch ? (
            <>
              {' '}
              and the local branch <span className="font-mono">{workspace.branch}</span>
            </>
          ) : null}
          , and ends its terminals.{remote ? ` The branch on ${remote} is kept.` : ''}
        </>
      }
      onClose={onClose}
    >
      <form
        className="text-md"
        onSubmit={(event) => {
          event.preventDefault();
          remove.mutate(
            { workspaceId: workspace.id, force, deleteBranch },
            { onError: () => setRefused(true) },
          );
        }}
      >
        {check.isPending ? <p className="text-sm text-fg-subtle">Checking the worktree…</p> : null}
        {data && warnings ? (
          <div className="divide-y divide-st-permission/30 rounded-lg border border-st-permission/50 bg-st-permission/8">
            {changes.length > 0 ? (
              <Warning title={plural(changes.length, 'uncommitted change')}>
                {shown.join(' · ')}
                {changes.length > shown.length ? ` · ${changes.length - shown.length} more` : ''}
              </Warning>
            ) : null}
            {data.unpushed > 0 ? (
              <Warning title={`${plural(data.unpushed, 'commit')} not pushed`}>
                {remote
                  ? `${workspace.branch} has commits that aren't on ${remote}`
                  : `${workspace.branch} has commits that aren't on any other branch`}
              </Warning>
            ) : null}
            <SubmoduleWarnings submodules={data.submodules} />
            <CheckedOutWarning
              name={repoName(workspace.projectId)}
              checkedOut={data.checkedOut}
              branch={workspace.branch}
              remote={remote}
            />
            {data.prOpen ? (
              <Warning title="Its pull request isn't merged">
                The last check found it {workspace.pr?.state === 'draft' ? 'a draft' : 'open'}
              </Warning>
            ) : null}
            {data.running > 0 ? (
              <Warning title={`${plural(data.running, 'running session')} will be stopped`} />
            ) : null}
          </div>
        ) : null}
        {data?.merged ? (
          <MergedNote
            merged={data.merged}
            base={workspace.baseBranch}
            className={warnings ? 'mt-3' : ''}
          />
        ) : null}
        {main ? <TrackedBranch check={main} branch={workspace.branch} className="mt-3" /> : null}
        {branchBox.shown ? (
          <label className="mt-3 flex items-center gap-2 text-md text-fg">
            <input
              type="checkbox"
              className="size-3.5 accent-fg"
              checked={alsoDeleteBranch ?? branchBox.ticked}
              onChange={(e) => setAlsoDeleteBranch(e.target.checked)}
            />
            Also delete the local branch <span className="font-mono">{workspace.branch}</span>
          </label>
        ) : null}
        <p className="mt-3 flex items-center gap-1.5 text-sm text-fg-subtle">
          <GuideLink to="delete-workspace" label="Deleting a workspace" before={onClose} />
          What is kept and what goes
        </p>
        {data?.worktreeMissing ? (
          <p className="mt-2 text-sm text-fg-muted">The worktree folder is already gone.</p>
        ) : null}
        {(check.error ?? remove.error) ? (
          <p role="alert" className="mt-3 text-sm text-st-error select-text">
            ✕ {(check.error ?? remove.error)?.message}
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
          {data && hasWork(data) ? (
            <button type="button" className={button('secondary', 'lg')} onClick={onCommitFirst}>
              {remote ? 'Commit and push first' : 'Commit first'}
            </button>
          ) : null}
          <button
            type="submit"
            className={button('danger', 'lg')}
            disabled={!data || remove.isPending}
          >
            {remove.isPending ? 'Deleting…' : danger ? 'Delete anyway' : 'Delete'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * Delete n merged workspaces, from Home's Clean up (spec §6.7, §14.2): every
 * workspace with Delete workspace's checks, one card per repository with its
 * warnings and its own "Also delete the local branch", Cancel focused first.
 * They are deleted one after another; one that git refuses stops the rest,
 * and Delete anyway then forces it.
 */
export function DeleteWorkspacesDialog({
  workspaces,
  projects,
  onClose,
  onDeleted,
}: {
  workspaces: Workspace[];
  /** The profile's projects, for repository names and remotes. */
  projects: Project[];
  onClose: () => void;
  /** Teardowns that didn't finish don't stop the deletes; they are shown afterwards (spec §8.3). */
  onDeleted: (result: { teardownFailures: string[] }) => void;
}) {
  const trpc = useTRPC();
  const checks = useQueries({
    queries: workspaces.map((w) =>
      trpc.workspaces.deleteCheck.queryOptions({ workspaceId: w.id }, { staleTime: 0 }),
    ),
  });
  const [deleted, setDeleted] = useState<string[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // "Also delete the local branch", by workspace and repository.
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState<Record<string, boolean | undefined>>({});
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const remote = (id: string) => projects.find((p) => p.id === id)?.remote ?? null;
  const left = workspaces.filter((w) => !deleted.includes(w.id));
  const loaded = checks.every((c) => c.data);
  const checkError = checks.find((c) => c.error)?.error?.message ?? null;

  const run = async () => {
    setPending(true);
    setError(null);
    const failures: string[] = [];
    for (const [i, w] of workspaces.entries()) {
      const check = checks[i]?.data;
      if (deleted.includes(w.id) || !check) continue;
      const force = refused === w.id;
      const choice = (r: RepoDeleteCheck) =>
        repoChoice(r, alsoDeleteBranch[`${w.id}:${r.projectId}`], force);
      const main = check.repos.find((r) => r.primary);
      try {
        const result = await trpcClient.workspaces.delete.mutate(
          w.repos.length > 1
            ? { workspaceId: w.id, force, deleteBranch: false, repos: check.repos.map(choice) }
            : {
                workspaceId: w.id,
                force: (main ? needsForce(main) : false) || force,
                deleteBranch: main ? choice(main).deleteBranch : true,
              },
        );
        if (result.teardown && !result.teardown.ok) {
          failures.push(`${w.name} (${result.teardown.message})`);
        }
        setDeleted((d) => [...d, w.id]);
      } catch (e) {
        setRefused(w.id);
        setError(`${w.name}: ${e instanceof Error ? e.message : String(e)}`);
        setPending(false);
        return;
      }
    }
    setPending(false);
    onDeleted({ teardownFailures: failures });
  };

  return (
    <Modal
      title={`Delete ${plural(workspaces.length, 'merged workspace')}?`}
      description="Removes their worktrees and ends their terminals. Branches on the remotes are kept; a local branch with commits that aren't pushed is kept unless you tick its box."
      onClose={onClose}
    >
      <form
        className="text-md"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        {!loaded && !checkError ? (
          <p className="text-sm text-fg-subtle">Checking the worktrees…</p>
        ) : null}
        <ul data-delete-merged className="flex max-h-[420px] flex-col gap-2.5 overflow-y-auto">
          {workspaces.map((w, i) => {
            const check = checks[i]?.data;
            if (deleted.includes(w.id)) return null;
            return (
              <li key={w.id} data-delete-workspace={w.id} className="space-y-1.5">
                <div className="flex items-baseline gap-2">
                  {w.task.id ? (
                    <span className="font-mono text-sm text-fg-subtle">{w.task.id}</span>
                  ) : null}
                  <span className="min-w-0 truncate font-medium">{w.task.title || w.name}</span>
                  <span className="shrink-0 font-mono text-xs text-fg-subtle">
                    {name(w.projectId)}
                  </span>
                </div>
                {check && check.running > 0 ? (
                  <div className="rounded-lg border border-st-permission/50 bg-st-permission/8">
                    <Warning
                      title={`${plural(check.running, 'running session')} will be stopped`}
                    />
                  </div>
                ) : null}
                {(check?.repos ?? []).map((r) => {
                  const key = `${w.id}:${r.projectId}`;
                  return (
                    <RepoCard
                      key={r.projectId}
                      name={name(r.projectId)}
                      check={r}
                      branch={w.branch}
                      base={repoBase(w, r.projectId)}
                      remote={remote(r.projectId)}
                      alsoDeleteBranch={alsoDeleteBranch[key]}
                      onAlsoDeleteBranch={(value) =>
                        setAlsoDeleteBranch((all) => ({ ...all, [key]: value }))
                      }
                    />
                  );
                })}
                {check?.worktreeMissing ? (
                  <p className="text-sm text-fg-muted">The worktree folder is already gone.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex items-center gap-1.5 text-sm text-fg-subtle">
          <GuideLink to="delete-workspace" label="Deleting a workspace" before={onClose} />
          What is kept and what goes
        </p>
        {(error ?? checkError) ? (
          <p role="alert" className="mt-3 text-sm text-st-error select-text">
            ✕ {error ?? checkError}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            data-autofocus
            className={button('secondary', 'lg')}
            onClick={deleted.length > 0 ? () => onDeleted({ teardownFailures: [] }) : onClose}
          >
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button
            type="submit"
            className={button('danger', 'lg')}
            disabled={!loaded || pending || left.length === 0}
          >
            {pending
              ? 'Deleting…'
              : refused
                ? 'Delete anyway'
                : `Delete ${plural(left.length, 'workspace')}`}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
