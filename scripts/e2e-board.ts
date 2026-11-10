/**
 * End-to-end test of Home's Board (spec §6.7): the only way Home shows the
 * workspaces (no List, no switch), the five columns following
 * the workspaces live, drag to delete (Esc, a drop elsewhere, the zone, the
 * dialog's Cancel and Delete), the keyboard (↑↓←→, ↵, Tab, Delete), Delete n
 * merged, a branch merged only locally (Merged, and Delete workspace's
 * "Merged into …" in place of the unpushed warning, spec §14.2), a branch
 * that only caught up with a newer main (never Merged, spec §14.2), the
 * columns (dragged by a header, Move Left, Move Right and Hide Column from
 * the column menu, the Columns panel, Needs you hidden with its mark, Reset,
 * each profile's layout across a restart), a card
 * unfolding on hover (after a rest, smoothly, none while the pointer passes
 * over, at once with reduced motion), and the quick reply: sent to a waiting
 * workspace and to a working
 * one, resumed first for a suspended one, refused on a permission request
 * (Open instead) and over a draft; above it what Claude last said (its
 * question, its words at a gate or the gate's hint alone, none for a fresh
 * session), the line opening the Responses panel at that entry, and Claude's
 * question tool shown as Asked a question (card, sidebar, Needs you in
 * the input color) and answered from its card's options. Runs with a throwaway HOME and a fake
 * `claude`.
 *
 *   tsx scripts/e2e-board.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { envVar } from '../src/shared/brand';
import { SUSPENDED_TOOLTIP } from '../src/shared/suspend';
import {
  type Cdp,
  CMD,
  chooseFromNextContextMenu,
  clickLabel,
  dialogText,
  launchApp,
  openContextMenu,
  pressKey,
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

/**
 * A minute lasts this long here: Personal's "after 5 minutes" is 5 seconds,
 * longer than a resumed Claude takes to be ready for the reply.
 */
const MINUTE_MS = 1000;

/** A card by workspace id, as an expression. */
const card = (id: string) => `document.querySelector('[data-board-card="${id}"]')`;
/** The ids of a column's cards, in order, as an expression. */
const columnIds = (column: string) =>
  `[...document.querySelectorAll('[data-board-column=${column}] [data-board-card]')].map((c) => c.dataset.boardCard)`;
const columnOf = (id: string) =>
  `(${card(id)}?.closest('[data-board-column]')?.dataset.boardColumn ?? null)`;
const activeCard = `(document.activeElement?.dataset?.boardCard ?? null)`;
/** The Board's shown columns, left to right, as an expression. */
const shown = `[...document.querySelectorAll('[data-board-column]')].map((c) => c.dataset.boardColumn)`;
const DEFAULT_ORDER = ['working', 'idle', 'needs', 'ship', 'merged'];
/** The Columns panel's rows, in order, with their checkbox: `needs:on`, `idle:off`, `merged:last`. */
const columnOptions = `[...document.querySelectorAll('[data-board-columns-option]')].map((o) => {
  const box = o.querySelector('input');
  return o.dataset.boardColumnsOption + ':' + (box.disabled ? 'last' : box.checked ? 'on' : 'off');
})`;
const columnsMark = `(document.querySelector('[data-board-columns-mark]')?.dataset.boardColumnsMark ?? null)`;

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
    buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' ? 1 : 1,
    clickCount: 1,
  });
}

/**
 * ↵ as a keyboard sends it, with its character: a focused button activates
 * only on that (pressKey sends the key alone).
 */
async function pressEnterOn(page: Cdp) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Presses on a card and moves the pointer far enough to lift it. */
async function lift(page: Cdp, id: string) {
  const from = await centre(page, card(id));
  await mouse(page, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= 4; i++) await mouse(page, 'mouseMoved', from.x + i * 5, from.y + i * 5);
  await page.waitFor(`!!document.querySelector('[data-board-float]')`, 'the lifted card');
  return from;
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: web } = fx.cloneWithRemote('web', 'main');
    const api = fx.localRepo('api');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, runs SessionStart with
    // its transcript's path, notes its workspace, worktree and starts, turns
    // typed words into hooks (a pasted line arrives in bracketed-paste marks,
    // which it drops) and records every other line typed into it. As Claude
    // Code, it writes its transcript at the first prompt.
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
echo "$*" >> "$HOME/starts-$id.txt"
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
    # Background work (spec §10.2): a command Claude waits for, running below it
    # as Claude Code runs one, its hand-back, and a dev server left running.
    held)
      sh -c 'sleep 600 && echo built' > /dev/null 2>&1 & bg=$!
      hook Stop '{"background_tasks":[{"id":"b1","type":"shell","status":"running","command":"sleep 600 && echo built"}]}' ;;
    handback)
      [ -n "$bg" ] && { pkill -P "$bg"; kill "$bg"; } 2>/dev/null
      hook UserPromptSubmit '{"prompt":"<task-notification><task-id>b1</task-id></task-notification>"}'
      hook Stop '{"background_tasks":[]}' ;;
    devserver) hook Stop '{"background_tasks":[{"id":"d1","type":"shell","status":"running","command":"npm run dev"}]}' ;;
    # What Claude says, in the transcript (spec §6.7's line above the quick reply).
    said)
      printf '%s\\n' '{"type":"assistant","message":{"id":"said-1","role":"assistant","content":[{"type":"text","text":"I picked a palette.\\n\\nShall I use the **brand blue**?"}]}}' >> "$transcript" ;;
    # Claude's question tool, as Claude Code 2.1.319 runs it: the call in the
    # transcript, PreToolUse, then a permission Notification; its menu takes
    # one key, a digit picking that option at once.
    ask)
      printf '%s\\n' '{"type":"assistant","message":{"id":"ask-1","role":"assistant","content":[{"type":"tool_use","id":"toolu_ask1","name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"Warm"},{"label":"Blue","description":"Calm"},{"label":"Green","description":"Fresh"}],"multiSelect":false}]}}]}}' >> "$transcript"
      hook PreToolUse '{"tool_name":"AskUserQuestion"}'
      hook Notification '{"notification_type":"permission_prompt","message":"Claude needs your permission"}'
      old=$(stty -g); stty -icanon -echo min 1; key=$(dd bs=1 count=1 2>/dev/null); stty "$old"
      printf '%s' "$key" > "$HOME/answer-$id.txt"
      case "$key" in 1) pick=Red ;; 2) pick=Blue ;; 3) pick=Green ;; *) pick="$key" ;; esac
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ask1","content":"answered"}]},"toolUseResult":{"answers":{"Which color do you prefer?":"'"$pick"'"}}}' >> "$transcript"
      hook PostToolUse '{"tool_name":"AskUserQuestion"}'
      hook Stop "{\\"last_assistant_message\\":\\"$pick\\"}" ;;
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
          // Personal suspends its idle Claude after "5 minutes" (spec §9.8), and
          // has a workflow with a gate (spec §13.4, §13.5).
          ...(p.id === 'personal'
            ? {
                suspendIdleMin: 5,
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
                      hint: 'Review and approve the spec',
                    },
                    { value: 'done', label: 'Done', kind: 'final' },
                  ],
                },
              }
            : {}),
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
          { id: 'api', profileId: 'personal', name: 'api', repoPath: api, remote: null },
        ],
      }),
    );
    const file = (name: string) => path.join(fx.root, name);
    const read = (name: string) =>
      fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';
    const launch = () =>
      launchApp({
        env: withDisplayEnv({ ...fx.env, [envVar('SUSPEND_MINUTE_MS')]: String(MINUTE_MS) }),
        dev: devMode,
        electronArgs,
      });

    app = await launch();
    let page = app.page;

    // 1. Without workspaces, New workspace in place of empty columns.
    await page.waitFor(
      `document.querySelector('[data-board-empty]')?.dataset.boardEmpty === 'no-workspaces'`,
      'No workspaces yet',
    );
    assert.equal(
      await page.eval(`!!document.querySelector('[data-board-columns], [data-board-column]')`),
      false,
      'no columns without workspaces',
    );

    // 2. Workspaces in every column but Ready to ship.
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

    await create('waiting', 'web', 'ABC-1 Pick a color');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'said');
    await typeInTerminal(page, 'input');
    await waitState('waiting', 'Waiting for input');
    await create('perm', 'web', 'ABC-2 Fix the flaky test');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'permission');
    await waitState('perm', 'Needs permission');
    await create('working', 'web', 'ABC-3 Rate limit the login');
    await typeInTerminal(page, 'prompt');
    await waitState('working', 'Working');
    for (const [key, n] of [
      ['merged1', 198],
      ['merged2', 187],
    ] as const) {
      await create(key, 'web', `ABC-${n} Merged ${n}`);
      const tree = ws[key]?.tree as string;
      fs.writeFileSync(path.join(tree, `${key}.txt`), 'x\n');
      fx.git(tree, 'add', '-A');
      fx.git(tree, 'commit', '-q', '-m', `Add ${key}`);
      fs.writeFileSync(
        file(`pr-${ws[key]?.branch}`),
        JSON.stringify({ state: 'merged', url: `https://git.example.com/acme/web/pull/${n}` }),
      );
      await typeInTerminal(page, 'stop');
      await waitState(key, 'Done');
    }
    // Idle, with a draft: text typed into its Claude and not sent.
    await create('draft', 'web', 'ABC-6 Search box focus');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('draft', 'Done');
    await typeInTerminal(page, 'half a thought', false);

    // 3. ⌘0: the Board, with no List and no switch.
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board');
    assert.equal(
      await page.eval(`!!document.querySelector('[data-home-layout], [data-home-overview]')`),
      false,
      'no List | Board switch',
    );
    await page.waitFor(`${columnIds('ship')}.length === 2`, 'the cards to ship', 30_000);
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('[data-board-column]')].map((c) => c.dataset.boardColumn + ':' + c.querySelector('h2').textContent + ':' + c.querySelector('[data-board-count]').textContent)`,
      ),
      [
        'working:Working:1',
        'idle:Idle:1',
        'needs:Needs you:2',
        'ship:Ready to ship:2',
        'merged:Merged:0',
      ],
    );
    // Needs you stands out while it has cards: its count in the most urgent card's color.
    const tone = (column: string) =>
      `(document.querySelector('[data-board-column=${column}]').dataset.boardTone ?? null)`;
    assert.equal(await page.eval(tone('needs')), 'permission');
    assert.ok(
      await page.eval(
        `document.querySelector('[data-board-column=needs] [data-board-count]').classList.contains('text-st-permission')`,
      ),
      'the count in the permission color',
    );
    assert.equal(await page.eval(tone('idle')), null);
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-column=merged]').innerText`),
      /Nothing here/,
    );
    assert.match(
      await page.eval<string>(`${card(id('merged1'))}.innerText`),
      /1 commit not pushed/,
    );
    // Pushed from their cards, their PRs are known merged: they move to Merged by themselves.
    for (const key of ['merged1', 'merged2']) {
      await page.eval(`${card(id(key))}.focus()`);
      await page.eval(`${card(id(key))}.querySelector('[data-home-action=push]').click()`);
    }
    await page.waitFor(`${columnIds('merged')}.length === 2`, 'the merged cards', 40_000);
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-column=ship]').innerText`),
      /Nothing here/,
    );
    assert.match(await page.eval<string>(`${card(id('merged1'))}.innerText`), /PR #198 merged/);
    assert.deepEqual(await page.eval(columnIds('needs')), [id('waiting'), id('perm')]);
    assert.deepEqual(await page.eval(columnIds('working')), [id('working')]);
    assert.deepEqual(await page.eval(columnIds('idle')), [id('draft')]);
    // The status line: the state in its color and the tool it asks for.
    assert.match(
      await page.eval<string>(`${card(id('perm'))}.innerText`),
      /ABC-2[\s\S]*Fix the flaky test[\s\S]*Needs permission[\s\S]*Bash/,
    );
    await screenshot(page, screenshotDir, 'b1-board.png');

    // 4. Quick reply. Never on a permission request: Open in the field's place.
    await page.waitFor(`!!${card(id('perm'))}.querySelector('[data-quick-reply-open]')`, 'Open');
    assert.equal(
      await page.eval(`!!${card(id('perm'))}.querySelector('[data-quick-reply]')`),
      false,
    );
    // Never over a draft: it says so and offers to open it.
    await page.waitFor(
      `!!${card(id('draft'))}.querySelector('[data-quick-reply-draft]')`,
      'the draft note',
    );
    assert.equal(
      await page.eval(`!!${card(id('draft'))}.querySelector('[data-quick-reply]')`),
      false,
    );
    assert.equal(
      await page.eval<string>(
        `${card(id('draft'))}.querySelector('[data-quick-reply-draft]').textContent`,
      ),
      'Has an unsent prompt; open it',
    );
    // Never on Merged.
    assert.equal(
      await page.eval(`!!${card(id('merged1'))}.querySelector('[data-quick-reply]')`),
      false,
    );

    // Above the field, what Claude last said (spec §6.7): its question, on Needs you always.
    const context = (key: string) => `${card(id(key))}.querySelector('[data-quick-reply-context]')`;
    await page.waitFor(`!!${context('waiting')}`, "the waiting card's line");
    assert.equal(
      await page.eval<string>(`${context('waiting')}.textContent`),
      'Claude asked: Shall I use the brand blue?',
    );
    assert.equal(
      await page.eval(
        `${context('waiting')}.compareDocumentPosition(${card(id('waiting'))}.querySelector('[data-quick-reply]')) & Node.DOCUMENT_POSITION_FOLLOWING`,
      ),
      4,
      'the line is above the field',
    );
    // A fresh session has no text: no line, also once its field shows.
    await page.eval(`${card(id('working'))}.focus()`);
    await page.waitFor(`!!${card(id('working'))}.querySelector('[data-quick-reply]')`, 'the field');
    assert.equal(await page.eval(`!!${context('working')}`), false, 'no line without text');
    // None where no field is offered: a permission request.
    assert.equal(await page.eval(`!!${context('perm')}`), false);

    // Sent to a waiting workspace: always shown on Needs you; ↵ sends, the field clears.
    const reply = async (key: string, text: string) => {
      await page.eval(`${card(id(key))}.focus()`);
      await page.waitFor(
        `!!${card(id(key))}.querySelector('[data-quick-reply]')`,
        `${key}'s field`,
      );
      await typeInField(page, `[data-board-card="${id(key)}"] [data-quick-reply]`, text);
    };
    await reply('waiting', 'Use the brand blue');
    await until(
      () => read(`input-${id('waiting')}.txt`).includes('Use the brand blue'),
      'the reply',
    );
    await page.waitFor(`!!${card(id('waiting'))}.querySelector('[data-quick-reply-sent]')`, 'Sent');
    assert.match(
      await page.eval<string>(
        `${card(id('waiting'))}.querySelector('[data-quick-reply-sent]').textContent`,
      ),
      /Sent to Claude/,
    );
    // To a working one, which reads it after this step.
    await reply('working', 'Also log refusals');
    await until(
      () => read(`input-${id('working')}.txt`).includes('Also log refusals'),
      'the reply',
    );
    assert.match(
      await page.eval<string>(
        `${card(id('working'))}.querySelector('[data-quick-reply-sent]').textContent`,
      ),
      /Claude reads it after this step/,
    );
    await screenshot(page, screenshotDir, 'b2-sent.png');

    // 5. Cards move by themselves: the waiting workspace stops and goes to Idle.
    await page.waitFor(
      `!${card(id('waiting'))}.querySelector('[data-quick-reply-sent]')`,
      'the field back',
      5_000,
    );
    await reply('waiting', 'stop');
    await page.waitFor(`${columnOf(id('waiting'))} === 'idle'`, 'the card in Idle');
    // Claude waiting for a background command it runs stays Working (spec §10.2)…
    const status = (key: string) =>
      `${card(id(key))}.querySelector('[data-board-status]').innerText`;
    await reply('waiting', 'held');
    await page.waitFor(`${columnOf(id('waiting'))} === 'working'`, 'held in Working');
    await page.waitFor(`${status('waiting')}.includes('1 in background')`, '1 in background');
    // …until the command hands back.
    await page.waitFor(
      `!${card(id('waiting'))}.querySelector('[data-quick-reply-sent]')`,
      'the field back',
      5_000,
    );
    await reply('waiting', 'handback');
    await page.waitFor(`${columnOf(id('waiting'))} === 'idle'`, 'back in Idle');
    assert.doesNotMatch(await page.eval<string>(status('waiting')), /running|background/);
    // A dev server left running keeps a Done card in its column, with a quiet mark.
    await page.waitFor(
      `!${card(id('waiting'))}.querySelector('[data-quick-reply-sent]')`,
      'the field back',
      5_000,
    );
    await reply('waiting', 'devserver');
    await page.waitFor(`${status('waiting')}.includes('1 running')`, 'the running mark');
    assert.equal(await page.eval(columnOf(id('waiting'))), 'idle');
    assert.equal(
      await page.eval(
        `[...${card(id('waiting'))}.querySelectorAll('[data-board-status] span')].find((s) => s.textContent === '1 running')?.title`,
      ),
      '1 still running in the background',
    );
    assert.deepEqual(await page.eval(columnIds('needs')), [id('perm')]);
    // The permission request answered in its terminal: Working, then Needs you again.
    await page.eval(`${card(id('perm'))}.click()`);
    await page.waitFor(`!document.querySelector('[data-home-board]')`, 'the workspace');
    // ↵ answers the permission prompt (spec §10.2); then Claude waits for input.
    await typeInTerminal(page, 'prompt');
    await waitState('perm', 'Working');
    await typeInTerminal(page, 'input');
    await waitState('perm', 'Waiting for input');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');
    await page.waitFor(
      `${columnOf(id('perm'))} === 'needs' && !!${card(id('perm'))}.querySelector('[data-quick-reply]')`,
      'its field now',
    );
    assert.equal(await page.eval(tone('needs')), 'input', 'waiting for input: the input color');

    // 6. The keyboard: ↓ from the Board to the first card, ← → across columns, ↑ ↓ within.
    await page.eval(`document.querySelector('[data-home-board]').focus()`);
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(activeCard), id('working'));
    await pressKey(page, 'ArrowRight');
    const idleFirst = await page.eval<string>(`${columnIds('idle')}[0]`);
    assert.equal(await page.eval(activeCard), idleFirst);
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(activeCard), await page.eval<string>(`${columnIds('idle')}[1]`));
    await pressKey(page, 'ArrowUp');
    assert.equal(await page.eval(activeCard), idleFirst);
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('perm'));
    // → skips the empty Ready to ship.
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(columnOf(await page.eval<string>(activeCard))), 'merged');
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(activeCard), id('perm'));
    await pressKey(page, 'ArrowLeft');
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(activeCard), id('working'));
    // Focus shows the card's actions; Tab reaches them.
    assert.equal(
      await page.eval(
        `getComputedStyle(${card(id('working'))}.querySelector('[data-home-action=delete]')).visibility === 'visible'`,
      ),
      true,
      'actions on focus',
    );
    await screenshot(page, screenshotDir, 'b3-focus.png');
    await pressKey(page, 'Tab');
    assert.equal(
      await page.eval(
        `${card(id('working'))}.contains(document.activeElement) && document.activeElement !== ${card(id('working'))}`,
      ),
      true,
      'Tab into the card',
    );
    // Delete on a focused card opens Delete workspace; Esc closes it.
    await page.eval(`${card(id('working'))}.focus()`);
    await pressKey(page, 'Backspace');
    await page.waitFor(`${dialogText}.includes('Delete ABC-3')`, 'Delete workspace');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    // ↵ opens the workspace.
    await page.eval(`${card(id('working'))}.focus()`);
    await pressKey(page, 'Enter');
    await page.waitFor(`!document.querySelector('[data-home-board]')`, 'the workspace by ↵');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');

    // 6b. Hover unfolds a card's field and actions once the pointer rests, as a
    // transition, and the card below moves down with it (spec §6.7). That it is
    // a transition is read from the computed style, not from transitions
    // starting, which depends on how often the test window draws.
    await page.eval(`document.querySelector('[data-home-board]').focus()`);
    await page.eval(`(() => {
      window.__unfolds = [];
      // Started, not merely created: one cancelled in its delay never starts.
      document.addEventListener('transitionstart', (e) => {
        if (e.propertyName === 'grid-template-rows') window.__unfolds.push(e.target.closest('[data-board-card]').dataset.boardCard);
      });
    })()`);
    const unfolds = () => page.eval<string[]>(`window.__unfolds.splice(0)`);
    const parts = (cardId: string) =>
      `[...${card(cardId)}.querySelectorAll('[data-board-unfold]')]`;
    const unfolded = (cardId: string) =>
      `${parts(cardId)}.every((u) => getComputedStyle(u).visibility === 'visible' && u.getBoundingClientRect().height > 20)`;
    const folded = (cardId: string) =>
      `${parts(cardId)}.every((u) => getComputedStyle(u).visibility === 'hidden' && u.getBoundingClientRect().height === 0)`;
    const transition = (cardId: string) =>
      page.eval<string[][]>(
        `${parts(cardId)}.map((u) => { const s = getComputedStyle(u); return [s.transitionProperty, s.transitionDuration, s.transitionDelay]; })`,
      );
    const top = (cardId: string) =>
      page.eval<number>(`${card(cardId)}.getBoundingClientRect().top`);
    const [upper = '', lower = ''] = await page.eval<string[]>(columnIds('idle'));
    assert.ok(upper && lower, 'two Idle cards');
    const away = await centre(page, `document.querySelector('[data-board-column=idle] h2')`);
    await mouse(page, 'mouseMoved', away.x, away.y);
    await page.waitFor(folded(upper), 'the Idle card folded');
    const lowerTop = await top(lower);
    let at = await centre(page, card(upper));
    await mouse(page, 'mouseMoved', at.x, at.y);
    assert.deepEqual(
      await page.eval(
        `${parts(upper)}.map((u) => [getComputedStyle(u).transitionDelay, getComputedStyle(u).transitionDuration])`,
      ),
      [
        ['0.15s', '0.18s'],
        ['0.15s', '0.18s'],
      ],
      'unfolds after 150 ms, over 180 ms',
    );
    await page.waitFor(unfolded(upper), 'the card unfolded on hover');
    assert.ok((await top(lower)) >= lowerTop + 40, 'the card below moved down');
    assert.ok(
      (await transition(upper)).every(
        ([property = '', duration]) =>
          property.split(', ').includes('grid-template-rows') && duration === '0.18s',
      ),
      'unfolded as a transition',
    );
    await mouse(page, 'mouseMoved', away.x, away.y);
    await page.waitFor(folded(upper), 'the card folded again');
    assert.equal(await top(lower), lowerTop, 'the card below back');
    assert.deepEqual(
      (await transition(upper)).map(([property = '', duration, delay]) => [
        property.split(', ').includes('grid-template-rows'),
        duration,
        delay,
      ]),
      [
        [true, '0.18s', '0s'],
        [true, '0.18s', '0s'],
      ],
      'folded as a transition',
    );
    // A pointer passing over several cards unfolds none of them.
    await unfolds();
    const passed = await page.eval<string[]>(
      `[...document.querySelectorAll('[data-board-column=merged] [data-board-card], [data-board-column=idle] [data-board-card]')].map((c) => c.dataset.boardCard)`,
    );
    const sweep = await Promise.all(passed.map((cardId) => centre(page, card(cardId))));
    for (const p of sweep) await mouse(page, 'mouseMoved', p.x, p.y);
    await mouse(page, 'mouseMoved', away.x, away.y);
    await sleep(500);
    assert.deepEqual(await unfolds(), [], 'nothing unfolded in passing');
    for (const cardId of passed) assert.ok(await page.eval(folded(cardId)), `${cardId} folded`);
    // Reduced motion: no delay and no transition; it shows and hides at once.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    at = await centre(page, card(upper));
    await mouse(page, 'mouseMoved', at.x, at.y);
    assert.ok(await page.eval(unfolded(upper)), 'unfolded at once');
    await mouse(page, 'mouseMoved', away.x, away.y);
    assert.ok(await page.eval(folded(upper)), 'folded at once');
    assert.deepEqual(await unfolds(), [], 'no transition with reduced motion');
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // 6c. A card's details behind its ⓘ (spec §6.7): no tooltip on the card;
    // hover shows them after a rest, a click pins them until a click outside
    // or Esc, Tab reaches the ⓘ and ↵ or Space opens it; never the workspace
    // or a drag.
    const info = (cardId: string) => `${card(cardId)}.querySelector('[data-card-info]')`;
    const details = `document.querySelector('[data-card-details]')`;
    const detailsShown = `!!${details}`;
    const noWorkspace = async (what: string) => {
      await sleep(300);
      assert.ok(await page.eval(`!!document.querySelector('[data-home-board]')`), what);
      assert.ok(
        await page.eval(`!document.querySelector('[data-board-float]')`),
        `${what}: no drag`,
      );
    };
    assert.equal(await page.eval(`${card(id('perm'))}.title`), '', 'no tooltip on the card');
    assert.equal(
      await page.eval(`${info(id('perm'))}.getAttribute('aria-label')`),
      'Details for ABC-2',
    );
    // Hover: shown after a rest (not pinned), gone once the pointer leaves.
    const hoverAt = await centre(page, info(id('perm')));
    const hover = (x: number, y: number) =>
      page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
      });
    await hover(away.x, away.y);
    await hover(hoverAt.x, hoverAt.y);
    assert.equal(await page.eval(detailsShown), false, 'not at once');
    await page.waitFor(detailsShown, 'the details on hover');
    assert.equal(await page.eval(`${details}.dataset.cardDetailsPinned ?? null`), null);
    await hover(away.x, away.y);
    await page.waitFor(`!${detailsShown}`, 'the details gone with the pointer');
    // A click pins them: the whole state message, the branch, the activity.
    await mouse(page, 'mousePressed', hoverAt.x, hoverAt.y);
    await mouse(page, 'mouseReleased', hoverAt.x, hoverAt.y);
    await page.waitFor(`${details}?.dataset.cardDetailsPinned === 'true'`, 'the details pinned');
    await noWorkspace('a click on the ⓘ opens no workspace');
    assert.equal(await page.eval(`document.activeElement === ${details}`), true, 'focus in them');
    assert.equal(await page.eval(`${info(id('perm'))}.getAttribute('aria-expanded')`), 'true');
    const permDetails = await page.eval<string>(`${details}.innerText`);
    assert.match(permDetails, /^ABC-2 Fix the flaky test\n/);
    assert.match(permDetails, /\nClaude is waiting for your input\n/);
    assert.match(permDetails, new RegExp(`\\nBranch: ${ws.perm?.branch}\\n`));
    assert.match(permDetails, /\nActive (just now|\d+[smh] ago)\n/);
    assert.match(permDetails, /\nClick the card to open it, drag it to delete\.$/);
    // Inside the window, and above the cards.
    assert.ok(
      await page.eval(`(() => {
        const r = ${details}.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      })()`),
      'inside the window',
    );
    await screenshot(page, screenshotDir, 'b3b-details.png');
    await hover(away.x, away.y);
    await sleep(400);
    assert.equal(await page.eval(detailsShown), true, 'pinned: they stay');
    // A click in them opens nothing either.
    const inDetails = await centre(page, details);
    await mouse(page, 'mousePressed', inDetails.x, inDetails.y);
    await mouse(page, 'mouseReleased', inDetails.x, inDetails.y);
    await noWorkspace('a click in the details opens no workspace');
    assert.equal(await page.eval(detailsShown), true);
    // A click outside closes them.
    await mouse(page, 'mousePressed', away.x, away.y);
    await mouse(page, 'mouseReleased', away.x, away.y);
    await page.waitFor(`!${detailsShown}`, 'the details closed by a click outside');
    await noWorkspace('a click outside opens nothing');
    // The keyboard: Tab from the card to its ⓘ, ↵ opens, Esc closes and gives the ⓘ focus.
    await page.eval(`${card(id('perm'))}.focus()`);
    await pressKey(page, 'Tab');
    assert.equal(
      await page.eval(`document.activeElement === ${info(id('perm'))}`),
      true,
      'Tab reaches the ⓘ',
    );
    await pressEnterOn(page);
    await page.waitFor(
      `${details}?.dataset.cardDetailsPinned === 'true' && document.activeElement === ${details}`,
      'the details by ↵',
    );
    await noWorkspace('↵ on the ⓘ opens no workspace');
    assert.match(await page.eval<string>(`${details}.innerText`), /^ABC-2 Fix the flaky test\n/);
    await pressKey(page, 'Escape');
    await page.waitFor(`!${detailsShown}`, 'the details closed by Esc');
    assert.equal(
      await page.eval(`document.activeElement === ${info(id('perm'))}`),
      true,
      'focus back',
    );
    assert.equal(await page.eval(`${info(id('perm'))}.getAttribute('aria-expanded')`), 'false');
    // Space opens them too; Tab leaves them, past the ⓘ.
    const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', ...space });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
    await page.waitFor(detailsShown, 'the details by Space');
    await pressKey(page, 'Tab');
    await page.waitFor(`!${detailsShown}`, 'the details closed by Tab');
    assert.equal(
      await page.eval(
        `${card(id('perm'))}.contains(document.activeElement) && document.activeElement !== ${info(id('perm'))}`,
      ),
      true,
      'on to what follows the ⓘ',
    );
    await page.eval(`document.activeElement?.blur()`);
    await page.eval(`document.querySelector('[data-home-board]').focus()`);

    // 7. Delete n merged: one dialog for both.
    await page.eval(
      `document.querySelector('[data-board-column=merged] [data-home-action=delete-merged]').click()`,
    );
    await page.waitFor(`${dialogText}.includes('Delete 2 merged workspaces')`, 'Delete n merged');
    assert.match(
      await page.eval<string>(dialogText),
      /ABC-198[\s\S]*ABC-187|ABC-187[\s\S]*ABC-198/,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');

    // 8. Drag to delete. Esc cancels: nothing moves, nothing is deleted.
    const draft = id('draft');
    await lift(page, draft);
    await page.waitFor(`!!document.querySelector('[data-drop-zone]')`, 'the zone');
    assert.equal(await page.eval(`${card(draft)}.dataset.boardLifted`), 'true', 'the dashed slot');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-drop-zone]').innerText`),
      /Drop to delete/,
    );
    // The columns shrink so the zone covers nothing.
    assert.equal(
      await page.eval(`(() => {
        const zone = document.querySelector('[data-drop-zone]').getBoundingClientRect();
        return [...document.querySelectorAll('[data-board-column]')].every((c) => c.getBoundingClientRect().bottom <= zone.top);
      })()`),
      true,
    );
    await screenshot(page, screenshotDir, 'b4-lifted.png');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-board-float]')`, 'the drag to end');
    const here = await centre(page, card(draft));
    await mouse(page, 'mouseReleased', here.x, here.y);
    assert.equal(await page.eval(`!!document.querySelector('dialog[open]')`), false);
    // Dropped on a column: nothing happens.
    await lift(page, draft);
    const column = await centre(page, `document.querySelector('[data-board-column=working]')`);
    await mouse(page, 'mouseMoved', column.x, column.y);
    await mouse(page, 'mouseReleased', column.x, column.y);
    await page.waitFor(`!document.querySelector('[data-board-float]')`, 'the drag to end');
    await sleep(300);
    assert.equal(await page.eval(`!!document.querySelector('dialog[open]')`), false);
    assert.equal(await page.eval(columnOf(draft)), 'idle');
    // Over the zone it names the card; the drop opens Delete workspace, Cancel focused.
    const dropOnZone = async () => {
      await lift(page, draft);
      const zone = await centre(page, `document.querySelector('[data-drop-zone]')`);
      await mouse(page, 'mouseMoved', zone.x, zone.y);
      await page.waitFor(
        `document.querySelector('[data-drop-zone]')?.dataset.dropZone === 'over'`,
        'over the zone',
      );
      // The lifted card stays under the pointer.
      await sleep(100);
      const lifted = await centre(page, `document.querySelector('[data-board-float]')`);
      assert.ok(
        Math.abs(lifted.y - zone.y) < 120,
        `the lifted card at ${lifted.y}, the pointer at ${zone.y}`,
      );
      return zone;
    };
    let zone = await dropOnZone();
    assert.match(
      await page.eval<string>(`document.querySelector('[data-drop-zone]').innerText`),
      /Release to delete ABC-6[\s\S]*You confirm in the next step/,
    );
    await screenshot(page, screenshotDir, 'b5-over.png');
    await mouse(page, 'mouseReleased', zone.x, zone.y);
    await page.waitFor(`${dialogText}.includes('Delete ABC-6')`, 'Delete workspace');
    await page.waitFor(
      `document.activeElement?.textContent?.startsWith('Cancel')`,
      'Cancel focused',
    );
    await screenshot(page, screenshotDir, 'b6-dialog.png');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    assert.equal(await page.eval(columnOf(draft)), 'idle', 'nothing deleted on Cancel');
    zone = await dropOnZone();
    await mouse(page, 'mouseReleased', zone.x, zone.y);
    await page.waitFor(`${dialogText}.includes('Delete ABC-6')`, 'Delete workspace');
    await submitDialog(page);
    await page.waitFor(`!${card(draft)}`, 'the card gone', 30_000);
    assert.equal(fs.existsSync(ws.draft?.tree as string), false, 'its worktree deleted');

    // 8b. Merged locally (spec §14.2): a fast-forward into web's own main moves
    // it to Merged without a PR, and Delete workspace says so instead of
    // warning about unpushed commits; once pushed, "Merged into main".
    await create('local', 'web', 'ABC-8 Merged here');
    const localTree = ws.local?.tree as string;
    fs.writeFileSync(path.join(localTree, 'local.txt'), 'x\n');
    fx.git(localTree, 'add', '-A');
    fx.git(localTree, 'commit', '-q', '-m', 'Add local');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('local', 'Done');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');
    await page.waitFor(`${columnOf(id('local'))} === 'ship'`, 'its commit to ship', 30_000);
    // And one that only catches up with main (spec §14.2), Done without commits.
    await create('caught', 'web', 'ABC-9 Caught up');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('caught', 'Done');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');
    await page.waitFor(`${columnOf(id('caught'))} === 'idle'`, 'nothing to ship yet', 30_000);
    fx.git(web, 'merge', '-q', '--ff-only', ws.local?.branch as string);
    await page.waitFor(`${columnOf(id('local'))} === 'merged'`, 'merged locally', 40_000);
    // 8c. Caught up (spec §14.2): main moves on (a commit made earlier, by
    // someone else) and the fresh branch is rebased onto it, as Claude does
    // before starting. main contains its tip, but it has no commits of its
    // own: not merged, not in Delete n merged; main's two commits are to ship.
    fs.writeFileSync(path.join(web, 'theirs.txt'), 'x\n');
    fx.git(web, 'add', 'theirs.txt');
    execFileSync('git', ['commit', '-q', '-m', 'Add theirs'], {
      cwd: web,
      env: { ...fx.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
    });
    fx.git(ws.caught?.tree as string, 'rebase', '-q', 'main');
    await page.waitFor(
      `${columnOf(id('caught'))} === 'ship' && /2 commits not pushed/.test(${card(id('caught'))}.innerText)`,
      "caught up: main's commits to ship",
      40_000,
    );
    await page.eval(
      `document.querySelector('[data-board-column=merged] [data-home-action=delete-merged]').click()`,
    );
    await page.waitFor(`${dialogText}.includes('Delete 3 merged workspaces')`, 'Delete n merged');
    assert.doesNotMatch(await page.eval<string>(dialogText), /ABC-9/);
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    assert.match(
      await page.eval<string>(`${card(id('local'))}.innerText`),
      /Merged into your local main \(not pushed yet\)/,
    );
    await page.eval(`${card(id('local'))}.focus()`);
    await pressKey(page, 'Backspace');
    await page.waitFor(`${dialogText}.includes('Delete ABC-8')`, 'Delete workspace');
    await page.waitFor(
      `${dialogText}.includes('Merged into your local main (not pushed yet)')`,
      'the merged line',
    );
    const localDialog = await page.eval<string>(dialogText);
    assert.doesNotMatch(localDialog, /commits? not pushed|Also delete the local branch/);
    // Other warnings stay: its Claude still runs.
    assert.match(localDialog, /1 running session will be stopped/);
    assert.doesNotMatch(localDialog, /Commit and push first/);
    assert.match(localDialog, new RegExp(`and the local branch ${ws.local?.branch}`));
    await screenshot(page, screenshotDir, 'b7-merged-locally.png');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    fx.git(web, 'push', '-q', 'origin', 'main');
    await page.eval(`${card(id('local'))}.focus()`);
    await pressKey(page, 'Backspace');
    await page.waitFor(`${dialogText}.includes('✓ Merged into main')`, 'merged into main');
    await submitDialog(page);
    await page.waitFor(`!${card(id('local'))}`, 'the card gone', 30_000);
    assert.equal(fx.git(web, 'branch', '--list', ws.local?.branch as string), '', 'branch deleted');
    // Pushed, origin's main contains the caught-up branch too: still not merged, nothing to ship.
    await page.waitFor(`${columnOf(id('caught'))} === 'idle'`, 'caught up: idle', 40_000);
    assert.doesNotMatch(await page.eval<string>(`${card(id('caught'))}.innerText`), /Merged/);
    await page.eval(
      `document.querySelector('[data-board-column=merged] [data-home-action=delete-merged]').click()`,
    );
    await page.waitFor(`${dialogText}.includes('Delete 2 merged workspaces')`, 'Delete n merged');
    assert.doesNotMatch(await page.eval<string>(dialogText), /ABC-9/);
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');

    // 8e. Squash-merged (spec §14.2): its commit isn't in main, but merging it
    // would change nothing, so it is merged, and Delete says why.
    await create('squash', 'web', 'ABC-10 Squashed');
    const squashTree = ws.squash?.tree as string;
    // Two commits: one would equal the squash commit, which `git cherry` already sees.
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(squashTree, `squash-${n}.txt`), 'x\n');
      fx.git(squashTree, 'add', '-A');
      fx.git(squashTree, 'commit', '-q', '-m', `Add squash ${n}`);
    }
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('squash', 'Done');
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');
    await page.waitFor(`${columnOf(id('squash'))} === 'ship'`, 'its commits to ship', 30_000);
    fx.git(web, 'merge', '-q', '--squash', ws.squash?.branch as string);
    fx.git(web, 'commit', '-q', '-m', 'Squashed');
    fx.git(web, 'push', '-q', 'origin', 'main');
    await page.waitFor(`${columnOf(id('squash'))} === 'merged'`, 'squash-merged', 40_000);
    await page.eval(`${card(id('squash'))}.focus()`);
    await pressKey(page, 'Backspace');
    await page.waitFor(
      `${dialogText}.includes('Merged into main (its changes are already there, for example after a squash merge)')`,
      'the squash-merged line',
    );
    assert.doesNotMatch(
      await page.eval<string>(dialogText),
      /commits? not pushed|Also delete the local branch/,
    );
    await submitDialog(page);
    await page.waitFor(`!${card(id('squash'))}`, 'the card gone', 30_000);
    assert.equal(
      fx.git(web, 'branch', '--list', ws.squash?.branch as string),
      '',
      'branch deleted',
    );

    // 8d. Columns (spec §6.7): reorder by dragging a header and from its menu,
    // hide and show, the mark for a hidden Needs you, Reset.
    const main = app.main;
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board again');
    assert.deepEqual(await page.eval(shown), DEFAULT_ORDER, 'the default order');
    assert.deepEqual(await page.eval(columnIds('needs')), [id('perm')]);
    // Drag Needs you's header in front of Working: a line shows where it lands.
    const header = (column: string) => `document.querySelector('[data-board-column=${column}] h2')`;
    const from = await centre(page, header('needs'));
    const target = await page.eval<number>(
      `document.querySelector('[data-board-column=working]').getBoundingClientRect().left + 20`,
    );
    await mouse(page, 'mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) {
      await mouse(page, 'mouseMoved', Math.round(from.x + ((target - from.x) * i) / 8), from.y);
    }
    await page.waitFor(
      `document.querySelector('[data-home-board]').dataset.boardColumnDrag === 'needs'`,
      'the header lifted',
    );
    await page.waitFor(`!!document.querySelector('[data-board-column-drop]')`, 'the drop line');
    assert.equal(
      await page.eval(`document.querySelector('[data-board-column-drop]').dataset.boardColumnDrop`),
      '0',
    );
    // Not a card drag: no card lifts and no Drop to delete.
    assert.equal(
      await page.eval(`!!document.querySelector('[data-board-float], [data-drop-zone]')`),
      false,
    );
    await screenshot(page, screenshotDir, 'b8-column-drag.png');
    await mouse(page, 'mouseReleased', target, from.y);
    await page.waitFor(
      `${shown}.join() === 'needs,working,idle,ship,merged'`,
      'Needs you moved first',
    );
    assert.equal(await page.eval(`!!document.querySelector('dialog[open]')`), false);
    // A card still drags to delete, wherever its column is; Esc cancels it.
    await lift(page, id('perm'));
    await page.waitFor(`!!document.querySelector('[data-drop-zone]')`, 'the zone');
    assert.equal(
      await page.eval(`document.querySelector('[data-home-board]').dataset.boardColumnDrag`),
      undefined,
      'a card drag moves no column',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-board-float]')`, 'the drag to end');
    const there = await centre(page, card(id('perm')));
    await mouse(page, 'mouseReleased', there.x, there.y);
    assert.deepEqual(await page.eval(shown), ['needs', 'working', 'idle', 'ship', 'merged']);
    // The Needs you tint and the quick reply follow the column.
    assert.equal(await page.eval(tone('needs')), 'input');
    assert.ok(await page.eval(`!!${card(id('perm'))}.querySelector('[data-quick-reply]')`));

    // The keyboard: Tab from the Board reaches the first column's menu; Move Right.
    const menuButton = (column: string) => `[data-board-column-menu=${column}]`;
    const activeMenu = `(document.activeElement?.dataset?.boardColumnMenu ?? null)`;
    await page.eval(`document.querySelector('[data-home-board]').focus()`);
    await pressKey(page, 'Tab');
    assert.equal(await page.eval(activeMenu), 'needs');
    assert.equal(
      await page.eval(`getComputedStyle(document.activeElement).opacity`),
      '1',
      'the menu button shows on focus',
    );
    await chooseFromNextContextMenu(main, 'Move Right');
    await pressEnterOn(page);
    await page.waitFor(
      `${shown}.join() === 'working,needs,idle,ship,merged'`,
      'Needs you moved right',
    );
    assert.deepEqual(await main.eval(`globalThis.__lastMenu`), [
      'Move Left',
      'Move Right',
      'Hide Column',
    ]);
    await page.waitFor(`${activeMenu} === 'needs'`, 'focus kept on the moved column');
    // Hide Column: focus goes to the next shown column's menu.
    await page.eval(`document.querySelector('${menuButton('idle')}').focus()`);
    await chooseFromNextContextMenu(main, 'Hide Column');
    await pressEnterOn(page);
    await page.waitFor(`${shown}.join() === 'working,needs,ship,merged'`, 'Idle hidden');
    await page.waitFor(`${activeMenu} === 'ship'`, 'focus on the next column');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-columns]').textContent`),
      /Columns\s*· 1 hidden/,
    );
    // ← → follow the shown order: Working, Needs you, (empty Ready to ship), Merged.
    await page.eval(`${card(id('working'))}.focus()`);
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(activeCard), id('perm'));
    await pressKey(page, 'ArrowRight');
    assert.equal(await page.eval(columnOf(await page.eval<string>(activeCard))), 'merged');
    await pressKey(page, 'ArrowLeft');
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(activeCard), id('working'));

    // The Columns panel: every column in its order, Idle unticked; tick it to show it again.
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-panel]')`, 'the panel');
    assert.deepEqual(await page.eval(columnOptions), [
      'working:on',
      'needs:on',
      'idle:off',
      'ship:on',
      'merged:on',
    ]);
    const tick = (column: string) =>
      page.eval(`document.querySelector('[data-board-columns-option=${column}] input').click()`);
    await tick('idle');
    await page.waitFor(`${shown}.join() === 'working,needs,idle,ship,merged'`, 'Idle shown');
    assert.equal(await page.eval(`!!document.querySelector('[data-board-columns-hidden]')`), false);
    // Needs you hidden while something needs you: a mark in its color.
    assert.equal(await page.eval(columnsMark), null);
    await tick('needs');
    await page.waitFor(`!${shown}.includes('needs')`, 'Needs you hidden');
    await page.waitFor(`${columnsMark} === 'input'`, 'the mark');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-columns]').title`),
      /Needs you is hidden · 1 workspace needs you/,
    );
    // Its workspace is still in the sidebar.
    assert.ok(await page.eval(`!!document.querySelector('nav [data-nav-key="w:${id('perm')}"]')`));
    await screenshot(page, screenshotDir, 'b9-columns.png');
    // At least one column stays: the last one's box can't be unticked.
    for (const column of ['working', 'idle', 'ship']) await tick(column);
    await page.waitFor(`${shown}.join() === 'merged'`, 'only Merged');
    assert.deepEqual(await page.eval(columnOptions), [
      'working:off',
      'needs:off',
      'idle:off',
      'ship:off',
      'merged:last',
    ]);
    // Esc closes the panel and puts focus back on the button.
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-board-columns-panel]')`, 'closed');
    assert.equal(await page.eval(`document.activeElement?.dataset.boardColumns`), 'true');
    // The sidebar still shows the hidden columns' workspaces.
    for (const key of ['perm', 'working']) {
      assert.equal(
        await page.eval(`!!document.querySelector('nav [data-nav-key="w:${id(key)}"]')`),
        true,
        `${key} in the sidebar`,
      );
    }
    // Reset to default: today's order, all shown, no mark.
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-panel]')`, 'the panel');
    await page.eval(`document.querySelector('[data-board-columns-reset]').click()`);
    await page.waitFor(`${shown}.join() === ${JSON.stringify(DEFAULT_ORDER.join())}`, 'Reset');
    assert.equal(await page.eval(columnsMark), null);
    assert.equal(
      await page.eval(`document.querySelector('[data-board-columns-reset]').disabled`),
      true,
    );
    await pressKey(page, 'Escape');
    // Work's own layout, kept across the restart below: Idle hidden, Merged
    // moved left from a right click on its header.
    await page.eval(`document.querySelector('[data-board-columns]').click()`);
    await page.waitFor(`!!document.querySelector('[data-board-columns-panel]')`, 'the panel');
    await tick('idle');
    await pressKey(page, 'Escape');
    await chooseFromNextContextMenu(main, 'Move Left');
    await openContextMenu(page, '[data-board-column=merged] [data-board-column-header]');
    await page.waitFor(`${shown}.join() === 'working,needs,merged,ship'`, "Work's layout");

    // 9. Personal: the Board too (it never chose), and a suspended Claude resumed for a reply.
    await clickLabel(page, 'Select Personal');
    await create('sleepy', 'api', 'ABC-7 Pagination');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('sleepy', 'Done');
    await pressKey(page, 'Digit0', CMD);
    // Its own columns: the default, whatever Work did.
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, "Personal's Board");
    assert.deepEqual(await page.eval(shown), DEFAULT_ORDER);
    await page.waitFor(
      `!!${card(id('sleepy'))}?.querySelector('[data-suspended]')`,
      'suspended',
      30_000,
    );
    assert.equal(await page.eval(columnOf(id('sleepy'))), 'idle');
    // Its details say so, read from the keyboard.
    await page.eval(`${card(id('sleepy'))}.focus()`);
    await pressKey(page, 'Tab');
    await pressEnterOn(page);
    await page.waitFor(`!!document.querySelector('[data-card-details]')`, "sleepy's details");
    assert.equal(
      await page.eval(
        `document.querySelector('[data-card-details] [data-card-detail=suspend]')?.textContent`,
      ),
      SUSPENDED_TOOLTIP,
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-card-details]').innerText`),
      /^ABC-7 Pagination\n/,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-card-details]')`, 'closed');
    await page.eval(`document.activeElement?.blur()`);
    const startsBefore = read(`starts-${id('sleepy')}.txt`)
      .trim()
      .split('\n').length;
    await reply('sleepy', 'Resume and add page sizes');
    await until(
      () => read(`input-${id('sleepy')}.txt`).includes('Resume and add page sizes'),
      'the reply after the resume',
      40_000,
    );
    const starts = read(`starts-${id('sleepy')}.txt`)
      .trim()
      .split('\n');
    assert.equal(starts.length, startsBefore + 1, 'Claude started again');
    assert.match(starts.at(-1) ?? '', /--resume/);
    // Needs you, empty, looks like the others.
    assert.equal(await page.eval(tone('needs')), null);

    // 9b. What Claude asked (spec §6.7). At a gate: Claude's words there.
    await create('gate', 'api', 'ABC-8 Checkout spec');
    const spec = path.join(ws.gate?.tree as string, 'docs', 'specs', 'checkout', 'spec.md');
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, `---\nbranch: ${ws.gate?.branch}\nstatus: review\n---\n# Checkout\n`);
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'said');
    await typeInTerminal(page, 'stop');
    await waitState('gate', 'Awaiting approval');
    // At a gate without Claude's words: the gate's hint alone, as the status names the gate.
    await create('hint', 'api', 'ABC-10 Refund spec');
    const hintSpec = path.join(ws.hint?.tree as string, 'docs', 'specs', 'refund', 'spec.md');
    fs.mkdirSync(path.dirname(hintSpec), { recursive: true });
    fs.writeFileSync(hintSpec, `---\nbranch: ${ws.hint?.branch}\nstatus: review\n---\n# Refund\n`);
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await waitState('hint', 'Awaiting approval');
    // Claude's question tool: its options in place of the field.
    await create('asker', 'api', 'ABC-9 Brand color');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'ask');
    // Claude Code reports its menu as a permission request: shown as a question (spec §10.2).
    await waitState('asker', 'Asked a question');
    const askerRow = `document.querySelector('nav [data-nav-key="w:${id('asker')}"]')`;
    assert.deepEqual(
      await page.eval(
        `[...${askerRow}.querySelectorAll('.text-st-input')].map((e) => e.textContent)`,
      ),
      ['?', 'Question'],
      "the sidebar row's glyph and label in the input color",
    );
    await pressKey(page, 'Digit0', CMD);
    await page.waitFor(`!!${context('gate')}`, "the gate card's line");
    assert.equal(await page.eval(`${context('gate')}.dataset.quickReplyContext`), 'gate');
    assert.equal(
      await page.eval<string>(`${context('gate')}.textContent`),
      'At Spec review, Claude: Shall I use the brand blue?',
    );
    assert.equal(
      await page.eval(`!!${card(id('gate'))}.querySelector('[data-quick-reply]')`),
      true,
    );
    await page.waitFor(`!!${context('hint')}`, "the hint card's line");
    assert.equal(
      await page.eval<string>(`${context('hint')}.textContent`),
      'Review and approve the spec',
    );
    assert.match(await page.eval<string>(`${card(id('hint'))}.innerText`), /At\s*Spec review/);
    assert.doesNotMatch(
      await page.eval<string>(`${card(id('hint'))}.innerText`),
      /Spec review: Review/,
    );
    await page.waitFor(
      `!!${card(id('asker'))}.querySelector('[data-quick-reply-question]')`,
      'the question on its card',
    );
    assert.equal(await page.eval(columnOf(id('asker'))), 'needs');
    assert.equal(
      await page.eval<string>(`${context('asker')}.textContent`),
      'Claude asked: Which color do you prefer?',
    );
    assert.deepEqual(
      await page.eval(
        `[...${card(id('asker'))}.querySelectorAll('[data-question-option], [data-home-action=other]')].map((b) => b.textContent)`,
      ),
      ['Red', 'Blue', 'Green', 'Other…'],
    );
    // Its status: Asked a question in the input color, not Needs permission, nor the notice.
    const askerText = await page.eval<string>(`${card(id('asker'))}.innerText`);
    assert.match(askerText, /Asked a question/);
    assert.doesNotMatch(askerText, /Needs permission|Claude needs/);
    const inInput = (root: string) =>
      `[...${root}.querySelectorAll('.text-st-input')].some((e) => e.textContent === 'Asked a question')`;
    assert.equal(await page.eval(inInput(card(id('asker')))), true, 'the status in st-input');
    assert.equal(
      await page.eval(
        `${card(id('asker'))}.querySelector('[role=img]')?.getAttribute('aria-label')`,
      ),
      'Asked a question',
    );
    // Needs you in the input color: a question counts as input, the gate too.
    assert.equal(await page.eval(tone('needs')), 'input');
    await page.waitFor(`!!${context('asker')}`, "the question's line");
    // Typed text would answer the menu: no field, and not Open's permission note.
    assert.equal(
      await page.eval(`!!${card(id('asker'))}.querySelector('[data-quick-reply]')`),
      false,
    );
    assert.equal(
      await page.eval(`!!${card(id('asker'))}.querySelector('[data-quick-reply-open]')`),
      false,
    );
    await screenshot(page, screenshotDir, 'b3-question.png');
    // Its line opens the Responses panel at that entry, expanded, the question in it.
    await page.eval(`${context('asker')}.click()`);
    await page.waitFor(
      `document.querySelector('[data-response="1"]')?.dataset.expanded === 'true'`,
      'Responses at the entry',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-response="1"]').innerText`),
      /Claude asked[\s\S]*Which color do you prefer\?[\s\S]*Blue: Calm/,
    );
    await pressKey(page, 'Digit0', CMD);
    // An option answers it: its digit, which Claude Code's menu picks at once.
    await page.waitFor(
      `!!${card(id('asker'))}?.querySelector('[data-question-option="1"]')`,
      'Blue',
    );
    await page.eval(`${card(id('asker'))}.querySelector('[data-question-option="1"]').click()`);
    assert.equal((await waitForFile(file(`answer-${id('asker')}.txt`))).trim(), '2');
    await page.waitFor(
      `${card(id('asker'))}?.querySelector('[data-quick-reply-sent]')?.textContent.includes('Answered: Blue')`,
      'Answered: Blue',
    );
    await waitState('asker', 'Done');
    await page.waitFor(
      `!${card(id('asker'))}.querySelector('[data-quick-reply-question]')`,
      'the question gone',
    );
    assert.equal(await page.eval(columnOf(id('gate'))), 'needs');

    // 10. Each profile's columns are remembered across a restart.
    await app.stop();
    app = await launch();
    page = app.page;
    await page.waitFor(`!!document.querySelector('[data-home-board]')`, 'the Board');
    await clickLabel(page, 'Select Work');
    await page.waitFor(`${shown}.join() === 'working,needs,merged,ship'`, "Work's Board");
    // Work's columns as it left them.
    assert.deepEqual(await page.eval(shown), ['working', 'needs', 'merged', 'ship']);
    assert.match(
      await page.eval<string>(`document.querySelector('[data-board-columns]').textContent`),
      /1 hidden/,
    );
    await clickLabel(page, 'Select Personal');
    await page.waitFor(
      `${shown}.join() === ${JSON.stringify(DEFAULT_ORDER.join())}`,
      'Personal on the Board',
    );
    assert.deepEqual(await page.eval(shown), DEFAULT_ORDER, "Personal's columns, the default");

    console.log('e2e-board: ok');
  } catch (error) {
    // What the window showed, for the failure's context.
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
