/**
 * End-to-end test of dialogs in a short window (spec §6.17): New workspace in
 * a profile with many projects (Also in) and with a long existing-branch list,
 * and Delete workspace with many linked repositories, keep their title and
 * buttons inside the window and clickable; only the body between them scrolls,
 * and a focused row is scrolled into view. Runs with a throwaway HOME and a
 * fake `claude`.
 *
 *   tsx scripts/e2e-dialogs.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import {
  type Cdp,
  chooseFromNextContextMenu,
  clickLabel,
  launchApp,
  type RunningApp,
  screenshot,
  sleep,
  typeInField,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

/** Projects besides shop: more Also in rows than fit a short window. */
const OTHERS = 14;
/** Branches in shop: a long Existing branch list. */
const BRANCHES = 40;

const dialog = `document.querySelector('dialog[open]')`;
const footerButton = (text: string) =>
  `[...${dialog}.querySelectorAll('[data-modal-footer] button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;

interface Layout {
  innerHeight: number;
  dialogTop: number;
  dialogBottom: number;
  titleTop: number;
  bodyOverflows: boolean;
  /** Per footer button: inside the window, and the element at its center is the button. */
  buttons: Record<string, { inside: boolean; hit: boolean }>;
}

/** Where the open dialog's parts are, and whether its footer buttons can be clicked. */
const layout = (page: Cdp, buttons: string[]) =>
  page.eval<Layout>(`(() => {
    const d = ${dialog};
    const r = d.getBoundingClientRect();
    const body = d.querySelector('[data-modal-body]');
    const out = {
      innerHeight: window.innerHeight,
      dialogTop: r.top,
      dialogBottom: r.bottom,
      titleTop: d.querySelector('h2').getBoundingClientRect().top,
      bodyOverflows: body.scrollHeight > body.clientHeight + 1,
      buttons: {},
    };
    for (const text of ${JSON.stringify(buttons)}) {
      const b = [...d.querySelectorAll('[data-modal-footer] button')].find((x) => x.textContent.includes(text));
      const br = b.getBoundingClientRect();
      const x = br.left + br.width / 2;
      const y = br.top + br.height / 2;
      out.buttons[text] = {
        inside: br.top >= 0 && br.bottom <= window.innerHeight && br.left >= 0 && br.right <= window.innerWidth,
        hit: b.contains(document.elementFromPoint(x, y)),
      };
    }
    return out;
  })()`);

const assertFits = async (page: Cdp, what: string, buttons: string[]) => {
  const l = await layout(page, buttons);
  assert.ok(l.dialogTop >= 0, `${what}: the dialog starts inside the window`);
  assert.ok(
    l.dialogBottom <= l.innerHeight,
    `${what}: the dialog ends inside the window (${l.dialogBottom} > ${l.innerHeight})`,
  );
  assert.ok(l.titleTop >= l.dialogTop, `${what}: the title shows`);
  assert.ok(l.bodyOverflows, `${what}: the content is longer than the window, so its body scrolls`);
  for (const [text, b] of Object.entries(l.buttons)) {
    assert.ok(b.inside, `${what}: ${text} is inside the window`);
    assert.ok(b.hit, `${what}: ${text} can be clicked`);
  }
};

/** A real mouse click at the center of the element. */
async function clickAt(page: Cdp, element: string) {
  const { x, y } = await page.eval<{ x: number; y: number }>(`(() => {
    const r = ${element}.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
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

    const shop = fx.localRepo('shop');
    for (let i = 1; i <= BRANCHES; i++) {
      fx.git(shop, 'branch', `feature/branch-${String(i).padStart(2, '0')}`);
    }
    const others = Array.from({ length: OTHERS }, (_, i) =>
      fx.localRepo(`service-${String(i + 1).padStart(2, '0')}`),
    );
    const configFile = path.join(
      appConfigDir({ platform: process.platform, env: {}, homeDir: fx.root }),
      'config.json',
    );
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const project = (repoPath: string) => ({
      id: path.basename(repoPath),
      profileId: 'work',
      name: path.basename(repoPath),
      repoPath,
      remote: null,
    });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...SEED_CONFIG,
        profiles: SEED_CONFIG.profiles.map((p) => ({
          ...p,
          claude: { command: fakeClaude, args: [] },
        })),
        projects: [project(shop), ...others.map(project)],
      }),
    );

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page, main: mainProcess } = app;
    await page.waitFor(
      `!!document.querySelector('[aria-label="New workspace in shop"]')`,
      'the app',
    );
    const setSize = async (width: number, height: number) => {
      await mainProcess.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(${width}, ${height})`,
      );
      await page.waitFor(
        `window.innerWidth === ${width} && window.innerHeight === ${height}`,
        `the window at ${width}×${height}`,
      );
    };
    const openNewWorkspace = async () => {
      await clickLabel(page, 'New workspace in shop');
      await page.waitFor(`!!${dialog}?.querySelector('[data-also-in]')`, 'New workspace');
    };

    // 1. New workspace with many projects, at a small window and at the
    // minimum size: Create and Cancel stay inside the window and clickable.
    for (const [width, height] of [
      [1024, 640],
      [720, 480],
    ] as const) {
      await setSize(width, height);
      await openNewWorkspace();
      await typeInField(page, '#ws-task', 'PROJ-1 Many repositories', false);
      await assertFits(page, `New workspace at ${width}×${height}`, ['Create', 'Cancel']);
      for (const theme of ['dark', 'light']) {
        await page.eval(`document.documentElement.dataset.theme = '${theme}'`);
        await screenshot(page, screenshotDir, `new-workspace-${width}x${height}-${theme}.png`);
      }
      // A focused Also in row is scrolled into view, inside the list and the body.
      const visible = await page.eval<boolean>(`(() => {
        const rows = [...${dialog}.querySelectorAll('[data-also-in] label:not([data-claude-may-link]) input')];
        const last = rows.at(-1);
        last.focus();
        const r = last.getBoundingClientRect();
        const body = ${dialog}.querySelector('[data-modal-body]').getBoundingClientRect();
        const list = last.closest('label').parentElement.getBoundingClientRect();
        return r.top >= body.top && r.bottom <= body.bottom && r.top >= list.top && r.bottom <= list.bottom;
      })()`);
      assert.equal(visible, true, `the focused last Also in row shows at ${width}×${height}`);
      await assertFits(page, `New workspace at ${width}×${height}, scrolled`, ['Create', 'Cancel']);
      await clickAt(page, footerButton('Cancel'));
      await page.waitFor(`!${dialog}`, `Cancel closes New workspace at ${width}×${height}`);
    }

    // 2. Existing branch, with a long branch list, at the minimum size.
    await openNewWorkspace();
    await page.eval(`document.querySelector('[data-mode=existing]').click()`);
    await page.waitFor(
      `${dialog}.querySelectorAll('[data-branch-list] [data-branch-row]').length >= ${BRANCHES}`,
      'the branch list',
    );
    await assertFits(page, 'Existing branch at 720×480', ['Create', 'Cancel']);
    await screenshot(page, screenshotDir, 'existing-branch-720x480.png');
    await clickAt(page, footerButton('Cancel'));
    await page.waitFor(`!${dialog}`, 'Cancel closes Existing branch');

    // 3. A workspace in every project, made with a real click on Create in a small window.
    await setSize(1024, 640);
    await openNewWorkspace();
    await page.eval(
      `for (const input of ${dialog}.querySelectorAll('[data-also-in] label:not([data-claude-may-link]) input')) if (!input.checked) input.click()`,
    );
    await typeInField(page, '#ws-task', 'PROJ-2 Everywhere', false);
    await sleep(600);
    await page.waitFor(`!${footerButton('Create')}.disabled`, 'Create enabled');
    await clickAt(page, footerButton('Create'));
    await page.waitFor(
      `!${dialog} && document.querySelector('h1')?.textContent === 'Everywhere'`,
      `the workspace in ${OTHERS + 1} repositories`,
      90_000,
    );

    // 4. Delete workspace with a card per repository: Delete and Cancel stay
    // inside the window and clickable, at a small window and the minimum size.
    const openDelete = async () => {
      await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
      await clickLabel(page, 'Workspace menu');
      await page.waitFor(
        `${dialog}?.querySelectorAll('[data-repo-card]').length === ${OTHERS + 1}`,
        'a card per repository',
        30_000,
      );
    };
    for (const [width, height] of [
      [1024, 640],
      [720, 480],
    ] as const) {
      await setSize(width, height);
      await openDelete();
      await assertFits(page, `Delete workspace at ${width}×${height}`, ['Delete', 'Cancel']);
      for (const theme of ['dark', 'light']) {
        await page.eval(`document.documentElement.dataset.theme = '${theme}'`);
        await screenshot(page, screenshotDir, `delete-workspace-${width}x${height}-${theme}.png`);
      }
      await clickAt(page, footerButton('Cancel'));
      await page.waitFor(`!${dialog}`, `Cancel closes Delete workspace at ${width}×${height}`);
    }
    await openDelete();
    await clickAt(page, footerButton('Delete'));
    await page.waitFor(`!${dialog}`, 'deleted', 60_000);
    await page.waitFor(`document.querySelector('h1')?.textContent !== 'Everywhere'`, 'gone');
    for (const repo of [shop, ...others]) {
      const trees = fx.git(repo, 'worktree', 'list').trim().split('\n');
      assert.equal(trees.length, 1, `${path.basename(repo)}'s worktree is gone`);
    }

    console.log(`e2e-dialogs: ok (${devMode ? 'dev server' : 'production build'})`);
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
