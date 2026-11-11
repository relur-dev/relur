import { FLAG_NOTE_MAX, flagTooltip } from '@shared/flag';
import type { Workspace, WorkspaceFlag } from '@shared/workspaces';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { trpcClient } from '../trpc';
import { button, inputClass, keyHint, labelClass } from '../ui/controls';
import { FlagIcon } from '../ui/icons';
import { Modal, ModalFooter } from './Modal';

/** How long "Unflagged · Undo" shows (spec §6.7). */
const UNDO_MS = 5000;

type FlagTarget = Pick<Workspace, 'id' | 'name' | 'task' | 'flag'>;

/** The Flag dialog's workspace, and the last unflag that can be undone. */
interface FlagStore {
  editing: FlagTarget | null;
  undo: { workspaceId: string; label: string; flag: WorkspaceFlag; at: number } | null;
}
let store: FlagStore = { editing: null, undo: null };
const listeners = new Set<() => void>();
const set = (next: Partial<FlagStore>) => {
  store = { ...store, ...next };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const labelOf = (w: FlagTarget) => w.task.id ?? (w.task.title || w.name);

/**
 * Flagging a workspace to come back to later (spec §6.7), the same from a
 * Board card's menu, its sidebar row, the workspace header and ⇧⌘G.
 */
export const flagging = {
  /** Flag… or Edit Flag Note…: the dialog with its one-line note. */
  open(w: FlagTarget) {
    set({ editing: w });
  },
  /** Clears the flag at once, with "Unflagged · Undo" for 5 seconds. */
  clear(w: FlagTarget) {
    if (!w.flag) return;
    set({ undo: { workspaceId: w.id, label: labelOf(w), flag: w.flag, at: Date.now() } });
    void trpcClient.workspaces.setFlag.mutate({ workspaceId: w.id, note: null });
  },
  /** ⇧⌘G: Flag… when it isn't flagged, else Unflag. */
  toggle(w: FlagTarget) {
    if (w.flag) flagging.clear(w);
    else flagging.open(w);
  },
};

/** The flag's items in a workspace's menus (spec §6.1, §6.2, §6.7). */
export const flagMenuItems = (w: FlagTarget) =>
  w.flag
    ? [
        { id: 'flag:edit', label: 'Edit Flag Note…' },
        { id: 'flag:clear', label: 'Unflag' },
      ]
    : [{ id: 'flag:set', label: 'Flag…' }];

/** Runs a flag item chosen in a menu; false for any other choice. */
export function runFlagChoice(w: FlagTarget, choice: string | null): boolean {
  if (choice === 'flag:set' || choice === 'flag:edit') flagging.open(w);
  else if (choice === 'flag:clear') flagging.clear(w);
  else return false;
  return true;
}

/**
 * The flag on a Board card, a sidebar row or the workspace header: the
 * filled flag in the flag color; a click clears it (spec §6.7).
 */
export function FlagMark({
  w,
  size = 12,
  className = '',
  focusable = true,
}: {
  w: FlagTarget;
  size?: number;
  className?: string;
  /** False on a Board card, where Tab goes to the ⓘ first (spec §6.7). */
  focusable?: boolean;
}): ReactNode {
  if (!w.flag) return null;
  const title = flagTooltip(w.flag.note);
  return (
    <button
      type="button"
      data-flag-mark={w.id}
      tabIndex={focusable ? undefined : -1}
      title={title}
      aria-label={`Unflag ${labelOf(w)}`}
      className={`-m-0.5 inline-flex flex-none items-center justify-center self-center rounded-[4px] p-0.5 text-flag outline-none hover:bg-band-strong focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)] ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        flagging.clear(w);
      }}
      onKeyDown={(e) => {
        // ↵ and Space clear it, not open the card or row around it.
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <FlagIcon size={size} />
    </button>
  );
}

/** The Flag dialog and the Undo toast, once per window. */
export function FlagLayer({ workspaces }: { workspaces: Workspace[] }) {
  const { editing, undo } = useSyncExternalStore(subscribe, () => store);
  // The dialog follows the workspace as it changes, and closes once it is gone.
  const current = editing ? (workspaces.find((w) => w.id === editing.id) ?? null) : null;
  useEffect(() => {
    if (editing && workspaces.length > 0 && !current) set({ editing: null });
  }, [editing, current, workspaces.length]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(
      () => set({ undo: store.undo === undo ? null : store.undo }),
      UNDO_MS - (Date.now() - undo.at),
    );
    return () => clearTimeout(timer);
  }, [undo]);
  return (
    <>
      {editing ? (
        <FlagDialog
          key={editing.id}
          w={current ?? editing}
          onClose={() => set({ editing: null })}
        />
      ) : null}
      {undo ? (
        <div
          role="status"
          data-flag-undo={undo.workspaceId}
          className="fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line-strong bg-raised py-1 pr-1 pl-3 text-md text-fg shadow-overlay"
        >
          <span className="flex items-center gap-1.5">
            <span className="text-fg-subtle">
              <FlagIcon filled={false} size={12} />
            </span>
            Unflagged <span className="font-mono text-sm text-fg-muted">{undo.label}</span>
          </span>
          <button
            type="button"
            data-flag-undo-button
            className="h-6 rounded-[5px] px-2 text-sm font-medium text-fg outline-none hover:bg-band-strong focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
            onClick={() => {
              set({ undo: null });
              void trpcClient.workspaces.setFlag.mutate({
                workspaceId: undo.workspaceId,
                note: undo.flag.note,
                restore: undo.flag,
              });
            }}
          >
            Undo
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Flag… and Edit Flag Note… (spec §6.7): one optional line, what to continue. */
function FlagDialog({ w, onClose }: { w: FlagTarget; onClose: () => void }) {
  const editing = w.flag !== null;
  const [note, setNote] = useState(w.flag?.note ?? '');
  const save = () => {
    void trpcClient.workspaces.setFlag.mutate({ workspaceId: w.id, note });
    onClose();
  };
  return (
    <Modal
      title={editing ? `Edit flag note · ${labelOf(w)}` : `Flag ${labelOf(w)}`}
      description="Flagged workspaces stay marked on the Board and in the sidebar until you clear the flag."
      onClose={onClose}
    >
      <form
        data-flag-dialog
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className={labelClass} htmlFor="flag-note">
          What to continue <span className="text-fg-subtle">(optional)</span>
        </label>
        <input
          id="flag-note"
          data-flag-note
          className={inputClass}
          value={note}
          maxLength={FLAG_NOTE_MAX}
          placeholder="Check the Safari case, then write the e2e"
          onChange={(e) => setNote(e.target.value)}
        />
        <ModalFooter>
          <button type="button" className={button('secondary')} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" data-flag-save className={button('primary')}>
            {editing ? 'Save' : 'Flag'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** "Flag to come back later (⇧⌘G)", for the header's button. */
export const flagHint = () => `Flag to come back later (${keyHint('flag')})`;
