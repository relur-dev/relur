import type { Workspace } from '@shared/workspaces';
import { useEffect } from 'react';
import { FlagIcon } from '../ui/icons';

/**
 * The Board's Flagged filter (spec §6.7), left of Columns: pressed, the Board
 * shows only flagged workspaces. It turns itself off once none is flagged, so
 * the Board never stays empty behind it.
 */
export function BoardFlagged({
  on,
  onChange,
  workspaces,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Every workspace the Board would show without the filter. */
  workspaces: Pick<Workspace, 'flag'>[];
}) {
  const count = workspaces.filter((w) => w.flag).length;
  useEffect(() => {
    if (on && count === 0) onChange(false);
  }, [on, count, onChange]);
  const pressed = on && count > 0;
  return (
    <button
      type="button"
      data-board-flagged
      aria-pressed={pressed}
      disabled={count === 0}
      title={
        count === 0
          ? 'No flagged workspaces'
          : pressed
            ? 'Show every workspace'
            : 'Show only flagged workspaces'
      }
      className={`mr-1.5 mb-[5px] box-border flex h-[26px] items-center gap-1.5 self-center rounded-md border px-2.5 text-sm whitespace-nowrap outline-none focus-visible:shadow-[0_0_0_1.5px_var(--color-focus)] disabled:opacity-50 ${
        pressed
          ? 'border-line-strong bg-raised text-fg'
          : 'border-line bg-canvas text-fg-muted enabled:hover:text-fg'
      }`}
      onClick={() => onChange(!pressed)}
    >
      <span className={pressed || count > 0 ? 'text-flag' : 'text-fg-subtle'}>
        <FlagIcon size={12} filled={pressed} />
      </span>
      Flagged
      {count > 0 ? <span className="text-fg-subtle">· {count}</span> : null}
    </button>
  );
}
