import { NOTE_MAX, type Note } from '@shared/notes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton, Kbd, keyHint } from '../ui/controls';
import { TrashIcon } from '../ui/icons';
import { PANEL_MIN_WIDTH, usePanelWidth } from '../ui/panel-width';

/** The side panel's width, kept in this window's storage. */
const WIDTH_KEY = 'notes-panel-width';

/** How long typing rests before an item is saved. */
const SAVE_MS = 300;

/** Puts the Claude terminal in focus, as Esc in the other panels does. */
const focusTerminal = () =>
  document.querySelector<HTMLElement>('[data-terminal] .xterm-helper-textarea')?.focus();

/** "14:05", or "Nov 8, 14:05" before today. */
function sentTime(at: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a sent item's prompt is in the Responses panel (spec §6.15). */
interface SentPrompt {
  id: string;
  sentAt: string;
  entry: number | null;
  elsewhere: boolean;
}

/**
 * An open or held item (spec §6.15): its text, saved as you type; a held
 * one is read-only until cancelled. Empty, it goes when it loses focus.
 */
const OpenNote = memo(function OpenNote({
  note,
  focus,
  selected,
  highlighted,
  waiting,
  error,
  onSelect,
  onSendNow,
  onHold,
  onCancel,
  onDelete,
}: {
  note: Note;
  focus: boolean;
  selected: boolean;
  highlighted: boolean;
  /** What held items wait on. */
  waiting: string | null;
  error: string | null;
  onSelect: (id: string, selected: boolean) => void;
  onSendNow: (ids: string[]) => void;
  onHold: (ids: string[]) => void;
  onCancel: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
}) {
  const held = note.state === 'held';
  const [text, setText] = useState(note.text);
  // The text typed and not saved yet; the saved one comes back from the list.
  const unsaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (unsaved.current === null) setText(note.text);
  }, [note.text]);
  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = unsaved.current;
    if (value === null) return;
    unsaved.current = null;
    void trpcClient.notes.setText.mutate({ id: note.id, text: value }).catch(() => {
      // the item was sent or deleted meanwhile
    });
  }, [note.id]);
  // Saved when the panel closes or the workspace changes, too.
  useEffect(() => save, [save]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const onBlur = () => {
    save();
    if (!held && !text.trim()) onDelete([note.id]);
  };
  const filled = text.trim().length > 0;
  return (
    <li
      data-note={note.id}
      data-note-state={note.state}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`border-b border-line px-3 py-2.5 transition-colors duration-300 ${highlighted ? 'bg-focus/10' : ''}`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          data-note-select
          className="mt-1.5 shrink-0 accent-fg disabled:opacity-30"
          aria-label="Select to send with others"
          title={held ? 'Queued; cancel it to send it with others' : 'Select to send with others'}
          disabled={held || !filled}
          checked={selected && !held}
          onChange={(event) => onSelect(note.id, event.target.checked)}
        />
        <textarea
          ref={ref}
          data-note-text
          value={text}
          readOnly={held}
          maxLength={NOTE_MAX}
          rows={1}
          placeholder="A thought for Claude…"
          aria-label="Note"
          className={`min-h-7 w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-md text-fg outline-none [field-sizing:content] placeholder:text-fg-subtle focus:border-focus focus:ring-[3px] focus:ring-focus/35 ${held ? 'text-fg-muted' : 'hover:border-line'}`}
          onChange={(event) => {
            setText(event.target.value);
            unsaved.current = event.target.value;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(save, SAVE_MS);
          }}
          onBlur={onBlur}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6">
        {held ? (
          <>
            <span
              data-note-queued
              className="mr-auto min-w-0 text-xs text-fg-muted"
              title="Sent by itself when Claude finishes its turn"
            >
              {waiting ?? 'Queued · sends when Claude is done'}
            </span>
            <button
              type="button"
              data-note-send-now
              className={button('ghost', 'sm')}
              title="Send it now, without waiting"
              onClick={() => onSendNow([note.id])}
            >
              Send now
            </button>
            <button
              type="button"
              data-note-cancel
              className={button('ghost', 'sm')}
              title="Don't send it; back to open"
              onClick={() => onCancel([note.id])}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="mr-auto" />
            <button
              type="button"
              data-note-send-now
              className={button('ghost', 'sm')}
              disabled={!filled}
              title="Type it into Claude now, as a quick reply"
              onClick={() => {
                save();
                onSendNow([note.id]);
              }}
            >
              Send now
            </button>
            <button
              type="button"
              data-note-hold
              className={button('ghost', 'sm')}
              disabled={!filled}
              title="Hold it and send it when Claude finishes its turn"
              onClick={() => {
                save();
                onHold([note.id]);
              }}
            >
              Send when Claude is done
            </button>
            <button
              type="button"
              data-note-delete
              className={iconButton}
              title="Delete"
              aria-label="Delete note"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onDelete([note.id])}
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" data-note-error className="mt-1 pl-6 text-xs text-st-error select-text">
          {error}
        </p>
      ) : null}
    </li>
  );
});

/** A sent item (spec §6.15): greyed, with when it went and its way to the response. */
const SentNote = memo(function SentNote({
  note,
  sent,
  highlighted,
  onViewResponse,
  onReopen,
  onDelete,
}: {
  note: Note;
  sent: SentPrompt | null;
  highlighted: boolean;
  onViewResponse: (entry: number) => void;
  onReopen: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const entry = sent?.entry ?? null;
  return (
    <li
      data-note={note.id}
      data-note-state="sent"
      data-highlighted={highlighted ? 'true' : undefined}
      className={`border-b border-line px-3 py-2.5 transition-colors duration-300 ${highlighted ? 'bg-focus/10' : ''}`}
    >
      <p
        data-note-text
        className="line-clamp-6 text-md whitespace-pre-wrap text-fg-subtle select-text"
        title={note.text}
      >
        {note.text}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span data-note-sent-at className="mr-auto font-mono text-xs text-fg-subtle">
          Sent {sentTime(note.sentAt)}
        </span>
        <button
          type="button"
          data-note-view-response
          className={button('ghost', 'sm')}
          disabled={entry === null}
          title={
            entry !== null
              ? `Open the Responses panel at prompt ${entry + 1}`
              : sent?.elsewhere
                ? "Not in Claude's current conversation"
                : 'Not in the transcript yet'
          }
          onClick={() => entry !== null && onViewResponse(entry)}
        >
          View response
        </button>
        <button
          type="button"
          data-note-copy
          className={button('ghost', 'sm')}
          onClick={() =>
            void trpcClient.clipboard.writeText
              .mutate({ text: note.text })
              .then(() => setCopied(true))
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          data-note-reopen
          className={button('ghost', 'sm')}
          title="Back to the open notes, to send it again"
          onClick={() => onReopen([note.id])}
        >
          Move back
        </button>
        <button
          type="button"
          data-note-delete
          className={iconButton}
          title="Delete"
          aria-label="Delete note"
          onClick={() => onDelete([note.id])}
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
});

/**
 * A workspace's Notes panel (spec §6.15): a scratchpad of items written
 * while Claude works, each sent when ready: now, as a quick reply, or held
 * until Claude finishes its turn; several selected go as one prompt, each
 * its own point. Sent items move to the Sent section with a way to their
 * response. Its left edge resizes it.
 */
export function NotesPanel({
  workspaceId,
  narrow,
  addRequest,
  highlight,
  onViewResponse,
  onClose,
}: {
  workspaceId: string;
  narrow: boolean;
  /** Add note asked for (⌥⌘N): a new item, in focus; `at` tells requests apart. */
  addRequest: number;
  /** Items to show: a Responses entry's "from notes" label; `at` tells requests apart. */
  highlight: { ids: string[]; at: number } | null;
  /** Opens the Responses panel at this entry (0-based). */
  onViewResponse: (entry: number) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useQuery(trpc.notes.list.queryOptions({ workspaceId }, { staleTime: 0 }));
  useSubscription(
    trpc.notes.changes.subscriptionOptions(
      { workspaceId },
      {
        onData: () =>
          void queryClient.invalidateQueries({
            queryKey: trpc.notes.list.queryKey({ workspaceId }),
          }),
      },
    ),
  );
  const refresh = useCallback(
    () =>
      void queryClient.invalidateQueries({ queryKey: trpc.notes.list.queryKey({ workspaceId }) }),
    [queryClient, trpc, workspaceId],
  );
  const notes = view.data?.notes ?? [];
  const open = notes.filter((n) => n.state !== 'sent');
  const sent = notes.filter((n) => n.state === 'sent');
  const sends = new Map((view.data?.sends ?? []).map((s) => [s.id, s]));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Only open items with text can be selected; others drop out.
  const selectable = new Set(
    open.filter((n) => n.state === 'open' && n.text.trim()).map((n) => n.id),
  );
  const chosen = [...selected].filter((id) => selectable.has(id));
  const onSelect = useCallback((id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const run = useCallback(
    (ids: string[], action: () => Promise<unknown>) => {
      setErrors((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });
      action().then(
        () => {
          setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
          refresh();
        },
        (error: unknown) => {
          setErrors((current) => ({
            ...current,
            ...Object.fromEntries(ids.map((id) => [id, message(error)])),
          }));
          refresh();
        },
      );
    },
    [refresh],
  );
  const onSendNow = useCallback(
    (ids: string[]) => run(ids, () => trpcClient.notes.sendNow.mutate({ workspaceId, ids })),
    [run, workspaceId],
  );
  const onHold = useCallback(
    (ids: string[]) => run(ids, () => trpcClient.notes.hold.mutate({ workspaceId, ids })),
    [run, workspaceId],
  );
  const onCancel = useCallback(
    (ids: string[]) => run(ids, () => trpcClient.notes.cancel.mutate({ workspaceId, ids })),
    [run, workspaceId],
  );
  const onReopen = useCallback(
    (ids: string[]) => run(ids, () => trpcClient.notes.reopen.mutate({ workspaceId, ids })),
    [run, workspaceId],
  );
  const onDelete = useCallback(
    (ids: string[]) => run(ids, () => trpcClient.notes.delete.mutate({ workspaceId, ids })),
    [run, workspaceId],
  );
  const add = useCallback(() => {
    void trpcClient.notes.add.mutate({ workspaceId }).then((note) => {
      setFocusId(note.id);
      refresh();
    });
  }, [workspaceId, refresh]);
  // ⌥⌘N, also from elsewhere in the workspace: a new item.
  const lastAdd = useRef(0);
  useEffect(() => {
    if (addRequest === lastAdd.current) return;
    lastAdd.current = addRequest;
    if (addRequest > 0) add();
  }, [addRequest, add]);

  // From a Responses entry's label: its items in view, marked for a moment.
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlight) return;
    setMarked(new Set(highlight.ids));
    const timer = setTimeout(() => setMarked(new Set()), 1500);
    return () => clearTimeout(timer);
  }, [highlight]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls once the marked items are listed
  useLayoutEffect(() => {
    const first = [...marked][0];
    if (!first) return;
    listRef.current
      ?.querySelector(`[data-note="${CSS.escape(first)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [marked, view.data]);

  const asideRef = useRef<HTMLElement>(null);
  const { width, handle } = usePanelWidth(WIDTH_KEY, asideRef, narrow ? PANEL_MIN_WIDTH : 360);
  const close = () => {
    onClose();
    focusTerminal();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
    close();
  };
  const waiting = view.data?.waiting ?? null;

  return (
    <aside
      ref={asideRef}
      data-notes-panel
      aria-label="Notes"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-line bg-canvas outline-none"
    >
      <div
        data-notes-resize
        title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-line-strong/60"
        {...handle}
      />
      <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-line bg-surface pr-2 pl-3.5">
        <span className="text-md font-semibold">Notes</span>
        <span className="font-mono text-xs text-fg-subtle">{view.data ? open.length : ''}</span>
        <span className="flex-1" />
        <button
          type="button"
          data-note-add
          className={button('ghost', 'sm')}
          title={`A new note (${keyHint('addNote')})`}
          onClick={add}
        >
          Add note <Kbd>{keyHint('addNote')}</Kbd>
        </button>
        <button
          type="button"
          className={iconButton}
          title={`Close (Esc, ${keyHint('notes')})`}
          aria-label="Close notes"
          onClick={close}
        >
          ×
        </button>
      </div>
      {chosen.length > 0 ? (
        <div
          data-notes-selection
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-raised px-3 py-1.5"
        >
          <span className="mr-auto text-sm text-fg-muted">{chosen.length} selected</span>
          <button
            type="button"
            data-notes-send-selected
            className={button('ghost', 'sm')}
            title="Send them now as one prompt, each its own point"
            onClick={() => onSendNow(chosen)}
          >
            Send now
          </button>
          <button
            type="button"
            data-notes-hold-selected
            className={button('ghost', 'sm')}
            title="Send them as one prompt when Claude finishes its turn"
            onClick={() => onHold(chosen)}
          >
            Send when done
          </button>
          <button
            type="button"
            className={button('ghost', 'sm')}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      ) : null}
      {view.error ? (
        <p role="alert" className="p-3 text-sm text-st-error select-text">
          ✕ {view.error.message}
        </p>
      ) : null}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {view.data && notes.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 p-6 text-center">
            <div className="font-medium">No notes yet</div>
            <div className="max-w-[260px] text-sm text-fg-subtle">
              Jot thoughts down while Claude works, then send them when ready. Claude can't see them
              until you do.
            </div>
          </div>
        ) : null}
        {open.length > 0 ? (
          <ul data-notes-open>
            {open.map((n) => (
              <OpenNote
                key={n.id}
                note={n}
                focus={focusId === n.id}
                selected={selected.has(n.id)}
                highlighted={marked.has(n.id)}
                waiting={n.state === 'held' ? waiting : null}
                error={errors[n.id] ?? null}
                onSelect={onSelect}
                onSendNow={onSendNow}
                onHold={onHold}
                onCancel={onCancel}
                onDelete={onDelete}
              />
            ))}
          </ul>
        ) : null}
        {sent.length > 0 ? (
          <section data-notes-sent>
            <h3 className="sticky top-0 z-1 border-b border-line bg-surface px-3.5 py-1 text-xs font-medium text-fg-subtle">
              Sent <span className="font-mono">{sent.length}</span>
            </h3>
            <ul>
              {sent.map((n) => (
                <SentNote
                  key={n.id}
                  note={n}
                  sent={n.sendId ? (sends.get(n.sendId) ?? null) : null}
                  highlighted={marked.has(n.id)}
                  onViewResponse={onViewResponse}
                  onReopen={onReopen}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
