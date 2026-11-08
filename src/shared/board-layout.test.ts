import { describe, expect, it } from 'vitest';
import {
  type BoardLayout,
  canMove,
  DEFAULT_BOARD_LAYOUT,
  isDefaultLayout,
  moveColumn,
  parseBoardLayout,
  placeColumn,
  serializeBoardLayout,
  setHidden,
  shownColumns,
} from './board-layout';

const layout = (order: string, hidden = ''): BoardLayout =>
  ({
    order: order.split(' '),
    hidden: hidden ? hidden.split(' ') : [],
  }) as BoardLayout;

describe('the default', () => {
  it("is today's order, all shown", () => {
    expect(DEFAULT_BOARD_LAYOUT).toEqual(layout('working idle needs ship merged'));
    expect(shownColumns(DEFAULT_BOARD_LAYOUT)).toEqual([
      'working',
      'idle',
      'needs',
      'ship',
      'merged',
    ]);
    expect(isDefaultLayout(DEFAULT_BOARD_LAYOUT)).toBe(true);
  });

  it('is what a profile without a stored layout, or an unreadable one, gets', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '"board"', '[]']) {
      expect(parseBoardLayout(raw)).toEqual(DEFAULT_BOARD_LAYOUT);
    }
  });
});

describe('reorder', () => {
  it('moves a column left or right, and not past its end', () => {
    const start = DEFAULT_BOARD_LAYOUT;
    expect(moveColumn(start, 'needs', -1).order).toEqual([
      'working',
      'needs',
      'idle',
      'ship',
      'merged',
    ]);
    expect(moveColumn(start, 'needs', 1).order).toEqual([
      'working',
      'idle',
      'ship',
      'needs',
      'merged',
    ]);
    expect(moveColumn(start, 'working', -1)).toBe(start);
    expect(moveColumn(start, 'merged', 1)).toBe(start);
    expect(canMove(start, 'working', -1)).toBe(false);
    expect(canMove(start, 'working', 1)).toBe(true);
    expect(canMove(start, 'merged', 1)).toBe(false);
  });

  it('moves past hidden columns to the next shown one', () => {
    const start = layout('working idle needs ship merged', 'idle');
    const moved = moveColumn(start, 'needs', -1);
    expect(shownColumns(moved)).toEqual(['needs', 'working', 'ship', 'merged']);
    // The hidden column keeps its place after Working.
    expect(moved.order).toEqual(['needs', 'working', 'idle', 'ship', 'merged']);
    expect(canMove(start, 'needs', -1)).toBe(true);
    expect(canMove(start, 'idle', 1)).toBe(false);
  });

  it('places a dragged column among the shown ones', () => {
    const start = DEFAULT_BOARD_LAYOUT;
    expect(placeColumn(start, 'needs', 0).order).toEqual([
      'needs',
      'working',
      'idle',
      'ship',
      'merged',
    ]);
    expect(placeColumn(start, 'working', 4).order).toEqual([
      'idle',
      'needs',
      'ship',
      'merged',
      'working',
    ]);
    expect(placeColumn(start, 'working', 99).order).toEqual([
      'idle',
      'needs',
      'ship',
      'merged',
      'working',
    ]);
    expect(placeColumn(start, 'needs', 2)).toEqual(start);
    const hidden = layout('working idle needs ship merged', 'merged');
    expect(placeColumn(hidden, 'working', 3).order).toEqual([
      'idle',
      'needs',
      'ship',
      'working',
      'merged',
    ]);
    expect(placeColumn(hidden, 'merged', 0)).toBe(hidden);
  });
});

describe('hide', () => {
  it('hides and shows a column', () => {
    const hidden = setHidden(DEFAULT_BOARD_LAYOUT, 'idle', true);
    expect(shownColumns(hidden)).toEqual(['working', 'needs', 'ship', 'merged']);
    expect(hidden.order).toEqual(DEFAULT_BOARD_LAYOUT.order);
    expect(isDefaultLayout(hidden)).toBe(false);
    expect(setHidden(hidden, 'idle', true)).toBe(hidden);
    expect(setHidden(hidden, 'idle', false)).toEqual(DEFAULT_BOARD_LAYOUT);
  });

  it('keeps the last shown column', () => {
    const one = layout('working idle needs ship merged', 'working idle ship merged');
    expect(shownColumns(one)).toEqual(['needs']);
    expect(setHidden(one, 'needs', true)).toBe(one);
  });
});

describe('reset', () => {
  it('is the default again, and the default is stored as such', () => {
    const changed = setHidden(moveColumn(DEFAULT_BOARD_LAYOUT, 'needs', -1), 'merged', true);
    expect(isDefaultLayout(changed)).toBe(false);
    expect(isDefaultLayout(parseBoardLayout(serializeBoardLayout(DEFAULT_BOARD_LAYOUT)))).toBe(
      true,
    );
  });

  it('reads back what it stored', () => {
    const changed = setHidden(moveColumn(DEFAULT_BOARD_LAYOUT, 'ship', -1), 'idle', true);
    const raw = serializeBoardLayout(changed);
    expect(JSON.parse(raw).v).toBe(1);
    expect(parseBoardLayout(raw)).toEqual(changed);
  });
});

describe('a layout from an older version', () => {
  it('puts a column it lacks back at its default place', () => {
    // Stored before Idle existed, and before Merged.
    const raw = JSON.stringify({ order: ['needs', 'working', 'ship'], hidden: [] });
    expect(parseBoardLayout(raw).order).toEqual(['needs', 'working', 'idle', 'ship', 'merged']);
    // Without a version and with no order: all in their default places.
    expect(parseBoardLayout(JSON.stringify({ hidden: ['idle'] }))).toEqual(
      layout('working idle needs ship merged', 'idle'),
    );
    // A missing first column goes first.
    expect(parseBoardLayout(JSON.stringify({ order: ['merged', 'needs'] })).order).toEqual([
      'working',
      'idle',
      'merged',
      'needs',
      'ship',
    ]);
  });

  it('drops unknown and repeated columns', () => {
    const raw = JSON.stringify({
      v: 1,
      order: ['ship', 'review', 'ship', 'working', 7, 'idle', 'needs', 'merged'],
      hidden: ['review', 'idle', 'idle'],
    });
    expect(parseBoardLayout(raw)).toEqual(layout('ship working idle needs merged', 'idle'));
  });

  it('shows every column when all are hidden', () => {
    const raw = JSON.stringify({
      order: DEFAULT_BOARD_LAYOUT.order,
      hidden: DEFAULT_BOARD_LAYOUT.order,
    });
    expect(parseBoardLayout(raw)).toEqual(DEFAULT_BOARD_LAYOUT);
  });
});
