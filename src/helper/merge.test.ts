import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MergeCliResponse } from '../main/bridge/server';
import { envVar } from '../shared/brand';
import type { RepoMergeResult, RepoPreflight } from '../shared/merge-prs';
import { parseMergeArgs, runMerge } from './merge';

const row = (name: string, extra: Partial<RepoPreflight> = {}): RepoPreflight => ({
  projectId: name,
  name,
  primary: name === 'web',
  branch: 'feat',
  baseBranch: 'main',
  prUrl: `https://example.com/${name}/pull/1`,
  result: 'ready',
  problems: [],
  methods: ['squash', 'merge'],
  method: 'squash',
  head: 'abc',
  ...extra,
});

const result = (name: string, extra: Partial<RepoMergeResult>): RepoMergeResult => ({
  projectId: name,
  name,
  outcome: 'merged',
  reason: null,
  prUrl: `https://example.com/${name}/pull/1`,
  method: 'squash',
  commit: null,
  commitUrl: null,
  branchDeleted: null,
  deleteError: null,
  warning: null,
  ...extra,
});

/** `<slug> merge` (spec §21.10) against a stand-in for the app's bridge. */
describe('helper merge', () => {
  let server: http.Server;
  let received: Record<string, unknown>[];
  let answers: Record<'preflight' | 'merge', MergeCliResponse>;
  let env: NodeJS.ProcessEnv;
  let out: string;
  let err: string;
  const io = {
    out: (t: string) => {
      out += t;
    },
    err: (t: string) => {
      err += t;
    },
  };

  beforeEach(async () => {
    received = [];
    out = '';
    err = '';
    answers = {
      preflight: {
        ok: true,
        branch: 'feat',
        preflight: { workspaceId: 'ws_1', repos: [row('web'), row('api')] },
        report: null,
      },
      merge: {
        ok: true,
        branch: 'feat',
        preflight: null,
        report: {
          stopped: false,
          repos: [
            result('web', {
              commit: 'c1',
              commitUrl: 'https://example.com/web/commit/c1',
              branchDeleted: true,
            }),
            result('api', {}),
          ],
        },
      },
    };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { action: 'preflight' | 'merge' };
        received.push(parsed);
        res.end(JSON.stringify(answers[parsed.action]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    env = {
      [envVar('BRIDGE_URL')]: `http://127.0.0.1:${port}`,
      [envVar('BRIDGE_TOKEN')]: 'secret',
      [envVar('WORKSPACE_ID')]: 'ws_1',
    };
  });
  afterEach(() => server.close());

  it('reads its options', () => {
    expect(
      parseMergeArgs(['--order', 'infra, api', '--method', 'api=rebase', '--keep-branch', '-y']),
    ).toEqual({
      yes: true,
      order: ['infra', 'api'],
      methods: { api: 'rebase' },
      deleteBranch: false,
    });
    expect(parseMergeArgs(['--order=web'])).toMatchObject({ order: ['web'] });
    expect(parseMergeArgs(['--method', 'api'])).toEqual({
      error: '--method takes <repo>=<method>',
    });
    expect(parseMergeArgs(['--force'])).toEqual({ error: 'Unknown option --force' });
    expect(parseMergeArgs(['--help'])).toBe('help');
  });

  it('checks, then with --yes asks the app to merge in the order shown and prints the report', async () => {
    expect(
      await runMerge(['--yes', '--order', 'web,api'], { ...env, CLAUDECODE: '1' }, io, () => null),
    ).toBe(0);
    expect(received).toEqual([
      {
        action: 'preflight',
        workspaceId: 'ws_1',
        order: ['web', 'api'],
        methods: {},
        deleteBranch: true,
        byClaude: true,
      },
      {
        action: 'merge',
        workspaceId: 'ws_1',
        order: ['web', 'api'],
        methods: {},
        deleteBranch: true,
        byClaude: true,
      },
    ]);
    // --yes skips the terminal's question only: the app still waits for a click.
    expect(out).toMatch(/Waiting for you to confirm in .+ \(up to 10 minutes\)…\n/);
    expect(out).toContain('Merge all PRs of feat, in this order:\n');
    expect(out).toContain('1. web  feat → main  ✓ ready · Squash  https://example.com/web/pull/1');
    expect(out).toContain('nothing is undone');
    expect(out).toContain(
      '✓ web: merged (https://example.com/web/commit/c1)  https://example.com/web/pull/1, remote branch deleted',
    );
    expect(out).toContain('Merged 2 pull requests\n');
  });

  it('asks first without --yes, and needs --yes where it cannot ask', async () => {
    const asked: string[] = [];
    expect(
      await runMerge([], env, io, async (q) => {
        asked.push(q);
        return false;
      }),
    ).toBe(1);
    expect(asked).toEqual(['Merge 2 pull requests? [y/N] ']);
    expect(err).toBe('Nothing was merged.\n');
    expect(received.map((r) => r.action)).toEqual(['preflight']);

    err = '';
    expect(await runMerge([], env, io, () => null)).toBe(1);
    expect(err).toBe('Run it with --yes to merge: there is no terminal to ask in.\n');
    expect(received.map((r) => r.action)).toEqual(['preflight', 'preflight']);
  });

  it('merges nothing while a repository fails its checks, naming why', async () => {
    answers.preflight = {
      ok: true,
      branch: 'feat',
      preflight: {
        workspaceId: 'ws_1',
        repos: [
          row('web'),
          row('api', {
            result: 'failed',
            problems: ['Checks running: check again when they finish'],
          }),
        ],
      },
      report: null,
    };
    expect(await runMerge(['--yes'], env, io)).toBe(1);
    expect(out).toContain('✕ failed');
    expect(out).toContain('       Checks running: check again when they finish\n');
    expect(err).toBe('Not merging: fix the problems above, then run it again.\n');
    expect(received.map((r) => r.action)).toEqual(['preflight']);
  });

  it('reports a stop with what merged, what failed and what was skipped, with exit 1', async () => {
    answers.preflight = {
      ok: true,
      branch: 'feat',
      preflight: {
        workspaceId: 'ws_1',
        repos: [row('infra'), row('api'), row('web')],
      },
      report: null,
    };
    answers.merge = {
      ok: true,
      branch: 'feat',
      preflight: null,
      report: {
        stopped: true,
        repos: [
          result('infra', { commit: 'c1' }),
          result('api', { outcome: 'failed', reason: 'Checks failed' }),
          result('web', { outcome: 'skipped', prUrl: null, method: null }),
        ],
      },
    };
    expect(await runMerge(['--yes'], env, io)).toBe(1);
    expect(out).toContain('✓ infra: merged (c1)');
    expect(out).toContain('✕ api: Checks failed\n');
    expect(out).toContain('– web: skipped\n');
    expect(out).toContain('Merge stopped at api: Checks failed · 1 merged · 1 skipped\n');
    expect(out).toContain('The pull requests merged before the failure stay merged.\n');
  });

  it('prints why the app did not merge: cancelled or timed out there, with exit 1', async () => {
    answers.merge = { ok: false, error: 'Not confirmed in the app (timed out)' };
    expect(await runMerge(['--yes'], env, io)).toBe(1);
    expect(err).toBe('Not confirmed in the app (timed out)\n');
    expect(out).not.toContain('Merged');
  });

  it('prints a refusal, and exit 2 without the app', async () => {
    answers.preflight = { ok: false, error: 'merge runs in a workspace' };
    expect(await runMerge(['--yes'], env, io)).toBe(1);
    expect(err).toBe('merge runs in a workspace\n');
    expect(await runMerge(['--yes'], {}, io)).toBe(2);
  });
});
