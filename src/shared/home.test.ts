import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMNS,
  boardColumn,
  boardColumns,
  type HomeSection,
  homeSection,
  homeSections,
  mergedLabel,
  permissionTool,
  prNumber,
  projectCounts,
  prText,
  quickReply,
  type ShipState,
  shipCandidates,
  shipStep,
  workingFor,
} from './home';
import type { WorkspaceState } from './status';
import type { PrStatus, Workspace, WorkspaceRepo } from './workspaces';

const pr = (state: PrStatus['state'], n = 212): PrStatus => ({
  state,
  url: `https://git.example.com/acme/web-app/pull/${n}`,
  source: 'command',
});

const repo = (projectId: string, primary: boolean, more: Partial<WorkspaceRepo> = {}) => ({
  projectId,
  primary,
  worktreePath: `/w/${projectId}`,
  baseBranch: 'main',
  pr: null,
  hasCommits: false,
  merged: null,
  setupError: null,
  ...more,
});

let n = 0;
function ws(state: WorkspaceState, more: Partial<Workspace> = {}): Workspace {
  n += 1;
  return {
    id: `w${n}`,
    profileId: 'p',
    projectId: 'web',
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
    claudeMayLink: true,
    claudeSessionId: null,
    ports: null,
    pr: null,
    repos: [repo('web', true)],
    createdAt: '2026-11-01T10:00:00.000Z',
    lastActivityAt: null,
    ...more,
  };
}

const dirty: ShipState = { uncommitted: 4, unpushed: 0 };
const ahead: ShipState = { uncommitted: 0, unpushed: 3 };
const clean: ShipState = { uncommitted: 0, unpushed: 0 };

describe('homeSection', () => {
  it('puts permission, input, approval and Unfinished under Needs you', () => {
    expect(homeSection(ws('needs-permission'), null)).toBe('needs');
    expect(homeSection(ws('needs-input'), null)).toBe('needs');
    expect(homeSection(ws('awaiting-approval'), null)).toBe('needs');
    const cut = { kind: 'working' as const, since: '2026-11-01T10:00:00.000Z', stopped: 0 };
    expect(homeSection(ws('interrupted', { unfinished: cut }), null)).toBe('needs');
    // Needs you wins over anything it has left to ship.
    expect(homeSection(ws('needs-input', { unfinished: cut }), dirty)).toBe('needs');
  });

  it('puts working workspaces under Working now', () => {
    expect(homeSection(ws('working'), dirty)).toBe('working');
    expect(homeSection(ws('starting'), dirty)).toBeNull();
  });

  it('puts merged workspaces under Clean up, even Done with changes left', () => {
    const merged = { repos: [repo('web', true, { pr: pr('merged'), hasCommits: true })] };
    expect(homeSection(ws('done', merged), dirty)).toBe('clean');
    expect(homeSection(ws('exited', merged), null)).toBe('clean');
    const likely = { repos: [repo('web', true, { pr: pr('likely-merged'), hasCommits: true })] };
    expect(homeSection(ws('interrupted', likely), null)).toBe('clean');
    // Working or needing you comes first.
    expect(homeSection(ws('working', merged), null)).toBe('working');
    expect(homeSection(ws('needs-permission', merged), null)).toBe('needs');
  });

  it('counts a branch merged into its base without a PR, also only locally (§14.2)', () => {
    const local = { repos: [repo('web', true, { hasCommits: true, merged: 'local' })] };
    expect(homeSection(ws('done', local), ahead)).toBe('clean');
    expect(boardColumn(ws('done', local), ahead)).toBe('merged');
    expect(shipCandidates([ws('done', local)])).toEqual([]);
    const base = { repos: [repo('web', true, { hasCommits: true, merged: 'base' })] };
    expect(homeSection(ws('exited', base), null)).toBe('clean');
    // The PR's text wins over the base's.
    expect(mergedLabel(repo('web', true, { merged: 'local' }))).toBe(
      'Merged into your local main (not pushed yet)',
    );
    expect(mergedLabel(repo('web', true, { merged: 'base' }))).toBe('Merged into main');
    expect(mergedLabel(repo('web', true, { merged: 'base', pr: pr('merged') }))).toBe(
      'PR #212 merged',
    );
  });

  it('puts Done workspaces with something to ship under Ready to ship', () => {
    expect(homeSection(ws('done'), dirty)).toBe('ship');
    expect(homeSection(ws('done'), ahead)).toBe('ship');
    const open = { repos: [repo('web', true, { pr: pr('open'), hasCommits: true })] };
    expect(homeSection(ws('done', open), clean)).toBe('ship');
    expect(homeSection(ws('done', open), null)).toBe('ship');
  });

  it('leaves out the rest', () => {
    expect(homeSection(ws('done'), clean)).toBeNull();
    expect(homeSection(ws('done'), null)).toBeNull();
    // Only Done workspaces are ready to ship.
    expect(homeSection(ws('interrupted'), dirty)).toBeNull();
    expect(homeSection(ws('exited'), dirty)).toBeNull();
    expect(homeSection(ws('error'), dirty)).toBeNull();
    const closed = { repos: [repo('web', true, { pr: pr('closed'), hasCommits: true })] };
    expect(homeSection(ws('done', closed), clean)).toBeNull();
  });

  it('counts a linked workspace as merged only when every repository with work is', () => {
    const half = {
      repos: [
        repo('web', true, { pr: pr('merged'), hasCommits: true }),
        repo('api', false, { pr: pr('open', 5), hasCommits: true }),
      ],
    };
    expect(homeSection(ws('done', half), clean)).toBe('ship');
    expect(shipStep(ws('done', half), clean)).toEqual({ kind: 'pr', pr: pr('open', 5) });
  });
});

describe('shipStep', () => {
  it('offers Commit, then Push, then View PR', () => {
    const open = ws('done', { repos: [repo('web', true, { pr: pr('draft') })] });
    expect(shipStep(open, { uncommitted: 2, unpushed: 1 })).toEqual({ kind: 'commit', files: 2 });
    expect(shipStep(open, ahead)).toEqual({ kind: 'push', commits: 3 });
    expect(shipStep(open, clean)).toEqual({ kind: 'pr', pr: pr('draft') });
    expect(shipStep(ws('done'), clean)).toBeNull();
  });
});

describe('homeSections', () => {
  it('orders Needs you oldest first, as ⌘J goes, with Unfinished by when Claude stopped', () => {
    const a = ws('needs-input', { stateSince: '2026-11-01T12:00:00.000Z' });
    const b = ws('needs-permission', { stateSince: '2026-11-01T11:00:00.000Z' });
    const c = ws('exited', {
      unfinished: { kind: 'interrupted', since: '2026-11-01T11:30:00.000Z', stopped: 0 },
    });
    const sections = homeSections([a, b, c], () => null);
    expect(sections.needs.map((w) => w.id)).toEqual([b.id, c.id, a.id]);
  });

  it('orders Working now longest first and the rest by last activity', () => {
    const w1 = ws('working', { stateSince: '2026-11-01T12:00:00.000Z' });
    const w2 = ws('working', { stateSince: '2026-11-01T11:00:00.000Z' });
    const s1 = ws('done', { lastActivityAt: '2026-11-01T09:00:00.000Z' });
    const s2 = ws('done', { lastActivityAt: '2026-11-01T10:00:00.000Z' });
    const sections = homeSections([w1, w2, s1, s2], () => dirty);
    expect(sections.working.map((w) => w.id)).toEqual([w2.id, w1.id]);
    expect(sections.ship.map((w) => w.id)).toEqual([s2.id, s1.id]);
    expect(sections.clean).toEqual([]);
  });

  it('puts every workspace in one section at most', () => {
    const all = [
      ws('needs-input'),
      ws('working'),
      ws('done'),
      ws('done', { repos: [repo('web', true, { pr: pr('merged'), hasCommits: true })] }),
      ws('done'),
    ];
    const sections = homeSections(all, (id) => (id === all[4]?.id ? clean : dirty));
    const ids = Object.values(sections).flatMap((list) => list.map((w) => w.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });
});

describe('shipCandidates', () => {
  it('asks git only for Done workspaces that are not merged or needing you', () => {
    const done = ws('done');
    const merged = ws('done', {
      repos: [repo('web', true, { pr: pr('merged'), hasCommits: true })],
    });
    const cut = ws('done', {
      unfinished: { kind: 'commands', since: '2026-11-01T10:00:00.000Z', stopped: 1 },
    });
    expect(shipCandidates([done, merged, cut, ws('working')]).map((w) => w.id)).toEqual([done.id]);
  });
});

describe('pull request text', () => {
  it('takes the number from the address', () => {
    expect(prNumber(pr('open', 212))).toBe('#212');
    expect(prNumber({ url: 'https://git.example.com/g/p/-/merge_requests/7' })).toBe('#7');
    expect(prNumber({ url: null })).toBeNull();
    expect(prText(pr('open', 212))).toBe('PR #212 open');
    expect(prText(pr('merged', 198))).toBe('PR #198 merged');
    expect(prText({ state: 'draft', url: null, source: 'git' })).toBe('PR draft');
  });
});

describe('workingFor', () => {
  it('says how long it has been working', () => {
    const now = Date.parse('2026-11-01T12:00:00.000Z');
    expect(workingFor('2026-11-01T11:59:30.000Z', now)).toBe('working for less than a minute');
    expect(workingFor('2026-11-01T11:56:00.000Z', now)).toBe('working for 4 min');
    expect(workingFor('2026-11-01T10:55:00.000Z', now)).toBe('working for 1 h 5 min');
    expect(workingFor('2026-11-01T10:00:00.000Z', now)).toBe('working for 2 h');
  });
});

describe('projectCounts', () => {
  it('counts own workspaces and those the project is linked into', () => {
    const own = ws('done');
    const linked = ws('done', { projectId: 'api', repos: [repo('api', true), repo('web', false)] });
    expect(projectCounts(['web', 'api', 'ui'], [own, linked])).toEqual([
      { projectId: 'web', count: 1, linked: 1 },
      { projectId: 'api', count: 1, linked: 0 },
      { projectId: 'ui', count: 0, linked: 0 },
    ]);
  });
});

describe('boardColumns', () => {
  const merged = { repos: [repo('web', true, { pr: pr('merged'), hasCommits: true })] };
  const all = () => [
    ws('needs-permission', { stateSince: '2026-11-01T11:00:00.000Z' }),
    ws('needs-input', { stateSince: '2026-11-01T10:00:00.000Z' }),
    ws('awaiting-approval'),
    ws('exited', {
      unfinished: { kind: 'working', since: '2026-11-01T09:00:00.000Z', stopped: 0 },
    }),
    ws('working', { background: 2 }),
    ws('done'),
    ws('done', merged),
    ws('interrupted', { lastActivityAt: '2026-11-01T08:00:00.000Z' }),
    ws('exited', { lastActivityAt: '2026-11-01T09:00:00.000Z' }),
    ws('starting'),
    ws('error'),
    ws('done', { lastActivityAt: '2026-11-01T07:00:00.000Z' }),
  ];

  it('matches the List: each section is its column, in the same order', () => {
    const list = all();
    const ship = (id: string) => (id === list[5]?.id ? dirty : clean);
    const sections = homeSections(list, ship);
    const columns = boardColumns(list, ship);
    const pairs: [HomeSection, keyof typeof columns][] = [
      ['needs', 'needs'],
      ['working', 'working'],
      ['ship', 'ship'],
      ['clean', 'merged'],
    ];
    for (const [section, column] of pairs) {
      expect(columns[column].map((w) => w.id)).toEqual(sections[section].map((w) => w.id));
    }
    for (const w of list) {
      const section = homeSection(w, ship(w.id));
      expect(boardColumn(w, ship(w.id))).toBe(
        section === null ? 'idle' : section === 'clean' ? 'merged' : section,
      );
    }
  });

  it('orders the columns Working, Idle, Needs you, Ready to ship, Merged', () => {
    expect(BOARD_COLUMNS).toEqual(['working', 'idle', 'needs', 'ship', 'merged']);
  });

  it('puts every workspace in exactly one column, the rest under Idle by last activity', () => {
    const list = all();
    const columns = boardColumns(list, () => clean);
    const ids = BOARD_COLUMNS.flatMap((c) => columns[c].map((w) => w.id));
    expect(new Set(ids).size).toBe(list.length);
    expect(ids).toHaveLength(list.length);
    // Interrupted, exited, starting, error and Done with nothing to ship.
    expect(columns.idle.map((w) => w.state).sort()).toEqual(
      ['done', 'done', 'error', 'exited', 'interrupted', 'starting'].sort(),
    );
    const dated = columns.idle.filter((w) => w.lastActivityAt).map((w) => w.state);
    expect(dated).toEqual(['exited', 'interrupted', 'done']);
  });

  it('moves a workspace when its state changes', () => {
    const w = ws('working');
    expect(boardColumn(w, null)).toBe('working');
    expect(boardColumn({ ...w, state: 'needs-input' }, null)).toBe('needs');
    expect(boardColumn({ ...w, state: 'interrupted' }, null)).toBe('idle');
    expect(boardColumn({ ...w, state: 'done' }, dirty)).toBe('ship');
    expect(boardColumn({ ...w, state: 'done', ...merged }, dirty)).toBe('merged');
  });
});

describe('quickReply', () => {
  const running = { status: 'running' as const, resuming: false };
  const suspended = { status: 'suspended' as const, resuming: false };
  const facts = (
    claude: typeof running | typeof suspended | null,
    draft = false,
    question = false,
  ) => ({ claude, draft, question });

  it('offers the field where Claude waits at its prompt or works', () => {
    for (const state of [
      'working',
      'needs-input',
      'awaiting-approval',
      'done',
      'interrupted',
    ] as const) {
      expect(quickReply(ws(state), 'idle', facts(running))).toBe('field');
    }
  });

  it('offers it on a suspended Claude, which resumes first', () => {
    expect(quickReply(ws('starting'), 'idle', facts(suspended))).toBe('field');
    expect(quickReply(ws('done'), 'ship', facts(suspended))).toBe('field');
  });

  it('never on a permission request: Open instead', () => {
    expect(quickReply(ws('needs-permission'), 'needs', facts(running))).toBe('open');
    // Nor at a question whose options the transcript doesn't have yet.
    expect(quickReply(ws('needs-answer'), 'needs', facts(running))).toBe('open');
    const cut = { kind: 'permission' as const, since: '2026-11-01T10:00:00.000Z', stopped: 0 };
    expect(quickReply(ws('interrupted', { unfinished: cut }), 'needs', facts(running))).toBe(
      'open',
    );
  });

  it('offers it on a merged workspace that needs you, whose card is under Needs you', () => {
    const merged = { repos: [repo('web', true, { pr: pr('merged'), hasCommits: true })] };
    const w = ws('needs-input', merged);
    expect(boardColumn(w, null)).toBe('needs');
    expect(quickReply(w, boardColumn(w, null), facts(running))).toBe('field');
    expect(
      quickReply(ws('done', merged), boardColumn(ws('done', merged), null), facts(running)),
    ).toBe('none');
  });

  it("offers the question's options at Claude's question menu, in place of the field or Open", () => {
    // Claude Code reads it as Working first, then as a permission request.
    for (const [state, column] of [
      ['working', 'working'],
      ['needs-permission', 'needs'],
      ['needs-answer', 'needs'],
    ] as const) {
      expect(quickReply(ws(state), column, facts(running, false, true))).toBe('question');
      expect(quickReply(ws(state), column, facts(running, true, true))).toBe('question');
    }
    // Not on Merged, nor once Claude no longer runs.
    expect(quickReply(ws('done'), 'merged', facts(running, false, true))).toBe('none');
    expect(quickReply(ws('done'), 'idle', facts(null, false, true))).toBe('none');
  });

  it('never over a draft', () => {
    expect(quickReply(ws('needs-input'), 'needs', facts(running, true))).toBe('draft');
  });

  it('never on Merged, an exited Claude, none at all, or one not ready', () => {
    expect(quickReply(ws('done'), 'merged', facts(running))).toBe('none');
    expect(
      quickReply(ws('exited'), 'idle', facts({ status: 'exited', resuming: false } as never)),
    ).toBe('none');
    expect(quickReply(ws('done'), 'idle', facts(null))).toBe('none');
    expect(quickReply(ws('starting'), 'idle', facts(running))).toBe('none');
    expect(quickReply(ws('error'), 'idle', facts(running))).toBe('none');
    expect(quickReply(ws('done'), 'idle', facts({ status: 'running', resuming: true }))).toBe(
      'none',
    );
  });
});

describe('permissionTool', () => {
  it('names the tool of a permission request', () => {
    expect(permissionTool('Claude needs your permission to use Bash')).toBe('Bash');
    expect(permissionTool('Something else')).toBe('Something else');
    expect(permissionTool(null)).toBeNull();
    // Claude Code's notice for its question tool names no tool.
    expect(permissionTool('Claude needs your permission')).toBeNull();
  });
});
