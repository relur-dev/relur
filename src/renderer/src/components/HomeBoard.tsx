import {
  type BoardLayout,
  canMove,
  moveColumn,
  placeColumn,
  setHidden,
  shownColumns,
} from '@shared/board-layout';
import {
  BOARD_COLUMN_TITLE,
  BOARD_COLUMNS,
  type BoardColumn,
  boardColumns,
  type HomeSection,
  QUICK_REPLY_REFUSAL,
  quickReply,
} from '@shared/home';
import type { MemorySnapshot } from '@shared/memory';
import type { Profile, Project } from '@shared/schemas';
import { backgroundNote, STATE_LABEL } from '@shared/status';
import { SUSPENDED_TOOLTIP } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import { workspaceGlyph } from '@shared/unfinished';
import type { Workspace } from '@shared/workspaces';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { trpcClient, useTRPC } from '../trpc';
import { useLaunching } from '../ui/launching';
import { StatusGlyph } from '../ui/StatusGlyph';
import { useSuspended } from '../ui/suspended';
import {
  Action,
  type HomeActions,
  type HomeItem,
  type Part,
  runningMark,
  Sep,
  TONE,
  useHomeItems,
  useNow,
  useShipStates,
} from './home-items';

/** The column's List section, whose rules and actions it shares (spec §6.7). */
const SECTION_OF: Record<Exclude<BoardColumn, 'idle'>, HomeSection> = {
  needs: 'needs',
  working: 'working',
  ship: 'ship',
  merged: 'clean',
};

/** Pointer travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

/** How near the Board's side a dragged column header scrolls it, and by how much. */
const EDGE = 40;
const EDGE_STEP = 14;

/** How long a card says its quick reply was sent. */
const SENT_MS = 2400;

interface Drag {
  id: string;
  /** The pointer's offset in the card, and the card's size. */
  dx: number;
  dy: number;
  width: number;
  /** Over the Drop to delete zone. */
  over: boolean;
  reduced: boolean;
}

/** A column header lifted to move it (spec §6.7); `index` where it lands among the shown ones. */
interface ColumnDrag {
  column: BoardColumn;
  index: number;
}

/**
 * Needs you stands out while it has cards (spec §6.7): its count in the most
 * urgent card's color, as the sidebar's (permission, then input), on a tint.
 */
export type NeedsTone = 'permission' | 'input';
export const needsTone = (list: Pick<Workspace, 'state'>[]): NeedsTone =>
  list.some((w) => w.state === 'needs-permission') ? 'permission' : 'input';
const NEEDS_TONE: Record<NeedsTone, string> = {
  permission:
    'border-[color-mix(in_oklab,var(--color-st-permission)_35%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-st-permission)_6%,var(--color-canvas))]',
  input:
    'border-[color-mix(in_oklab,var(--color-st-input)_35%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-st-input)_6%,var(--color-canvas))]',
};
const TONE_TEXT: Record<NeedsTone, string> = {
  permission: 'text-st-permission',
  input: 'text-st-input',
};

const cardLabel = (w: Workspace) => w.task.id ?? (w.task.title || w.name);

/**
 * Home's Board (spec §6.7): the profile's workspaces in five status columns,
 * by the List's rules, in the order the profile arranged them and without
 * the ones it hid. Cards move by themselves as states change; the only card
 * drag target is Drop to delete, which opens the Delete workspace dialog. A
 * column moves by dragging its header or from its menu.
 */
export function HomeBoard({
  profile,
  projects,
  workspaces,
  sessions,
  memory,
  actions,
  layout,
  onLayout,
}: {
  profile: Profile;
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  memory: MemorySnapshot | null;
  actions: HomeActions;
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const launching = useLaunching();
  const suspended = useSuspended();
  const ship = useShipStates(workspaces);
  const now = useNow();
  const item = useHomeItems({ profile, sessions, memory, actions, ship, now });
  const columns = boardColumns(workspaces, ship);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '';

  // Drafts change as keys are typed into a terminal: read them often while shown.
  const drafts = useQuery(
    trpc.sessions.drafts.queryOptions(undefined, { refetchInterval: 3_000, staleTime: 0 }),
  );
  const refreshDrafts = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.sessions.drafts.queryKey() });
  const claudeOf = (id: string) =>
    sessions.find((s) => s.workspaceId === id && s.kind === 'claude' && s.status !== 'exited') ??
    null;

  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, 'working' | 'idle'>>({});
  const [replyErrors, setReplyErrors] = useState<Record<string, string | null>>({});
  const send = useMutation(trpc.workspaces.quickReply.mutationOptions());
  const sendReply = (w: Workspace, column: BoardColumn) => {
    const text = (replies[w.id] ?? '').trim();
    if (!text) return;
    setReplyErrors((e) => ({ ...e, [w.id]: null }));
    send.mutate(
      { workspaceId: w.id, text },
      {
        onSuccess: () => {
          setReplies((r) => ({ ...r, [w.id]: '' }));
          setSent((s) => ({ ...s, [w.id]: column === 'working' ? 'working' : 'idle' }));
          setTimeout(
            () =>
              setSent((s) => {
                const next = { ...s };
                delete next[w.id];
                return next;
              }),
            SENT_MS,
          );
        },
        onError: (e) => {
          setReplyErrors((r) => ({ ...r, [w.id]: e.message }));
          refreshDrafts();
        },
      },
    );
  };

  // Keyboard (spec §6.7): ↑↓ in a column, ←→ to the next one, ↵ opens, Delete or ⌫ deletes.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const focusCard = (card: HTMLElement | null | undefined) => {
    card?.focus();
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-board-card]');
    // Only from a card itself or the Board: its buttons and field keep their keys.
    if (card ? target !== card : target !== root.current) return;
    const cardsOf = (column: Element | null) => [
      ...(column?.querySelectorAll<HTMLElement>('[data-board-card]') ?? []),
    ];
    const columnEls = [...(root.current?.querySelectorAll('[data-board-column]') ?? [])];
    const go = (next: HTMLElement | null | undefined) => {
      e.preventDefault();
      focusCard(next);
    };
    if (!card) {
      if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
        go(root.current?.querySelector<HTMLElement>('[data-board-card]'));
      }
      return;
    }
    const w = workspaces.find((x) => x.id === card.dataset.boardCard);
    const column = card.closest('[data-board-column]');
    const cards = cardsOf(column);
    const at = cards.indexOf(card);
    if (e.key === 'ArrowDown') go(cards[Math.min(cards.length - 1, at + 1)]);
    else if (e.key === 'ArrowUp') go(cards[Math.max(0, at - 1)]);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // The nearest column with cards that way, at the card nearest in height.
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const top = card.getBoundingClientRect().top;
      for (
        let i = columnEls.indexOf(column as Element) + step;
        i >= 0 && i < columnEls.length;
        i += step
      ) {
        const there = cardsOf(columnEls[i] ?? null);
        if (there.length === 0) continue;
        const nearest = there.reduce((a, b) =>
          Math.abs(b.getBoundingClientRect().top - top) <
          Math.abs(a.getBoundingClientRect().top - top)
            ? b
            : a,
        );
        go(nearest);
        return;
      }
      e.preventDefault();
    } else if (e.key === 'Enter' && w) {
      e.preventDefault();
      actions.open(w);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && w) {
      e.preventDefault();
      actions.delete(w);
    }
  };

  // Drag to delete: a press that moves lifts the card; only the zone takes it.
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ id: string; x: number; y: number; card: HTMLElement } | null>(null);
  const float = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** A click right after a drop isn't a click on the card. */
  const dropped = useRef(false);
  /** A drag ended with Esc: its pointer is still down, and its release isn't a click either. */
  const cancelled = useRef(false);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const deleteRef = useRef(actions.delete);
  deleteRef.current = actions.delete;

  // Drag a column's header to move it (spec §6.7): only from a header, never with a card.
  const [columnDrag, setColumnDrag] = useState<(ColumnDrag & { at: number | null }) | null>(null);
  const columnPress = useRef<{ column: BoardColumn; x: number; y: number } | null>(null);
  const columnDragRef = useRef<ColumnDrag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  useEffect(() => {
    const place = (x: number, y: number) => {
      const d = dragRef.current;
      if (float.current && d) {
        float.current.style.left = `${x - d.dx}px`;
        float.current.style.top = `${y - d.dy}px`;
      }
    };
    const overZone = (x: number, y: number) => {
      const r = zone.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const end = () => {
      press.current = null;
      setDrag(null);
      columnPress.current = null;
      columnDragRef.current = null;
      setColumnDrag(null);
    };
    /** Where a dragged header lands: among the other shown columns, by their middles. */
    const columnTarget = (column: BoardColumn, x: number) => {
      const el = scroller.current;
      if (!el) return null;
      const others = [...el.querySelectorAll<HTMLElement>('[data-board-column]')]
        .filter((c) => c.dataset.boardColumn !== column)
        .map((c) => c.getBoundingClientRect());
      const index = others.filter((r) => (r.left + r.right) / 2 < x).length;
      const box = el.getBoundingClientRect();
      // The line between the columns it lands between; none where it already is.
      const edge = others[index] ? others[index].left - 6 : (others.at(-1)?.right ?? 0) + 6;
      const unchanged = shownColumns(layoutRef.current).indexOf(column) === index;
      return { column, index, at: unchanged ? null : edge - box.left + el.scrollLeft };
    };
    const onColumnMove = (e: PointerEvent, p: { column: BoardColumn; x: number; y: number }) => {
      if (!columnDragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        (document.activeElement as HTMLElement | null)?.blur();
      }
      // Near a side the Board scrolls, so a column can go past what shows.
      const el = scroller.current;
      if (el) {
        const box = el.getBoundingClientRect();
        if (e.clientX < box.left + EDGE) el.scrollLeft -= EDGE_STEP;
        else if (e.clientX > box.right - EDGE) el.scrollLeft += EDGE_STEP;
      }
      const next = columnTarget(p.column, e.clientX);
      if (!next) return;
      columnDragRef.current = next;
      setColumnDrag((d) => (d && d.index === next.index && d.at === next.at ? d : next));
    };
    const onMove = (e: PointerEvent) => {
      if (columnPress.current) {
        onColumnMove(e, columnPress.current);
        return;
      }
      const p = press.current;
      if (!p) return;
      const d = dragRef.current;
      if (!d) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        const r = p.card.getBoundingClientRect();
        const next: Drag = {
          id: p.id,
          dx: p.x - r.left,
          dy: p.y - r.top,
          width: r.width,
          over: false,
          reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        };
        dragRef.current = next;
        setDrag(next);
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      place(e.clientX, e.clientY);
      const over = overZone(e.clientX, e.clientY);
      if (over !== d.over) setDrag({ ...d, over });
    };
    const swallowClick = () => {
      dropped.current = true;
      setTimeout(() => {
        dropped.current = false;
      }, 0);
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (cancelled.current) {
        cancelled.current = false;
        swallowClick();
      }
      if (columnPress.current) {
        const c = columnDragRef.current;
        end();
        if (!c) return;
        swallowClick();
        const next = placeColumn(layoutRef.current, c.column, c.index);
        const before = shownColumns(layoutRef.current).join();
        if (shownColumns(next).join() !== before) onLayoutRef.current(next);
        return;
      }
      if (!d) {
        press.current = null;
        return;
      }
      swallowClick();
      const w = workspacesRef.current.find((x) => x.id === d.id);
      end();
      if (w && overZone(e.clientX, e.clientY)) deleteRef.current(w);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !(dragRef.current || columnDragRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      end();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  /**
   * The lifted card starts where the pointer took it, then follows it. Stable,
   * so a render while it is lifted (over the zone) doesn't put it back.
   */
  const floatRef = useCallback((el: HTMLDivElement | null) => {
    const p = press.current;
    const d = dragRef.current;
    if (el && el !== float.current && p && d) {
      el.style.left = `${p.x - d.dx}px`;
      el.style.top = `${p.y - d.dy}px`;
    }
    float.current = el;
  }, []);

  /**
   * A column's menu (spec §6.7), from its ⋯ button or a right click on its
   * header: Move Left, Move Right and Hide Column, each off where it can't.
   * From the button, focus stays on the moved column's button (after Hide,
   * the next shown column's).
   */
  const focusAfter = useRef<BoardColumn | null>(null);
  const columnMenu = async (column: BoardColumn, fromButton: boolean) => {
    const shown = shownColumns(layout);
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [
        { id: 'left', label: 'Move Left', enabled: canMove(layout, column, -1) },
        { id: 'right', label: 'Move Right', enabled: canMove(layout, column, 1) },
        { id: 'hide', label: 'Hide Column', enabled: shown.length > 1 },
      ],
    });
    const now = layoutRef.current;
    let next = now;
    let focus = column;
    if (choice === 'left' || choice === 'right') {
      next = moveColumn(now, column, choice === 'left' ? -1 : 1);
    } else if (choice === 'hide') {
      const visible = shownColumns(now);
      const at = visible.indexOf(column);
      focus = visible[at + 1] ?? visible[at - 1] ?? column;
      next = setHidden(now, column, true);
    }
    if (fromButton && choice) focusAfter.current = focus;
    if (next !== now) onLayout(next);
    else refocus();
  };
  const refocus = () => {
    const column = focusAfter.current;
    focusAfter.current = null;
    if (column)
      root.current
        ?.querySelector<HTMLElement>(`[data-board-column="${column}"] [data-board-column-menu]`)
        ?.focus();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the moved column has rendered
  useEffect(refocus, [layout]);

  /** What a card shows: its List section's item, or Idle's own. */
  const cardItem = (column: BoardColumn, w: Workspace): HomeItem => {
    if (column !== 'idle') return item(SECTION_OF[column], w, true);
    // Done keeps its quiet mark for a dev server (spec §10.2); other states their note.
    const note = backgroundNote(w.state, w.background);
    const background: Part | null = runningMark(w) ?? (note ? { text: note } : null);
    const text = suspended.has(w.id)
      ? 'Suspended'
      : w.state === 'error' && w.stateMessage
        ? w.stateMessage
        : STATE_LABEL[w.state];
    return {
      glyph: workspaceGlyph(w, launching.has(w.id)) ?? 'exited',
      parts: [{ text }, ...(background ? [background] : [])],
      dotted: true,
      buttons: [
        <Action
          key="open"
          kind="secondary"
          size="card"
          data="open"
          title={
            suspended.has(w.id) ? 'Open the workspace; its Claude resumes' : 'Open the workspace'
          }
          onClick={() => actions.open(w)}
        >
          Open
        </Action>,
      ],
      hover: [],
      meta: null,
      title: null,
      error: null,
    };
  };

  const card = (column: BoardColumn, w: Workspace) => {
    const it = cardItem(column, w);
    const lifted = drag?.id === w.id;
    const claude = claudeOf(w.id);
    const offer = quickReply(w, column, {
      claude,
      draft: drafts.data?.includes(w.id) ?? false,
    });
    const text = replies[w.id] ?? '';
    const wasSent = sent[w.id];
    const permission = offer === 'open';
    // Needs permission shows Open in the field's place, not again below.
    const main = permission ? [] : it.buttons;
    const always = column === 'needs';
    /** Under Needs you the field is always there; elsewhere it unfolds with the actions. */
    const unfold = (node: ReactNode) =>
      always ? node : <Unfold shown={text !== ''}>{node}</Unfold>;
    const error = replyErrors[w.id] ?? it.error;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a card holds its own buttons and field
      // biome-ignore lint/a11y/useKeyWithClickEvents: the Board handles ↵, Delete and ⌫ on cards
      <div
        key={w.id}
        role="button"
        tabIndex={0}
        data-board-card={w.id}
        data-board-lifted={lifted || undefined}
        title={`${w.task.id ? `${w.task.id} ` : ''}${w.task.title || w.name} · click to open, drag to delete`}
        className={`group flex flex-none cursor-default touch-none flex-col rounded-[7px] border py-[9px] pr-2.5 pl-[11px] outline-none select-none focus-visible:outline-none ${
          lifted
            ? 'border-dashed border-line-strong bg-transparent'
            : 'border-line bg-raised hover:border-line-strong focus-visible:border-focus focus-visible:shadow-[0_0_0_1px_var(--color-focus)] has-[:focus-visible]:border-focus has-[:focus-visible]:shadow-[0_0_0_1px_var(--color-focus)]'
        }`}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a')) return;
          press.current = { id: w.id, x: e.clientX, y: e.clientY, card: e.currentTarget };
        }}
        onClick={() => {
          if (!dropped.current) actions.open(w);
        }}
        // A card focused near the column's edge stays in view once it has unfolded.
        onTransitionEnd={(e) => {
          if (
            e.propertyName === 'grid-template-rows' &&
            e.currentTarget.contains(document.activeElement)
          )
            e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <div className={`flex flex-col gap-[5px] ${lifted ? 'opacity-0' : ''}`}>
          <CardBody
            w={w}
            it={it}
            project={projectName(w.projectId)}
            suspended={suspended.has(w.id) && column !== 'idle'}
          />
          {offer === 'field' && !lifted && !wasSent
            ? unfold(
                <div className="relative mt-[3px] flex">
                  <input
                    data-quick-reply
                    value={text}
                    placeholder={placeholder(column, w, suspended.has(w.id))}
                    aria-label={`Message Claude in ${cardLabel(w)}`}
                    disabled={send.isPending && send.variables?.workspaceId === w.id}
                    className="box-border h-7 w-full rounded-[5px] border border-line bg-term pr-7 pl-2 text-sm text-ellipsis text-fg outline-none placeholder:text-fg-subtle focus:border-focus focus:shadow-[0_0_0_1px_var(--color-focus)]"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onFocus={refreshDrafts}
                    onChange={(e) => {
                      const value = e.target.value;
                      setReplies((r) => ({ ...r, [w.id]: value }));
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        sendReply(w, column);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        (
                          e.currentTarget.closest('[data-board-card]') as HTMLElement | null
                        )?.focus();
                      }
                    }}
                  />
                  <span
                    title="Send ↵"
                    className={`pointer-events-none absolute top-[5px] right-[5px] box-border flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-line font-mono text-xs ${
                      text.trim() ? 'bg-raised text-fg' : 'text-fg-subtle'
                    }`}
                  >
                    ↵
                  </span>
                </div>,
              )
            : null}
          {offer === 'open' && !lifted ? (
            <div
              data-quick-reply-open
              className="mt-[3px] flex h-7 items-center gap-2 text-sm text-fg-subtle"
            >
              <Action
                kind="secondary"
                size="card"
                data="open"
                title="Open the Claude tab to allow or deny"
                onClick={() => actions.open(w)}
              >
                Open
              </Action>
              <span className="min-w-0 truncate">Answer it in the Claude tab</span>
            </div>
          ) : null}
          {offer === 'draft' && !lifted
            ? unfold(
                <button
                  type="button"
                  data-quick-reply-draft
                  className="mt-[3px] flex h-7 items-center self-start rounded-[5px] text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline outline-none focus-visible:shadow-[0_0_0_2px_var(--color-raised),0_0_0_3.5px_var(--color-focus)]"
                  title="Its Claude tab has text you typed and didn't send"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.open(w);
                  }}
                >
                  {QUICK_REPLY_REFUSAL.draft}
                </button>,
              )
            : null}
          {wasSent && !lifted ? (
            <div
              data-quick-reply-sent
              className="mt-[3px] flex h-7 items-center gap-1.5 text-sm text-fg-subtle"
            >
              <span className="text-diff-add">✓</span>
              {wasSent === 'working' ? 'Sent · Claude reads it after this step' : 'Sent to Claude'}
            </div>
          ) : null}
          {error ? (
            <span role="alert" className="text-sm text-st-error">
              ✕ {error}
            </span>
          ) : null}
          {!drag ? (
            <Unfold>
              <div className="mt-0.5 flex items-center gap-1.5 border-t border-line pt-[7px]">
                {main}
                <span className="flex-1" />
                <button
                  type="button"
                  data-home-action="delete"
                  title="Delete workspace…"
                  className="flex h-6 items-center rounded-[5px] px-[7px] text-sm text-fg-subtle outline-none hover:bg-band-strong hover:text-st-error focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.delete(w);
                  }}
                >
                  Delete
                </button>
              </div>
            </Unfold>
          ) : null}
        </div>
      </div>
    );
  };

  const lifted = drag ? workspaces.find((w) => w.id === drag.id) : undefined;
  const liftedColumn = lifted
    ? BOARD_COLUMNS.find((c) => columns[c].some((w) => w.id === lifted.id))
    : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the cards inside it
    <div
      ref={root}
      tabIndex={-1}
      data-home-board={drag ? 'dragging' : ''}
      data-board-column-drag={columnDrag?.column}
      className={`relative flex min-h-0 flex-1 flex-col bg-term outline-none ${columnDrag ? 'cursor-grabbing' : ''}`}
      onKeyDown={onKeyDown}
    >
      <div
        ref={scroller}
        className={`relative flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden px-6 pt-[18px] ${drag ? 'pb-[112px]' : 'pb-5'}`}
      >
        {shownColumns(layout).map((column) => {
          const list = columns[column];
          const tone = column === 'needs' && list.length > 0 ? needsTone(list) : null;
          const moving = columnDrag?.column === column;
          return (
            <section
              key={column}
              data-board-column={column}
              data-board-tone={tone ?? undefined}
              data-board-column-lifted={moving || undefined}
              aria-label={BOARD_COLUMN_TITLE[column]}
              className={`flex min-h-0 min-w-[220px] flex-[1_0_220px] flex-col rounded-lg border ${
                moving
                  ? 'border-dashed border-line-strong bg-canvas'
                  : tone
                    ? NEEDS_TONE[tone]
                    : 'border-line bg-canvas'
              }`}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: dragging a header moves its column; its menu button does the same from the keyboard */}
              <div
                data-board-column-header
                title="Drag to move the column"
                className={`group/header flex h-10 flex-none touch-none items-center gap-2 pr-2 pl-3 select-none ${moving ? 'opacity-60' : ''}`}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
                  if (dragRef.current) return;
                  columnPress.current = { column, x: e.clientX, y: e.clientY };
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void columnMenu(column, false);
                }}
              >
                <h2 className="text-base font-semibold whitespace-nowrap">
                  {BOARD_COLUMN_TITLE[column]}
                </h2>
                <span
                  data-board-count
                  className={`font-mono text-sm ${tone ? `font-semibold ${TONE_TEXT[tone]}` : 'text-fg-subtle'}`}
                >
                  {list.length}
                </span>
                <span className="flex-1" />
                {column === 'merged' && list.length > 0 ? (
                  <button
                    type="button"
                    data-home-action="delete-merged"
                    title="Deletes their worktrees and local branches"
                    className="flex h-6 items-center rounded-[5px] border border-line-strong px-2 text-sm whitespace-nowrap text-fg outline-none hover:bg-raised focus-visible:shadow-[0_0_0_2px_var(--color-canvas),0_0_0_3.5px_var(--color-focus)]"
                    onClick={() => actions.deleteMerged(list)}
                  >
                    Delete {list.length} merged
                  </button>
                ) : null}
                <button
                  type="button"
                  data-board-column-menu={column}
                  aria-label={`${BOARD_COLUMN_TITLE[column]} column`}
                  aria-haspopup="menu"
                  title="Move or hide this column"
                  className="flex size-6 flex-none items-center justify-center rounded-[5px] text-base text-fg-subtle opacity-0 outline-none group-hover/header:opacity-100 hover:bg-band-strong hover:text-fg focus-visible:opacity-100 focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
                  onClick={() => void columnMenu(column, true)}
                >
                  ⋯
                </button>
              </div>
              <div
                className={`flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pt-0.5 pb-2 contain-content ${moving ? 'opacity-60' : ''}`}
              >
                {list.map((w) => card(column, w))}
                {list.length === 0 ? (
                  <div className="rounded-[7px] border border-dashed border-line px-2 py-[22px] text-center text-sm text-fg-subtle">
                    Nothing here
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
        {columnDrag && columnDrag.at !== null ? (
          <div
            data-board-column-drop={columnDrag.index}
            aria-hidden
            style={{ left: columnDrag.at - 1 }}
            className="pointer-events-none absolute top-[18px] bottom-5 w-0.5 rounded-full bg-focus"
          />
        ) : null}
      </div>

      {drag ? (
        <div
          ref={zone}
          data-drop-zone={drag.over ? 'over' : ''}
          className={`absolute right-6 bottom-5 left-6 box-border flex h-[72px] items-center justify-center gap-3 rounded-lg border-[1.5px] ${
            drag.over
              ? 'border-solid border-st-error bg-[color-mix(in_oklch,var(--color-st-error)_13%,var(--color-term))]'
              : 'border-dashed border-line-strong bg-term'
          }`}
        >
          <span
            className={`text-base font-semibold ${drag.over ? 'text-st-error' : 'text-fg-muted'}`}
          >
            {drag.over && lifted ? `Release to delete ${cardLabel(lifted)}` : 'Drop to delete'}
          </span>
          <span className="text-sm text-fg-subtle">
            {drag.over
              ? 'You confirm in the next step'
              : 'Cards move between columns by themselves'}
          </span>
        </div>
      ) : null}

      {drag && lifted && liftedColumn ? (
        <div
          ref={floatRef}
          data-board-float
          aria-hidden
          style={{
            width: drag.width,
            transform: drag.reduced
              ? undefined
              : drag.over
                ? 'rotate(-2deg) scale(0.98)'
                : 'rotate(-1.5deg)',
          }}
          className="pointer-events-none fixed z-50 box-border rounded-[7px] border border-line-strong bg-raised py-[9px] pr-2.5 pl-[11px] shadow-[0_16px_36px_oklch(0_0_0/0.32),0_2px_6px_oklch(0_0_0/0.18)]"
        >
          <div className="flex flex-col gap-[5px]">
            <CardBody
              w={lifted}
              it={cardItem(liftedColumn, lifted)}
              project={projectName(lifted.projectId)}
              suspended={suspended.has(lifted.id) && liftedColumn !== 'idle'}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What a card shows on hover or focus (spec §6.7, components.md Board): the
 * quick reply off Needs you and the actions. It unfolds over 180 ms, ease-out,
 * after the pointer rests 150 ms (a pointer passing over doesn't start it;
 * focus starts it at once), and folds back when both leave. Its grid row grows
 * from 0fr to 1fr, so the cards below move with it. Reduced motion: no delay,
 * no transition (theme.css). `shown` keeps it open (a field holding text).
 */
function Unfold({ shown = false, children }: { shown?: boolean; children: ReactNode }) {
  return (
    <div
      data-board-unfold
      // -5px takes back the card's gap: folded, it takes no room.
      // Focus and text show it at once (a transition's start is still hidden, and
      // the field must take focus), so only folding and hover transition visibility.
      className={`-mt-[5px] grid duration-[180ms] ease-out ${
        shown
          ? 'visible grid-rows-[1fr] transition-[grid-template-rows]'
          : 'invisible grid-rows-[0fr] transition-[grid-template-rows,visibility] group-focus-within:visible group-focus-within:grid-rows-[1fr] group-focus-within:transition-[grid-template-rows] group-hover:visible group-hover:grid-rows-[1fr] motion-safe:[.group:hover:not(:focus-within)_&]:delay-150'
      }`}
    >
      {/* Clipped only vertically, so focus rings show at the sides. */}
      <div className="min-h-0 overflow-x-visible overflow-y-clip">
        <div className="flex flex-col gap-[5px] pt-[5px]">{children}</div>
      </div>
    </div>
  );
}

/** The quick reply's placeholder: what a message there would be. */
function placeholder(column: BoardColumn, w: Workspace, suspended: boolean): string {
  if (w.state === 'awaiting-approval') return 'Feedback on this step…';
  if (w.unfinished) return 'Continue with a note…';
  if (column === 'needs') return 'Reply to Claude…';
  if (column === 'ship') return 'Ask for a change…';
  if (column === 'idle' && (suspended || w.state === 'interrupted'))
    return 'Resume with a message…';
  return 'Message Claude…';
}

/** A card's glyph, id, project, title and status line (components.md, Board). */
function CardBody({
  w,
  it,
  project,
  suspended,
}: {
  w: Workspace;
  it: HomeItem;
  project: string;
  /** Its Claude is suspended (spec §9.8): said after the status, outside Idle. */
  suspended: boolean;
}): ReactNode {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {it.glyph ? <StatusGlyph glyph={it.glyph} /> : <span className="size-3 flex-none" />}
        {w.task.id ? (
          <span className="flex-none font-mono text-[11.5px] text-fg-subtle">{w.task.id}</span>
        ) : null}
        <span className="flex-1" />
        <span className="min-w-0 truncate font-mono text-xs text-fg-subtle">{project}</span>
      </div>
      <span
        className={`line-clamp-2 text-base text-pretty ${
          it.title === 'bold' ? 'font-semibold' : 'font-medium'
        } ${it.title === 'muted' ? 'text-fg-muted' : 'text-fg'}`}
      >
        {w.task.title || w.name}
      </span>
      <div className="flex min-w-0 items-baseline gap-2">
        <div
          data-board-status
          className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden text-sm whitespace-nowrap text-fg-muted"
        >
          {it.parts.map((p, i) => (
            <span key={p.text} className="contents">
              {i > 0 && it.dotted ? <Sep /> : null}
              <span
                data-suspended={p.text === 'Suspended' || undefined}
                title={p.text === 'Suspended' ? SUSPENDED_TOOLTIP : p.title}
                className={p.tone ? TONE[p.tone] : 'min-w-0 flex-none truncate last:shrink'}
              >
                {p.text}
              </span>
            </span>
          ))}
          {suspended ? (
            <span data-suspended title={SUSPENDED_TOOLTIP} className="contents">
              <Sep />
              <span className="flex-none text-fg-subtle">Suspended</span>
            </span>
          ) : null}
        </div>
        {it.meta ? (
          <span
            data-home-memory
            title={it.meta.title}
            className="flex-none font-mono text-xs text-fg-subtle"
          >
            {it.meta.text}
          </span>
        ) : null}
      </div>
    </>
  );
}
