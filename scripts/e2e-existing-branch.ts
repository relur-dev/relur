/**
 * End-to-end test of a workspace from an existing branch (spec §7.6): a
 * branch someone else pushed to a local bare remote shows in New workspace's
 * Existing branch list with its author, a branch in the main checkout is
 * refused with Open project, and a pasted branch URL picks the branch. The
 * workspace's worktree tracks the remote branch; a commit and Push update it.
 * A conflicting change on the base shows in the Changes panel and the header
 * (spec §6.4, §6.2), and Ask Claude to merge reaches Claude. Delete names the
 * other author and keeps the remote branch (spec §14.2). Runs with a
 * throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-existing-branch.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import {
  clickButtonText,
  clickLabel,
  dialogText,
  hasButton,
  launchApp,
  pressShortcut,
  type RunningApp,
  screenshot,
  sleep,
  typeInField,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

const BRANCH = 'feature/ABC-7-checkout';
const row = (name: string) =>
  `document.querySelector('dialog[open] [data-branch-row=${JSON.stringify(name)}]')`;
const panelText = `(document.querySelector('[data-changes-panel]')?.innerText ?? '')`;
const submit = `document.querySelector('dialog[open] button[type=submit]')`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { origin, clone: shop } = fx.cloneWithRemote('shop', 'main');
    // Someone else's branch, pushed before the app sees it: Ana changes the
    // README, so a later README change on main conflicts with it.
    const ana = path.join(fx.root, 'ana');
    fx.git(fx.root, 'clone', '-q', origin, ana);
    const asAna = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, {
        cwd: ana,
        env: {
          ...fx.env,
          GIT_AUTHOR_NAME: 'Ana',
          GIT_AUTHOR_EMAIL: 'ana@example.com',
          GIT_COMMITTER_NAME: 'Ana',
          GIT_COMMITTER_EMAIL: 'ana@example.com',
        },
        encoding: 'utf8',
      });
    asAna('checkout', '-q', '-b', BRANCH);
    fs.writeFileSync(path.join(ana, 'README'), 'checkout, by Ana\n');
    asAna('commit', '-q', '-am', 'Checkout page');
    asAna('push', '-q', 'origin', BRANCH);
    // A branch of your own, checked out in the main checkout.
    fx.git(shop, 'checkout', '-q', '-b', 'mine');

    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, notes where it runs and
    // keeps every line typed or pasted into its terminal.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
n=$(ls "$HOME" | grep -c '^claude-run-')
pwd > "$HOME/claude-run-$n.txt"
echo "fake claude"
while IFS= read -r line; do printf '%s\\n' "$line" >> "$HOME/claude-input-$n.txt"; done
exec sleep 600
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fx.root, '.claude.json'), '{}');
    fs.mkdirSync(path.join(fx.root, '.claude-personal'));
    fs.writeFileSync(path.join(fx.root, '.claude-personal', '.claude.json'), '{}');
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
        })),
        projects: [
          {
            id: 'shop',
            profileId: 'work',
            name: 'shop',
            repoPath: shop,
            remote: 'origin',
            baseBranch: 'main',
          },
        ],
      }),
    );

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page } = app;
    await page.waitFor(
      `!!document.querySelector('[aria-label="New workspace in shop"]')`,
      'the app',
    );

    // 1. Existing branch: Ana's branch after the fetch, with its author; main is the base.
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-mode=existing]')`, 'modes');
    assert.equal(
      await page.eval(`document.querySelector('[data-mode=new]').getAttribute('aria-pressed')`),
      'true',
      'opens on New branch',
    );
    await page.eval(`document.querySelector('[data-mode=existing]').click()`);
    await page.waitFor(`!!${row(BRANCH)}`, "Ana's branch in the list", 30_000);
    assert.match(await page.eval<string>(`${row(BRANCH)}.innerText`), /origin[\s\S]*Ana/);
    assert.match(await page.eval<string>(`${row('main')}.innerText`), /base/);
    assert.match(await page.eval<string>(`${row('mine')}.innerText`), /main checkout/);
    await screenshot(page, screenshotDir, 'eb1-list.png');

    // 2. The branch in the main checkout: refused, with Open project.
    await page.eval(`${row('mine')}.click()`);
    await page.waitFor(
      `${dialogText}.includes('mine is checked out in the main checkout of shop')`,
      'the main checkout refusal',
    );
    assert.equal(await page.eval(hasButton('Open project')), true);
    assert.equal(await page.eval(`${submit}.disabled`), true, 'Create is disabled');

    // 3. A pasted branch URL picks the branch; the task comes from its name.
    await typeInField(
      page,
      '#ws-existing-search',
      `https://github.com/acme/shop/tree/${BRANCH}`,
      false,
    );
    await page.waitFor(
      `(document.querySelector('[data-url-result]')?.innerText ?? '').includes('Branch ${BRANCH} on origin')`,
      'the URL resolved',
      30_000,
    );
    await page.waitFor(
      `document.querySelector('#ws-task').value === 'ABC-7 checkout'`,
      'the task from the branch',
    );
    assert.equal(
      await page.eval(`!!document.querySelector('#ws-branch')`),
      false,
      'no Branch name',
    );
    await page.waitFor(`!${submit}.disabled`, 'Create enabled');
    await page.eval(`${submit}.click()`);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace', 30_000);

    // 4. The worktree is on Ana's branch, tracking it: no new branch.
    const tree = (await waitForFile(path.join(fx.root, 'claude-run-0.txt'))).trim();
    assert.equal(fx.git(tree, 'branch', '--show-current').trim(), BRANCH);
    assert.equal(fx.git(tree, 'rev-parse', 'HEAD'), fx.git(ana, 'rev-parse', 'HEAD'));
    assert.equal(fx.git(shop, 'config', `branch.${BRANCH}.remote`).trim(), 'origin');
    assert.equal(fx.git(shop, 'config', `branch.${BRANCH}.merge`).trim(), `refs/heads/${BRANCH}`);

    // 5. A commit of yours, then main moves on with a conflicting README.
    await pressShortcut(page, 'changes');
    await page.waitFor(`!!document.querySelector('[data-finish]')`, 'the Changes panel');
    fs.writeFileSync(path.join(tree, 'cart.txt'), 'mine\n');
    await page.waitFor(hasButton('Commit 1 file'), 'Commit 1 file', 15_000);
    await clickButtonText(page, 'Commit 1 file');
    await page.waitFor(hasButton('Push 1 commit to origin'), 'Push', 15_000);
    asAna('checkout', '-q', 'main');
    fs.writeFileSync(path.join(ana, 'README'), 'changed on main\n');
    asAna('commit', '-q', '-am', 'README on main');
    asAna('push', '-q', 'origin', 'main');
    fx.git(shop, 'fetch', '-q', 'origin', 'main');
    await page.waitFor(
      `(document.querySelector('[data-behind]')?.innerText ?? '') === '↓1 behind origin/main'`,
      'behind origin/main',
      15_000,
    );
    await page.waitFor(
      `(document.querySelector('[data-conflicts]')?.innerText ?? '').includes('conflicts in 1 file')`,
      'the conflict',
    );

    // 6. Push updates the remote branch (the pull request's).
    await clickButtonText(page, 'Push 1 commit to origin');
    await page.waitFor(
      `!(${hasButton('Push 1 commit to origin')}) && !(${hasButton('Pushing…')})`,
      'pushed',
      20_000,
    );
    const pushed = fx.git(tree, 'rev-parse', 'HEAD');
    assert.equal(fx.git(origin, 'rev-parse', BRANCH), pushed);
    // The push refreshes the panel's queries: the header shows the conflict now.
    await page.waitFor(
      `(document.querySelector('[data-conflict-mark]')?.innerText ?? '') === 'Conflicts with main'`,
      "the header's conflict mark",
      40_000,
    );
    await screenshot(page, screenshotDir, 'eb2-conflicts.png');

    // 7. Ask Claude to merge main: the prompt reaches Claude.
    await page.eval(`document.querySelector('[data-ask-merge=base]').click()`);
    const asked = await waitForFile(path.join(fx.root, 'claude-input-0.txt'), {
      until: /Don't rebase and don't force-push/,
    });
    assert.match(
      asked,
      new RegExp(
        `Merge origin/main into ${BRANCH}: run git fetch origin main, then git merge origin/main\\.`,
      ),
    );
    await page.waitFor(`${panelText}.includes('Sent to Claude: it merges main')`, 'sent');

    // 8. Delete names Ana, deletes the local copy, keeps the remote branch.
    await clickLabel(page, 'Delete workspace');
    await page.waitFor(
      `(document.querySelector('dialog[open] [data-others-branch]')?.innerText ?? '').includes('${BRANCH} tracks origin/${BRANCH}, with commits by Ana')`,
      'the warning about Ana',
      20_000,
    );
    assert.equal(
      await page.eval(`document.querySelector('dialog[open] input[type=checkbox]').checked`),
      true,
      'Also delete the local branch, ticked',
    );
    await screenshot(page, screenshotDir, 'eb3-delete.png');
    // Claude still runs, so it reads Delete anyway.
    await clickButtonText(page, 'Delete anyway', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'deleted', 30_000);
    await sleep(300);
    assert.equal(fs.existsSync(tree), false, 'the worktree is gone');
    assert.equal(fx.git(shop, 'branch', '--list', BRANCH).trim(), '', 'the local branch is gone');
    assert.equal(fx.git(origin, 'rev-parse', BRANCH), pushed, 'the remote branch is kept');

    console.log(`e2e-existing-branch: ok (${devMode ? 'dev server' : 'production build'})`);
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
