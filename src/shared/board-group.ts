import type { BoardColumn } from './home';
import type { Workspace } from './workspaces';

/**
 * How the Board groups its cards (spec §6.7): not at all, or in a band per
 * project under the shared column headers.
 */
export type BoardGroup = 'none' | 'project';

/** A stored grouping; anything but Project is None, the default. */
export const parseBoardGroup = (raw: string | null): BoardGroup =>
  raw === 'project' ? 'project' : 'none';

/**
 * The collapsed bands, by project id, read leniently: anything unreadable is
 * none, and only distinct strings are kept. Ids of projects that are gone do
 * no harm; a new project starts expanded.
 */
export function parseCollapsedLanes(raw: string | null): string[] {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!Array.isArray(data)) return [];
  return [...new Set(data.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** None collapsed is stored as nothing. */
export const serializeCollapsedLanes = (ids: string[]): string | null =>
  ids.length === 0 ? null : JSON.stringify([...new Set(ids)]);

/** A project's band on the grouped Board. */
export interface BoardLane {
  projectId: string;
  name: string;
  /** Its own workspaces by column, in each column's order. */
  columns: Record<BoardColumn, Workspace[]>;
  /** Its own workspaces, in every column, hidden ones too. */
  count: number;
  /** Other projects' workspaces linked into it (spec §21.1): counted, not shown here. */
  linkedIn: number;
}

/**
 * The bands of the grouped Board (spec §6.7): one per project with at least
 * one workspace of its own, in the projects' order. A workspace is a card in
 * its own project's band only, in the column it has on the Board.
 */
export function boardLanes(
  projects: { id: string; name: string }[],
  workspaces: Pick<Workspace, 'id' | 'projectId' | 'repos'>[],
  columns: Record<BoardColumn, Workspace[]>,
): BoardLane[] {
  const lanes: BoardLane[] = [];
  for (const p of projects) {
    const count = workspaces.filter((w) => w.projectId === p.id).length;
    if (count === 0) continue;
    const own = (list: Workspace[]) => list.filter((w) => w.projectId === p.id);
    lanes.push({
      projectId: p.id,
      name: p.name,
      columns: {
        needs: own(columns.needs),
        working: own(columns.working),
        idle: own(columns.idle),
        ship: own(columns.ship),
        merged: own(columns.merged),
      },
      count,
      linkedIn: workspaces.filter(
        (w) => w.projectId !== p.id && w.repos.some((r) => r.projectId === p.id),
      ).length,
    });
  }
  return lanes;
}

/** Collapse a band, or expand it. */
export const toggleLane = (collapsed: string[], projectId: string): string[] =>
  collapsed.includes(projectId)
    ? collapsed.filter((id) => id !== projectId)
    : [...collapsed, projectId];
