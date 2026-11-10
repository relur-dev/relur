/**
 * End-to-end test of the Board grouped by project (spec §6.7): the Group
 * control and its menu, a band per project with workspaces of its own (none
 * for a project without), the bands' headers (count, "↗ n linked in", the
 * + that starts New workspace in the project), a
 * linked workspace shown once with its "+n" chip, the Needs you tint per
 * band, collapse and expand (a band's header, its count row, Expand all and
 * Collapse all), the memory per profile across a restart, the profile's
 * column order and hidden columns applied to the bands (a band whose
 * workspaces are all hidden stays), a header dragged with the bands
 * following, the keyboard (↑↓ across bands, ←→ within one, ↵, Tab), drag to
 * delete and Delete n merged from a band (a dialog opening mid-drag cancels
 * it), the quick reply unfolding and sent from a band, a narrow window (the
 * headers, band names and +s stay in view), and turning it off. Runs with a
 * throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-board-group.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { envVar } from '../src/shared/brand';
import { hint } from '../src/shared/shortcuts';
import {
  type Cdp,
  CMD,
  chooseFromNextContextMenu,
  clickLabel,
  dialogText,
  launchApp,
  openContextMenu,
  pressKey,
  pressShortcut,
  type RunningApp,
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

const card = (id: string) => `document.querySelector('[data-board-card="${id}"]')`;
const lane = (project: string) => `document.querySelector('[data-board-lane="${project}"]')`;
/** The ids of a band's cards in a column, in order. */
const cellIds = (project: string, column: string) =>
  `[...${lane(project)}.querySelectorAll('[data-board-cell=${column}] [data-board-card]')].map((c) => c.dataset.boardCard)`;
/** The bands, top to bottom. */
const lanes = `[...document.querySelectorAll('[data-board-lane]')].map((l) => l.dataset.boardLane)`;
/** A band's columns, left to right. */
const laneColumns = (project: string) =>
  `[...${lane(project)}.querySelectorAll('[data-board-cell], [data-board-lane-cell]')].map((c) => c.dataset.boardCell ?? c.dataset.boardLaneCell)`;
const shown = `[...document.querySelectorAll('[data-board-column]')].map((c) => c.dataset.boardColumn)`;
const activeCard = `(document.activeElement?.dataset?.boardCard ?? null)`;
const grouped = `(document.querySelector('[data-home-board]')?.dataset.boardGrouped ?? null)`;
const groupButton = `document.querySelector('[data-board-group]')`;
const menuOpen = `!!document.querySelector('[data-board-group-menu]')`;
const stored = (key: string) => `localStorage.getItem(${JSON.stringify(key)})`;

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

/** ↵ with its character, as a keyboard sends it: a focused button activates only on that. */
async function pressEnterOn(page: Cdp) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: web } = fx.cloneWithRemote('web', 'main');
    const api = fx.localRepo('api');
    const docs = fx.localRepo('docs');
    const notes = fx.localRepo('notes');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude, as in e2e-board: notes its workspace and worktree,
    // turns typed words into hooks and records every other line typed into it.
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
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1" > /dev/null; }
id="\${${envVar('WORKSPACE_ID')}:-home}"
echo "$PWD" > "$HOME/tree-$id.txt"
hook SessionStart "{\\"session_id\\":\\"$sid\\",\\"transcript_path\\":\\"$transcript\\"}"
echo "fake claude"
esc=$(printf '\\033')
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d "$esc"); line=\${line#\\[200~}; line=\${line%\\[201~}
  case "$line" in
    prompt)
      mkdir -p "$HOME/transcripts"
      echo '{"type":"user","message":{"role":"user","content":"Fix it"}}' >> "$transcript"
      hook UserPromptSubmit '{"prompt":"Fix it"}' ;;
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
          ...(p.id === 'work'
            ? {
                pr: {
                  statusCommand: `cat "$HOME/pr-$${envVar('BRANCH')}" 2>/dev/null || true`,
                },
              }
            : {}),
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
          { id: 'api', profileId: 'work', name: 'api', repoPath: api, remote: null },
          // No workspaces of its own: no band.
          { id: 'docs', profileId: 'work', name: 'docs', repoPath: docs, remote: null },
          { id: 'notes', profileId: 'personal', name: 'notes', repoPath: notes, remote: null },
        ],
      }),
    );
    const file = (name: string) => path.join(fx.root, name);
    const read = (name: string) =>
      fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';
    const launch = () => launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });

    app = await launch();
    let page = app.page;
    const main = () => (app as RunningApp).main;
    await page.waitFor(
      `document.querySelector('[data-board-empty]')?.dataset.boardEmpty === 'no-workspaces'`,
      'No workspaces yet',
    );

    // 1. Workspaces in two of Work's three projects, one in Personal's.
    const ws: Record<string, { id: string; tree: string; branch: string }> = {};
    const create = async (key: string, project: string, task: string) => {
      const before = new Set(fs.readdirSync(fx.root).filter((f) => f.startsWith('tree-')));
      await clickLabel(page, `New workspace in ${project}`);
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(
        `!document.querySelector('dialog[open]')`,
        `the workspace ${task}`,
        30_000,
      );
      let found: string | undefined;
      for (const end = Date.now() + 20_000; !found && Date.now() < end; await sleep(100)) {
        found = fs
          .readdirSync(fx.root)
          .find((f) => f.startsWith('tree-') && f !== 'tree-home.txt' && !before.has(f));
      }
      if (!found) throw new Error(`Claude didn't start in ${task}`);
      const id = found.slice('tree-'.length, -'.txt'.length);
      const tree = (await waitForFile(file(found))).trim();
      ws[key] = { id, tree, branch: fx.git(tree, 'branch', '--show-current').trim() };
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${task}`,
      );
    };
    const id = (key: string) => ws[key]?.id as string;
    const sidebarState = (key: string) =>
      `(document.querySelector('nav [data-nav-key="w:${id(key)}"]')?.title.split('\\n')[1] ?? '')`;
    const waitState = (key: string, state: string) =>
      page.waitFor(`${sidebarState(key)}.startsWith(${JSON.stringify(state)})`, `${key}: ${state}`);

    // web: waiting for input, working, and one to merge.
    await create('wait', 'web', 'ABC-1 Pick a color');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'input');
    await waitState('wait', 'Waiting for input');
    await create('work', 'web', 'ABC-2 Rate limit the login');
    await typeInTerminal(page, 'prompt');
    await waitState('work', 'Working');
    await create('merged', 'web', 'ABC-3 Session banner');
    {
      const tree = ws.merged?.tree as string;
      fs.writeFileSync(path.join(tree, 'banner.txt'), 'x\n');
      fx.git(tree, 'add', '-A');
      fx.git(tree, 'commit', '-q', '-m', 'Add the banner');
      fs.writeFileSync(
        file(`pr-${ws.merged?.branch}`),
        JSON.stringify({ state: 'merged', url: 'https://git.example.com/acme/web/pull/198' }),
      );
    }
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('merged', 'Done');
    // api: a permission request, one to ship, and an idle one linked into web.
    await create('perm', 'api', 'ABC-4 Fix the flaky test');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState('perm', 'Needs permission');
    await create('ship', 'api', 'ABC-5 Dark mode tokens');
    fs.writeFileSync(path.join(ws.ship?.tree as string, 'tokens.css'), ':root {}\n');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('ship', 'Done');
    await create('idle', 'api', 'ABC-6 Pagination');
    await chooseFromNextContextMenu(main(), 'Link another repository…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(`!!document.querySelector('dialog[open] input[name=link-project]')`, 'Link');
    await page.eval(
      `[...document.querySelectorAll('dialog[open] label')].find((l) => l.querySelector('input[name=link-project]') && l.textContent.includes('web')).querySelector('input').click()`,
    );
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'linked web', 30_000);
    await page.waitFor(`document.querySelectorAll('[data-repo-chip]').length === 2`, 'two chips');
    // Personal: one workspace, so its Board shows.
    await clickLabel(page, 'Select Personal');
    await create('note', 'notes', 'ABC-7 Write it down');
    await clickLabel(page, 'Select Work');

    // 2. ⌘0: the Board, not grouped; Group None.
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board');
    assert.equal(await page.eval(grouped), null, 'not grouped by default');
    assert.equal(await page.eval(`${groupButton}.dataset.boardGroup`), 'none');
    assert.match(await page.eval<string>(`${groupButton}.textContent`), /Group\s*None/);
    assert.equal(await page.eval(`document.querySelectorAll('[data-board-lane]').length`), 0);
    // Columns, then Group, left to right.
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('[data-board-columns], [data-board-group], [data-home-layout]')].map((e) => Object.keys(e.dataset)[0])`,
      ),
      ['boardColumns', 'boardGroup'],
    );
    // Its menu: None ticked, Project; nothing to expand or collapse yet.
    await page.eval(`${groupButton}.click()`);
    await page.waitFor(menuOpen, 'the Group menu');
    assert.equal(
      await page.eval(`document.activeElement?.dataset.boardGroupOption`),
      'none',
      'focus on the ticked item',
    );
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('[data-board-group-menu] [role^=menuitem]')].map((b) => b.textContent.trim() + ':' + b.getAttribute('aria-checked'))`,
      ),
      ['✓None:true', 'Project:false'],
    );
    // Esc closes it and gives the button the focus back.
    await pressKey(page, 'Escape');
    await page.waitFor(`!${menuOpen}`, 'the menu closed');
    assert.equal(await page.eval(`document.activeElement === ${groupButton}`), true);
    // ↵ opens it, ↓ and ↵ choose Project.
    await pressEnterOn(page);
    await page.waitFor(menuOpen, 'the Group menu by keyboard');
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(`document.activeElement?.dataset.boardGroupOption`), 'project');
    await pressEnterOn(page);
    await page.waitFor(`${grouped} === 'project'`, 'grouped by project');
    assert.equal(await page.eval(menuOpen), false);
    assert.match(await page.eval<string>(`${groupButton}.textContent`), /Group\s*Project/);
    assert.equal(await page.eval(stored('home-board-group:work')), 'project');

    // 3. A band per project with workspaces of its own, in the projects' order.
    await page.waitFor(
      `${cellIds('api', 'ship')}.length === 1 && ${cellIds('web', 'ship')}.length === 1`,
      'the cards to ship',
      30_000,
    );
    assert.deepEqual(await page.eval(lanes), ['web', 'api'], 'no band for docs');
    const laneHeader = (project: string) =>
      page.eval<string>(`${lane(project)}.querySelector('[data-board-lane-toggle]').textContent`);
    assert.match(await laneHeader('web'), /▾\s*web\s*3 workspaces\s*↗ 1 linked in/);
    assert.match(await laneHeader('api'), /▾\s*api\s*3 workspaces$/);
    // Each band's + starts New workspace in its project, as the sidebar's (spec §6.7).
    const laneNew = (project: string) => `${lane(project)}.querySelector('[data-board-lane-new]')`;
    for (const project of ['web', 'api']) {
      const [label, title] = await page.eval<[string, string]>(
        `[${laneNew(project)}.getAttribute('aria-label'), ${laneNew(project)}.title]`,
      );
      assert.equal(label, `New workspace in ${project}`);
      // Its shortcut as shown on this platform: ⌘N on macOS, Ctrl+Shift+N elsewhere.
      assert.equal(
        title,
        `New workspace in ${project} (${hint('newWorkspace', process.platform === 'darwin')})`,
      );
    }
    await page.eval(`${laneNew('api')}.click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    assert.match(await page.eval<string>(dialogText), /In api · creates a worktree/);
    assert.ok(await page.eval(`!document.querySelector('dialog[open] #ws-project')`), 'no Project');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'New workspace closed');
    // The shared headers: every column with its total; the bands' cells under them.
    assert.deepEqual(await page.eval(shown), ['working', 'idle', 'needs', 'ship', 'merged']);
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('[data-board-column]')].map((c) => c.querySelector('[data-board-count]').textContent)`,
      ),
      ['1', '1', '2', '2', '0'],
    );
    assert.deepEqual(await page.eval(laneColumns('web')), await page.eval(shown));
    assert.deepEqual(await page.eval(cellIds('web', 'needs')), [id('wait')]);
    assert.deepEqual(await page.eval(cellIds('web', 'working')), [id('work')]);
    assert.deepEqual(await page.eval(cellIds('web', 'ship')), [id('merged')]);
    assert.deepEqual(await page.eval(cellIds('api', 'needs')), [id('perm')]);
    assert.deepEqual(await page.eval(cellIds('api', 'idle')), [id('idle')]);
    assert.deepEqual(await page.eval(cellIds('api', 'ship')), [id('ship')]);
    // The linked workspace shows once, in its own project's band, with its chip.
    assert.equal(
      await page.eval(`document.querySelectorAll('${`[data-board-card="${id('idle')}"]`}').length`),
      1,
    );
    assert.deepEqual(
      await page.eval(
        `(() => { const c = ${card(id('idle'))}.querySelector('[data-linked-chip]'); return [c.textContent, c.title]; })()`,
      ),
      ['+1', 'Also in web'],
    );
    // The band names the project, so the cards don't.
    assert.doesNotMatch(await page.eval<string>(`${card(id('perm'))}.innerText`), /^api$/m);
    // Empty cells are plain: no "Nothing here".
    assert.doesNotMatch(
      await page.eval<string>(`document.querySelector('[data-board-grouped]').innerText`),
      /Nothing here/,
    );
    // Needs you's tint: the shared header in the most urgent color, each band's cell in its own.
    const tone = (expression: string) => page.eval(`(${expression}).dataset.boardTone ?? null`);
    assert.equal(await tone(`document.querySelector('[data-board-column=needs]')`), 'permission');
    assert.equal(await tone(`${lane('web')}.querySelector('[data-board-cell=needs]')`), 'input');
    assert.equal(
      await tone(`${lane('api')}.querySelector('[data-board-cell=needs]')`),
      'permission',
    );
    assert.equal(await tone(`${lane('api')}.querySelector('[data-board-cell=idle]')`), null);
    // The quick reply belongs to Needs you in a band too.
    assert.ok(await page.eval(`!!${card(id('wait'))}.querySelector('[data-quick-reply]')`));
    assert.ok(await page.eval(`!!${card(id('perm'))}.querySelector('[data-quick-reply-open]')`));
    await screenshot(page, screenshotDir, 'g1-grouped.png');

    // Pushed from its card, the PR is known merged: it moves to Merged in its band.
    await page.eval(`${card(id('merged'))}.focus()`);
    await page.eval(`${card(id('merged'))}.querySelector('[data-home-action=push]').click()`);
    await page.waitFor(`${cellIds('web', 'merged')}.length === 1`, 'the merged card', 40_000);
    assert.deepEqual(await page.eval(cellIds('web', 'ship')), []);

    // 4. The keyboard: ↑↓ down a column across bands, ←→ within a band.
    await page.eval(`${card(id('wait'))}.focus()`);
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(activeCard), id('perm'), '↓ into the next band');
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(activeCard), id('perm'), 'no further down');
    await pressKey(page, 'ArrowUp');
    assert.equal(await page.eval(activeCard), id('wait'), '↑ back');
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('merged'), '→ past the empty cell');
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('merged'), 'nothing further right in the band');
    await page.eval(`${card(id('perm'))}.focus()`);
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('ship'));
    await pressKey(page, 'ArrowLeft');
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(activeCard), id('idle'));
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(activeCard), id('idle'), 'nothing further left in the band');
    // Tab reaches the card's field; ↵ on a card opens its workspace.
    await page.eval(`${card(id('wait'))}.focus()`);
    await pressKey(page, 'Tab');
    assert.equal(
      await page.eval(`document.activeElement?.hasAttribute('data-quick-reply')`),
      true,
      'Tab to the field',
    );
    await page.eval(`${card(id('idle'))}.focus()`);
    await pressKey(page, 'Enter');
    await page.waitFor(`!document.querySelector('[data-home-board]')`, 'the workspace opened');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`${grouped} === 'project'`, 'back on the grouped Board');

    // 8. The quick reply in a band: it unfolds, the band below moves, ↵ sends it.
    const apiTop = () => page.eval<number>(`${lane('api')}.getBoundingClientRect().top`);
    const before = await apiTop();
    await page.eval(`${card(id('work'))}.focus()`);
    await page.waitFor(
      `[...${card(id('work'))}.querySelectorAll('[data-board-unfold]')].every((u) => u.getBoundingClientRect().height > 20)`,
      'the card unfolded',
    );
    assert.ok((await apiTop()) > before + 20, 'the band below moved down');
    await typeInField(page, `[data-board-card="${id('work')}"] [data-quick-reply]`, 'Add a test');
    await page.waitFor(
      `!!${card(id('work'))}.querySelector('[data-quick-reply-sent]')`,
      'Sent to Claude',
    );
    assert.match(
      await page.eval<string>(
        `${card(id('work'))}.querySelector('[data-quick-reply-sent]').textContent`,
      ),
      /Sent · Claude reads it after this step/,
    );
    for (
      const end = Date.now() + 20_000;
      !read(`input-${id('work')}.txt`).includes('Add a test');
    ) {
      if (Date.now() > end) throw new Error('the reply never reached Claude');
      await sleep(100);
    }

    // 5. Collapse and expand: a band's header, its count row, the menu.
    await page.eval(`${lane('web')}.querySelector('[data-board-lane-toggle]').click()`);
    await page.waitFor(`${lane('web')}.dataset.boardLaneOpen === 'false'`, 'web collapsed');
    assert.match(await laneHeader('web'), /^▸/);
    assert.equal(
      await page.eval(`${lane('web')}.querySelector('[data-board-lane-toggle]').title`),
      'Expand web',
    );
    assert.equal(await page.eval(`${lane('web')}.querySelectorAll('[data-board-card]').length`), 0);
    assert.deepEqual(
      await page.eval(
        `[...${lane('web')}.querySelectorAll('[data-board-lane-cell]')].map((c) => c.title + '=' + c.textContent)`,
      ),
      [
        'web · Working: 1=1',
        'web · Idle: 0=–',
        'web · Needs you: 1=1',
        'web · Ready to ship: 0=–',
        'web · Merged: 1=1',
      ],
    );
    assert.ok(
      await page.eval(
        `${lane('web')}.querySelector('[data-board-lane-cell=needs] span').classList.contains('text-st-input')`,
      ),
      "the Needs you count in the band's color",
    );
    assert.equal(await page.eval(stored('home-board-lanes:work')), '["web"]');
    // ↓ skips a collapsed band.
    await page.eval(`${card(id('perm'))}.focus()`);
    await pressKey(page, 'ArrowUp');
    assert.equal(await page.eval(activeCard), id('perm'), 'nothing above in an open band');
    await screenshot(page, screenshotDir, 'g2-collapsed.png');
    // A click on the count row expands it.
    const counts = await centre(
      page,
      `${lane('web')}.querySelector('[data-board-lane-cell=idle]')`,
    );
    await mouse(page, 'mousePressed', counts.x, counts.y);
    await mouse(page, 'mouseReleased', counts.x, counts.y);
    await page.waitFor(`${lane('web')}.dataset.boardLaneOpen === 'true'`, 'web expanded');
    assert.equal(await page.eval(stored('home-board-lanes:work')), null, 'none stored as nothing');
    // Collapse all and Expand all, each off when it would change nothing.
    const menuItem = (attr: string) =>
      `document.querySelector('[data-board-group-menu] [${attr}]')`;
    await page.eval(`${groupButton}.click()`);
    await page.waitFor(menuOpen, 'the menu');
    assert.equal(await page.eval(`${menuItem('data-board-group-expand')}.disabled`), true);
    assert.equal(await page.eval(`${menuItem('data-board-group-collapse')}.disabled`), false);
    await page.eval(`${menuItem('data-board-group-collapse')}.click()`);
    await page.waitFor(
      `[...document.querySelectorAll('[data-board-lane]')].every((l) => l.dataset.boardLaneOpen === 'false')`,
      'all collapsed',
    );
    assert.equal(await page.eval(`document.activeElement === ${groupButton}`), true);
    await page.eval(`${groupButton}.click()`);
    await page.waitFor(menuOpen, 'the menu');
    assert.equal(await page.eval(`${menuItem('data-board-group-collapse')}.disabled`), true);
    assert.equal(await page.eval(`${menuItem('data-board-group-expand')}.disabled`), false);
    await pressKey(page, 'Escape');
    // Personal isn't grouped.
    await clickLabel(page, 'Select Personal');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, "Personal's Board");
    assert.equal(await page.eval(grouped), null, 'Personal not grouped');
    await clickLabel(page, 'Select Work');

    // 6. Remembered per profile across a restart: grouped, both bands collapsed.
    await app.stop();
    app = await launch();
    page = app.page;
    await page.waitFor(
      `!!document.querySelector('[data-home-board]')`,
      'the Board after a restart',
    );
    // ABC-2 was working and ABC-4 asking for permission at the quit: once their
    // Claude has resumed, the start asks about them (spec §9.7). Not now, so
    // nothing covers the Board, however long the resume takes.
    await page.waitFor(
      `${dialogText}.includes("Claude didn't finish in 2 workspaces")`,
      'the unfinished overview',
      30_000,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Not now');
    await page.waitFor(`${grouped} === 'project'`, 'still grouped');
    await page.waitFor(`${lanes}.join() === 'web,api'`, 'the bands');
    assert.equal(
      await page.eval(`document.querySelectorAll('[data-board-lane-open=false]').length`),
      2,
      'both still collapsed',
    );
    await clickLabel(page, 'Select Personal');
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, "Personal's Board");
    assert.equal(await page.eval(grouped), null, 'Personal still not grouped');
    await clickLabel(page, 'Select Work');
    await page.waitFor(`${grouped} === 'project'`, "Work's Board");
    await page.eval(`${groupButton}.click()`);
    await page.waitFor(menuOpen, 'the menu');
    await page.eval(`${menuItem('data-board-group-expand')}.click()`);
    await page.waitFor(
      `document.querySelectorAll('[data-board-lane-open=true]').length === 2`,
      'all expanded',
    );

    // 7. The profile's columns: the bands follow its order and hidden columns.
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    const box = (column: string) =>
      `document.querySelector('[data-board-columns-option=${column}] input')`;
    await page.waitFor(`!!${box('idle')}`, 'the Columns panel');
    await page.eval(`${box('idle')}.click()`);
    await page.waitFor(`${shown}.join() === 'working,needs,ship,merged'`, 'Idle hidden');
    assert.deepEqual(await page.eval(laneColumns('api')), ['working', 'needs', 'ship', 'merged']);
    assert.equal(await page.eval(`!!${card(id('idle'))}`), false, 'its card hidden');
    assert.match(await laneHeader('api'), /3 workspaces/, 'the count keeps every workspace');
    // All of api's columns hidden: its band stays, empty, with its full count.
    await page.eval(`${box('needs')}.click()`);
    await page.eval(`${box('ship')}.click()`);
    await page.waitFor(
      `${shown}.join() === 'working,merged'`,
      'Needs you and Ready to ship hidden',
    );
    assert.deepEqual(await page.eval(lanes), ['web', 'api']);
    assert.equal(await page.eval(`${lane('api')}.querySelectorAll('[data-board-card]').length`), 0);
    assert.deepEqual(await page.eval(laneColumns('api')), ['working', 'merged']);
    assert.match(await laneHeader('api'), /3 workspaces/);
    // The mark for a hidden Needs you stays on Columns (after the restart the
    // waiting workspaces are Unfinished, so in the input color).
    assert.ok(
      await page.eval(`!!document.querySelector('[data-board-columns-mark]')`),
      'the mark for a hidden Needs you',
    );
    await page.eval(`document.querySelector('[data-board-columns-reset]').click()`);
    await page.waitFor(`${shown}.join() === 'working,idle,needs,ship,merged'`, 'Reset');
    await pressKey(page, 'Escape');
    // Move Left from a header's menu: the bands' cells follow.
    await chooseFromNextContextMenu(app.main, 'Move Left');
    await openContextMenu(page, '[data-board-column=needs] [data-board-column-header]');
    await page.waitFor(
      `${shown}.join() === 'working,needs,idle,ship,merged'`,
      'Needs you moved left',
    );
    assert.deepEqual(await page.eval(laneColumns('web')), await page.eval(shown));
    // ← → follow the shown order within the band.
    await page.eval(`${card(id('perm'))}.focus()`);
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('idle'));
    // Drag Merged's header in front of Working: the line spans the bands; the bands follow.
    const from = await centre(page, `document.querySelector('[data-board-column=merged] h2')`);
    const target = await page.eval<number>(
      `document.querySelector('[data-board-column=working]').getBoundingClientRect().left + 20`,
    );
    await mouse(page, 'mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) {
      await mouse(page, 'mouseMoved', Math.round(from.x + ((target - from.x) * i) / 8), from.y);
    }
    await page.waitFor(`!!document.querySelector('[data-board-column-drop]')`, 'the drop line');
    assert.ok(
      await page.eval(`(() => {
        const line = document.querySelector('[data-board-column-drop]').getBoundingClientRect();
        const last = document.querySelector('[data-board-lane="api"]').getBoundingClientRect();
        const first = document.querySelector('[data-board-column=working]').getBoundingClientRect();
        return line.top <= first.top + 1 && line.bottom >= last.bottom - 1 && Math.abs(line.left - (first.left - 7)) <= 2;
      })()`),
      'the line in front of Working, across the bands',
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-board-float]')`), false);
    await mouse(page, 'mouseReleased', target, from.y);
    await page.waitFor(`${shown}[0] === 'merged'`, 'Merged moved first');
    assert.deepEqual(await page.eval(laneColumns('api')), await page.eval(shown));
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-reset]')`, 'the panel');
    await page.eval(`document.querySelector('[data-board-columns-reset]').click()`);
    await page.waitFor(`${shown}.join() === 'working,idle,needs,ship,merged'`, 'Reset again');
    await pressKey(page, 'Escape');

    // 9. Delete n merged in the shared header; drag to delete from a band.
    await page.eval(`document.querySelector('[data-home-action=delete-merged]').click()`);
    await page.waitFor(`${dialogText}.includes('Delete 1 merged')`, 'Delete n merged');
    assert.match(await page.eval<string>(dialogText), /ABC-3/);
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog closed');
    const lifted = await centre(page, card(id('ship')));
    await mouse(page, 'mousePressed', lifted.x, lifted.y);
    for (let i = 1; i <= 4; i++)
      await mouse(page, 'mouseMoved', lifted.x + i * 5, lifted.y + i * 5);
    await page.waitFor(`!!document.querySelector('[data-board-float]')`, 'the lifted card');
    const zone = await centre(page, `document.querySelector('[data-drop-zone]')`);
    await mouse(page, 'mouseMoved', zone.x, zone.y);
    await page.waitFor(
      `document.querySelector('[data-drop-zone]').dataset.dropZone === 'over'`,
      'over the zone',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-drop-zone]').textContent`),
      /Release to delete ABC-5/,
    );
    await screenshot(page, screenshotDir, 'g3-drag.png');
    await mouse(page, 'mouseReleased', zone.x, zone.y);
    await page.waitFor(`${dialogText}.includes('ABC-5')`, 'Delete workspace');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'cancelled');
    assert.ok(await page.eval(`!!${card(id('ship'))}`), 'nothing deleted');
    // A dialog that opens during the drag (here ⌘N) cancels it: the drop
    // opens nothing over it.
    await mouse(page, 'mousePressed', lifted.x, lifted.y);
    for (let i = 1; i <= 4; i++)
      await mouse(page, 'mouseMoved', lifted.x + i * 5, lifted.y + i * 5);
    await page.waitFor(`!!document.querySelector('[data-board-float]')`, 'lifted again');
    await mouse(page, 'mouseMoved', zone.x, zone.y);
    await page.waitFor(
      `document.querySelector('[data-drop-zone]')?.dataset.dropZone === 'over'`,
      'over the zone again',
    );
    await pressShortcut(page, 'newWorkspace');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    await mouse(page, 'mouseMoved', zone.x + 5, zone.y);
    await mouse(page, 'mouseReleased', zone.x + 5, zone.y);
    await sleep(300);
    assert.equal(await page.eval(`document.querySelectorAll('dialog[open]').length`), 1);
    assert.ok(await page.eval(`!!document.querySelector('dialog[open] #ws-task')`));
    assert.equal(await page.eval(`!!document.querySelector('[data-board-float]')`), false);
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'New workspace closed');
    // Released without a move in between: still nothing.
    await mouse(page, 'mousePressed', lifted.x, lifted.y);
    for (let i = 1; i <= 4; i++)
      await mouse(page, 'mouseMoved', lifted.x + i * 5, lifted.y + i * 5);
    await page.waitFor(`!!document.querySelector('[data-board-float]')`, 'lifted a third time');
    await mouse(page, 'mouseMoved', zone.x, zone.y);
    await page.waitFor(
      `document.querySelector('[data-drop-zone]')?.dataset.dropZone === 'over'`,
      'over the zone a third time',
    );
    await pressShortcut(page, 'newWorkspace');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    await mouse(page, 'mouseReleased', zone.x, zone.y);
    await sleep(300);
    assert.equal(await page.eval(`document.querySelectorAll('dialog[open]').length`), 1);
    assert.ok(await page.eval(`!!document.querySelector('dialog[open] #ws-task')`));
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'New workspace closed again');
    assert.equal(await page.eval(`!!document.querySelector('[data-board-float]')`), false);
    assert.ok(await page.eval(`!!${card(id('ship'))}`), 'still nothing deleted');

    // 10. A narrow window: the headers stay on top, the bands' names at the left.
    const setSize = (width: number, height: number) =>
      (app as RunningApp).main.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setSize(${width}, ${height})`,
      );
    await setSize(900, 520);
    const scroller = `document.querySelector('[data-board-headers]').parentElement.parentElement`;
    await page.waitFor(
      `${scroller}.scrollWidth > ${scroller}.clientWidth && ${scroller}.scrollHeight > ${scroller}.clientHeight`,
      'the Board scrolling both ways',
    );
    await page.eval(`${scroller}.scrollTo(${scroller}.scrollWidth, ${scroller}.scrollHeight)`);
    await sleep(200);
    assert.ok(
      await page.eval(`(() => {
        const s = ${scroller}.getBoundingClientRect();
        const h = document.querySelector('[data-board-headers]').getBoundingClientRect();
        const name = ${lane('api')}.querySelector('[data-board-lane-toggle]').getBoundingClientRect();
        return Math.abs(h.top - s.top) <= 1 && name.left >= s.left && name.left <= s.left + 30;
      })()`),
      'the headers and the band name in view',
    );
    // The band's + stays beside its name; the sidebar's +s stay shown, in their rows.
    assert.ok(
      await page.eval(`(() => {
        const s = ${scroller}.getBoundingClientRect();
        const plus = ${laneNew('api')}.getBoundingClientRect();
        return plus.left >= s.left && plus.right <= s.right;
      })()`),
      'the band’s + in view',
    );
    assert.ok(
      await page.eval(
        `[...document.querySelectorAll('[data-project]')].every((r) => { const b = r.lastElementChild; const box = b.getBoundingClientRect(); const row = r.getBoundingClientRect(); return b.getAttribute('aria-label')?.startsWith('New workspace in ') && getComputedStyle(b).opacity === '1' && box.width > 0 && box.right <= row.right; })`,
      ),
      'every sidebar + shown, at the end of its row',
    );
    assert.ok(
      await page.eval(
        `[...document.querySelectorAll('[data-board-column]')].every((c) => c.getBoundingClientRect().width >= 219)`,
      ),
      'columns at least 220 px',
    );
    await screenshot(page, screenshotDir, 'g4-narrow.png');
    await setSize(1440, 900);

    // 11. Turned off: the columns as before, and nothing stored.
    await page.eval(`${groupButton}.click()`);
    await page.waitFor(menuOpen, 'the menu');
    await page.eval(`document.querySelector('[data-board-group-option=none]').click()`);
    await page.waitFor(`${grouped} === null`, 'not grouped');
    assert.equal(await page.eval(`document.querySelectorAll('[data-board-lane]').length`), 0);
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('[data-board-column=needs] [data-board-card]')].length`,
      ),
      2,
    );
    assert.equal(await page.eval(stored('home-board-group:work')), null);

    console.log('e2e-board-group: ok');
  } catch (error) {
    const shownText = await app?.page.eval<string>(`document.body.innerText`).catch(() => '');
    console.error(`The window showed:\n${shownText?.slice(0, 2000)}`);
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
