import { NOTE_MAX, type Note, QUEUED } from '@shared/notes';
import { matchShortcut } from '@shared/shortcuts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { trpcClient, useTRPC } from '../trpc';
import { button, isMac, Kbd, keyHint } from '../ui/controls';
import { TrashIcon } from '../ui/icons';
import { PANEL_MIN_WIDTH, usePanelWidth } from '../ui/panel-width';
import { remember } from '../ui/remember';

/** The side panel's width, kept in this window's storage. */
const WIDTH_KEY = 'notes-panel-width';

/** The workspaces whose Sent section is collapsed (spec §6.15), kept in this window's storage. */
const SENT_COLLAPSED_KEY = 'notes-sent-collapsed';
/** How many workspaces it remembers; the oldest drop out. */
const SENT_COLLAPSED_MAX = 200;

function sentCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SENT_COLLAPSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Narrower than this, labels shorten (Add note becomes +, View response View). */
const COMPACT_WIDTH = 360;

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

/** A send that was refused: its reason, and the items it was for (Queue instead holds them all). */
interface Refusal {
  message: string;
  ids: string[];
}

/** Where a sent item's prompt is in the Responses panel (spec §6.15). */
interface SentPrompt {
  id: string;
  sentAt: string;
  entry: number | null;
  elsewhere: boolean;
}

/** Focus ring of a control on the panel: a 2px gap, then the ring. */
const ringOut =
  'outline-none focus-visible:shadow-[0_0_0_2px_var(--color-canvas),0_0_0_3.5px_var(--color-focus)]';
/** Focus ring of a frameless control: inset. */
const ringIn = 'outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]';
/** A frameless action in a row: muted, `band-strong` on hover (`quietLook` without its display). */
const quietLook = `h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-sm whitespace-nowrap text-fg-muted transition-colors duration-120 hover:bg-band-strong hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent ${ringIn}`;
const quiet = `inline-flex ${quietLook}`;
/** The trash button of a row: turns `st-error` on hover. */
const trash = `inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-fg-subtle transition-colors duration-120 hover:bg-band-strong hover:text-st-error ${ringIn}`;

/** A frameless 24px icon button of a row, `fg-subtle`, `fg` on hover. */
const iconQuiet = `inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-sm text-fg-subtle transition-colors duration-120 hover:bg-band-strong hover:text-fg ${ringIn}`;

/** ⤢, the Responses panel's Full view mark: opens the item in the large editor (spec §6.15). */
function ExpandButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-note-expand
      className={`${iconQuiet} ${className}`}
      title={`Open in the large editor (${keyHint('noteEditor')})`}
      aria-label="Open in the large editor"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <span aria-hidden>⤢</span>
    </button>
  );
}

/** Where in its text a click on a preview landed, for the caret; null when not on the text. */
function caretAt(event: { clientX: number; clientY: number; currentTarget: Element }) {
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!range || !event.currentTarget.contains(range.startContainer)) return null;
  return range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : null;
}

/** ⌥⌘F on a queued or sent item, or a control in it: the large editor. */
const expandKey = (onExpand: () => void) => (event: KeyboardEvent) => {
  if (matchShortcut('noteEditor', event.nativeEvent, isMac) === -1) return;
  event.preventDefault();
  onExpand();
};

/** A refused send (spec §6.15): the reason in `st-permission` with its triangle. */
function RefusalLine({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      data-note-error
      className="flex items-baseline gap-[7px] px-0.5 text-sm text-st-permission select-text"
    >
      <span className="h-2 w-[9px] shrink-0 bg-st-permission [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
      {children}
    </div>
  );
}

/**
 * An open item (spec §6.15): plain text until hovered or edited, saved as
 * you type. A long one shows its first four lines with "…" until it is
 * edited; editing, its field grows with the text up to half the panel's
 * height, then scrolls. Its checkbox and actions show on the item you're
 * on; ⌘↵ sends it, ⌥↵ holds it, ⌥⌘F opens the large editor, Esc leaves it.
 * Empty, it goes when it loses focus.
 */
const OpenNote = memo(function OpenNote({
  note,
  focus,
  selected,
  selecting,
  highlighted,
  refusal,
  onSelect,
  onSendNow,
  onHold,
  onDelete,
  onExpand,
  onLeave,
}: {
  note: Note;
  focus: boolean;
  selected: boolean;
  /** Any item is ticked: every checkbox shows, per-item actions step aside. */
  selecting: boolean;
  highlighted: boolean;
  /** Its send was refused, shown under it when it's the last item of that send. */
  refusal: Refusal | null;
  onSelect: (id: string, selected: boolean) => void;
  onSendNow: (ids: string[]) => void;
  onHold: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  /** Opens it in the large editor (spec §6.15). */
  onExpand: (id: string) => void;
  /** Esc in the field: the focus goes to the panel, so a second Esc closes it. */
  onLeave: () => void;
}) {
  const [text, setText] = useState(note.text);
  const [editing, setEditing] = useState(false);
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
  const filled = text.trim().length > 0;
  // Its preview gave way to the field: in focus, the caret where it was clicked.
  const caret = useRef<number | null>(null);
  const [opening, setOpening] = useState(false);
  useLayoutEffect(() => {
    if (!opening) return;
    setOpening(false);
    const field = ref.current;
    if (!field) return;
    field.focus();
    const at = caret.current ?? field.value.length;
    caret.current = null;
    field.setSelectionRange(at, at);
  }, [opening]);
  const expand = () => {
    save();
    onExpand(note.id);
  };
  const sendNow = () => {
    save();
    onSendNow([note.id]);
  };
  const hold = () => {
    save();
    onHold([note.id]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Leaves the item; the panel's own Esc closes it (spec §6.15).
      event.preventDefault();
      event.stopPropagation();
      onLeave();
      return;
    }
    if (matchShortcut('noteEditor', event.nativeEvent, isMac) !== -1) {
      event.preventDefault();
      if (filled) expand();
      return;
    }
    const send = matchShortcut('noteSendNow', event.nativeEvent, isMac) !== -1;
    const queue = !send && matchShortcut('noteQueue', event.nativeEvent, isMac) !== -1;
    if (!send && !queue) return;
    event.preventDefault();
    if (!filled) return;
    if (send) sendNow();
    else hold();
  };
  const shown = refusal && refusal.ids.at(-1) === note.id ? refusal : null;
  return (
    <li
      data-note={note.id}
      data-note-state={note.state}
      data-highlighted={highlighted ? 'true' : undefined}
      data-selecting={selecting ? 'true' : undefined}
      className={`group/note flex gap-2 border-b border-line py-2 pr-2.5 pl-3 transition-colors duration-300 ${
        highlighted ? 'bg-focus/10' : selected ? 'bg-band-strong' : editing ? '' : 'hover:bg-band'
      }`}
    >
      <label
        className={`relative mt-1.5 size-4 shrink-0 ${
          selected || selecting
            ? ''
            : 'opacity-0 group-focus-within/note:opacity-100 group-hover/note:opacity-100'
        } ${filled ? '' : 'invisible'}`}
        title="Select to send with others"
      >
        <input
          type="checkbox"
          data-note-select
          className="peer absolute inset-0 m-0 cursor-default opacity-0"
          aria-label="Select to send with others"
          disabled={!filled}
          checked={selected}
          onChange={(event) => onSelect(note.id, event.target.checked)}
        />
        <span
          aria-hidden
          className="pointer-events-none flex size-4 items-center justify-center rounded-[3px] border border-line-strong text-[10px] font-bold text-on-fg peer-checked:border-fg peer-checked:bg-fg peer-focus-visible:shadow-[0_0_0_2px_var(--color-canvas),0_0_0_3.5px_var(--color-focus)]"
        >
          {selected ? '✓' : ''}
        </span>
      </label>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {filled && !editing ? (
          // Not edited: its first four lines, "…" after them; a click edits it there.
          // biome-ignore lint/a11y/useSemanticElements: it stands in for the field, which replaces it on focus
          <div
            data-note-text
            data-note-preview
            role="textbox"
            tabIndex={0}
            aria-label="Note"
            className="min-h-[30px] cursor-text rounded-[5px] border border-transparent px-2 py-[5px] text-base leading-[19px] break-words whitespace-pre-wrap text-fg outline-none"
            onMouseDown={(event) => {
              caret.current = caretAt(event);
            }}
            onFocus={() => {
              setEditing(true);
              setOpening(true);
            }}
          >
            {/* Clamped inside the padding, so no fifth line shows under the "…". */}
            <span data-note-clamp className="line-clamp-4">
              {text}
            </span>
          </div>
        ) : (
          <textarea
            ref={ref}
            data-note-text
            value={text}
            maxLength={NOTE_MAX}
            rows={1}
            placeholder="A thought for Claude…"
            aria-label="Note"
            className="max-h-[50cqh] min-h-[30px] w-full resize-none rounded-[5px] border border-transparent bg-transparent px-2 py-[5px] text-base leading-[19px] text-fg outline-none [field-sizing:content] placeholder:text-fg-subtle focus:border-focus focus:bg-term"
            onChange={(event) => {
              setText(event.target.value);
              unsaved.current = event.target.value;
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(save, SAVE_MS);
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              save();
              if (!text.trim()) onDelete([note.id]);
            }}
            onKeyDown={onKeyDown}
          />
        )}
        {shown ? (
          <RefusalLine>
            <span className="min-w-0 flex-1">{shown.message}</span>
            <button
              type="button"
              data-note-queue-instead
              className={`shrink-0 rounded-[3px] px-0.5 text-sm font-medium text-fg underline underline-offset-2 ${ringIn}`}
              title="Send it when Claude is done instead"
              onClick={() => onHold(shown.ids)}
            >
              Queue instead
            </button>
          </RefusalLine>
        ) : null}
        {filled && !selecting ? (
          <div
            className={`items-center gap-1 ${
              shown ? 'flex' : 'hidden group-focus-within/note:flex group-hover/note:flex'
            }`}
          >
            <button
              type="button"
              data-note-send-now
              className={`${button('secondary', 'sm')} rounded-[5px] ${ringOut}`}
              title={`Type it into Claude now, as a quick reply (${keyHint('noteSendNow')})`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={sendNow}
            >
              Send now
              {editing ? <Kbd>{keyHint('noteSendNow')}</Kbd> : null}
            </button>
            <button
              type="button"
              data-note-hold
              className={quiet}
              title={`Hold it and send it when Claude finishes its turn (${keyHint('noteQueue')})`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={hold}
            >
              When done
              {editing ? <Kbd>{keyHint('noteQueue')}</Kbd> : null}
            </button>
            <span className="flex-1" />
            <ExpandButton onClick={expand} />
            <button
              type="button"
              data-note-delete
              className={trash}
              title="Delete"
              aria-label="Delete note"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onDelete([note.id])}
            >
              <TrashIcon />
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
});

/**
 * A held item (spec §6.15) in the Queued section: its text, read-only (its
 * first four lines, "…" after them), the Queued pill and, on the first, what
 * the items wait on; Send now sends it anyway, Cancel puts it back with the
 * open items, ⤢ shows all of it in the large editor.
 */
const HeldNote = memo(function HeldNote({
  note,
  waiting,
  highlighted,
  refusal,
  onSendNow,
  onCancel,
  onExpand,
}: {
  note: Note;
  /** What held items wait on; null on all but the first. */
  waiting: string | null;
  highlighted: boolean;
  refusal: Refusal | null;
  onSendNow: (ids: string[]) => void;
  onCancel: (ids: string[]) => void;
  onExpand: (id: string) => void;
}) {
  const gate = waiting?.startsWith('Waiting: Claude is at ') ?? false;
  return (
    <li
      data-note={note.id}
      data-note-state="held"
      data-highlighted={highlighted ? 'true' : undefined}
      className={`group/note flex gap-2 border-b border-line py-2 pr-2.5 pl-9 transition-colors duration-300 ${highlighted ? 'bg-focus/10' : 'hover:bg-band'}`}
      onKeyDown={expandKey(() => onExpand(note.id))}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <p
          data-note-text
          className="line-clamp-4 text-base leading-[1.45] break-words whitespace-pre-wrap text-fg select-text"
        >
          {note.text}
        </p>
        <div
          data-note-queued
          className="flex min-w-0 items-center gap-[7px] text-[11.5px] text-fg-muted"
          title="Sent when Claude finishes its turn"
        >
          <span className="flex h-[17px] shrink-0 items-center gap-1 rounded-[9px] border border-line-strong px-1.5 font-medium text-fg">
            <span className="box-border size-[7px] rounded-full border-[1.3px] border-current" />
            Queued
          </span>
          {waiting && waiting !== QUEUED ? (
            <span
              className={`min-w-0 truncate font-medium ${gate ? 'text-st-approval' : 'text-st-permission'}`}
              title={waiting}
            >
              {waiting}
            </span>
          ) : null}
        </div>
        {refusal ? (
          <RefusalLine>
            <span className="min-w-0 flex-1">{refusal.message}</span>
          </RefusalLine>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start gap-0.5 self-start">
        <button
          type="button"
          data-note-send-now
          className={`${quietLook} hidden group-focus-within/note:inline-flex group-hover/note:inline-flex`}
          title="Send it now, without waiting"
          onClick={() => onSendNow([note.id])}
        >
          Send now
        </button>
        <button
          type="button"
          data-note-cancel
          className={quiet}
          title="Don't send it; back to the unsent notes"
          onClick={() => onCancel([note.id])}
        >
          Cancel
        </button>
        <ExpandButton
          className="hidden group-focus-within/note:inline-flex group-hover/note:inline-flex"
          onClick={() => onExpand(note.id)}
        />
      </div>
    </li>
  );
});

/**
 * A sent item (spec §6.15): quieter, its time, and on hover or focus its
 * actions: View response, Copy, Move back, the large editor and delete.
 */
const SentNote = memo(function SentNote({
  note,
  sent,
  compact,
  highlighted,
  onViewResponse,
  onReopen,
  onDelete,
  onExpand,
}: {
  note: Note;
  sent: SentPrompt | null;
  compact: boolean;
  highlighted: boolean;
  onViewResponse: (entry: number) => void;
  onReopen: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onExpand: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const entry = sent?.entry ?? null;
  const elsewhere = entry === null && (sent?.elsewhere ?? false);
  return (
    <li
      data-note={note.id}
      data-note-state="sent"
      data-highlighted={highlighted ? 'true' : undefined}
      className={`group/note flex flex-col gap-1 transition-colors duration-300 ${highlighted ? 'bg-focus/10' : ''}`}
      onKeyDown={expandKey(() => onExpand(note.id))}
    >
      <p
        data-note-text
        className="line-clamp-2 text-md leading-[1.45] whitespace-pre-wrap text-fg-muted select-text"
        title={note.text}
      >
        {note.text}
      </p>
      <div className="flex h-6 min-w-0 items-center gap-1">
        <span
          data-note-sent-at
          className="font-mono text-[11.5px] whitespace-nowrap text-fg-subtle"
          title="When it was sent"
        >
          {sentTime(note.sentAt)}
        </span>
        {elsewhere ? (
          <span className="min-w-0 truncate text-[11.5px] text-fg-subtle">
            · Not in Claude's current conversation
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className={`items-center gap-0.5 ${copied ? 'flex' : 'hidden group-focus-within/note:flex group-hover/note:flex'}`}
        >
          {elsewhere ? null : (
            <button
              type="button"
              data-note-view-response
              className={quiet}
              disabled={entry === null}
              title={
                entry !== null
                  ? `Open the Responses panel at prompt ${entry + 1} (${keyHint('responses')})`
                  : 'Not in the transcript yet'
              }
              onClick={() => entry !== null && onViewResponse(entry)}
            >
              {compact ? 'View' : 'View response'}
            </button>
          )}
          <button
            type="button"
            data-note-copy
            className={quiet}
            title="Copy the text"
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
            className={quiet}
            title="Back to the unsent notes, to edit or send again"
            onClick={() => onReopen([note.id])}
          >
            Move back
          </button>
          <ExpandButton onClick={() => onExpand(note.id)} />
          <button
            type="button"
            data-note-delete
            className={trash}
            title="Delete"
            aria-label="Delete note"
            onClick={() => onDelete([note.id])}
          >
            <TrashIcon />
          </button>
        </span>
      </div>
    </li>
  );
});

/**
 * The large editor (spec §6.15): one item over the whole workspace area, as
 * the Responses panel's Full view, its text in a column up to 900px wide. An
 * open item is edited there, saved as you type, with Send now (⌘↵) and When
 * done (⌥↵); a queued one is read-only with Send now and Cancel, a sent one
 * read-only with Copy. Done, Esc or ⌥⌘F go back to the panel.
 */
function NoteEditor({
  note,
  waiting,
  refusal,
  onText,
  onSendNow,
  onHold,
  onCancel,
  onClose,
}: {
  note: Note;
  /** What held items wait on, for a queued one. */
  waiting: string | null;
  refusal: Refusal | null;
  /** The text typed, at once, so the panel shows it too. */
  onText: (id: string, text: string) => void;
  /** These resolve true once sent or held: the editor then goes. */
  onSendNow: (ids: string[]) => Promise<boolean>;
  onHold: (ids: string[]) => Promise<boolean>;
  onCancel: (ids: string[]) => void;
  onClose: () => void;
}) {
  const editable = note.state === 'open';
  const [text, setText] = useState(note.text);
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
  useEffect(() => save, [save]);
  const ref = useRef<HTMLTextAreaElement>(null);
  // In focus when it opens, the caret at the end of an open item's text.
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    if (editable) field.setSelectionRange(field.value.length, field.value.length);
    else field.setSelectionRange(0, 0);
  }, [editable]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const filled = text.trim().length > 0;
  const close = () => {
    save();
    onClose();
  };
  const sendNow = () => {
    save();
    void onSendNow([note.id]).then((ok) => ok && onClose());
  };
  const hold = () => {
    save();
    void onHold([note.id]).then((ok) => ok && onClose());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Esc goes back to the panel, never closes it (the panel's own Esc).
    if (event.key === 'Escape' || matchShortcut('noteEditor', event.nativeEvent, isMac) !== -1) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!editable) return;
    const send = matchShortcut('noteSendNow', event.nativeEvent, isMac) !== -1;
    const queue = !send && matchShortcut('noteQueue', event.nativeEvent, isMac) !== -1;
    if (!send && !queue) return;
    event.preventDefault();
    if (!filled) return;
    if (send) sendNow();
    else hold();
  };
  const gate = waiting?.startsWith('Waiting: Claude is at ') ?? false;
  return (
    <section
      data-note-editor
      data-note-state={note.state}
      aria-label="Note"
      className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas"
      onKeyDown={onKeyDown}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3.5">
        <span className="text-base font-semibold">Note</span>
        {note.state === 'held' ? (
          <span className="ml-1.5 flex min-w-0 items-center gap-[7px] text-[11.5px] text-fg-muted">
            <span className="flex h-[17px] shrink-0 items-center gap-1 rounded-[9px] border border-line-strong px-1.5 font-medium text-fg">
              <span className="box-border size-[7px] rounded-full border-[1.3px] border-current" />
              Queued
            </span>
            {waiting && waiting !== QUEUED ? (
              <span
                className={`min-w-0 truncate font-medium ${gate ? 'text-st-approval' : 'text-st-permission'}`}
              >
                {waiting}
              </span>
            ) : null}
          </span>
        ) : note.state === 'sent' ? (
          <span className="ml-1.5 font-mono text-[11.5px] whitespace-nowrap text-fg-subtle">
            Sent {sentTime(note.sentAt)}
          </span>
        ) : (
          <span className="ml-1.5 truncate text-sm text-fg-subtle">Saved as you type</span>
        )}
        <span className="flex-1" />
        {editable ? (
          <>
            <button
              type="button"
              data-note-send-now
              className={`${button('secondary', 'sm')} rounded-[5px] ${ringOut}`}
              disabled={!filled}
              title={`Type it into Claude now, as a quick reply (${keyHint('noteSendNow')})`}
              onClick={sendNow}
            >
              Send now <Kbd>{keyHint('noteSendNow')}</Kbd>
            </button>
            <button
              type="button"
              data-note-hold
              className={quiet}
              disabled={!filled}
              title={`Hold it and send it when Claude finishes its turn (${keyHint('noteQueue')})`}
              onClick={hold}
            >
              When done <Kbd>{keyHint('noteQueue')}</Kbd>
            </button>
          </>
        ) : note.state === 'held' ? (
          <>
            <button
              type="button"
              data-note-send-now
              className={quiet}
              title="Send it now, without waiting"
              onClick={sendNow}
            >
              Send now
            </button>
            <button
              type="button"
              data-note-cancel
              className={quiet}
              title="Don't send it; back to the unsent notes"
              onClick={() => onCancel([note.id])}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-note-copy
            className={quiet}
            title="Copy the text"
            onClick={() =>
              void trpcClient.clipboard.writeText
                .mutate({ text: note.text })
                .then(() => setCopied(true))
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        <button
          type="button"
          data-note-editor-done
          className={`${quiet} h-[26px] gap-1.5 px-2 text-md`}
          title={`Back to the Notes panel (Esc, ${keyHint('noteEditor')})`}
          onClick={close}
        >
          <span aria-hidden className="text-sm">
            ⤡
          </span>
          Done
        </button>
      </div>
      {refusal ? (
        <div className="mx-auto w-full max-w-[900px] px-6 pt-3">
          <RefusalLine>
            <span className="min-w-0 flex-1">{refusal.message}</span>
            {editable ? (
              <button
                type="button"
                data-note-queue-instead
                className={`shrink-0 rounded-[3px] px-0.5 text-sm font-medium text-fg underline underline-offset-2 ${ringIn}`}
                title="Send it when Claude is done instead"
                onClick={hold}
              >
                Queue instead
              </button>
            ) : null}
          </RefusalLine>
        </div>
      ) : null}
      <div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col px-6 py-4">
        <textarea
          ref={ref}
          data-note-editor-text
          value={editable ? text : note.text}
          readOnly={!editable}
          maxLength={NOTE_MAX}
          placeholder="A thought for Claude…"
          aria-label="Note"
          className={`min-h-0 w-full flex-1 resize-none rounded-[5px] border border-line bg-term px-3 py-2.5 text-base leading-[1.55] outline-none placeholder:text-fg-subtle focus:border-focus ${editable ? 'text-fg' : 'text-fg-muted'}`}
          onChange={(event) => {
            setText(event.target.value);
            unsaved.current = event.target.value;
            onText(note.id, event.target.value);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(save, SAVE_MS);
          }}
        />
      </div>
    </section>
  );
}

/** Sent items in runs that went out in the same prompt, newest first. */
function bySend(sent: readonly Note[]): Note[][] {
  const runs: Note[][] = [];
  for (const note of sent) {
    const last = runs.at(-1);
    if (last && note.sendId && last[0]?.sendId === note.sendId) last.push(note);
    else runs.push([note]);
  }
  return runs;
}

/**
 * A workspace's Notes panel (spec §6.15): a scratchpad of items written
 * while Claude works, each sent when ready: now, as a quick reply, or held
 * until Claude finishes its turn; several go as one prompt, each its own
 * point. Unsent items first, then the Queued section, then Sent, which
 * collapses. Its left edge resizes it.
 */
export function NotesPanel({
  workspaceId,
  narrow,
  addRequest,
  onAddHandled,
  highlight,
  onViewResponse,
  onClose,
  overlay,
}: {
  workspaceId: string;
  narrow: boolean;
  /** The workspace area, where the large editor goes over the terminal and the panels. */
  overlay: HTMLElement | null;
  /** Add note asked for (⌥⌘N), by when: a new item, in focus; null when none is waiting. */
  addRequest: number | null;
  /** The request was handled: it is cleared, so opening the panel again adds nothing. */
  onAddHandled: () => void;
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
  const open = notes.filter((n) => n.state === 'open');
  const held = notes.filter((n) => n.state === 'held');
  const sent = notes.filter((n) => n.state === 'sent');
  const sends = new Map((view.data?.sends ?? []).map((s) => [s.id, s]));
  // Open items with text: what "All n, as one prompt" sends, in the panel's order.
  const filled = open.filter((n) => n.text.trim()).map((n) => n.id);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Only open items with text can be selected; others drop out.
  const chosen = [...selected].filter((id) => filled.includes(id));
  const selecting = chosen.length > 0;
  const onSelect = useCallback((id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const [refusals, setRefusals] = useState<Record<string, Refusal>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Runs an action on items: true once it went through, false with its refusal shown. */
  const run = useCallback(
    (ids: string[], action: () => Promise<unknown>): Promise<boolean> => {
      setRefusals((current) => {
        const next = { ...current };
        for (const id of ids) delete next[id];
        return next;
      });
      return action().then(
        () => {
          setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
          refresh();
          return true;
        },
        (error: unknown) => {
          const refusal = { message: message(error), ids };
          setRefusals((current) => ({
            ...current,
            ...Object.fromEntries(ids.map((id) => [id, refusal])),
          }));
          refresh();
          return false;
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
  // The large editor (spec §6.15): one item over the workspace area.
  const [editorId, setEditorId] = useState<string | null>(null);
  const editorNote = editorId ? (notes.find((n) => n.id === editorId) ?? null) : null;
  // A deleted item takes its editor with it.
  useEffect(() => {
    if (editorId && view.data && !editorNote) setEditorId(null);
  }, [editorId, editorNote, view.data]);
  const onExpand = useCallback((id: string) => setEditorId(id), []);
  // What the editor types shows in the panel at once; it saves on its own.
  const onEditorText = useCallback(
    (id: string, text: string) =>
      queryClient.setQueryData(trpc.notes.list.queryKey({ workspaceId }), (current) =>
        current
          ? { ...current, notes: current.notes.map((n) => (n.id === id ? { ...n, text } : n)) }
          : current,
      ),
    [queryClient, trpc, workspaceId],
  );
  /** Back from the editor: the item in focus again in the panel, where it still is. */
  const closeEditor = useCallback(() => {
    const id = editorId;
    setEditorId(null);
    requestAnimationFrame(() => {
      const item = listRef.current?.querySelector(`[data-note="${CSS.escape(id ?? '')}"]`);
      const target =
        item?.querySelector<HTMLElement>('[data-note-preview], textarea[data-note-text]') ??
        item?.querySelector<HTMLElement>('[data-note-expand]') ??
        asideRef.current;
      target?.focus();
    });
  }, [editorId]);
  const add = useCallback(() => {
    void trpcClient.notes.add.mutate({ workspaceId }).then((note) => {
      setFocusId(note.id);
      refresh();
    });
  }, [workspaceId, refresh]);
  // ⌥⌘N, also from elsewhere in the workspace: a new item, once per request.
  const lastAdd = useRef<number | null>(null);
  useEffect(() => {
    if (addRequest === null || addRequest === lastAdd.current) return;
    lastAdd.current = addRequest;
    add();
    onAddHandled();
  }, [addRequest, add, onAddHandled]);

  // The Sent section, collapsed or not, per workspace.
  const [sentOpen, setSentOpen] = useState(() => !sentCollapsed().includes(workspaceId));
  useEffect(() => setSentOpen(!sentCollapsed().includes(workspaceId)), [workspaceId]);
  const toggleSent = () => {
    const open = !sentOpen;
    setSentOpen(open);
    const rest = sentCollapsed().filter((id) => id !== workspaceId);
    const next = open ? rest : [...rest, workspaceId].slice(-SENT_COLLAPSED_MAX);
    remember(SENT_COLLAPSED_KEY, next.length ? JSON.stringify(next) : null);
  };

  // From a Responses entry's label: its items in view, marked for a moment.
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlight) return;
    setMarked(new Set(highlight.ids));
    // Sent items to show: the section opens (not remembered).
    setSentOpen(true);
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
  const compact = width < COMPACT_WIDTH;
  const close = () => {
    onClose();
    focusTerminal();
  };
  const leaveNote = useCallback(() => asideRef.current?.focus(), []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
    close();
  };
  const waiting = view.data?.waiting ?? null;
  const counts = view.data
    ? [
        open.length + held.length ? `${open.length + held.length} unsent` : '',
        held.length ? `${held.length} queued` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <aside
      ref={asideRef}
      data-notes-panel
      aria-label="Notes"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ width }}
      // A size container: an item's field grows to half the panel's height (50cqh).
      className="relative flex min-h-0 shrink-0 flex-col border-l border-line bg-canvas outline-none [container-type:size]"
    >
      {editorNote && overlay
        ? createPortal(
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              waiting={editorNote.state === 'held' ? waiting : null}
              refusal={refusals[editorNote.id] ?? null}
              onText={onEditorText}
              onSendNow={onSendNow}
              onHold={onHold}
              onCancel={onCancel}
              onClose={closeEditor}
            />,
            overlay,
          )
        : null}
      <div
        data-notes-resize
        title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-line-strong/60"
        {...handle}
      />
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3.5">
        <span className="text-base font-semibold">Notes</span>
        <span data-notes-count className="truncate text-sm whitespace-nowrap text-fg-subtle">
          {counts}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-note-add
          className={`inline-flex h-[26px] shrink-0 items-center gap-[7px] rounded-[5px] px-2 text-md whitespace-nowrap text-fg transition-colors duration-120 hover:bg-band-strong ${ringIn}`}
          title={`Add note (${keyHint('addNote')})`}
          aria-label="Add note"
          onClick={add}
        >
          <span className="text-[14px] leading-none text-fg-muted">+</span>
          {compact ? null : (
            <>
              Add note <Kbd>{keyHint('addNote')}</Kbd>
            </>
          )}
        </button>
        <button
          type="button"
          className={`inline-flex size-[26px] shrink-0 items-center justify-center rounded-[5px] text-base text-fg-muted transition-colors duration-120 hover:bg-band-strong hover:text-fg ${ringIn}`}
          title={`Close (Esc, ${keyHint('notes')})`}
          aria-label="Close notes"
          onClick={close}
        >
          ×
        </button>
      </div>
      {view.error ? (
        <p role="alert" className="p-3 text-sm text-st-error select-text">
          ✕ {view.error.message}
        </p>
      ) : null}
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view.data && notes.length === 0 ? (
          <div
            data-notes-empty
            className="flex flex-1 flex-col items-start justify-center gap-3 px-7 pt-6 pb-20"
          >
            <p className="text-md leading-[1.55] text-pretty text-fg-muted">
              Jot down thoughts while Claude works. They stay private until you send them, one at a
              time or together as one prompt.
            </p>
            <button
              type="button"
              className={`${button('secondary', 'md')} rounded-[5px] ${ringOut}`}
              onClick={add}
            >
              Add note <Kbd>{keyHint('addNote')}</Kbd>
            </button>
          </div>
        ) : null}
        {open.length > 0 ? (
          <ul data-notes-open>
            {open.map((n) => (
              <OpenNote
                key={n.id}
                note={n}
                focus={focusId === n.id}
                selected={chosen.includes(n.id)}
                selecting={selecting}
                highlighted={marked.has(n.id)}
                refusal={refusals[n.id] ?? null}
                onSelect={onSelect}
                onSendNow={onSendNow}
                onHold={onHold}
                onDelete={onDelete}
                onExpand={onExpand}
                onLeave={leaveNote}
              />
            ))}
          </ul>
        ) : null}
        {held.length > 0 ? (
          <section data-notes-queued-section>
            <h3 className="flex h-[30px] shrink-0 items-center gap-[7px] px-3.5 pt-2.5 text-[11.5px] font-semibold text-fg-subtle">
              Queued <span className="font-mono font-normal">{held.length}</span>
              <span className="ml-1 h-px flex-1 bg-line" />
            </h3>
            <ul data-notes-queued>
              {held.map((n, i) => (
                <HeldNote
                  key={n.id}
                  note={n}
                  waiting={i === 0 ? waiting : null}
                  highlighted={marked.has(n.id)}
                  refusal={refusals[n.id] ?? null}
                  onSendNow={onSendNow}
                  onCancel={onCancel}
                  onExpand={onExpand}
                />
              ))}
            </ul>
          </section>
        ) : null}
        {sent.length > 0 ? (
          <section data-notes-sent data-collapsed={sentOpen ? 'false' : 'true'}>
            <button
              type="button"
              data-notes-sent-toggle
              aria-expanded={sentOpen}
              className={`mt-2.5 flex h-[34px] w-full items-center gap-[7px] px-3.5 text-left text-[11.5px] font-semibold text-fg-subtle hover:text-fg-muted ${ringIn}`}
              title={sentOpen ? 'Collapse the sent notes' : 'Show the sent notes'}
              onClick={toggleSent}
            >
              <span className="w-2 text-[8px]">{sentOpen ? '▼' : '▶'}</span>
              Sent <span className="font-mono font-normal">{sent.length}</span>
              <span className="ml-1 h-px flex-1 bg-line" />
            </button>
            {sentOpen ? (
              <ul>
                {bySend(sent).map((run) => (
                  <li
                    key={run[0]?.id}
                    data-notes-send={run[0]?.sendId ?? undefined}
                    className="flex flex-col gap-1 border-b border-line pt-[7px] pr-2.5 pb-[5px] pl-9 hover:bg-band focus-within:bg-band"
                  >
                    {run.length > 1 ? (
                      <span className="text-xs text-fg-subtle">Sent together as one prompt</span>
                    ) : null}
                    <ul
                      className={
                        run.length > 1
                          ? 'flex flex-col gap-1 border-l-2 border-line-strong pl-[9px]'
                          : 'flex flex-col'
                      }
                    >
                      {run.map((n) => (
                        <SentNote
                          key={n.id}
                          note={n}
                          sent={n.sendId ? (sends.get(n.sendId) ?? null) : null}
                          compact={compact}
                          highlighted={marked.has(n.id)}
                          onViewResponse={onViewResponse}
                          onReopen={onReopen}
                          onDelete={onDelete}
                          onExpand={onExpand}
                        />
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
      {selecting || filled.length > 1 ? (
        <div
          data-notes-footer
          data-notes-selection={selecting ? '' : undefined}
          className={`flex h-11 shrink-0 items-center gap-1.5 border-t border-line pr-2.5 pl-3.5 ${selecting ? 'bg-raised' : 'bg-surface'}`}
        >
          <span
            className={`min-w-0 truncate text-md whitespace-nowrap ${selecting ? 'font-semibold text-fg' : 'text-fg-muted'}`}
          >
            {selecting ? `${chosen.length} selected` : `All ${filled.length}, as one prompt`}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-notes-send-selected
            className={`${button('primary', 'md')} h-[26px] rounded-[5px] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-surface),0_0_0_3.5px_var(--color-focus)]`}
            title={
              selecting
                ? 'Send the selected notes now as one prompt, each its own point'
                : 'Send all unsent notes now as one prompt, each its own point'
            }
            onClick={() => onSendNow(selecting ? chosen : filled)}
          >
            Send now
          </button>
          <button
            type="button"
            data-notes-hold-selected
            className={`${button('secondary', 'md')} h-[26px] rounded-[5px] ${ringOut}`}
            title="Send them as one prompt when Claude finishes its turn"
            onClick={() => onHold(selecting ? chosen : filled)}
          >
            {compact ? 'When done' : 'Send when done'}
          </button>
          {selecting ? (
            <button
              type="button"
              className={`${quiet} h-[26px] text-md`}
              title="Clear the selection"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
