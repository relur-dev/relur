import { describe, expect, it } from 'vitest';
import { type LastShown, parseLastShown, resolveLastShown, type ShownWorld } from './last-shown';

const world: ShownWorld = {
  profiles: [{ id: 'work' }, { id: 'private' }],
  projects: [
    { id: 'web', profileId: 'work' },
    { id: 'api', profileId: 'private' },
    { id: 'lib', profileId: 'private' },
  ],
  workspaces: [
    {
      id: 'w1',
      profileId: 'private',
      projectId: 'api',
      repos: [{ projectId: 'api' }, { projectId: 'lib' }],
    },
  ],
};

const inWorkspace = (tab: Extract<LastShown['view'], { kind: 'workspace' }>['tab']): LastShown => ({
  profileId: 'private',
  guide: false,
  view: {
    kind: 'workspace',
    projectId: 'api',
    workspaceId: 'w1',
    tab,
    changes: true,
    responses: false,
    notes: true,
  },
});

describe('resolveLastShown', () => {
  it('opens on the first profile when nothing is stored, and nowhere without profiles', () => {
    expect(resolveLastShown(null, world)).toEqual({
      profileId: 'work',
      guide: false,
      view: { kind: 'home', tab: 'overview' },
    });
    expect(resolveLastShown(inWorkspace({ kind: 'claude' }), { ...world, profiles: [] })).toBe(
      null,
    );
  });

  it('shows a workspace that still exists with its tab and panels', () => {
    const last = inWorkspace({ kind: 'shell', projectId: 'lib' });
    expect(resolveLastShown(last, world)).toEqual(last);
    const spec = inWorkspace({ kind: 'spec' });
    expect(resolveLastShown(spec, world)).toEqual(spec);
  });

  it('keeps Home and its tab, and a project view with its tab', () => {
    const home: LastShown = {
      profileId: 'private',
      guide: false,
      view: { kind: 'home', tab: 'terminal' },
    };
    expect(resolveLastShown(home, world)).toEqual(home);
    const project: LastShown = {
      profileId: 'private',
      guide: false,
      view: { kind: 'project', projectId: 'lib', tab: 'skills' },
    };
    expect(resolveLastShown(project, world)).toEqual(project);
  });

  it('falls back from a deleted workspace to its project', () => {
    const last = inWorkspace({ kind: 'claude' });
    expect(resolveLastShown(last, { ...world, workspaces: [] })).toEqual({
      profileId: 'private',
      guide: false,
      view: { kind: 'project', projectId: 'api', tab: 'workspaces' },
    });
  });

  it('falls back from a removed project to Home', () => {
    const last = inWorkspace({ kind: 'claude' });
    const removed = { ...world, projects: world.projects.filter((p) => p.id !== 'api') };
    expect(resolveLastShown(last, removed)).toEqual({
      profileId: 'private',
      guide: false,
      view: { kind: 'home', tab: 'overview' },
    });
    // A project now in another profile counts as removed from this one.
    const moved = {
      ...world,
      projects: world.projects.map((p) => (p.id === 'api' ? { ...p, profileId: 'work' } : p)),
    };
    expect(resolveLastShown(last, moved)?.view).toEqual({ kind: 'home', tab: 'overview' });
  });

  it('falls back from a removed profile to the first profile, keeping the Guide', () => {
    const last: LastShown = { ...inWorkspace({ kind: 'claude' }), guide: true };
    expect(resolveLastShown(last, { ...world, profiles: [{ id: 'work' }] })).toEqual({
      profileId: 'work',
      guide: true,
      view: { kind: 'home', tab: 'overview' },
    });
  });

  it("falls back from a shell in a repository that's no longer linked to Claude", () => {
    const last = inWorkspace({ kind: 'shell', projectId: 'lib' });
    const unlinked = {
      ...world,
      workspaces: world.workspaces.map((w) => ({ ...w, repos: [{ projectId: 'api' }] })),
    };
    expect(resolveLastShown(last, unlinked)).toEqual(inWorkspace({ kind: 'claude' }));
    // The main repository's shell always stays.
    const main = inWorkspace({ kind: 'shell', projectId: 'api' });
    expect(resolveLastShown(main, unlinked)).toEqual(main);
  });
});

describe('parseLastShown', () => {
  it('reads what was stored', () => {
    const last = inWorkspace({ kind: 'shell', projectId: 'lib' });
    expect(parseLastShown(JSON.stringify(last))).toEqual(last);
  });

  it('ignores nothing stored and anything unreadable', () => {
    expect(parseLastShown(null)).toBe(null);
    expect(parseLastShown('{')).toBe(null);
    expect(parseLastShown('null')).toBe(null);
    expect(parseLastShown('{"guide":true}')).toBe(null);
  });

  it('reads damaged parts as the nearest sensible view', () => {
    expect(parseLastShown('{"profileId":"work","view":{"kind":"workspace"}}')).toEqual({
      profileId: 'work',
      guide: false,
      view: { kind: 'home', tab: 'overview' },
    });
    expect(
      parseLastShown(
        '{"profileId":"work","view":{"kind":"workspace","projectId":"web","workspaceId":"w","tab":{"kind":"shell"}}}',
      )?.view,
    ).toEqual({
      kind: 'workspace',
      projectId: 'web',
      workspaceId: 'w',
      tab: { kind: 'claude' },
      changes: false,
      responses: false,
      notes: false,
    });
    expect(
      parseLastShown('{"profileId":"work","view":{"kind":"project","projectId":"web"}}')?.view,
    ).toEqual({ kind: 'project', projectId: 'web', tab: 'workspaces' });
  });
});
