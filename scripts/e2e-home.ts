/**
 * End-to-end test of Home (spec §6.7): its Overview and Terminal tabs. The
 * quick actions, the empty states (no workspaces with New workspace, Add your
 * first project), the Board's columns with the cards' actions (Open, Review
 * and a gate's answer, Commit…, Push, View PR, Delete and Delete n merged),
 * Create PR and Create PRs… for repositories without a PR, View PRs with
 * several, the cards' tooltips, ↵ on a card, and the Terminal tab (⌃1 ⌃2, ⌘L,
 * ⌘0). The Board's own behaviour is covered by e2e-board, Unfinished cards by
 * e2e-continue. Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-home.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  CMD,
  chooseFromNextContextMenu,
  clickButtonText,
  clickLabel,
  dialogText,
  launchApp,
  MOD,
  pressKey,
  pressShortcut,
  type RunningApp,
  readCardDetails,
  screenshot,
  sleep,
  submitDialog,
  typeInField,
  typeInTerminal,
  waitForCardDetails,
  waitForFile,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');
const isMac = process.platform === 'darwin';

/** A Board card by workspace id, as an expression. */
const homeRow = (id: string) => `document.querySelector('[data-board-card="${id}"]')`;
/** The ids of a column's cards, in order, as an expression. */
const sectionIds = (column: string) =>
  `[...document.querySelectorAll('[data-board-column=${column}] [data-board-card]')].map((r) => r.dataset.boardCard)`;
/** The column a card is in, as an expression. */
const columnOf = (id: string) =>
  `(${homeRow(id)}?.closest('[data-board-column]')?.dataset.boardColumn ?? null)`;
const hasNoThanks = `[...document.querySelectorAll('button')].some((b) => b.textContent === 'No thanks')`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { origin, clone: web } = fx.cloneWithRemote('web', 'main');
    const api = fx.localRepo('api');
    // Linked into a web workspace for Create PRs (spec §21.5).
    const { origin: libOrigin, clone: lib } = fx.cloneWithRemote('lib', 'main');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, runs SessionStart, notes
    // its workspace and worktree, turns typed words into hooks and records
    // every other line typed into it.
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
id="\${${envVar('WORKSPACE_ID')}:-home}"
echo "$PWD" > "$HOME/tree-$id.txt"
hook SessionStart "{\\"session_id\\":\\"$sid\\"}" > /dev/null
while IFS= read -r line; do
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
          ...(p.id === 'work'
            ? {
                // A workflow with a gate and its answer (spec §13.4, §13.5).
                workflow: {
                  file: 'docs/specs/*/spec.md',
                  match: { field: 'branch', equals: 'branch' },
                  statusField: 'status',
                  statuses: [
                    { value: 'draft', label: 'Draft', kind: 'step' },
                    {
                      value: 'review',
                      label: 'Spec review',
                      kind: 'gate',
                      answer: { label: 'Approve spec', prompt: 'approved' },
                    },
                    { value: 'done', label: 'Done', kind: 'final' },
                  ],
                },
                // The PR status per branch, from a file the test writes (spec
                // §12.3); per repository (its project's folder) when there is one.
                pr: {
                  statusCommand: `p=$(basename "$(dirname "$PWD")"); cat "$HOME/pr-$p-$${envVar('BRANCH')}" 2>/dev/null || cat "$HOME/pr-$${envVar('BRANCH')}" 2>/dev/null || true`,
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
          {
            id: 'lib',
            profileId: 'work',
            name: 'lib',
            repoPath: lib,
            remote: 'origin',
            baseBranch: 'main',
          },
        ],
      }),
    );

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page, main: mainProcess } = app;
    await mainProcess.eval(`(() => {
      const { shell } = process.mainModule.require('electron');
      globalThis.__opened = [];
      shell.openExternal = async (url) => { globalThis.__opened.push(url); };
    })()`);

    // 1. Home opens on the Overview. Work has projects but no workspaces: in
    // place of empty columns, New workspace.
    await page.waitFor(
      `document.querySelector('[data-board-empty]')?.dataset.boardEmpty === 'no-workspaces'`,
      'the Overview',
    );
    assert.equal(
      await page.eval(
        `document.querySelector('[data-home-tab=overview]').getAttribute('aria-selected')`,
      ),
      'true',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('main').innerText`),
      /No workspaces yet/,
    );
    assert.equal(
      await page.eval(`!!document.querySelector('[data-board-columns], [data-home-board]')`),
      false,
      'no columns and no Columns control without workspaces',
    );
    // The quick actions, always at the top: New workspace and Add project, no Guide.
    const quick = `[...document.querySelectorAll('[data-home-quick]')].map((b) => b.dataset.homeQuick + (b.disabled ? ':off' : '') + ':' + b.textContent).join('|')`;
    const keys = await page.eval<string>(
      `[...document.querySelectorAll('[data-home-quick] kbd')].map((k) => k.textContent).join()`,
    );
    assert.ok(keys.split(',').every(Boolean), 'each quick action shows its shortcut');
    assert.match(
      await page.eval<string>(quick),
      /^New workspace:New workspace.+\|Add project:Add project.+$/,
    );
    // The empty state's New workspace opens the dialog. Until the profile's
    // setup check has passed it shows the check instead: then Home again.
    const opens = async (button: string) => {
      const open = `!!document.querySelector('dialog[open] #ws-task')`;
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitFor(`!!document.querySelector(${JSON.stringify(button)})`, button);
        await page.eval(`document.querySelector(${JSON.stringify(button)}).click()`);
        for (let i = 0; i < 20 && !(await page.eval<boolean>(open)); i++) await sleep(100);
        if (await page.eval<boolean>(open)) return;
        await pressKey(page, 'Digit0', CMD);
        await sleep(500);
      }
      throw new Error(`${button} didn't open New workspace`);
    };
    await opens('[data-home-action=new-first-workspace]');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    // The quick row's New workspace too.
    await opens('[data-home-quick="New workspace"]');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    assert.equal(
      await page
        .eval<string>(`document.querySelector('footer').innerText`)
        .then((t) => /\bHome\b/.test(t)),
      true,
      'the status bar says Home',
    );
    await screenshot(page, screenshotDir, 'h1-no-workspaces.png');

    // A profile without projects: Add your first project, which opens Add
    // project; the quick row's New workspace is off until there is one.
    await clickLabel(page, 'Select Personal');
    await page.waitFor(
      `!!document.querySelector('[data-home-action=add-first-project]')`,
      'Add your first project',
    );
    assert.match(await page.eval<string>(quick), /^New workspace:off:.+\|Add project:Add project/);
    await screenshot(page, screenshotDir, 'h2-no-projects.png');
    await page.eval(`document.querySelector('[data-home-quick="Add project"]').click()`);
    await page.waitFor(`${dialogText}.includes('Add project')`, 'the Add project dialog');
    await pressKey(page, 'Escape');
    // Gone, not only closed: the dialog's close event, which ends Add project,
    // comes a moment after Esc; a click before it would be undone by it.
    await page.waitFor(`!document.querySelector('dialog')`, 'the dialog to go');
    await page.eval(`document.querySelector('[data-home-action=add-first-project]').click()`);
    await page.waitFor(`${dialogText}.includes('Add project')`, 'the Add project dialog');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog')`, 'the dialog to go');
    await clickLabel(page, 'Select Work');

    // 2. The Terminal tab: the profile's home shell, ⌃2 and ⌃1 (Ctrl+Tab elsewhere).
    const terminalShown = `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`;
    if (isMac) await pressKey(page, 'Digit2', MOD.ctrl);
    else await pressShortcut(page, 'cycleTabs');
    await page.waitFor(terminalShown, 'the Terminal tab');
    await page.waitFor(
      `document.activeElement?.classList.contains('xterm-helper-textarea')`,
      'the shell in focus',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('footer').innerText`),
      /Home › Terminal/,
    );
    await typeInTerminal(page, `echo "$PWD" > "$HOME/home-shell.txt"`);
    assert.equal(await waitForFile(path.join(fx.root, 'home-shell.txt')), fx.root);
    await screenshot(page, screenshotDir, 'h3-terminal.png');
    if (isMac) await pressKey(page, 'Digit1', MOD.ctrl);
    else await pressShortcut(page, 'cycleTabs');
    await page.waitFor(
      `!(${terminalShown}) && !!document.querySelector('[data-board-empty]')`,
      'the Overview again',
    );
    // ⌘L from the Overview starts Claude in the home shell, on the Terminal tab.
    await pressShortcut(page, 'startClaude');
    await page.waitFor(terminalShown, 'the Terminal tab for Start Claude here');
    assert.equal(await waitForFile(path.join(fx.root, 'tree-home.txt')), fx.root);
    await pressKey(page, 'KeyC', MOD.ctrl);
    await sleep(300);
    if (isMac) await pressKey(page, 'Digit1', MOD.ctrl);
    else await pressShortcut(page, 'cycleTabs');

    // 3. Workspaces in every state. Each is created with New workspace; the
    // fake Claude says which workspace and worktree it runs in.
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
        file = fs
          .readdirSync(fx.root)
          .find((f) => f.startsWith('tree-') && f !== 'tree-home.txt' && !before.has(f));
      }
      if (!file) throw new Error(`Claude didn't start in ${task}`);
      const id = file.slice('tree-'.length, -'.txt'.length);
      const tree = (await waitForFile(path.join(fx.root, file))).trim();
      const branch = fx.git(tree, 'branch', '--show-current').trim();
      ws[key] = { id, tree, branch };
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${task}`,
      );
    };
    const sidebarState = (key: string) =>
      `(document.querySelector('nav [data-nav-key="w:${ws[key]?.id}"]')?.title.split('\\n')[1] ?? '')`;
    const waitState = (key: string, state: string) =>
      page.waitFor(`${sidebarState(key)}.startsWith(${JSON.stringify(state)})`, `${key}: ${state}`);
    const commitIn = (key: string, file: string) => {
      const tree = ws[key]?.tree as string;
      fs.writeFileSync(path.join(tree, file), `${file}\n`);
      fx.git(tree, 'add', '-A');
      fx.git(tree, 'commit', '-q', '-m', `Add ${file}`);
    };
    const pr = (key: string, state: string, n: number) =>
      fs.writeFileSync(
        path.join(fx.root, `pr-${ws[key]?.branch}`),
        JSON.stringify({ state, url: `https://git.example.com/acme/web/pull/${n}` }),
      );

    // Needs you: permission, then input, then a gate (oldest first).
    await create('perm', 'web', 'ABC-1 Fix the flaky test');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState('perm', 'Needs permission');
    await create('input', 'web', 'ABC-2 Pick a color');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'input');
    await waitState('input', 'Waiting for input');
    await create('gate', 'web', 'ABC-3 Checkout redesign');
    const spec = path.join(ws.gate?.tree as string, 'docs', 'specs', 'checkout', 'spec.md');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, `---\nbranch: ${ws.gate?.branch}\nstatus: review\n---\n# Checkout\n`);
    await typeInTerminal(page, 'prompt');
    await sleep(1500);
    await typeInTerminal(page, 'stop');
    await waitState('gate', 'Awaiting approval');

    // Working: six, each with its card.
    for (const [i, key] of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].entries()) {
      await create(key, 'api', `ABC-${20 + i} Working ${i + 1}`);
      await typeInTerminal(page, 'prompt');
      await waitState(key, 'Working');
    }

    // Ready to ship: uncommitted files, an unpushed commit (pushed from Home,
    // then its open PR), and two merged ones for Clean up.
    await create('commit', 'web', 'ABC-4 Dark mode tokens');
    fs.writeFileSync(path.join(ws.commit?.tree as string, 'tokens.css'), ':root {}\n');
    await typeInTerminal(page, 'stop');
    await waitState('commit', 'Done');
    await create('push', 'web', 'ABC-5 Search filters');
    commitIn('push', 'filters.txt');
    pr('push', 'open', 212);
    await typeInTerminal(page, 'stop');
    await waitState('push', 'Done');
    for (const [key, n] of [
      ['merged1', 198],
      ['merged2', 187],
    ] as const) {
      await create(key, 'web', `ABC-${n} Merged ${n}`);
      commitIn(key, `${key}.txt`);
      pr(key, 'merged', n);
      await typeInTerminal(page, 'stop');
      await waitState(key, 'Done');
    }

    // 4. ⌘0: the Board with every column.
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board');
    assert.equal(
      await page.eval(`!!document.querySelector('[data-home-layout], [data-home-overview]')`),
      false,
      'no List and no List | Board switch',
    );
    await page.waitFor(
      `(${sectionIds('needs')}).join() === ${JSON.stringify([ws.perm?.id, ws.input?.id, ws.gate?.id].join())}`,
      'Needs you, oldest first',
    );
    const needsText = await page.eval<string>(
      `document.querySelector('[data-board-column=needs]').innerText`,
    );
    assert.match(needsText, /Needs permission/);
    assert.match(needsText, /Waiting for input/);
    assert.match(needsText, /At\s*Spec review/);
    // ⌘J, which the List said under Needs you, in its header's tooltip.
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-column=needs] h2').title`),
      /jumps to the next one that needs you/,
    );
    // A card's details behind its ⓘ: the whole permission message, the branch, the activity.
    const permTip = await readCardDetails(page, homeRow(ws.perm?.id as string));
    assert.match(permTip, /^ABC-1 Fix the flaky test\n/);
    assert.match(permTip, /\nClaude needs your permission to use Bash\n/);
    assert.match(permTip, new RegExp(`\\nBranch: ${ws.perm?.branch}\\n`));
    assert.match(permTip, /\nActive (just now|\d+[smh] ago)\n/);
    assert.match(permTip, /\nClick the card to open it, drag it to delete\.$/);
    // A card names its project at the top right.
    assert.match(await page.eval<string>(`${homeRow(ws.perm?.id as string)}.innerText`), /\bweb\b/);
    // Working: all six, with how long and the memory, also in the details.
    assert.equal(await page.eval(`(${sectionIds('working')}).length`), 6);
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-column=working]').innerText`),
      /Working\s*6[\s\S]*working for less than a minute/,
    );
    await page.waitFor(
      `[...document.querySelectorAll('[data-board-column=working] [data-home-memory]')].some((m) => /^\\d+(\\.\\d)? (MB|GB)$/.test(m.textContent))`,
      'the memory of working workspaces',
      30_000,
    );
    await waitForCardDetails(
      page,
      `[...document.querySelectorAll('[data-board-column=working] [data-board-card]')].find((c) => c.querySelector('[data-home-memory]'))`,
      /\nMemory: \d+(\.\d)? (MB|GB) · Claude /,
      'the memory in the details',
      30_000,
    );
    // Ready to ship: the merged ones too until they are pushed and their PR is known.
    const shipping = ['commit', 'push', 'merged1', 'merged2'].map((k) => ws[k]?.id).sort();
    await page.waitFor(
      `(${sectionIds('ship')}).sort().join() === ${JSON.stringify(shipping.join())}`,
      'Ready to ship',
      20_000,
    );
    assert.match(
      await page.eval<string>(`${homeRow(ws.commit?.id as string)}.innerText`),
      /1 file not committed/,
    );
    assert.match(
      await page.eval<string>(`${homeRow(ws.push?.id as string)}.innerText`),
      /1 commit not pushed/,
    );
    await screenshot(page, screenshotDir, 'h4-overview.png');
    // For comparing with the design: its frames, 1440×900 dark and light, and 900×1120.
    if (screenshotDir) {
      const frame = (width: number, height: number, theme: 'dark' | 'light') =>
        mainProcess.eval(`(() => {
          const { BrowserWindow, nativeTheme } = process.mainModule.require('electron');
          nativeTheme.themeSource = ${JSON.stringify(theme)};
          BrowserWindow.getAllWindows()[0].setContentSize(${width}, ${height});
        })()`);
      if (await page.eval(hasNoThanks)) await clickButtonText(page, 'No thanks');
      for (const [name, width, height, theme] of [
        ['h4a-dark', 1440, 900, 'dark'],
        ['h4b-light', 1440, 900, 'light'],
        ['h4c-narrow', 900, 1120, 'dark'],
      ] as const) {
        await frame(width, height, theme);
        await sleep(800);
        await screenshot(page, screenshotDir, `${name}.png`);
      }
      await frame(1440, 900, 'dark');
      await sleep(500);
    }

    // 5. Push from a card: pushed to the bare remote, then its PR is checked: View PR.
    await page.eval(
      `${homeRow(ws.push?.id as string)}.querySelector('[data-home-action=push]').click()`,
    );
    await page.waitFor(
      `/PR #212 open/.test(${homeRow(ws.push?.id as string)}?.innerText ?? '')`,
      'PR #212 open',
      30_000,
    );
    assert.equal(
      fx.git(origin, 'rev-parse', ws.push?.branch as string).trim(),
      fx.git(ws.push?.tree as string, 'rev-parse', 'HEAD').trim(),
      'pushed to the remote',
    );
    await page.eval(
      `${homeRow(ws.push?.id as string)}.querySelector('[data-home-action=pr]').click()`,
    );
    await sleep(300);
    assert.deepEqual(await mainProcess.eval('globalThis.__opened'), [
      'https://git.example.com/acme/web/pull/212',
    ]);
    // The merged ones: pushed from Home too, then Merged.
    for (const key of ['merged1', 'merged2']) {
      await page.eval(
        `${homeRow(ws[key]?.id as string)}.querySelector('[data-home-action=push]').click()`,
      );
      await page.waitFor(
        `${columnOf(ws[key]?.id as string)} === 'merged'`,
        `${key} under Merged`,
        30_000,
      );
    }
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-column=merged]').innerText`),
      /Merged\s*2[\s\S]*Delete 2 merged[\s\S]*PR #198 merged[\s\S]*PR #187 merged|Merged\s*2[\s\S]*Delete 2 merged[\s\S]*PR #187 merged[\s\S]*PR #198 merged/,
    );

    // 6. ↵ on a card opens its workspace: the second of Needs you. (The Board's
    // keyboard is covered by e2e-board.)
    await page.eval(`${homeRow(ws.input?.id as string)}.focus()`);
    await pressKey(page, 'Enter');
    await page.waitFor(`!document.querySelector('[data-home-board]')`, 'the workspace');
    assert.match(
      await page.eval<string>(
        `document.querySelector('[aria-label=Terminals] [role=tab][aria-selected=true]').innerText`,
      ),
      /Claude/,
    );

    // 7. The cards' actions. Open: the Claude tab of a workspace that needs permission.
    const home = async () => {
      await pressKey(page, 'Digit0', CMD);
      await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'Home');
    };
    await home();
    await page.eval(
      `${homeRow(ws.perm?.id as string)}.querySelector('[data-home-action=open]').click()`,
    );
    await page.waitFor(
      `!document.querySelector('[data-home-board]') && /Claude/.test(document.querySelector('[aria-label=Terminals] [role=tab][aria-selected=true]')?.innerText ?? '')`,
      'the Claude tab',
    );
    // Review at a gate opens the spec view, also next to the gate's answer; the
    // answer types into Claude.
    await home();
    await page.eval(
      `${homeRow(ws.gate?.id as string)}.querySelector('[data-home-action=review]').click()`,
    );
    await page.waitFor(
      `document.querySelector('[data-spec-tab]')?.getAttribute('aria-selected') === 'true'`,
      'the spec view',
    );
    await home();
    await page.waitFor(
      `!${homeRow(ws.gate?.id as string)}.querySelector('[data-answer]')?.disabled`,
      'Approve spec enabled',
    );
    await page.eval(`${homeRow(ws.gate?.id as string)}.querySelector('[data-answer]').click()`);
    // Typed as a paste, as the header's answer button does.
    assert.match(
      await waitForFile(path.join(fx.root, `input-${ws.gate?.id}.txt`), { until: /approved/ }),
      /approved/,
    );
    // Commit…: the workspace with the Changes panel and its commit box in focus.
    await home();
    await page.eval(
      `${homeRow(ws.commit?.id as string)}.querySelector('[data-home-action=commit]').click()`,
    );
    await page.waitFor(
      `document.activeElement?.getAttribute('aria-label') === 'Commit message'`,
      'the commit box in focus',
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-finish]')`), true);

    // 8. Delete on a merged card: the Delete workspace dialog, as from the sidebar.
    await home();
    await page.eval(`${homeRow(ws.merged1?.id as string)}.focus()`);
    await page.eval(
      `${homeRow(ws.merged1?.id as string)}.querySelector('[data-home-action=delete]').click()`,
    );
    await page.waitFor(`${dialogText}.includes('Delete ABC-198 Merged 198?')`, 'Delete workspace');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    // Delete 2 merged: one dialog with both and their checks, one button.
    await clickButtonText(page, 'Delete 2 merged');
    await page.waitFor(
      `document.querySelectorAll('dialog[open] [data-delete-workspace]').length === 2 && ${dialogText}.includes('No uncommitted changes or unpushed commits')`,
      'the merged workspaces with their checks',
    );
    assert.match(await page.eval<string>(dialogText), /Delete 2 merged workspaces\?/);
    assert.equal(await page.eval<string>('document.activeElement.textContent'), 'Cancel Esc');
    await screenshot(page, screenshotDir, 'h6-delete-merged.png');
    assert.equal(
      await page.eval(`document.querySelector('dialog[open] button[type=submit]').textContent`),
      'Delete 2 workspaces',
    );
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the deletes', 30_000);
    await page.waitFor(`(${sectionIds('merged')}).length === 0`, 'Merged empty');
    for (const key of ['merged1', 'merged2']) {
      assert.equal(fs.existsSync(ws[key]?.tree as string), false, `${key}'s worktree is gone`);
    }
    await screenshot(page, screenshotDir, 'h7-after-delete.png');

    // 9. Pushed without a pull request (spec §6.7): the profile has a PR status
    // command, so it stays under Ready to ship. Create PR from Home asks Claude.
    await create('nopr', 'web', 'ABC-30 No PR yet');
    commitIn('nopr', 'nopr.txt');
    await typeInTerminal(page, 'stop');
    await waitState('nopr', 'Done');
    await home();
    const nopr = homeRow(ws.nopr?.id as string);
    await page.waitFor(`/1 commit not pushed/.test(${nopr}?.innerText ?? '')`, 'not pushed');
    await page.eval(`${nopr}.querySelector('[data-home-action=push]').click()`);
    await page.waitFor(
      `/Pushed, no PR yet/.test(${nopr}?.innerText ?? '') && !!${nopr}.querySelector('[data-home-action=create-pr]')`,
      'Pushed, no PR yet',
      30_000,
    );
    await page.eval(`${nopr}.querySelector('[data-home-action=create-pr]').click()`);
    assert.match(
      await waitForFile(path.join(fx.root, `input-${ws.nopr?.id}.txt`), {
        until: /Open a pull request/,
      }),
      /Open a pull request from this branch into main\. Title: "ABC-30: No PR yet"/,
    );

    // A linked workspace in web and lib, both pushed: "2 repositories without
    // a PR", Create PRs… opens the Changes panel, where Create 2 PRs asks
    // Claude once for both; then "2 PRs open" and View PRs' menu (spec §21.5).
    await create('linked', 'web', 'ABC-40 Shared search', ['lib']);
    const linked = ws.linked as { id: string; tree: string; branch: string };
    const libTree = path.join(path.dirname(path.dirname(linked.tree)), 'lib', linked.branch);
    for (const tree of [linked.tree, libTree]) {
      fs.writeFileSync(path.join(tree, 'search.txt'), 'search\n');
      fx.git(tree, 'add', '-A');
      fx.git(tree, 'commit', '-q', '-m', 'Add search');
      fx.git(tree, 'push', '-q', '-u', 'origin', linked.branch);
    }
    assert.ok(fx.git(libOrigin, 'rev-parse', linked.branch).trim(), 'lib pushed');
    await typeInTerminal(page, 'stop');
    await waitState('linked', 'Done');
    await home();
    const linkedRow = homeRow(linked.id);
    await page.waitFor(
      `/2 repositories without a PR/.test(${linkedRow}?.innerText ?? '')`,
      '2 repositories without a PR',
      30_000,
    );
    assert.equal(
      await page.eval(`${linkedRow}.querySelector('[data-home-action=create-pr]').textContent`),
      'Create PRs…',
    );
    await page.eval(`${linkedRow}.querySelector('[data-home-action=create-pr]').click()`);
    const createAll = `document.querySelector('[data-create-all-prs]')`;
    await page.waitFor(
      `${createAll}?.textContent === 'Create 2 PRs' && !${createAll}.disabled`,
      'Create 2 PRs in the Changes panel',
      20_000,
    );
    await page.eval(`${createAll}.click()`);
    const allAsk = await waitForFile(path.join(fx.root, `input-${linked.id}.txt`), {
      until: /link the pull requests to each other/,
    });
    assert.match(
      allAsk,
      new RegExp(`1\\. In the web repository, whose worktree is ${linked.tree}`),
    );
    assert.match(allAsk, new RegExp(`2\\. In the lib repository, whose worktree is ${libTree}`));
    await page.waitFor(
      `/Sent to Claude: it opens the pull requests in web, lib/.test(document.querySelector('[data-create-all-note]')?.innerText ?? '')`,
      'the outcome',
    );
    // Claude opened them; the status command finds each repository's own.
    for (const [repo, n] of [
      ['web', 41],
      ['lib', 5],
    ] as const) {
      fs.writeFileSync(
        path.join(fx.root, `pr-${repo}-${linked.branch}`),
        JSON.stringify({ state: 'open', url: `https://git.example.com/acme/${repo}/pull/${n}` }),
      );
    }
    await home();
    // The window's focus checks every PR, at most once a minute.
    for (const end = Date.now() + 90_000; Date.now() < end; await sleep(3000)) {
      await mainProcess.eval(
        `setImmediate(() => process.mainModule.require('electron').app.emit('browser-window-focus'))`,
      );
      if (await page.eval(`/2 PRs open/.test(${linkedRow}?.innerText ?? '')`)) break;
    }
    await page.waitFor(`/2 PRs open/.test(${linkedRow}?.innerText ?? '')`, '2 PRs open');
    assert.match(
      await page.eval<string>(`${linkedRow}.querySelector('[data-home-action=pr]').textContent`),
      /^View PRs/,
    );
    await chooseFromNextContextMenu(mainProcess, 'lib · PR #5 open ↗');
    await page.eval(`${linkedRow}.querySelector('[data-home-action=pr]').click()`);
    await sleep(300);
    assert.deepEqual(await mainProcess.eval('globalThis.__lastMenu'), [
      'web · PR #41 open ↗',
      'lib · PR #5 open ↗',
    ]);
    assert.equal(
      (await mainProcess.eval<string[]>('globalThis.__opened')).at(-1),
      'https://git.example.com/acme/lib/pull/5',
    );
    await screenshot(page, screenshotDir, 'h8-linked-prs.png');

    console.log(`e2e home test passed (${devMode ? 'dev server' : 'production build'})`);
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
  console.error(`e2e home test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
