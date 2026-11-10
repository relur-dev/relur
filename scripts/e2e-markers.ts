/**
 * End-to-end test of prompt markers (spec §6.8) with a fake `claude` that
 * shows prompts as Claude Code's classic renderer does: `❯ <prompt>` at the
 * line's start, answers indented below (here repeating the prompt's words),
 * an input box between full-width rules, the whole conversation reprinted on
 * a resize and on a resume, and pasted prompts wrapped in Claude Code's
 * `<pasted_content>` tags in the hook and the transcript. Every prompt's
 * number must sit on its own `❯` line: as prompts are sent (typed, a short
 * one, one typed and pasted into, one the app sends as a paste), with a
 * draft in the input box repeating a prompt, after a resize, after a
 * suspended session resumes and after an app restart, where the earlier
 * prompts come back from the transcript. The navigator counts all of them.
 * Runs with a throwaway HOME and the fake `claude`.
 *
 *   tsx scripts/e2e-markers.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  clickButtonText,
  clickLabel,
  hasButton,
  launchApp,
  pressKey,
  pressShortcut,
  type RunningApp,
  screenshot,
  sleep,
  submitDialog,
  typeInField,
  typeInTerminal,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

/** A minute lasts this long here: "after 5 minutes" is 5 seconds (spec §9.8). */
const MINUTE_MS = 1000;

/**
 * A stand-in for Claude Code's classic renderer, in Node (it draws an input
 * box, redraws on a resize and reads bracketed pastes). Each prompt runs
 * UserPromptSubmit while the input box still shows it, then is printed as
 * Claude Code 2.1.318 prints it (recorded live): `❯ <prompt>` on a grey band,
 * wrapped at spaces by Claude itself, further lines indented two spaces,
 * every line padded with spaces to the full width; then an answer that
 * repeats its first line, written to the transcript, then Stop. `--resume <id>` reprints that conversation, then
 * SessionStart says `resume`. Scripted tests never start the real one.
 */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
  console.log(JSON.stringify({ loggedIn: true, email: 'test@example.com', configDirectory: dir }));
  process.exit(0);
}
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const resumed = arg('--resume');
const sid = resumed || arg('--session-id') || 'fake-' + process.pid;
let helper = null;
try {
  const settings = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8'));
  helper = settings.hooks.SessionStart[0].hooks[0].command.match(/^'(.*)' hook/)[1];
} catch {}
const dir = path.join(process.env.HOME, 'fake-claude');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'starts.txt'), argv.join(' ') + '\\n');
fs.appendFileSync(path.join(dir, 'cwds.txt'), process.cwd() + '\\n');
const transcript = path.join(dir, sid + '.jsonl');
const screenFile = path.join(dir, sid + '.screen.json');
const hook = (event, payload) => {
  if (!helper) return;
  try {
    execFileSync(helper, ['hook', event], {
      input: JSON.stringify({ session_id: sid, transcript_path: transcript, ...payload }),
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
  } catch {}
};
const out = (s) => process.stdout.write(s);
const cols = () => process.stdout.columns || 80;
let screen = resumed && fs.existsSync(screenFile) ? JSON.parse(fs.readFileSync(screenFile, 'utf8')) : [];
let draft = '';
let prompt = '';
let pastes = 0;
// The input box: a full-width rule, then ❯ and the draft (its lines indented).
const boxRows = () =>
  1 + draft.split('\\n').reduce((n, l, i) => n + Math.max(1, Math.ceil((l.length + 2) / cols())), 0);
const box = () => out('\\u2500'.repeat(cols()) + '\\r\\n\\u276f ' + draft.split('\\n').join('\\r\\n  '));
const unbox = () => out('\\r\\x1b[' + (boxRows() - 1) + 'A\\x1b[J');
// A sent prompt, drawn at the width of the moment (a reprint wraps it anew).
const wrap = (text, width) => text.split('\\n').flatMap((para) => {
  const rows = [];
  let rest = para;
  while (rest.length > width) {
    const at = rest.lastIndexOf(' ', width - 1);
    const cut = at > 0 ? at + 1 : width;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return [...rows, rest];
});
const drawPrompt = (text) =>
  '\\x1b[48;2;55;55;55m' +
  wrap(text, cols() - 2)
    .map((row, i) => (i === 0 ? '\\x1b[38;2;153;153;153m\\u276f ' : '  ') +
      '\\x1b[38;2;255;255;255m' + row + '\\x1b[39m' + ' '.repeat(Math.max(0, cols() - 2 - row.length)))
    .join('\\r\\n') +
  '\\x1b[49m';
const draw = (line) => (typeof line === 'string' ? line : drawPrompt(line.prompt));
const say = (lines) => {
  unbox();
  for (const line of lines) out(draw(line) + '\\r\\n');
  screen.push(...lines);
  fs.writeFileSync(screenFile, JSON.stringify(screen));
  box();
};
// Classic Claude Code clears the screen and its scrollback and reprints.
const reprint = () => {
  out('\\x1b[2J\\x1b[3J\\x1b[H');
  out('fake claude ' + sid + '\\r\\n\\r\\n');
  for (const line of screen) out(draw(line) + '\\r\\n');
  box();
};
const entry = (e) => fs.appendFileSync(transcript, JSON.stringify(e) + '\\n');
const submit = () => {
  const shown = draft.trim();
  const sent = prompt.trim();
  draft = '';
  prompt = '';
  if (!shown) return;
  entry({ type: 'user', sessionId: sid, message: { role: 'user', content: sent } });
  // The hook runs before Claude prints the prompt; the box still shows it.
  hook('UserPromptSubmit', { prompt: sent });
  setTimeout(() => {
    const [first, ...more] = shown.split('\\n');
    const answer = ['Done. In short:', first, '- ' + first + ', as asked'];
    say([{ prompt: shown }, '', '\\u23fa ' + answer[0], ...answer.slice(1).map((l) => '  ' + l), '']);
    const text = answer.join('\\n');
    entry({ type: 'assistant', sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    hook('Stop', { last_assistant_message: text });
  }, 300);
};
// Raw before anything else: keys typed early must not reach a cooked terminal.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out('\\x1b[?2004h');
reprint();
hook('SessionStart', { source: resumed ? 'resume' : 'startup' });
process.stdout.on('resize', reprint);
let pending = '';
let paste = null;
process.stdin.on('data', (data) => {
  pending += data;
  while (pending) {
    if (paste !== null) {
      const end = pending.indexOf('\\x1b[201~');
      // The end marker may come in the next read: keep what could begin it.
      if (end === -1) { const keep = pending.lastIndexOf('\\x1b'); paste += keep === -1 ? pending : pending.slice(0, keep); pending = keep === -1 ? '' : pending.slice(keep); break; }
      paste += pending.slice(0, end);
      pending = pending.slice(end + 6);
      const text = paste.replace(/\\r\\n?/g, '\\n');
      paste = null;
      unbox();
      draft += text;
      pastes += 1;
      prompt += '\\n\\n<pasted_content id="' + pastes + '">\\n' + text + '\\n</pasted_content id="' + pastes + '">\\n';
      box();
      continue;
    }
    if (pending.startsWith('\\x1b[200~')) { paste = ''; pending = pending.slice(6); continue; }
    if (pending[0] === '\\x1b') {
      const m = pending.match(/^\\x1b\\[[0-9;<>?]*[A-Za-z~]/);
      if (!m && /^\\x1b(\\[[0-9;<>?]*)?$/.test(pending)) break;
      pending = pending.slice(m ? m[0].length : 1);
      continue;
    }
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === '\\r' || ch === '\\n') submit();
    else if (ch === '\\x7f') { unbox(); draft = draft.slice(0, -1); prompt = prompt.slice(0, -1); box(); }
    else if (ch >= ' ') { unbox(); draft += ch; prompt += ch; box(); }
  }
});
`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: repo } = fx.cloneWithRemote('api', 'main');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(fakeClaude, `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o755 });
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
          ...(p.id === 'work' ? { suspendIdleMin: 5 } : {}),
        })),
        projects: [
          {
            id: 'api',
            profileId: 'work',
            name: 'api',
            repoPath: repo,
            remote: 'origin',
            baseBranch: 'main',
          },
        ],
      }),
    );
    const env = withDisplayEnv({ ...fx.env, [envVar('SUSPEND_MINUTE_MS')]: String(MINUTE_MS) });
    const launch = async () => {
      app = await launchApp({ env, dev: devMode, electronArgs });
      await setSize(1600, 1000);
      await app.page.waitFor(
        `!!document.querySelector('[aria-label="New workspace in api"]')`,
        'app',
      );
      return app;
    };
    const setSize = (width: number, height: number) =>
      (app as RunningApp).main.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setSize(${width}, ${height})`,
      );
    let { page } = await launch();

    const shownTerminal = `[...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent)`;
    /** Each placed prompt marker: its number and the text of its line. */
    const promptLines = `(() => {
      const c = ${shownTerminal};
      if (!c?.aids) return null;
      const prompts = c.aids.marks.filter((m) => m.mark.kind === 'prompt');
      return prompts.map((m, i) => m.marker && !m.marker.isDisposed
        ? (i + 1) + ' ' + c.xterm.buffer.active.getLine(m.marker.line).translateToString(true).trim()
        : null).filter(Boolean);
    })()`;
    const navigator = `document.querySelector('[data-prompt-navigator]')?.textContent ?? null`;
    /** Line texts by their start: a long prompt may wrap at the terminal's width. */
    const starts = (lines: string[] | null) => lines?.map((l) => l.slice(0, 60)) ?? null;
    /** Waits (markers settle once output is quiet) until every prompt is on its own line. */
    const expectPrompts = async (what: string, expected: string[]) => {
      const want = JSON.stringify(starts(expected));
      try {
        await page.waitFor(
          `JSON.stringify((${promptLines})?.map((l) => l.slice(0, 60))) === ${JSON.stringify(want)} && (${navigator} ?? '').includes('of ${expected.length}')`,
          what,
          10_000,
        );
      } catch {
        await screenshot(page, screenshotDir, `markers-failure-${what.replace(/\W+/g, '-')}.png`);
        assert.deepEqual(
          { lines: starts(await page.eval(promptLines)), navigator: await page.eval(navigator) },
          {
            lines: starts(expected),
            navigator: `Prompt ${expected.length} of ${expected.length}↑↓`,
          },
          `${what}: each prompt's number on its own prompt line`,
        );
      }
    };
    /**
     * The shown terminal's text, a line wrapped at the terminal's width joined
     * again: a long answer may wrap inside "as asked" (at 1600 px, answer 4's
     * line breaks between "as" and "asked"), and counting them must not depend
     * on the width.
     */
    const screenText = `(() => { const b = (${shownTerminal}).xterm.buffer.active; let s = ''; for (let y = 0; y < b.length; y++) { const wraps = !!b.getLine(y + 1)?.isWrapped; s += b.getLine(y).translateToString(!wraps) + (wraps ? '' : '\\n'); } return s; })()`;
    /** Sends a prompt and waits for its answer. */
    const send = async (prompt: string) => {
      const before = await page.eval<number>(`(${screenText}).split('as asked').length`);
      await typeInTerminal(page, prompt);
      await page.waitFor(
        `(${screenText}).split('as asked').length > ${before}`,
        `the answer to ${prompt}`,
      );
    };

    await clickLabel(page, 'New workspace in api');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    await typeInField(page, '#ws-task', 'AB-10247 Markers', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace created');
    await page.waitFor(`(${screenText}).includes('fake claude')`, 'Claude started');
    const cwds = () =>
      fs
        .readFileSync(path.join(fx.root, 'fake-claude', 'cwds.txt'), 'utf8')
        .trim()
        .split('\n');
    const worktree = cwds()[0] as string;

    // 1. Answers whose lines repeat the prompts' words, and a short prompt
    // that a line of the answer equals: each number on its prompt's own line.
    const backend = 'AB-10247 backend: fix the login';
    const frontend = 'AB-10247 frontend: fix the form';
    await send(backend);
    await send('ok');
    // Typed, then pasted into (⌘V): the hook's prompt has Claude's paste tags.
    const withLog = 'AB-10247 backend: see the log ';
    await typeInTerminal(page, withLog, false);
    await app?.main.eval(
      `(() => { const { clipboard, BrowserWindow } = process.mainModule.require('electron'); clipboard.writeText('error: login failed\\nat auth.ts:12'); BrowserWindow.getAllWindows()[0].webContents.paste(); })()`,
    );
    await page.waitFor(`(${screenText}).includes('at auth.ts:12')`, 'the paste in the draft');
    await send('');
    // A prompt the app sends as a paste (spec §14.1), as Continue and answer buttons do.
    fs.writeFileSync(path.join(worktree, 'notes.txt'), 'notes\n');
    await pressShortcut(page, 'changes');
    await page.waitFor(hasButton('Ask Claude to write it'), 'Ask Claude to write it', 15_000);
    const answered = await page.eval<number>(`(${screenText}).split('as asked').length`);
    await clickButtonText(page, 'Ask Claude to write it');
    await page.waitFor(
      `(${screenText}).split('as asked').length > ${answered}`,
      'the answer to the pasted prompt',
    );
    await pressShortcut(page, 'changes');
    await page.waitFor(`!document.querySelector('[data-changes-panel]')`, 'Changes closed');
    await send(frontend);
    const commit = `4 ❯ Commit the uncommitted changes in this worktree: stage them with git add -A and run git commit with a message you write from the changes. Start the subject line with "AB-10247: ".`;
    const sent = [
      `1 ❯ ${backend}`,
      '2 ❯ ok',
      `3 ❯ ${withLog}error: login failed`,
      commit,
      `5 ❯ ${frontend}`,
    ];
    await expectPrompts('as sent', sent);
    await screenshot(page, screenshotDir, 'markers-1-sent.png');

    // 2. A draft in the input box that repeats a prompt, then a resize: Claude
    // reprints, and the draft is never taken for the prompt. Sent, it is a
    // prompt of its own, below the earlier equal one.
    await typeInTerminal(page, frontend, false);
    await setSize(900, 700);
    await sleep(1500);
    await expectPrompts('narrow, with a draft', sent);
    await setSize(1600, 1000);
    await expectPrompts('after a resize', sent);
    await pressKey(page, 'Enter');
    await page.waitFor(`(${screenText}).split('as asked').length > 6`, 'the draft sent');
    const drafted = [...sent, `6 ❯ ${frontend}`];
    await expectPrompts('the draft sent', drafted);

    // 3. Suspended while another workspace is shown, then resumed: Claude
    // reprints the conversation and its prompts get their numbers again.
    await clickLabel(page, 'New workspace in api');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
    await typeInField(page, '#ws-task', 'CD-2 Other', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the second workspace');
    const row = `[...document.querySelectorAll('nav [data-nav-key^="w:"]')].find((b) => b.title.startsWith('AB-10247'))`;
    await page.waitFor(`(${row})?.dataset.suspended === 'true'`, 'AB-10247 suspended', 40_000);
    await page.eval(`(${row}).click()`);
    await page.waitFor(`!document.querySelector('[data-resuming]')`, 'resumed', 30_000);
    await expectPrompts('after a resume', drafted);
    // A new prompt equal to an earlier one: numbered after them, on its own line.
    await send(backend);
    const latest = [...drafted, `7 ❯ ${backend}`];
    await expectPrompts('a prompt after the resume', latest);
    await screenshot(page, screenshotDir, 'markers-2-resumed.png');

    // 4. An app restart: Claude resumes and reprints, the numbers come back.
    await (app as RunningApp | undefined)?.stop();
    app = undefined;
    ({ page } = await launch());
    await page.waitFor(`!!(${row})`, 'the workspace in the sidebar');
    await page.eval(`(${row}).click()`);
    await page.waitFor(`!!${shownTerminal}`, "the workspace's Claude tab", 30_000);
    await page.waitFor(`!document.querySelector('[data-resuming]')`, 'resumed', 30_000);
    await expectPrompts('after a restart', latest);
    await screenshot(page, screenshotDir, 'markers-3-restarted.png');

    console.log(`e2e markers test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    const running = app as RunningApp | undefined;
    if (running) {
      await screenshot(running.page, screenshotDir, 'markers-failure.png').catch(() => {});
      if (running.page.errors.length > 0) {
        console.error(`renderer errors:\n  ${running.page.errors.join('\n  ')}`);
      }
    }
    throw error;
  } finally {
    await (app as RunningApp | undefined)?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e markers test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
