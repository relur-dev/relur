/**
 * End-to-end test of adding files to a terminal (spec §6.16): files dragged
 * over Claude's terminal highlight it; dropped, their paths go into Claude's
 * prompt as `@path` (inside the worktree) or absolute and quoted (outside),
 * one paste per file and never followed by Enter. Add files and ⇧⌘A with the
 * system's picker (replaced here) do the same. A shell tab gets the quoted
 * absolute paths. At a permission request a drop is refused with the reason
 * and types nothing; a drop elsewhere in the window does nothing.
 * Runs with a throwaway HOME and a fake `claude` that logs every key it gets.
 *
 *   tsx scripts/e2e-drop.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
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
  clickLabel,
  launchApp,
  MOD,
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
 * A stand-in for Claude, in Node: SessionStart, then its input box between
 * two rules (as Claude Code draws it), a paste and typed keys going into it.
 * Enter on `permission` asks for permission (a Notification), on `allow`
 * goes on working (PostToolUse); other text is a prompt. Every chunk it
 * reads is logged to claude-input.jsonl, and its folder to claude-cwd.txt.
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
fs.writeFileSync(process.env.HOME + '/claude-cwd.txt', process.cwd());
const settings = argv[argv.indexOf('--settings') + 1];
const helper = /"command": "'(.*)' hook SessionStart"/.exec(fs.readFileSync(settings, 'utf8'))[1];
const sessionId = 'drop';
const transcript = process.env.HOME + '/transcript-drop.jsonl';
const hook = (event, payload) =>
  execFileSync(helper, ['hook', event], { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, ...payload }) });
let draft = '';
const rule = () => '\\u2500'.repeat(process.stdout.columns || 80);
const promptLine = () => draft ? '\\u276f\\u00a0' + draft : '\\u276f\\u00a0\\u001b[2mTry "something"\\u001b[0m\\r\\u001b[2C';
const box = () => process.stdout.write(rule() + '\\r\\n' + '\\r\\n' + rule() + '\\u001b[1A\\r' + promptLine());
const redraw = () => process.stdout.write('\\r\\u001b[2K' + promptLine());
const out = (text) => { process.stdout.write('\\u001b[1A\\r\\u001b[J' + text); box(); };
process.stdout.on('resize', () => { process.stdout.write('\\u001b[1A\\r\\u001b[J'); box(); });
hook('SessionStart', {});
console.log('fake claude');
box();
let buffer = '';
const START = '\\u001b[200~';
const END = '\\u001b[201~';
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(process.env.HOME + '/claude-input.jsonl', JSON.stringify(chunk) + '\\n');
  buffer += chunk;
  for (;;) {
    const start = buffer.indexOf(START);
    if (start === 0) {
      const end = buffer.indexOf(END);
      if (end === -1) return;
      draft += buffer.slice(START.length, end);
      buffer = buffer.slice(end + END.length);
      redraw();
      continue;
    }
    const key = /^(?:\\u001b\\[[0-?]*[ -\\/]*[@-~]|\\u001b[\\s\\S]?|[\\s\\S])/.exec(buffer);
    if (!key) return;
    buffer = buffer.slice(key[0].length);
    const k = key[0];
    if (k === '\\r' || k === '\\n') {
      const line = draft.trim();
      draft = '';
      redraw();
      if (line === 'permission') hook('Notification', { message: 'Claude needs your permission to use Bash' });
      else if (line === 'allow') hook('PostToolUse', { tool_name: 'Bash' });
      else if (line) { out('\\u276f ' + line + '\\r\\n'); hook('UserPromptSubmit', { prompt: line }); hook('Stop', {}); }
    } else if (k === '\\u007f') { draft = draft.slice(0, -1); redraw(); }
    else if (k === '\\u0003' || k === '\\u0015') { draft = ''; redraw(); }
    else if (k >= ' ') { draft += k; redraw(); }
    if (buffer === '') return;
  }
});
setInterval(() => {}, 1 << 30);
`;

/** The shown, connected terminal, as an expression. */
const shownTerminal = `[...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent)`;

/** The shown terminal's text, from xterm's buffer, as an expression. */
const screenText = `(() => { const b = ${shownTerminal}?.xterm?.buffer.active; if (!b) return ''; let s = ''; for (let y = 0; y < b.length; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s; })()`;

/** The text in Claude's input box as the shown terminal draws it, as an expression. */
const promptText = `(() => { const b = ${shownTerminal}?.xterm?.buffer.active; const line = b?.getLine(b.baseY + b.cursorY)?.translateToString(true); if (!line?.startsWith('\\u276f')) return null; return line.includes('Try "something"') ? '' : line.slice(2).trimEnd(); })()`;

const has = (selector: string) => `!!document.querySelector(${JSON.stringify(selector)})`;

/** Where an element's centre is on the page. */
const centreOf = (page: Cdp, selector: string) =>
  page.eval<{ x: number; y: number }>(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

/** Drags files from the system over a point (dragEnter, dragOver), as real input. */
async function dragOver(page: Cdp, at: { x: number; y: number }, files: string[]) {
  const data = { items: [], files, dragOperationsMask: 1 };
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await page.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
}

/** Drops files from the system at a point, as real input. */
async function drop(page: Cdp, at: { x: number; y: number }, files: string[]) {
  await dragOver(page, at, files);
  const data = { items: [], files, dragOperationsMask: 1 };
  await page.send('Input.dispatchDragEvent', { type: 'drop', ...at, data });
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
    // Files outside any worktree: a name with spaces, and a folder.
    const outside = path.join(fx.root, 'outside dir');
    fs.mkdirSync(path.join(outside, 'assets'), { recursive: true });
    const shot = path.join(outside, 'shot 1.png');
    fs.writeFileSync(shot, 'png');
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
    const { page, main: mainProcess } = app;
    // Only the system's file picker is replaced.
    await mainProcess.eval(`(() => {
      const { dialog } = process.mainModule.require('electron');
      globalThis.__filePicker = { answer: [], options: null };
      dialog.showOpenDialog = async (...a) => {
        globalThis.__filePicker.options = a.at(-1);
        return { canceled: globalThis.__filePicker.answer.length === 0, filePaths: globalThis.__filePicker.answer };
      };
    })()`);
    const answerPicker = (paths: string[]) =>
      mainProcess.eval(`globalThis.__filePicker.answer = ${JSON.stringify(paths)}`);

    // 1. A workspace; its Claude shows its prompt. Files in its worktree.
    await clickLabel(page, 'New workspace in web');
    await page.waitFor(has('dialog[open] #ws-task'), 'New workspace');
    await typeInField(page, '#ws-task', 'DROP-1 Drop files', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace created', 30_000);
    await page.waitFor(`${promptText} === ''`, "Claude's empty prompt", 30_000);
    const cwdFile = path.join(fx.root, 'claude-cwd.txt');
    const worktree = fs.readFileSync(cwdFile, 'utf8');
    fs.mkdirSync(path.join(worktree, 'src'));
    fs.mkdirSync(path.join(worktree, 'my notes'));
    const appTs = path.join(worktree, 'src', 'app.ts');
    const plan = path.join(worktree, 'my notes', 'plan a.md');
    fs.writeFileSync(appTs, 'x');
    fs.writeFileSync(plan, 'x');
    const inputLog = path.join(fx.root, 'claude-input.jsonl');
    const input = () =>
      fs.existsSync(inputLog)
        ? fs
            .readFileSync(inputLog, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as string)
            .join('')
        : '';
    /** What Claude got as pastes since `from` (a length of the log), their texts joined. */
    const pasted = (from: number) =>
      input()
        .slice(from)
        .split('\x1b[200~')
        .slice(1)
        .map((p) => p.split('\x1b[201~')[0])
        .join('');
    const waitPasted = async (from: number, text: string, what: string) => {
      for (let i = 0; i < 100 && pasted(from) !== text; i++) {
        const refused = await page.eval<string | null>(
          `document.querySelector('[data-drop-refusal]')?.innerText ?? null`,
        );
        if (refused) throw new Error(`${what}: refused: ${refused}`);
        await sleep(100);
      }
      assert.equal(pasted(from), text, what);
    };
    // Keys before the drop: focus reports and the like.
    const before = input().length;

    // 2. Dragged over Claude's terminal: the highlight, gone when the drag leaves.
    const terminal = await centreOf(page, '[data-terminal]');
    await dragOver(page, terminal, [appTs]);
    await page.waitFor(has('[data-drop-target="claude"]'), 'the drop highlight');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-drop-target]').innerText`),
      /Add to Claude's prompt/,
    );
    await screenshot(page, screenshotDir, 'd1-drag-over.png');
    // Moved on to the header, then cancelled.
    const header = await centreOf(page, 'header');
    await page.send('Input.dispatchDragEvent', {
      type: 'dragOver',
      ...header,
      data: { items: [], files: [appTs], dragOperationsMask: 1 },
    });
    await page.waitFor(`!${has('[data-drop-target]')}`, 'the highlight gone off the terminal');
    await page.send('Input.dispatchDragEvent', {
      type: 'dragCancel',
      ...header,
      data: { items: [], files: [appTs], dragOperationsMask: 1 },
    });

    // 3. Dropped: @paths inside the worktree, the outside file absolute and
    //    quoted, a folder with its slash; one paste each, and no Enter.
    await drop(page, terminal, [appTs, plan, shot, path.join(worktree, 'src')]);
    const expected = `@src/app.ts @"my notes/plan a.md" '${shot}' @src/ `;
    await waitPasted(before, expected, 'the paths pasted into the prompt');
    await page.waitFor(
      `${screenText}.includes(${JSON.stringify(`\u276f\u00a0@src/app.ts @"my notes/plan a.md"`)})`,
      'the paths in the prompt',
    );
    await page.waitFor(`!${has('[data-drop-target]')}`, 'no highlight after the drop');
    await screenshot(page, screenshotDir, 'd2-dropped.png');
    const typed = input().slice(before);
    assert.equal(
      typed.split(`\x1b[200~`).length - 1,
      4,
      `one paste per file: ${JSON.stringify(typed)}`,
    );
    assert.ok(!/[\r\n]/.test(typed), `no Enter: ${JSON.stringify(typed)}`);
    // Nothing was sent: no prompt reached Claude.
    await sleep(500);
    assert.ok(!(await page.eval<string>(screenText)).includes('❯ @src'), 'not sent');

    // 4. Add files with the picker (button, then ⇧⌘A): after the draft, with a space.
    const afterDrop = input().length;
    await answerPicker([path.join(outside, 'assets')]);
    await page.eval(`document.querySelector('[data-add-files]').click()`);
    // The draft ends with a space: none added before it.
    await waitPasted(afterDrop, `'${outside}/assets' `, 'the chosen folder');
    const options = await mainProcess.eval<{ properties: string[] }>(
      'globalThis.__filePicker.options',
    );
    assert.ok(options.properties.includes('multiSelections'), 'several files at once');
    await pressKey(page, 'KeyU', MOD.ctrl);
    await page.waitFor(`${promptText} === ''`, 'the prompt cleared');
    // After a word typed: a space first.
    await typeInTerminal(page, 'see', false);
    await page.waitFor(`${promptText} === 'see'`, 'a word typed');
    await answerPicker([appTs]);
    await pressShortcut(page, 'addFiles');
    await page.waitFor(`${promptText} === 'see @src/app.ts'`, 'the file chosen with ⇧⌘A');
    // Cancelled: nothing.
    await answerPicker([]);
    await pressShortcut(page, 'addFiles');
    await sleep(500);
    assert.equal(await page.eval(promptText), 'see @src/app.ts');
    await pressKey(page, 'KeyU', MOD.ctrl);
    await page.waitFor(`${promptText} === ''`, 'the prompt cleared again');

    // 5. A drop elsewhere in the window does nothing.
    const atHeader = header;
    await dragOver(page, atHeader, [appTs]);
    await sleep(300);
    assert.ok(!(await page.eval<boolean>(has('[data-drop-target]'))), 'no highlight elsewhere');
    await drop(page, atHeader, [appTs]);
    await sleep(800);
    assert.equal(await page.eval(promptText), '', 'nothing typed');
    assert.ok(!(await page.eval<boolean>(has('[data-drop-refusal]'))), 'no message either');
    assert.ok(await page.eval<boolean>(has('[data-terminal]')), 'the page stays');

    // 6. At a permission request: refused with the reason, nothing typed.
    await typeInTerminal(page, 'permission');
    await page.waitFor(
      `!!document.querySelector('nav button[title^="DROP-1 Drop files"] [aria-label="Needs permission"]')`,
      'Claude asking for permission',
    );
    const beforeRefusal = input().length;
    await drop(page, terminal, [appTs]);
    await page.waitFor(has('[data-drop-refusal]'), 'the refusal', 10_000);
    assert.match(
      await page.eval<string>(`document.querySelector('[data-drop-refusal]').innerText`),
      /Claude is asking for permission: answer it, then add the files/,
    );
    await screenshot(page, screenshotDir, 'd3-refused.png');
    await sleep(500);
    assert.equal(input().slice(beforeRefusal), '', 'nothing typed into the menu');
    assert.equal(await page.eval(promptText), '');
    await typeInTerminal(page, 'allow');

    // 7. A shell tab: the quoted absolute paths, as a terminal's own drop.
    await pressShortcut(page, 'newShell');
    await page
      .waitFor(
        `${shownTerminal} && ${shownTerminal}.dataset.terminal !== ${JSON.stringify(
          await page.eval<string>(`document.querySelector('[data-terminal]').dataset.terminal`),
        )}`,
        'the shell tab',
        15_000,
      )
      .catch(() => undefined);
    await page.waitFor(`/[%$#>] *$/m.test(${screenText})`, 'the shell prompt', 15_000);
    await dragOver(page, await centreOf(page, '[data-terminal]'), [shot]);
    await page.waitFor(has('[data-drop-target="shell"]'), "the shell's highlight");
    await drop(page, await centreOf(page, '[data-terminal]'), [shot, appTs]);
    await page.waitFor(
      // Long lines wrap: the screen's lines joined.
      `${screenText}.replaceAll('\\n', '').includes(${JSON.stringify(`'${shot}' ${appTs}`)})`,
      'the quoted paths in the shell',
    );
    await sleep(500);
    assert.ok(
      !(await page.eval<string>(screenText)).includes('not found'),
      'not run: no Enter after them',
    );
    await screenshot(page, screenshotDir, 'd4-shell.png');

    console.log('E2E DROP: PASS');
  } catch (error) {
    const shown = await app?.page.eval<string>(`document.body.innerText`).catch(() => '');
    console.error(`The window showed:\n${shown?.slice(0, 3000)}`);
    console.error(`The terminal:\n${await app?.page.eval<string>(screenText).catch(() => '')}`);
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
