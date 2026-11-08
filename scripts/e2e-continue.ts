/**
 * End-to-end test of continuing interrupted work (spec §9.7): quitting while
 * Claude works, with one workspace interrupted with Esc and one waiting for
 * permission; then starting again with the profile's setting on (the notice,
 * the continue prompt sent once and only to the Working ones, Stop) and off
 * (the overview with its default ticks, Not now and Continue selected, the
 * workspace bar's Continue and Dismiss). Runs with a throwaway HOME and a fake
 * `claude` that records what is typed into it.
 *
 *   tsx scripts/e2e-continue.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { BRAND } from '../src/shared/brand';
import { DEFAULT_RESUME_PROMPT } from '../src/shared/unfinished';
import {
  type Cdp,
  CMD,
  chooseFromNextContextMenu,
  clickButtonText,
  clickClosingButton,
  clickLabel,
  dialogText,
  launchApp,
  openContextMenu,
  pressKey,
  pressShortcut,
  type RunningApp,
  showHomeList,
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

/** The sidebar row of a workspace, by its name, as an expression. */
const row = (name: string) =>
  `[...document.querySelectorAll('nav [data-nav-key^="w:"]')].find((b) => b.title.split('\\n')[0] === ${JSON.stringify(name)})`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const api = fx.localRepo('api');
    const notes = fx.localRepo('notes');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, runs SessionStart, turns
    // `prompt` and `permission` into their hooks and records every other line
    // typed into it (the continue prompt) per worktree.
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
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1"; }
name=$(basename "$PWD")
echo started >> "$HOME/starts-$name.txt"
hook SessionStart "{\\"session_id\\":\\"$sid\\"}" > /dev/null
while IFS= read -r line; do
  case "$line" in
    prompt) printf '\\342\\235\\257 Fix the login\\n'; hook UserPromptSubmit '{"prompt":"Fix the login"}' ;;
    permission) hook Notification '{"message":"Claude needs your permission to use Bash"}' ;;
    # Done with a dev server still running in the background (spec §10.2).
    background) hook Stop '{"background_tasks":[{"type":"shell","status":"running","command":"npm run dev"}]}' ;;
    *) printf '%s\\n' "$line" >> "$HOME/input-$name.txt" ;;
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
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
        })),
        projects: [
          { id: 'api', profileId: 'work', name: 'api', repoPath: api, remote: null },
          { id: 'notes', profileId: 'personal', name: 'notes', repoPath: notes, remote: null },
        ],
      }),
    );
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    /** How often the continue prompt reached the workspace's Claude (by worktree folder). */
    const continued = (branch: string) => {
      const file = path.join(fx.root, `input-${branch}.txt`);
      if (!fs.existsSync(file)) return 0;
      return fs.readFileSync(file, 'utf8').split('Continue where you left off.').length - 1;
    };
    const starts = (branch: string) => {
      const file = path.join(fx.root, `starts-${branch}.txt`);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;
    };

    // Any uncaught exception in the main process is a failure: written to a
    // file, as the listener outlives the inspector's connection.
    const uncaughtLog = path.join(fx.root, 'uncaught.log');
    const launch = async () => {
      app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
      await app.main.eval(`void process.on('uncaughtException', (e) =>
        process.mainModule.require('node:fs').appendFileSync(${JSON.stringify(uncaughtLog)}, String(e?.stack ?? e) + '\\n'))`);
      return app;
    };
    const assertNoUncaught = (what: string) =>
      assert.equal(
        fs.existsSync(uncaughtLog) ? fs.readFileSync(uncaughtLog, 'utf8') : '',
        '',
        `${what}: no uncaught exception in the main process`,
      );
    /** ⌘Q as a user quits, the quit dialog's text, then Quit; the app exits. */
    const quit = async (running: RunningApp, expected: RegExp) => {
      await running.main.eval(
        process.platform === 'darwin'
          ? `void setTimeout(() => process.mainModule.require('electron').Menu.sendActionToFirstResponder('terminate:'))`
          : `void setTimeout(() => process.mainModule.require('electron').app.quit())`,
      );
      await running.page.waitFor(`${dialogText}.includes('running session')`, 'the quit dialog');
      assert.match(await running.page.eval<string>(dialogText), expected);
      await clickClosingButton(running.page, 'Quit', `document.querySelector('dialog[open]')`);
      running.page.close();
      running.main.close();
      assert.ok(await running.exited(20_000), 'the app quit');
      app = undefined;
    };
    const ids: Record<string, string> = {};
    const idOf = async (page: Cdp, name: string) => {
      await page.waitFor(`!!(${row(name)})`, `the row of ${name}`);
      ids[name] = (await page.eval<string>(`(${row(name)}).dataset.navKey`)).slice(2);
      return ids[name] as string;
    };
    /** Opens a workspace from the sidebar, expanding its project, and waits for its terminal. */
    const open = async (page: Cdp, name: string, project: string) => {
      await page.eval(
        `document.querySelector('[data-nav-key="p:${project}"] button[aria-label="Expand"]')?.click()`,
      );
      await page.waitFor(`!!(${row(name)})`, `the row of ${name}`);
      await page.eval(`(${row(name)}).click()`);
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${name}`,
      );
    };
    const stateOf = (name: string) => `((${row(name)})?.title.split('\\n')[1] ?? '')`;
    const waitState = (page: Cdp, name: string, state: string) =>
      page.waitFor(`${stateOf(name)}.startsWith(${JSON.stringify(state)})`, `${name}: ${state}`);
    const marker = (name: string) => `(${row(name)})?.dataset.unfinished ?? null`;
    const newWorkspace = async (page: Cdp, project: string, task: string, branch: string) => {
      await clickLabel(page, `New workspace in ${project}`);
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, `the workspace ${task}`);
      await waitForFile(path.join(fx.root, `starts-${branch}.txt`));
    };
    const openEditProfile = async (running: RunningApp, profile: string) => {
      await chooseFromNextContextMenu(running.main, 'Edit profile…');
      await openContextMenu(running.page, `[aria-label="Select ${profile}"]`);
      await running.page.waitFor(
        `!!document.querySelector('dialog[open] #edit-profile-continue')`,
        'Edit profile',
      );
    };

    // 1. Four workspaces in Work and one in Personal, with Claude in each.
    let running = await launch();
    let { page } = running;
    await newWorkspace(page, 'api', 'Alpha', 'alpha');
    await newWorkspace(page, 'api', 'Alpha two', 'alpha-two');
    await newWorkspace(page, 'api', 'Bravo', 'bravo');
    await newWorkspace(page, 'api', 'Charlie', 'charlie');
    for (const name of ['Alpha', 'Alpha two', 'Bravo', 'Charlie']) await idOf(page, name);
    await pressKey(page, 'Digit2', CMD);
    await newWorkspace(page, 'notes', 'Delta', 'delta');
    await idOf(page, 'Delta');

    // Work continues interrupted work at start (Edit profile › General), with the default prompt.
    await pressKey(page, 'Digit1', CMD);
    await openEditProfile(running, 'Work');
    assert.equal(
      await page.eval(`document.querySelector('#edit-profile-continue').checked`),
      false,
      'off by default',
    );
    assert.equal(
      await page.eval(`document.querySelector('#edit-profile-continue-prompt').value`),
      DEFAULT_RESUME_PROMPT,
    );
    await page.eval(`document.querySelector('#edit-profile-continue').click()`);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');
    const work = readConfig().profiles.find((p: { id: string }) => p.id === 'work');
    assert.deepEqual(work.resume, { continueAtStart: true }, 'the default prompt is not written');

    // Alpha, Alpha two and Delta work; Bravo is interrupted with Esc; Charlie asks for permission.
    for (const name of ['Alpha', 'Alpha two']) {
      await open(page, name, 'api');
      await typeInTerminal(page, 'prompt');
      await waitState(page, name, 'Working');
    }
    await open(page, 'Bravo', 'api');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Bravo', 'Working');
    await pressKey(page, 'Escape');
    await waitState(page, 'Bravo', 'Interrupted');
    await open(page, 'Charlie', 'api');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState(page, 'Charlie', 'Needs permission');
    await pressKey(page, 'Digit2', CMD);
    await open(page, 'Delta', 'notes');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Delta', 'Working');
    // The quit dialog says what comes next: Work's two continue, the rest are asked about.
    await quit(running, /2 will continue when \w+ starts again; you'll be asked about the rest\./);

    // 2. Setting on: the notice continues Alpha, then Stop before Alpha two.
    running = await launch();
    ({ page } = running);
    await page.waitFor(`!!document.querySelector('[data-continue-notice]')`, 'the notice', 20_000);
    const item = (name: string) =>
      `document.querySelector('[data-continue-item="${ids[name]}"]')?.dataset.state`;
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('[data-continue-item]')].map((i) => i.dataset.continueItem).join()`,
      ),
      [ids.Alpha, ids['Alpha two']].join(),
      'only the Working ones of Work, in order',
    );
    await page.waitFor(`${item('Alpha')} === 'sent'`, 'Alpha continued', 20_000);
    await clickButtonText(page, 'Stop', `document.querySelector('[data-continue-notice]')`);
    // The overview follows the notice: Bravo unticked, Charlie without a box, Delta ticked.
    await page.waitFor(`!!document.querySelector('[data-unfinished-overview]')`, 'the overview');
    assert.equal(
      await page.eval(`document.querySelector('[data-continue-notice]')`),
      null,
      'the notice is gone',
    );
    assert.match(await page.eval<string>(dialogText), /Claude didn't finish in 3 workspaces/);
    const rows = await page.eval<{ id: string; kind: string; box: boolean | null }[]>(
      `[...document.querySelectorAll('[data-unfinished-row]')].map((r) => ({
        id: r.dataset.unfinishedRow, kind: r.dataset.kind,
        box: r.querySelector('input[type=checkbox]')?.checked ?? null }))`,
    );
    assert.deepEqual(rows, [
      { id: ids.Bravo, kind: 'interrupted', box: false },
      { id: ids.Charlie, kind: 'permission', box: null },
      { id: ids.Delta, kind: 'working', box: true },
    ]);
    assert.match(
      await page.eval<string>(
        `document.querySelector('[data-unfinished-row="${ids.Bravo}"] [data-last-prompt]').textContent`,
      ),
      /Fix the login/,
    );
    // Not now (Esc) leaves the markers.
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the overview to close');
    await sleep(5000);
    assert.equal(continued('alpha'), 1, 'Alpha got the continue prompt once');
    for (const branch of ['alpha-two', 'bravo', 'charlie', 'delta']) {
      assert.equal(continued(branch), 0, `nothing went to ${branch}`);
    }
    await pressKey(page, 'Digit1', CMD);
    await page.eval(
      `document.querySelector('[data-nav-key="p:api"] button[aria-label="Expand"]')?.click()`,
    );
    await page.waitFor(`(${marker('Alpha two')}) === 'working'`, 'Alpha two stays unfinished');
    assert.equal(await page.eval(marker('Alpha')), null, 'Alpha is no longer unfinished');
    assert.equal(await page.eval(marker('Bravo')), 'interrupted');
    assert.equal(await page.eval(marker('Charlie')), 'permission');
    assert.equal(
      await page.eval(`(${row('Alpha two')}).querySelector('[role=img]')?.getAttribute('title')`),
      `Claude didn't finish when ${BRAND.displayName} closed`,
    );
    // Delta in Personal: under Home's Needs you (spec §6.7), with Continue and
    // Dismiss; Dismiss drops the marker and sends nothing.
    // Personal opens on Delta, shown when the app quit (spec §5); then its Home.
    await pressKey(page, 'Digit2', CMD);
    await pressShortcut(page, 'home');
    await showHomeList(page);
    const homeDelta = `document.querySelector('[data-home-row="${ids.Delta}"]')`;
    await page.waitFor(
      `${homeDelta}?.dataset.homeSection === 'needs' && ${homeDelta}.innerText.includes('Unfinished')`,
      "Delta under Home's Needs you",
    );
    assert.equal(
      await page.eval(`!!${homeDelta}.querySelector('[data-home-action=continue]')`),
      true,
    );
    await page.eval(`${homeDelta}.querySelector('[data-home-action=dismiss]').click()`);
    await page.waitFor(`!${homeDelta}`, 'Delta dismissed');
    await pressKey(page, 'Digit1', CMD);

    // The bar: Continue in Bravo sends the prompt; Dismiss in Alpha two sends nothing.
    await open(page, 'Bravo', 'api');
    await page.waitFor(`!!document.querySelector('[data-unfinished-bar="interrupted"]')`, 'bar');
    await clickButtonText(page, 'Continue', `document.querySelector('[data-unfinished-bar]')`);
    await page.waitFor(`!document.querySelector('[data-unfinished-bar]')`, 'Bravo continued');
    await waitForFile(path.join(fx.root, 'input-bravo.txt'));
    assert.equal(continued('bravo'), 1);
    await open(page, 'Alpha two', 'api');
    await page.waitFor(`!!document.querySelector('[data-unfinished-bar="working"]')`, 'bar');
    await clickButtonText(page, 'Dismiss', `document.querySelector('[data-unfinished-bar]')`);
    await page.waitFor(`(${marker('Alpha two')}) === null`, 'Alpha two dismissed');
    assert.equal(continued('alpha-two'), 0);

    // Work again, setting off: Alpha works, Bravo is interrupted, Charlie asks again.
    await open(page, 'Alpha', 'api');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Alpha', 'Working');
    await open(page, 'Bravo', 'api');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Bravo', 'Working');
    await pressKey(page, 'Escape');
    await waitState(page, 'Bravo', 'Interrupted');
    await open(page, 'Charlie', 'api');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState(page, 'Charlie', 'Needs permission');
    await openEditProfile(running, 'Work');
    await page.eval(`document.querySelector('#edit-profile-continue').click()`);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');
    assert.equal(
      readConfig().profiles.find((p: { id: string }) => p.id === 'work').resume,
      undefined,
    );
    // Delta (Personal) is Done with a dev server still running; Personal continues
    // at start, but stopped commands are never continued by themselves.
    await pressKey(page, 'Digit2', CMD);
    await open(page, 'Delta', 'notes');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Delta', 'Working');
    await typeInTerminal(page, 'background');
    await page.waitFor(
      `!!(${row('Delta')})?.querySelector('[data-background="1"]')`,
      'Delta: Done, 1 running',
    );
    await openEditProfile(running, 'Personal');
    await page.eval(`document.querySelector('#edit-profile-continue').click()`);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');
    await pressKey(page, 'Digit1', CMD);
    await quit(running, /You'll be asked when \w+ starts again\./);

    // 3. Setting off: no notice; the overview, and Continue selected (⌘↵).
    running = await launch();
    ({ page } = running);
    await page.waitFor(
      `!!document.querySelector('[data-unfinished-overview]')`,
      'the overview',
      20_000,
    );
    assert.equal(await page.eval(`document.querySelector('[data-continue-notice]')`), null);
    // Only what this stop left unfinished; Delta's stopped command unticked, with its note.
    const overviewRows = await page.eval<{ id: string; kind: string; box: boolean | null }[]>(
      `[...document.querySelectorAll('[data-unfinished-row]')].map((r) => ({
        id: r.dataset.unfinishedRow, kind: r.dataset.kind,
        box: r.querySelector('input[type=checkbox]')?.checked ?? null }))`,
    );
    assert.deepEqual(overviewRows, [
      { id: ids.Alpha, kind: 'working', box: true },
      { id: ids.Bravo, kind: 'interrupted', box: false },
      { id: ids.Charlie, kind: 'permission', box: null },
      { id: ids.Delta, kind: 'commands', box: false },
    ]);
    assert.match(
      await page.eval<string>(
        `document.querySelector('[data-unfinished-row="${ids.Delta}"]').innerText`,
      ),
      /1 background command was stopped/,
    );
    await pressKey(page, 'Enter', CMD);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the overview to close');
    for (let i = 0; i < 100 && continued('alpha') < 2; i++) await sleep(100);
    await sleep(5000);
    assert.equal(continued('alpha'), 2, 'Alpha got the continue prompt again, once');
    assert.equal(continued('bravo'), 1, 'Bravo was unticked');
    assert.equal(continued('charlie'), 0);
    assert.equal(continued('delta'), 0, 'Delta was unticked, and never continued by itself');
    await page.eval(
      `document.querySelector('[data-nav-key="p:api"] button[aria-label="Expand"]')?.click()`,
    );
    await page.waitFor(`(${marker('Alpha')}) === null`, 'Alpha continued');
    assert.equal(await page.eval(marker('Bravo')), 'interrupted');
    assert.equal(await page.eval(marker('Charlie')), 'permission');
    // Delta's marker and bar say what was stopped; its Continue sends the prompt.
    await pressKey(page, 'Digit2', CMD);
    await open(page, 'Delta', 'notes');
    assert.equal(await page.eval(marker('Delta')), 'commands');
    assert.match(
      await page.eval<string>(`(${row('Delta')}).title`),
      /didn't finish when \w+ closed: 1 background command was stopped/,
    );
    await page.waitFor(
      `document.querySelector('[data-unfinished-bar="commands"]')?.innerText.includes('1 background command was stopped.')`,
      "Delta's bar",
    );
    // Continue from Home's row sends the prompt, as the bar's does.
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!${homeDelta}`, 'Delta on Home');
    await page.eval(`${homeDelta}.querySelector('[data-home-action=continue]').click()`);
    await page.waitFor(`(${marker('Delta')}) === null`, 'Delta continued');
    for (let i = 0; i < 50 && continued('delta') < 1; i++) await sleep(100);
    assert.equal(continued('delta'), 1);
    await pressKey(page, 'Digit1', CMD);
    // Claude resumed once per start in each workspace.
    assert.equal(starts('alpha'), 3);
    assertNoUncaught('the restarts');
    // Quitting while keys keep arriving in a workspace's Claude terminal: input
    // after the shutdown began must reach neither the sessions nor state.db.
    await open(page, 'Alpha', 'api');
    const lines = () =>
      fs.readFileSync(path.join(fx.root, 'input-alpha.txt'), 'utf8').split('\n').length;
    const before = lines();
    await page.eval(`(() => {
      const input = [...document.querySelectorAll('[data-terminal][data-connected]')]
        .find((t) => t.offsetParent)?.querySelector('.xterm-helper-textarea');
      const enter = () => {
        const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => 13 });
        Object.defineProperty(e, 'which', { get: () => 13 });
        return e;
      };
      setInterval(() => input?.dispatchEvent(enter()), 2);
    })()`);
    for (let i = 0; i < 50 && lines() < before + 20; i++) await sleep(100);
    assert.ok(lines() >= before + 20, 'the keys reach Claude');
    await quit(running, /running session/);
    // The listener writes after the window is gone: give a late one time.
    await sleep(500);
    assertNoUncaught('quitting while typing');
    console.log(`e2e continue test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) {
      const text = await app.page
        .eval<string>(`document.querySelector('#root')?.innerText.slice(0, 1500) ?? ''`)
        .catch(() => '');
      console.error(`window text:\n${text}`);
      if (app.page.errors.length > 0)
        console.error(`renderer errors:\n  ${app.page.errors.join('\n  ')}`);
    }
    throw error;
  } finally {
    await (app as RunningApp | undefined)?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e continue test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
