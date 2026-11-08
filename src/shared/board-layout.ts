import { BOARD_COLUMNS, type BoardColumn } from './home';

/**
 * The Board's columns as a profile arranged them (spec §6.7): their order,
 * every column in it once, and which are hidden. At least one stays shown.
 */
export interface BoardLayout {
  order: BoardColumn[];
  hidden: BoardColumn[];
}

export const DEFAULT_BOARD_LAYOUT: BoardLayout = { order: [...BOARD_COLUMNS], hidden: [] };

/** The version written with a layout; one without it is read the same way. */
const VERSION = 1;

const isColumn = (c: unknown): c is BoardColumn =>
  typeof c === 'string' && (BOARD_COLUMNS as readonly string[]).includes(c);

const unique = (list: unknown): BoardColumn[] =>
  Array.isArray(list) ? [...new Set(list.filter(isColumn))] : [];

/**
 * A stored layout, read leniently: anything unreadable is the default, unknown
 * and repeated columns are dropped, and a column it doesn't know (one added
 * after it was stored) goes back to its default place, after the nearest
 * column before it there. All hidden shows them all.
 */
export function parseBoardLayout(raw: string | null): BoardLayout {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') return DEFAULT_BOARD_LAYOUT;
  const stored = data as { order?: unknown; hidden?: unknown };
  const order = unique(stored.order);
  for (const [at, column] of BOARD_COLUMNS.entries()) {
    if (order.includes(column)) continue;
    const before = BOARD_COLUMNS.slice(0, at)
      .reverse()
      .find((c) => order.includes(c));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, column);
  }
  const hidden = unique(stored.hidden);
  return { order, hidden: hidden.length >= order.length ? [] : hidden };
}

export const serializeBoardLayout = (layout: BoardLayout): string =>
  JSON.stringify({ v: VERSION, order: layout.order, hidden: layout.hidden });

/** The columns the Board shows, in their order. */
export const shownColumns = (layout: BoardLayout): BoardColumn[] =>
  layout.order.filter((c) => !layout.hidden.includes(c));

export const isDefaultLayout = (layout: BoardLayout): boolean =>
  layout.hidden.length === 0 && layout.order.every((c, i) => c === BOARD_COLUMNS[i]);

/**
 * Puts a shown column at this index among the shown columns (a dragged
 * header's drop). Hidden columns keep their place relative to the others.
 */
export function placeColumn(layout: BoardLayout, column: BoardColumn, index: number): BoardLayout {
  const shown = shownColumns(layout);
  if (!shown.includes(column)) return layout;
  const rest = shown.filter((c) => c !== column);
  const at = Math.max(0, Math.min(rest.length, index));
  const next = rest[at];
  const order = layout.order.filter((c) => c !== column);
  // Before the shown column it lands in front of, else after the last shown one.
  const to = next ? order.indexOf(next) : order.indexOf(rest[rest.length - 1] as BoardColumn) + 1;
  order.splice(to, 0, column);
  return { ...layout, order };
}

/** Move Left or Move Right: past the next shown column that way; none at its end. */
export function moveColumn(layout: BoardLayout, column: BoardColumn, step: -1 | 1): BoardLayout {
  const shown = shownColumns(layout);
  const at = shown.indexOf(column);
  if (at < 0 || at + step < 0 || at + step >= shown.length) return layout;
  return placeColumn(layout, column, at + step);
}

/** Whether Move Left (-1) or Move Right (1) can move the column. */
export function canMove(layout: BoardLayout, column: BoardColumn, step: -1 | 1): boolean {
  const shown = shownColumns(layout);
  const at = shown.indexOf(column);
  return at >= 0 && at + step >= 0 && at + step < shown.length;
}

/** Hides or shows a column; the last shown one stays. */
export function setHidden(layout: BoardLayout, column: BoardColumn, hidden: boolean): BoardLayout {
  const is = layout.hidden.includes(column);
  if (hidden === is) return layout;
  if (!hidden) return { ...layout, hidden: layout.hidden.filter((c) => c !== column) };
  if (shownColumns(layout).length <= 1) return layout;
  return { ...layout, hidden: [...layout.hidden, column] };
}
