import { describe, expect, it } from 'vitest';
import {
  boardLanes,
  parseBoardGroup,
  parseCollapsedLanes,
  serializeCollapsedLanes,
  toggleLane,
} from './board-group';
import { boardColumns } from './home';
import type { WorkspaceState } from './status';
import type { Workspace, WorkspaceRepo } from './workspaces';

const repo = (projectId: string, primary: boolean): WorkspaceRepo => ({
  projectId,
  primary,
  worktreePath: `/w/${projectId}`,
  baseBranch: 'main',
  pr: null,
  hasCommits: false,
  merged: null,
  setupError: null,
});

let n = 0;
function ws(projectId: string, state: WorkspaceState, linked: string[] = []): Workspace {
  n += 1;
  return {
    id: `w${n}`,
    profileId: 'p',
    projectId,
    name: `ABC-${n}`,
    task: { id: `ABC-${n}`, title: `Task ${n}`, url: null },
    branch: `abc-${n}`,
    baseBranch: 'main',
    worktreePath: `/w/${n}`,
    state,
    unread: false,
    stateMessage: null,
    stateSince: null,
    background: 0,
    unfinished: null,
    lastPrompt: null,
    keepRunning: false,
    claudeSessionId: null,
    ports: null,
    pr: null,
    repos: [repo(projectId, true), ...linked.map((p) => repo(p, false))],
    createdAt: '2026-11-01T10:00:00.000Z',
    lastActivityAt: null,
  };
}

const projects = [
  { id: 'web', name: 'web-app' },
  { id: 'api', name: 'api-service' },
  { id: 'ui', name: 'shared-ui' },
  { id: 'docs', name: 'docs' },
];

describe('parseBoardGroup', () => {
  it('reads Project, and anything else as None', () => {
    expect(parseBoardGroup('project')).toBe('project');
    expect(parseBoardGroup('none')).toBe('none');
    expect(parseBoardGroup(null)).toBe('none');
    expect(parseBoardGroup('status')).toBe('none');
  });
});

describe('collapsed bands', () => {
  it('reads distinct ids leniently', () => {
    expect(parseCollapsedLanes('["web","api","web"]')).toEqual(['web', 'api']);
    expect(parseCollapsedLanes('["web",3,null,""]')).toEqual(['web']);
    expect(parseCollapsedLanes('{"web":true}')).toEqual([]);
    expect(parseCollapsedLanes('not json')).toEqual([]);
    expect(parseCollapsedLanes(null)).toEqual([]);
  });

  it('stores none collapsed as nothing', () => {
    expect(serializeCollapsedLanes([])).toBeNull();
    expect(parseCollapsedLanes(serializeCollapsedLanes(['api', 'ui']))).toEqual(['api', 'ui']);
  });

  it('collapses and expands one band', () => {
    expect(toggleLane([], 'web')).toEqual(['web']);
    expect(toggleLane(['web', 'api'], 'web')).toEqual(['api']);
  });
});

describe('boardLanes', () => {
  it('has a band per project with workspaces of its own, in the projects’ order', () => {
    const list = [ws('ui', 'working'), ws('web', 'needs-permission'), ws('web', 'working')];
    const lanes = boardLanes(
      projects,
      list,
      boardColumns(list, () => null),
    );
    expect(lanes.map((l) => l.name)).toEqual(['web-app', 'shared-ui']);
    expect(lanes.map((l) => l.count)).toEqual([2, 1]);
  });

  it('puts each card in its own project’s band, in its Board column and order', () => {
    const a = ws('web', 'working');
    const b = ws('api', 'needs-input');
    const c = ws('web', 'interrupted');
    const d = ws('web', 'needs-permission');
    const list = [a, b, c, d];
    const columns = boardColumns(list, () => null);
    const [web, api] = boardLanes(projects, list, columns);
    expect(web?.columns.working).toEqual([a]);
    expect(web?.columns.idle).toEqual([c]);
    expect(web?.columns.needs).toEqual([d]);
    expect(web?.columns.ship).toEqual([]);
    expect(api?.columns.needs).toEqual([b]);
    // Every card shows once, in the band of the column it has ungrouped.
    for (const column of ['needs', 'working', 'idle', 'ship', 'merged'] as const) {
      const banded = [web, api].flatMap((l) => l?.columns[column] ?? []);
      expect(new Set(banded)).toEqual(new Set(columns[column]));
    }
  });

  it('counts linked-in workspaces without showing them, and no band for those alone', () => {
    const own = ws('web', 'working', ['api', 'ui']);
    const list = [own, ws('api', 'interrupted')];
    const lanes = boardLanes(
      projects,
      list,
      boardColumns(list, () => null),
    );
    expect(lanes.map((l) => [l.name, l.count, l.linkedIn])).toEqual([
      ['web-app', 1, 0],
      ['api-service', 1, 1],
    ]);
    const api = lanes[1];
    expect(Object.values(api?.columns ?? {}).flat()).not.toContain(own);
    // shared-ui has only a linked workspace: no band.
    expect(lanes.find((l) => l.projectId === 'ui')).toBeUndefined();
  });

  it('counts every workspace of a band, also in columns the Board hides', () => {
    const list = [ws('docs', 'interrupted'), ws('docs', 'working')];
    const [docs] = boardLanes(
      projects,
      list,
      boardColumns(list, () => null),
    );
    expect(docs?.count).toBe(2);
  });

  it('has no bands without workspaces', () => {
    expect(
      boardLanes(
        projects,
        [],
        boardColumns([], () => null),
      ),
    ).toEqual([]);
  });
});
