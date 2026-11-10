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
 * line typed `begin` starts a turn (a prompt, UserPromptSubmit) and `finish`
 * ends it (Claude's text, Stop, then the transcript, as Claude Code writes
 * it). A paste and Enter while a turn runs is taken into it, as Claude Code
 * does (a `queued_command` attachment, checked live with 2.1.321); while
 * idle, it is a prompt of its own, answered at once.
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
const transcript = process.env.HOME + '/transcript-notes.jsonl';
const hook = (event, payload) =>
  execFileSync(helper, ['hook', event], { input: JSON.stringify({ session_id: 'notes', transcript_path: transcript, ...payload }) });
const write = (entry) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\\n');
let n = 0;
const id = () => 'uuid-' + ++n;
let busy = false;
const prompt = (text) => {
  write({ type: 'user', uuid: id(), origin: { kind: 'human' }, message: { role: 'user', content: text } });
  process.stdout.write('\\u276f ' + text.split('\\n')[0] + '\\n');
  hook('UserPromptSubmit', { prompt: text });
};
const answer = (text) => {
  process.stdout.write('\\u23fa ' + text + '\\n\\n');
  hook('Stop', { last_assistant_message: text });
  write({ type: 'assistant', uuid: id(), message: { id: 'm' + n, role: 'assistant', content: [{ type: 'text', text }] } });
};
hook('SessionStart', {});
console.log('fake claude');
let buffer = '';
const START = '\\u001b[200~';
const END = '\\u001b[201~';
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
    const nl = buffer.search(/[\\r\\n]/);
    if (nl === -1) return;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === 'begin') { busy = true; prompt('Start the work'); }
    else if (line === 'finish') { busy = false; answer('Finished the work.'); }
  }
});
setInterval(() => {}, 1 << 30);
`;

/** The shown terminal's text, from xterm's buffer, as an expression. */
const screenText = `(() => { const t = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent); const b = t?.xterm?.buffer.active; if (!b) return ''; let s = ''; for (let y = 0; y < b.length; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s; })()`;

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
    // on it; ⌘↵ is refused and Queue instead holds that one too. Both go by
    // themselves once the draft is deleted with ⌫, without ↵.
    const draft = 'half a thought';
    await typeInTerminal(page, draft, false);
    await sleep(300);
    await page.eval(`${noteWith('Held by key')}.querySelector('[data-note-text]').focus()`);
    await pressShortcut(page, 'noteQueue');
    await page.waitFor(
      `${noteWith('Held by key')}?.dataset.noteState === 'held' && ${noteWith('Held by key')}.querySelector('[data-note-queued]').textContent.includes('an unsent prompt in the terminal')`,
      '⌥↵ held it, waiting on the draft',
    );
    await page.eval(`${noteWith('A last thought')}.querySelector('[data-note-text]').focus()`);
    await pressShortcut(page, 'noteSendNow');
    await page.waitFor(
      `!!${noteWith('A last thought')}?.querySelector('[data-note-queue-instead]')`,
      '⌘↵ refused over the draft',
    );
    await page.eval(
      `${noteWith('A last thought')}.querySelector('[data-note-queue-instead]').click()`,
    );
    await page.waitFor(
      `${noteWith('A last thought')}?.dataset.noteState === 'held'`,
      'Queue instead held it',
    );
    await page.waitFor(
      `[...document.querySelectorAll('[data-note-queued]')].some((q) => q.textContent.includes('an unsent prompt in the terminal'))`,
      'the waiting line names the draft',
    );
    await screenshot(page, screenshotDir, 'n4-queued-by-key.png');
    await typeInTerminal(page, '', false);
    for (let i = 1; i < draft.length; i++) await pressKey(page, 'Backspace');
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

    console.log(`e2e-notes: ok (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    const shown = await app?.page.eval<string>(`document.body.innerText`).catch(() => '');
    console.error(`The window showed:\n${shown?.slice(0, 3000)}`);
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
