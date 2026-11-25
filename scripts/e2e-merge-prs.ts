/**
 * End-to-end test of Merge all PRs (spec §21.10): a workspace in web linked
 * to infra and api, each on a local bare remote, with a stand-in PR
 * provider (create, status and merge commands that answer from files). The
 * header's Merge all PRs is disabled until every repository has a pull
 * request (Create 3 PRs opens them); the dialog checks all three, shows the
 * primary first, takes a new order (infra, api, web) and says merges can't
 * be undone. The host refuses api's merge: infra is merged (its remote
 * branch deleted), api fails with the host's reason, web is skipped and
 * never merged, and the report says so.
 * Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-merge-prs.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { BRAND, envVar } from '../src/shared/brand';
import {
  appDir,
  CMD,
  chooseFromNextContextMenu,
  clickLabel,
  launchApp,
  MOD,
  pressKey,
  type RunningApp,
  screenshot,
  sleep,
  submitDialog,
  typeInField,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

const NAMES = ['web', 'infra', 'api'] as const;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const repos = Object.fromEntries(
      NAMES.map((name) => [name, fx.cloneWithRemote(name, 'main')]),
    ) as Record<(typeof NAMES)[number], { origin: string; clone: string }>;
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: runs SessionStart and notes its worktree.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
settings=""; prev=""
for arg in "$@"; do [ "$prev" = --settings ] && settings="$arg"; prev="$arg"; done
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
[ -n "$helper" ] && printf '{"session_id":"fake-%s"}' "$$" | "$helper" hook SessionStart > /dev/null
echo "$PWD" > "$HOME/tree.txt"
echo "$${envVar('WORKSPACE_ID')}" > "$HOME/workspace.txt"
echo "fake claude"
exec sleep 600
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fx.root, '.claude.json'), '{}');
    fs.mkdirSync(path.join(fx.root, '.claude-personal'));
    fs.writeFileSync(path.join(fx.root, '.claude-personal', '.claude.json'), '{}');
    // The stand-in provider. A worktree is <worktrees>/<project>/<branch>.
    const repo = 'n=$(basename "$(dirname "$PWD")")';
    const pr = {
      createCommand: `${repo}; touch "$HOME/pr-$n"; echo "opened $n"`,
      statusCommand: [
        repo,
        '[ -f "$HOME/pr-$n" ] || exit 0',
        `if [ -f "$HOME/merged-$n" ]; then printf '{"state":"merged","url":"https://example.com/%s/pull/1"}' "$n"; exit 0; fi`,
        `h=$(git rev-parse "refs/remotes/origin/$${envVar('BRANCH')}")`,
        `printf '{"state":"open","url":"https://example.com/%s/pull/1","base":"main","head":"%s","mergeable":true,"checks":"passed","reviews":"approved","methods":["squash","merge"]}' "$n" "$h"`,
      ].join('\n'),
      mergeCommand: [
        repo,
        `echo "$n $${envVar('MERGE_METHOD')}" >> "$HOME/merges"`,
        `if [ "$n" = api ] && [ -f "$HOME/fail-api" ]; then echo 'Required status check "deploy" is failing on the host' >&2; exit 1; fi`,
        'touch "$HOME/merged-$n"',
        `printf '{"commit":"c0ffee-%s","commitUrl":"https://example.com/%s/commit/c0ffee"}\\n' "$n" "$n"`,
      ].join('\n'),
    };
    const configFile = path.join(
      appConfigDir({ platform: process.platform, env: {}, homeDir: fx.root }),
      'config.json',
    );
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
          pr,
        })),
        projects: NAMES.map((name) => ({
          id: name,
          profileId: 'work',
          name,
          repoPath: repos[name].clone,
          remote: 'origin',
          baseBranch: 'main',
        })),
      }),
    );
    const file = (name: string) => path.join(fx.root, name);
    const read = (name: string) =>
      fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';

    // The host refuses api's merge until this goes.
    fs.writeFileSync(file('fail-api'), '');
    app = await launchApp({ env: withDisplayEnv({ ...fx.env }), dev: devMode, electronArgs });
    const page = app.page;
    await page.waitFor(
      `document.querySelector('[data-board-empty]')?.dataset.boardEmpty === 'no-workspaces'`,
      'No workspaces yet',
    );

    // A workspace in web, also in infra and api.
    await clickLabel(page, 'New workspace in web');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-also-in]')`, 'Also in');
    for (const name of ['infra', 'api']) {
      await page.eval(
        `[...document.querySelectorAll('[data-also-in] label')].find((l) => l.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`,
      );
    }
    await typeInField(page, '#ws-task', 'PROJ-5 Ship it', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace', 30_000);
    const webTree = (await waitForFile(file('tree.txt'))).trim();
    const branch = path.basename(webTree);
    const trees = Object.fromEntries(
      NAMES.map((n) => [n, path.join(path.dirname(path.dirname(webTree)), n, branch)]),
    ) as Record<(typeof NAMES)[number], string>;
    await page.waitFor(`document.querySelectorAll('[data-repo-chip]').length === 3`, 'three chips');

    // Without pull requests the header's button is disabled, and says why.
    const headerButton = `document.querySelector('[data-merge-prs-button]')`;
    await page.waitFor(`!!${headerButton}`, 'Merge all PRs in the header');
    assert.equal(await page.eval(`${headerButton}.disabled`), true);
    assert.match(await page.eval<string>(`${headerButton}.title`), /^No pull request known in /);

    // A commit in each, then Create 3 PRs pushes them and opens the PRs.
    for (const name of NAMES) {
      fs.writeFileSync(path.join(trees[name], `${name}.txt`), `${name}\n`);
      fx.git(trees[name], 'add', '.');
      fx.git(trees[name], 'commit', '-qm', `PROJ-5: ${name}`);
    }
    await pressKey(page, 'KeyD', CMD | MOD.shift);
    const createAll = `document.querySelector('[data-create-all-prs]')`;
    await page.waitFor(
      `${createAll}?.textContent === 'Create 3 PRs' && !${createAll}.disabled`,
      'Create 3 PRs',
      20_000,
    );
    await page.eval(`${createAll}.click()`);
    await page.waitFor(
      `${headerButton} && !${headerButton}.disabled`,
      'Merge all PRs enabled',
      30_000,
    );
    await pressKey(page, 'KeyD', CMD | MOD.shift);

    // The dialog checks every repository: the primary first, then in link order.
    await page.eval(`${headerButton}.click()`);
    const rows = `[...document.querySelectorAll('dialog[open] [data-merge-row]')]`;
    const rowState = `${rows}.map((r) => r.dataset.mergeRow + ':' + r.dataset.mergeResult).join(' ')`;
    await page.waitFor(
      `${rows}.length === 3 && ${rows}.every((r) => r.dataset.mergeResult === 'ready')`,
      'every repository ready',
      30_000,
    );
    const defaultOrder = await page.eval<string[]>(`${rows}.map((r) => r.dataset.mergeRow)`);
    assert.equal(defaultOrder[0], 'web', `the primary first: ${defaultOrder}`);
    assert.deepEqual([...defaultOrder].sort(), ['api', 'infra', 'web']);
    const dialogText = await page.eval<string>(`document.querySelector('dialog[open]').innerText`);
    assert.match(dialogText, /web\s+primary/);
    assert.match(dialogText, new RegExp(`${branch} → main`));
    assert.match(dialogText, /nothing is undone/);
    assert.match(
      await page.eval<string>(
        `document.querySelector('dialog[open] [data-merge-submit]').textContent`,
      ),
      /^Merge 3 PRs/,
    );

    // Reorder to infra, api, web: infra before the services.
    const target = ['infra', 'api', 'web'];
    for (let i = 0; i < target.length; i++) {
      for (;;) {
        const order = await page.eval<string[]>(`${rows}.map((r) => r.dataset.mergeRow)`);
        const at = order.indexOf(target[i] as string);
        if (at === i) break;
        await page.eval(
          `document.querySelector('dialog[open] [aria-label="Move ${target[i]} up"]').click()`,
        );
        await sleep(50);
      }
    }
    assert.deepEqual(await page.eval<string[]>(`${rows}.map((r) => r.dataset.mergeRow)`), target);
    await screenshot(page, screenshotDir, '01-merge-all-prs.png');

    // Merge: infra merges, the host refuses api, web is skipped.
    await page.eval(`document.querySelector('dialog[open] [data-merge-submit]').click()`);
    const summary = `document.querySelector('dialog[open] [data-merge-summary]')?.innerText ?? ''`;
    await page.waitFor(`${summary} !== ''`, 'the report', 60_000);
    assert.equal(
      await page.eval(rowState),
      'infra:merged api:failed web:skipped',
      'merged, failed, skipped in the chosen order',
    );
    assert.deepEqual(read('merges').trim().split('\n'), ['infra squash', 'api squash']);
    assert.ok(!fs.existsSync(file('merged-web')), 'web was never merged');
    assert.match(
      await page.eval<string>(summary),
      /^Merge stopped at api: The PR merge command failed: Required status check "deploy" is failing on the host · 1 merged · 1 skipped\. The pull requests merged before it stay merged\.$/,
    );
    const report = await page.eval<string>(`document.querySelector('dialog[open] ol').innerText`);
    assert.match(report, /infra[\s\S]*✓ Merged · Squash · c0ffee-in/);
    assert.match(report, /api[\s\S]*✕ The PR merge command failed: Required status check/);
    assert.match(report, /web[\s\S]*– Skipped/);
    // infra's remote branch was deleted after its merge; the others keep theirs.
    const remoteBranch = (name: (typeof NAMES)[number]) =>
      fx.git(repos[name].origin, 'branch', '--list', branch).trim();
    assert.equal(remoteBranch('infra'), '');
    assert.notEqual(remoteBranch('api'), '');
    assert.notEqual(remoteBranch('web'), '');
    // Stopped: no Delete workspace… offered, only Close.
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.startsWith('Delete workspace'))`,
      ),
      false,
    );
    await screenshot(page, screenshotDir, '02-merge-stopped.png');
    await page.eval(
      `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.startsWith('Close')).click()`,
    );
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog closed');

    // From the command line, as Claude runs it (spec §21.10): --yes skips the
    // terminal's question, but nothing merges without a click in the app.
    const workspaceId = (await waitForFile(file('workspace.txt'))).trim();
    const helper = path.join(appDir, 'out', 'helper', BRAND.helperCommand);
    const cli = (...cliArgs: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(helper, ['merge', ...cliArgs], {
          env: { ...fx.env, [envVar('WORKSPACE_ID')]: workspaceId, CLAUDECODE: '1' },
          cwd: webTree,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += d;
        });
        child.stderr.on('data', (d) => {
          err += d;
        });
        child.on('close', (code) => resolve({ code, out, err }));
      });
    const requestedBy = `document.querySelector('dialog[open] [data-merge-requested-by]')?.textContent ?? ''`;
    const mergedBefore = read('merges');

    // Cancel: the dialog opens by itself, says who asked; a second request
    // while it waits is refused; Cancel tells the command line, merging nothing.
    const cancelled = cli('--yes');
    await page.waitFor(`${requestedBy} !== ''`, 'the confirmation dialog', 60_000);
    assert.match(
      await page.eval<string>(requestedBy),
      /^Requested from the command line by Claude in .*Ship it\. Nothing merges until you press Merge here\.$/,
    );
    await page.waitFor(
      `${rows}.length === 3 && ${rows}.every((r) => r.dataset.mergeResult !== undefined)`,
      'the request checked',
      30_000,
    );
    const second = await cli('--yes');
    assert.equal(second.code, 1);
    assert.match(second.err, /already waiting for confirmation in .+ for this workspace/);
    assert.equal(read('merges'), mergedBefore, 'nothing merged while waiting');
    await page.eval(`document.querySelector('dialog[open] [data-merge-cancel]').click()`);
    const cancelResult = await cancelled;
    assert.equal(cancelResult.code, 1, cancelResult.out);
    assert.match(cancelResult.out, /Waiting for you to confirm in .+ \(up to 10 minutes\)…/);
    assert.equal(
      cancelResult.err.trim(),
      `Not confirmed in ${BRAND.displayName} (cancelled in the app)`,
    );
    assert.equal(read('merges'), mergedBefore, 'a cancelled request merges nothing');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog closed on Cancel');

    // Confirm: the order asked for (api, web, then infra, merged already),
    // merged once Merge is pressed; the command line prints the report.
    fs.rmSync(file('fail-api'));
    const confirmed = cli('--yes', '--order', 'api,web');
    await page.waitFor(`${requestedBy} !== ''`, 'the confirmation dialog again', 60_000);
    await page.waitFor(
      `${rowState} === 'api:ready web:ready infra:merged'`,
      'the asked order, checked',
      30_000,
    );
    await screenshot(page, screenshotDir, '03-confirm-request.png');
    assert.equal(read('merges'), mergedBefore, 'nothing merged before the click');
    await page.eval(`document.querySelector('dialog[open] [data-merge-submit]').click()`);
    const confirmResult = await confirmed;
    assert.equal(confirmResult.code, 0, confirmResult.err);
    assert.match(
      confirmResult.out,
      /✓ api: merged \(https:\/\/example\.com\/api\/commit\/c0ffee\)/,
    );
    assert.match(confirmResult.out, /✓ infra: merged already/);
    assert.match(confirmResult.out, /Merged 2 pull requests\n/);
    assert.deepEqual(read('merges').trim().split('\n').slice(2), ['api squash', 'web squash']);
    await page.waitFor(`${summary} === 'Merged 2 pull requests'`, 'the report in the app', 30_000);
    assert.equal(await page.eval(rowState), 'api:merged web:merged infra:already-merged');
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.startsWith('Delete workspace'))`,
      ),
      true,
      'Delete workspace… offered once everything merged',
    );
    // The header's ▾ › Merge into bases (local) (spec §6.2): Merge into the
    // base (§14.4) for every repository, as the Changes panel's strip does.
    // The PRs merged on the stand-in host only, so each local main is behind.
    await page.eval(
      `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.startsWith('Close')).click()`,
    );
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the report closed');
    for (const name of NAMES) {
      assert.notEqual(
        fx.git(repos[name].clone, 'rev-parse', 'main').trim(),
        fx.git(trees[name], 'rev-parse', 'HEAD').trim(),
      );
    }
    await chooseFromNextContextMenu(app.main, 'Merge into bases (local)');
    await page.eval(`document.querySelector('[data-header-merge-menu]').click()`);
    for (const name of NAMES) {
      const deadline = Date.now() + 30_000;
      while (
        fx.git(repos[name].clone, 'rev-parse', 'main').trim() !==
        fx.git(trees[name], 'rev-parse', 'HEAD').trim()
      ) {
        if (Date.now() > deadline) throw new Error(`${name}'s local main wasn't fast-forwarded`);
        await sleep(200);
      }
      assert.equal(fx.git(repos[name].clone, 'branch', '--show-current').trim(), 'main');
    }
    assert.deepEqual(await app.main.eval<string[]>('globalThis.__lastMenu'), [
      'Merge into bases (local)',
    ]);
    // Never pushed: origin's main is where it was.
    for (const name of NAMES) {
      assert.notEqual(
        fx.git(repos[name].origin, 'rev-parse', 'main').trim(),
        fx.git(trees[name], 'rev-parse', 'HEAD').trim(),
      );
    }
    console.log('e2e-merge-prs: ok');
  } catch (error) {
    const shown = await app?.page.eval<string>(`document.body.innerText`).catch(() => '');
    console.error(`The window showed:\n${shown?.slice(0, 2000)}`);
    if (app) await screenshot(app.page, screenshotDir, 'failure.png').catch(() => {});
    throw error;
  } finally {
    await app?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
