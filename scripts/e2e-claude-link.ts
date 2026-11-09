/**
 * End-to-end test of Let Claude add others when needed (spec §21.9): on by
 * default in New workspace, Claude is told about the profile's other projects
 * at SessionStart, and the fake claude links them with the command line tool
 * as Claude's Bash tool would. The new repository shows as a chip ("Added by
 * Claude"), as "+1" on the sidebar row and the Board card; the notice is the
 * window's while another view is shown and the workspace header's line while
 * it is shown. A path that isn't a project is refused, and so is any link once
 * the workspace's menu turns it off; Delete workspace covers every repository.
 * Unticked, Claude isn't told and the choice is remembered for the project.
 * Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-claude-link.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { BRAND } from '../src/shared/brand';
import {
  CMD,
  chooseFromNextContextMenu,
  clickButtonText,
  clickLabel,
  hasButton,
  launchApp,
  pressKey,
  type RunningApp,
  reloadPage,
  screenshot,
  sleep,
  submitDialog,
  typeInField,
  typeInTerminal,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

const chips = `document.querySelectorAll('[data-repo-chips] [data-repo-chip]').length`;
const appNotice = `(document.querySelector('[data-app-notice]')?.innerText ?? '')`;
const linkNotice = `(document.querySelector('[data-link-notice]')?.innerText ?? '')`;
const sidebarRow = `document.querySelector('nav button[title^="PROJ-1 Claude links"]')`;
const mayLinkBox = `document.querySelector('dialog[open] [data-claude-may-link] input')`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: shop } = fx.cloneWithRemote('shop', 'main');
    const { clone: cartapi } = fx.cloneWithRemote('cartapi', 'main');
    const cartweb = fx.localRepo('cartweb');
    const cartdocs = fx.localRepo('cartdocs');
    fx.localRepo('stranger');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, keeps what SessionStart
    // added to its context, and runs the command line tool for lines typed
    // into its terminal, as its Bash tool would (CLAUDECODE set): `link <x>`
    // at once, `later <x>` two seconds later in the background.
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
settings=""; prev=""
for arg in "$@"; do [ "$prev" = --settings ] && settings="$arg"; prev="$arg"; done
helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
printf '%s' '{"session_id":"s","transcript_path":"/dev/null"}' | "$helper" hook SessionStart > "$HOME/.claude-context-$n.tmp"
mv "$HOME/.claude-context-$n.tmp" "$HOME/claude-context-$n.txt"
echo "fake claude"
k=0
while IFS= read -r line; do
  k=$((k + 1))
  case "$line" in
    link\\ *) { CLAUDECODE=1 ${BRAND.cliCommand} $line; echo "exit $?"; } > "$HOME/claude-link-$k.txt" 2>&1 ;;
    later\\ *) ( sleep 2; { CLAUDECODE=1 ${BRAND.cliCommand} link "\${line#later }"; echo "exit $?"; } > "$HOME/claude-link-$k.txt" 2>&1 ) & ;;
  esac
done
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
    const project = (id: string, repoPath: string, more: Record<string, unknown> = {}) => ({
      id,
      profileId: 'work',
      name: id,
      repoPath,
      remote: null,
      ...more,
    });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
        })),
        projects: [
          project('shop', shop, { remote: 'origin' }),
          project('cartapi', cartapi, { remote: 'origin', baseBranch: 'main' }),
          project('cartweb', cartweb),
          project('cartdocs', cartdocs),
        ],
      }),
    );
    const linkOutput = (k: number) =>
      waitForFile(path.join(fx.root, `claude-link-${k}.txt`), { until: /^exit \d+$/m });
    let typed = 0;
    const claudeTypes = async (line: string) => {
      typed += 1;
      await typeInTerminal(page, line);
      return typed;
    };

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page, main: mainProcess } = app;
    await page.waitFor(
      `!!document.querySelector('[aria-label="New workspace in shop"]')`,
      'the app',
    );
    // The Board grouped by project shows a card's linked repositories as "+n" (spec §6.7).
    await page.eval(`localStorage.setItem('home-board-group:work', 'project')`);
    await reloadPage(page);
    await page.waitFor(
      `!!document.querySelector('[aria-label="New workspace in shop"]')`,
      'reloaded',
    );

    // 1. New workspace: the choice under Also in, on by default, nothing ticked.
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!${mayLinkBox}`, 'Let Claude add others when needed');
    assert.equal(await page.eval(`${mayLinkBox}.checked`), true, 'on by default');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-claude-may-link]').innerText`),
      /Let Claude add others when needed/,
    );
    await typeInField(page, '#ws-task', 'PROJ-1 Claude links', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace', 30_000);
    const shopTree = await waitForFile(path.join(fx.root, 'claude-run-0.txt'));
    const treeOf = (id: string) =>
      path.join(path.dirname(path.dirname(shopTree)), id, 'PROJ-1-claude-links');

    // 2. Told at SessionStart: the other projects with their paths and bases.
    const context = JSON.parse(await waitForFile(path.join(fx.root, 'claude-context-0.txt')))
      .hookSpecificOutput.additionalContext as string;
    assert.match(context, new RegExp(`- cartapi: ${cartapi} \\(base main\\)`));
    assert.match(context, new RegExp(`- cartweb: ${cartweb} \\(base main\\)`));
    assert.match(context, /This folder's repository stays your main one and your working folder/);
    assert.match(context, new RegExp(`${BRAND.cliCommand} link <name>`));
    assert.doesNotMatch(context, /- shop:/);

    // 3. Linked while another view is shown: the window's notice, "+1" on
    // the sidebar row and the Board card.
    await page.waitFor(`!!document.querySelector('[data-terminal][data-connected]')`, 'Claude');
    const later = await claudeTypes('later cartapi');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board');
    assert.match(
      await linkOutput(later),
      new RegExp(`^Linked cartapi: ${treeOf('cartapi')}$`, 'm'),
    );
    await page.waitFor(
      `${appNotice}.includes('Claude linked cartapi to PROJ-1 Claude links')`,
      "the window's notice",
    );
    assert.equal(
      fx.git(treeOf('cartapi'), 'branch', '--show-current').trim(),
      'PROJ-1-claude-links',
    );
    await page.waitFor(
      `document.querySelector('[data-board-card] [data-linked-chip]')?.textContent === '+1'`,
      "the Board card's +1",
    );
    assert.equal(
      await page.eval(`${sidebarRow}.querySelector('[data-linked-chip]')?.textContent`),
      '+1',
    );
    await screenshot(page, screenshotDir, 'cl1-board-linked.png');
    await page.eval(
      `document.querySelector('[data-app-notice] button[aria-label=Dismiss]').click()`,
    );

    // 4. Back in the workspace: its chip, "Added by Claude"; no header line for it.
    await page.eval(`${sidebarRow}.click()`);
    await page.waitFor(`${chips} === 2`, 'two chips');
    assert.equal(await page.eval(linkNotice), '');
    await page.eval(`document.querySelector('[data-repo-chip="cartapi"]').focus()`);
    await page.waitFor(
      `document.querySelector('[data-repo-tooltip="cartapi"]')?.innerText.includes('Added by Claude')`,
      'the tooltip',
    );
    await page.eval(`document.activeElement.blur()`);

    // 5. Linked while the workspace is shown: the header's line, not the window's notice.
    const now = await claudeTypes('link cartweb');
    assert.match(await linkOutput(now), /^exit 0$/m);
    await page.waitFor(`${chips} === 3`, 'three chips');
    await page.waitFor(
      `${linkNotice}.includes('Claude added cartweb') && ${linkNotice}.includes(${JSON.stringify(treeOf('cartweb'))})`,
      "the header's line",
    );
    assert.equal(await page.eval(appNotice), '', 'no window notice for the shown workspace');
    await screenshot(page, screenshotDir, 'cl2-header-line.png');
    await page.eval(
      `document.querySelector('[data-link-notice] button[aria-label=Dismiss]').click()`,
    );
    await page.waitFor(`!document.querySelector('[data-link-notice]')`, 'the line dismissed');

    // 6. A path that isn't a project of the profile is refused to Claude.
    const stranger = await claudeTypes('link ~/stranger');
    const refused = await linkOutput(stranger);
    assert.match(refused, /isn't a project of this profile/);
    assert.match(refused, /^exit 1$/m);
    assert.equal(
      JSON.parse(fs.readFileSync(configFile, 'utf8')).projects.some(
        (p: { name: string }) => p.name === 'stranger',
      ),
      false,
    );

    // 7. Turned off in the workspace's menu: Claude's link is refused.
    await chooseFromNextContextMenu(mainProcess, 'Let Claude Add Repositories');
    await clickLabel(page, 'Workspace menu');
    await sleep(300);
    const off = await claudeTypes('link cartdocs');
    const offOutput = await linkOutput(off);
    assert.match(offOutput, /Claude may not add repositories to this workspace/);
    assert.match(offOutput, /^exit 1$/m);
    assert.equal(await page.eval(chips), 3);

    // 8. Delete workspace: a card per repository, Claude's included; every worktree goes.
    // cartapi's worktree was switched to another branch with a commit (spec §14.2).
    fx.git(treeOf('cartapi'), 'switch', '-q', '-c', 'side-work');
    fs.writeFileSync(path.join(treeOf('cartapi'), 'side.txt'), 'x\n');
    fx.git(treeOf('cartapi'), 'add', 'side.txt');
    fx.git(treeOf('cartapi'), 'commit', '-q', '-m', 'Side work');
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(
      `document.querySelectorAll('dialog[open] [data-repo-card]').length === 3`,
      'a card per repository',
      30_000,
    );
    await page.waitFor(
      `/cartapi is on side-work, not .*\\n1 commit on side-work isn't on origin; that branch is kept/.test(document.querySelector('dialog[open] [data-repo-card=cartapi] [data-checked-out]')?.innerText ?? '')`,
      "cartapi's other branch",
    );
    assert.equal(await page.eval<boolean>(hasButton('Delete anyway')), true);
    assert.equal(
      await page.eval(`!!document.querySelector('dialog[open] [data-repo-card=cartapi]')`),
      true,
    );
    const deleteLabel = (await page.eval<boolean>(hasButton('Delete anyway')))
      ? 'Delete anyway'
      : 'Delete';
    await clickButtonText(page, deleteLabel, 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'deleted', 30_000);
    for (const id of ['shop', 'cartapi', 'cartweb']) {
      assert.equal(fs.existsSync(treeOf(id)), false, `${id}'s worktree is gone`);
    }

    // 9. Unticked: Claude isn't told; the choice is remembered for shop.
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!${mayLinkBox}`, 'New workspace');
    await page.eval(`${mayLinkBox}.click()`);
    await typeInField(page, '#ws-task', 'PROJ-2 On my own', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the second workspace', 30_000);
    const quiet = JSON.parse(await waitForFile(path.join(fx.root, 'claude-context-1.txt')))
      .hookSpecificOutput.additionalContext as string;
    assert.match(quiet, /is the git worktree of the task/);
    assert.doesNotMatch(quiet, /- cartapi:/);
    assert.doesNotMatch(quiet, /link <name>/);
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!${mayLinkBox}`, 'New workspace again');
    assert.equal(await page.eval(`${mayLinkBox}.checked`), false, 'remembered for shop');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'closed');

    console.log(`e2e-claude-link: ok (${devMode ? 'dev server' : 'production build'})`);
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
