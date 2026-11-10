/**
 * End-to-end test of notes per workspace (spec §6.15): two items written in
 * the Notes panel, the mark on Home's and the project's Board while they are unsent, one sent
 * now while Claude works (Claude Code takes it into the running turn), the
 * other held until Claude is done and sent then by itself; both move to Sent,
 * and each View response opens the Responses panel at its own entry, which
 * has the "from notes" label. The Delete dialog mentions an unsent item.
 * Notes are written in the box at the panel's foot, as in a chat: ↵ adds,
 * ⇧↵ types a new line, an empty box adds nothing, ⌥⌘N focuses it without
 * adding a note, and its text is kept when the panel closes. Then the keys:
 * Esc leaves a note or the box and a second Esc closes the panel, ⌥↵ holds a
 * note, ⌘↵ from the box refused over a draft offers Queue instead, ⌥↵ from
 * the box holds it, and they go by themselves once the draft is deleted
 * with ⌫; the footer's "All n, as one prompt", the chat order (Sent, Queued,
 * open, newest last, scrolled to it), the Sent section staying collapsed,
 * and a pasted log growing the box, then scrolling, and Show more.
 * Runs with a throwaway HOME and a fake `claude` that writes its transcript
 * as Claude Code does (uuids, a queued prompt as an attachment).
 *
 *   tsx scripts/e2e-notes.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { hint } from '../src/shared/shortcuts';
import {
  type Cdp,
  chooseFromNextContextMenu,
  clickLabel,
  dialogText,
  launchApp,
  MOD,
  pressEnter,
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

/** The Notes box, as an expression. */
const box = `document.querySelector('[data-notes-box]')`;
/** How many open notes there are, as an expression. */
const openCount = `document.querySelectorAll('[data-notes-open] [data-note]').length`;

/**
 * ⌥⌘N: the panel opens, its box in focus. Right after a workspace opens, its
 * terminal can take the focus back once; ⌥⌘N is pressed again then.
 */
async function focusBox(page: Cdp) {
  for (let attempt = 1; ; attempt++) {
    await pressShortcut(page, 'addNote');
    try {
      await page.waitFor(`document.activeElement === ${box}`, 'the Notes box in focus', 2_000);
      await sleep(150);
      if (await page.eval<boolean>(`document.activeElement === ${box}`)) return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
    if (attempt === 3) throw new Error('the Notes box lost the focus');
  }
}

/** Writes a note in the box and adds it with ↵ (or the Add button): the box is empty again. */
async function writeNote(page: Cdp, text: string, how: 'enter' | 'button' = 'enter') {
  const before = await page.eval<number>(openCount);
  await focusBox(page);
  await page.send('Input.insertText', { text });
  if (how === 'enter') await pressEnter(page);
  else await page.eval(`document.querySelector('[data-notes-box-add]').click()`);
  await page.waitFor(
    `${openCount} === ${before + 1} && ${box}.value === ''`,
    `"${text.slice(0, 30)}" added, the box empty`,
  );
}

/** Where an element's centre is on the page. */
const centreOf = (page: Cdp, selector: string) =>
  page.eval<{ x: number; y: number }>(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

/** Drags files from the system over a point, then drops them there unless `drop` is false. */
async function dragFiles(page: Cdp, at: { x: number; y: number }, files: string[], drop = true) {
  const data = { items: [], files, dragOperationsMask: 1 };
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await page.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
  if (drop) await page.send('Input.dispatchDragEvent', { type: 'drop', ...at, data });
}

/** Whether the notes list shows its end, as an expression. */
const listAtEnd = `(() => { const l = document.querySelector('[data-notes-list]'); return l.scrollHeight - l.scrollTop - l.clientHeight < 4; })()`;

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

    // 2. The Notes panel (⇧⌘K) and its box: an empty ↵ adds nothing, ⌥⌘N
    // focuses the box without adding a note, ↵ adds one, the Add button too.
    await pressShortcut(page, 'notes');
    await page.waitFor(has('[data-notes-panel]'), 'the Notes panel');
    await focusBox(page);
    await pressEnter(page);
    await sleep(300);
    assert.equal(await page.eval(openCount), 0, 'an empty box adds nothing');
    assert.equal(await page.eval(`${box}.value`), '', 'nor types a new line');
    assert.equal(
      await page.eval(`document.querySelector('[data-notes-box-add]').disabled`),
      true,
      'Add is off while the box is empty',
    );
    await writeNote(page, 'Also update the changelog');
    await writeNote(page, 'Then run the linter', 'button');
    assert.deepEqual(await page.eval(notesIn('open')), [
      'Also update the changelog',
      'Then run the linter',
    ]);
    const tips = await page.eval<string[]>(
      `['add', 'send', 'hold'].map((b) => document.querySelector('[data-notes-box-' + b + ']').title)`,
    );
    assert.match(tips[0] ?? '', /↵|Enter/);
    assert.ok(tips[1]?.includes(hint('noteSendNow', process.platform === 'darwin')), tips[1]);
    assert.ok(tips[2]?.includes(hint('noteQueue', process.platform === 'darwin')), tips[2]);
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
      `JSON.stringify(${notesIn('sent')}) === '["Also update the changelog","Then run the linter"]'`,
      'both notes sent, the oldest first',
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
    // Text left in the box stays there when the panel closes, until it is added.
    await focusBox(page);
    await page.send('Input.insertText', { text: 'A last thought' });
    await pressShortcut(page, 'notes');
    await page.waitFor(`!document.querySelector('[data-notes-panel]')`, 'the panel closed');
    await pressShortcut(page, 'notes');
    await page.waitFor(`${box}?.value === 'A last thought'`, 'the box kept its text');
    await focusBox(page);
    await pressEnter(page);
    await page.waitFor(`!!${noteWith('A last thought')} && ${box}.value === ''`, 'added');
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
    // ⇧↵ types a new line in the box; ↵ then adds both lines as one note.
    await focusBox(page);
    await page.send('Input.insertText', { text: 'Held by key' });
    await pressEnter(page, MOD.shift);
    await page.send('Input.insertText', { text: 'on two lines' });
    assert.equal(await page.eval(`${box}.value`), 'Held by key\non two lines');
    await pressEnter(page);
    await page.waitFor(`!!${noteWith('Held by key\non two lines')}`, 'a two-line note');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-notes-footer]')?.innerText ?? ''`),
      /All 2, as one prompt/,
    );
    // Esc in the box leaves it, as Esc in a note does.
    await focusBox(page);
    await pressKey(page, 'Escape');
    await page.waitFor(`document.activeElement?.matches('[data-notes-panel]')`, 'the box left');
    await page.eval(`${noteWith('A last thought')}.querySelector('[data-note-text]').focus()`);
    await page.waitFor(`document.activeElement?.matches('textarea[data-note-text]')`, 'in a note');
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
    // A draft in the terminal while Claude is done: ⌥↵ in a note holds it,
    // waiting on the draft; ⌘↵ in the box adds a note and is refused, naming
    // the draft, and Queue instead holds that one too. Then a click into the terminal to focus it, on the prompt line
    // (where Claude Code would move its cursor), and ⌫ until the prompt is
    // empty, without ↵: both go by themselves.
    const draft = 'half a thought';
    await typeInTerminal(page, draft, false);
    await page.waitFor(`${promptText} === ${JSON.stringify(draft)}`, 'the draft in the input box');
    const twoLines = 'Held by key\non two lines';
    await page.eval(`${noteWith(twoLines)}.querySelector('[data-note-text]').focus()`);
    await pressShortcut(page, 'noteQueue');
    await page.waitFor(
      `${noteWith(twoLines)}?.dataset.noteState === 'held' && ${noteWith(twoLines)}.querySelector('[data-note-queued]').textContent.includes(${JSON.stringify(WAITING_DRAFT)})`,
      '⌥↵ held it, waiting on the draft',
    );
    await focusBox(page);
    await page.send('Input.insertText', { text: 'Sent from the box' });
    await pressShortcut(page, 'noteSendNow');
    await page.waitFor(
      `!!${noteWith('Sent from the box')}?.querySelector('[data-note-queue-instead]')`,
      '⌘↵ in the box added it, refused over the draft',
    );
    assert.equal(await page.eval(`${box}.value`), '', 'the box empty again');
    assert.match(
      await page.eval<string>(refusalOf('Sent from the box')),
      /^There may be text in Claude's prompt: send it or clear it with Ctrl\+C/,
    );
    await page.eval(
      `${noteWith('Sent from the box')}.querySelector('[data-note-queue-instead]').click()`,
    );
    await page.waitFor(
      `${noteWith('Sent from the box')}?.dataset.noteState === 'held'`,
      'Queue instead held it',
    );
    // In a chat's order: Sent, then Queued, then the open notes.
    assert.equal(
      await page.eval<boolean>(
        `(() => { const [s, q, o] = ['[data-notes-sent]', '[data-notes-queued-section]', '[data-notes-open]'].map((x) => document.querySelector(x)); return !!(s.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(q.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING); })()`,
      ),
      true,
      'Sent, Queued, then open',
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
        `[${noteWith(twoLines)}?.dataset.noteState, ${noteWith('Sent from the box')}?.dataset.noteState]`,
      ),
      ['held', 'held'],
      'one character of the draft left: still waiting',
    );
    await pressKey(page, 'Backspace');
    await page.waitFor(
      `${notesIn('sent')}.includes(${JSON.stringify(twoLines)}) && ${notesIn('sent')}.includes('Sent from the box')`,
      'both sent by themselves once the draft was deleted',
      5_000,
    );

    // A click while the terminal has the focus reaches Claude, which may move
    // its cursor there; the keys can't follow that, Claude's screen can: once
    // it shows the prompt empty after ⌫, a queued note goes.
    // ⌥↵ in the box adds a note and holds it.
    await page.waitFor(`${promptText} === ''`, "Claude's prompt empty after the last send");
    await sleep(500);
    await typeInTerminal(page, 'more', false);
    await page.waitFor(`${promptText} === 'more'`, 'a second draft');
    await focusBox(page);
    await page.send('Input.insertText', { text: 'After a click in the draft' });
    await pressShortcut(page, 'noteQueue');
    await page.waitFor(
      `${noteWith('After a click in the draft')}?.querySelector('[data-note-queued]')?.textContent.includes(${JSON.stringify(WAITING_DRAFT)})`,
      '⌥↵ in the box held it behind the second draft',
    );
    assert.equal(await page.eval(`${box}.value`), '', 'the box empty again');
    await page.eval(
      `document.querySelector('main [data-terminal] .xterm-helper-textarea')?.focus()`,
    );
    assert.equal(await page.eval(terminalFocused), true, 'the terminal has the focus');
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

    // Room for long notes: a pasted log grows the box at once, up to 40% of
    // the panel's height, then it scrolls; added, the box shrinks back and
    // the list shows the new note at its end. The note shows its first four
    // lines; Show more shows all of it in place, Show less clamps it again.
    const log = Array.from({ length: 60 }, (_, i) => `log line ${i + 1}: request took 12 ms`).join(
      '\n',
    );
    await focusBox(page);
    const empty = await page.eval<number>(`${box}.clientHeight`);
    await page.send('Input.insertText', { text: log });
    const grown = await page.eval<{ height: number; scroll: number; panel: number }>(
      `({ height: ${box}.clientHeight, scroll: ${box}.scrollHeight, panel: document.querySelector('[data-notes-panel]').clientHeight })`,
    );
    assert.ok(grown.height > 120, `the box grew with the paste (${grown.height}px)`);
    assert.ok(grown.height <= grown.panel * 0.4 + 2, `at most 40% (${JSON.stringify(grown)})`);
    assert.ok(grown.scroll > grown.height + 100, 'then it scrolls');
    await screenshot(page, screenshotDir, 'n5-box-grown.png');
    await pressEnter(page);
    await page.waitFor(`!!${noteWith(log)} && ${box}.value === ''`, 'the log added');
    assert.equal(await page.eval(`${box}.clientHeight`), empty, 'the box shrank back');
    assert.equal(
      await page.eval(
        `[...document.querySelectorAll('[data-notes-open] [data-note]')].at(-1) === ${noteWith(log)}`,
      ),
      true,
      'the newest last',
    );
    await page.waitFor(listAtEnd, 'the list at its newest note');
    const clamp = `${noteWith(log)}.querySelector('[data-note-clamp]')`;
    const preview = await page.eval<{ height: number; scroll: number; clamp: string }>(
      `({ height: ${clamp}.clientHeight, scroll: ${clamp}.scrollHeight, clamp: getComputedStyle(${clamp}).webkitLineClamp })`,
    );
    assert.equal(preview.clamp, '4', 'four lines, then "…"');
    assert.ok(preview.height < 100 && preview.scroll > preview.height, JSON.stringify(preview));
    await page.eval(`${noteWith(log)}.querySelector('[data-note-more]').click()`);
    await page.waitFor(
      `${clamp}.clientHeight > 600 && ${noteWith(log)}.querySelector('[data-note-more]').textContent === 'Show less'`,
      'Show more showed all of it',
    );
    assert.equal(
      await page.eval(`document.activeElement?.matches('textarea[data-note-text]') ?? false`),
      false,
      'without editing it',
    );
    await screenshot(page, screenshotDir, 'n6-show-more.png');
    await page.eval(`${noteWith(log)}.querySelector('[data-note-more]').click()`);
    await page.waitFor(`${clamp}.clientHeight < 100`, 'Show less clamped it again');
    // A short note has no Show more.
    assert.equal(
      await page.eval(`!!${noteWith('A last thought')}.querySelector('[data-note-more]')`),
      false,
    );

    // Focus after an action (spec §6.15): from a focused button, the focus
    // follows the item to its new section, or goes to the box once it's gone.
    const pressOn = (text: string, button: string) =>
      page.eval(
        `(() => { const n = ${noteWith(text)}; n.focus(); const b = n.querySelector('${button}'); b.focus(); b.click(); })()`,
      );
    const inFocus = (text: string) => `document.activeElement === ${noteWith(text)}`;
    await pressOn('Also update the changelog', '[data-note-reopen]');
    await page.waitFor(
      `${noteWith('Also update the changelog')}?.dataset.noteState === 'open' && ${inFocus('Also update the changelog')}`,
      'Move back: the item in focus among the open ones',
    );
    await page.waitFor(`${promptText} === ''`, "Claude's prompt empty");
    await typeInTerminal(page, 'x', false);
    await page.waitFor(`${promptText} === 'x'`, 'a draft to hold a note');
    await pressOn('A last thought', '[data-note-hold]');
    await page.waitFor(
      `${noteWith('A last thought')}?.dataset.noteState === 'held' && ${inFocus('A last thought')}`,
      'When done: the item in focus in Queued',
    );
    await pressOn('A last thought', '[data-note-cancel]');
    await page.waitFor(
      `${noteWith('A last thought')}?.dataset.noteState === 'open' && ${inFocus('A last thought')}`,
      'Cancel: the item in focus among the open ones',
    );
    await pressOn('A last thought', '[data-note-delete]');
    await page.waitFor(
      `!${noteWith('A last thought')} && document.activeElement === ${box}`,
      'deleted: the box in focus',
    );
    await typeInTerminal(page, '', false);
    await pressKey(page, 'Backspace');
    await page.waitFor(`${promptText} === ''`, 'the draft gone');

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
    await writeNote(page, 'First words');
    // The panel opening resized the terminal: Claude redraws its prompt first.
    await sleep(700);
    await page.eval(`${noteWith('First words')}.querySelector('[data-note-send-now]').click()`);
    await page.waitFor(`${notesIn('sent')}.includes('First words')`, 'sent now in Starting');
    await page.waitFor(`${screenText}.includes('Noted: First words')`, 'Claude took it');

    // Files into the box (spec §6.16): dropped, chosen with its Add files and
    // with ⇧⌘A in it; at the caret, as Claude's prompt would get them, and
    // nothing typed into Claude. Sent, the note gives Claude the paths.
    const tree = execFileSync('git', ['-C', web, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.replace(/^worktree /, ''))
      .find((l) => l.endsWith('NOTE-2-fresh'));
    assert.ok(tree, 'the second workspace’s worktree');
    fs.mkdirSync(path.join(tree, 'src'));
    fs.writeFileSync(path.join(tree, 'src', 'a.ts'), 'x');
    const farLog = path.join(fx.root, 'my docs', 'log 1.txt');
    fs.mkdirSync(path.dirname(farLog));
    fs.writeFileSync(farLog, 'x');
    await app.main.eval(`(() => {
      const { dialog } = process.mainModule.require('electron');
      globalThis.__filePicker = { answer: [] };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.__filePicker.answer });
    })()`);
    const answerPicker = (paths: string[]) =>
      app?.main.eval(`globalThis.__filePicker.answer = ${JSON.stringify(paths)}`);
    await focusBox(page);
    await page.send('Input.insertText', { text: 'Look at' });
    const boxAt = await centreOf(page, '[data-notes-box]');
    await dragFiles(page, boxAt, [path.join(tree, 'src', 'a.ts')], false);
    await page.waitFor(has('[data-drop-target="note"]'), "the box's drop highlight");
    await screenshot(page, screenshotDir, 'n6-drop-on-box.png');
    await dragFiles(page, boxAt, [path.join(tree, 'src', 'a.ts')]);
    await page.waitFor(`${box}.value === 'Look at @src/a.ts '`, 'the dropped file in the box');
    await page.waitFor(`!${has('[data-drop-target]')}`, 'no highlight after the drop');
    await answerPicker([farLog]);
    await page.eval(`document.querySelector('[data-notes-box-files]').click()`);
    await page.waitFor(
      `${box}.value === ${JSON.stringify(`Look at @src/a.ts '${farLog}' `)}`,
      'the chosen file in the box',
    );
    await answerPicker([path.join(tree, 'src')]);
    await page.waitFor(`document.activeElement === ${box}`, 'the box in focus again');
    await pressShortcut(page, 'addFiles');
    const noted = `Look at @src/a.ts '${farLog}' @src/`;
    await page.waitFor(`${box}.value === ${JSON.stringify(`${noted} `)}`, '⇧⌘A in the box');
    assert.equal(await page.eval(promptText), '', "nothing typed into Claude's prompt");
    await pressShortcut(page, 'noteSendNow');
    await page.waitFor(
      `${screenText}.replaceAll('\\n', '').includes(${JSON.stringify(`Noted: ${noted}`)})`,
      'Claude got the paths with the note',
    );
    // Claude has ended: the refusal says so.
    await typeInTerminal(page, 'exit');
    await page.waitFor(`${screenText}.includes('process exited')`, 'Claude ended');
    await writeNote(page, 'Too late');
    await page.eval(`${noteWith('Too late')}.querySelector('[data-note-send-now]').click()`);
    await page.waitFor(
      `${refusalOf('Too late')}.startsWith("Claude isn't running in this workspace")`,
      'refused: Claude has ended',
    );

    // Right after opening (spec §6.7): Send now from the box as soon as the
    // new Claude's prompt is on screen, before the view's report of it can
    // have reached the main process. It waits for that report, not refused.
    await clickLabel(page, 'New workspace in web');
    await page.waitFor(has('dialog[open] #ws-task'), 'New workspace');
    await typeInField(page, '#ws-task', 'NOTE-3 Quick', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the third workspace', 30_000);
    // The note is ready in the box while Claude starts; Send now goes the
    // moment its prompt shows.
    await focusBox(page);
    await page.send('Input.insertText', { text: 'Straight away' });
    await page.waitFor(
      `${promptText} === '' && !document.querySelector('[data-notes-box-send]').click()`,
      "its Claude's empty input box, and Send now at once",
      30_000,
    );
    await page.waitFor(`${notesIn('sent')}.includes('Straight away')`, 'sent right after opening');
    await page.waitFor(`${screenText}.includes('Noted: Straight away')`, 'Claude took it at once');

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
