/**
 * End-to-end test of clicking a notification (spec §10.3), with a fake
 * `claude`: a recorded notification's click (the test-only
 * `globalThis.__clickNotification`) shows the workspace's profile, selects
 * the workspace and puts its Claude tab in focus, from another profile and
 * from the workspace's shell tab; a suspended workspace resumes; one that no
 * longer exists leaves the app as it is; and on macOS, with the window
 * closed while the app keeps running, the click opens a window that shows it.
 *
 *   tsx scripts/e2e-notifications.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { envVar } from '../src/shared/brand';
import {
  type Cdp,
  clickClosingButton,
  clickLabel,
  dialogText,
  launchApp,
  type RunningApp,
  sleep,
  submitDialog,
  typeInField,
  typeInTerminal,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => a !== '--dev');
const isMac = process.platform === 'darwin';

/** A minute lasts this long here: "after 5 minutes" is 5 seconds. */
const MINUTE_MS = 1000;
const DELAY_MS = 5 * MINUTE_MS;

/** The sidebar row of a workspace, by its name, as an expression. */
const row = (name: string) =>
  `[...document.querySelectorAll('nav [data-nav-key^="w:"]')].find((b) => b.title.split('\\n')[0] === ${JSON.stringify(name)})`;
const suspendedRow = (name: string) => `(${row(name)})?.dataset.suspended === 'true'`;
const currentProfile = `document.querySelector('[role=tab][aria-current=true]')?.getAttribute('aria-label')`;
const activeTab = `(document.querySelector('[role=tablist][aria-label=Terminals] [aria-selected=true]')?.textContent ?? '')`;
const tabCount = `document.querySelectorAll('[role=tablist][aria-label=Terminals] [role=tab]').length`;
/** The Claude tab of the workspace, shown and in focus. */
const claudeInFocus = (title: string) =>
  `document.querySelector('h1')?.textContent === ${JSON.stringify(title)} && ${activeTab}.includes('Claude') && !!document.activeElement?.classList.contains('xterm-helper-textarea') && !!document.activeElement.closest('[data-terminal]')`;

const windowCount = (main: Cdp) =>
  main.eval<number>(`process.mainModule.require('electron').BrowserWindow.getAllWindows().length`);

async function waitForWindows(main: Cdp, count: number, what: string) {
  for (const end = Date.now() + 10_000; Date.now() < end; ) {
    if ((await windowCount(main)) === count) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const api = fx.localRepo('api');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, records how it was
    // started, runs SessionStart with its transcript's path, and turns
    // `prompt` and `done` into their hooks. As Claude Code, it writes its
    // transcript at the first prompt, and a resume without one fails.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
settings=""; sid="fake-$$"; prev=""
for arg in "$@"; do
  [ "$prev" = --settings ] && settings="$arg"
  { [ "$prev" = --session-id ] || [ "$prev" = --resume ]; } && sid="$arg"
  prev="$arg"
done
transcript="$HOME/transcripts/$sid.jsonl"
case " $* " in *" --resume "*) [ -e "$transcript" ] || { echo "No conversation found with session ID: $sid"; exit 1; } ;; esac
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1" > /dev/null; }
name=$(basename "$PWD")
echo "$*" >> "$HOME/starts-$name.txt"
hook SessionStart "{\\"session_id\\":\\"$sid\\",\\"transcript_path\\":\\"$transcript\\"}"
echo "fake claude in $name"
while IFS= read -r line; do
  case "$line" in
    prompt)
      mkdir -p "$HOME/transcripts"
      echo '{"type":"user","message":{"role":"user","content":"Fix the login"}}' >> "$transcript"
      hook UserPromptSubmit '{"prompt":"Fix the login"}' ;;
    done) hook Stop '{}' ;;
  esac
done
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
          // Work suspends idle Claude sessions after 5 (short) minutes (spec §9.8).
          ...(p.id === 'work' ? { suspendIdleMin: 5 } : {}),
        })),
        projects: [{ id: 'api', profileId: 'work', name: 'api', repoPath: api, remote: null }],
      }),
    );
    const file = (name: string) => path.join(fx.root, name);
    const starts = (name: string) =>
      fs.existsSync(file(`starts-${name}.txt`))
        ? fs
            .readFileSync(file(`starts-${name}.txt`), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
        : [];

    const running = await launchApp({
      env: withDisplayEnv({ ...fx.env, [envVar('SUSPEND_MINUTE_MS')]: String(MINUTE_MS) }),
      dev: devMode,
      electronArgs,
    });
    app = running;
    let { page } = running;
    const notifications = () =>
      running.main.eval<{ workspaceId: string; title: string }[]>('globalThis.__notifications');
    const clickNotification = (index: number) =>
      running.main.eval(`globalThis.__clickNotification(${index})`);
    const ids: Record<string, string> = {};
    const expandApi = () =>
      page.eval(
        `document.querySelector('[data-nav-key="p:api"] button[aria-label="Expand"]')?.click()`,
      );
    const open = async (name: string) => {
      await clickLabel(page, 'Select Work');
      await expandApi();
      await page.waitFor(`!!(${row(name)})`, `the row of ${name}`);
      await page.eval(`(${row(name)}).click()`);
      await page.waitFor(
        `document.querySelector('h1')?.textContent === ${JSON.stringify(name)} && !!document.querySelector('[data-terminal][data-connected]')`,
        `the terminal of ${name}`,
      );
    };
    const newWorkspace = async (task: string, branch: string) => {
      await clickLabel(page, 'New workspace in api');
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, `the workspace ${task}`);
      await waitForFile(file(`starts-${branch}.txt`));
      await expandApi();
      await page.waitFor(`!!(${row(task)})`, `the row of ${task}`);
      ids[task] = (await page.eval<string>(`(${row(task)}).dataset.navKey`)).slice(2);
    };
    const showPersonal = async () => {
      await clickLabel(page, 'Select Personal');
      await page.waitFor(`${currentProfile} === 'Select Personal'`, 'the Personal profile');
      await page.eval(`(document.activeElement?.blur(), true)`);
    };
    /** Done in the workspace: its notification's index. */
    const doneIn = async (name: string) => {
      const before = (await notifications()).length;
      await open(name);
      await typeInTerminal(page, 'prompt');
      await typeInTerminal(page, 'done');
      await running.main.waitFor(
        `globalThis.__notifications.length === ${before + 1}`,
        `the Done notification of ${name}`,
      );
      const recorded = (await notifications())[before];
      assert.equal(recorded?.workspaceId, ids[name]);
      assert.equal(recorded?.title, `[Work] ${name} is done`);
      return before;
    };

    // 1. Alpha's notification, clicked from the Personal profile while
    // Alpha shows its shell tab: Work, Alpha, its Claude tab in focus.
    await newWorkspace('Alpha', 'alpha');
    await newWorkspace('Bravo', 'bravo');
    const alpha = await doneIn('Alpha');
    await clickLabel(page, 'New shell');
    await page.waitFor(`${tabCount} === 2 && ${activeTab}.includes('Shell')`, "Alpha's shell tab");
    await showPersonal();
    await clickNotification(alpha);
    await page.waitFor(
      `${currentProfile} === 'Select Work' && ${claudeInFocus('Alpha')}`,
      "Alpha's Claude tab in focus, in Work",
    );
    // Clicked again with the focus elsewhere in the same workspace: back in Claude.
    await page.eval(`(document.activeElement?.blur(), true)`);
    await clickNotification(alpha);
    await page.waitFor(claudeInFocus('Alpha'), "Alpha's Claude in focus again");

    // 2. A workspace that no longer exists (deleted since, or from before a
    // restart): the app stays as it is, without an error.
    await running.main.eval(
      `globalThis.__notifications.push({ workspaceId: 'gone', profileId: 'work', state: 'done', title: '[Work] gone is done', body: '' })`,
    );
    const gone = (await notifications()).length - 1;
    await showPersonal();
    await clickNotification(gone);
    await sleep(1000);
    assert.equal(await page.eval(currentProfile), 'Select Personal', 'nothing opened');
    assert.deepEqual(page.errors, [], 'no renderer errors');

    // 3. A suspended workspace (spec §9.8): the click opens it and it resumes.
    const bravo = await doneIn('Bravo');
    await open('Alpha');
    await expandApi();
    await page.waitFor(suspendedRow('Bravo'), 'Bravo suspended', DELAY_MS + 15_000);
    assert.equal(starts('bravo').length, 1);
    await showPersonal();
    await clickNotification(bravo);
    await page.waitFor(
      `${currentProfile} === 'Select Work' && document.querySelector('h1')?.textContent === 'Bravo'`,
      'Bravo in Work',
    );
    await until(() => starts('bravo').length === 2, 'Bravo to resume');
    assert.match(starts('bravo')[1] ?? '', /--resume \S+/);
    await page.waitFor(`!document.querySelector('[data-resuming]')`, 'Bravo ready', 20_000);
    await page.waitFor(claudeInFocus('Bravo'), "Bravo's Claude tab in focus");
    assert.equal(await page.eval(suspendedRow('Bravo')), false);

    // 4. macOS: the window closed while the app keeps running (spec §5). The
    // click opens a window, which shows Alpha's Claude tab in focus.
    if (isMac) {
      await showPersonal();
      await running.main.eval(
        `void setTimeout(() => process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close())`,
      );
      // The first close ever says the app keeps running.
      await page.waitFor(`${dialogText}.includes('keeps running')`, 'the close notice');
      await clickClosingButton(page, 'Close Window', `document.querySelector('dialog[open]')`);
      page.close();
      await waitForWindows(running.main, 0, 'the window to close');
      await clickNotification(alpha);
      await waitForWindows(running.main, 1, 'a window for the click');
      page = await running.reconnect();
      await page.waitFor(
        `${currentProfile} === 'Select Work' && ${claudeInFocus('Alpha')}`,
        "Alpha's Claude tab in focus, in the new window",
      );
      // One that no longer exists, with no window: the app opens, without an error.
      page.close();
      await running.main.eval(
        `void setTimeout(() => process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close())`,
      );
      await waitForWindows(running.main, 0, 'the window to close again');
      await clickNotification(gone);
      await waitForWindows(running.main, 1, 'a window for the click');
      page = await running.reconnect();
      await page.waitFor(`!!document.querySelector('nav')`, 'the window');
      await sleep(1000);
      assert.deepEqual(page.errors, [], 'no renderer errors');
    }

    await running.stop();
    app = undefined;
    console.log(`e2e notifications test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) {
      if (app.page.errors.length > 0) {
        console.error(`renderer errors:\n  ${app.page.errors.join('\n  ')}`);
      }
    }
    throw error;
  } finally {
    await app?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e notifications test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
