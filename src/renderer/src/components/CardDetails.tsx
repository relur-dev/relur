import type { CardDetail } from '@shared/home';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InfoIcon } from '../ui/icons';

/** How long the pointer rests on the ⓘ before the details show, and its grace on leaving. */
const OPEN_MS = 400;
const CLOSE_MS = 150;
/** The details' distance from the ⓘ and from the window's edges. */
const GAP = 6;
const MARGIN = 8;

/**
 * A Board card's ⓘ and its details (spec §6.7, components.md Board): hover
 * shows them after a short rest, a click (↵ or Space) pins them until a click
 * outside or Esc, and focus goes back to the ⓘ when they close. The details are
 * in a portal at the window's level, as the card lists clip and contain their
 * cards; events from them stop there, so they never open or drag the card.
 */
export function CardDetails({
  label,
  title,
  lines,
}: {
  /** What the details are for: "ABC-142", else the title. */
  label: string;
  title: string;
  lines: CardDetail[];
}) {
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const titleId = useId();

  const wait = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = () => {
    clearTimeout(timer.current);
    // Focus in the details goes back to the ⓘ.
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
    setOpen(null);
  };
  // Hover: shown after a rest, gone a moment after the pointer leaves the ⓘ and the details.
  // A held button is a drag passing over: nothing shows.
  const enter = (e: React.PointerEvent) => {
    if (e.buttons !== 0) return;
    if (open) clearTimeout(timer.current);
    else wait(() => setOpen((o) => o ?? 'hover'), OPEN_MS);
  };
  const leave = () => {
    if (open !== 'pinned') wait(() => setOpen((o) => (o === 'hover' ? null : o)), CLOSE_MS);
  };

  // Pinned: the details take focus; a click outside or Esc closes them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close reads refs only
  useEffect(() => {
    if (open !== 'pinned') return;
    panel.current?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!trigger.current?.contains(at) && !panel.current?.contains(at)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  // Esc closes them, pinned or shown by hover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close reads refs only
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (open === 'pinned') {
        e.preventDefault();
        e.stopPropagation();
      }
      close();
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [open]);

  // Below the ⓘ and right-aligned to it, above it where the window ends, always
  // inside the window; followed every frame, as cards move and columns scroll.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const place = () => {
      const t = trigger.current;
      const p = panel.current;
      if (!t || !p) return;
      const at = t.getBoundingClientRect();
      if (!t.isConnected || at.width === 0) {
        setOpen(null);
        return;
      }
      const width = p.offsetWidth;
      const height = p.offsetHeight;
      const left = Math.max(MARGIN, Math.min(at.right - width, window.innerWidth - MARGIN - width));
      let top = at.bottom + GAP;
      if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, at.top - GAP - height);
      p.style.left = `${left}px`;
      p.style.top = `${top}px`;
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-card-info
        aria-label={`Details for ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open ? id : undefined}
        className={`-my-0.5 flex size-[18px] flex-none items-center justify-center rounded-[4px] outline-none hover:text-fg focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-focus)] ${
          open ? 'text-fg' : 'text-fg-subtle'
        }`}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={(e) => {
          e.stopPropagation();
          if (open === 'pinned') close();
          else {
            clearTimeout(timer.current);
            setOpen('pinned');
          }
        }}
      >
        <InfoIcon />
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
              data-card-details
              data-card-details-pinned={open === 'pinned' || undefined}
              style={{ left: 0, top: 0 }}
              className="fixed z-50 w-max max-w-[min(360px,calc(100vw-16px))] min-w-[200px] rounded-md border border-line-strong bg-raised p-3 text-sm text-fg shadow-overlay outline-none select-text"
              onPointerEnter={enter}
              onPointerLeave={leave}
              onPointerDown={stop}
              onClick={stop}
              onDoubleClick={stop}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Tab leaves the details from the ⓘ, on to what follows it.
                if (e.key === 'Tab') close();
              }}
            >
              <div id={titleId} className="font-medium break-words">
                {title}
              </div>
              {lines.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {lines.map((l) => (
                    <li
                      key={l.kind}
                      data-card-detail={l.kind}
                      className={`break-words ${l.kind === 'state' ? 'text-fg' : 'text-fg-muted'}`}
                    >
                      {l.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-2.5 border-t border-line pt-2 text-xs text-fg-subtle">
                Click the card to open it, drag it to delete.
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
