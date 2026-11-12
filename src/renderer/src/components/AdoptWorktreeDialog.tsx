import type { Profile, Project } from '@shared/schemas';
import type { OtherWorktree, Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { GuideLink } from '../guide/link';
import { useTRPC } from '../trpc';
import { button, inputClass, Kbd, keyHint, labelClass } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/**
 * Open as workspace (spec §13.6): an existing worktree of the project becomes
 * a workspace, with the task prefilled from its status file or branch.
 * Nothing is written into the worktree; Claude doesn't start by itself.
 */
export function AdoptWorktreeDialog({
  profile,
  project,
  worktree,
  onClose,
  onAdopted,
}: {
  profile: Profile;
  project: Project;
  worktree: OtherWorktree;
  onClose: () => void;
  onAdopted: (workspace: Workspace) => void;
}) {
  const trpc = useTRPC();
  const [taskId, setTaskId] = useState(worktree.taskId ?? '');
  const [title, setTitle] = useState(worktree.title);
  const [base, setBase] = useState(project.baseBranch ?? profile.defaults.baseBranch);
  const [runSetup, setRunSetup] = useState(false);
  const bases = useQuery(trpc.workspaces.baseBranches.queryOptions({ projectId: project.id }));
  const plan = useQuery(trpc.projects.setup.queryOptions({ projectId: project.id }));
  const adopt = useMutation(trpc.workspaces.adopt.mutationOptions({ onSuccess: onAdopted }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!taskId.trim() && !title.trim()) return;
    adopt.mutate({
      projectId: project.id,
      worktreePath: worktree.path,
      taskId: taskId.trim() || null,
      title: title.trim(),
      baseBranch: base,
      runSetup,
    });
  };
  return (
    <Modal
      title="Open as workspace"
      description={
        <span className="inline-flex items-center gap-1.5">
          A worktree of {project.name} that {profile.name} doesn't know yet.
          <GuideLink to="adopting-worktrees" label="Adopting worktrees" before={onClose} />
        </span>
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className={modalForm} data-adopt-dialog>
        <ModalBody className="flex flex-col gap-3">
          <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-fg-muted">Branch</dt>
            <dd className="truncate font-mono select-text">{worktree.branch}</dd>
            <dt className="text-fg-muted">Folder</dt>
            <dd className="truncate font-mono select-text" title={worktree.path}>
              {worktree.path}
            </dd>
          </dl>
          <div className="grid grid-cols-[120px_1fr] gap-2">
            <div>
              <label className={labelClass} htmlFor="adopt-id">
                Task id
              </label>
              <input
                id="adopt-id"
                className={`${inputClass} font-mono text-sm`}
                spellCheck={false}
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="adopt-title">
                Title
              </label>
              <input
                id="adopt-title"
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="adopt-base">
              Base branch
            </label>
            <select
              id="adopt-base"
              className={inputClass}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              {[...new Set([base, ...(bases.data ?? [])])].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          {(plan.data?.setup.length ?? 0) > 0 ? (
            <label className="flex items-center gap-2 text-md">
              <input
                type="checkbox"
                checked={runSetup}
                onChange={(e) => setRunSetup(e.target.checked)}
              />
              Run setup in it
              <span className="text-sm text-fg-subtle">
                off when the worktree is set up already
              </span>
            </label>
          ) : null}
          <p className="text-sm text-fg-subtle">
            Nothing is copied or written into the folder. Claude doesn't start by itself: start it
            in the Claude tab.
          </p>
          {adopt.error ? (
            <p role="alert" className="text-md text-st-error select-text">
              ✕ {adopt.error.message}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <button type="button" className={button('ghost')} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={button('primary')}
            disabled={(!taskId.trim() && !title.trim()) || adopt.isPending}
          >
            Open as workspace <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
