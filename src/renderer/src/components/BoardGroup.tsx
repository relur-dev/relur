import type { BoardGroup as Group } from '@shared/board-group';
import { useEffect, useId, useRef, useState } from 'react';

const GROUPS: { id: Group; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'project', label: 'Project' },
];

const ITEM =
  'flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-left text-md outline-none hover:bg-selected focus-visible:bg-selected disabled:text-fg-subtle disabled:hover:bg-transparent';

/**
 * The Board's Group control (spec §6.7): "Group None ▾" or "Group Project ▾",
 * a menu to choose, and while grouped Expand all and Collapse all, each off
 * when it would change nothing.
 */
export function BoardGroup({
  group,
  onGroup,
  canExpand,
  canCollapse,
  onExpandAll,
  onCollapseAll,
}: {
  group: Group;
  onGroup: (group: Group) => void;
  canExpand: boolean;
  canCollapse: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
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

  const choose = (run: () => void) => {
    setOpen(false);
    run();
    trigger.current?.focus();
  };

  // ↑ ↓ move through the menu's items that are on, Home and End to its ends.
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === 'ArrowDown'
        ? (at + 1) % items.length
        : e.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    items[to]?.focus();
  };

  const label = GROUPS.find((g) => g.id === group)?.label ?? 'None';
  return (
    <span ref={wrapper} className="relative mr-1.5 mb-[5px] flex self-center">
      <button
        ref={trigger}
        type="button"
        data-board-group={group}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Group the Board · remembered for this profile"
        className={`box-border flex h-[26px] items-center gap-1.5 rounded-md border border-line pr-2 pl-2.5 text-sm whitespace-nowrap outline-none hover:border-line-strong hover:text-fg focus-visible:shadow-[0_0_0_1.5px_var(--color-focus)] ${
          open ? 'bg-raised text-fg' : 'bg-canvas text-fg-muted'
        }`}
        onClick={() => setOpen(!open)}
      >
        Group <span className="font-medium text-fg">{label}</span>
        <span aria-hidden className="text-xs text-fg-subtle">
          ▾
        </span>
      </button>
      {open ? (
        <div
          id={menuId}
          ref={menu}
          role="menu"
          aria-label="Group board by"
          tabIndex={-1}
          data-board-group-menu
          className="absolute top-full right-0 z-50 mt-1.5 flex w-[196px] flex-col rounded-lg border border-line-strong bg-raised p-1 text-fg shadow-overlay outline-none"
          onKeyDown={onMenuKey}
        >
          <div className="px-2 pt-1.5 pb-1 text-xs text-fg-subtle">Group board by</div>
          {GROUPS.map((g) => {
            const on = g.id === group;
            return (
              <button
                key={g.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                data-board-group-option={g.id}
                className={ITEM}
                onClick={() => choose(() => onGroup(g.id))}
              >
                <span aria-hidden className="w-3 text-center text-xs">
                  {on ? '✓' : ''}
                </span>
                <span className="flex-1">{g.label}</span>
              </button>
            );
          })}
          {group === 'project' ? (
            <>
              <hr className="mx-1 my-1 h-px border-0 bg-line" />
              <button
                type="button"
                role="menuitem"
                data-board-group-expand
                disabled={!canExpand}
                className={ITEM}
                onClick={() => choose(onExpandAll)}
              >
                <span className="w-3" />
                <span className="flex-1">Expand all</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-board-group-collapse
                disabled={!canCollapse}
                className={ITEM}
                onClick={() => choose(onCollapseAll)}
              >
                <span className="w-3" />
                <span className="flex-1">Collapse all</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
