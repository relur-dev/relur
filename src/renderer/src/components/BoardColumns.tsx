import {
  type BoardLayout,
  DEFAULT_BOARD_LAYOUT,
  isDefaultLayout,
  setHidden,
  shownColumns,
} from '@shared/board-layout';
import { BOARD_COLUMN_TITLE, homeSection } from '@shared/home';
import type { Workspace } from '@shared/workspaces';
import { useEffect, useId, useRef, useState } from 'react';
import { button } from '../ui/controls';
import { needsTone } from './Board';

const MARK: Record<'permission' | 'input', string> = {
  permission: 'bg-st-permission',
  input: 'bg-st-input',
};

/**
 * The Board's Columns control (spec §6.7): every column in its order with a
 * checkbox, and Reset to default. With Needs you hidden while something
 * needs you, it carries a mark in Needs you's color, so nothing waiting goes
 * unseen.
 */
export function BoardColumns({
  layout,
  onLayout,
  workspaces,
}: {
  layout: BoardLayout;
  onLayout: (layout: BoardLayout) => void;
  workspaces: Workspace[];
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Needs you doesn't depend on git, so the workspaces' states are enough.
  const needs = workspaces.filter((w) => homeSection(w, null) === 'needs');
  const mark = layout.hidden.includes('needs') && needs.length > 0 ? needsTone(needs) : null;
  const shown = shownColumns(layout);
  const hiddenCount = layout.hidden.length;
  const markTitle = `Needs you is hidden · ${needs.length} ${needs.length === 1 ? 'workspace needs' : 'workspaces need'} you`;

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  return (
    <span ref={wrapper} className="relative mr-1.5 mb-[5px] flex self-center">
      <button
        ref={trigger}
        type="button"
        data-board-columns
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={mark ? markTitle : 'Show, hide and reset the Board’s columns'}
        className={`box-border flex h-[26px] items-center gap-1.5 rounded-md border border-line px-2.5 text-sm whitespace-nowrap outline-none hover:text-fg focus-visible:shadow-[0_0_0_1.5px_var(--color-focus)] ${
          open ? 'bg-raised text-fg' : 'bg-canvas text-fg-muted'
        }`}
        onClick={() => setOpen(!open)}
      >
        Columns
        {hiddenCount > 0 ? (
          <span data-board-columns-hidden className="text-fg-subtle">
            · {hiddenCount} hidden
          </span>
        ) : null}
        {mark ? (
          <span
            data-board-columns-mark={mark}
            role="img"
            aria-label={markTitle}
            className={`size-[7px] flex-none rounded-full ${MARK[mark]}`}
          />
        ) : null}
        <span aria-hidden className="text-xs text-fg-subtle">
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panel}
          role="dialog"
          aria-label="Columns"
          tabIndex={-1}
          data-board-columns-panel
          className="absolute top-full right-0 z-50 mt-1.5 w-[248px] rounded-md border border-line-strong bg-raised p-1 text-sm text-fg shadow-overlay outline-none"
        >
          <div className="px-2 pt-1.5 pb-1 text-xs text-fg-muted">
            Shown on the Board, left to right
          </div>
          {layout.order.map((column) => {
            const checked = !layout.hidden.includes(column);
            const last = checked && shown.length === 1;
            return (
              <label
                key={column}
                data-board-columns-option={column}
                title={last ? 'At least one column stays shown' : undefined}
                className={`flex h-[30px] items-center gap-2 rounded px-2 ${last ? 'text-fg-muted' : 'hover:bg-band-strong'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={last}
                  onChange={(e) => onLayout(setHidden(layout, column, !e.target.checked))}
                />
                <span className="min-w-0 flex-1 truncate">{BOARD_COLUMN_TITLE[column]}</span>
                {column === 'needs' && mark ? (
                  <span
                    title={markTitle}
                    className={`size-[7px] flex-none rounded-full ${MARK[mark]}`}
                  />
                ) : null}
              </label>
            );
          })}
          <div className="mt-1 border-t border-line px-1 pt-1.5 pb-1">
            <button
              type="button"
              data-board-columns-reset
              disabled={isDefaultLayout(layout)}
              className={button('secondary', 'sm')}
              onClick={() => onLayout(DEFAULT_BOARD_LAYOUT)}
            >
              Reset to default
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
