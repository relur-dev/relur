/**
 * Files dragged from the system onto the window (spec §6.16). Only the places
 * that take them (a terminal, the Notes box) accept a drop; elsewhere the
 * pointer shows that a drop does nothing, and a drop does nothing.
 */
import { useEffect, useRef, useState } from 'react';

/** A drag that carries files from the system (not text or a tab). */
export const carriesFiles = (e: DragEvent | React.DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** The dropped files' paths on disk; files that aren't on disk are left out. */
export function droppedPaths(e: DragEvent | React.DragEvent): string[] {
  return Array.from(e.dataTransfer?.files ?? [])
    .map((file) => window.bridge.pathForFile(file))
    .filter((p) => p !== '');
}

/**
 * Turns file drops away everywhere but where a handler accepts them: it runs
 * first (capture) and says "none"; a drop target then says "copy". A drop is
 * never left to the page, which would open the file.
 */
export function refuseStrayDrops(): () => void {
  const over = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const drop = (e: DragEvent) => {
    if (carriesFiles(e)) e.preventDefault();
  };
  window.addEventListener('dragover', over, true);
  window.addEventListener('drop', drop, true);
  return () => {
    window.removeEventListener('dragover', over, true);
    window.removeEventListener('drop', drop, true);
  };
}

/**
 * A place that takes dropped files (spec §6.16): `over` while files are
 * dragged over it, for its highlight; `onPaths` with the dropped files'
 * paths. A drag that ends elsewhere (cancelled with Esc, dropped outside the
 * window) may send no dragleave; dragover repeats while it stays, so
 * `over` also ends 1.5 s after the last one.
 */
export function useFileDrop(accepts: boolean, onPaths: (paths: string[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = () => {
    clearTimeout(timer.current);
    depth.current = 0;
    setOver(false);
  };
  const takes = (e: React.DragEvent) => accepts && carriesFiles(e);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!takes(e)) return;
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(leave, 1500);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!takes(e)) return;
      depth.current -= 1;
      if (depth.current <= 0) leave();
    },
    onDrop: (e: React.DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      leave();
      onPaths(droppedPaths(e));
    },
  };
  return { over, handlers };
}
