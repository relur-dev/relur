/**
 * End-to-end test of notes per workspace (spec §6.15): two items written in
 * the Notes panel, the mark on Home's and the project's Board while they are unsent, one sent
 * now while Claude works (Claude Code takes it into the running turn), the
 * other held until Claude is done and sent then by itself; both move to Sent,
 * and each View response opens the Responses panel at its own entry, which
 * has the "from notes" label. The Delete dialog mentions an unsent item.
 * Then the panel's keys: Esc leaves a note and a second Esc closes the panel,
 * ⌥↵ holds a note, ⌘↵ refused over a draft offers Queue instead, and both go
 * by themselves once the draft is deleted with ⌫; the footer's
 * "All n, as one prompt", and the Sent section staying collapsed.
 * Runs with a throwaway HOME and a fake `claude` that writes its transcript
 * as Claude Code does (uuids, a queued prompt as an attachment).
 *
 *   tsx scripts/e2e-notes.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  dialogText,
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

/**
 * A stand-in for Claude, in Node (run by this Node): SessionStart, then per
 * line typed `begin` starts a turn (a prompt, UserPromptSubmit), `finish`
 * ends it (Claude's text, Stop, then the transcript, as Claude Code writes
 * it) and `exit` ends Claude. A paste and Enter while a turn runs is taken
 * into it, as Claude Code does (a `queued_command` attachment, checked live
 * with 2.1.321); while idle, it is a prompt of its own, answered at once.
 * As Claude Code does, it turns on mouse and focus reports, ignores them
 * (a click doesn't move its cursor here; it notes the clicks it got in
 * claude-mouse.txt), and shows typed keys in its input
 * box between two full-width rules, with a dim placeholder when empty.
 */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, email: 'test@example.com', configDirectory: process.env.CLAUDE_CONFIG_DIR || process.env.HOME + '/.claude' }));
  process.exit(0);
}
const settings = argv[argv.indexOf('--settings') + 1];
const helper = /"command": "'(.*)' hook SessionStart"/.exec(fs.readFileSync(settings, 'utf8'))[1];
// The first workspace's Claude writes transcript-notes.jsonl; later ones their own.
const first = !fs.existsSync(process.env.HOME + '/transcript-notes.jsonl');
const sessionId = first ? 'notes' : 'notes-' + process.pid;
const transcript = process.env.HOME + '/transcript-' + sessionId + '.jsonl';
const hook = (event, payload) =>
  execFileSync(helper, ['hook', event], { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, ...payload }) });
const write = (entry) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\\n');
let n = 0;
const id = () => 'uuid-' + ++n;
let busy = false;
const prompt = (text) => {
  write({ type: 'user', uuid: id(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
  out('\\u276f ' + text.split('\\n')[0] + '\\r\\n');
  hook('UserPromptSubmit', { prompt: text });
};
const answer = (text) => {
  out('\\u23fa ' + text + '\\r\\n\\r\\n');
  hook('Stop', { last_assistant_message: text });
  write({ type: 'assistant', uuid: id(), message: { id: 'm' + n, role: 'assistant', content: [{ type: 'text', text }] } });
};
let draft = '';
const rule = () => '\\u2500'.repeat(process.stdout.columns || 80);
// The input box: a rule, the prompt line with the cursor in it, a rule.
const promptLine = () => draft ? '\\u276f\\u00a0' + draft : '\\u276f\\u00a0\\u001b[2mTry "something"\\u001b[0m\\r\\u001b[2C';
const box = () => process.stdout.write(rule() + '\\r\\n' + '\\r\\n' + rule() + '\\u001b[1A\\r' + promptLine());
const redraw = () => process.stdout.write('\\r\\u001b[2K' + promptLine());
// Output goes above the box: cleared from its top rule, written, drawn again.
const out = (text) => { process.stdout.write('\\u001b[1A\\r\\u001b[J' + text); box(); };
process.stdout.on('resize', () => { process.stdout.write('\\u001b[1A\\r\\u001b[J'); box(); });
hook('SessionStart', {});
process.stdout.write('\\u001b[?1000h\\u001b[?1006h\\u001b[?1004h');
console.log('fake claude');
box();
let buffer = '';
const START = '\\u001b[200~';
const END = '\\u001b[201~';
// Raw, as Claude Code reads its keys: no echo or line editing by the terminal.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const start = buffer.indexOf(START);
    const end = buffer.indexOf(END);
    if (start !== -1 && end > start) {
      const after = buffer.slice(end + END.length);
      const enter = after.search(/[\\r\\n]/);
      if (enter === -1) return;
      const text = buffer.slice(start + START.length, end).replace(/\\r\\n?/g, '\\n');
      buffer = after.slice(enter + 1);
      if (busy) {
        write({ type: 'attachment', uuid: id(), attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } } });
        fs.appendFileSync(process.env.HOME + '/claude-queued.txt', text + '\\n---\\n');
      } else {
        prompt(text);
        answer('Noted: ' + text.split('\\n')[0]);
      }
      continue;
    }
    if (start !== -1) return;
    // Keys, one at a time: mouse and focus reports and other sequences change nothing.
    const key = /^(?:\\u001b\\[[0-?]*[ -\\/]*[@-~]|\\u001b[\\s\\S]?|[\\s\\S])/.exec(buffer);
    if (!key) return;
    buffer = buffer.slice(key[0].length);
    const k = key[0];
    if (k === '\\r' || k === '\\n') {
      const line = draft.trim();
      draft = '';
      redraw();
      if (line === 'begin') { busy = true; prompt('Start the work'); }
      else if (line === 'finish') { busy = false; answer('Finished the work.'); }
      else if (line === 'exit') { process.stdout.write('\\r\\n'); process.exit(0); }
    } else if (k === '\\u007f') { draft = draft.slice(0, -1); redraw(); }
    else if (k === '\\u0003' || k === '\\u0015') { draft = ''; redraw(); }
    else if (/^\\u001b\\[<\\d+;\\d+;\\d+[Mm]$/.test(k)) fs.appendFileSync(process.env.HOME + '/claude-mouse.txt', k.slice(1) + '\\n');
    else if (k >= ' ') { draft += k; redraw(); }
    if (buffer === '') return;
  }
});
setInterval(() => {}, 1 << 30);
`;

/** The shown terminal's text, from xterm's buffer, as an expression. */
const screenText = `(() => { const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent); const b = t?.xterm?.buffer.active; if (!b) return ''; let s = ''; for (let y = 0; y < b.length; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s; })()`;

/** The text in Claude's input box as the shown terminal draws it, as an expression; null without one. */
const promptText = `(() => { const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent); const b = t?.xterm?.buffer.active; const line = b?.getLine(b.baseY + b.cursorY)?.translateToString(true); if (!line?.startsWith('\\u276f')) return null; return line.includes('Try "something"') ? '' : line.slice(2).trimEnd(); })()`;

/** Whether the shown terminal has the keyboard focus, as an expression. */
const terminalFocused = `[...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent)?.querySelector('.xterm-helper-textarea') === document.activeElement`;

/** What a note's refusal says, as an expression. */
const refusalOf = (text: string) =>
  `(${noteWith(text)}?.querySelector('[data-note-queue-instead]')?.parentElement?.innerText ?? ${noteWith(text)}?.innerText ?? '')`;

/** The waiting line of notes held behind a draft. */
const WAITING_DRAFT = "there may be text in Claude's prompt";

/** A real click on the prompt line of the shown terminal, at its fourth column. */
async function clickPromptLine(page: Cdp) {
  const { x, y } = await page.eval<{ x: number; y: number }>(`(() => {
    const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent);
    const r = t.querySelector('.xterm-screen').getBoundingClientRect();
    const term = t.xterm;
    return { x: r.left + (r.width / term.cols) * 3.5, y: r.top + (r.height / term.rows) * (term.buffer.active.cursorY + 0.5) };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

/** Whether the selector matches, as an expression. */
const has = (selector: string) => `!!document.querySelector(${JSON.stringify(selector)})`;
/** The notes in a section, by their text, as an expression. */
const notesIn = (section: 'open' | 'sent') =>
  `[...document.querySelectorAll('[data-notes-${section}] [data-note]')].map((n) => (n.querySelector('[data-note-text]')?.value ?? n.querySelector('[data-note-text]')?.textContent ?? '').trim())`;
/** A note's element by its text, as an expression. */
const noteWith = (text: string) =>
  `[...document.querySelectorAll('[data-note]')].find((n) => (n.querySelector('[data-note-text]')?.value ?? n.querySelector('[data-note-text]')?.textContent ?? '').trim() === ${JSON.stringify(text)})`;

/** Adds a note and types its text: it is focused once it shows. */
async function writeNote(page: Cdp, add: () => Promise<void>, text: string) {
  const before = await page.eval<number>(
    `document.querySelectorAll('[data-notes-open] [data-note]').length`,
  );
  await add();
  await page.waitFor(
    `document.querySelectorAll('[data-notes-open] [data-note]').length === ${before + 1} && document.activeElement?.matches('[data-note-text]')`,
    'a new note in focus',
  );
  await page.send('Input.insertText', { text });
  // Saved as you type, after a pause.
  await sleep(700);
}

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: web } = fx.cloneWithRemote('web', 'main');
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
        })),
        projects: [{ id: 'web', profileId: 'work', name: 'web', repoPath: web, remote: 'origin' }],
      }),
    );
    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const page = app.page;

    // 1. A workspace; its Claude starts a turn and works.
    await clickLabel(page, 'New workspace in web');
    await page.waitFor(has('dialog[open] #ws-task'), 'New workspace');
    await typeInField(page, '#ws-task', 'NOTE-1 Notes', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace created', 30_000);
    await page.waitFor(`${screenText}.includes('fake claude')`, 'its Claude', 30_000);
    await typeInTerminal(page, 'begin');
    const transcript = path.join(fx.root, 'transcript-notes.jsonl');
    await page.waitFor(`${screenText}.includes('Start the work')`, 'the turn');

    // 2. The Notes panel (⇧⌘K) and two items: Add note, then ⌥⌘N.
    await pressShortcut(page, 'notes');
    await page.waitFor(has('[data-notes-panel]'), 'the Notes panel');
    await writeNote(
      page,
      () => page.eval(`document.querySelector('[data-note-add]').click()`),
      'Also update the changelog',
    );
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'Then run the linter');
    assert.deepEqual(await page.eval(notesIn('open')), [
      'Also update the changelog',
      'Then run the linter',
    ]);
    await page.waitFor(
      `document.querySelector('[data-notes-toggle]')?.textContent.includes('2')`,
      'the count on the Notes toggle',
    );
    await screenshot(page, screenshotDir, 'n1-two-notes.png');

    // 3. The Board marks the workspace with its unsent items.
    await pressShortcut(page, 'home');
    await page.waitFor(has('[data-home-board]'), 'the Board');
    await page.waitFor(has('[data-board-card] [data-notes-mark="2"]'), 'the notes mark with 2');
    // The project's Board too (spec §6.10).
    await page.eval(`document.querySelector('[data-nav-key="p:web"] [data-nav-focus]').click()`);
    await page.waitFor(
      has('main [data-board-card] [data-notes-mark="2"]'),
      "the mark on the project's Board",
    );
    await page.eval(`document.querySelector('main [data-board-card]').click()`);
    await page.waitFor(has('[data-notes-panel]'), 'the workspace with its Notes panel');

    // 4. Send now while Claude works: Claude Code takes it into the running turn.
    await page.eval(
      `${noteWith('Also update the changelog')}.querySelector('[data-note-send-now]').click()`,
    );
    await page.waitFor(
      `JSON.stringify(${notesIn('sent')}) === '["Also update the changelog"]'`,
      'the first note sent',
    );
    const queuedFile = path.join(fx.root, 'claude-queued.txt');
    for (let i = 0; i < 50 && !fs.existsSync(queuedFile); i++) await sleep(100);
    assert.equal(fs.readFileSync(queuedFile, 'utf8'), 'Also update the changelog\n---\n');

    // 5. Send when Claude is done: held, queued, then sent by itself at the turn's end.
    await page.eval(`${noteWith('Then run the linter')}.querySelector('[data-note-hold]').click()`);
    await page.waitFor(
      `${noteWith('Then run the linter')}?.dataset.noteState === 'held' && ${noteWith('Then run the linter')}.querySelector('[data-note-queued]')?.textContent.includes('Queued')`,
      'the second note queued',
    );
    await screenshot(page, screenshotDir, 'n2-queued.png');
    assert.ok(!fs.readFileSync(transcript, 'utf8').includes('Then run the linter'), 'not sent yet');
    await page.eval(
      `document.querySelector('main [data-terminal] .xterm-helper-textarea')?.focus()`,
    );
    await typeInTerminal(page, 'finish');
    await page.waitFor(
      `JSON.stringify(${notesIn('sent')}.sort()) === '["Also update the changelog","Then run the linter"]'`,
      'both notes sent',
      20_000,
    );
    await page.waitFor(`!document.querySelector('[data-notes-open] [data-note]')`, 'no open notes');
    // Marked sent before it is typed; Claude has it as a prompt of its own a moment later.
    const asPrompt = () =>
      fs.readFileSync(transcript, 'utf8').includes('"content":"Then run the linter"');
    for (let i = 0; i < 50 && !asPrompt(); i++) await sleep(100);
    assert.ok(asPrompt(), 'the held note sent as a prompt of its own');

    // 6. View response: the Responses panel at each one's own entry, labelled "from notes".
    const viewResponse = async (text: string, entry: number) => {
      await page.waitFor(
        `!${noteWith(text)}?.querySelector('[data-note-view-response]')?.disabled`,
        `View response for "${text}"`,
        20_000,
      );
      await page.eval(`${noteWith(text)}.querySelector('[data-note-view-response]').click()`);
      await page.waitFor(
        `document.querySelector('[data-responses-panel] [data-response="${entry}"]')?.dataset.expanded === 'true'`,
        `entry ${entry} expanded`,
      );
      await page.waitFor(
        `!!document.querySelector('[data-response="${entry}"] [data-response-from-notes]')`,
        `entry ${entry}'s "from notes" label`,
      );
    };
    // The first went into the turn it was sent in: entry 1 ("Start the work").
    await viewResponse('Also update the changelog', 1);
    await viewResponse('Then run the linter', 2);
    assert.equal(
      await page.eval(`document.querySelectorAll('[data-response-from-notes]').length`),
      2,
    );
    await screenshot(page, screenshotDir, 'n3-view-response.png');
    // The label leads back to its note.
    await page.eval(
      `document.querySelector('[data-response="2"] [data-response-from-notes]').click()`,
    );
    await page.waitFor(
      `${noteWith('Then run the linter')}?.dataset.highlighted === 'true'`,
      'the note marked',
    );

    // 7. No unsent notes: no mark on the Board.
    await pressShortcut(page, 'home');
    await page.waitFor(has('[data-home-board] [data-board-card]'), 'the Board again');
    await sleep(500);
    assert.equal(await page.eval(has('[data-notes-mark]')), false, 'no mark');

    // 8. An unsent note: the Delete dialog says it goes with the workspace.
    await page.eval(`document.querySelector('[data-board-card]').click()`);
    await page.waitFor(has('[data-notes-panel]'), 'the Notes panel again');
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'A last thought');
    await page.eval(
      `document.querySelector('main [data-terminal] .xterm-helper-textarea')?.focus()`,
    );
    await chooseFromNextContextMenu(app.main, 'Delete workspace…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(
      `${dialogText}.includes('1 unsent note will be deleted')`,
      'the notes warning',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog closed');

    // 9. The panel's keys and footer (spec §6.15). With two unsent notes the
    // footer offers all of them as one prompt; Esc in a note leaves it, a
    // second Esc closes the panel.
    await page.eval(`${noteWith('A last thought')}.querySelector('[data-note-text]').focus()`);
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'Held by key');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-notes-footer]')?.innerText ?? ''`),
      /All 2, as one prompt/,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`document.activeElement?.matches('[data-notes-panel]')`, 'the note left');
    assert.equal(await page.eval(has('[data-notes-panel]')), true, 'still open after one Esc');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('[data-notes-panel]')`, 'a second Esc closes it');
    await pressShortcut(page, 'notes');
    await page.waitFor(has('[data-notes-panel]'), 'the panel again');
    // The Sent section collapses, and stays so when the panel opens again.
    await page.eval(`document.querySelector('[data-notes-sent-toggle]').click()`);
    await page.waitFor(
      `document.querySelector('[data-notes-sent]')?.dataset.collapsed === 'true' && !document.querySelector('[data-notes-sent] [data-note]')`,
      'Sent collapsed',
    );
    await pressShortcut(page, 'notes');
    await page.waitFor(`!document.querySelector('[data-notes-panel]')`, 'closed');
    await pressShortcut(page, 'notes');
    await page.waitFor(
      `document.querySelector('[data-notes-sent]')?.dataset.collapsed === 'true'`,
      'still collapsed',
    );
    await page.eval(`document.querySelector('[data-notes-sent-toggle]').click()`);
    await page.waitFor(`!!document.querySelector('[data-notes-sent] [data-note]')`, 'Sent open');
    // A draft in the terminal while Claude is done: ⌥↵ holds a note, waiting
    // on it; ⌘↵ is refused, naming the draft, and Queue instead holds that one
    // too. Then a click into the terminal to focus it, on the prompt line
    // (where Claude Code would move its cursor), and ⌫ until the prompt is
    // empty, without ↵: both go by themselves.
    const draft = 'half a thought';
    await typeInTerminal(page, draft, false);
    await page.waitFor(`${promptText} === ${JSON.stringify(draft)}`, 'the draft in the input box');
    await page.eval(`${noteWith('Held by key')}.querySelector('[data-note-text]').focus()`);
    await pressShortcut(page, 'noteQueue');
    await page.waitFor(
      `${noteWith('Held by key')}?.dataset.noteState === 'held' && ${noteWith('Held by key')}.querySelector('[data-note-queued]').textContent.includes(${JSON.stringify(WAITING_DRAFT)})`,
      '⌥↵ held it, waiting on the draft',
    );
    await page.eval(`${noteWith('A last thought')}.querySelector('[data-note-text]').focus()`);
    await pressShortcut(page, 'noteSendNow');
    await page.waitFor(
      `!!${noteWith('A last thought')}?.querySelector('[data-note-queue-instead]')`,
      '⌘↵ refused over the draft',
    );
    assert.match(
      await page.eval<string>(refusalOf('A last thought')),
      /^There may be text in Claude's prompt: send it or clear it with Ctrl\+C/,
    );
    await page.eval(
      `${noteWith('A last thought')}.querySelector('[data-note-queue-instead]').click()`,
    );
    await page.waitFor(
      `${noteWith('A last thought')}?.dataset.noteState === 'held'`,
      'Queue instead held it',
    );
    await page.waitFor(
      `[...document.querySelectorAll('[data-note-queued]')].some((q) => q.textContent.includes(${JSON.stringify(WAITING_DRAFT)}))`,
      'the waiting line names the draft',
    );
    await screenshot(page, screenshotDir, 'n4-queued-by-key.png');
    assert.equal(await page.eval(terminalFocused), false, 'the note has the focus');
    await clickPromptLine(page);
    await page.waitFor(terminalFocused, 'the click focused the terminal');
    const mouseFile = path.join(fx.root, 'claude-mouse.txt');
    await sleep(300);
    assert.equal(fs.existsSync(mouseFile), false, 'a click that focuses never reaches Claude');
    for (let i = 1; i < draft.length; i++) await pressKey(page, 'Backspace');
    await page.waitFor(`${promptText} === 'h'`, 'one character left');
    await sleep(1_000);
    assert.deepEqual(
      await page.eval(
        `[${noteWith('Held by key')}?.dataset.noteState, ${noteWith('A last thought')}?.dataset.noteState]`,
      ),
      ['held', 'held'],
      'one character of the draft left: still waiting',
    );
    await pressKey(page, 'Backspace');
    await page.waitFor(
      `${notesIn('sent')}.includes('Held by key') && ${notesIn('sent')}.includes('A last thought')`,
      'both sent by themselves once the draft was deleted',
      5_000,
    );

    // A click while the terminal has the focus reaches Claude, which may move
    // its cursor there; the keys can't follow that, Claude's screen can: once
    // it shows the prompt empty after ⌫, a queued note goes.
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'After a click in the draft');
    await typeInTerminal(page, 'more', false);
    await page.waitFor(`${promptText} === 'more'`, 'a second draft');
    await page.eval(
      `${noteWith('After a click in the draft')}.querySelector('[data-note-hold]').click()`,
    );
    await page.waitFor(
      `${noteWith('After a click in the draft')}?.querySelector('[data-note-queued]')?.textContent.includes(${JSON.stringify(WAITING_DRAFT)})`,
      'held behind the second draft',
    );
    assert.equal(await page.eval(terminalFocused), true, 'the terminal kept the focus');
    await clickPromptLine(page);
    const clicked = () =>
      fs.existsSync(mouseFile) && fs.readFileSync(mouseFile, 'utf8').endsWith('m\n');
    for (let i = 0; i < 50 && !clicked(); i++) await sleep(100);
    assert.match(fs.readFileSync(mouseFile, 'utf8'), /^\[<0;\d+;\d+M\n\[<0;\d+;\d+m\n$/);
    for (let i = 0; i < 'more'.length; i++) await pressKey(page, 'Backspace');
    await page.waitFor(
      `${notesIn('sent')}.includes('After a click in the draft')`,
      'sent once the screen shows the prompt empty',
      5_000,
    );

    // Room for long notes: a pasted log grows the field at once, up to half
    // the panel's height, then it scrolls; left, the note shows its first
    // four lines and "…". ⌥⌘F opens it in the large editor, Done goes back;
    // ⤢ opens it again, Esc goes back; edited there and sent from there.
    const log = Array.from({ length: 60 }, (_, i) => `log line ${i + 1}: request took 12 ms`).join(
      '\n',
    );
    await writeNote(page, () => pressShortcut(page, 'addNote'), log);
    const field = await page.eval<{ height: number; scroll: number; panel: number }>(
      `(() => { const f = document.activeElement; return { height: f.clientHeight, scroll: f.scrollHeight, panel: document.querySelector('[data-notes-panel]').clientHeight }; })()`,
    );
    assert.ok(field.height > 150, `the field grew with the paste (${field.height}px)`);
    assert.ok(
      field.height <= field.panel / 2 + 2,
      `at most half the panel (${JSON.stringify(field)})`,
    );
    assert.ok(field.scroll > field.height + 100, 'then it scrolls');
    await pressKey(page, 'Escape');
    await page.waitFor(`!!${noteWith(log)}?.querySelector('[data-note-preview]')`, 'its preview');
    const preview = await page.eval<{ height: number; scroll: number; clamp: string }>(
      `(() => { const p = ${noteWith(log)}.querySelector('[data-note-preview] [data-note-clamp]'); return { height: p.clientHeight, scroll: p.scrollHeight, clamp: getComputedStyle(p).webkitLineClamp }; })()`,
    );
    assert.equal(preview.clamp, '4', 'four lines, then "…"');
    assert.ok(preview.height < 100 && preview.scroll > preview.height, JSON.stringify(preview));
    await screenshot(page, screenshotDir, 'n5-long-note.png');
    const editor = '[data-note-editor]';
    const editorText = `document.querySelector('[data-note-editor-text]')`;
    await page.eval(`${noteWith(log)}.querySelector('[data-note-text]').focus()`);
    await page.waitFor(`document.activeElement?.matches('textarea[data-note-text]')`, 'editing it');
    await pressShortcut(page, 'noteEditor');
    await page.waitFor(
      `${editorText}?.value === ${JSON.stringify(log)} && document.activeElement === ${editorText}`,
      '⌥⌘F opened it in the large editor, in focus',
    );
    assert.equal(await page.eval(`document.querySelector('${editor}').dataset.noteState`), 'open');
    await screenshot(page, screenshotDir, 'n6-editor.png');
    await page.eval(`document.querySelector('[data-note-editor-done]').click()`);
    await page.waitFor(`!document.querySelector('${editor}')`, 'Done went back');
    await page.waitFor(
      `!!document.activeElement?.closest('[data-notes-panel] [data-note]')`,
      'the note in focus again',
    );
    await page.eval(`${noteWith(log)}.querySelector('[data-note-expand]').click()`);
    await page.waitFor(`document.activeElement === ${editorText}`, '⤢ opened it');
    const added = '\nlast line added in the editor';
    await page.send('Input.insertText', { text: added });
    await sleep(700);
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('${editor}')`, 'Esc went back');
    assert.equal(await page.eval(has('[data-notes-panel]')), true, 'the panel stays open');
    await page.waitFor(`!!${noteWith(log + added)}`, 'the edit shows in the panel');
    await page.eval(`${noteWith(log + added)}.querySelector('[data-note-expand]').click()`);
    await page.waitFor(
      `${editorText}?.value === ${JSON.stringify(log + added)}`,
      'kept when opened again',
    );
    await page.eval(`document.querySelector('${editor} [data-note-send-now]').click()`);
    await page.waitFor(`!document.querySelector('${editor}')`, 'sent: the editor goes');
    await page.waitFor(`${notesIn('sent')}.includes(${JSON.stringify(log + added)})`, 'in Sent');
    for (let i = 0; i < 50 && !fs.readFileSync(transcript, 'utf8').includes('last line added'); i++)
      await sleep(100);
    assert.ok(
      fs.readFileSync(transcript, 'utf8').includes('last line added in the editor'),
      'Claude got the edited text',
    );
    // A sent note opens read-only, with Copy.
    await page.eval(`${noteWith(log + added)}.querySelector('[data-note-expand]').click()`);
    await page.waitFor(
      `document.querySelector('${editor}')?.dataset.noteState === 'sent' && ${editorText}.readOnly && !!document.querySelector('${editor} [data-note-copy]')`,
      'a sent note read-only with Copy',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('${editor}')`, 'back from the sent note');
    // A queued note opens read-only, with Send now and Cancel.
    await typeInTerminal(page, 'x', false);
    await page.waitFor(`${promptText} === 'x'`, 'a draft to hold it');
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'Queued and long enough');
    await pressShortcut(page, 'noteQueue');
    await page.waitFor(
      `${noteWith('Queued and long enough')}?.dataset.noteState === 'held'`,
      'queued',
    );
    await page.eval(
      `${noteWith('Queued and long enough')}.querySelector('[data-note-expand]').click()`,
    );
    await page.waitFor(
      `document.querySelector('${editor}')?.dataset.noteState === 'held' && ${editorText}.readOnly && !!document.querySelector('${editor} [data-note-cancel]')`,
      'a queued note read-only with Cancel',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('${editor}')`, 'back from the queued note');
    await typeInTerminal(page, '', false);
    await pressKey(page, 'Backspace');
    await page.waitFor(
      `${notesIn('sent')}.includes('Queued and long enough')`,
      'the queued note sent once the draft went',
      5_000,
    );

    // A fresh workspace: its Claude waits at its prompt in Starting, before
    // any prompt. Send now types a note there, and a held one goes at once.
    await clickLabel(page, 'New workspace in web');
    await page.waitFor(has('dialog[open] #ws-task'), 'New workspace');
    await typeInField(page, '#ws-task', 'NOTE-2 Fresh', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the second workspace', 30_000);
    await page.waitFor(`${promptText} === ''`, "its Claude's empty input box", 30_000);
    if (!(await page.eval<boolean>(has('[data-notes-panel]')))) await pressShortcut(page, 'notes');
    await page.waitFor(has('[data-notes-panel]'), 'its Notes panel');
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'First words');
    await page.eval(`${noteWith('First words')}.querySelector('[data-note-send-now]').click()`);
    await page.waitFor(`${notesIn('sent')}.includes('First words')`, 'sent now in Starting');
    await page.waitFor(`${screenText}.includes('Noted: First words')`, 'Claude took it');
    // Claude has ended: the refusal says so.
    await typeInTerminal(page, 'exit');
    await page.waitFor(`${screenText}.includes('process exited')`, 'Claude ended');
    await writeNote(page, () => pressShortcut(page, 'addNote'), 'Too late');
    await page.eval(`${noteWith('Too late')}.querySelector('[data-note-send-now]').click()`);
    await page.waitFor(
      `${refusalOf('Too late')}.startsWith("Claude isn't running in this workspace")`,
      'refused: Claude has ended',
    );

    console.log(`e2e-notes: ok (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    const shown = await app?.page.eval<string>(`document.body.innerText`).catch(() => '');
    console.error(`The window showed:\n${shown?.slice(0, 3000)}`);
    const bottom = await app?.page
      .eval<string>(
        `(() => { const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent); const b = t?.xterm?.buffer.active; if (!b) return ''; const rows = []; for (let y = Math.max(0, b.baseY + b.cursorY - 5); y <= b.baseY + b.cursorY + 2; y++) rows.push(JSON.stringify(b.getLine(y)?.translateToString(true))); return rows.join('\\n') + '\\ncursor ' + (b.baseY + b.cursorY) + ',' + b.cursorX; })()`,
      )
      .catch(() => '');
    console.error(`The terminal's last lines:\n${bottom}`);
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
