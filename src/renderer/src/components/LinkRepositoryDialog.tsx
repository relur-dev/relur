import { projectWorktreeDir } from '@shared/projects';
import type { Profile, Project } from '@shared/schemas';
import type { SessionInfo } from '@shared/terminal-protocol';
import { LINK_TRUST_NOTE, type Workspace } from '@shared/workspaces';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { GuideLink } from '../guide/link';
import { trpcClient, useTRPC } from '../trpc';
import { button, Kbd, keyHint } from '../ui/controls';
import { showAppNotice } from './EditorPicker';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/** A command line with Copy ("Copied" for 1.5 s). */
function CopyLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-term px-2.5 py-1.5">
      <code data-add-dir-line className="min-w-0 flex-1 truncate font-mono text-sm select-text">
        {line}
      </code>
      <button
        type="button"
        className={button('ghost', 'sm')}
        onClick={() =>
          void trpcClient.clipboard.writeText.mutate({ text: line }).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Link another repository… (spec §21.4): one of the profile's other
 * projects gets a worktree on the workspace's branch. Then Claude restarts
 * with every folder (the conversation continues), or keeps running and the
 * user pastes the `/add-dir` line.
 */
export function LinkRepositoryDialog({
  profile,
  projects,
  workspace,
  mainName,
  onClose,
  onLinked,
}: {
  profile: Profile;
  /** The profile's projects. */
  projects: Project[];
  workspace: Workspace;
  mainName: string;
  onClose: () => void;
  /** The new Setup tab or restarted Claude, to show. */
  onLinked: (session: SessionInfo | null) => void;
}) {
  const trpc = useTRPC();
  const inWorkspace = new Set(workspace.repos.map((r) => r.projectId));
  const others = projects.filter((p) => p.id !== workspace.projectId);
  const [projectId, setProjectId] = useState(
    others.find((p) => !inWorkspace.has(p.id))?.id ?? null,
  );
  const [restart, setRestart] = useState(true);
  const [linkedLine, setLinkedLine] = useState<string | null>(null);
  const project = others.find((p) => p.id === projectId) ?? null;
  const setup = useQuery(
    trpc.projects.setup.queryOptions(
      { projectId: projectId ?? '' },
      { enabled: Boolean(projectId), staleTime: 0 },
    ),
  );
  const link = useMutation(
    trpc.workspaces.link.mutationOptions({
      onSuccess: (result) => {
        onLinked(result.setup ?? result.claude);
        // A base from the local branch (spec §7.3).
        if (result.notes.length > 0) showAppNotice(result.notes.join('\n'), true);
        if (restart) onClose();
        else setLinkedLine(result.addDirLine);
      },
    }),
  );
  const worktree = project ? `${projectWorktreeDir(profile, project)}/${workspace.branch}` : '';
  const base = project?.baseBranch ?? profile.defaults.baseBranch;
  const hasSetup = (setup.data?.setup.length ?? 0) > 0;
  const total = workspace.repos.length + 1;

  if (linkedLine) {
    return (
      <Modal
        title={`Linked ${project?.name ?? ''}`}
        description="Claude keeps running. Paste this into Claude so it works in the new folder too:"
        onClose={onClose}
      >
        <CopyLine line={linkedLine} />
        <ModalFooter>
          <button
            type="button"
            data-autofocus
            className={button('primary', 'lg')}
            onClick={onClose}
          >
            Done <Kbd onFg>Esc</Kbd>
          </button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal
      title="Link another repository"
      description={
        <>
          Adds a worktree on <span className="font-mono">{workspace.branch}</span> to{' '}
          {workspace.task.id ?? workspace.name}.
        </>
      }
      onClose={onClose}
    >
      <form
        className={`${modalForm} text-md`}
        onSubmit={(event) => {
          event.preventDefault();
          if (project) link.mutate({ workspaceId: workspace.id, projectId: project.id, restart });
        }}
      >
        <ModalBody className="space-y-3">
          <div
            role="radiogroup"
            aria-label="Project"
            className="flex flex-col gap-px overflow-hidden rounded-md border border-line bg-line"
          >
            {others.map((p) => {
              const already = inWorkspace.has(p.id);
              return (
                <label
                  key={p.id}
                  className={`flex h-7.5 items-center gap-2.5 bg-raised px-2.5 ${
                    already ? 'opacity-45' : 'hover:bg-selected'
                  }`}
                >
                  <input
                    type="radio"
                    name="link-project"
                    disabled={already}
                    checked={p.id === projectId}
                    onChange={() => setProjectId(p.id)}
                  />
                  <span className="font-mono text-sm">{p.name}</span>
                  <span className="flex-1" />
                  <span className="text-xs text-fg-subtle">
                    {already
                      ? 'Already in this workspace'
                      : `← ${p.baseBranch ?? profile.defaults.baseBranch}`}
                  </span>
                </label>
              );
            })}
          </div>

          {project ? (
            <div className="space-y-1 rounded-md bg-surface px-3 py-2 text-sm">
              <div className="truncate font-mono text-fg-muted" title={worktree}>
                {worktree}
              </div>
              <div className="font-mono">
                {workspace.branch} <span className="text-fg-subtle">← {base}</span>{' '}
                <span className="font-sans text-fg-subtle">new branch</span>
              </div>
              <div className="text-fg-muted">
                {hasSetup
                  ? `Its setup runs first, in a new Setup tab: ${setup.data?.setup.join(' && ')}`
                  : 'It has no setup commands.'}
              </div>
            </div>
          ) : null}

          <p data-trust-note className="text-sm text-fg-subtle">
            {LINK_TRUST_NOTE}
          </p>

          <div role="radiogroup" aria-label="Claude" className="grid gap-2">
            <label
              className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${restart ? 'border-line-strong bg-raised' : 'border-line'}`}
            >
              <input
                type="radio"
                name="link-mode"
                className="mt-1"
                checked={restart}
                onChange={() => setRestart(true)}
              />
              <span>
                <span className="font-medium">Link and restart Claude</span>
                <span className="block text-sm text-fg-muted">
                  Claude restarts in {mainName} with all {total} folders. The conversation
                  continues.
                </span>
              </span>
            </label>
            <label
              className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${restart ? 'border-line' : 'border-line-strong bg-raised'}`}
            >
              <input
                type="radio"
                name="link-mode"
                className="mt-1"
                checked={!restart}
                onChange={() => setRestart(false)}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">Link only</span>
                <span className="block text-sm text-fg-muted">
                  Claude keeps running. Paste this into Claude afterwards:
                </span>
                {!restart && project ? <CopyLine line={`/add-dir ${worktree}`} /> : null}
              </span>
            </label>
          </div>

          <p className="flex items-center gap-1.5 text-sm text-fg-subtle">
            <GuideLink
              to="tasks-across-repositories#linking-and-unlinking"
              label="Tasks across repositories"
              before={onClose}
            />
            How linked repositories work
          </p>
          {link.isPending ? (
            <p className="text-sm text-fg-muted">
              {project?.remote ? `Fetching ${project.remote}/${base}, then a` : 'A'}dding the
              worktree…
            </p>
          ) : null}
          {link.error ? (
            <p role="alert" className="text-sm text-st-error select-text">
              ✕ {link.error.message}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button
            type="submit"
            data-autofocus
            className={button('primary', 'lg')}
            disabled={!project || link.isPending}
          >
            {restart ? 'Link and restart Claude' : 'Link only'} <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
