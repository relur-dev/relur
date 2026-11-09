/**
 * End-to-end test of suspension becoming on by default (spec §9.8), with a
 * fake `claude`: profiles from before that never chose a delay get 10
 * minutes and an explicit Off stays; the one-time notice names the changed
 * profiles, its Settings opens Edit profile › General of the shown profile
 * with the new delay, and the next start shows no notice.
 *
 *   tsx scripts/e2e-suspend-notice.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { suspendDefaultNotice } from '../src/shared/suspend';
import {
  clickButtonText,
  launchApp,
  pressKey,
  type RunningApp,
  sleep,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => a !== '--dev');

const notice = `document.querySelector('[data-suspend-notice]')`;

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
    // A config from before the update: Work and Personal never chose a delay,
    // Spare chose Off.
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        checkForUpdates: false,
        profiles: [
          ...SEED_CONFIG.profiles.map(({ suspendIdleMin: _, ...p }) => ({
            ...p,
            claude: { command: fakeClaude, args: [] },
          })),
          {
            id: 'spare',
            name: 'Spare',
            color: 'teal',
            claude: { command: fakeClaude, args: [] },
            suspendIdleMin: 0,
          },
        ],
      }),
    );
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const launch = async () => {
      app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
      return app;
    };
    const quit = async (running: RunningApp) => {
      running.page.close();
      assert.equal(await running.stop(), false, 'the app quit by itself');
      app = undefined;
    };

    // 1. The first start writes the default and shows the notice, naming both profiles.
    let running = await launch();
    let { page } = running;
    await page.waitFor(`!!${notice}`, 'the notice');
    assert.deepEqual(
      readConfig().profiles.map((p: { id: string; suspendIdleMin: number }) => [
        p.id,
        p.suspendIdleMin,
      ]),
      [
        ['work', 10],
        ['personal', 10],
        ['spare', 0],
      ],
      'the default is written; an explicit Off stays',
    );
    const text = await page.eval<string>(`${notice}.innerText`);
    assert.ok(text.includes(suspendDefaultNotice(['Work', 'Personal'])), text);
    assert.equal(await page.eval(`!!document.querySelector('dialog[open]')`), false, 'no dialog');

    // 2. Settings opens Edit profile › General of the shown profile, at 10 minutes.
    await page.eval(`document.querySelector('[aria-label="Select Personal"]').click()`);
    await sleep(300);
    await clickButtonText(page, 'Settings', notice);
    await page.waitFor(
      `!!document.querySelector('dialog[open] #edit-profile-suspend')`,
      'Edit profile',
    );
    assert.equal(await page.eval(`document.querySelector('#edit-profile-name').value`), 'Personal');
    assert.equal(
      await page.eval(
        `document.querySelector('[data-edit-tab][aria-selected="true"]').dataset.editTab`,
      ),
      'general',
    );
    assert.equal(await page.eval(`document.querySelector('#edit-profile-suspend').value`), '10');
    await page.waitFor(`!${notice}`, 'the notice to go');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');
    await quit(running);

    // 3. Never again: the next start has nothing to change and shows nothing.
    running = await launch();
    ({ page } = running);
    await page.waitFor(`!!document.querySelector('[aria-label="Select Work"]')`, 'the window');
    await sleep(1500);
    assert.equal(await page.eval(`!!${notice}`), false, 'no notice after a restart');
    await quit(running);
    console.log(`e2e suspend notice test passed (${devMode ? 'dev server' : 'production build'})`);
  } finally {
    await (app as RunningApp | undefined)?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e suspend notice test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
