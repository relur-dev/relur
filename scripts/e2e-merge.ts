/**
 * End-to-end test of Merge into the base (spec §14.4): a workspace whose
 * branch contains main is fast-forwarded from the Changes panel (main moves
 * in the main checkout, its branch stays, and the card goes to Merged); a
 * diverged one is merged from its Board card: Claude gets the rebase prompt,
 * the card says "Rebasing for merge…", the fake claude rebases and ends its
 * turn with "Ready to merge.", and the app fast-forwards main. Cancel stops
 * waiting: Claude's later rebase moves nothing. The base is never pushed.
 * Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-merge.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  clickLabel,
  launchApp,
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
const columnOf = (id: string) =>
  `(${card(id)}?.closest('[data-board-column]')?.dataset.boardColumn ?? null)`;

async function until(check: () => boolean, what: string, timeoutMs = 30_000) {
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
    const { clone: web } = fx.cloneWithRemote('web', 'main');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: runs SessionStart, notes its workspace and
    // worktree, turns typed words into hooks, and records every other line.
    // Merge's prompts (a paste, one line) it acts on as Claude would: a
    // rebase or a merge of the local base, then Stop with "Ready to merge.".
    // While $HOME/hold exists it waits before doing so.
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
echo "fake claude"
esc=$(printf '\\033')
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d "$esc"); line=\${line#\\[200~}; line=\${line%\\[201~}
  case "$line" in
    prompt) hook UserPromptSubmit '{"prompt":"Fix it"}' ;;
    stop) hook Stop '{"last_assistant_message":"Done."}' ;;
    Rebase*|Merge*)
      printf '%s\\n' "$line" >> "$HOME/input-$id.txt"
      hook UserPromptSubmit '{"prompt":"merge"}'
      sleep 2
      while [ -f "$HOME/hold" ]; do sleep 0.2; done
      base=$(printf '%s' "$line" | sed -n 's/.*run git rebase \\([^ ]*\\) .*/\\1/p')
      if [ -n "$base" ]; then git rebase -q "$base" > /dev/null 2>&1
      else git merge -q --no-edit "$(printf '%s' "$line" | sed -n 's/.*run git merge \\([^ ]*\\) .*/\\1/p')" > /dev/null 2>&1
      fi
      hook Stop '{"last_assistant_message":"Rebased, the checks pass.\\n\\nReady to merge."}' ;;
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
        ],
      }),
    );
    const file = (name: string) => path.join(fx.root, name);
    const read = (name: string) =>
      fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';
    const tip = (dir: string, ref: string) => fx.git(dir, 'rev-parse', ref).trim();
    /** A commit of `name` in `dir`. */
    const commit = (dir: string, name: string) => {
      fs.writeFileSync(path.join(dir, name), `${name}\n`);
      fx.git(dir, 'add', name);
      fx.git(dir, 'commit', '-q', '-m', `add ${name}`);
    };
    const originMain = tip(web, 'origin/main');

    app = await launchApp({ env: withDisplayEnv({ ...fx.env }), dev: devMode, electronArgs });
    const page = app.page;
    await page.waitFor(
      `document.querySelector('[data-home-overview]')?.dataset.homeOverview === 'empty'`,
      'All clear',
    );

    const ws: Record<string, { id: string; tree: string }> = {};
    const create = async (key: string, task: string) => {
      const before = new Set(fs.readdirSync(fx.root).filter((f) => f.startsWith('tree-')));
      await clickLabel(page, 'New workspace in web');
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
      ws[key] = {
        id: found.slice('tree-'.length, -'.txt'.length),
        tree: (await waitForFile(file(found))).trim(),
      };
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${task}`,
      );
    };
    const id = (key: string) => ws[key]?.id as string;
    const tree = (key: string) => ws[key]?.tree as string;
    const sidebarState = (key: string) =>
      `(document.querySelector('nav [data-nav-key="w:${id(key)}"]')?.title.split('\\n')[1] ?? '')`;
    const waitState = (key: string, state: string) =>
      page.waitFor(`${sidebarState(key)}.startsWith(${JSON.stringify(state)})`, `${key}: ${state}`);
    /** Claude did its work and committed it; its turn ended. */
    const workDone = async (key: string, name: string) => {
      await typeInTerminal(page, 'prompt');
      await waitState(key, 'Working');
      commit(tree(key), name);
      await typeInTerminal(page, 'stop');
      await waitState(key, 'Done');
    };
    const branchOf = (key: string) => fx.git(tree(key), 'branch', '--show-current').trim();

    // 1. A fast-forward from the Changes panel.
    await create('fast', 'ABC-1 Fast forward');
    await workDone('fast', 'fast.txt');
    await pressShortcut(page, 'changes');
    await page.waitFor(`!!document.querySelector('[data-finish]')`, 'the Changes panel');
    const mergeAll = `document.querySelector('[data-merge="all"]')`;
    await page.waitFor(`!!${mergeAll} && !${mergeAll}.disabled`, 'Merge into main');
    assert.equal(await page.eval<string>(`${mergeAll}.textContent`), 'Merge into main');
    await page.eval(`${mergeAll}.click()`);
    await page.waitFor(
      `document.querySelector('[data-merge-outcome]')?.dataset.mergeOutcome === 'merged'`,
      'the merge outcome',
    );
    assert.equal(tip(web, 'main'), tip(tree('fast'), 'HEAD'), 'main is fast-forwarded');
    assert.equal(fx.git(web, 'branch', '--show-current').trim(), 'main', 'its branch stays');
    assert.ok(fs.existsSync(path.join(web, 'fast.txt')), 'the main checkout has the change');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-merge-outcome]').textContent`),
      /Merged into your local main/,
    );
    await screenshot(page, screenshotDir, 'merge-changes-panel.png');
    await page.eval(`document.querySelector('[data-merge-dismiss]').click()`);
    await page.waitFor(`!document.querySelector('[data-merge-outcome]')`, 'the outcome dismissed');
    await pressShortcut(page, 'changes');
    await pressShortcut(page, 'home');
    await page.waitFor(`${columnOf(id('fast'))} === 'merged'`, 'the fast card under Merged');

    // 2. A diverged branch, merged from its Board card: Claude rebases first.
    await create('diverged', 'ABC-2 Diverged');
    await workDone('diverged', 'diverged.txt');
    commit(web, 'other.txt');
    const mainBefore = tip(web, 'main');
    await pressShortcut(page, 'home');
    const cardMerge = `${card(id('diverged'))}?.querySelector('[data-home-action=merge]')`;
    await page.waitFor(
      `${columnOf(id('diverged'))} === 'ship' && !!${cardMerge} && !${cardMerge}.disabled`,
      'Merge on the Ready to ship card',
    );
    assert.equal(await page.eval<string>(`${cardMerge}.textContent`), 'Merge into main');
    await page.eval(`${cardMerge}.click()`);
    await page.waitFor(
      `${columnOf(id('diverged'))} === 'working' && ${card(id('diverged'))}.innerText.includes('Rebasing for merge…')`,
      '"Rebasing for merge…" on the working card',
    );
    await screenshot(page, screenshotDir, 'merge-rebasing-card.png');
    await until(() => read(`input-${id('diverged')}.txt`).includes('Rebase '), 'the prompt');
    const prompt = read(`input-${id('diverged')}.txt`);
    assert.match(prompt, new RegExp(`^Rebase ${branchOf('diverged')} onto the local main branch`));
    assert.match(prompt, /run git rebase main /);
    assert.match(prompt, /"Ready to merge\."/);
    await page.waitFor(
      `${columnOf(id('diverged'))} === 'merged'`,
      'the diverged card under Merged',
      30_000,
    );
    assert.equal(tip(web, 'main'), tip(tree('diverged'), 'HEAD'), 'main has the rebased branch');
    assert.ok(fx.git(web, 'merge-base', '--is-ancestor', mainBefore, 'main') === '');
    assert.ok(fs.existsSync(path.join(web, 'diverged.txt')));

    // 3. Cancel stops waiting: Claude's rebase afterwards moves nothing.
    await create('cancel', 'ABC-3 Cancelled');
    await workDone('cancel', 'cancel.txt');
    commit(web, 'another.txt');
    const mainAtCancel = tip(web, 'main');
    fs.writeFileSync(file('hold'), '');
    await pressShortcut(page, 'changes');
    await page.waitFor(`!!${mergeAll} && !${mergeAll}.disabled`, 'Merge into main again');
    await page.eval(`${mergeAll}.click()`);
    await page.waitFor(`!!document.querySelector('[data-merge-progress]')`, 'Rebasing for merge…');
    assert.equal(
      await page.eval<string>(`document.querySelector('[data-merge-progress]').textContent`),
      'Rebasing for merge…',
    );
    await page.eval(`document.querySelector('[data-merge-cancel]').click()`);
    await page.waitFor(`!document.querySelector('[data-merge-progress]')`, 'the wait cancelled');
    fs.rmSync(file('hold'));
    await waitState('cancel', 'Done');
    await sleep(1500);
    assert.equal(tip(web, 'main'), mainAtCancel, 'main stays after Cancel');
    // Rebased by Claude, it is a plain fast-forward now.
    await page.waitFor(`!!${mergeAll} && !${mergeAll}.disabled`, 'Merge offered again');

    assert.equal(tip(web, 'origin/main'), originMain, 'the base is never pushed');
    console.log('e2e-merge: ok');
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
