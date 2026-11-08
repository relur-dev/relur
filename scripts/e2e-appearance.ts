/**
 * End-to-end test of View › Appearance (spec §6), with a fake `claude`:
 * System follows the OS, Dark and Light switch the window and its terminal at
 * once (the light terminal with the theme's ANSI palette, the dark one with
 * xterm's own), the choice is written to config.json, and after a restart the
 * window opens in it with the menu item checked. System removes it again.
 *
 *   tsx scripts/e2e-appearance.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { APPEARANCE_LABEL, type Appearance } from '../src/shared/appearance';
import {
  type Cdp,
  launchApp,
  type RunningApp,
  showHomeTerminal,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => a !== '--dev');

/** View › Appearance's items, as the main process sees them. */
const appearanceItems = `(() => {
  const { Menu } = process.mainModule.require('electron');
  const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
  return view.submenu.items.find((i) => i.label === 'Appearance').submenu.items;
})()`;
const choose = (main: Cdp, appearance: Appearance) =>
  main.eval(
    `${appearanceItems}.find((i) => i.label === ${JSON.stringify(APPEARANCE_LABEL[appearance])}).click()`,
  );
const checked = (main: Cdp) =>
  main.eval<string>(`${appearanceItems}.filter((i) => i.checked).map((i) => i.label).join()`);

/** A theme token as rgb()/rgba(), as ui/theme.ts resolves it for xterm. */
const token = (name: string) => `(() => {
  const value = getComputedStyle(document.documentElement).getPropertyValue('${name}').trim();
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? 'rgb(' + r + ', ' + g + ', ' + b + ')' : 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a / 255 + ')';
})()`;
const terminalColors = `[...document.querySelectorAll('[data-terminal]')].find((t) => t.offsetParent)?.dataset.colors ?? ''`;

/** The window, its terminal and nativeTheme are all in `theme`. */
async function assertTheme(page: Cdp, main: Cdp, theme: 'light' | 'dark', what: string) {
  await page.waitFor(`document.documentElement.dataset.theme === '${theme}'`, `${what}: ${theme}`);
  assert.equal(
    await main.eval(`process.mainModule.require('electron').nativeTheme.shouldUseDarkColors`),
    theme === 'dark',
    `${what}: nativeTheme`,
  );
  const red = theme === 'light' ? `${token('--term-ansi-1')}` : `'xterm'`;
  const expected = `[${token('--color-term')}, ${token('--color-term-cursor')}, ${red}].join('|')`;
  await page.waitFor(`(${terminalColors}) === ${expected}`, `${what}: the terminal's colors`);
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
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
        checkForUpdates: false,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
        })),
      }),
    );
    const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).appearance;
    const launch = async () => {
      app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
      await showHomeTerminal(app.page);
      return app;
    };
    const quit = async (running: RunningApp) => {
      running.page.close();
      running.main.close();
      assert.equal(await running.stop(), false, 'the app quit by itself');
      app = undefined;
    };

    // 1. Unset: System, following the OS.
    let running = await launch();
    assert.equal(await checked(running.main), 'System');
    assert.equal(
      await running.main.eval(`process.mainModule.require('electron').nativeTheme.themeSource`),
      'system',
    );
    const os = (await running.page.eval<boolean>(
      `matchMedia('(prefers-color-scheme: dark)').matches`,
    ))
      ? 'dark'
      : 'light';
    await assertTheme(running.page, running.main, os, 'System');

    // 2. Dark and Light apply at once, to the window and the terminal, and are written.
    await choose(running.main, 'dark');
    await assertTheme(running.page, running.main, 'dark', 'Dark');
    assert.equal(stored(), 'dark');
    assert.equal(await checked(running.main), 'Dark');
    await choose(running.main, 'light');
    await assertTheme(running.page, running.main, 'light', 'Light');
    assert.equal(stored(), 'light');
    // The one the OS doesn't use, so the restart below shows it was remembered.
    const other: Appearance = os === 'dark' ? 'light' : 'dark';
    await choose(running.main, other);
    await assertTheme(running.page, running.main, other, 'not the OS');
    await quit(running);

    // 3. Remembered: the next start opens in it, painted so before the page.
    running = await launch();
    assert.equal(
      (
        await running.main.eval<string>(
          `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].getBackgroundColor()`,
        )
      ).toLowerCase(),
      other === 'dark' ? '#0d0e11' : '#c4c2bd',
      "the window's first paint",
    );
    await assertTheme(running.page, running.main, other, 'after a restart');
    assert.equal(await checked(running.main), APPEARANCE_LABEL[other]);

    // 4. System again: the key is removed and the OS appearance applies.
    await choose(running.main, 'system');
    await assertTheme(running.page, running.main, os, 'System again');
    assert.equal(stored(), undefined, 'System removes the key');
    assert.equal(await checked(running.main), 'System');
    await quit(running);
    console.log(`e2e appearance test passed (${devMode ? 'dev server' : 'production build'})`);
  } finally {
    await (app as RunningApp | undefined)?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e appearance test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
