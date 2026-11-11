import { type BoardGroup, boardLanes } from '@shared/board-group';
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
  cardDetails,
  DRAFT_NOTE,
  type HomeSection,
  quickReply,
} from '@shared/home';
import type { LastWords } from '@shared/last-words';
import { describeSplit, formatBytes, type MemorySnapshot, workspaceMemory } from '@shared/memory';
import { answerable } from '@shared/question';
import type { Profile, Project } from '@shared/schemas';
import { matchShortcut } from '@shared/shortcuts';
import { backgroundNote, STATE_LABEL } from '@shared/status';
import { SUSPENDED_TOOLTIP, suspendClockNote } from '@shared/suspend';
import type { SessionInfo } from '@shared/terminal-protocol';
import { workspaceGlyph } from '@shared/unfinished';
import { linkedRepos, type Workspace } from '@shared/workspaces';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { trpcClient, useTRPC } from '../trpc';
import { button, iconButton, isMac, Kbd, keyHint } from '../ui/controls';
import { InfoIcon } from '../ui/icons';
import { useLaunching } from '../ui/launching';
import { StatusGlyph } from '../ui/StatusGlyph';
import { useSuspended } from '../ui/suspended';
import { ago } from '../ui/time';
import { CardDetails } from './CardDetails';
import { FlagMark, flagging, flagMenuItems, runFlagChoice } from './Flag';
import {
  Action,
  actionClass,
  type HomeActions,
  type HomeItem,
  NotesMark,
  type Part,
  runningMark,
  Sep,
  TONE,
  useHomeItems,
  useNow,
  useShipStates,
} from './home-items';
import { useMerge } from './MergeControls';

/** The column's section, whose rules and actions it shows (spec §6.7). */
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
 * urgent card's color, as the sidebar's (permission, then input), on a tint of
 * it; in light also a top edge in that color (theme.css --color-needs-*).
 */
export type NeedsTone = 'permission' | 'input';
export const needsTone = (list: Pick<Workspace, 'state'>[]): NeedsTone =>
  list.some((w) => w.state === 'needs-permission') ? 'permission' : 'input';
const NEEDS_TONE: Record<NeedsTone, string> = {
  permission: 'border-needs-line bg-needs-bg shadow-[inset_0_2px_0_var(--color-needs-accent)]',
  input:
    'border-needs-input-line bg-needs-input-bg shadow-[inset_0_2px_0_var(--color-needs-input-accent)]',
};
const TONE_TEXT: Record<NeedsTone, string> = {
  permission: 'text-st-permission',
  input: 'text-st-input',
};

const cardLabel = (w: Workspace) => w.task.id ?? (w.task.title || w.name);

/**
 * The Board (spec §6.7, §6.10): workspaces in five status columns, in the
 * order the profile arranged them and without the ones it hid; on Home the
 * profile's, in a project's view that project's and those linked into it.
 * Cards move by themselves as states change; the only card drag target is
 * Drop to delete, which opens the Delete workspace dialog. A column moves by
 * dragging its header or from its menu.
 */
export function Board({
  profile,
  inProject = null,
  projects,
  workspaces,
  sessions,
  memory,
  actions,
  layout,
  onLayout,
  group,
  collapsed,
  onToggleLane,
}: {
  profile: Profile;
  /**
   * A project's view (spec §6.10): its cards show their branch where Home's
   * show the project, and mark the workspaces linked in from other projects.
   */
  inProject?: Project | null;
  /** The profile's projects. */
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  memory: MemorySnapshot | null;
  actions: HomeActions;
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
  /** Grouped by project, a band per project (spec §6.7). */
  group: BoardGroup;
  /** The projects whose bands are collapsed. */
  collapsed: string[];
  onToggleLane: (projectId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const launching = useLaunching();
  const suspended = useSuspended();
  const ship = useShipStates(workspaces);
  const now = useNow();
  const merge = useMerge();
  const item = useHomeItems({ profile, projects, sessions, memory, actions, ship, now, merge });
  const columns = boardColumns(workspaces, ship);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '';
  // Why a running Claude isn't suspended, or when it will be (spec §9.8), for
  // the cards' details: read again as often as the app checks.
  const clocks = useQuery(
    trpc.sessions.suspendClocks.queryOptions(undefined, { refetchInterval: 15_000 }),
  );
  const clockNote = (w: Workspace) => {
    const clock = clocks.data?.find((c) => c.workspaceId === w.id);
    return clock ? suspendClockNote(clock, Date.now()) : null;
  };
  /** A card's details behind its ⓘ (spec §6.7): what the card itself leaves out. */
  const details = (w: Workspace) => {
    const used = workspaceMemory(memory, w.id);
    const { title, lines } = cardDetails(w, {
      linkedFrom: linkedFrom(w),
      branch: !inProject,
      memory: used ? `${formatBytes(used.total)} · ${describeSplit(used)}` : null,
      active: ago(w.lastActivityAt ?? w.createdAt, now),
      suspended: suspended.has(w.id),
      suspendNote: clockNote(w),
      flagged: w.flag ? ago(w.flag.at, now) : null,
    });
    return <CardDetails label={cardLabel(w)} title={title} lines={lines} />;
  };
  /** On a project's Board, the project a linked-in workspace belongs to (spec §6.10). */
  const linkedFrom = (w: Workspace) =>
    inProject && w.projectId !== inProject.id ? projectName(w.projectId) : null;
  /** What a card names at its top right: the project on Home, the branch in a project's view. */
  const place = (w: Workspace) => (inProject ? w.branch : projectName(w.projectId));

  // Drafts change as keys are typed into a terminal: read them often while shown.
  const prompts = useQuery(
    trpc.sessions.prompts.queryOptions(undefined, { refetchInterval: 3_000, staleTime: 0 }),
  );
  const refreshDrafts = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.sessions.prompts.queryKey() });
  // What each card's Claude last said, for the line above its quick reply (spec §6.7).
  const lastWords = useQuery(
    trpc.workspaces.lastWords.queryOptions(
      { profileId: profile.id },
      { refetchInterval: 3_000, staleTime: 0 },
    ),
  );
  const refreshLastWords = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.workspaces.lastWords.queryKey() });
  const claudeOf = (id: string) =>
    sessions.find((s) => s.workspaceId === id && s.kind === 'claude' && s.status !== 'exited') ??
    null;

  const [replies, setReplies] = useState<Record<string, string>>({});
  /** What a card says after a reply or an answer went to Claude, by workspace. */
  const [sent, setSent] = useState<Record<string, string>>({});
  const [replyErrors, setReplyErrors] = useState<Record<string, string | null>>({});
  const send = useMutation(trpc.workspaces.quickReply.mutationOptions());
  const answer = useMutation(trpc.workspaces.answerQuestion.mutationOptions());
  const showSent = (id: string, note: string) => {
    setSent((s) => ({ ...s, [id]: note }));
    setTimeout(
      () =>
        setSent((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        }),
      SENT_MS,
    );
  };
  /** Picks option `option` of the question Claude waits on (spec §6.7). */
  const sendAnswer = (w: Workspace, words: LastWords, option: number) => {
    const question = words.question;
    const label = question?.questions[0]?.options[option]?.label;
    if (!question || !label) return;
    setReplyErrors((e) => ({ ...e, [w.id]: null }));
    answer.mutate(
      { workspaceId: w.id, questionId: question.id, option },
      {
        onSuccess: () => {
          showSent(w.id, `Answered: ${label}`);
          refreshLastWords();
        },
        onError: (e) => {
          setReplyErrors((r) => ({ ...r, [w.id]: e.message }));
          refreshLastWords();
        },
      },
    );
  };
  const sendReply = (w: Workspace, column: BoardColumn) => {
    const text = (replies[w.id] ?? '').trim();
    if (!text) return;
    setReplyErrors((e) => ({ ...e, [w.id]: null }));
    send.mutate(
      { workspaceId: w.id, text },
      {
        onSuccess: () => {
          setReplies((r) => ({ ...r, [w.id]: '' }));
          showSent(
            w.id,
            column === 'working' ? 'Sent · Claude reads it after this step' : 'Sent to Claude',
          );
        },
        onError: (e) => {
          setReplyErrors((r) => ({ ...r, [w.id]: e.message }));
          refreshDrafts();
          refreshLastWords();
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
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-board-card]');
    // ⇧⌘G on a card, or anywhere in it (spec §6.7): Flag…, or Unflag.
    if (card && matchShortcut('flag', e.nativeEvent, isMac) !== -1) {
      const w = workspaces.find((x) => x.id === card.dataset.boardCard);
      if (w) {
        e.preventDefault();
        flagging.toggle(w);
      }
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    // Only from a card itself or the Board: its buttons and field keep their keys.
    if (card ? target !== card : target !== root.current) return;
    const cardsOf = (cell: Element | null | undefined) => [
      ...(cell?.querySelectorAll<HTMLElement>('[data-board-card]') ?? []),
    ];
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
    // A cell is a column, or a column in a project's band when grouped.
    const cell = card.closest<HTMLElement>('[data-board-cell]');
    // ↑ ↓ go down the column, across the open bands when grouped.
    const cards = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        `[data-board-cell="${cell?.dataset.boardCell}"] [data-board-card]`,
      ) ?? []),
    ];
    const at = cards.indexOf(card);
    if (e.key === 'ArrowDown') go(cards[Math.min(cards.length - 1, at + 1)]);
    else if (e.key === 'ArrowUp') go(cards[Math.max(0, at - 1)]);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // The nearest cell with cards that way, in the same band when grouped,
      // at the card nearest in height; none past the last.
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const top = card.getBoundingClientRect().top;
      const row = card.closest('[data-board-lane]') ?? root.current;
      const cells = [...(row?.querySelectorAll('[data-board-cell]') ?? [])];
      for (let i = cells.indexOf(cell as Element) + step; i >= 0 && i < cells.length; i += step) {
        const there = cardsOf(cells[i]);
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

  /**
   * A card's menu (spec §6.7), from its ⋯ or a right click: Flag… (or Edit
   * Flag Note… and Unflag), then Delete workspace….
   */
  const cardMenu = async (w: Workspace) => {
    const choice = await trpcClient.ui.contextMenu.mutate({
      items: [...flagMenuItems(w), { id: 'delete', label: 'Delete workspace…' }],
    });
    if (runFlagChoice(w, choice)) return;
    if (choice === 'delete') actions.delete(w);
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
      dragRef.current = null;
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
    /**
     * A dialog opened meanwhile (the overview at start, ⌘N) cancels a drag: the
     * Board is behind it, and a drop must never open a second dialog over it.
     */
    const behindDialog = () => {
      if (!(press.current || columnPress.current)) return false;
      if (!document.querySelector('dialog[open]')) return false;
      cancelled.current = true;
      end();
      return true;
    };
    const onMove = (e: PointerEvent) => {
      if (behindDialog()) return;
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
      behindDialog();
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

  /** What a card shows: its section's item, or Idle's own. */
  const cardItem = (column: BoardColumn, w: Workspace): HomeItem => {
    if (column !== 'idle') return item(SECTION_OF[column], w);
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
          data="open"
          title={
            suspended.has(w.id) ? 'Open the workspace; its Claude resumes' : 'Open the workspace'
          }
          onClick={() => actions.open(w)}
        >
          Open
        </Action>,
      ],
      meta: null,
      title: null,
      error: null,
    };
  };

  const card = (column: BoardColumn, w: Workspace) => {
    const it = cardItem(column, w);
    const lifted = drag?.id === w.id;
    const claude = claudeOf(w.id);
    const words = lastWords.data?.[w.id] ?? null;
    const offer = quickReply(w, column, {
      claude,
      draft: prompts.data?.drafts.includes(w.id) ?? false,
      atPrompt: prompts.data?.atPrompt.includes(w.id) ?? false,
      question: words?.kind === 'question',
    });
    /** The line above the field: what Claude last said; it opens the Responses panel there. */
    const context =
      words && (offer === 'field' || offer === 'question') ? (
        <button
          type="button"
          data-quick-reply-context={words.kind}
          title={`${words.lead ? `${words.lead} ` : ''}${words.text}\n\n${words.entry === null ? 'Open the workspace' : 'Click to read it in Responses'}`}
          className="mt-[3px] line-clamp-2 rounded-[3px] text-left text-sm break-words text-fg-muted outline-none hover:text-fg focus-visible:shadow-[0_0_0_2px_var(--color-raised),0_0_0_3.5px_var(--color-focus)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (words.entry === null) actions.open(w);
            else actions.responses(w, words.entry);
          }}
        >
          {words.lead ? (
            <>
              <span className="font-medium text-fg-subtle">{words.lead}</span>{' '}
            </>
          ) : null}
          {words.text}
        </button>
      ) : null;
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
        data-board-linked={linkedFrom(w) ?? undefined}
        data-suspend-note={suspended.has(w.id) ? undefined : (clockNote(w) ?? undefined)}
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
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('input')) return;
          e.preventDefault();
          void cardMenu(w);
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
            place={place(w)}
            linkedFrom={linkedFrom(w)}
            linkedIn={group === 'project' ? projectName : null}
            suspended={suspended.has(w.id) && column !== 'idle'}
            details={details(w)}
            menu={
              <button
                type="button"
                data-card-menu={w.id}
                aria-label={`Menu for ${cardLabel(w)}`}
                aria-haspopup="menu"
                title="Flag, delete…"
                className="-my-0.5 flex size-[18px] flex-none items-center justify-center rounded-[4px] text-fg-subtle opacity-0 outline-none group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 hover:text-fg focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void cardMenu(w);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                }}
              >
                ⋯
              </button>
            }
          />
          {offer === 'question' && words?.question && !lifted && !wasSent ? (
            <div data-quick-reply-question className="flex flex-col gap-[5px]">
              {context}
              {answerable(words.question) ? (
                <div className="mt-[3px] flex flex-wrap items-center gap-1.5">
                  {words.question.questions[0]?.options.map((o, i) => (
                    <button
                      key={o.label}
                      type="button"
                      data-question-option={i}
                      title={`${o.description ? `${o.description} · ` : ''}Answer "${o.label}" (${i + 1} in the Claude tab)`}
                      disabled={answer.isPending && answer.variables?.workspaceId === w.id}
                      className={`${actionClass('secondary')} max-w-full truncate`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        sendAnswer(w, words, i);
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                  <Action
                    kind="ghost"
                    data="other"
                    title="Open the Claude tab to type your own answer"
                    onClick={() => actions.open(w)}
                  >
                    Other…
                  </Action>
                </div>
              ) : (
                <div className="mt-[3px] flex h-7 items-center gap-2 text-sm text-fg-subtle">
                  <Action
                    kind="secondary"
                    data="open"
                    title="Open the Claude tab to answer"
                    onClick={() => actions.open(w)}
                  >
                    Open
                  </Action>
                  <span className="min-w-0 truncate">
                    {words.question.questions.length > 1
                      ? 'Several questions; answer them in the Claude tab'
                      : 'Pick any of them in the Claude tab'}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {offer === 'field' && !lifted && !wasSent
            ? unfold(
                <div className="flex flex-col">
                  {context}
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
                  </div>
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
                  {DRAFT_NOTE}
                </button>,
              )
            : null}
          {wasSent && !lifted ? (
            <div
              data-quick-reply-sent
              className="mt-[3px] flex h-7 items-center gap-1.5 text-sm text-fg-subtle"
            >
              <span className="text-diff-add">✓</span>
              {wasSent}
            </div>
          ) : null}
          {error ? (
            <span role="alert" className="text-sm text-st-error">
              ✕ {error}
            </span>
          ) : null}
          {!drag ? (
            <Unfold>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-[7px]">
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

  const shown = shownColumns(layout);
  const grouped = group === 'project';
  const lanes = grouped ? boardLanes(projects, workspaces, columns) : [];
  /** The shown columns side by side, each at least 220 px wide (spec §6.7). */
  const gridColumns = { gridTemplateColumns: `repeat(${shown.length}, minmax(220px, 1fr))` };

  /** A column's header: title, count, Delete n merged and ⋯; dragging it moves the column. */
  const header = (column: BoardColumn, tone: NeedsTone | null, moving: boolean) => {
    const list = columns[column];
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: dragging a header moves its column; its menu button does the same from the keyboard
      <div
        data-board-column-header
        title="Drag to move the column"
        className={`group/header flex flex-none touch-none items-center gap-2 pr-2 pl-3 select-none ${grouped ? 'h-9' : 'h-10'} ${moving ? 'opacity-60' : ''}`}
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
        <h2
          className="text-base font-semibold whitespace-nowrap"
          title={
            column === 'needs'
              ? `${keyHint('nextNeedingYou')} jumps to the next one that needs you`
              : undefined
          }
        >
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
    );
  };
  /** A column's frame: Needs you tinted while it has cards, dashed while it is lifted. */
  const frame = (tone: NeedsTone | null, moving: boolean) =>
    moving
      ? 'border-dashed border-line-strong bg-canvas'
      : tone
        ? NEEDS_TONE[tone]
        : 'border-line bg-canvas';
  const toneOf = (column: BoardColumn, list: Workspace[]) =>
    column === 'needs' && list.length > 0 ? needsTone(list) : null;
  const dropLine = (offset: number, className: string) =>
    columnDrag && columnDrag.at !== null ? (
      <div
        data-board-column-drop={columnDrag.index}
        aria-hidden
        style={{ left: columnDrag.at - 1 - offset }}
        className={`pointer-events-none absolute w-0.5 rounded-full bg-focus ${className}`}
      />
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the cards inside it
    <div
      ref={root}
      tabIndex={-1}
      data-home-board={inProject ? undefined : drag ? 'dragging' : ''}
      data-project-board={inProject ? (drag ? 'dragging' : '') : undefined}
      data-board-grouped={grouped ? 'project' : undefined}
      data-board-column-drag={columnDrag?.column}
      className={`relative flex min-h-0 flex-1 flex-col bg-term outline-none ${columnDrag ? 'cursor-grabbing' : ''}`}
      onKeyDown={onKeyDown}
    >
      {grouped ? (
        // Grouped by project (spec §6.7): one scroller both ways; the column headers
        // stay on top, the bands' names at the left.
        <div
          ref={scroller}
          className={`relative min-h-0 flex-1 overflow-auto px-6 ${drag ? 'pb-[112px]' : 'pb-5'}`}
        >
          <div
            className="relative flex flex-col gap-3.5"
            style={{ minWidth: shown.length * 220 + (shown.length - 1) * 12 }}
          >
            <div
              data-board-headers
              style={gridColumns}
              className="sticky top-0 z-[3] grid gap-3 bg-term pt-[18px] pb-1"
            >
              {shown.map((column) => {
                const tone = toneOf(column, columns[column]);
                const moving = columnDrag?.column === column;
                return (
                  <section
                    key={column}
                    data-board-column={column}
                    data-board-tone={tone ?? undefined}
                    data-board-column-lifted={moving || undefined}
                    aria-label={BOARD_COLUMN_TITLE[column]}
                    className={`min-w-0 rounded-lg border ${frame(tone, moving)}`}
                  >
                    {header(column, tone, moving)}
                  </section>
                );
              })}
            </div>
            {lanes.map((lane) => {
              const open = !collapsed.includes(lane.projectId);
              const project = projects.find((p) => p.id === lane.projectId);
              return (
                <div
                  key={lane.projectId}
                  data-board-lane={lane.projectId}
                  data-board-lane-open={open}
                  className="flex flex-col gap-1.5"
                >
                  <div className="sticky left-0 z-[2] -ml-1.5 flex items-center gap-1 self-start">
                    <button
                      type="button"
                      data-board-lane-toggle={lane.projectId}
                      aria-expanded={open}
                      title={open ? `Collapse ${lane.name}` : `Expand ${lane.name}`}
                      className="flex h-7 items-center gap-2 rounded-[5px] pr-2.5 pl-1.5 whitespace-nowrap outline-none hover:bg-band-strong focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)]"
                      onClick={() => onToggleLane(lane.projectId)}
                    >
                      <span aria-hidden className="w-3 text-center text-2xs text-fg-subtle">
                        {open ? '▾' : '▸'}
                      </span>
                      <span className="font-mono text-[12.5px] font-medium text-fg">
                        {lane.name}
                      </span>
                      <span data-board-lane-count className="text-sm text-fg-subtle">
                        {lane.count} {lane.count === 1 ? 'workspace' : 'workspaces'}
                      </span>
                      {lane.linkedIn > 0 ? (
                        <span
                          data-board-lane-linked={lane.linkedIn}
                          title={`${lane.linkedIn} ${lane.linkedIn === 1 ? 'workspace' : 'workspaces'} of other projects linked into ${lane.name}; ${lane.linkedIn === 1 ? 'it shows' : 'they show'} with ${lane.linkedIn === 1 ? 'its' : 'their'} own project`}
                          className="text-sm text-fg-subtle"
                        >
                          ↗ {lane.linkedIn} linked in
                        </span>
                      ) : null}
                    </button>
                    {/* New workspace in this project, as the sidebar's + (spec §6.7). */}
                    {project ? (
                      <button
                        type="button"
                        data-board-lane-new={lane.projectId}
                        className={`${iconButton} size-5 text-md`}
                        title={`New workspace in ${lane.name} (${keyHint('newWorkspace')})`}
                        aria-label={`New workspace in ${lane.name}`}
                        onClick={() => actions.newWorkspaceIn(project)}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <div style={gridColumns} className="grid items-stretch gap-3">
                      {shown.map((column) => {
                        const list = lane.columns[column];
                        const tone = toneOf(column, list);
                        const moving = columnDrag?.column === column;
                        return (
                          <div
                            key={column}
                            data-board-cell={column}
                            data-board-tone={tone ?? undefined}
                            className={`flex min-h-12 min-w-0 flex-col gap-1.5 rounded-lg border p-1.5 ${frame(tone, moving)} ${moving ? 'opacity-60' : ''}`}
                          >
                            {list.map((w) => card(column, w))}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    // Collapsed: each column's count; a click expands the band (its header is the key's way).
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the band's header button expands it from the keyboard
                    // biome-ignore lint/a11y/noStaticElementInteractions: as above
                    <div
                      data-board-lane-counts
                      style={gridColumns}
                      className="grid cursor-default gap-3"
                      onClick={() => onToggleLane(lane.projectId)}
                    >
                      {shown.map((column) => {
                        const n = lane.columns[column].length;
                        const tone = toneOf(column, lane.columns[column]);
                        return (
                          <div
                            key={column}
                            data-board-lane-cell={column}
                            title={`${lane.name} · ${BOARD_COLUMN_TITLE[column]}: ${n}`}
                            className={`flex h-8 min-w-0 items-center rounded-md border border-line bg-canvas px-3 hover:border-line-strong ${columnDrag?.column === column ? 'opacity-60' : ''}`}
                          >
                            <span
                              className={`font-mono text-sm font-medium ${tone ? TONE_TEXT[tone] : n > 0 ? 'text-fg' : 'text-fg-subtle'}`}
                            >
                              {n > 0 ? n : '–'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {dropLine(24, 'top-[18px] bottom-0')}
          </div>
        </div>
      ) : (
        <div
          ref={scroller}
          className={`relative flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden px-6 pt-[18px] ${drag ? 'pb-[112px]' : 'pb-5'}`}
        >
          {shown.map((column) => {
            const list = columns[column];
            const tone = toneOf(column, list);
            const moving = columnDrag?.column === column;
            return (
              <section
                key={column}
                data-board-column={column}
                data-board-cell={column}
                data-board-tone={tone ?? undefined}
                data-board-column-lifted={moving || undefined}
                aria-label={BOARD_COLUMN_TITLE[column]}
                className={`flex min-h-0 min-w-[220px] flex-[1_0_220px] flex-col rounded-lg border ${frame(tone, moving)}`}
              >
                {header(column, tone, moving)}
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
          {dropLine(0, 'top-[18px] bottom-5')}
        </div>
      )}

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
              place={place(lifted)}
              linkedFrom={linkedFrom(lifted)}
              suspended={suspended.has(lifted.id) && liftedColumn !== 'idle'}
            />
          </div>
        </div>
      ) : null}
      {merge.dialog}
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

/** A card's glyph, id, project or branch, title and status line (components.md, Board). */
function CardBody({
  w,
  it,
  place,
  linkedFrom = null,
  linkedIn = null,
  suspended,
  details = null,
  menu = null,
}: {
  w: Workspace;
  it: HomeItem;
  /** The project on Home, the branch on a project's Board (spec §6.10). */
  place: string;
  /** On a project's Board, the project a linked-in workspace belongs to. */
  linkedFrom?: string | null;
  /**
   * Grouped by project, the band names the project: the card shows its
   * linked repositories' count in its place, named by this (spec §6.7).
   */
  linkedIn?: ((projectId: string) => string) | null;
  /** Its Claude is suspended (spec §9.8): said after the status, outside Idle. */
  suspended: boolean;
  /** The ⓘ and its details (spec §6.7); a dragged copy shows the ⓘ alone. */
  details?: ReactNode;
  /** The card's ⋯ menu button, after the ⓘ; none on a dragged copy. */
  menu?: ReactNode;
}): ReactNode {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {it.glyph ? <StatusGlyph glyph={it.glyph} /> : <span className="size-3 flex-none" />}
        {w.task.id ? (
          <span className="flex-none font-mono text-[11.5px] text-fg-subtle">{w.task.id}</span>
        ) : null}
        {/* Not a Tab stop: Tab goes to the ⓘ first; ⇧⌘G and the ⋯ unflag from the keyboard. */}
        <FlagMark w={w} focusable={false} />
        <NotesMark w={w} />
        <span className="flex-1" />
        {linkedFrom ? (
          <span
            data-linked-from={linkedFrom}
            title={`Linked in from ${linkedFrom}`}
            className="flex-none rounded-xs border border-line-strong px-1 font-mono text-2xs text-fg-muted"
          >
            ↗ {linkedFrom}
          </span>
        ) : null}
        {!linkedIn ? (
          <span className="min-w-0 truncate font-mono text-xs text-fg-subtle">{place}</span>
        ) : linkedRepos(w).length > 0 ? (
          <span
            data-linked-chip
            title={`Also in ${linkedRepos(w)
              .map((r) => linkedIn(r.projectId))
              .join(', ')}`}
            className="flex-none rounded-xs border border-line-strong px-1 font-mono text-2xs text-fg-muted"
          >
            +{linkedRepos(w).length}
          </span>
        ) : null}
        {details ?? (
          <span className="-my-0.5 flex size-[18px] flex-none items-center justify-center text-fg-subtle">
            <InfoIcon />
          </span>
        )}
        {menu}
      </div>
      <span
        className={`line-clamp-2 text-base text-pretty ${
          it.title === 'bold' ? 'font-semibold' : 'font-medium'
        } ${it.title === 'muted' ? 'text-fg-muted' : 'text-fg'}`}
      >
        {w.task.title || w.name}
      </span>
      {w.flag?.note ? (
        // What to continue (spec §6.7): two lines at most, the whole in the details.
        <span
          data-card-flag-note={w.id}
          className="line-clamp-2 border-l-2 border-flag/60 pl-1.5 text-sm text-pretty text-fg-muted"
        >
          {w.flag.note}
        </span>
      ) : null}
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

/**
 * In place of the Board without anything to show on it (spec §6.7, §6.10):
 * without projects, Add your first project; without workspaces, New workspace,
 * in place of five empty columns.
 */
export function BoardEmpty({
  kind,
  onAddProject,
  onNewWorkspace,
}: {
  kind: 'no-projects' | 'no-workspaces';
  onAddProject?: () => void;
  /** Null while it can't open (no projects). */
  onNewWorkspace?: (() => void) | null;
}) {
  return (
    <div data-board-empty={kind} className="min-h-0 flex-1 overflow-auto bg-term outline-none">
      <div className="box-border flex min-h-full flex-col items-center justify-center px-6 pt-10 pb-20">
        <div className="flex w-full max-w-[400px] flex-col gap-[22px]">
          <div className="flex flex-col gap-1.5">
            <span className="text-[17px] font-semibold">
              {kind === 'no-projects' ? 'No projects yet' : 'No workspaces yet'}
            </span>
            <span className="text-base leading-normal text-pretty text-fg-muted">
              {kind === 'no-projects'
                ? 'A project is a git repository on disk. Add one, then start a workspace for each task: its own worktree, branch and terminals.'
                : 'A workspace is one task in its own worktree and branch, with Claude and shells running there. Its card shows here, in the column of what it’s doing.'}
            </span>
          </div>
          {kind === 'no-projects' ? (
            <button
              type="button"
              data-home-action="add-first-project"
              className={`${button('primary', 'lg')} self-start`}
              onClick={onAddProject}
            >
              Add your first project <Kbd onFg>{keyHint('addProject')}</Kbd>
            </button>
          ) : (
            <button
              type="button"
              data-home-action="new-first-workspace"
              className={`${button('primary', 'lg')} self-start`}
              disabled={!onNewWorkspace}
              onClick={onNewWorkspace ?? undefined}
            >
              New workspace <Kbd onFg>{keyHint('newWorkspace')}</Kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
