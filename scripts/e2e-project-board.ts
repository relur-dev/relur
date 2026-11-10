/**
 * End-to-end test of a project's Board (spec §6.10): the Workspaces tab shows
 * the project's workspaces and those linked into it (marked, and counted
 * apart in the tab), each card with its branch where Home's show the
 * project, its details behind the ⓘ (by click and by keyboard) without it; Columns and no Group, the column layout
 * shared with Home (hidden here, hidden there, and Reset there shows it here
 * again); the quick reply, ↵ on a card, drag to delete (Esc, then the
 * zone and the Delete workspace dialog) and ⌫ on a focused card; the
 * empty state with New workspace in that project; and Other worktrees as a
 * folded strip under the Board. Runs with a throwaway HOME and a fake
 * `claude`.
 *
 *   tsx scripts/e2e-project-board.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  CMD,
  clickLabel,
  dialogText,
  launchApp,
  pressKey,
  type RunningApp,
  readCardDetails,
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

/** A card in the main area by workspace id, as an expression. */
const card = (id: string) => `document.querySelector('main [data-board-card="${id}"]')`;
const cards = `[...document.querySelectorAll('main [data-board-card]')].map((c) => c.dataset.boardCard).sort()`;
const shown = `[...document.querySelectorAll('main [data-board-column]')].map((c) => c.dataset.boardColumn)`;
const DEFAULT_ORDER = ['working', 'idle', 'needs', 'ship', 'merged'];

/** The middle of an element, in the window's coordinates. */
const centre = (page: Cdp, expression: string) =>
  page.eval<{ x: number; y: number }>(`(() => {
    const r = (${expression}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

async function mouse(
  page: Cdp,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
) {
  await page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: web } = fx.cloneWithRemote('web', 'main');
    const lib = fx.localRepo('lib');
    const api = fx.localRepo('api');
    // A worktree of web made by hand: Other worktrees (spec §13.6).
    fx.git(web, 'worktree', 'add', '-q', '-b', 'by-hand', path.join(fx.root, 'by-hand'));
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, runs SessionStart, notes
    // its workspace and worktree, turns typed words into hooks and records
    // every other line typed into it (a quick reply comes as a paste).
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
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1" > /dev/null; }
id="\${${envVar('WORKSPACE_ID')}:-home}"
echo "$PWD" > "$HOME/tree-$id.txt"
hook SessionStart "{\\"session_id\\":\\"$sid\\"}"
esc=$(printf '\\033')
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d "$esc"); line=\${line#\\[200~}; line=\${line%\\[201~}
  case "$line" in
    prompt) hook UserPromptSubmit '{"prompt":"Fix the login"}' ;;
    permission) hook Notification '{"message":"Claude needs your permission to use Bash"}' ;;
    input) hook Notification '{"notification_type":"idle_prompt","message":"Claude is waiting for your input"}' ;;
    stop) hook Stop '{"last_assistant_message":"Done."}' ;;
    *) printf '%s\\n' "$line" >> "$HOME/input-$id.txt" ;;
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
          // Suspension on, never reached here: the cards' details say why or when (spec §9.8).
          ...(p.id === 'work' ? { suspendIdleMin: 30 as const } : {}),
        })),
        projects: [
          {
            id: 'web',
            profileId: 'work',
            name: 'web',
            repoPath: web,
            remote: 'origin',
            baseBranch: 'main',
          },
          { id: 'lib', profileId: 'work', name: 'lib', repoPath: lib, remote: null },
          { id: 'api', profileId: 'work', name: 'api', repoPath: api, remote: null },
        ],
      }),
    );

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page } = app;
    await page.waitFor(`!!document.querySelector('[data-board-empty]')`, 'Home');

    // 1. Workspaces: two in web, one in lib linked into web.
    const ws: Record<string, { id: string; tree: string; branch: string }> = {};
    const create = async (key: string, project: string, task: string, alsoIn: string[] = []) => {
      const before = new Set(fs.readdirSync(fx.root).filter((f) => f.startsWith('tree-')));
      await clickLabel(page, `New workspace in ${project}`);
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      for (const name of alsoIn) {
        await page.eval(
          `[...document.querySelectorAll('[data-also-in] label')].find((l) => l.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`,
        );
      }
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(
        `!document.querySelector('dialog[open]')`,
        `the workspace ${task}`,
        30_000,
      );
      let file: string | undefined;
      for (const end = Date.now() + 20_000; !file && Date.now() < end; await sleep(100)) {
        file = fs.readdirSync(fx.root).find((f) => f.startsWith('tree-') && !before.has(f));
      }
      if (!file) throw new Error(`Claude didn't start in ${task}`);
      const id = file.slice('tree-'.length, -'.txt'.length);
      const tree = (await waitForFile(path.join(fx.root, file))).trim();
      ws[key] = { id, tree, branch: fx.git(tree, 'branch', '--show-current').trim() };
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${task}`,
      );
    };
    const id = (key: string) => ws[key]?.id as string;
    const waitState = (key: string, state: string) =>
      page.waitFor(
        `(document.querySelector('nav [data-nav-key="w:${id(key)}"]')?.title.split('\\n')[1] ?? '').startsWith(${JSON.stringify(state)})`,
        `${key}: ${state}`,
      );
    await create('waiting', 'web', 'ABC-1 Pick a color');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'input');
    await waitState('waiting', 'Waiting for input');
    await create('perm', 'web', 'ABC-2 Fix the flaky test');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState('perm', 'Needs permission');
    await create('linked', 'lib', 'ABC-3 Shared search', ['web']);
    await typeInTerminal(page, 'stop');
    await waitState('linked', 'Done');

    // 2. web's view: its own two and the linked one, on the Board.
    const showProject = async (project: string) => {
      await page.eval(
        `document.querySelector('[data-nav-key="p:${project}"] [data-nav-focus]').click()`,
      );
      await page.waitFor(
        `document.querySelector('main h1')?.textContent === ${JSON.stringify(project)}`,
        `the ${project} view`,
      );
    };
    await showProject('web');
    await page.waitFor(
      `${cards}.join() === ${JSON.stringify([id('waiting'), id('perm'), id('linked')].sort().join())}`,
      "web's cards with the linked one",
    );
    assert.equal(
      await page.eval(`!!document.querySelector('[data-workspace-row], [data-home-board]')`),
      false,
      "no table, and the project's Board",
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-project-board]')`), true);
    // The tab counts its own and, apart, those linked in.
    assert.match(
      await page.eval<string>(
        `document.querySelector('main [role=tab][aria-selected=true]').innerText`,
      ),
      /^Workspaces\s*2\s*\+ 1 linked$/,
    );
    // Cards show the branch where Home's show the project; the details leave it out.
    const waitingText = await page.eval<string>(`${card(id('waiting'))}.innerText`);
    assert.ok(waitingText.includes(ws.waiting?.branch as string), 'the branch on the card');
    const waitingTip = await readCardDetails(page, card(id('waiting')));
    assert.match(waitingTip, /^ABC-1 Pick a color\n/);
    assert.doesNotMatch(waitingTip, /\nBranch: /);
    assert.match(waitingTip, /\nClaude is waiting for your input\n/);
    // The details by a click on the ⓘ (spec §6.7): pinned, with the suspension
    // line, and the workspace stays closed; a click outside closes them.
    const info = `${card(id('waiting'))}.querySelector('[data-card-info]')`;
    const details = `document.querySelector('[data-card-details]')`;
    const stillHere = async (what: string) => {
      await sleep(300);
      assert.ok(await page.eval(`!!document.querySelector('[data-project-board]')`), what);
      assert.ok(
        await page.eval(`!document.querySelector('[data-board-float]')`),
        `${what}: no drag`,
      );
    };
    assert.equal(await page.eval(`${card(id('waiting'))}.title`), '', 'no tooltip on the card');
    assert.equal(await page.eval(`${info}.getAttribute('aria-label')`), 'Details for ABC-1');
    await page.waitFor(
      `!!${card(id('waiting'))}.dataset.suspendNote`,
      "the waiting workspace's suspension note",
      20_000,
    );
    const infoAt = await centre(page, info);
    await mouse(page, 'mousePressed', infoAt.x, infoAt.y);
    await mouse(page, 'mouseReleased', infoAt.x, infoAt.y);
    await page.waitFor(
      `${details}?.dataset.cardDetailsPinned === 'true'`,
      'the details by a click',
    );
    await stillHere('a click on the ⓘ opens no workspace');
    const clicked = await page.eval<string>(`${details}.innerText`);
    assert.match(clicked, /^ABC-1 Pick a color\n/);
    assert.match(clicked, /\nActive (just now|\d+[smh] ago)\n/);
    const suspendLine = await page.eval<string>(
      `${details}.querySelector('[data-card-detail=suspend]')?.textContent ?? ''`,
    );
    assert.match(suspendLine, /^(Not suspended: .+|Suspended in \d+ min if it stays idle)$/);
    const outside = await centre(
      page,
      `document.querySelector('main [data-board-column=idle] h2')`,
    );
    await mouse(page, 'mousePressed', outside.x, outside.y);
    await mouse(page, 'mouseReleased', outside.x, outside.y);
    await page.waitFor(`!${details}`, 'the details closed by a click outside');
    await stillHere('a click outside opens nothing');
    // By the keyboard: Tab from the card to the ⓘ, ↵ opens, Esc closes and gives the ⓘ focus.
    await page.eval(`${card(id('waiting'))}.focus()`);
    await pressKey(page, 'Tab');
    assert.equal(await page.eval(`document.activeElement === ${info}`), true, 'Tab reaches the ⓘ');
    const enter = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...enter });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
    await page.waitFor(`document.activeElement === ${details}`, 'the details by ↵, in focus');
    await stillHere('↵ on the ⓘ opens no workspace');
    assert.equal(
      await page.eval(`${details}.querySelector('[data-card-detail=suspend]')?.textContent`),
      suspendLine,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!${details}`, 'the details closed by Esc');
    assert.equal(
      await page.eval(`document.activeElement === ${info}`),
      true,
      'focus back on the ⓘ',
    );
    await page.eval(`document.activeElement?.blur()`);
    // The linked one: marked with its own project, in the chip and the details.
    assert.equal(
      await page.eval(`${card(id('linked'))}.querySelector('[data-linked-from]')?.textContent`),
      '↗ lib',
    );
    assert.match(await readCardDetails(page, card(id('linked'))), /\nLinked in from lib\n/);
    assert.equal(
      await page.eval(`${card(id('waiting'))}.querySelector('[data-linked-from]')`),
      null,
    );
    // Columns, never Group; the profile's columns.
    assert.equal(await page.eval(`!!document.querySelector('main [data-board-columns]')`), true);
    assert.equal(await page.eval(`!!document.querySelector('[data-board-group]')`), false);
    assert.deepEqual(await page.eval(shown), DEFAULT_ORDER);
    // Other worktrees: a folded strip under the Board, opened by a click.
    await page.waitFor(
      `document.querySelector('[data-other-worktrees]')?.dataset.otherWorktrees === 'folded'`,
      'Other worktrees, folded',
      20_000,
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-other-worktrees]').innerText`),
      /Other worktrees\s*1/,
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-other-worktree]')`), false);
    await page.eval(`document.querySelector('[data-other-worktrees-toggle]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-other-worktree="by-hand"]')`,
      'the by-hand worktree',
    );
    assert.match(
      await page.eval<string>(
        `document.querySelector('[data-other-worktree="by-hand"]').innerText`,
      ),
      /Open as workspace/,
    );
    await screenshot(page, screenshotDir, 'p1-project-board.png');

    // In lib's view the linked one is its own: no mark, no linked count.
    await showProject('lib');
    await page.waitFor(`${cards}.join() === ${JSON.stringify(id('linked'))}`, "lib's card");
    assert.equal(
      await page.eval(`${card(id('linked'))}.querySelector('[data-linked-from]')`),
      null,
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-linked-in-count]')`), false);

    // 3. One column layout for the profile: Idle hidden here is hidden on Home.
    await showProject('web');
    await page.waitFor(`${cards}.length === 3`, "web's cards");
    await page.eval(`document.querySelector('main [data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-panel]')`, 'the panel');
    await page.eval(`document.querySelector('[data-board-columns-option=idle] input').click()`);
    await page.waitFor(`${shown}.join() === 'working,needs,ship,merged'`, 'Idle hidden');
    await pressKey(page, 'Escape');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(
      `!!document.querySelector('[data-home-board]') && ![...document.querySelectorAll('[data-board-column]')].some((c) => c.dataset.boardColumn === 'idle')`,
      'Idle hidden on Home too',
    );
    // Reset on Home shows it in the project's view again.
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-panel]')`, 'the panel');
    await page.eval(`document.querySelector('[data-board-columns-reset]').click()`);
    await pressKey(page, 'Escape');
    await showProject('web');
    await page.waitFor(
      `${shown}.join() === ${JSON.stringify(DEFAULT_ORDER.join())}`,
      'the default columns in the project',
    );

    // 4. The quick reply: sent to the waiting workspace's Claude.
    const field = `${card(id('waiting'))}.querySelector('[data-quick-reply]')`;
    await page.waitFor(`!!${field}`, 'the quick reply');
    await page.eval(`${field}.focus()`);
    await page.send('Input.insertText', { text: 'Use the brand blue' });
    await pressKey(page, 'Enter');
    assert.match(
      await waitForFile(path.join(fx.root, `input-${id('waiting')}.txt`), {
        until: /Use the brand blue/,
      }),
      /Use the brand blue/,
    );
    await page.waitFor(
      `!!${card(id('waiting'))}?.querySelector('[data-quick-reply-sent]')`,
      'Sent to Claude',
    );

    // 5. Drag to delete: Esc cancels; dropped on the zone, Delete workspace.
    const lift = async () => {
      const from = await centre(page, card(id('perm')));
      await mouse(page, 'mousePressed', from.x, from.y);
      for (let i = 1; i <= 4; i++) await mouse(page, 'mouseMoved', from.x + i * 5, from.y + i * 5);
      await page.waitFor(`!!document.querySelector('[data-board-float]')`, 'the lifted card');
    };
    await lift();
    await page.waitFor(`!!document.querySelector('[data-drop-zone]')`, 'the zone');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-drop-zone]')`, 'the drag cancelled');
    await mouse(page, 'mouseReleased', 0, 0);
    await lift();
    const zone = await centre(page, `document.querySelector('[data-drop-zone]')`);
    await mouse(page, 'mouseMoved', zone.x, zone.y);
    await page.waitFor(
      `document.querySelector('[data-drop-zone]')?.dataset.dropZone === 'over'`,
      'over the zone',
    );
    await mouse(page, 'mouseReleased', zone.x, zone.y);
    await page.waitFor(`${dialogText}.includes('Delete ABC-2 Fix the flaky test?')`, 'Delete');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    // ⌫ on a focused card opens it too. The closed dialog gives focus back
    // first, so the card is focused once that has happened.
    await sleep(300);
    await page.eval(`${card(id('perm'))}.focus()`);
    await page.waitFor(`document.activeElement === ${card(id('perm'))}`, 'the card in focus');
    await pressKey(page, 'Backspace');
    await page.waitFor(`${dialogText}.includes('Delete ABC-2 Fix the flaky test?')`, 'Delete');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');

    // 6. ↵ on a card opens its workspace.
    await page.eval(`${card(id('linked'))}.focus()`);
    await pressKey(page, 'Enter');
    await page.waitFor(
      `document.querySelector('nav [data-nav-key="w:${id('linked')}"]')?.getAttribute('aria-current') === 'true'`,
      'the linked workspace',
    );

    // 7. A project without workspaces: New workspace, in that project.
    await showProject('api');
    await page.waitFor(
      `document.querySelector('main [data-board-empty]')?.dataset.boardEmpty === 'no-workspaces'`,
      'No workspaces yet',
    );
    assert.equal(await page.eval(`!!document.querySelector('main [data-board-columns]')`), false);
    await page.eval(`document.querySelector('[data-home-action=new-first-workspace]').click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    assert.match(await page.eval<string>(dialogText), /\bapi\b/);
    await screenshot(page, screenshotDir, 'p2-empty.png');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');

    console.log(`e2e project board test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) {
      const text = await app.page
        .eval<string>(`document.querySelector('#root')?.innerText.slice(0, 2500) ?? ''`)
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
  console.error(`e2e project board test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
