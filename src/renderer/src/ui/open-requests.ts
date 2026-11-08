/**
 * What a workspace should show once it opens, asked for by Home's Overview
 * (spec §6.7): the spec view (Review at a gate) or the commit box in its
 * Changes panel (Commit…); and at start, the spec view or the Responses panel
 * shown when the app quit (spec §5); from a Board card, the Responses panel at
 * one entry (spec §6.7). The workspace view takes each request once.
 */
type Request = 'spec' | 'commit' | 'responses';

const pending = new Map<string, Map<Request, number>>();

/** Requests older than this are stale: the view never opened. */
const FRESH_MS = 10_000;

/** The Responses entry (0-based) to show, by workspace, with when it was asked. */
const entries = new Map<string, { entry: number; at: number }>();

export function requestOnOpen(workspaceId: string, what: Request, entry?: number): void {
  const requests = pending.get(workspaceId) ?? new Map<Request, number>();
  requests.set(what, Date.now());
  pending.set(workspaceId, requests);
  if (what === 'responses' && entry !== undefined) {
    entries.set(workspaceId, { entry, at: Date.now() });
  }
}

/** The Responses entry asked for with the panel, if any; the request is used up. */
export function takeResponseEntry(workspaceId: string): number | null {
  const asked = entries.get(workspaceId);
  entries.delete(workspaceId);
  return asked && Date.now() - asked.at < FRESH_MS ? asked.entry : null;
}

/** Whether `what` was asked for this workspace; the request is used up. */
export function takeRequest(workspaceId: string, what: Request): boolean {
  const requests = pending.get(workspaceId);
  const at = requests?.get(what);
  if (!requests || at === undefined) return false;
  requests.delete(what);
  if (requests.size === 0) pending.delete(workspaceId);
  return Date.now() - at < FRESH_MS;
}
