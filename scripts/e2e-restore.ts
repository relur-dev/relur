/**
 * End-to-end test of reopening where you were (spec §5): a workspace's shell
 * tab with its Changes panel open, in the second profile, is shown again after
 * a restart (the same profile, workspace and tab, a new shell in it); once the
 * workspace is deleted, a restart shows its project. Runs with a throwaway
 * HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-restore.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import {
  chooseFromNextContextMenu,
  clickLabel,
  dialogText,
  launchApp,
  pressShortcut,
  type RunningApp,
  screenshot,
  sleep,
  submitDialog,
  typeInField,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

/** The selected profile tab's id, as an expression. */
const shownProfile = `(document.querySelector('[data-profile-tab][aria-selected=true]')?.dataset.profileTab ?? null)`;
/** The main area's title, as an expression. */
const title = `(document.querySelector('main h1')?.textContent ?? null)`;
/** The selected terminal tab's title, as an expression. */
const shownTab = `([...document.querySelectorAll('main [role=tab][aria-selected=true]')].map((t) => t.title).join('|'))`;
const changesOpen = `!!document.querySelector('[data-changes-panel]')`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: web } = fx.cloneWithRemote('web', 'main');
    const { clone: api } = fx.cloneWithRemote('api', 'main');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, runs SessionStart, then waits.
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
helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
printf '%s' '{"session_id":"s","transcript_path":"/dev/null"}' | "$helper" hook SessionStart > /dev/null
echo "fake claude"
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
          { id: 'web', profileId: 'work', name: 'web', repoPath: web, remote: 'origin' },
          { id: 'api', profileId: 'personal', name: 'api', repoPath: api, remote: 'origin' },
        ],
      }),
    );
    const launch = () => launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });

    // 1. A first start opens on the first profile.
    app = await launch();
    let page = app.page;
    await page.waitFor(`${shownProfile} === 'work'`, 'Work, the first profile');

    // 2. In Personal, a workspace's shell tab with the Changes panel open.
    await clickLabel(page, 'Select Personal');
    await page.waitFor(`${shownProfile} === 'personal'`, 'Personal');
    await clickLabel(page, 'New workspace in api');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    await typeInField(page, '#ws-task', 'AAA-1 Alpha', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace created', 30_000);
    await page.waitFor(`${title} === 'Alpha'`, 'the workspace');
    await page.waitFor(`${shownTab}.includes('claude')`, "the workspace's Claude tab");
    await clickLabel(page, 'New shell');
    await page.waitFor(`/shell/.test(${shownTab})`, 'the shell tab');
    await pressShortcut(page, 'changes');
    await page.waitFor(changesOpen, 'the Changes panel');
    // Saved soon after it shows (spec §5); the quit doesn't wait for it.
    await sleep(500);

    // 3. After a restart: the same profile, workspace, tab and panel.
    await app.stop();
    app = await launch();
    page = app.page;
    await page.waitFor(
      `${shownProfile} === 'personal' && ${title} === 'Alpha'`,
      'Personal with the workspace',
      20_000,
    );
    await page.waitFor(`/shell/.test(${shownTab})`, 'the shell tab again', 20_000);
    await page.waitFor(changesOpen, 'the Changes panel again');
    // The shell is a new one, running in the workspace.
    await page.waitFor(`!!document.querySelector('main [data-terminal]')`, 'its terminal');
    await screenshot(page, screenshotDir, 'r1-restored-shell.png');

    // 4. Delete the workspace; after a restart its project is shown.
    await chooseFromNextContextMenu(app.main, 'Delete workspace…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(`${dialogText}.includes('Delete')`, 'Delete workspace', 30_000);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the delete', 30_000);
    await page.waitFor(`${title} === 'api'`, 'the project after the delete');
    await app.stop();
    app = await launch();
    page = app.page;
    await page.waitFor(
      `${shownProfile} === 'personal' && ${title} === 'api'`,
      'Personal with the project',
      20_000,
    );
    assert.equal(await page.eval(`${title}`), 'api');
    await screenshot(page, screenshotDir, 'r2-restored-project.png');

    console.log(`e2e-restore: ok (${devMode ? 'dev server' : 'production build'})`);
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
