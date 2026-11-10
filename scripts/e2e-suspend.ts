/**
 * End-to-end test of suspending idle sessions (spec §9.8), with a fake
 * `claude` and a one-second minute: the setting in Edit profile; an idle
 * workspace suspended after the delay (Claude and a process it started gone),
 * never one that is shown, working, has a background command or a draft, or
 * is kept running, while the mouse over its terminal is no draft; why each
 * isn't (a Board card's tooltip in the project view), the suspended ones by name in the
 * memory panel, and app.log; resuming on open (`--resume` with the session
 * id, "Resuming…", keys blocked, then typed); Esc on the memory panel over a
 * Claude terminal; a main checkout's Claude; and the start, where only the
 * opened and the continued workspaces resume, with the mark on Home.
 *
 *   tsx scripts/e2e-suspend.ts [--dev] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { envVar } from '../src/shared/brand';
import { NEW_CONVERSATION_NOTE, SUSPENDED_TOOLTIP } from '../src/shared/suspend';
import {
  type Cdp,
  chooseFromNextContextMenu,
  clickButtonText,
  clickClosingButton,
  clickLabel,
  dialogText,
  launchApp,
  openContextMenu,
  pressKey,
  ptyRecords,
  type RunningApp,
  recordPtys,
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

/** A minute lasts this long here: "after 5 minutes" is 5 seconds. */
const MINUTE_MS = 1000;
const DELAY_MS = 5 * MINUTE_MS;

/** The sidebar row of a workspace, by its name, as an expression. */
const row = (name: string) =>
  `[...document.querySelectorAll('nav [data-nav-key^="w:"]')].find((b) => b.title.split('\\n')[0] === ${JSON.stringify(name)})`;
const suspendedRow = (name: string) => `(${row(name)})?.dataset.suspended === 'true'`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
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
    const api = fx.localRepo('api');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: passes the setup check, records how it was
    // started, its folder, its pid and a child it starts, runs SessionStart
    // (after 3 s while `slow-start` exists) with its transcript's path (none
    // while `no-transcript-path` exists), turns on mouse tracking as Claude
    // Code does (any motion, SGR reports), turns `prompt`, `done` and
    // `background` into their hooks, ends at `exit`, and records every other
    // line typed into it. As Claude Code, it writes its transcript at the
    // first prompt, and a resume without one fails with Claude's message.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
settings=""; sid="fake-$$"; prev=""; resume=0
for arg in "$@"; do
  [ "$prev" = --settings ] && settings="$arg"
  { [ "$prev" = --session-id ] || [ "$prev" = --resume ]; } && sid="$arg"
  [ "$prev" = --resume ] && resume=1
  prev="$arg"
done
transcript="$HOME/transcripts/$sid.jsonl"
if [ "$resume" = 1 ] && [ ! -e "$transcript" ]; then
  echo "$*" >> "$HOME/starts-$(basename "$PWD").txt"
  echo "No conversation found with session ID: $sid"
  exit 1
fi
path_json=",\\"transcript_path\\":\\"$transcript\\""
[ -e "$HOME/no-transcript-path" ] && path_json=""
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1" > /dev/null; }
name=$(basename "$PWD")
echo "$*" >> "$HOME/starts-$name.txt"
echo "$PWD" > "$HOME/cwd-$name.txt"
echo $$ > "$HOME/pid-$name.txt"
sleep 600 &
echo $! > "$HOME/child-$name.txt"
[ -e "$HOME/slow-start" ] && sleep 3
hook SessionStart "{\\"session_id\\":\\"$sid\\"$path_json}"
printf '\\033[?1003h\\033[?1006h'
echo "fake claude in $name"
while IFS= read -r line; do
  case "$line" in
    prompt)
      mkdir -p "$HOME/transcripts"
      echo '{"type":"user","message":{"role":"user","content":"Fix the login"}}' >> "$transcript"
      hook UserPromptSubmit '{"prompt":"Fix the login"}' ;;
    exit) exit 0 ;;
    done) hook Stop '{}' ;;
    background) hook Stop '{"background_tasks":[{"type":"shell","status":"running","command":"npm run dev"}]}' ;;
    *) printf '%s\\n' "$line" >> "$HOME/input-$name.txt" ;;
  esac
done
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
          // Work continues interrupted work at start (spec §9.7).
          ...(p.id === 'work' ? { resume: { continueAtStart: true } } : {}),
        })),
        projects: [{ id: 'api', profileId: 'work', name: 'api', repoPath: api, remote: null }],
      }),
    );
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const file = (name: string) => path.join(fx.root, name);
    const read = (name: string) =>
      fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '';
    const starts = (name: string) => read(`starts-${name}.txt`).trim().split('\n').filter(Boolean);
    const pidOf = (name: string, what: 'pid' | 'child' = 'pid') =>
      Number(read(`${what}-${name}.txt`).trim());
    /** The id the first start chose (`--session-id`, spec §9.4). */
    const sessionIdOf = (name: string) => starts(name)[0]?.match(/--session-id (\S+)/)?.[1] ?? '';

    const appLog = () => {
      const log = path.join(path.dirname(configFile), 'app.log');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    };
    /** A card's line on suspension in its tooltip, in the project view's Board (spec §9.8). */
    const suspendNote = (name: string) =>
      page.eval<string | null>(
        `document.querySelector('main [data-board-card="${ids[name]}"]')?.dataset.suspendNote ?? null`,
      );
    /** A real click: the pointer moves there, presses and releases. */
    const click = async (page: Cdp, selector: string) => {
      const at = await page.eval<{ x: number; y: number }>(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
        await page.send('Input.dispatchMouseEvent', {
          type,
          ...at,
          button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
        });
      }
    };
    const uncaughtLog = file('uncaught.log');
    const launch = async () => {
      app = await launchApp({
        env: withDisplayEnv({ ...fx.env, [envVar('SUSPEND_MINUTE_MS')]: String(MINUTE_MS) }),
        dev: devMode,
        electronArgs,
      });
      await app.main.eval(`void process.on('uncaughtException', (e) =>
        process.mainModule.require('node:fs').appendFileSync(${JSON.stringify(uncaughtLog)}, String(e?.stack ?? e) + '\\n'))`);
      return app;
    };
    const ids: Record<string, string> = {};
    const expandApi = (page: Cdp) =>
      page.eval(
        `document.querySelector('[data-nav-key="p:api"] button[aria-label="Expand"]')?.click()`,
      );
    /** Opens a workspace from the sidebar and waits for its terminal. */
    const open = async (page: Cdp, name: string) => {
      await expandApi(page);
      await page.waitFor(`!!(${row(name)})`, `the row of ${name}`);
      await page.eval(`(${row(name)}).click()`);
      await page.waitFor(
        `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
        `the terminal of ${name}`,
      );
    };
    /** The shown terminal's text. */
    const screenOf = `(() => {
      const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((e) => e.offsetParent);
      const buf = t?.xterm?.buffer.active;
      let text = '';
      for (let y = 0; buf && y < buf.length; y++) text += (buf.getLine(y)?.translateToString(true) ?? '') + '\\n';
      return text;
    })()`;
    const stateOf = (name: string) => `((${row(name)})?.title.split('\\n')[1] ?? '')`;
    const waitState = (page: Cdp, name: string, state: string) =>
      page.waitFor(`${stateOf(name)}.startsWith(${JSON.stringify(state)})`, `${name}: ${state}`);
    const newWorkspace = async (page: Cdp, task: string, branch: string) => {
      await clickLabel(page, 'New workspace in api');
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, `the workspace ${task}`);
      await waitForFile(file(`starts-${branch}.txt`));
      await page.waitFor(`!!(${row(task)})`, `the row of ${task}`);
      ids[task] = (await page.eval<string>(`(${row(task)}).dataset.navKey`)).slice(2);
    };
    const showProject = async (page: Cdp) => {
      await page.eval(`document.querySelector('[data-nav-key="p:api"] [data-nav-focus]').click()`);
      await page.waitFor(`!!document.querySelector('main [data-board-card]')`, 'the project view');
    };

    // 1. Workspaces with Claude in each, suspension still off.
    let running = await launch();
    let { page } = running;
    await recordPtys(running.main);
    for (const [task, branch] of [
      ['Alpha', 'alpha'],
      ['Bravo', 'bravo'],
      ['Charlie', 'charlie'],
      ['Delta', 'delta'],
      ['Golf', 'golf'],
      ['Echo', 'echo'],
      ['Foxtrot', 'foxtrot'],
    ] as const) {
      await newWorkspace(page, task, branch);
    }
    // Alpha is done; Bravo works; Charlie is done with a command in the
    // background; Delta is kept running; Golf has a draft; Echo stays shown;
    // Foxtrot never got a prompt, so Claude saved no conversation.
    await open(page, 'Alpha');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Alpha', 'Working');
    await typeInTerminal(page, 'done');
    await waitState(page, 'Alpha', 'Done');
    // The mouse moves over its terminal: Claude gets the reports, which are no draft.
    const terminalBox = await page.eval<{ x: number; y: number; width: number; height: number }>(
      `(() => { const r = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    for (let i = 1; i <= 5; i++) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: terminalBox.x + (terminalBox.width * i) / 6,
        y: terminalBox.y + (terminalBox.height * i) / 6,
      });
    }
    const alphaInput = async () =>
      (await ptyRecords(running.main)).find((r) => path.basename(r.cwd) === 'alpha')?.input ?? '';
    for (const end = Date.now() + 5000; !(await alphaInput()).includes('\x1b[<35;'); ) {
      if (Date.now() > end) throw new Error('the mouse reports never reached Alpha');
      await sleep(100);
    }
    await open(page, 'Bravo');
    await typeInTerminal(page, 'prompt');
    await waitState(page, 'Bravo', 'Working');
    await open(page, 'Charlie');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'background');
    await waitState(page, 'Charlie', 'Done · 1 still running');
    await open(page, 'Delta');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'done');
    await waitState(page, 'Delta', 'Done');
    await open(page, 'Golf');
    await typeInTerminal(page, 'half a prompt', false);
    await chooseFromNextContextMenu(running.main, 'Keep Claude Running');
    await openContextMenu(page, `[data-nav-key="w:${ids.Delta}"]`);
    await sleep(300);
    await open(page, 'Echo');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'done');
    await waitState(page, 'Echo', 'Done');

    // The setting: Edit profile › General, Off as seeded; 5 minutes is written.
    await chooseFromNextContextMenu(running.main, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Work"]');
    await page.waitFor(`!!document.querySelector('dialog[open] #edit-profile-suspend')`, 'Edit');
    assert.equal(await page.eval(`document.querySelector('#edit-profile-suspend').value`), 'off');
    await page.eval(`(() => {
      const select = document.querySelector('#edit-profile-suspend');
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(select, '5');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');
    const work = readConfig().profiles.find((p: { id: string }) => p.id === 'work');
    assert.equal(work.suspendIdleMin, 5, 'the delay is written');
    const settingOn = Date.now();

    // 2. Alpha is suspended after the delay: Claude and its child are gone.
    const alphaPid = pidOf('alpha');
    const alphaChild = pidOf('alpha', 'child');
    assert.ok(alive(alphaPid) && alive(alphaChild), "Alpha's Claude runs");
    await expandApi(page);
    await page.waitFor(suspendedRow('Alpha'), 'Alpha suspended', DELAY_MS + 15_000);
    assert.ok(Date.now() - settingOn >= DELAY_MS - 500, 'not before the delay');
    await until(() => !alive(alphaPid) && !alive(alphaChild), "Alpha's processes to end");
    const alphaTip = await page.eval<string>(`(${row('Alpha')}).title`);
    assert.ok(alphaTip.split('\n')[1]?.startsWith('Done'), 'the state stays');
    assert.ok(alphaTip.endsWith(SUSPENDED_TOOLTIP), alphaTip);
    assert.match(await page.eval<string>(`(${row('Alpha')}).innerText`), /Suspended/);
    // Never while shown, working, with background work, a draft, kept
    // running, or without a saved conversation.
    await sleep(DELAY_MS);
    for (const name of ['Bravo', 'Charlie', 'Delta', 'Golf', 'Echo', 'Foxtrot']) {
      assert.equal(await page.eval(suspendedRow(name)), false, `${name} isn't suspended`);
      assert.ok(alive(pidOf(name.toLowerCase())), `${name}'s Claude runs`);
    }
    // The project view's Board and the memory panel say so too.
    await showProject(page);
    await page.waitFor(
      `!!document.querySelector('main [data-board-card="${ids.Alpha}"] [data-suspended]')`,
      "Suspended on the project's Board",
    );
    // A card's tooltip says why each running one isn't suspended, or when it will be.
    await page.waitFor(
      `!!document.querySelector('main [data-board-card="${ids.Golf}"]')?.dataset.suspendNote`,
      'the tooltips',
    );
    assert.equal(await suspendNote('Golf'), 'Not suspended: a draft in the prompt');
    assert.equal(await suspendNote('Charlie'), 'Not suspended: background work running');
    assert.equal(await suspendNote('Delta'), 'Not suspended: Keep Claude Running is on');
    assert.equal(await suspendNote('Bravo'), "Not suspended: Claude isn't idle");
    assert.equal(await suspendNote('Foxtrot'), 'Not suspended: no conversation yet');
    // Echo's clock runs once the window no longer shows it (read again every 15 s).
    await page.waitFor(
      `/^Suspended in \\d+ min if it stays idle$/.test(document.querySelector('main [data-board-card="${ids.Echo}"]')?.dataset.suspendNote)`,
      "Echo's clock",
      20_000,
    );
    assert.equal(await suspendNote('Alpha'), null, 'none on a suspended one');
    assert.match(
      await page.eval<string>(
        `document.querySelector('main [data-board-card="${ids.Golf}"]').title`,
      ),
      /\nNot suspended: a draft in the prompt\n/,
    );
    assert.match(
      await page.eval<string>(
        `document.querySelector('main [data-board-card="${ids.Alpha}"]').title`,
      ),
      new RegExp(`\\n${SUSPENDED_TOOLTIP}\\n`),
    );
    await page.waitFor(`!!document.querySelector('button[data-memory]')`, 'Memory', 20_000);
    await page.eval(`document.querySelector('button[data-memory]').click()`);
    await page.waitFor(
      `document.querySelector('[data-memory-panel] [data-memory-suspended]')?.textContent.startsWith('1 session suspended to save memory')`,
      'the memory panel',
    );
    // By name, with its project.
    assert.deepEqual(
      await page.eval<string[]>(
        `[...document.querySelectorAll('[data-memory-suspended-list] li')].map((li) => li.innerText.replace(/\\s+/g, ' '))`,
      ),
      ['Alpha api'],
    );
    // app.log: the clock, its resets with the reason, and the suspend.
    const log = appLog();
    for (const line of [
      'suspend Alpha (Work): eligible: suspended after 5 min idle',
      'suspend Alpha (Work): suspended after 5 min idle',
      'suspend Golf (Work): not suspended: a draft in the prompt',
      'suspend Charlie (Work): not suspended: background work running',
      'suspend Delta (Work): not suspended: Keep Claude Running is on',
      'suspend Echo (Work): not suspended: shown in a window',
      'suspend Foxtrot (Work): not suspended: no conversation yet',
    ]) {
      assert.ok(log.includes(` ${line}\n`), `app.log has "${line}":\n${log}`);
    }
    await page.eval(`document.querySelector('button[data-memory]').click()`);
    await page.waitFor(`!document.querySelector('[data-memory-panel]')`, 'the panel to close');

    // 3. Keep Claude Running off again: Delta is suspended after the delay.
    await chooseFromNextContextMenu(running.main, 'Keep Claude Running');
    await openContextMenu(page, `[data-nav-key="w:${ids.Delta}"]`);
    await page.waitFor(suspendedRow('Delta'), 'Delta suspended', DELAY_MS + 15_000);

    // 4. Opening Alpha resumes it with its session id; keys typed meanwhile
    // are blocked, with the note, and nothing reaches Claude until it's ready.
    fs.writeFileSync(file('slow-start'), '');
    await open(page, 'Alpha');
    await page.waitFor(`!!document.querySelector('[data-resuming]')`, 'Resuming…');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-resuming]').innerText`),
      /Resuming…/,
    );
    await until(() => starts('alpha').length === 2, 'Alpha to start again');
    assert.ok(
      starts('alpha')[1]?.includes(`--resume ${sessionIdOf('alpha')}`),
      `resumed with its session id: ${starts('alpha')[1]}`,
    );
    await sleep(500);
    await typeInTerminal(page, 'early');
    await page.waitFor(
      `!!document.querySelector('[data-resuming-blocked]')`,
      'the note that keys are blocked',
    );
    fs.rmSync(file('slow-start'));
    await page.waitFor(`!document.querySelector('[data-resuming]')`, 'Claude ready', 20_000);
    await typeInTerminal(page, 'late');
    await until(() => read('input-alpha.txt').includes('late'), 'the late keys');
    assert.ok(!read('input-alpha.txt').includes('early'), 'the early keys went nowhere');
    assert.equal(await page.eval(suspendedRow('Alpha')), false);
    assert.ok(appLog().includes(' suspend Alpha (Work): resumed: shown in a window\n'));

    // The memory panel over Alpha's Claude terminal (spec §6.14): a click
    // opens it in focus, Esc closes it, focus goes back to the button, and
    // the Esc never reaches Claude.
    const memoryPanel = `document.querySelector('[data-memory-panel]')`;
    const memoryButton = `document.querySelector('footer [data-memory]')`;
    await typeInTerminal(page, 'before', false);
    await click(page, 'footer [data-memory]');
    await page.waitFor(
      `!!${memoryPanel} && document.activeElement === ${memoryPanel}`,
      'the memory panel in focus over the terminal',
    );
    await sleep(500);
    assert.equal(await page.eval(`document.activeElement === ${memoryPanel}`), true);
    await pressKey(page, 'Escape');
    await page.waitFor(
      `!${memoryPanel} && document.activeElement === ${memoryButton}`,
      'Esc to close the panel over the terminal',
    );
    // With the terminal in focus while it is open, Esc still closes it.
    await click(page, 'footer [data-memory]');
    await page.waitFor(`!!${memoryPanel}`, 'the panel again');
    await page.eval(
      `[...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent).querySelector('.xterm-helper-textarea').focus()`,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(
      `!${memoryPanel} && document.activeElement === ${memoryButton}`,
      'Esc with the terminal in focus',
    );
    await typeInTerminal(page, '-after');
    await until(
      () => read('input-alpha.txt').split('\n').includes('before-after'),
      'the line typed around the panel, without an Esc in it',
    );

    // 5. A main checkout's Claude: started with hooks and its own session id,
    // suspended, once it has a conversation, while its tab isn't shown,
    // resumed when it is.
    await showProject(page);
    await clickButtonText(page, 'Start Claude here');
    await waitForFile(file('starts-api.txt'));
    assert.match(starts('api')[0] ?? '', /^--settings .+ --session-id \S+/);
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'done');
    await until(
      () => read('transcripts/' + sessionIdOf('api') + '.jsonl') !== '',
      'its transcript',
    );
    const mainPid = pidOf('api');
    await open(page, 'Echo');
    await until(() => !alive(mainPid), "the main checkout's Claude suspended", DELAY_MS + 15_000);
    await showProject(page);
    await page.waitFor(
      `!!document.querySelector('[role=tab][data-suspended]')`,
      'the Suspended tab',
    );
    await page.eval(`document.querySelector('[role=tab][data-suspended]').click()`);
    await until(() => starts('api').length === 2, "the main checkout's Claude resumed");
    assert.ok(starts('api')[1]?.includes(`--resume ${sessionIdOf('api')}`), starts('api')[1]);

    // 6. A conversation that was never saved, as older builds left one:
    // Claude ended, and a resume of its session id would fail. Start Claude
    // starts a new conversation with that id instead, in the same tab, with
    // the note.
    const claudeTabs = () =>
      page.eval<number>(
        `[...document.querySelectorAll('[role=tab]')].filter((t) => t.title.includes('· claude')).length`,
      );
    const note = `document.querySelector('[data-session-note]')?.innerText ?? ''`;
    const startClaude = async (name: string) => {
      await typeInTerminal(page, 'exit');
      await page.waitFor(
        `[...document.querySelectorAll('button')].some((b) => b.textContent === 'Start Claude')`,
        `Start Claude in ${name}`,
      );
      await clickButtonText(page, 'Start Claude');
    };
    await open(page, 'Foxtrot');
    await startClaude('Foxtrot');
    await until(() => starts('foxtrot').length === 2, 'Foxtrot started again');
    assert.match(starts('foxtrot')[1] ?? '', new RegExp(`--session-id ${sessionIdOf('foxtrot')}`));
    assert.ok(!starts('foxtrot')[1]?.includes('--resume'), starts('foxtrot')[1]);
    await page.waitFor(`${note}.includes(${JSON.stringify(NEW_CONVERSATION_NOTE)})`, 'the note');
    assert.equal(await claudeTabs(), 1, 'no second Claude tab');
    // Where Claude never said where its transcript is, the resume is tried:
    // it fails as Claude's does, and a new conversation starts in that tab.
    fs.writeFileSync(file('no-transcript-path'), '');
    await newWorkspace(page, 'Hotel', 'hotel');
    await open(page, 'Hotel');
    await page.waitFor(`(${screenOf}).includes('fake claude in hotel')`, 'Hotel ready');
    fs.rmSync(file('no-transcript-path'));
    await startClaude('Hotel');
    await until(() => starts('hotel').length === 3, 'Hotel started anew');
    assert.ok(starts('hotel')[1]?.includes(`--resume ${sessionIdOf('hotel')}`), starts('hotel')[1]);
    const hotelId = starts('hotel')[2]?.match(/--session-id (\S+)/)?.[1] ?? '';
    assert.ok(hotelId && hotelId !== sessionIdOf('hotel'), starts('hotel')[2]);
    await page.waitFor(`${note}.includes(${JSON.stringify(NEW_CONVERSATION_NOTE)})`, 'its note');
    assert.equal(await claudeTabs(), 1, 'no second Claude tab in Hotel');
    // Its next start doesn't try that resume again: Claude said where its
    // transcript would be, and there is none.
    await page.waitFor(`(${screenOf}).includes('fake claude in hotel')`, 'Hotel ready again');
    await startClaude('Hotel');
    await until(() => starts('hotel').length === 4, 'Hotel started again');
    assert.match(starts('hotel')[3] ?? '', new RegExp(`--session-id ${hotelId}`));
    assert.equal(await claudeTabs(), 1);
    assert.ok(!appLog().includes('resume failed'), appLog());

    // 7. Quit with Bravo working (continued at start), Alpha and Echo idle
    // (Alpha with a file not committed), Charlie with a background command,
    // Delta suspended.
    fs.writeFileSync(path.join(read('cwd-alpha.txt').trim(), 'notes.txt'), 'draft\n');
    await open(page, 'Echo');
    await running.main.eval(
      process.platform === 'darwin'
        ? `void setTimeout(() => process.mainModule.require('electron').Menu.sendActionToFirstResponder('terminate:'))`
        : `void setTimeout(() => process.mainModule.require('electron').app.quit())`,
    );
    await page.waitFor(`${dialogText}.includes('running session')`, 'the quit dialog');
    assert.ok(
      !(await page.eval<string>(dialogText)).includes('Delta'),
      'a suspended session is not listed',
    );
    await clickClosingButton(page, 'Quit', `document.querySelector('dialog[open]')`);
    page.close();
    running.main.close();
    assert.ok(await running.exited(20_000), 'the app quit');
    app = undefined;
    const branches = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'golf'] as const;
    const before = Object.fromEntries(branches.map((b) => [b, starts(b).length])) as Record<
      (typeof branches)[number],
      number
    >;

    // 8. Start: the window shows Echo, as at quit (spec §5), so Echo and
    // Bravo, continued with §9.7, resume; the rest start suspended until opened.
    running = await launch();
    ({ page } = running);
    await until(() => starts('bravo').length === before.bravo + 1, 'Bravo resumed', 30_000);
    await until(
      () => read('input-bravo.txt').includes('Continue where you left off.'),
      'the continue prompt',
      30_000,
    );
    await until(() => starts('echo').length === before.echo + 1, 'Echo, shown, resumed', 30_000);
    await sleep(2000);
    for (const branch of ['alpha', 'charlie', 'delta', 'golf'] as const) {
      assert.equal(starts(branch).length, before[branch], `${branch} starts suspended`);
    }
    // Home's cards show the mark too: Alpha, suspended.
    // Home, under the overview that start's work shows (spec §9.7).
    await page.eval(`document.querySelector('[data-nav-key="home"]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-home-board] [data-board-card="${ids.Alpha}"] [data-suspended]')`,
      'Suspended on Home',
      20_000,
    );
    assert.equal(
      await page.eval(
        `document.querySelector('[data-home-board] [data-board-card="${ids.Alpha}"] [data-suspended]').title`,
      ),
      SUSPENDED_TOOLTIP,
    );
    await expandApi(page);
    await page.waitFor(suspendedRow('Charlie'), 'Charlie marked suspended');
    // Opening one resumes it.
    await open(page, 'Charlie');
    await until(() => starts('charlie').length === before.charlie + 1, 'Charlie resumed');
    assert.ok(
      starts('charlie')
        .at(-1)
        ?.includes(`--resume ${sessionIdOf('charlie')}`),
    );
    await sleep(1000);
    assert.equal(starts('echo').length, before.echo + 1, 'Echo resumed only once');

    assert.equal(read('uncaught.log'), '', 'no uncaught exception in the main process');
    console.log(`e2e suspend test passed (${devMode ? 'dev server' : 'production build'})`);
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
  console.error(`e2e suspend test failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
