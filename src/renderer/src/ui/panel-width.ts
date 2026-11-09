import { type PointerEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { remember } from './remember';

/** A side panel's narrowest width (spec §6.8, §6.15). */
export const PANEL_MIN_WIDTH = 320;
/** At most this share of the workspace area. */
const MAX_SHARE = 0.7;

function savedWidth(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= PANEL_MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

/**
 * A side panel's width beside the terminal (spec §6.8, §6.15): dragged by its
 * left edge, between PANEL_MIN_WIDTH and 70 % of the workspace area (the
 * panel's parent), kept in the window's local storage under `key`.
 */
export function usePanelWidth(key: string, panel: RefObject<HTMLElement | null>, initial: number) {
  const [width, setWidth] = useState(() => savedWidth(key) ?? initial);
  const [areaWidth, setAreaWidth] = useState(0);
  useLayoutEffect(() => {
    const area = panel.current?.parentElement;
    if (!area) return;
    const observer = new ResizeObserver(() => setAreaWidth(area.clientWidth));
    observer.observe(area);
    setAreaWidth(area.clientWidth);
    return () => observer.disconnect();
  }, [panel]);
  const clamp = (value: number) =>
    Math.max(PANEL_MIN_WIDTH, Math.min(value, areaWidth > 0 ? areaWidth * MAX_SHARE : value));
  const shown = clamp(width);
  // The drag's latest width, saved on release (the render may not have caught up yet).
  const drag = useRef<{ x: number; width: number; now: number } | null>(null);
  const handle = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width: shown, now: shown };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      drag.current.now = clamp(drag.current.width + drag.current.x - event.clientX);
      setWidth(drag.current.now);
    },
    onPointerUp: () => {
      if (!drag.current) return;
      remember(key, String(Math.round(drag.current.now)));
      drag.current = null;
    },
  };
  return { width: shown, handle: { ...handle, onPointerCancel: handle.onPointerUp } };
}
