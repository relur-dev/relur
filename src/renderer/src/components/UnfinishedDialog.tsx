import { BRAND } from '@shared/brand';
import type { Profile, Project } from '@shared/schemas';
import {
  canContinue,
  planLimitReached,
  tickedByDefault,
  unfinishedReason,
} from '@shared/unfinished';
import type { UsageSnapshot } from '@shared/usage';
import type { Workspace } from '@shared/workspaces';
import { type FormEvent, useState } from 'react';
import type { AppRouterOutputs } from '../trpc';
import { button, Kbd, keyHint } from '../ui/controls';
import { ProfileDot } from '../ui/profile-color';
import { plural } from './DeleteWorkspaceDialog';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The overview at start (spec §9.7): the workspaces Claude didn't finish in,
 * grouped by profile. Working ones are ticked, Esc-interrupted ones not, and
 * a permission request has no checkbox: it is given again in the workspace
 * (Open). Continue selected sends the continue prompt to the ticked ones;
 * Not now (Esc) leaves their markers.
 */
export function UnfinishedDialog({
  workspaceIds,
  workspaces,
  profiles,
  projects,
  usage,
  onContinue,
  onClose,
  onOpen,
}: {
  workspaceIds: string[];
  workspaces: Workspace[];
  profiles: Profile[];
  projects: Project[];
  usage: Record<string, UsageSnapshot>;
  onContinue: (workspaceIds: string[]) => void;
  onClose: () => void;
  onOpen: (workspace: Workspace) => void;
}) {
  const rows = workspaceIds.flatMap((id) => {
    const w = workspaces.find((x) => x.id === id);
    return w?.unfinished
      ? [{ w, kind: w.unfinished.kind, since: w.unfinished.since, marker: w.unfinished }]
      : [];
  });
  const [ticked, setTicked] = useState(
    () => new Set(rows.filter((r) => tickedByDefault(r.kind)).map((r) => r.w.id)),
  );
  const groups = profiles
    .map((profile) => ({ profile, rows: rows.filter((r) => r.w.profileId === profile.id) }))
    .filter((g) => g.rows.length > 0);
  const chosen = rows.filter((r) => ticked.has(r.w.id) && canContinue(r.kind));
  // Never while plan usage is at its limit.
  const limited = [...new Set(chosen.map((r) => r.w.profileId))]
    .map((profileId) => {
      const reason = planLimitReached(usage[profileId]);
      const name = profiles.find((p) => p.id === profileId)?.name ?? profileId;
      return reason ? `${name}: ${reason}` : null;
    })
    .filter((r): r is string => r !== null);
  const disabledReason =
    limited.length > 0 ? limited.join('; ') : chosen.length === 0 ? 'Nothing is ticked' : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabledReason) return;
    onContinue(chosen.map((r) => r.w.id));
  };
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <Modal
      title={`Claude didn't finish in ${plural(rows.length, 'workspace')}`}
      description={`${BRAND.displayName} stopped while Claude was at work there. The ticked ones get the continue prompt, one after another.`}
      onClose={onClose}
      wide
    >
      <form className={modalForm} onSubmit={submit}>
        <ModalBody>
          <div data-unfinished-overview className="flex flex-col gap-3">
            {groups.map(({ profile, rows: group }) => (
              <section key={profile.id} aria-label={profile.name}>
                <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-fg-muted">
                  <ProfileDot color={profile.color} size={8} />
                  {profile.name}
                </h3>
                <ul className="divide-y divide-line rounded-lg border border-line text-md">
                  {group.map(({ w, kind, since, marker }) => (
                    <li
                      key={w.id}
                      data-unfinished-row={w.id}
                      data-kind={kind}
                      className="flex items-center gap-2.5 px-3 py-2"
                    >
                      <span className="flex size-4 flex-none items-center justify-center">
                        {canContinue(kind) ? (
                          <input
                            type="checkbox"
                            aria-label={`Continue ${w.task.id ?? w.task.title ?? w.name}`}
                            checked={ticked.has(w.id)}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setTicked((current) => {
                                const next = new Set(current);
                                if (on) next.add(w.id);
                                else next.delete(w.id);
                                return next;
                              });
                            }}
                          />
                        ) : null}
                      </span>
                      <ProfileDot color={profile.color} size={6} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-1.5">
                          {w.task.id ? (
                            <span className="font-mono text-xs text-fg-muted">{w.task.id}</span>
                          ) : null}
                          <span className="truncate">{w.task.title || w.name}</span>
                          <span className="shrink-0 font-mono text-xs text-fg-subtle">
                            {projectName(w.projectId)}
                          </span>
                        </span>
                        <span
                          data-last-prompt
                          className="block truncate text-sm text-fg-muted"
                          title={w.lastPrompt ?? undefined}
                        >
                          {w.lastPrompt ? w.lastPrompt.replace(/\s+/g, ' ') : 'No prompt recorded'}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <span
                          className={`text-sm ${kind === 'permission' ? 'text-st-permission' : 'text-fg-muted'}`}
                        >
                          {unfinishedReason(marker)}
                        </span>
                        <span className="font-mono text-xs text-fg-subtle">
                          stopped {timeOf(since)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={button('ghost', 'sm')}
                        title={
                          kind === 'permission'
                            ? 'Open the workspace to give the permission again'
                            : 'Open the workspace'
                        }
                        onClick={() => onOpen(w)}
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ModalBody>
        <ModalFooter>
          {limited.length > 0 ? (
            <span data-limit-reason className="mr-auto text-sm text-st-permission">
              {limited.join('; ')}
            </span>
          ) : null}
          <button type="button" className={button('ghost', 'lg')} onClick={onClose}>
            Not now <Kbd>Esc</Kbd>
          </button>
          <button
            type="submit"
            data-autofocus
            className={button('primary', 'lg')}
            disabled={!!disabledReason}
            title={disabledReason ?? undefined}
          >
            Continue selected <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

type ContinueRun = AppRouterOutputs['unfinished']['state']['run'];

const ITEM_TEXT: Record<ContinueRun['items'][number]['state'], string> = {
  waiting: 'waiting',
  sent: '✓ continued',
  stopped: 'stopped',
  skipped: 'skipped',
  held: 'held',
  failed: 'failed',
};

/**
 * The notice while continue prompts go out (spec §9.7): each workspace and
 * how far it got, with Stop, which cancels the ones not yet sent.
 */
export function ContinueNotice({
  run,
  workspaces,
  profiles,
  onStop,
}: {
  run: ContinueRun;
  workspaces: Workspace[];
  profiles: Profile[];
  onStop: () => void;
}) {
  const waiting = run.items.filter((i) => i.state === 'waiting').length;
  return (
    <div
      role="status"
      data-continue-notice
      className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2 text-md"
    >
      <span className="text-fg-subtle">↻</span>
      <span className="min-w-0 flex-1 truncate">
        Continuing interrupted work:{' '}
        {run.items.map((item, index) => {
          const w = workspaces.find((x) => x.id === item.workspaceId);
          const profile = profiles.find((p) => p.id === w?.profileId);
          return (
            <span
              key={item.workspaceId}
              data-continue-item={item.workspaceId}
              data-state={item.state}
              title={item.reason ?? undefined}
              className="inline-flex items-center gap-1.5"
            >
              {index > 0 ? <span className="text-fg-subtle">·</span> : null}
              {profile ? <ProfileDot color={profile.color} size={6} /> : null}
              {w ? w.task.id || w.task.title || w.name : item.workspaceId}
              <span className="text-sm text-fg-muted">{ITEM_TEXT[item.state]}</span>
            </span>
          );
        })}
      </span>
      <button
        type="button"
        className={button('secondary', 'sm')}
        disabled={waiting === 0}
        onClick={onStop}
      >
        Stop
      </button>
    </div>
  );
}
