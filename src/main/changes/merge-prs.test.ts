import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { envVar } from '@shared/brand';
import { githubPreset } from '@shared/merge-prs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MergeCliRequest } from '../bridge/server';
import { ConfigStore } from '../config/store';
import { openStateDb } from '../db/state-db';
import { WorkspaceRecords } from '../db/workspaces';
import type { TerminalService } from '../services/terminals';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { SEED_CONFIG } from '../test-support/seed-config';
import { FinishService, parsePrDetails } from './finish';
import { MergePrsService } from './merge-prs';

/**
 * Merge all PRs (spec §21.10) with real repositories: three on local bare
 * remotes, a status command that answers per repository from files (with
 * the pushed commit as the PR's head) and a merge command that records its
 * calls and fails where told to.
 */
describe('MergePrsService with local bare remotes', () => {
  type Name = 'web' | 'infra' | 'api';
  const names: Name[] = ['web', 'infra', 'api'];
  const bases: Record<Name, string> = { web: 'main', infra: 'main', api: 'dev' };
  const id = 'ws_merge';
  const branch = 'PROJ-9-ship';
  let fx: Fixture;
  let trees: Record<Name, string>;
  let origins: Record<Name, string>;
  let service: MergePrsService;
  let makeService: (options: ConstructorParameters<typeof MergePrsService>[2]) => MergePrsService;
  let state: string;
  const merges = () =>
    fs.existsSync(path.join(state, 'merges'))
      ? fs.readFileSync(path.join(state, 'merges'), 'utf8').trim().split('\n')
      : [];
  const remoteHas = (name: Name) => fx.git(origins[name], 'branch', '--list', branch).trim() !== '';

  beforeAll(() => {
    fx = createFixture();
    state = path.join(fx.root, 'state');
    fs.mkdirSync(state);
    trees = {} as typeof trees;
    origins = {} as typeof origins;
    const projects = names.map((name) => {
      const { origin, clone } = fx.cloneWithRemote(name, bases[name]);
      origins[name] = origin;
      trees[name] = path.join(fx.root, 'wt', name);
      fx.git(
        clone,
        'worktree',
        'add',
        '-q',
        '--no-track',
        '-b',
        branch,
        trees[name],
        `origin/${bases[name]}`,
      );
      fs.writeFileSync(path.join(trees[name], `${name}.txt`), `${name}\n`);
      fx.git(trees[name], 'add', '.');
      fx.git(trees[name], 'commit', '-qm', `PROJ-9: ${name}`);
      fx.git(trees[name], 'push', '-q', '-u', 'origin', branch);
      return {
        id: name,
        profileId: 'work',
        name,
        repoPath: clone,
        remote: 'origin',
        baseBranch: bases[name],
        ...(name === 'api' ? { pr: { mergeMethod: 'rebase' } } : {}),
      };
    });
    // The status command: a PR per repository, open and mergeable at the
    // pushed commit, unless a file says otherwise; merged once merged.
    const status = [
      'n=$(basename "$PWD")',
      `s=${state}`,
      'if [ -f "$s/merged-$n" ]; then printf \'{"state":"merged","url":"https://example.com/%s/pull/1"}\' "$n"; exit 0; fi',
      'if [ -f "$s/pr-$n.json" ]; then cat "$s/pr-$n.json"; exit 0; fi',
      'case "$n" in api) b=dev ;; *) b=main ;; esac',
      'h=$(git rev-parse "refs/remotes/origin/$(git branch --show-current)")',
      'printf \'{"state":"open","url":"https://example.com/%s/pull/1","base":"%s","head":"%s","mergeable":true,"checks":"passed","methods":["merge","rebase"]}\' "$n" "$b" "$h"',
    ].join('\n');
    const merge = [
      'n=$(basename "$PWD")',
      `s=${state}`,
      `echo "$n $${envVar('MERGE_METHOD')} $${envVar('PR_HEAD')}" >> "$s/merges"`,
      'if [ -f "$s/fail-$n" ]; then echo "Merge conflict on the host" >&2; exit 1; fi',
      'touch "$s/merged-$n"',
      // Merged on the host, then a step of its own fails.
      'if [ -f "$s/fail-after-$n" ]; then echo "failed to delete local branch $n" >&2; exit 1; fi',
      'printf \'{"commit":"c-%s","commitUrl":"https://example.com/%s/commit/c"}\\n\' "$n" "$n"',
    ].join('\n');
    const file = path.join(fx.root, 'config', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) =>
          p.id === 'work' ? { ...p, pr: { statusCommand: status, mergeCommand: merge } } : p,
        ),
        projects,
      }),
    );
    const config = new ConfigStore(file);
    config.load();
    const records = new WorkspaceRecords(openStateDb(':memory:'));
    records.insert({
      id,
      profileId: 'work',
      projectId: 'web',
      name: 'PROJ-9 Ship',
      task: { id: 'PROJ-9', title: 'Ship', url: null },
      branch,
      baseBranch: 'main',
      worktreePath: trees.web,
      state: 'done',
      unread: false,
      stateMessage: null,
      background: 0,
      stateSince: null,
      claudeSessionId: null,
      ports: null,
      pr: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: null,
      // Linked in this order: infra, then api.
      repos: [
        { projectId: 'infra', worktreePath: trees.infra, baseBranch: 'main' },
        { projectId: 'api', worktreePath: trees.api, baseBranch: 'dev' },
      ],
    });
    const terminals = {
      workspaceCommandEnv: async () => ({ shell: '/bin/sh', env: { ...fx.env } }),
      host: { list: () => [] },
    } as unknown as TerminalService;
    const finish = new FinishService(config, records, terminals);
    service = new MergePrsService(finish, (w) => records.get(w));
    makeService = (options) => new MergePrsService(finish, (w) => records.get(w), options);
  });
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    for (const f of fs.readdirSync(state)) fs.rmSync(path.join(state, f));
  });

  it('checks every repository: primary first, then in link order, with each method', async () => {
    const { repos } = await service.preflight(id);
    expect(repos.map((r) => [r.name, r.result, r.baseBranch, r.method, r.problems])).toEqual([
      ['web', 'ready', 'main', 'merge', []],
      ['infra', 'ready', 'main', 'merge', []],
      // api's own pr.mergeMethod, which the host allows.
      ['api', 'ready', 'dev', 'rebase', []],
    ]);
    expect(repos[0]?.head).toBe(fx.git(trees.web, 'rev-parse', 'HEAD').trim());
    expect(repos[0]?.prUrl).toBe('https://example.com/web/pull/1');
  });

  it('refuses a dirty tree, unpushed and unpulled commits, and pending checks', async () => {
    fs.writeFileSync(path.join(trees.web, 'web.txt'), 'changed\n');
    fx.git(trees.infra, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const other = path.join(fx.root, 'other-api');
    fx.git(fx.root, 'clone', '-q', '-b', branch, origins.api, other);
    fx.git(other, 'commit', '-q', '--allow-empty', '-m', 'from elsewhere');
    fx.git(other, 'push', '-q', 'origin', branch);
    try {
      const { repos } = await service.preflight(id);
      expect(repos.map((r) => [r.name, r.result, r.problems])).toEqual([
        ['web', 'failed', ['1 uncommitted file: commit and push them first']],
        ['infra', 'failed', ['1 commit not pushed: push first']],
        [
          'api',
          'failed',
          [
            `origin/${branch} has 1 commit this worktree doesn't: pull first`,
            // The host's head is the pushed commit, which the worktree doesn't have.
          ],
        ],
      ]);
    } finally {
      fx.git(trees.web, 'checkout', '--', 'web.txt');
      fx.git(trees.infra, 'reset', '-q', '--hard', 'HEAD~1');
      fx.git(trees.api, 'pull', '-q', '--ff-only');
    }
    fs.writeFileSync(
      path.join(state, 'pr-web.json'),
      JSON.stringify({
        state: 'draft',
        url: 'https://example.com/web/pull/1',
        base: 'main',
        mergeable: false,
        checks: 'pending',
        reviews: 'required',
      }),
    );
    const { repos } = await service.preflight(id);
    expect(repos[0]?.problems).toEqual([
      'Its pull request is a draft: mark it ready for review',
      'Checks running: check again when they finish',
      'It needs an approving review',
    ]);
    expect(repos.slice(1).map((r) => r.result)).toEqual(['ready', 'ready']);
  });

  it('merges in the order given, stops at the first failure and skips the rest', async () => {
    fs.writeFileSync(path.join(state, 'fail-api'), '');
    const heads = Object.fromEntries(
      names.map((n) => [n, fx.git(trees[n], 'rev-parse', 'HEAD').trim()]),
    );
    const report = await service.merge(id, {
      order: ['infra', 'api', 'web'],
      methods: { infra: 'rebase' },
      deleteBranch: true,
    });
    expect(merges()).toEqual([`infra rebase ${heads.infra}`, `api rebase ${heads.api}`]);
    expect(report.stopped).toBe(true);
    expect(report.repos).toEqual([
      expect.objectContaining({
        projectId: 'infra',
        outcome: 'merged',
        method: 'rebase',
        commit: 'c-infra',
        commitUrl: 'https://example.com/infra/commit/c',
        prUrl: 'https://example.com/infra/pull/1',
        branchDeleted: true,
      }),
      expect.objectContaining({
        projectId: 'api',
        outcome: 'failed',
        reason: 'The PR merge command failed: Merge conflict on the host',
      }),
      expect.objectContaining({ projectId: 'web', outcome: 'skipped' }),
    ]);
    // The merged one's remote branch is gone; the others keep theirs.
    expect(remoteHas('infra')).toBe(false);
    expect(remoteHas('api')).toBe(true);
    expect(remoteHas('web')).toBe(true);
    expect(service.list()).toEqual([
      expect.objectContaining({ workspaceId: id, running: false, report }),
    ]);

    // Once fixed, the same order goes on: infra was merged already.
    fs.rmSync(path.join(state, 'fail-api'));
    fs.writeFileSync(path.join(state, 'merged-infra'), '');
    const again = await service.merge(id, {
      order: ['infra', 'api', 'web'],
      methods: {},
      deleteBranch: false,
    });
    expect(again.repos.map((r) => [r.projectId, r.outcome, r.branchDeleted])).toEqual([
      ['infra', 'already-merged', null],
      ['api', 'merged', null],
      ['web', 'merged', null],
    ]);
    expect(remoteHas('web')).toBe(true);
    // Pushed again for the tests after this one.
    fx.git(trees.infra, 'push', '-q', 'origin', branch);
  });

  it('counts a merge whose command failed afterwards as merged, with a warning, and goes on', async () => {
    fs.writeFileSync(path.join(state, 'fail-after-infra'), '');
    const report = await service.merge(id, {
      order: ['infra', 'api', 'web'],
      methods: {},
      deleteBranch: false,
    });
    expect(report.stopped).toBe(false);
    expect(report.repos.map((r) => [r.projectId, r.outcome, r.warning])).toEqual([
      [
        'infra',
        'merged',
        'Merged on the host, but the PR merge command failed afterwards: failed to delete local branch infra',
      ],
      ['api', 'merged', null],
      ['web', 'merged', null],
    ]);
    expect(merges().map((m) => m.split(' ')[0])).toEqual(['infra', 'api', 'web']);
  });

  describe('asked for over the bridge (spec §21.10)', () => {
    const ask = (s: MergePrsService, extra: Partial<MergeCliRequest> = {}) =>
      s.cli({
        action: 'merge',
        workspaceId: id,
        order: ['api'],
        methods: {},
        deleteBranch: false,
        byClaude: true,
        ...extra,
      });
    const settled = <T>(p: Promise<T>) => {
      let done = false;
      void p.finally(() => {
        done = true;
      });
      return () => done;
    };

    it('never merges without the click: it waits, and a cancel merges nothing', async () => {
      const asked: string[] = [];
      const s = makeService({ onConfirmRequested: (w) => asked.push(w) });
      const answer = ask(s);
      const isDone = settled(answer);
      await new Promise((r) => setTimeout(r, 300));
      expect(isDone()).toBe(false);
      expect(merges()).toEqual([]);
      expect(asked).toEqual([id]);
      const [pending] = s.pendingConfirmations();
      expect(pending).toMatchObject({
        workspaceId: id,
        order: ['api', 'web', 'infra'],
        deleteBranch: false,
        state: 'pending',
        requestedBy: 'Requested from the command line by Claude in PROJ-9 Ship',
      });
      // A second request while one waits is refused.
      await expect(ask(s)).rejects.toThrow(/already waiting for confirmation/);
      s.cancelConfirmation(id, pending?.id ?? '');
      expect(await answer).toEqual({
        ok: false,
        error: expect.stringMatching(/^Not confirmed in .+ \(cancelled in the app\)$/),
      });
      expect(merges()).toEqual([]);
      expect(s.pendingConfirmations()).toEqual([]);
    });

    it('times out after its limit, merging nothing, and stays as expired until closed', async () => {
      const s = makeService({ confirmTimeoutMs: 100 });
      expect(await ask(s, { byClaude: false })).toEqual({
        ok: false,
        error: expect.stringMatching(/^Not confirmed in .+ \(timed out\)$/),
      });
      expect(merges()).toEqual([]);
      const [expired] = s.pendingConfirmations();
      expect(expired).toMatchObject({
        state: 'expired',
        requestedBy: 'Requested from the command line',
      });
      expect(() =>
        s.confirm(id, expired?.id ?? '', {
          order: ['api', 'web', 'infra'],
          methods: {},
          deleteBranch: false,
        }),
      ).toThrow(/no longer waiting/);
      expect(merges()).toEqual([]);
      s.cancelConfirmation(id, expired?.id ?? '');
      expect(s.pendingConfirmations()).toEqual([]);
    });

    it('merges once confirmed, in the order and with the methods the dialog confirmed', async () => {
      const s = makeService({});
      const answer = ask(s);
      await new Promise((r) => setTimeout(r, 50));
      const [pending] = s.pendingConfirmations();
      expect(() =>
        s.confirm(id, pending?.id ?? '', { order: ['web'], methods: {}, deleteBranch: false }),
      ).toThrow('The order leaves out infra, api');
      s.confirm(id, pending?.id ?? '', {
        order: ['web', 'api', 'infra'],
        methods: { web: 'rebase' },
        deleteBranch: false,
      });
      const result = await answer;
      if (!result.ok) throw new Error(result.error);
      expect(result.report?.repos.map((r) => [r.projectId, r.outcome, r.method])).toEqual([
        ['web', 'merged', 'rebase'],
        ['api', 'merged', 'rebase'],
        ['infra', 'merged', 'merge'],
      ]);
      expect(s.pendingConfirmations()).toEqual([]);
    });
  });

  it('refuses an order that leaves a repository out', async () => {
    await expect(
      service.merge(id, { order: ['web', 'api'], methods: {}, deleteBranch: true }),
    ).rejects.toThrow('The order leaves out infra');
  });

  it('answers the command line in the order asked, with the methods asked', async () => {
    const result = await service.cli({
      action: 'preflight',
      workspaceId: id,
      order: ['API', 'infra'],
      methods: { web: 'squash', infra: 'rebase' },
      deleteBranch: true,
      byClaude: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.preflight?.repos.map((r) => [r.name, r.result, r.method, r.problems])).toEqual([
      ['api', 'ready', 'rebase', []],
      ['infra', 'ready', 'rebase', []],
      ['web', 'failed', 'squash', ["The host doesn't allow squash here (merge, rebase)"]],
    ]);
    expect(
      await service.cli({
        action: 'preflight',
        workspaceId: null,
        order: [],
        methods: {},
        deleteBranch: true,
        byClaude: false,
      }),
    ).toEqual({ ok: false, error: expect.stringMatching(/merge runs in a workspace/) });
    await expect(
      service.cli({
        action: 'preflight',
        workspaceId: id,
        order: ['nope'],
        methods: {},
        deleteBranch: true,
        byClaude: false,
      }),
    ).rejects.toThrow("nope isn't a repository of this workspace (web, infra, api)");
  });
});

const hasJq = spawnSync('jq', ['--version']).status === 0;

/** The GitHub CLI preset (spec §12.6) against a stand-in `gh` that answers from files. */
describe.skipIf(!hasJq)('the GitHub CLI preset', () => {
  let fx: Fixture;
  let bin: string;
  const run = (command: string, env: Record<string, string> = {}) =>
    execFileSync('/bin/sh', ['-c', command], {
      env: {
        ...fx.env,
        PATH: `${bin}:${process.env.PATH}`,
        [envVar('BRANCH')]: 'feat',
        ...env,
      },
      encoding: 'utf8',
    });

  beforeAll(() => {
    fx = createFixture();
    bin = path.join(fx.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${fx.root}/gh-calls"
expr=""; prev=""
for a in "$@"; do [ "$prev" = --jq ] && expr="$a"; prev="$a"; done
case "$1 $2" in
  "pr view") case "$*" in *mergeCommit*) jq -c "$expr" "${fx.root}/merged.json" ;; *)
    [ -f "${fx.root}/pr.json" ] || { echo 'no pull requests found for branch "feat"' >&2; exit 1; }
    cat "${fx.root}/pr.json" ;; esac ;;
  "repo view") echo '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}' ;;
  "pr merge") : ;;
esac
`,
      { mode: 0o755 },
    );
  });
  afterAll(() => fx.cleanup());

  const pr = (fields: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(fx.root, 'pr.json'),
      JSON.stringify({
        state: 'OPEN',
        isDraft: false,
        url: 'https://example.com/o/r/pull/3',
        title: 'PROJ-1: Fix',
        baseRefName: 'main',
        headRefOid: 'abc',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
        ...fields,
      }),
    );

  it('prints nothing without a pull request, and the fields Merge all PRs needs', () => {
    const { statusCommand } = githubPreset();
    expect(run(statusCommand)).toBe('');
    pr({});
    expect(parsePrDetails(run(statusCommand))).toEqual({
      state: 'open',
      url: 'https://example.com/o/r/pull/3',
      base: 'main',
      head: 'abc',
      mergeable: true,
      conflicts: false,
      checks: 'passed',
      reviews: 'approved',
      methods: ['squash', 'rebase'],
    });
  });

  it('reports running and failed checks, reviews, conflicts and a branch behind', () => {
    const { statusCommand } = githubPreset();
    const details = () => parsePrDetails(run(statusCommand));
    pr({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }, { state: 'SUCCESS' }],
    });
    expect(details()).toMatchObject({ mergeable: false, checks: 'pending', reviews: 'required' });
    pr({
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    expect(details()).toMatchObject({ mergeable: false, checks: 'failed' });
    pr({ isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(details()).toMatchObject({ state: 'draft', conflicts: true, mergeable: false });
    pr({ mergeStateStatus: 'BEHIND' });
    expect(details()).toMatchObject({
      mergeable: false,
      blockedReason: 'Its branch is behind main, and the repository requires it to be up to date',
    });
    pr({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' });
    expect(details()).toMatchObject({ mergeable: null });
  });

  it('merges with the method and the checked head, and prints the merge commit', () => {
    fs.writeFileSync(
      path.join(fx.root, 'merged.json'),
      JSON.stringify({ url: 'https://example.com/o/r/pull/3', mergeCommit: { oid: 'def' } }),
    );
    fs.rmSync(path.join(fx.root, 'gh-calls'), { force: true });
    const out = run(githubPreset().mergeCommand, {
      [envVar('MERGE_METHOD')]: 'squash',
      [envVar('PR_HEAD')]: 'abc',
    });
    expect(JSON.parse(out)).toEqual({
      url: 'https://example.com/o/r/pull/3',
      commit: 'def',
      commitUrl: 'https://example.com/o/r/commit/def',
    });
    expect(fs.readFileSync(path.join(fx.root, 'gh-calls'), 'utf8').split('\n')[0]).toBe(
      'pr merge feat --squash --match-head-commit abc',
    );
  });
});
