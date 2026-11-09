/**
 * End-to-end test of quitting and closing the window (spec §5): ⌘Q quits
 * completely, asking once while something runs; closing the window keeps the
 * app running on macOS and says so once ever; Quit When the Window Closes; on
 * Linux closing the window quits. After every quit no process of the app is
 * left. Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-quit.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { QUIT_ON_CLOSE_LABEL } from '../src/shared/window-close';
import {
  assertExitedCleanly,
  type Cdp,
  clickClosingButton,
  dialogText,
  launchApp,
  pressShortcut,
  type RunningApp,
  sleep,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => a !== '--dev');
const isMac = process.platform === 'darwin';

/** Every process started under `pid`, at any depth (Electron's helpers, shells, Claude). */
function descendants(pid: number): number[] {
  const parents = new Map<number, number[]>();
  for (const line of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined) continue;
    parents.set(parent, [...(parents.get(parent) ?? []), child]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const c of parents.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The app exits by itself, leaving none of its processes and no process started from the fixture. */
async function assertGone(app: RunningApp, processes: number[], root: string, what: string) {
  // An attached inspector keeps Electron's main process from exiting.
  app.main.close();
  assert.ok(await app.exited(15_000), `${what}: the app quit by itself`);
  await assertExitedCleanly(app, what);
  for (const end = Date.now() + 5_000; Date.now() < end; ) {
    if (processes.every((p) => !alive(p))) break;
    await sleep(100);
  }
  assert.deepEqual(
    processes.filter(alive),
    [],
    `${what}: no process of the app is left (Electron's helpers, shells, Claude)`,
  );
  let leftover = '';
  try {
    leftover = execFileSync('pgrep', ['-fl', root], { encoding: 'utf8' }).trim();
  } catch {
    // pgrep exits 1 when nothing matches
  }
  assert.equal(leftover, '', `${what}: pgrep finds nothing started from the fixture`);
}

/** Native message boxes are recorded and answered with Cancel: none is expected. */
const recordNativeDialogs = (main: Cdp) =>
  main.eval(`(() => {
    const fs = process.mainModule.require('node:fs');
    const path = process.mainModule.require('node:path');
    const { dialog } = process.mainModule.require('electron');
    const log = (options) =>
      fs.appendFileSync(path.join(process.env.HOME, 'native-dialogs.log'), (options.message ?? '') + '\\n');
    dialog.showMessageBox = async (...a) => { log(a.at(-1)); return { response: 1, checkboxChecked: false }; };
    dialog.showMessageBoxSync = (...a) => { log(a.at(-1)); return 1; };
  })()`);

const windowCount = (main: Cdp) =>
  main.eval<number>(`process.mainModule.require('electron').BrowserWindow.getAllWindows().length`);
// closeWindow and pressQuit return before acting: the app may quit before
// an answer could arrive.
const closeWindow = (main: Cdp) =>
  main.eval(
    `void setTimeout(() => process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close())`,
  );
/** As clicking the Dock icon does. */
const activate = (main: Cdp) =>
  main.eval(`process.mainModule.require('electron').app.emit('activate')`);
/**
 * ⌘Q, the app menu's Quit and the Dock's Quit: Cocoa's terminate:, which the
 * menu item sends natively (its role can't be clicked from script).
 */
const pressQuit = (main: Cdp) =>
  main.eval(
    `void setTimeout(() => process.mainModule.require('electron').Menu.sendActionToFirstResponder('terminate:'))`,
  );
/** A menu item by label, clicked as when chosen from the menu. */
const clickMenuItem = (main: Cdp, label: string) =>
  main.eval(`(() => {
    const { Menu } = process.mainModule.require('electron');
    const find = (items) => items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu.items) : [])]);
    find(Menu.getApplicationMenu().items).find((i) => i.label === ${JSON.stringify(label)}).click();
  })()`);

async function waitForWindows(main: Cdp, count: number, what: string) {
  for (const end = Date.now() + 10_000; Date.now() < end; ) {
    if ((await windowCount(main)) === count) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  const nativeDialogs = path.join(fx.root, 'native-dialogs.log');
  try {
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, otherwise records that it
    // started and waits. Scripted tests never start the real one.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
echo started > "$HOME/claude-started.txt"
exec sleep 600
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fx.root, '.claude.json'), '{}');
    fs.mkdirSync(path.join(fx.root, '.claude-personal'));
    fs.writeFileSync(path.join(fx.root, '.claude-personal', '.claude.json'), '{}');
    const configDir = appConfigDir({ platform: process.platform, env: {}, homeDir: fx.root });
    const configFile = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
        })),
        // A project whose expanding in the sidebar the window remembers.
        projects: [
          {
            id: 'notes',
            profileId: 'work',
            name: 'notes',
            repoPath: fx.localRepo('notes'),
            remote: null,
            baseBranch: 'main',
          },
        ],
      }),
    );
    const launch = async () => {
      const running = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
      app = running;
      await recordNativeDialogs(running.main);
      return running;
    };

    if (isMac) {
      // Closing the window the first time: the notice says the app keeps running.
      let running = await launch();
      let page = running.page;
      await closeWindow(running.main);
      await page.waitFor(`${dialogText}.includes('keeps running')`, 'the close notice');
      assert.match(await page.eval<string>(dialogText), /Click .+ in the Dock/);
      assert.match(await page.eval<string>('document.activeElement.textContent'), /^Close Window/);
      assert.equal(await windowCount(running.main), 1, 'the window waits for the answer');
      await clickClosingButton(page, 'Close Window', `document.querySelector('dialog[open]')`);
      page.close();
      await waitForWindows(running.main, 0, 'the window to close');
      await sleep(500);
      assert.ok(alive(running.pid), 'the app keeps running without a window');

      // The Dock icon brings it back; closing it again says nothing.
      await activate(running.main);
      page = await running.reconnect();
      await closeWindow(running.main);
      await waitForWindows(running.main, 0, 'the window to close without the notice');
      assert.ok(alive(running.pid), 'still running');

      // ⌘Q while Claude runs asks once, in the window; Quit quits completely.
      await activate(running.main);
      page = await running.reconnect();
      await pressShortcut(page, 'startClaude');
      await waitForFile(path.join(fx.root, 'claude-started.txt'));
      await sleep(500);
      let processes = descendants(running.pid);
      await pressQuit(running.main);
      await page.waitFor(`${dialogText}.includes('Stop 1 running session?')`, 'the quit dialog');
      await clickClosingButton(page, 'Quit', `document.querySelector('dialog[open]')`);
      await assertGone(running, processes, fx.root, '⌘Q with Claude running');
      assert.equal(fs.existsSync(nativeDialogs), false, 'no second question');
      app = undefined;

      // The notice was shown once ever: after a restart closing says nothing,
      // and ⌘Q with nothing running quits without any question.
      running = await launch();
      await closeWindow(running.main);
      await waitForWindows(running.main, 0, 'the window to close without the notice');
      assert.ok(alive(running.pid), 'still running after the restart');
      await activate(running.main);
      await running.reconnect();
      processes = descendants(running.pid);
      await pressQuit(running.main);
      await assertGone(running, processes, fx.root, '⌘Q with nothing running');
      assert.equal(fs.existsSync(nativeDialogs), false, 'no question at all');
      app = undefined;

      // Quit When the Window Closes: stored in config.json; closing then quits.
      running = await launch();
      await clickMenuItem(running.main, QUIT_ON_CLOSE_LABEL);
      assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).quitOnWindowClose, true);
      processes = descendants(running.pid);
      await closeWindow(running.main);
      await assertGone(running, processes, fx.root, 'closing with Quit When the Window Closes');
      assert.equal(fs.existsSync(nativeDialogs), false, 'no question');
      app = undefined;
    } else {
      // Linux: closing the window quits, without a notice; with nothing running,
      // without a question.
      const running = await launch();
      const processes = descendants(running.pid);
      await closeWindow(running.main);
      await assertGone(running, processes, fx.root, 'closing the window on Linux');
      assert.equal(fs.existsSync(nativeDialogs), false, 'no question');
      app = undefined;
      // The end of a desktop session (spec §5): every process of the app is
      // signalled at once, or its display goes away. What the window
      // remembers (here a project expanded in the sidebar) was on disk already.
      const remembered = `localStorage.getItem('sidebar-projects')`;
      for (const end of ['every process signalled', 'the display gone'] as const) {
        let display: ChildProcess | null = null;
        let env = withDisplayEnv(fx.env);
        if (end === 'the display gone') {
          display = spawn('Xvfb', [':93', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
            stdio: 'ignore',
          });
          await sleep(1000);
          env = { ...env, DISPLAY: ':93' };
          delete env.XAUTHORITY;
        }
        const running = await launchApp({ env, dev: devMode, electronArgs });
        app = running;
        const before = await running.page.eval<string | null>(remembered);
        // Expanded by the first round and remembered, so the second collapses it.
        const toggle = `document.querySelector('[data-nav-key="p:notes"] button:is([aria-label="Expand"], [aria-label="Collapse"])')`;
        await running.page.waitFor(`!!${toggle}`, 'the project');
        await running.page.eval(`${toggle}.click()`);
        await running.page.waitFor(`${remembered} !== ${JSON.stringify(before)}`, 'the change');
        const changed = await running.page.eval<string | null>(remembered);
        // A moment later, as no one logs out within a fraction of a second.
        await sleep(1000);
        running.page.close();
        running.main.close();
        if (display) display.kill('SIGTERM');
        else process.kill(-(running.process.pid as number), 'SIGTERM');
        if (!(await running.exited(20_000))) await running.terminate();
        app = undefined;
        const again = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
        app = again;
        assert.equal(await again.page.eval(remembered), changed, `kept with ${end}`);
        again.page.close();
        assert.equal(await again.stop(), false, 'the app quit by itself');
        app = undefined;
      }
    }
    console.log(`e2e quit test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (fs.existsSync(nativeDialogs)) {
      console.error(`native dialogs:\n${fs.readFileSync(nativeDialogs, 'utf8')}`);
    }
    throw error;
  } finally {
    await (app as RunningApp | undefined)?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e quit test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
