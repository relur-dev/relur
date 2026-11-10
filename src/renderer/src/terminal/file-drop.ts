/**
 * Files dragged from the system onto the window (spec §6.16). Only the places
 * that take them (a terminal) accept a drop; elsewhere the pointer shows that
 * a drop does nothing, and a drop does nothing.
 */

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
