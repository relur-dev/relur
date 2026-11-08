/**
 * End-to-end smoke test. Launches the app with a throwaway HOME, drives the UI
 * over the Chrome DevTools Protocol and checks the results on disk.
 *
 *   tsx scripts/e2e-smoke.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 *
 * Without --dev it runs the production build in out/ (run `npm run build`
 * first). With --dev it runs `electron-vite dev`, as `npm run dev` does:
 * development React, StrictMode and the Vite dev server, where some bugs only
 * show up. `npm run e2e` runs both.
 *
 * Only the native folder panel is replaced, in the main process through the
 * Node inspector; the IPC path from the renderer to it is real.
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import { BRAND, envVar } from '../src/shared/brand';
import { LOOKUP_DENIED_TOOLS } from '../src/shared/lookup';
import { hint as shortcutHint } from '../src/shared/shortcuts';
import { LINK_TRUST_NOTE } from '../src/shared/workspaces';
import {
  assertExitedCleanly,
  type Cdp,
  CMD,
  chooseFromNextContextMenu,
  clickButtonText,
  clickLabel,
  dialogText,
  hasButton,
  launchApp,
  MOD,
  openContextMenu,
  pressEnter,
  pressKey,
  pressShortcut,
  type RunningApp,
  reloadPage,
  screenshot,
  showHomeTerminal,
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

const typePath = (page: Cdp, text: string) => typeInField(page, '#add-project-folder', text);
const tabCount = `document.querySelectorAll('[role=tablist][aria-label=Terminals] [role=tab]').length`;

const pressCtrlC = (page: Cdp) =>
  page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    modifiers: 2, // Ctrl
  });

const clickProject = (page: Cdp, name: string) =>
  page.eval(
    `[...document.querySelectorAll('nav li button')].find((b) => b.textContent === ${JSON.stringify(name)}).click()`,
  );

/** The sidebar's project rows (spec §6.1); expanded ones by id, sorted. */
function sidebarChecks(page: Cdp) {
  const project = (id: string) => `document.querySelector('[data-project="${id}"]')`;
  const expandedJs = `[...document.querySelectorAll('[data-project]')].filter((p) => p.querySelector('[aria-expanded=true]')).map((p) => p.dataset.project).sort().join()`;
  return {
    expandedJs,
    expanded: () => page.eval<string>(expandedJs),
    toggle: (id: string) => page.eval(`${project(id)}.querySelector('[aria-expanded]').click()`),
    /** [↗ count, own count], each [text, tooltip] or null when not shown. */
    counts: (id: string) =>
      page.eval<([string, string] | null)[]>(
        `['[data-linked-count]', '[data-workspace-count]'].map((s) => { const c = ${project(id)}.querySelector(s); return c ? [c.textContent, c.title] : null; })`,
      ),
    /** The collapsed project's glyph as [state, tooltip], or null. */
    glyphJs: (id: string) =>
      `(() => { const g = ${project(id)}.querySelector('[data-project-glyph] [role=img]'); return g ? [g.getAttribute('aria-label'), g.title] : null; })()`,
  };
}

/** Whether wheel input reaches a program with mouse tracking as one report per line. */
async function checkMouseWheel(page: Cdp, home: string) {
  // Turns on SGR mouse reporting and counts wheel-up reports until there are 4.
  fs.writeFileSync(
    path.join(home, 'wheel.js'),
    `const fs = require('node:fs');
const writeRows = () => fs.writeFileSync(process.env.HOME + '/rows.txt', String(process.stdout.rows));
writeRows();
// The terminal may still be resized after the program starts (slow dev runs).
process.stdout.on('resize', writeRows);
process.stdout.write('\\x1b[?1000h\\x1b[?1006h');
process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', (data) => {
  input += data;
  const reports = input.match(/\\x1b\\[<64;/g) ?? [];
  if (reports.length < 4) return;
  fs.writeFileSync(process.env.HOME + '/wheel.txt', String(reports.length));
  process.stdout.write('\\x1b[?1000l\\x1b[?1006l');
  process.exit(0);
});
`,
  );
  await typeInTerminal(page, 'node ~/wheel.js');
  await waitForFile(path.join(home, 'rows.txt'));
  await sleep(500);
  const rows = Number(await waitForFile(path.join(home, 'rows.txt')));
  const box = await page.eval<{ x: number; y: number; line: number }>(`(() => {
    const r = document.querySelector('[data-terminal] .xterm-screen').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, line: r.height / ${rows} };
  })()`);
  // One event worth four and a half lines of pixels: xterm alone sends one report.
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY: -4.5 * box.line,
  });
  assert.equal(await waitForFile(path.join(home, 'wheel.txt')), '4');
}

/**
 * Whether ⇧↵ reaches a program as ESC ↵, Claude Code's new line, and on macOS
 * ⌘⌫ as ⌃U (spec §6.3).
 */
async function checkTerminalKeys(page: Cdp, home: string) {
  // Records its input in raw mode until a carriage return arrives.
  fs.writeFileSync(
    path.join(home, 'newline.js'),
    `const fs = require('node:fs');
process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', (data) => {
  input += data;
  if (!input.includes('\\r')) return;
  fs.writeFileSync(process.env.HOME + '/newline.txt', JSON.stringify(input));
  process.exit(0);
});
fs.writeFileSync(process.env.HOME + '/newline-ready.txt', 'ready');
`,
  );
  await typeInTerminal(page, 'node ~/newline.js');
  await waitForFile(path.join(home, 'newline-ready.txt'));
  const mac = process.platform === 'darwin';
  if (mac) await pressKey(page, 'Backspace', MOD.meta);
  await pressKey(page, 'Enter', MOD.shift);
  assert.equal(
    JSON.parse(await waitForFile(path.join(home, 'newline.txt'))),
    mac ? '\x15\x1b\r' : '\x1b\r',
  );
}

/**
 * An OSC 8 hyperlink (as Claude Code prints them) opens through the main
 * process, without xterm's confirm() dialog.
 */
async function checkHyperlink(page: Cdp, main: Cdp, home: string) {
  await main.eval(`(() => {
    const { shell } = process.mainModule.require('electron');
    globalThis.__opened = [];
    shell.openExternal = async (url) => { globalThis.__opened.push(url); };
  })()`);
  await page.eval(
    `window.__confirms = 0; window.confirm = () => { window.__confirms++; return true; }`,
  );
  await typeInTerminal(
    page,
    `clear; printf '\\033]8;;https://example.com/osc8\\033\\\\LINK-TEXT\\033]8;;\\033\\\\\\n'; echo shown > "$HOME/link-shown"`,
  );
  await waitForFile(path.join(home, 'link-shown'));
  await sleep(300);
  const rows = Number(fs.readFileSync(path.join(home, 'rows.txt'), 'utf8'));
  const point = await page.eval<{ x: number; y: number }>(`(() => {
    const r = document.querySelector('[data-terminal] .xterm-screen').getBoundingClientRect();
    return { x: r.x + 4, y: r.y + r.height / ${rows} / 2 };
  })()`);
  // xterm finds the link under the pointer on hover, then opens it on click.
  // Finding it can take longer than a hover in the dev build, so hover and
  // click again until it opens.
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const dx of [0, 2]) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x + dx,
        y: point.y,
      });
      await sleep(150 * (attempt + 1));
    }
    const at = { x: point.x + 2, y: point.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
    // Opening goes through the main process: give it a second before clicking again.
    let opened = false;
    for (let i = 0; i < 10 && !opened; i++) {
      await sleep(100);
      opened = await main.eval<boolean>('globalThis.__opened.length > 0');
    }
    if (opened) break;
  }
  await main.waitFor('globalThis.__opened.length > 0', 'the link to open');
  assert.deepEqual(await main.eval('globalThis.__opened'), ['https://example.com/osc8']);
  assert.equal(await page.eval('window.__confirms'), 0, 'no confirm() dialog');
}

const profileVar = envVar('PROFILE');

/** The minute of Done held for background commands (spec §10.2), shortened for the test. */
const MINUTE_MS = 800;
/** The hold's fixed fallback, for a command whose process is never found: 10 minutes. */
const HOLD_DONE_MS = 10 * MINUTE_MS;

async function main() {
  const fx = createFixture();
  const appEnv = () => ({
    ...withDisplayEnv(fx.env),
    [envVar('TEST_MINUTE_MS')]: String(MINUTE_MS),
  });
  let app: RunningApp | undefined;
  try {
    const { clone: repo } = fx.cloneWithRemote('api-service', 'develop');
    fs.mkdirSync(path.join(repo, 'src'));
    fx.localRepo('notes');
    // Keeps zsh from starting its interactive new-user setup in the throwaway HOME.
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: answers the setup check (signed in, made-up
    // account), otherwise records where and how it was started, then waits.
    // Scripted tests never start the real one.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
  # The profile's connectors (spec §13.10): one connected tracker.
  mcp) printf 'Checking MCP server health...\\n\\ntracker: npx tracker-mcp - \\342\\234\\224 Connected\\n'; exit 0 ;;
  # Set up from my skills (spec §13.10): records how it ran, answers with the test's proposal.
  -p) case "$2" in *"helping set up a workflow"*)
      printf '%s\\n' "$@" > "$HOME/claude-proposal-args.txt"; pwd > "$HOME/claude-proposal-cwd.txt"
      cat "$HOME/proposal.json"; exit 0 ;;
    esac
  # A task lookup (spec §13.7): records its arguments, finds no title and says why.
    printf '%s\\n' "$@" > "$HOME/claude-lookup-args.txt"
    printf '%s\\n' '{"type":"result","is_error":false,"result":"{}","permission_denials":[],"structured_output":{"title":null,"missingTool":null,"reason":"The tracker has no task with that key."}}'
    exit 0 ;;
esac
n=$(ls "$HOME" | grep -c '^claude-run-')
# Written in several steps, so it's renamed into place: the test never reads half of it.
{ echo "$PWD"; echo "$${profileVar}"; echo "$${envVar('BRANCH')}"; printf '%s\\n' "$@"; } > "$HOME/.claude-run-$n.tmp"
mv "$HOME/.claude-run-$n.tmp" "$HOME/claude-run-$n.txt"
# Like Claude, it runs the hooks of its --settings file: SessionStart now, and
# a hook per line typed into its terminal (prompt, permission, stop).
settings=""; sid="fake-$n"; prev=""
for arg in "$@"; do
  [ "$prev" = --settings ] && settings="$arg"
  # Like Claude, a new conversation takes the id it's given, a resumed one keeps its own.
  { [ "$prev" = --session-id ] || [ "$prev" = --resume ]; } && sid="$arg"
  prev="$arg"
done
helper=""
[ -n "$settings" ] && helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { [ -n "$helper" ] && printf '%s' "$2" | "$helper" hook "$1"; }
# What SessionStart adds to Claude's context (spec §21.9) is kept.
hook SessionStart "{\\"session_id\\":\\"$sid\\",\\"transcript_path\\":\\"$HOME/transcript-$n.jsonl\\"}" > "$HOME/claude-context-$n.txt"
while IFS= read -r line; do
  case "$line" in
    prompt)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"Fix the login"}}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\235\\257 Fix the login\\n'
      hook UserPromptSubmit '{"prompt":"Fix the login"}' ;;
    permission) hook Notification '{"message":"Claude needs your permission to use Bash"}' ;;
    # Like Claude, the response is printed, the Stop hook runs, then the
    # transcript gets the response.
    stop)
      printf '\\342\\217\\272 Answer one.\\n\\n'
      hook Stop '{"last_assistant_message":"Answer **one**."}'
      printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Answer **one**."}]},"timestamp":"2026-10-28T12:00:00Z"}' >> "$HOME/transcript-$n.jsonl" ;;
    # A response that isn't on the screen: no Copy button for it.
    unseen)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"And now?"}}' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Quiet **two**."}]},"timestamp":"2026-10-28T12:01:00Z"}' >> "$HOME/transcript-$n.jsonl"
      hook Stop '{"last_assistant_message":"Quiet **two**."}' ;;
    # A turn with tool work between Claude's messages (spec §6.8): one entry, three parts.
    parts)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"Tidy the README"},"origin":{"kind":"human"}}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\235\\257 Tidy the README\\n'
      hook UserPromptSubmit '{"prompt":"Tidy the README"}'
      printf '%s\\n' '{"type":"assistant","message":{"id":"p1","role":"assistant","content":[{"type":"text","text":"Reading it first."}]},"timestamp":"2026-10-28T12:03:00Z"}' '{"type":"assistant","message":{"id":"p1","role":"assistant","content":[{"type":"tool_use","name":"Read"}]},"timestamp":"2026-10-28T12:03:00Z"}' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}' '{"type":"assistant","message":{"id":"p2","role":"assistant","content":[{"type":"text","text":"Fixed the **links**."},{"type":"tool_use","name":"Edit"}]},"timestamp":"2026-10-28T12:04:00Z"}' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}' '{"type":"assistant","message":{"id":"p3","role":"assistant","content":[{"type":"text","text":"Done: two fixes."}]},"timestamp":"2026-10-28T12:05:00Z"}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\217\\272 Done: two fixes.\\n\\n'
      hook Stop '{"last_assistant_message":"Done: two fixes."}' ;;
    # A turn with tool work only: no text.
    notext)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"Format the files"},"origin":{"kind":"human"}}' '{"type":"assistant","message":{"id":"q1","role":"assistant","content":[{"type":"tool_use","name":"Bash"}]},"timestamp":"2026-10-28T12:02:30Z"}' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\235\\257 Format the files\\n'
      hook UserPromptSubmit '{"prompt":"Format the files"}'
      hook Stop '{}' ;;
    # Interrupted with Esc after some text: Claude Code's note follows it (spec §6.8).
    interrupted)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"Explain the build"},"origin":{"kind":"human"}}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\235\\257 Explain the build\\n'
      hook UserPromptSubmit '{"prompt":"Explain the build"}'
      printf '%s\\n' '{"type":"assistant","message":{"id":"r1","role":"assistant","content":[{"type":"text","text":"The build has three steps. First"}]},"timestamp":"2026-10-28T12:06:00Z"}' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}' >> "$HOME/transcript-$n.jsonl"
      printf '\\342\\217\\272 The build has three steps. First\\n\\n' ;;
    # Claude's full-screen renderer draws in the alternate screen; classic leaves it.
    fullscreen) printf '\\033[?1049h\\033[HFull screen\\n' ;;
    classic) printf '\\033[?1049l' ;;
    # As Claude's Bash tool would run it (spec §21.9).
    link\\ *) { CLAUDECODE=1 ${BRAND.cliCommand} $line; echo "exit $?"; } > "$HOME/claude-link-$n.txt" 2>&1 ;;
    # A background command handing back (spec §6.8): Claude's turn after it, as Claude Code writes it.
    handback)
      printf '%s\\n' '{"type":"user","message":{"role":"user","content":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}}' >> "$HOME/transcript-$n.jsonl"
      hook UserPromptSubmit '{"prompt":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}'
      printf '\\342\\217\\272 The command finished.\\n\\n'
      printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The command finished."}]},"timestamp":"2026-10-28T12:02:00Z"}' >> "$HOME/transcript-$n.jsonl" ;;
    # A background command below Claude, as Claude Code runs one: its command line in a shell's arguments.
    bg\\ *) sh -c "\${line#bg }" > /dev/null 2>&1 & ;;
    # Any hook with its payload: \`hook <event> <json>\` (background work, spec §10.2).
    hook\\ *) rest="\${line#hook }"; hook "\${rest%% *}" "\${rest#* }" ;;
    usage) [ -n "$helper" ] && printf '%s' '{"rate_limits":{"five_hour":{"used_percentage":34,"resets_at":4102444800},"seven_day":{"used_percentage":81}}}' | "$helper" statusline > /dev/null ;;
    *) printf '%s\\n' "$line" >> "$HOME/claude-input-$n.txt" ;;
  esac
done
exec sleep 600
`,
      { mode: 0o755 },
    );
    // Both account folders have been used by Claude (setup check, spec §6.11).
    fs.writeFileSync(path.join(fx.root, '.claude.json'), '{}');
    fs.mkdirSync(path.join(fx.root, '.claude-personal'));
    fs.writeFileSync(path.join(fx.root, '.claude-personal', '.claude.json'), '{}');
    const fakePrCommands = {
      createCommand: `echo "$${envVar('BRANCH')} into $${envVar('BASE_BRANCH')}" > "$HOME/pr-created.txt"; echo created`,
      statusCommand: `if [ -f "$HOME/pr-merged" ]; then printf '{"state":"merged","url":"https://example.com/pr/7"}'; elif [ -f "$HOME/pr-created.txt" ]; then printf '{"state":"open","url":"https://example.com/pr/7"}'; fi`,
    };
    const claudeRun = (n: number) => waitForFile(path.join(fx.root, `claude-run-${n}.txt`));
    // Fake editors (spec §6.13) that record their arguments, first on the Work
    // profile's PATH, so a real editor is never started.
    const editorBin = path.join(fx.root, 'editor-bin');
    fs.mkdirSync(editorBin);
    for (const name of ['code', 'idea']) {
      fs.writeFileSync(
        path.join(editorBin, name),
        `#!/bin/sh\n{ printf '%s|' "$@"; echo; } >> "$HOME/editor-${name}.log"\n`,
        { mode: 0o755 },
      );
    }
    const editorCalls = (name: string) => {
      const file = path.join(fx.root, `editor-${name}.log`);
      return fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .trimEnd()
            .split('\n')
            .map((l) => l.replace(/\|$/, '').split('|'))
        : [];
    };
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
          // Fake PR commands (spec §12.3, §14.1); tests never reach a real host.
          ...(p.id === 'work'
            ? {
                env: { ...p.env, PATH: `${editorBin}:${process.env.PATH ?? ''}` },
                pr: fakePrCommands,
                git: { commitName: 'Casey Example', commitEmail: 'casey@example.com' },
              }
            : {}),
        })),
      }),
    );

    app = await launchApp({ env: appEnv(), dev: devMode, electronArgs });
    const { page, main: mainProcess } = app;
    // Replace only the native panel; record whether it was attached to the app window.
    await mainProcess.eval(`(() => {
      const { dialog, BrowserWindow } = process.mainModule.require('electron');
      globalThis.__folderPanel = { calls: [], answer: null };
      dialog.showOpenDialog = async (...args) => {
        globalThis.__folderPanel.calls.push({
          attachedToWindow: args[0] instanceof BrowserWindow,
          options: args.at(-1),
        });
        return { canceled: false, filePaths: [globalThis.__folderPanel.answer] };
      };
    })()`);
    const answerFolderPanel = (folder: string) =>
      mainProcess.eval(`globalThis.__folderPanel.answer = ${JSON.stringify(folder)}`);

    // On launch the first profile is selected and its home shell runs in ~ (spec §6.7).
    await showHomeTerminal(page);
    await typeInTerminal(
      page,
      `printf '%s|%s|%s' "$${profileVar}" "$PWD" "\${CLAUDE_CONFIG_DIR-unset}" > "$HOME/work-home.txt"`,
    );
    assert.equal(await waitForFile(path.join(fx.root, 'work-home.txt')), `work|${fx.root}|unset`);
    await screenshot(page, screenshotDir, '1-work-home.png');

    // The Guide (components.md, Guide): ⇧⌘/ opens it from the terminal, ⌘F
    // searches, and a "?" deep link marks its section and offers Back.
    const article = `document.querySelector('[data-guide-article]')?.dataset.guideArticle`;
    await pressKey(page, 'Slash', CMD | MOD.shift);
    await page.waitFor(`(${article}) === 'what-it-is'`, 'the Guide');
    assert.equal(
      await page.eval('document.querySelector("[data-guide-tab]").getAttribute("aria-pressed")'),
      'true',
    );
    await pressKey(page, 'KeyF', CMD);
    await page.waitFor(
      `document.activeElement?.matches('[data-guide-search]')`,
      'the search field',
    );
    await page.send('Input.insertText', { text: 'worktree' });
    await page.waitFor(
      `!!document.querySelector('[data-guide-result="worktrees"]')`,
      'search results',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-guide-results]').innerText`),
      /^\d+ pages/,
    );
    await page.eval(`document.querySelector('[data-guide-result="worktrees"]').click()`);
    await page.waitFor(`(${article}) === 'worktrees'`, 'the Where worktrees go page');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-guide-article]').innerText`),
      /\.worktrees/,
    );
    // A screenshot (spec §6.12): the variant of the app's theme is the one shown, and loaded;
    // View › Appearance switches it at once (spec §6).
    await page.eval(`document.querySelector('[data-guide-search]').select()`);
    await page.send('Input.insertText', { text: 'Overview' });
    await page.waitFor(`!!document.querySelector('[data-guide-result="home"]')`, 'Home found');
    await page.eval(`document.querySelector('[data-guide-result="home"]').click()`);
    await page.waitFor(`(${article}) === 'home'`, 'the Home page');
    const shownImage = `[...document.querySelectorAll('[data-guide-image]')].filter((i) => i.offsetParent).map((i) => i.complete && i.naturalWidth > 0 ? i.dataset.guideImage : 'not loaded').join()`;
    const chooseAppearance = (label: string) =>
      mainProcess.eval(`(() => {
        const { Menu } = process.mainModule.require('electron');
        const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
        const items = view.submenu.items.find((i) => i.label === 'Appearance').submenu.items;
        items.find((i) => i.label === '${label}').click();
      })()`);
    for (const theme of ['dark', 'light']) {
      await chooseAppearance(theme === 'dark' ? 'Dark' : 'Light');
      await page.waitFor(`document.documentElement.dataset.theme === '${theme}'`, theme);
      // The Overview's, loaded, then the Board's (lazily loaded further down), in the same theme.
      await page.waitFor(
        `${shownImage}.split(',')[0] === 'home-overview-${theme}'`,
        `the ${theme} screenshot`,
      );
      assert.equal(
        await page.eval(
          `[...document.querySelectorAll('[data-guide-image]')].filter((i) => i.offsetParent).map((i) => i.dataset.guideImage).join()`,
        ),
        `home-overview-${theme},home-board-${theme}`,
      );
    }
    await chooseAppearance('System');
    // Back to the profile, then a deep link from the status bar's usage meter.
    await clickLabel(page, 'Select Work');
    await page.waitFor(`!document.querySelector('[data-guide]')`, 'the Guide to close');
    await page.waitFor(
      `!!document.querySelector('[data-guide-to="plan-usage#session-and-week"]')`,
      'the usage "?"',
      30_000,
    );
    await page.eval(
      `document.querySelector('[data-guide-to="plan-usage#session-and-week"]').click()`,
    );
    await page.waitFor(
      `(${article}) === 'plan-usage' && !!document.querySelector('[data-sec="session-and-week"][data-linked]')`,
      'the linked section',
    );
    assert.equal(
      await page.eval<string>(`document.querySelector('[data-guide-back]').textContent`),
      '← Back to Work Home',
    );
    await screenshot(page, screenshotDir, '1b-guide-deep-link.png');
    await pressKey(page, 'BracketLeft', CMD);
    await page.waitFor(
      `!document.querySelector('[data-guide]') && !!document.querySelector('[data-terminal]')`,
      'back at Home',
    );

    // Terminals render with WebGL where the GPU allows it (always on macOS).
    const renderer = await page.eval<string>(
      `document.querySelector('[data-terminal]').dataset.renderer`,
    );
    console.log(`terminal renderer: ${renderer}`);
    if (process.platform === 'darwin') assert.equal(renderer, 'webgl');
    await checkMouseWheel(page, fx.root);
    await checkTerminalKeys(page, fx.root);
    await checkHyperlink(page, mainProcess, fx.root);

    // Add project with Browse…: the main checkout is found from a subfolder.
    await answerFolderPanel(path.join(repo, 'src'));
    await clickLabel(page, 'Add project to Work');
    await page.waitFor(`!!document.querySelector('dialog[open]')`, 'the Add project dialog');
    await clickButtonText(page, 'Browse…', `document.querySelector('dialog[open]')`);
    await page.waitFor(
      `${dialogText}.includes('from the remote default branch')`,
      'the detected details',
    );
    const panel = await mainProcess.eval<{ calls: Array<{ attachedToWindow: boolean }> }>(
      'globalThis.__folderPanel',
    );
    assert.equal(panel.calls.length, 1);
    assert.equal(
      panel.calls[0]?.attachedToWindow,
      true,
      'the folder panel is attached to the window',
    );
    await screenshot(page, screenshotDir, '2-add-project.png');
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    // Adding a project opens its view.
    await page.waitFor(
      `!!document.querySelector('[data-project="api-service"]') && document.querySelector('h1')?.textContent === 'api-service'`,
      'the project view',
    );

    const projects = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).projects;
    assert.deepEqual(projects(), [
      {
        id: 'api-service',
        profileId: 'work',
        name: 'api-service',
        repoPath: '~/api-service',
        remote: 'origin',
        baseBranch: 'develop',
      },
    ]);

    // Typed paths: errors are shown, ~ is expanded, and rule R1 refuses a second profile.
    // The sidebar shows the active profile only.
    await clickLabel(page, 'Select Personal');
    await clickLabel(page, 'Add project to Personal');
    await page.waitFor(`!!document.querySelector('dialog[open]')`, 'the Add project dialog');
    await typePath(page, '~/missing');
    await page.waitFor(
      `${dialogText}.includes('There is no folder at')`,
      'the missing-folder error',
    );
    await typePath(page, '~/api-service');
    await page.waitFor(
      `${dialogText}.includes('already registered under the Work profile')`,
      'the R1 error',
    );
    assert.equal(
      await page.eval(`document.querySelector('dialog[open] button[type=submit]').disabled`),
      true,
    );
    await screenshot(page, screenshotDir, '3-already-registered.png');
    await typePath(page, '~/notes');
    await page.waitFor(
      `${dialogText}.includes('the currently checked-out branch')`,
      'the detected details',
    );
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    assert.deepEqual(projects()[1], {
      id: 'notes',
      profileId: 'personal',
      name: 'notes',
      repoPath: '~/notes',
      remote: null,
      baseBranch: 'main',
    });

    // Clicking a project's name shows its view; shells in its main checkout open from there.
    await clickLabel(page, 'Select Work');
    await clickProject(page, 'api-service');
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'api-service'`,
      'api-service',
    );
    assert.equal(await page.eval(tabCount), 0, 'no shell is started by opening the project');
    await clickButtonText(page, 'Open shell');
    await page.waitFor(
      `${tabCount} === 1 && !!document.querySelector('[data-connected]')`,
      'the project shell',
    );
    await typeInTerminal(page, `printf '%s|%s' "$${profileVar}" "$PWD" > "$HOME/work-shell.txt"`);
    assert.equal(await waitForFile(path.join(fx.root, 'work-shell.txt')), `work|${repo}`);
    await clickProject(page, 'api-service');
    await page.waitFor(`!document.querySelector('[data-terminal]')`, 'the Workspaces tab');
    await clickButtonText(page, 'Open shell');
    await page.waitFor(`${tabCount} === 2`, 'a second project shell');

    // Reloading the window re-attaches to the running shells.
    await reloadPage(page);
    await clickProject(page, 'api-service');
    await page.waitFor(`${tabCount} === 2`, 'both project shells after reload');
    await page.eval(
      `document.querySelector('[role=tablist][aria-label=Terminals] [role=tab]').click()`,
    );
    await typeInTerminal(page, `echo reattached > "$HOME/after-reload.txt"`);
    // An intermittent dev-mode failure here never reproduced in
    // isolation; if it happens, show whether the keys reached the terminal.
    const reattached = await waitForFile(path.join(fx.root, 'after-reload.txt')).catch(
      async (error: unknown) => {
        const rows = await page.eval<string[]>(
          `[...document.querySelectorAll('[data-terminal] .xterm-rows > div')].map((r) => r.textContent).filter(Boolean).slice(-5)`,
        );
        console.error('after reload, the terminal shows:', rows);
        throw error;
      },
    );
    assert.equal(reattached, 'reattached');
    await screenshot(page, screenshotDir, '4-after-reload.png');

    // Paste goes through the main-process clipboard.
    await mainProcess.eval(
      `process.mainModule.require('electron').clipboard.writeText('echo pasted > "$HOME/pasted.txt"')`,
    );
    if (process.platform === 'darwin') {
      // ⌘V reaches the terminal as a paste event from the Edit menu.
      await page.eval(`document.querySelector('[data-terminal] .xterm-helper-textarea')
        .dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }))`);
    } else {
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'V',
        code: 'KeyV',
        windowsVirtualKeyCode: 86,
        modifiers: 2 | 8, // Ctrl+Shift
      });
    }
    await sleep(300);
    await typeInTerminal(page, '');
    assert.equal(await waitForFile(path.join(fx.root, 'pasted.txt')), 'pasted');
    for (let open = 2; open > 0; open--) {
      await clickLabel(page, 'Close api-service · shell');
      await page.waitFor(`${tabCount} === ${open - 1}`, 'a project shell to close');
    }
    await page.waitFor(`${tabCount} === 0`, 'the project shells to close');

    // Start Claude here: Claude in the main checkout with the profile environment, in its own
    // tab, with the hooks and a conversation id the app chose, so it can be suspended (spec §9.8).
    await clickButtonText(page, 'Start Claude here');
    const mainRun = (await claudeRun(0)).split('\n');
    assert.deepEqual(mainRun.slice(0, 5), [
      repo,
      'work',
      '',
      '--settings',
      path.join(path.dirname(configFile), 'claude', 'settings-ask-link.json'),
    ]);
    assert.equal(mainRun[5], '--session-id');
    assert.match(mainRun[6] ?? '', /^[0-9a-f-]{36}$/);
    await page.waitFor(`${tabCount} === 1`, 'the Claude tab');
    await clickLabel(page, 'Close api-service · claude');
    await page.waitFor(`${tabCount} === 0`, 'the Claude tab to close');

    // New workspace: branch from the template, checked against local and remote branches.
    fx.git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-only');
    fx.git(repo, 'update-ref', '-d', 'refs/remotes/origin/remote-only');
    await clickButtonText(page, 'New workspace');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the New workspace dialog',
    );
    await typeInField(page, '#ws-task', 'PROJ-1 Fix login timeout', false);
    await page.waitFor(
      `document.querySelector('[data-task-preview]')?.textContent === 'ID PROJ-1Title Fix login timeout'`,
      'the task preview',
    );
    assert.equal(
      await page.eval(`document.querySelector('#ws-branch').value`),
      'PROJ-1-fix-login-timeout',
    );
    assert.equal(await page.eval(`document.querySelector('#ws-base').value`), 'develop');
    await typeInField(page, '#ws-branch', 'develop', false);
    await page.waitFor(
      `${dialogText}.includes('A branch named develop already exists')`,
      'the local refusal',
    );
    await typeInField(page, '#ws-branch', 'remote-only', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `${dialogText}.includes('origin already has a branch named remote-only')`,
      'the remote refusal',
    );
    await screenshot(page, screenshotDir, '7-new-workspace.png');
    await typeInField(page, '#ws-branch', 'PROJ-1-fix-login-timeout', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workspace to be created');

    // Create: worktree from origin/develop, task file kept out of git, Claude with --settings.
    const worktree = path.join(
      fx.root,
      BRAND.homeDirName,
      'worktrees',
      'work',
      'api-service',
      'PROJ-1-fix-login-timeout',
    );
    // Ask before Claude links a repository is on by default (spec §21.9).
    const settingsFile = path.join(path.dirname(configFile), 'claude', 'settings-ask-link.json');
    // A new conversation, with the session id the app chose (spec §9.4).
    const [firstRun, firstSession] = (await claudeRun(1)).split('\n--session-id\n');
    assert.equal(
      firstRun,
      `${worktree}\nwork\nPROJ-1-fix-login-timeout\n--settings\n${settingsFile}`,
    );
    assert.match(firstSession ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(
      fs.readFileSync(path.join(worktree, BRAND.repoDirName, 'task.md'), 'utf8'),
      '---\nid: PROJ-1\n---\n# Fix login timeout\n',
    );
    assert.match(
      fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
      new RegExp(`^/\\${BRAND.repoDirName}/$`, 'm'),
    );
    assert.equal(fx.git(worktree, 'status', '--porcelain'), '');
    assert.equal(
      fx.git(worktree, 'rev-parse', 'HEAD').trim(),
      fx.git(repo, 'rev-parse', 'origin/develop').trim(),
    );
    assert.equal(
      fx
        .git(repo, 'config', '--default', 'none', '--get', 'branch.PROJ-1-fix-login-timeout.remote')
        .trim(),
      'none',
    );
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Fix login timeout' && ${tabCount} === 1`,
      'the workspace view with its Claude tab',
    );
    assert.equal(
      await page.eval(`!!document.querySelector('nav button[title^="PROJ-1 Fix login timeout"]')`),
      true,
      'the workspace in the sidebar',
    );
    // The fake Claude prints nothing: the launch spinner goes after about 3 s,
    // and a workspace still Starting then shows no glyph (spec §6.3).
    const spinners = `document.querySelectorAll('[role=img][aria-label=Working]').length`;
    await page.waitFor(`${spinners} === 0`, 'the launch spinner to go', 8000);

    // Hooks set the state (spec §10.2): the fake Claude runs them through the
    // helper and the bridge when a line is typed into it.
    const row = `document.querySelector('nav button[title^="PROJ-1 Fix login timeout"]')`;
    await typeInTerminal(page, 'prompt');
    await page.waitFor(`!!${row}.querySelector('[aria-label=Working]')`, 'Working');
    // The status bar counts it (spec §6.5).
    const footerCount = (kind: string) =>
      `document.querySelector('footer [data-count-${kind}]')?.textContent ?? null`;
    await page.waitFor(`${footerCount('working')} === '1 working'`, 'the working count');
    assert.equal(await page.eval(footerCount('needs')), null);
    await typeInTerminal(page, 'permission');
    await page.waitFor(`!!${row}.querySelector('[aria-label="Needs permission"]')`, 'Permission');
    await page.waitFor(`${footerCount('needs')} === '1 needs you'`, 'the needs-you count');
    assert.equal(await page.eval(footerCount('working')), null);
    assert.match(
      await page.eval<string>(`document.querySelector('[aria-label="Select Work"]').textContent`),
      /^Work1(⌘|Ctrl\+)1$/,
      'the tab badge counts it',
    );
    const notifications = () =>
      mainProcess.eval<{ title: string; body: string }[]>('globalThis.__notifications');
    assert.deepEqual(
      (await notifications()).map((n) => [n.title, n.body]),
      [['[Work] PROJ-1 needs permission', 'Claude needs your permission to use Bash']],
    );
    await typeInTerminal(page, 'stop');
    await page.waitFor(`!${row}.querySelector('[aria-label="Needs permission"]')`, 'Done');
    await mainProcess.waitFor('globalThis.__notifications.length === 2', 'the Done notification');
    assert.equal((await notifications())[1]?.title, '[Work] PROJ-1 is done');

    // Conversation aids (spec §6.8): the prompt's number in the gutter, the
    // navigator, and Copy where the response ended, read from the transcript.
    await page.waitFor(`!!document.querySelector('[data-prompt-mark="1"]')`, 'the prompt marker');
    await page.waitFor(
      `!!document.querySelector('[data-response-mark="0"] button')`,
      'the Copy button',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-prompt-navigator]').textContent`),
      /^Prompt 1 of 1/,
    );
    // Its tooltips name the keys from the shortcut definitions, per platform.
    const mac = process.platform === 'darwin';
    assert.deepEqual(
      await page.eval<string[]>(
        `[...document.querySelectorAll('[data-prompt-navigator] button')].map((b) => b.title)`,
      ),
      [
        `Previous prompt (${shortcutHint('promptStep', mac, 0)})`,
        `Next prompt (${shortcutHint('promptStep', mac, 1)})`,
      ],
    );
    await mainProcess.eval(`(() => {
      const { clipboard } = process.mainModule.require('electron');
      globalThis.__copied = [];
      clipboard.writeText = (text) => { globalThis.__copied.push(text); };
    })()`);
    // The button sits on the response's line.
    assert.equal(
      await page.eval<string>(`(() => {
        const c = document.querySelector('[data-terminal]');
        const m = c.aids.marks.find((m) => m.mark.kind === 'response');
        return c.xterm.buffer.active.getLine(m.marker.line).translateToString(true);
      })()`),
      '⏺ Answer one.',
    );
    await page.eval(`document.querySelector('[data-response-mark="0"] button').click()`);
    await mainProcess.waitFor('globalThis.__copied.length === 1', 'the copied response');
    // ⌥C copies the last response.
    await pressKey(page, 'KeyC', MOD.alt);
    await mainProcess.waitFor('globalThis.__copied.length === 2', 'Copy response (⌥C)');
    assert.deepEqual(await mainProcess.eval('globalThis.__copied'), [
      'Answer **one**.',
      'Answer **one**.',
    ]);
    await screenshot(page, screenshotDir, '7b-conversation-aids.png');

    // The Responses panel (spec §6.8): every response from the transcript,
    // as Markdown, each with its own Copy; ⇧⌘R and Esc.
    const responsesPanel = `document.querySelector('[data-responses-panel]')`;
    const panelResponses = `document.querySelectorAll('[data-responses-panel] [data-response]').length`;
    assert.equal(
      await page.eval<boolean>(`!!document.querySelector('[data-copy-response]')`),
      false,
    );
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`${panelResponses} === 1`, 'the Responses panel');
    assert.equal(
      await page.eval<string>(`${responsesPanel}.querySelector('[data-response-part]').innerHTML`),
      '<p>Answer <strong>one</strong>.</p>\n',
    );
    const first = await page.eval<string>(
      `${responsesPanel}.querySelector('[data-response="1"]').innerText`,
    );
    assert.match(first, /^▸\n1\n› Fix the login\n.+\nCopy\n+Answer one\.$/, JSON.stringify(first));
    await page.eval(`${responsesPanel}.querySelector('[data-response-copy]').click()`);
    await mainProcess.waitFor('globalThis.__copied.length === 3', 'the panel copy');
    // One entry: Expand all and Collapse all are there too (spec §6.8).
    const onlyEntry = `${responsesPanel}.querySelector('[data-response="1"]').dataset.expanded`;
    await clickButtonText(page, 'Expand all', responsesPanel);
    await page.waitFor(`${onlyEntry} === 'true'`, 'Expand all with one entry');
    await clickButtonText(page, 'Collapse all', responsesPanel);
    await page.waitFor(`${onlyEntry} === 'false'`, 'Collapse all with one entry');
    // It follows the transcript: a new response shows without reopening.
    await typeInTerminal(page, 'unseen');
    await page.waitFor(`${panelResponses} === 2`, 'the new response in the panel');
    await page.eval(`${responsesPanel}.querySelectorAll('[data-response-copy]')[1].click()`);
    await mainProcess.waitFor('globalThis.__copied.length === 4', 'the second copy');
    assert.deepEqual((await mainProcess.eval<string[]>('globalThis.__copied')).slice(2), [
      'Answer **one**.',
      'Quiet **two**.',
    ]);
    // Blocks: all collapsed, the newest too (spec §6.8), Copy working while collapsed.
    const expanded = `[...${responsesPanel}.querySelectorAll('[data-response]')].map((r) => r.dataset.expanded).join()`;
    await page.waitFor(`${expanded} === 'false,false'`, 'every entry collapsed');
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="1"] [data-response-copy]').click()`,
    );
    await mainProcess.waitFor('globalThis.__copied.length === 5', 'Copy while collapsed');
    assert.equal((await mainProcess.eval<string[]>('globalThis.__copied'))[4], 'Answer **one**.');
    assert.equal(await page.eval<string>(expanded), 'false,false', 'Copy leaves it collapsed');
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="1"] [data-response-header]').click()`,
    );
    await page.waitFor(`${expanded} === 'true,false'`, 'a click on the header expands');
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="2"] [data-response-header]').click()`,
    );
    await page.waitFor(`${expanded} === 'true,true'`, 'the newest expands too');
    // ↵ on a header toggles it.
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="2"] [data-response-header]').focus()`,
    );
    await pressKey(page, 'Enter');
    await page.waitFor(`${expanded} === 'true,false'`, '↵ collapses');
    await clickButtonText(page, 'Collapse all', responsesPanel);
    await page.waitFor(`${expanded} === 'false,false'`, 'Collapse all');
    await clickButtonText(page, 'Expand all', responsesPanel);
    await page.waitFor(`${expanded} === 'true,true'`, 'Expand all');
    // Its left edge resizes it; the width is kept for next time.
    const panelWidth = `Math.round(${responsesPanel}.getBoundingClientRect().width)`;
    const startWidth = await page.eval<number>(panelWidth);
    const handle = await page.eval<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('[data-responses-resize]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const mouse = (type: string, x: number) =>
      page.send('Input.dispatchMouseEvent', {
        type,
        x,
        y: handle.y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
      });
    await mouse('mousePressed', handle.x);
    await mouse('mouseMoved', handle.x - 60);
    await mouse('mouseMoved', handle.x - 120);
    await mouse('mouseReleased', handle.x - 120);
    await page.waitFor(`Math.abs(${panelWidth} - ${startWidth + 120}) <= 2`, 'the wider panel');
    assert.equal(
      await page.eval<string>(`localStorage.getItem('responses-panel-width')`),
      String(startWidth + 120),
    );
    // Never wider than 70 % of the workspace area.
    await mouse('mousePressed', handle.x - 120);
    await mouse('mouseMoved', 0);
    await mouse('mouseReleased', 0);
    await page.waitFor(`${panelWidth} > ${startWidth + 120}`, 'the widest panel');
    const widest = await page.eval<number>(panelWidth);
    assert.ok(
      widest <= (await page.eval<number>(`${responsesPanel}.parentElement.clientWidth * 0.7 + 1`)),
      'at most 70 %',
    );
    // Classic mode: a click scrolls the terminal to the response's line and marks it.
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="1"] [data-response-body]').click()`,
    );
    await page.waitFor(
      `!!document.querySelector('[data-revealed]')`,
      'the response in the terminal',
    );
    // The terminal is narrower with the panel open; the inline Copy stays at its right edge.
    assert.equal(
      await page.eval<boolean>(`(() => {
        const term = document.querySelector('[data-terminal]').getBoundingClientRect();
        const copy = document.querySelector('[data-response-mark="0"] button').getBoundingClientRect();
        return copy.left > term.left + term.width / 2;
      })()`),
      true,
      'the inline Copy at the right',
    );
    await screenshot(page, screenshotDir, '7c-responses-panel.png');
    // One that isn't on the screen says so.
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="2"] [data-response-body]').click()`,
    );
    await page.waitFor(`${responsesPanel}.innerText.includes('Not in the terminal')`, 'the note');
    // Full view: the whole workspace area, the terminal hidden; back with the
    // button, ⇧⌘F or Esc.
    const terminalShown = `!!document.querySelector('[data-terminal]').offsetParent`;
    const fullView = `${responsesPanel}?.dataset.full === 'true'`;
    await page.eval(`document.querySelector('[data-responses-full]').click()`);
    await page.waitFor(`${fullView} && !${terminalShown}`, 'full view');
    await screenshot(page, screenshotDir, '7c-responses-full-view.png');
    await page.eval(`document.querySelector('[data-responses-full]').click()`);
    await page.waitFor(`!(${fullView}) && ${terminalShown}`, 'the side panel again');
    await pressKey(page, 'KeyF', CMD | MOD.shift);
    await page.waitFor(`${fullView}`, '⇧⌘F to full view');
    await pressKey(page, 'KeyF', CMD | MOD.shift);
    await page.waitFor(`!(${fullView}) && ${terminalShown}`, '⇧⌘F back');
    await pressKey(page, 'KeyF', CMD | MOD.shift);
    await page.waitFor(`${fullView}`, 'full view again');
    await pressKey(page, 'Escape');
    await page.waitFor(`!(${fullView}) && !!${responsesPanel}`, 'Esc back to the side panel');
    await page.eval(`${responsesPanel}.focus()`);
    await pressKey(page, 'Escape');
    await page.waitFor(`!${responsesPanel}`, 'Esc to close the panel');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`!!${responsesPanel}`, 'the panel again');
    assert.equal(await page.eval<number>(panelWidth), widest, 'its width kept');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`!${responsesPanel}`, '⇧⌘R to close it');

    // Full-screen mode (the alternate screen): no buttons in the terminal, the
    // panel the same, without scrolling to a response.
    await typeInTerminal(page, 'fullscreen');
    await page.waitFor(
      `document.querySelector('[data-terminal]').xterm.buffer.active.type === 'alternate'`,
      'the alternate screen',
    );
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`${panelResponses} === 2`, 'the panel in full-screen mode');
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, 'stop');
    await page.waitFor(`${panelResponses} === 3`, 'a full-screen response in the panel');
    assert.equal(
      await page.eval<string | null>(
        `${responsesPanel}.querySelector('[data-response="3"] [data-response-body]').getAttribute('title')`,
      ),
      'Expand',
      'nothing to scroll to: a click only expands it',
    );
    await page.eval(
      `${responsesPanel}.querySelector('[data-response="3"] [data-response-copy]').click()`,
    );
    await mainProcess.waitFor('globalThis.__copied.length === 6', 'the full-screen copy');
    await pressKey(page, 'KeyC', MOD.alt);
    await mainProcess.waitFor('globalThis.__copied.length === 7', '⌥C in full-screen mode');
    await screenshot(page, screenshotDir, '7d-responses-fullscreen.png');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`!${responsesPanel}`, 'the panel closed');
    await typeInTerminal(page, 'classic');
    // The terminal fits its area: no columns hidden under the right edge.
    assert.equal(
      await page.eval<boolean>(`(() => {
        const box = document.querySelector('[data-terminal]').getBoundingClientRect();
        const screen = document.querySelector('[data-terminal] .xterm-screen').getBoundingClientRect();
        return screen.right <= box.right + 0.5;
      })()`),
      true,
      'the terminal fits',
    );

    // One entry per prompt (spec §6.8): Claude's messages between tool calls
    // are its parts, with a divider between them. Copy takes all of them,
    // Copy last part the last one, ⌥C the whole latest entry; a turn of tool
    // work alone says so.
    await typeInTerminal(page, 'notext');
    await typeInTerminal(page, 'parts');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    const entry = (n: number) => `${responsesPanel}.querySelector('[data-response="${n}"]')`;
    await page.waitFor(
      `${panelResponses} === 5 && ${entry(5)}.querySelectorAll('[data-response-part]').length === 3`,
      'the entry with three parts',
    );
    assert.equal(
      await page.eval<number>(`${entry(5)}.querySelectorAll('[data-response-divider]').length`),
      2,
    );
    assert.match(
      await page.eval<string>(`${entry(5)}.querySelector('[data-response-header]').innerText`),
      /› Tidy the README/,
    );
    assert.match(
      await page.eval<string>(`${entry(4)}.innerText`),
      /› Format the files[\s\S]*No text response/,
    );
    assert.equal(
      await page.eval<boolean>(`!!${entry(4)}.querySelector('[data-response-copy]')`),
      false,
      'nothing to copy',
    );
    // Collapsed, the newest too: Copy last part shows once it's expanded.
    assert.equal(await page.eval<string>(`${entry(5)}.dataset.expanded`), 'false');
    assert.equal(
      await page.eval<boolean>(`!!${entry(5)}.querySelector('[data-response-copy-last]')`),
      false,
    );
    await page.eval(`${entry(5)}.querySelector('[data-response-header]').click()`);
    await page.waitFor(`!!${entry(5)}.querySelector('[data-response-copy-last]')`, 'expanded');
    const copiedBefore = await mainProcess.eval<number>('globalThis.__copied.length');
    await page.eval(`${entry(5)}.querySelector('[data-response-copy]').click()`);
    await mainProcess.waitFor(`globalThis.__copied.length === ${copiedBefore + 1}`, 'Copy');
    await page.eval(`${entry(5)}.querySelector('[data-response-copy-last]').click()`);
    await mainProcess.waitFor(
      `globalThis.__copied.length === ${copiedBefore + 2}`,
      'Copy last part',
    );
    await page.eval(`${responsesPanel}.focus()`);
    await pressKey(page, 'KeyC', MOD.alt);
    await mainProcess.waitFor(`globalThis.__copied.length === ${copiedBefore + 3}`, '⌥C');
    const whole = 'Reading it first.\n\nFixed the **links**.\n\nDone: two fixes.';
    assert.deepEqual((await mainProcess.eval<string[]>('globalThis.__copied')).slice(-3), [
      whole,
      'Done: two fixes.',
      whole,
    ]);
    // A prompt interrupted with Esc keeps its entry, its partial text marked Interrupted.
    await typeInTerminal(page, 'interrupted');
    await page.waitFor(`${panelResponses} === 6`, 'the interrupted entry');
    await page.waitFor(`!!${entry(6)}.querySelector('[data-response-interrupted]')`, 'Interrupted');
    assert.match(
      await page.eval<string>(`${entry(6)}.innerText`),
      /› Explain the build\nInterrupted[\s\S]*The build has three steps\. First/,
    );
    assert.equal(
      await page.eval<number>(
        `${responsesPanel}.querySelectorAll('[data-response-interrupted]').length`,
      ),
      1,
      'only the interrupted entry',
    );
    await screenshot(page, screenshotDir, '7c-responses-parts.png');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`!${responsesPanel}`, 'the panel closed');

    // Plan usage from the status line (spec §11).
    assert.match(
      await page.eval<string>(`document.querySelector('footer').innerText`),
      /Usage n\/a/,
    );
    await typeInTerminal(page, 'usage');
    await page.waitFor(`!!document.querySelector('[data-usage=fresh]')`, 'the usage meter');
    assert.match(
      await page.eval<string>(
        `document.querySelector('[data-usage]').innerText.replace(/\\s+/g, ' ')`,
      ),
      /^Session 34% resets \d+d \d+h Week 81%$/,
    );

    // Background work (spec §10.2), with the Stop payloads Claude Code sends
    // (checked live). Waiting for agents stays Working, with the count.
    const background = `(${row}.querySelector('[data-background]')?.textContent ?? null)`;
    const tasks = (...list: [string, string, string?][]) =>
      JSON.stringify({
        background_tasks: list.map(([id, type, command]) => ({
          id,
          type,
          status: 'running',
          ...(command && { command }),
        })),
      });
    const sent = (await notifications()).length;
    // Only prompts you typed are numbered (spec §6.8); hand-backs below aren't.
    const promptTotal = `Number(document.querySelector('[data-prompt-navigator]')?.textContent.match(/of (\\d+)/)?.[1])`;
    const promptsBefore = await page.eval<number>(promptTotal);
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `hook Stop ${tasks(['a1', 'subagent'], ['a2', 'subagent'])}`);
    await page.waitFor(`${background} === '2 in background'`, 'Working with 2 in background');
    assert.equal(await page.eval(`!!${row}.querySelector('[aria-label=Working]')`), true);
    assert.match(await page.eval<string>(`${row}.title`), /\nWorking · 2 in background · /);
    await screenshot(page, screenshotDir, '7e-background-agents.png');
    // Neither the idle notice nor one agent's hand-back ends it.
    await typeInTerminal(
      page,
      `hook Notification {"notification_type":"idle_prompt","message":"Claude is waiting for your input"}`,
    );
    await typeInTerminal(page, `hook UserPromptSubmit {"prompt":"<task-notification>a1"}`);
    await typeInTerminal(page, `hook Stop ${tasks(['a2', 'subagent'])}`);
    await page.waitFor(`${background} === '1 in background'`, 'one agent left');
    assert.equal(await page.eval(`!!${row}.querySelector('[aria-label=Working]')`), true);
    assert.equal((await notifications()).length, sent, 'no Done while agents work');
    // Done, with its notification, once nothing is pending.
    await typeInTerminal(page, `hook UserPromptSubmit {"prompt":"<task-notification>a2"}`);
    await typeInTerminal(page, `hook Stop ${tasks()}`);
    await page.waitFor(
      `${background} === null && !${row}.querySelector('[aria-label=Working]')`,
      'Done once the agents finished',
    );
    await mainProcess.waitFor(`globalThis.__notifications.length === ${sent + 1}`, 'one Done');
    const done = (await notifications()).at(-1);
    assert.deepEqual([done?.title, done?.body], ['[Work] PROJ-1 is done', 'Fix login timeout']);
    // A dev server left running (its command looks like one): Done, with a note.
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `hook Stop ${tasks(['b1', 'shell', 'npm run dev'])}`);
    await page.waitFor(`/1 running$/.test(${background})`, 'Done with 1 running');
    assert.match(
      await page.eval<string>(`${row}.title`),
      /\nDone.* · 1 still running in the background · /,
    );
    await mainProcess.waitFor(`globalThis.__notifications.length === ${sent + 2}`, 'Done again');
    assert.equal(
      (await notifications()).at(-1)?.body,
      'Fix login timeout · 1 still running in the background',
    );
    await screenshot(page, screenshotDir, '7f-background-command.png');
    // Any other command holds Done, Working with the count; one whose process
    // isn't found is Done with a note at the fixed fallback (shortened for the test).
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `hook Stop ${tasks(['b2', 'shell', './watch-forever.sh'])}`);
    await page.waitFor(`${background} === '1 in background'`, 'Done held');
    assert.equal(await page.eval(`!!${row}.querySelector('[aria-label=Working]')`), true);
    assert.equal((await notifications()).length, sent + 2, 'no Done while held');
    await mainProcess.waitFor(
      `globalThis.__notifications.length === ${sent + 3}`,
      'Done at the fallback',
      HOLD_DONE_MS + 10_000,
    );
    assert.equal(
      (await notifications()).at(-1)?.body,
      'Fix login timeout · 1 still running in the background',
    );
    await page.waitFor(`/1 running$/.test(${background})`, 'Done with 1 running, at the fallback');
    // One whose process runs below Claude is held for as long as it lives,
    // past the fallback, and Done once it has handed back.
    const long = 'sleep 30 && echo long-done';
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `bg ${long}`);
    await typeInTerminal(page, `hook Stop ${tasks(['b4', 'shell', long])}`);
    await page.waitFor(`${background} === '1 in background'`, 'held for the long command');
    await sleep(HOLD_DONE_MS + 3 * MINUTE_MS);
    assert.equal(
      await page.eval(`!!${row}.querySelector('[aria-label=Working]')`),
      true,
      'Working past the fallback while it runs',
    );
    assert.equal((await notifications()).length, sent + 3, 'no Done while it runs');
    await typeInTerminal(page, 'handback');
    await typeInTerminal(page, `hook Stop ${tasks()}`);
    await page.waitFor(
      `${background} === null && !${row}.querySelector('[aria-label=Working]')`,
      'Done after the hand-back',
    );
    await mainProcess.waitFor(`globalThis.__notifications.length === ${sent + 4}`, 'one Done');
    assert.equal((await notifications()).at(-1)?.body, 'Fix login timeout');
    // One that ends without handing back: Done with the note 2 minutes after
    // it's gone, before the fallback.
    const short = 'sleep 2 && echo short-done';
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `bg ${short}`);
    const heldAt = Date.now();
    await typeInTerminal(page, `hook Stop ${tasks(['b5', 'shell', short])}`);
    await page.waitFor(`${background} === '1 in background'`, 'held for the short command');
    await mainProcess.waitFor(
      `globalThis.__notifications.length === ${sent + 5}`,
      'Done the grace after it ended',
      HOLD_DONE_MS,
    );
    assert.ok(Date.now() - heldAt < HOLD_DONE_MS, 'before the fallback');
    assert.equal(
      (await notifications()).at(-1)?.body,
      'Fix login timeout · 1 still running in the background',
    );
    await page.waitFor(`/1 running$/.test(${background})`, 'Done with 1 running, after the grace');
    // A command Claude waits for: no Done until it hands back and Claude's
    // turn after it ends, then one.
    await typeInTerminal(page, 'prompt');
    await typeInTerminal(page, `hook Stop ${tasks(['b3', 'shell', 'sleep 60 && echo finished'])}`);
    await page.waitFor(`${background} === '1 in background'`, 'Working while it waits');
    await typeInTerminal(page, 'handback');
    await page.waitFor(
      `!!${row}.querySelector('[aria-label=Working]')`,
      'Working after the hand-back',
    );
    assert.equal((await notifications()).length, sent + 5, 'no Done before the last Stop');
    await typeInTerminal(page, `hook Stop ${tasks()}`);
    await page.waitFor(
      `${background} === null && !${row}.querySelector('[aria-label=Working]')`,
      'Done without a note',
    );
    await mainProcess.waitFor(`globalThis.__notifications.length === ${sent + 6}`, 'one Done');
    assert.equal((await notifications()).at(-1)?.body, 'Fix login timeout');
    // The hand-backs got no prompt marker; the panel labels the turn after one.
    await page.waitFor(`${promptTotal} === ${promptsBefore + 6}`, 'six typed prompts counted');
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(
      `[...document.querySelectorAll('[data-responses-panel] [data-response]')].at(-1)?.innerText.includes('The command finished.')`,
      'the response after the hand-back',
    );
    // It joins the entry of the prompt before it, under a label.
    assert.match(
      await page.eval<string>(
        `[...document.querySelectorAll('[data-responses-panel] [data-response-header]')].at(-1).innerText`,
      ),
      /› Fix the login/,
    );
    assert.equal(
      await page.eval<string>(
        `[...document.querySelectorAll('[data-responses-panel] [data-response]')].at(-1).querySelector('[data-response-handback]')?.innerText`,
      ),
      'After background work',
    );
    assert.equal(
      await page.eval<boolean>(
        `document.querySelector('[data-responses-panel]').innerText.includes('task-notification')`,
      ),
      false,
    );
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(`!document.querySelector('[data-responses-panel]')`, 'the panel closed');

    // Shell tabs open in the worktree.
    await clickLabel(page, 'New shell');
    await page.waitFor(
      `${tabCount} === 2 && !!document.querySelector('[data-connected]')`,
      'the workspace shell',
    );
    await typeInTerminal(
      page,
      `printf '%s|%s' "$PWD" "$${envVar('WORKSPACE_NAME')}" > "$HOME/ws-shell.txt"`,
    );
    assert.equal(
      await waitForFile(path.join(fx.root, 'ws-shell.txt')),
      `${worktree}|PROJ-1 Fix login timeout`,
    );
    await screenshot(page, screenshotDir, '8-workspace.png');

    // Quitting asks first while Claude runs, in the window, listing the session;
    // Cancel keeps everything running (spec §5).
    await mainProcess.eval(`process.mainModule.require('electron').app.quit()`);
    await page.waitFor(`${dialogText}.includes('Stop 1 running session?')`, 'the quit dialog');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-quit-sessions]').innerText`),
      /PROJ-1\s+Fix login timeout/,
    );
    assert.match(
      await page.eval<string>('document.activeElement.textContent'),
      /^Quit (⌘|Ctrl\+)Q$/,
    );
    await clickButtonText(page, 'Cancel', `document.querySelector('dialog[open]')`);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    await sleep(300);
    assert.equal(await page.eval<number>(tabCount), 2, 'nothing was stopped');

    // ⌃Tab cycles the tabs; Close Tab (⌘W) closes a shell at once and asks
    // before stopping Claude.
    const activeTab = `document.querySelector('[role=tablist][aria-label=Terminals] [aria-selected=true]')?.textContent ?? ''`;
    const closeTab = () =>
      mainProcess.eval(`(() => {
        const { Menu } = process.mainModule.require('electron');
        const find = (items) => items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu.items) : [])]);
        find(Menu.getApplicationMenu().items).find((i) => i.label === 'Close Tab').click();
      })()`);
    const before = await page.eval<string>(activeTab);
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      modifiers: 2,
    });
    await page.waitFor(`(${activeTab}) !== ${JSON.stringify(before)}`, 'the next tab');
    if ((await page.eval<string>(activeTab)).includes('Claude')) {
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        modifiers: 2,
      });
    }
    await page.waitFor(`(${activeTab}).includes('Shell')`, 'the shell tab');
    await closeTab();
    await page.waitFor(`${tabCount} === 1`, 'the shell to close');
    await closeTab();
    await page.waitFor(`${dialogText}.includes('Close Claude?')`, 'the Close Claude question');
    await clickButtonText(page, 'Cancel', `document.querySelector('dialog[open]')`);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the question to close');
    assert.equal(await page.eval<number>(tabCount), 1, 'Claude keeps running');
    await clickLabel(page, 'New shell');
    await page.waitFor(`${tabCount} === 2`, 'a new shell');

    // With one workspace and nothing waiting, the workspace keys say so in the
    // status bar instead of doing nothing (components.md).
    const keyNotice = `document.querySelector('[data-key-notice]')?.textContent ?? ''`;
    await page.eval(`document.querySelector('[data-terminal] .xterm-helper-textarea').focus()`);
    await pressKey(page, 'ArrowDown', MOD.alt);
    await page.waitFor(`(${keyNotice}) === 'This is the only workspace in Work'`, 'the notice');
    await pressShortcut(page, 'nextNeedingYou');
    await page.waitFor(`(${keyNotice}) === 'No workspace needs you'`, 'the ⌘J notice');

    // A branch with unpushed commits is kept unless "Also delete the local branch" is ticked.
    // This one starts from the project row's + in the sidebar, with the project fixed.
    await clickLabel(page, 'New workspace in api-service');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the New workspace dialog',
    );
    assert.equal(
      await page.eval<boolean>(
        `!document.querySelector('dialog[open] #ws-project') && !!document.querySelector('dialog[open]')`,
      ),
      true,
      'no project picker',
    );
    await typeInField(page, '#ws-task', 'Keep my commits', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the second workspace');
    assert.match(await claudeRun(2), /keep-my-commits/);
    // Its terminal takes the focus once connected; the sidebar keys come after.
    await page.waitFor(
      `!!document.activeElement?.classList.contains('xterm-helper-textarea')`,
      "the new workspace's terminal in focus",
    );

    // The sidebar from the keyboard (spec §6.1): one Tab stop, ↑↓ ←→, ↵ opens.
    const navKey = `document.activeElement?.closest('[data-nav-key]')?.dataset.navKey ?? null`;
    const navTabStops = `[...document.querySelectorAll('nav [data-nav-key]')]
      .map((r) => (r.matches('button') ? r : r.querySelector('[data-nav-focus]')))
      .filter((b) => b.tabIndex === 0).length`;
    assert.equal(await page.eval(navTabStops), 1, 'one Tab stop in the tree');
    await page.eval(`document.querySelector('nav [data-nav-key="home"]').focus()`);
    await pressKey(page, 'ArrowDown');
    assert.equal(await page.eval(navKey), 'p:api-service');
    await pressKey(page, 'ArrowDown');
    const firstRow = await page.eval<string>(navKey);
    assert.match(firstRow, /^w:/);
    await pressKey(page, 'ArrowLeft'); // to its project
    assert.equal(await page.eval(navKey), 'p:api-service');
    await pressKey(page, 'ArrowLeft'); // collapses it
    await page.waitFor(
      `document.querySelector('[data-nav-key="p:api-service"] [data-nav-focus]').getAttribute('aria-expanded') === 'false'`,
      'the project to collapse',
    );
    await pressKey(page, 'ArrowRight'); // expands it
    await page.waitFor(
      `document.querySelector('[data-nav-key="p:api-service"] [data-nav-focus]').getAttribute('aria-expanded') === 'true'`,
      'the project to expand',
    );
    await pressKey(page, 'ArrowRight'); // into it
    assert.equal(await page.eval(navKey), firstRow);
    await pressKey(page, 'End');
    await pressKey(page, 'Home');
    assert.equal(await page.eval(navKey), 'home');
    assert.equal(await page.eval(navTabStops), 1, 'still one Tab stop');
    // ↵ on a workspace row opens it.
    await page.eval(
      `document.querySelector('nav [data-nav-key=${JSON.stringify(firstRow)}]').focus()`,
    );
    await pressEnter(page);
    await page.waitFor(
      `document.querySelector('nav [data-nav-key=${JSON.stringify(firstRow)}]').getAttribute('aria-current') === 'true'`,
      'the workspace to open from the keyboard',
    );
    // The project's Workspaces table (spec §6.10): ↑↓ move, ↵ opens.
    await page.eval(
      `document.querySelector('[data-nav-key="p:api-service"] [data-nav-focus]').click()`,
    );
    await page.waitFor(
      `document.querySelectorAll('[data-workspace-row]').length === 2`,
      'the table',
    );
    assert.deepEqual(
      await page.eval<number[]>(
        `[...document.querySelectorAll('[data-workspace-row]')].map((r) => r.tabIndex)`,
      ),
      [0, -1],
    );
    // Memory (spec §6.14), measured from the fake claude's processes: the
    // Memory column with its split, the project's total and the status bar's.
    const size = String.raw`\d+(\.\d)? (MB|GB)`;
    await page.waitFor(
      `[...document.querySelectorAll('[data-memory-cell]')].some((c) => /^${size}$/.test(c.textContent))`,
      'the Memory column',
      15_000,
    );
    assert.match(
      await page.eval<string>(
        `[...document.querySelectorAll('[data-memory-cell]')].find((c) => c.textContent).title`,
      ),
      new RegExp(`^Claude ${size}, other ${size}`),
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-detail=Memory] dd').textContent`),
      new RegExp(`^${size} · \\d+ sessions?$`),
    );
    // The status bar (spec §6.14): a bar filled by the sessions and the app
    // relative to the machine's RAM, then "2.4 GB of 16 GB".
    const memoryButton = `document.querySelector('footer [data-memory]')`;
    const totalRam = `${Math.round(os.totalmem() / 1024 ** 3)} GB`;
    assert.match(
      await page.eval<string>(`${memoryButton}.innerText.replace(/\\s+/g, ' ')`),
      new RegExp(`^Memory ${size} of ${totalRam}$`),
    );
    const fill = await page.eval<string>(
      `${memoryButton}.querySelector('[aria-hidden] > span').style.width`,
    );
    assert.ok(Number.parseFloat(fill) > 0 && Number.parseFloat(fill) <= 100, `bar at ${fill}`);
    // A click opens the panel, not a native tooltip; it takes focus.
    const memoryPanel = `document.querySelector('[data-memory-panel]')`;
    assert.equal(await page.eval(`${memoryButton}.title`), '');
    await page.eval(`${memoryButton}.click()`);
    await page.waitFor(
      `!!${memoryPanel} && document.activeElement === ${memoryPanel}`,
      'the memory panel in focus',
    );
    assert.equal(await page.eval(`${memoryButton}.getAttribute('aria-expanded')`), 'true');
    const memoryText = await page.eval<string>(`${memoryPanel}.innerText`);
    assert.match(memoryText, new RegExp(`^Memory\\n${size} of ${totalRam}\\n`));
    assert.match(memoryText, new RegExp(`Claude sessions\\n${size}\\nThis app\\n${size}`));
    assert.match(
      memoryText,
      new RegExp(`Largest workspaces\\n.+\\n${size}\\nClaude ${size}, other ${size}`),
    );
    for (const term of ['Claude', 'Other', 'This app', 'Not counted']) {
      assert.ok(
        await page.eval(
          `[...${memoryPanel}.querySelectorAll('[data-memory-terms] dt')].some((t) => t.textContent === ${JSON.stringify(term)})`,
        ),
        `the panel explains ${term}`,
      );
    }
    assert.match(memoryText, /shells you open in terminal tabs, and processes that detach/);
    await screenshot(page, screenshotDir, '5c-memory-panel.png');
    // Esc closes it and puts focus back on the button.
    await pressKey(page, 'Escape');
    await page.waitFor(
      `!${memoryPanel} && document.activeElement === ${memoryButton}`,
      'Esc to close the panel',
    );
    // Keyboard: ↵ on the focused button opens it; a click outside closes it.
    await pressEnter(page);
    await page.waitFor(`!!${memoryPanel}`, 'the panel from the keyboard');
    const outsideAt = await page.eval<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('[data-detail=Path]').getBoundingClientRect();
      return { x: r.x + 4, y: r.y + 4 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await page.send('Input.dispatchMouseEvent', {
        type,
        ...outsideAt,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
    }
    await page.waitFor(`!${memoryPanel}`, 'a click outside to close the panel');
    assert.equal(await page.eval(`${memoryButton}.getAttribute('aria-expanded')`), 'false');
    // Learn more opens the Guide's Memory page; ⌘[ comes back.
    const guideArticle = `document.querySelector('[data-guide-article]')?.dataset.guideArticle`;
    const toMemoryGuide = async (link: string, what: string) => {
      await page.eval(`${link}.click()`);
      await page.waitFor(`(${guideArticle}) === 'memory'`, `${what} to the Memory page`);
      assert.match(
        await page.eval<string>(`document.querySelector('[data-guide-article]').innerText`),
        /higher than Activity Monitor/,
      );
      await pressKey(page, 'BracketLeft', CMD);
      await page.waitFor(
        `!document.querySelector('[data-guide]') && !!document.querySelector('[data-sort-memory]')`,
        `back from the Guide (${what})`,
      );
    };
    await page.eval(`${memoryButton}.click()`);
    await page.waitFor(`!!${memoryPanel}`, 'the panel again');
    await toMemoryGuide(`${memoryPanel}.querySelector('[data-guide-to="memory"]')`, 'Learn more');
    assert.equal(await page.eval(`!!${memoryPanel}`), false, 'Learn more closes the panel');
    // The "?" after the column's header and after the project's Memory.
    await toMemoryGuide(
      `document.querySelector('[data-sort-memory]').closest('th').querySelector('[data-guide-to="memory"]')`,
      'the column\'s "?"',
    );
    await page.waitFor(`!!document.querySelector('[data-detail=Memory]')`, "the project's Memory");
    await toMemoryGuide(
      `document.querySelector('[data-detail=Memory] [data-guide-to="memory"]')`,
      'the project\'s "?"',
    );
    // Not in the sidebar's rows.
    assert.equal(
      await page.eval(`/\\d (MB|GB)\\b/.test(document.querySelector('nav').innerText)`),
      false,
    );
    // The column sorts: largest first, smallest first, then as listed.
    const memorySort = `document.querySelector('[data-sort-memory]').closest('th').getAttribute('aria-sort')`;
    for (const expected of ['descending', 'ascending', null]) {
      await page.eval(`document.querySelector('[data-sort-memory]').click()`);
      await page.waitFor(
        `${memorySort} === ${JSON.stringify(expected)}`,
        `memory sort ${expected}`,
      );
    }
    await page.eval(`document.querySelector('[data-workspace-row]').focus()`);
    await pressKey(page, 'ArrowDown');
    const secondRow = await page.eval<string>(`document.activeElement.dataset.workspaceRow`);
    assert.equal(
      secondRow,
      await page.eval<string>(
        `document.querySelectorAll('[data-workspace-row]')[1].dataset.workspaceRow`,
      ),
    );
    await pressEnter(page);
    await page.waitFor(
      `document.querySelector('nav [data-nav-key="w:${secondRow}"]')?.getAttribute('aria-current') === 'true'`,
      'the workspace to open from the table',
    );
    await page.eval(`document.querySelector('nav button[title^="Keep my commits"]').click()`);
    await page.waitFor(`document.querySelector('h1')?.textContent === 'Keep my commits'`, 'back');

    // Workspace keys (components.md) as real key events, with the focus in a
    // Claude tab, in a shell tab and outside the terminal.
    const heading = `document.querySelector('h1')?.textContent`;
    const shows = (title: string) => page.waitFor(`${heading} === ${JSON.stringify(title)}`, title);
    const focusTerminal = async () => {
      await page.waitFor(
        `!!document.querySelector('[data-terminal][data-connected]')`,
        'a terminal',
      );
      await page.eval(`document.querySelector('[data-terminal] .xterm-helper-textarea').focus()`);
    };
    const focusOutside = () =>
      page.eval(`(document.activeElement?.blur(), document.body.focus(), true)`);
    await shows('Keep my commits');
    await focusTerminal(); // its Claude tab
    await pressKey(page, 'ArrowUp', MOD.alt);
    await shows('Fix login timeout');
    assert.match(await page.eval<string>(activeTab), /Shell/);
    await focusTerminal(); // its shell tab
    await pressKey(page, 'ArrowDown', MOD.alt);
    await shows('Keep my commits');
    await focusOutside();
    await pressKey(page, 'ArrowDown', MOD.alt); // wraps around
    await shows('Fix login timeout');
    await focusOutside();
    await pressKey(page, 'ArrowUp', MOD.alt);
    await shows('Keep my commits');
    // ⌘J goes to the workspace that needs you, and to its Claude tab.
    await typeInTerminal(page, 'permission');
    const row2 = `document.querySelector('nav button[title^="Keep my commits"]')`;
    await page.waitFor(`!!${row2}.querySelector('[aria-label="Needs permission"]')`, 'Permission');
    for (const where of ['shell', 'outside', 'claude'] as const) {
      await pressKey(page, 'ArrowUp', MOD.alt);
      await shows('Fix login timeout');
      if (where === 'claude') {
        await pressKey(page, 'Tab', MOD.ctrl);
        await page.waitFor(`(${activeTab}).includes('Claude')`, 'the Claude tab');
      }
      if (where === 'outside') await focusOutside();
      else await focusTerminal();
      await pressShortcut(page, 'nextNeedingYou');
      await shows('Keep my commits');
      assert.match(await page.eval<string>(activeTab), /Claude/, `⌘J from the ${where}`);
    }
    await pressKey(page, 'ArrowUp', MOD.alt);
    await shows('Fix login timeout');

    // The row's tooltip (spec §6.1): name, then state and branch.
    assert.match(
      await page.eval<string>(
        `document.querySelector('nav button[title^="PROJ-1 Fix login timeout"]').title`,
      ),
      /^PROJ-1 Fix login timeout\n[A-Z][a-z ():]+ · PROJ-1-fix-login-timeout$/,
    );
    // The sidebar row's menu (spec §6.1): reveal, copy path and branch name.
    await mainProcess.eval(`(() => {
      const { clipboard, shell } = process.mainModule.require('electron');
      globalThis.__rowCopied = [];
      globalThis.__rowRevealed = [];
      globalThis.__rowClipboard = clipboard.writeText;
      globalThis.__rowReveal = shell.showItemInFolder;
      clipboard.writeText = (text) => { globalThis.__rowCopied.push(text); };
      shell.showItemInFolder = (p) => { globalThis.__rowRevealed.push(p); };
    })()`);
    const rowMenu = async (label: string) => {
      await chooseFromNextContextMenu(mainProcess, label);
      await openContextMenu(page, 'nav button[title^="PROJ-1 Fix login timeout"]');
    };
    await rowMenu('Copy path');
    await mainProcess.waitFor('globalThis.__rowCopied.length === 1', 'Copy path');
    assert.deepEqual(await mainProcess.eval<string[]>('globalThis.__lastMenu'), [
      'Open in editor',
      process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder',
      'Copy path',
      'Copy branch name',
      'Keep Claude Running',
      'Delete workspace…',
    ]);
    await rowMenu('Copy branch name');
    await mainProcess.waitFor('globalThis.__rowCopied.length === 2', 'Copy branch name');
    assert.deepEqual(await mainProcess.eval<string[]>('globalThis.__rowCopied'), [
      worktree,
      'PROJ-1-fix-login-timeout',
    ]);
    await rowMenu(process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder');
    await mainProcess.waitFor('globalThis.__rowRevealed.length === 1', 'Reveal in Finder');
    assert.deepEqual(await mainProcess.eval<string[]>('globalThis.__rowRevealed'), [worktree]);
    await mainProcess.eval(`(() => {
      const { clipboard, shell } = process.mainModule.require('electron');
      clipboard.writeText = globalThis.__rowClipboard;
      shell.showItemInFolder = globalThis.__rowReveal;
    })()`);

    // Delete: lists what would be lost, Cancel first; --force only after "Delete anyway".
    fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'x');
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await clickLabel(page, 'Workspace menu');
    // git status can be slow (x64 under emulation); wait for the whole check.
    await page.waitFor(
      `(${dialogText}).includes('1 uncommitted change') && (${dialogText}).includes('2 running sessions will be stopped')`,
      'the delete warnings',
      30_000,
    );
    assert.equal(
      await page.eval(`document.activeElement?.textContent?.startsWith('Cancel')`),
      true,
      'the delete dialog focuses Cancel',
    );
    await screenshot(page, screenshotDir, '9-delete-workspace.png');
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]')`,
      'the workspace to be deleted',
      20_000,
    );
    assert.equal(fs.existsSync(worktree), false, 'the worktree is removed');
    assert.equal(
      fx.git(repo, 'branch', '--list', 'PROJ-1-fix-login-timeout'),
      '',
      'the local branch is deleted',
    );
    assert.notEqual(fx.git(repo, 'ls-remote', 'origin', 'remote-only'), '', 'remote branches stay');
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'api-service'`,
      'the project view',
    );

    const worktree2 = path.join(path.dirname(worktree), 'keep-my-commits');
    fs.writeFileSync(path.join(worktree2, 'work.txt'), 'x');
    fx.git(worktree2, 'add', 'work.txt');
    fx.git(worktree2, 'commit', '-q', '-m', 'work in progress');
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await openContextMenu(page, 'nav button[title^="Keep my commits"]');
    await page.waitFor(
      `(${dialogText}).includes('1 commit not pushed') && (${dialogText}).includes('Also delete the local branch')`,
      'the unpushed warning and the branch checkbox',
      30_000,
    );
    assert.equal(
      await page.eval(`document.querySelector('dialog[open] input[type=checkbox]').checked`),
      false,
      'the branch checkbox starts unchecked',
    );
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]')`,
      'the second workspace to be deleted',
      20_000,
    );
    assert.equal(fs.existsSync(worktree2), false, 'the worktree is removed');
    assert.equal(
      fx.git(repo, 'branch', '--list', 'keep-my-commits').trim(),
      'keep-my-commits',
      'the branch is kept',
    );

    // Remove project without workspaces: its running shell is listed, stopped on
    // confirmation, and only config.json changes (spec §14.3).
    const notesMenu = '[data-project="notes"] button:not([aria-label])';
    await clickLabel(page, 'Select Personal');
    await clickProject(page, 'notes');
    await clickButtonText(page, 'Open shell');
    await page.waitFor(`!!document.querySelector('[data-connected]')`, 'the notes shell');
    await chooseFromNextContextMenu(mainProcess, 'Remove from Personal…');
    await openContextMenu(page, notesMenu);
    await page.waitFor(
      `${dialogText}.includes('1 running session will be stopped') && ${dialogText}.includes('Nothing is deleted on disk')`,
      'the confirmation',
    );
    assert.equal(await page.eval<string>('document.activeElement.textContent'), 'Cancel Esc');
    await screenshot(page, screenshotDir, '5-remove-project.png');
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('[data-project="notes"]')`, 'notes to be removed');
    assert.deepEqual(
      projects().map((p: { id: string }) => p.id),
      ['api-service'],
    );
    assert.ok(fs.existsSync(path.join(fx.root, 'notes', 'README')), 'the repository is kept');

    // The personal profile has its own home shell, with its CLAUDE_CONFIG_DIR (~ expanded).
    await clickLabel(page, 'Select Personal');
    await page.waitFor(
      `document.querySelector('[role=tab][aria-current=true]')?.getAttribute('aria-label') === 'Select Personal'`,
      'Personal selected',
    );
    await showHomeTerminal(page);
    await typeInTerminal(
      page,
      `printf '%s|%s' "$${profileVar}" "$CLAUDE_CONFIG_DIR" > "$HOME/personal-home.txt"`,
    );
    assert.equal(
      await waitForFile(path.join(fx.root, 'personal-home.txt')),
      `personal|${path.join(fx.root, '.claude-personal')}`,
    );
    await screenshot(page, screenshotDir, '6-personal-home.png');

    // Start Claude here types into the home shell only while the shell is at its prompt.
    await typeInTerminal(page, 'sleep 60');
    await sleep(500);
    await pressShortcut(page, 'startClaude');
    await page.waitFor(
      `document.body.innerText.includes('The home terminal is busy')`,
      'the refusal',
    );
    await pressCtrlC(page);
    await sleep(500);
    await pressShortcut(page, 'startClaude');
    assert.equal(await claudeRun(3), `${fx.root}\npersonal`);
    await pressCtrlC(page);
    await sleep(500);

    // When the home shell exits, it can be started again.
    await typeInTerminal(page, 'exit');
    await page.waitFor(hasButton('Start again'), 'the Start again button');
    const exitedId = await page.eval<string>(
      `document.querySelector('[data-terminal]').dataset.terminal`,
    );
    await clickButtonText(page, 'Start again');
    // Type only once the new shell's terminal has replaced the exited one.
    const connected = `document.querySelector('[data-terminal][data-connected]')?.dataset.terminal`;
    await page.waitFor(
      `(${connected} ?? ${JSON.stringify(exitedId)}) !== ${JSON.stringify(exitedId)}`,
      'the new home shell',
    );
    await typeInTerminal(page, `echo restarted > "$HOME/restarted.txt"`);
    assert.equal(await waitForFile(path.join(fx.root, 'restarted.txt')), 'restarted');
    assert.equal(await page.eval(`document.querySelectorAll('[data-terminal]').length`), 1);

    // The command line tool (spec §7.5): in a terminal of the app it adds to that
    // terminal's profile, and refuses another one.
    const cli = BRAND.cliCommand;
    fx.localRepo('cli-repo');
    await typeInTerminal(
      page,
      `${cli} add ~/cli-repo > ~/cli-1.txt 2>&1; echo "exit $?" >> ~/cli-1.txt`,
    );
    // The output and the exit status are written one after the other: wait for both.
    assert.match(
      await waitForFile(path.join(fx.root, 'cli-1.txt'), { until: /^exit \d+$/m }),
      /^Added cli-repo to personal: ~\/cli-repo \(base main\)\nexit 0$/,
    );
    await page.waitFor(
      `!!document.querySelector('[data-project="cli-repo"]')`,
      'the added project',
    );
    fx.localRepo('cli-other');
    await typeInTerminal(
      page,
      `${cli} add ~/cli-other --profile work > ~/cli-2.txt 2>&1; echo "exit $?" >> ~/cli-2.txt`,
    );
    assert.match(
      await waitForFile(path.join(fx.root, 'cli-2.txt'), { until: /^exit \d+$/m }),
      /personal profile[^\n]*\nexit 1$/,
    );

    // Install Command Line Tool… puts the launcher in ~/.local/bin, which isn't
    // on this PATH; outside the app it finds the app through cli.json.
    await mainProcess.eval(`(() => {
      const { Menu } = process.mainModule.require('electron');
      const find = (items) => items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu.items) : [])]);
      find(Menu.getApplicationMenu().items).find((i) => i.label === 'Install Command Line Tool…').click();
    })()`);
    await page.waitFor(`${dialogText}.includes('/.local/bin/${cli}')`, 'the install confirmation');
    await submitDialog(page);
    await page.waitFor(`!!document.querySelector('[data-cli-installed]')`, 'the installed note');
    assert.match(await page.eval<string>(dialogText), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    await submitDialog(page);
    const launcher = path.join(fx.root, '.local', 'bin', cli);
    const outside = (...args: string[]) =>
      spawnSync(launcher, ['add', ...args], { env: fx.env, cwd: fx.root, encoding: 'utf8' });
    assert.equal(
      outside(path.join(fx.root, 'cli-other')).status,
      1,
      '--profile is required outside',
    );
    const added = outside(path.join(fx.root, 'cli-other'), '--profile', 'work', '--name', 'other');
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /^Added other to work/);

    // Remove project with a workspace: listed with its checks, then deleted with
    // its worktree; the emptied worktree folder goes, the main checkout stays.
    await clickLabel(page, 'Select Work');
    // Its worktrees go to a folder of its own from now on (spec §8.1); one inside
    // the main checkout is refused.
    await clickProject(page, 'api-service');
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'api-service'`,
      'the project',
    );
    const worktreesDetail = `document.querySelector('[data-detail=Worktrees]')`;
    await answerFolderPanel(path.join(repo, 'src'));
    await clickButtonText(page, 'Change…', worktreesDetail);
    await page.waitFor(
      `document.body.innerText.includes("can't go inside the repository's main checkout")`,
      'the refusal',
    );
    const elsewhere = path.join(fx.root, 'trees-elsewhere');
    fs.mkdirSync(elsewhere);
    await answerFolderPanel(elsewhere);
    await clickButtonText(page, 'Change…', worktreesDetail);
    await page.waitFor(hasButton('Use default'), 'the own worktree folder');
    assert.equal(projects()[0].worktreeRoot, '~/trees-elsewhere');
    // The chosen folder is a parent: worktrees go in its hidden .worktrees/<project>.
    await page.waitFor(
      `document.body.innerText.includes('~/trees-elsewhere/.worktrees/api-service/')`,
      'the resulting path',
    );
    await clickLabel(page, 'New workspace in api-service');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'PROJ-9 Remove me', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the third workspace');
    assert.match(await claudeRun(4), /PROJ-9-remove-me/);
    const worktree3 = path.join(elsewhere, '.worktrees', 'api-service', 'PROJ-9-remove-me');
    fs.writeFileSync(path.join(worktree3, 'scratch.txt'), 'not committed\n');
    await chooseFromNextContextMenu(mainProcess, 'Remove from Work…');
    await openContextMenu(page, '[data-project="api-service"] button:not([aria-label])');
    await page.waitFor(
      `${dialogText}.includes('PROJ-9 Remove me') && ${dialogText}.includes('1 uncommitted change') && ${dialogText}.includes('will be stopped')`,
      'the workspace and its checks',
    );
    assert.equal(
      await page.eval<string>(
        `document.querySelector('dialog[open] button[type=submit]').textContent`,
      ),
      'Delete anyway and remove',
    );
    await screenshot(page, screenshotDir, '10-remove-project-with-workspace.png');
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the project to be removed');
    assert.deepEqual(
      projects().map((p: { id: string }) => p.id),
      ['cli-repo', 'other'],
    );
    assert.equal(fs.existsSync(worktree3), false, 'the worktree is deleted');
    assert.equal(
      fs.existsSync(path.join(elsewhere, '.worktrees')),
      false,
      'the emptied .worktrees goes',
    );
    assert.ok(fs.existsSync(elsewhere), 'the chosen folder stays');
    assert.equal(fs.existsSync(path.dirname(worktree)), false, 'and the emptied default one');
    assert.equal(fx.git(repo, 'branch', '--list', 'PROJ-9-remove-me').trim(), '', 'branch deleted');
    assert.equal(
      fx.git(repo, 'branch', '--list', 'keep-my-commits').trim(),
      'keep-my-commits',
      'other branches stay',
    );
    assert.ok(fs.existsSync(path.join(repo, 'src')), 'the main checkout is untouched');

    // Add project with a folder of repositories (spec §6.1): one level down,
    // linked worktrees left out, one registered in Work shown and disabled.
    const reposDir = path.join(fx.root, 'repos');
    for (const name of ['alpha', 'beta', 'shared']) fx.localRepo(path.join('repos', name));
    fx.git(
      path.join(reposDir, 'alpha'),
      'worktree',
      'add',
      '-q',
      '-b',
      'wt',
      path.join(reposDir, 'alpha-wt'),
    );
    const shared = outside(path.join(reposDir, 'shared'), '--profile', 'work');
    assert.equal(shared.status, 0, shared.stderr);
    await clickLabel(page, 'Select Personal');
    await clickLabel(page, 'Add project to Personal');
    await page.waitFor(`!!document.querySelector('dialog[open]')`, 'the Add project dialog');
    await typePath(page, '~/repos');
    const repoNote = (name: string) =>
      `document.querySelector('[data-repo="${name}"] [data-repo-note]')?.textContent`;
    await page.waitFor(
      `${dialogText}.includes('3 repositories in this folder') && ${repoNote('shared')} === 'in Work'`,
      'the inspected repositories',
    );
    assert.equal(
      await page.eval(`document.querySelector('[data-repo="alpha-wt"]')`),
      null,
      'no linked worktree',
    );
    const submitText = `document.querySelector('dialog[open] button[type=submit]').textContent`;
    assert.match(await page.eval<string>(submitText), /^Add 2 projects/);
    assert.equal(
      await page.eval(`document.querySelector('input[aria-label=shared]').disabled`),
      true,
    );
    await clickButtonText(page, 'Select none');
    await page.waitFor(`/^Add 0 projects/.test(${submitText})`, 'none selected');
    await clickButtonText(page, 'Select all');
    await page.waitFor(`/^Add 2 projects/.test(${submitText})`, 'all selected');
    // The worktree location applies to all of them.
    const batchTrees = path.join(fx.root, 'batch-trees');
    fs.mkdirSync(batchTrees);
    await answerFolderPanel(batchTrees);
    await page.eval(`document.querySelectorAll('dialog[open] input[name=worktrees]')[1].click()`);
    await page.waitFor(
      `document.querySelector('[data-worktree-root]')?.textContent === '~/batch-trees/.worktrees/<project>'`,
      'the chosen worktree folder',
    );
    await screenshot(page, screenshotDir, '11-add-folder.png');
    await submitDialog(page);
    await page.waitFor(`!!document.querySelector('[data-import-results]')`, 'the results');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-import-results]').innerText`),
      /✓\s*alpha\s*added as alpha[\s\S]*✓\s*beta\s*added as beta/,
    );
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the dialog to close');
    const batch = projects().filter((p: { id: string }) => ['alpha', 'beta'].includes(p.id));
    assert.deepEqual(
      batch.map((p: { profileId: string; worktreeRoot: string }) => [p.profileId, p.worktreeRoot]),
      [
        ['personal', '~/batch-trees'],
        ['personal', '~/batch-trees'],
      ],
    );
    // The command line: --all gives one line per repository; without it, a hint.
    const hint = outside(reposDir, '--profile', 'personal');
    assert.equal(hint.status, 1);
    assert.match(hint.stderr, /isn't a git repository\. It holds 3 repositories; .* --all/);
    const all = outside(reposDir, '--all', '--profile', 'personal');
    assert.equal(all.status, 1, 'one is refused');
    assert.match(
      all.stdout,
      /^Skipped ~\/repos\/alpha: already added\nSkipped ~\/repos\/beta: already added\n$/,
    );
    assert.match(
      all.stderr,
      /^Refused ~\/repos\/shared: already registered under the Work profile\n$/,
    );

    // Workspace setup (spec §8): commands kept in the app, ports, and the
    // gitignored files .worktreeinclude names, copied into the worktree.
    const beta = path.join(reposDir, 'beta');
    fs.writeFileSync(path.join(beta, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(beta, '.worktreeinclude'), '.env\n');
    fx.git(beta, 'add', '.');
    fx.git(beta, 'commit', '-q', '-m', 'include .env');
    fs.writeFileSync(path.join(beta, '.env'), 'SECRET=local\n');
    await clickProject(page, 'beta');
    await page.waitFor(`document.querySelector('h1')?.textContent === 'beta'`, 'the beta project');
    await clickButtonText(page, 'Setup');
    await page.waitFor(`!!document.querySelector('[data-project-setup=app]')`, 'the Setup tab');
    const portVars = ['PORT', 'PORT_BASE', 'PORT_COUNT'].map((v) => `"$${envVar(v)}"`).join(' ');
    await typeInField(
      page,
      '#setup-commands',
      `printf '%s %s %s' ${portVars} > ports.txt\ncp .env setup-saw.env`,
      false,
    );
    await typeInField(
      page,
      '#teardown-commands',
      'echo torn > "$HOME/teardown.txt"; exit 7',
      false,
    );
    await typeInField(page, '#setup-ports', '5', false);
    await clickButtonText(page, 'Save');
    await page.waitFor(
      `document.body.innerText.includes('Saved · used by new workspaces')`,
      'saved',
    );
    assert.deepEqual(projects().find((p: { id: string }) => p.id === 'beta').setup, {
      setup: [`printf '%s %s %s' ${portVars} > ports.txt`, 'cp .env setup-saw.env'],
      teardown: ['echo torn > "$HOME/teardown.txt"; exit 7'],
      ports: 5,
      startClaude: 'after-setup',
    });
    const newBetaWorkspace = async (task: string) => {
      await clickLabel(page, 'New workspace in beta');
      await page.waitFor(
        `!!document.querySelector('dialog[open] #ws-run-setup')`,
        'the setup checkbox',
      );
      assert.equal(await page.eval('document.querySelector("#ws-run-setup").checked'), true);
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, task, 30_000);
    };
    await newBetaWorkspace('Setup works');
    // The Setup tab shows first; when setup succeeds, Claude starts and its tab is shown.
    assert.match(await claudeRun(5), /setup-works/);
    await page.waitFor(`(${activeTab}).includes('Claude')`, 'the Claude tab after setup');
    const setupTree = path.join(fx.root, 'batch-trees', '.worktrees', 'beta', 'setup-works');
    assert.equal(fs.readFileSync(path.join(setupTree, 'ports.txt'), 'utf8'), '20000 20000 5');
    assert.equal(fs.lstatSync(path.join(setupTree, '.env')).isSymbolicLink(), false, 'copied');
    assert.equal(fs.readFileSync(path.join(setupTree, 'setup-saw.env'), 'utf8'), 'SECRET=local\n');
    assert.match(
      await page.eval<string>('document.querySelector("h1").closest("header").innerText'),
      /ports 20000–20004/,
    );
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('[role=tablist][aria-label=Terminals] [role=tab]')].map((t) => /Claude|Setup|Shell/.exec(t.textContent)?.[0])`,
      ),
      ['Claude', 'Setup'],
      'Claude first, then Setup',
    );

    // The repository's own .<slug>/config.json wins; a failing setup leaves Error
    // with Retry, Start Claude anyway and Delete (spec §7.3).
    fs.mkdirSync(path.join(beta, BRAND.repoDirName), { recursive: true });
    fs.writeFileSync(
      path.join(beta, BRAND.repoDirName, 'config.json'),
      JSON.stringify({ setup: ['echo from-repo', 'exit 4'] }),
    );
    fx.git(beta, 'add', '-f', `${BRAND.repoDirName}/config.json`);
    fx.git(beta, 'commit', '-q', '-m', 'repo setup');
    await clickProject(page, 'beta');
    await clickButtonText(page, 'Setup');
    await page.waitFor(`!!document.querySelector('[data-project-setup=repo]')`, 'the repo setup');
    await newBetaWorkspace('Setup fails');
    await page.waitFor(
      `!!document.querySelector('[data-setup-failed]')`,
      'the setup failure',
      20_000,
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-setup-failed]').innerText`),
      /Setup failed \(exit 4\)[\s\S]*Retry[\s\S]*Start Claude anyway[\s\S]*Delete…/,
    );
    assert.equal(
      await page.eval(
        `!!document.querySelector('nav button[title^="Setup fails"] [aria-label=Error]')`,
      ),
      true,
      'the sidebar shows Error',
    );
    await clickButtonText(page, 'Start Claude anyway');
    assert.match(await claudeRun(6), /setup-fails/);
    await page.waitFor(`!document.querySelector('[data-setup-failed]')`, 'Claude to take over');
    // Retry runs setup again (here fixed in the worktree), then starts Claude.
    await newBetaWorkspace('Retry setup');
    await page.waitFor(
      `!!document.querySelector('[data-setup-failed]')`,
      'the second failure',
      20_000,
    );
    const retryTree = path.join(path.dirname(setupTree), 'retry-setup');
    fs.writeFileSync(
      path.join(retryTree, BRAND.repoDirName, 'config.json'),
      JSON.stringify({ setup: ['echo fixed > fixed.txt'] }),
    );
    // ⌘R (F5 on Linux) is Retry here (spec §6.6), outside a terminal on every platform.
    assert.ok(
      (await page.eval<string>(`document.querySelector('[data-setup-failed]').innerText`))
        .replace(/\s+/g, '')
        .includes(`Retry${shortcutHint('checkAgain', process.platform === 'darwin')}`),
      'Retry shows its key',
    );
    await page.eval(`(document.activeElement?.blur(), true)`);
    await pressShortcut(page, 'checkAgain');
    await waitForFile(path.join(retryTree, 'fixed.txt'));
    assert.match(await claudeRun(7), /retry-setup/);
    await page.waitFor(`!document.querySelector('[data-setup-failed]')`, 'the failure to clear');

    // Teardown runs on delete; its failure is shown but doesn't stop the deletion.
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await openContextMenu(page, 'nav button[title^="Setup works"]');
    await page.waitFor(`${dialogText}.includes('Delete')`, 'the delete dialog', 30_000);
    await submitDialog(page);
    await page.waitFor(
      `!!document.querySelector('[data-app-notice]')`,
      'the teardown notice',
      30_000,
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-app-notice]').innerText`),
      /Setup works was deleted, but its teardown didn't finish: Teardown failed \(exit 7\)/,
    );
    assert.equal(await waitForFile(path.join(fx.root, 'teardown.txt')), 'torn');
    assert.equal(fs.existsSync(setupTree), false, 'deleted anyway');
    await clickLabel(page, 'Dismiss');

    // Projects without a remote only commit (spec §3.2, §14.1).
    await clickLabel(page, 'Select Personal');
    await page.eval(
      `[...document.querySelectorAll('nav button')].find((b) => b.title.startsWith('Retry setup')).click()`,
    );
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Retry setup'`,
      'Retry setup',
    );
    await pressKey(page, 'KeyD', CMD | MOD.shift);
    await page.waitFor(`!!document.querySelector('[data-finish]')`, 'the finish controls');
    await page.waitFor(
      `document.querySelector('[data-finish]').innerText.includes("No remote")`,
      'no remote',
    );
    assert.equal(await page.eval(hasButton('Create PR')), false);
    await pressKey(page, 'KeyD', CMD | MOD.shift);
    await page.waitFor(`!document.querySelector('[data-changes-panel]')`, 'the panel to close');

    // Finish (spec §14.1): Changes panel with Monaco's diff, Commit, Push to a
    // local bare remote, Create PR with a fake command, and the PR badge.
    const { origin: shopOrigin, clone: shop } = fx.cloneWithRemote('shop', 'main');
    assert.equal(outside(shop, '--profile', 'work').status, 0);
    await clickLabel(page, 'Select Work');
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'PROJ-7 Add cart', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the shop workspace', 30_000);
    const shopRun = await claudeRun(8);
    assert.match(shopRun, /PROJ-7-add-cart/);
    const shopTree = shopRun.split('\n')[0] as string;
    // The Changes count follows file changes made outside Claude within
    // seconds (spec §6.4), not only at the panel-closed fallback check.
    const changesCount = `document.querySelector('[data-changes-toggle] span')?.textContent`;
    await page.waitFor(`${changesCount} === '0'`, 'no changes yet', 30_000);
    fs.writeFileSync(path.join(shopTree, 'README'), 'hello\ncart\n');
    fs.writeFileSync(path.join(shopTree, 'cart.txt'), 'one\ntwo\n');
    await page.waitFor(`${changesCount} === '2'`, 'the count after a file change', 5000);
    // Delete offers "Commit and push first", which opens the Changes panel. The
    // trash icon after the title opens the same confirmation as the ⋯ menu (spec §6.2).
    assert.equal(
      await page.eval(`document.querySelector('[data-delete-workspace]').title`),
      'Delete workspace…',
    );
    await page.eval(`document.querySelector('[data-delete-workspace]').click()`);
    await page.waitFor(hasButton('Commit and push first'), 'Commit and push first', 30_000);
    await clickButtonText(page, 'Commit and push first');
    await page.waitFor(`!!document.querySelector('[data-changes-panel]')`, 'the Changes panel');
    const panelText = `document.querySelector('[data-changes-panel]').innerText`;
    await page.waitFor(`${panelText}.includes('Uncommitted · 2')`, 'two uncommitted files');
    assert.match(await page.eval<string>(panelText), /vs origin\/main/);
    await page.eval(`document.querySelector('[data-change-file="README"]').click()`);
    await page.waitFor(
      `document.querySelector('[data-diff-editor] .modified .view-lines')?.textContent.includes('cart')`,
      "Monaco's diff",
      20_000,
    );
    // The diff's colors come from the tokens in both themes, also those no
    // class uses: a missing token used to show removed lines solid black.
    for (const theme of ['light', 'dark']) {
      await mainProcess.eval(
        `process.mainModule.require('electron').nativeTheme.themeSource = '${theme}'`,
      );
      await page.waitFor(`document.documentElement.dataset.theme === '${theme}'`, theme);
      await sleep(300);
      const colors = await page.eval<string[]>(
        `(() => { const s = getComputedStyle(document.querySelector('[data-diff-editor] .monaco-diff-editor')); return ['inserted', 'removed'].flatMap((k) => [s.getPropertyValue('--vscode-diffEditor-' + k + 'LineBackground'), s.getPropertyValue('--vscode-diffEditorGutter-' + k + 'LineBackground')]).map((v) => v.trim()); })()`,
      );
      // Monaco writes translucent colors as rgba() and opaque ones as hex.
      for (const color of colors) assert.match(color, /^rgba\(/, `${theme}: ${colors}`);
    }
    await mainProcess.eval(
      `process.mainModule.require('electron').nativeTheme.themeSource = 'system'`,
    );
    await screenshot(page, screenshotDir, '12-changes-panel.png');
    // The view buttons sit in the tab bar, not the header (spec §6.2); ⇧⌘D toggles Changes.
    assert.equal(
      await page.eval(
        `['[data-open-editor]', '[data-changes-toggle]'].every((s) => !!document.querySelector('[data-view-buttons] ' + s) && !document.querySelector('header ' + s))`,
      ),
      true,
    );
    assert.equal(await page.eval(`!!document.querySelector('[data-header-separator]')`), true);
    await pressShortcut(page, 'changes');
    await page.waitFor(`!document.querySelector('[data-changes-panel]')`, '⇧⌘D closes Changes');
    await pressShortcut(page, 'changes');
    await page.waitFor(`!!document.querySelector('[data-diff-editor]')`, '⇧⌘D opens it again');
    // A narrow window: the view buttons are icons, named in their tooltips.
    const setWindowSize = (w: number, h: number) =>
      mainProcess.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setSize(${w}, ${h})`,
      );
    await setWindowSize(860, 760);
    await page.waitFor(
      `!!document.querySelector('[data-view-buttons] [data-open-editor] svg') && !!document.querySelector('[data-view-buttons] [data-changes-toggle] svg')`,
      'the icons in a narrow window',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-open-editor]').title`),
      process.platform === 'darwin' ? /in its editor \(⌘E\)/ : /in its editor \(Ctrl\+Shift\+E\)/,
    );
    await setWindowSize(1280, 800);
    await page.waitFor(
      `!document.querySelector('[data-view-buttons] [data-open-editor] svg')`,
      'the labels again',
    );

    // Its width (spec §6.4): 380 px by default, its left edge drags it.
    const changesWidth = `Math.round(document.querySelector('[data-changes-panel]').getBoundingClientRect().width)`;
    await page.waitFor(`${changesWidth} === 380`, 'the default width');
    const edge = await page.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('[data-changes-resize]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    const drag = (type: string, x: number) =>
      page.send('Input.dispatchMouseEvent', {
        type,
        x,
        y: edge.y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
      });
    await drag('mousePressed', edge.x);
    await drag('mouseMoved', edge.x - 70);
    await drag('mouseMoved', edge.x - 140);
    await drag('mouseReleased', edge.x - 140);
    await page.waitFor(`${changesWidth} === 520`, 'the dragged width');
    // Side by side doesn't fit in 520 px: unified, with the hint.
    assert.equal(
      await page.eval(
        `document.querySelector('[data-diff-style="unified"]').getAttribute('aria-pressed')`,
      ),
      'true',
    );
    await page.eval(`document.querySelector('[data-diff-style="split"]').click()`);
    await page.waitFor(`!!document.querySelector('[data-split-fallback]')`, 'the narrow fallback');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-split-fallback]').textContent`),
      /widen the panel or use Full view/,
    );
    const sideBySide = `!!document.querySelector('[data-diff-editor] .monaco-diff-editor.side-by-side')`;
    assert.equal(await page.eval(sideBySide), false, 'unified while too narrow');
    // Full view (⇧⌘M): the whole workspace area, the terminal hidden; side by side fits.
    await pressShortcut(page, 'changesFullView');
    await page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'true' && !document.querySelector('[data-split-fallback]')`,
      'full view',
    );
    await page.waitFor(sideBySide, 'the side-by-side diff', 20_000);
    assert.equal(
      await page.eval(`document.querySelector('[data-terminal]')?.offsetParent ?? null`),
      null,
      'the terminal hidden in full view',
    );
    // Esc returns, and the diff is unified again beside the terminal.
    await pressKey(page, 'Escape');
    await page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'false' && !!document.querySelector('[data-split-fallback]')`,
      'back beside the terminal',
    );
    await page.waitFor(`${changesWidth} === 520`, 'the same width');
    // The button does the same, and reads Side panel meanwhile.
    await page.eval(`document.querySelector('[data-changes-full]').click()`);
    await page.waitFor(
      `document.querySelector('[data-changes-full]').textContent === 'Side panel'`,
      'full view from the button',
    );
    await page.eval(`document.querySelector('[data-changes-full]').click()`);
    await page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'false'`,
      'the side panel from the button',
    );

    // The file list (spec §6.4): as tall as its files, up to about five rows.
    const list = `document.querySelector('[data-changes-list]')`;
    const listBox = `(() => { const l = ${list}; const r = l.getBoundingClientRect(); return { mode: l.dataset.changesList, height: Math.round(r.height), width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), scrolls: l.scrollHeight > l.clientHeight + 1 }; })()`;
    type ListBox = {
      mode: string;
      height: number;
      width: number;
      left: number;
      right: number;
      scrolls: boolean;
    };
    let box = await page.eval<ListBox>(listBox);
    assert.equal(box.mode, 'auto');
    assert.equal(box.scrolls, false, 'two files fit');
    const fewHeight = box.height;
    assert.ok(fewHeight < 120, `two files: ${fewHeight}px`);
    const extra = Array.from({ length: 12 }, (_, i) => `extra-${String(i).padStart(2, '0')}.txt`);
    for (const file of extra) fs.writeFileSync(path.join(shopTree, file), `${file}\n`);
    await page.waitFor(
      `document.querySelectorAll('[data-changes-list] [data-change-file]').length === 14`,
      'fourteen files',
      10_000,
    );
    box = await page.eval<ListBox>(listBox);
    assert.equal(box.scrolls, true, 'many files scroll');
    assert.ok(box.height > fewHeight && box.height <= 170, `many files: ${box.height}px`);
    const autoHeight = box.height;
    // Dragging the divider down gives the list more; double-click resets it.
    const dragBy = async (selector: string, dx: number, dy: number) => {
      const at = await page.eval<{ x: number; y: number }>(
        `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      );
      const mouse = (type: string, x: number, y: number) =>
        page.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: 1,
        });
      await mouse('mousePressed', at.x, at.y);
      await mouse('mouseMoved', at.x + dx / 2, at.y + dy / 2);
      await mouse('mouseMoved', at.x + dx, at.y + dy);
      await mouse('mouseReleased', at.x + dx, at.y + dy);
    };
    await dragBy('[data-changes-list-resize]', 0, 80);
    await page.waitFor(
      `${list}.dataset.changesList === 'sized' && Math.round(${list}.getBoundingClientRect().height) === ${autoHeight + 80}`,
      'the dragged height',
    );
    // Saved on release, which may come after the last move.
    await page.waitFor(
      `localStorage.getItem('changes-list-height') === '${autoHeight + 80}'`,
      'the dragged height saved',
    );
    await page.eval(
      `document.querySelector('[data-changes-list-resize]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    );
    await page.waitFor(`${list}.dataset.changesList === 'auto'`, 'the default height again');
    assert.equal(await page.eval(`localStorage.getItem('changes-list-height')`), null);
    await dragBy('[data-changes-list-resize]', 0, 60);
    await page.waitFor(`${list}.dataset.changesList === 'sized'`, 'dragged again');
    await page.waitFor(
      `localStorage.getItem('changes-list-height') === '${autoHeight + 60}'`,
      'dragged again, saved',
    );
    // Clicking a group's header collapses the list to one line: the current
    // file with previous and next, and the keys from inside the diff.
    const order = await page.eval<string[]>(
      `[...document.querySelectorAll('[data-changes-list] [data-change-file]')].map((f) => f.dataset.changeFile)`,
    );
    const [firstFile, secondFile] = order as [string, string];
    await page.eval(
      `document.querySelector('[data-change-file=${JSON.stringify(firstFile)}]').click()`,
    );
    await page.eval(`document.querySelector('[data-changes-list-toggle]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-changes-list-collapsed]') && !document.querySelector('[data-changes-list]')`,
      'the collapsed list',
    );
    const currentFile = `document.querySelector('[data-changes-current]')?.textContent`;
    assert.equal(await page.eval(currentFile), firstFile);
    assert.equal(await page.eval(`localStorage.getItem('changes-list-collapsed')`), '1');
    assert.match(
      await page.eval<string>(
        `document.querySelector('[data-changes-list-collapsed]').textContent`,
      ),
      /1\/14/,
    );
    assert.equal(
      await page.eval(`document.querySelector('[data-changes-prev]').disabled`),
      true,
      'no file before the first',
    );
    await page.eval(`document.querySelector('[data-changes-next]').click()`);
    await page.waitFor(`${currentFile} === ${JSON.stringify(secondFile)}`, 'the next file');
    await page.eval(`document.querySelector('[data-changes-prev]').click()`);
    await page.waitFor(`${currentFile} === ${JSON.stringify(firstFile)}`, 'the previous file');
    const monacoInput = `document.querySelector('[data-diff-editor] .modified textarea, [data-diff-editor] .modified .native-edit-context')`;
    await page.waitFor(`!!${monacoInput}`, 'the diff', 20_000);
    await page.eval(`${monacoInput}.focus()`);
    await pressShortcut(page, 'changesFileStep', 1);
    await page.waitFor(`${currentFile} === ${JSON.stringify(secondFile)}`, 'the next file by key');
    await pressShortcut(page, 'changesFileStep', 0);
    await page.waitFor(
      `${currentFile} === ${JSON.stringify(firstFile)}`,
      'the previous file by key',
    );
    // Full view: the list in a column on the left, its width dragged and kept.
    await pressShortcut(page, 'changesFullView');
    await page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'true'`,
      'full view',
    );
    // Still collapsed there: the line above the diff; open the column.
    await page.eval(`document.querySelector('[data-changes-list-toggle]').click()`);
    await page.waitFor(`${list}?.dataset.changesList === 'column'`, 'the column');
    box = await page.eval<ListBox>(listBox);
    const diffLeft = await page.eval<number>(
      `Math.round(document.querySelector('[data-diff-area]').getBoundingClientRect().left)`,
    );
    assert.equal(box.width, 280, 'the default column width');
    assert.ok(box.right <= diffLeft, 'the diff right of the list');
    await dragBy('[data-changes-column-resize]', 60, 0);
    await page.waitFor(
      `Math.round(${list}.getBoundingClientRect().width) === 340`,
      'the dragged column',
    );
    await page.waitFor(
      `localStorage.getItem('changes-list-width') === '340'`,
      'the dragged column saved',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'false' && ${list}?.dataset.changesList === 'sized'`,
      'back beside the terminal, as dragged',
    );
    for (const file of extra) fs.rmSync(path.join(shopTree, file));
    await page.waitFor(
      `document.querySelectorAll('[data-changes-list] [data-change-file]').length === 2`,
      'the two files again',
      10_000,
    );
    const message = `document.querySelector('[aria-label="Commit message"]').value`;
    assert.equal(await page.eval(message), 'PROJ-7: Add cart');
    await clickButtonText(page, 'Ask Claude to write it');
    // Claude's input file grows a line at a time: wait for the line the check needs.
    const commitAsk =
      /Commit the uncommitted changes in this worktree.*Start the subject line with "PROJ-7: "/;
    const asked = await waitForFile(path.join(fx.root, 'claude-input-8.txt'), {
      until: commitAsk,
    });
    assert.match(asked, commitAsk);
    await clickButtonText(page, 'Commit 2 files');
    await page.waitFor(`${panelText}.includes('Committed · 2')`, 'the commit');
    assert.equal(fx.git(shopTree, 'log', '-1', '--format=%s').trim(), 'PROJ-7: Add cart');
    // The profile's commit identity (Edit profile) is the author and committer.
    assert.equal(
      fx.git(shopTree, 'log', '-1', '--format=%an <%ae> / %cn <%ce>').trim(),
      'Casey Example <casey@example.com> / Casey Example <casey@example.com>',
    );
    await page.waitFor(hasButton('Push 1 commit to origin'), 'Push');
    await clickButtonText(page, 'Push 1 commit to origin');
    await page.waitFor(hasButton('Create PR'), 'Create PR', 20_000);
    assert.equal(
      fx.git(shopOrigin, 'rev-parse', 'PROJ-7-add-cart').trim(),
      fx.git(shopTree, 'rev-parse', 'HEAD').trim(),
      'pushed to the bare remote',
    );
    await clickButtonText(page, 'Create PR');
    assert.equal(
      await waitForFile(path.join(fx.root, 'pr-created.txt')),
      'PROJ-7-add-cart into main',
    );
    await page.waitFor(`!!document.querySelector('[data-pr-badge=open]')`, 'the PR badge', 20_000);
    fs.writeFileSync(path.join(fx.root, 'pr-merged'), '');
    await clickButtonText(page, 'Check again');
    await page.waitFor(
      `!!document.querySelector('[data-merged]')`,
      'Delete workspace? after merging',
      20_000,
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-merged]').innerText`),
      /PROJ-7-add-cart is merged into main\. Delete workspace\?/,
    );
    await screenshot(page, screenshotDir, '13-merged.png');

    // Linked repositories (spec §21): one workspace in shop and cartapi, one
    // Claude with --add-dir, per-repository changes, commit and push to their
    // bare remotes, link and unlink cartweb, then delete.
    fs.rmSync(path.join(fx.root, 'pr-merged'));
    fs.rmSync(path.join(fx.root, 'pr-created.txt'));
    const { origin: apiOrigin, clone: cartapi } = fx.cloneWithRemote('cartapi', 'main');
    const cartweb = fx.localRepo('cartweb');
    assert.equal(outside(cartapi, '--profile', 'work').status, 0);
    assert.equal(outside(cartweb, '--profile', 'work').status, 0);
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-also-in]')`, 'Also in');
    await page.eval(
      `[...document.querySelectorAll('[data-also-in] label')].find((l) => l.textContent.includes('cartapi')).querySelector('input').click()`,
    );
    const trustNote = `document.querySelector('dialog[open] [data-trust-note]')?.textContent`;
    assert.equal(await page.eval(trustNote), LINK_TRUST_NOTE);
    await page.waitFor(
      `document.querySelector('[data-also-in]').innerText.includes('One Claude works in all of them, starting in shop.')`,
      'the Also in note',
    );
    await typeInField(page, '#ws-task', 'PROJ-8 Linked cart', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the linked workspace', 30_000);
    const linkedRun = (await claudeRun(9)).split('\n');
    const linkedTree = linkedRun[0] as string;
    const apiTree = path.join(
      path.dirname(path.dirname(linkedTree)),
      'cartapi',
      'PROJ-8-linked-cart',
    );
    assert.equal(path.basename(linkedTree), 'PROJ-8-linked-cart');
    // Spec §9.4: the first start begins a conversation with an id the app chose.
    const linkedSession = linkedRun[linkedRun.indexOf('--session-id') + 1] as string;
    assert.match(linkedSession, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      linkedRun
        .slice(3)
        .filter((a) => a !== '--settings' && !a.endsWith('.json'))
        .filter((a) => a !== '--session-id' && a !== linkedSession),
      ['--add-dir', apiTree],
    );
    assert.equal(fx.git(apiTree, 'branch', '--show-current').trim(), 'PROJ-8-linked-cart');
    await page.waitFor(`document.querySelectorAll('[data-repo-chip]').length === 2`, 'two chips');
    assert.equal(
      await page.eval(`document.querySelector('[data-linked-chip]')?.textContent`),
      '+1',
    );
    // cartapi stays collapsed (spec §6.1); its row counts the workspace it's linked into.
    assert.equal(
      await page.eval(
        `document.querySelector('[data-project="cartapi"] [data-linked-count]')?.textContent`,
      ),
      '↗ 1',
    );
    await screenshot(page, screenshotDir, '14-linked.png');

    // Changes per repository; Commit and Push act on one repository each.
    fs.writeFileSync(path.join(linkedTree, 'cart.txt'), 'linked\n');
    fs.writeFileSync(path.join(apiTree, 'api.txt'), 'linked\n');
    await pressKey(page, 'KeyD', CMD | MOD.shift);
    await page.waitFor(
      `document.querySelectorAll('[data-changes-repo]').length === 2`,
      'a section per repository',
    );
    const section = (id: string) => `document.querySelector('[data-changes-repo="${id}"]')`;
    // Each section has its own message editor; Ask Claude names that repository only.
    await page.waitFor(hasButton('Ask Claude to write it', section('cartapi')), 'Ask Claude');
    await clickButtonText(page, 'Ask Claude to write it', section('cartapi'));
    const linkedAsk = new RegExp(`cartapi repository only, whose worktree is ${apiTree}`);
    const askedLinked = await waitForFile(path.join(fx.root, 'claude-input-9.txt'), {
      until: linkedAsk,
    });
    assert.match(askedLinked, linkedAsk);
    assert.doesNotMatch(askedLinked, /shop/);
    await screenshot(page, screenshotDir, '14a-linked-changes.png');
    for (const id of ['shop', 'cartapi']) {
      await page.waitFor(`${section(id)}.innerText.includes('Uncommitted 1')`, `${id} changes`);
      await page.waitFor(hasButton('Commit 1', section(id)), `${id} Commit`);
      const editor = `${section(id)}.querySelector('textarea[aria-label="Commit message for ${id}"]')`;
      assert.equal(await page.eval(`${editor}.value`), 'PROJ-8: Linked cart');
      await page.eval(`${editor}.focus(), ${editor}.select(), true`);
      await page.send('Input.insertText', { text: `PROJ-8: ${id} part` });
      await sleep(300);
      await clickButtonText(page, 'Commit 1', section(id));
      await page.waitFor(hasButton('Push ↑1', section(id)), `${id} Push`, 20_000);
      await page.waitFor(
        `![...${section(id)}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Push ↑1')).disabled`,
        `${id} Push enabled`,
      );
      await clickButtonText(page, 'Push ↑1', section(id));
      await page.waitFor(
        `${section(id)}.innerText.includes('pushed') && !${section(id)}.innerText.includes('not pushed')`,
        `${id} pushed`,
        20_000,
      );
    }
    assert.equal(fx.git(apiTree, 'log', '-1', '--format=%s').trim(), 'PROJ-8: cartapi part');
    assert.equal(fx.git(linkedTree, 'log', '-1', '--format=%s').trim(), 'PROJ-8: shop part');
    assert.equal(
      fx.git(apiOrigin, 'rev-parse', 'PROJ-8-linked-cart').trim(),
      fx.git(apiTree, 'rev-parse', 'HEAD').trim(),
      'cartapi pushed to its bare remote',
    );
    assert.equal(
      fx.git(shopOrigin, 'rev-parse', 'PROJ-8-linked-cart').trim(),
      fx.git(linkedTree, 'rev-parse', 'HEAD').trim(),
      'shop pushed to its bare remote',
    );
    await page.waitFor(
      `[...${section('cartapi')}.querySelectorAll('button')].some((b) => b.textContent === 'Create PR' && !b.disabled)`,
      'Create PR enabled',
      20_000,
    );
    await clickButtonText(page, 'Create PR', section('cartapi'));
    assert.equal(
      await waitForFile(path.join(fx.root, 'pr-created.txt')),
      'PROJ-8-linked-cart into main',
    );
    await pressKey(page, 'KeyD', CMD | MOD.shift);

    // Link cartweb and restart Claude: the conversation resumes with both folders.
    const webTree = path.join(
      path.dirname(path.dirname(linkedTree)),
      'cartweb',
      'PROJ-8-linked-cart',
    );
    await chooseFromNextContextMenu(mainProcess, 'Link another repository…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(`!!document.querySelector('dialog[open] input[name=link-project]')`, 'Link');
    assert.equal(await page.eval(trustNote), LINK_TRUST_NOTE);
    await page.eval(
      `[...document.querySelectorAll('dialog[open] label')].find((l) => l.textContent.includes('cartweb')).querySelector('input').click()`,
    );
    await clickButtonText(
      page,
      'Link and restart Claude',
      'document.querySelector("dialog[open]")',
    );
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'linked cartweb', 30_000);
    const relinked = (await claudeRun(10)).split('\n');
    assert.deepEqual(
      relinked.slice(relinked.indexOf('--resume'), relinked.indexOf('--resume') + 2),
      ['--resume', linkedSession],
    );
    assert.deepEqual(
      relinked.filter((_a, i) => relinked[i - 1] === '--add-dir'),
      [apiTree, webTree],
    );
    await page.waitFor(`document.querySelectorAll('[data-repo-chip]').length === 3`, 'three chips');

    // Spec §21.9: Claude gets the settings file with the ask rule for the
    // link command; turning off Ask before Claude links a repository in Edit
    // profile gives the next start the plain one (the Unlink restart below).
    const settingsOf = (run: string[]) => run[run.indexOf('--settings') + 1] as string;
    assert.equal(path.basename(settingsOf(relinked)), 'settings-ask-link.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsOf(relinked), 'utf8')).permissions, {
      ask: [`Bash(${BRAND.cliCommand} link:*)`, `Bash(${BRAND.helperCommand} link:*)`],
    });
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Work"]');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #edit-profile-name')`,
      'Edit profile',
    );
    await page.eval(
      `[...document.querySelectorAll('dialog[open] label')].find((l) => l.textContent.includes('Ask before Claude links a repository')).querySelector('input').click()`,
    );
    // Sounds per event, all off by default (spec §10.3); ticking one plays it.
    assert.deepEqual(
      await page.eval(
        `[...document.querySelectorAll('dialog[open] [data-sounds] label')].map((l) => [l.textContent, l.querySelector('input').checked])`,
      ),
      [
        ['Needs permission', false],
        ['Waiting for input', false],
        ['Awaiting approvala workflow gate', false],
        ['Done', false],
        ['Error', false],
      ],
    );
    await page.eval(`(() => {
      window.__tones = 0;
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () { window.__tones++; return create.call(this); };
    })()`);
    await page.eval(
      `[...document.querySelectorAll('dialog[open] [data-sounds] label')].find((l) => l.textContent === 'Done').querySelector('input').click()`,
    );
    assert.equal(await page.eval<number>('window.__tones'), 1, 'the Done sound played once');
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile saved');
    const savedAlerts = JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles.find(
      (p: { id: string }) => p.id === 'work',
    ).alerts;
    assert.deepEqual(savedAlerts.sounds, {
      needsPermission: false,
      needsInput: false,
      awaitingApproval: false,
      done: true,
      error: false,
    });

    // Unlink it again: its worktree goes, Claude restarts without it.
    await chooseFromNextContextMenu(mainProcess, 'Unlink cartweb…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-repo-card=cartweb]')`,
      'Unlink',
    );
    await clickButtonText(page, 'Unlink cartweb', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'unlinked cartweb', 30_000);
    const unlinked = (await claudeRun(11)).split('\n');
    assert.equal(path.basename(settingsOf(unlinked)), 'settings.json');
    assert.deepEqual(
      unlinked.filter((_a, i) => unlinked[i - 1] === '--add-dir'),
      [apiTree],
    );
    assert.equal(fs.existsSync(webTree), false, 'the unlinked worktree is gone');

    // Claude links it itself (spec §21.9): it was told about cartweb at
    // session start, runs the command line tool, and the app shows the link.
    // The fake claude's redirect creates the file before the hook writes it.
    const context = JSON.parse(await waitForFile(path.join(fx.root, 'claude-context-11.txt')));
    assert.match(context.hookSpecificOutput.additionalContext, /- cartweb: /);
    assert.match(
      context.hookSpecificOutput.additionalContext,
      new RegExp(`${BRAND.cliCommand} link <name>`),
    );
    await page.eval(
      `[...document.querySelectorAll('[aria-label=Terminals] [role=tab]')].find((t) => t.textContent.includes('Claude')).click()`,
    );
    await focusTerminal();
    await typeInTerminal(page, 'link cartweb');
    const linkOutput = await waitForFile(path.join(fx.root, 'claude-link-11.txt'), {
      until: /^exit \d+$/m,
    });
    assert.match(linkOutput, new RegExp(`^Linked cartweb: ${webTree}$`, 'm'));
    assert.match(linkOutput, /^exit 0$/m);
    assert.equal(fx.git(webTree, 'branch', '--show-current').trim(), 'PROJ-8-linked-cart');
    await page.waitFor(
      `document.querySelectorAll('[data-repo-chip]').length === 3`,
      'three chips again',
    );
    await page.waitFor(
      `document.querySelector('[data-app-notice]')?.innerText.includes('Claude linked cartweb to PROJ-8 Linked cart')`,
      'the notice',
    );
    await screenshot(page, screenshotDir, '14b-claude-linked.png');
    assert.equal(
      fs.existsSync(path.join(fx.root, 'claude-run-12.txt')),
      false,
      'Claude keeps running',
    );

    // Skill sources (spec §13.2, §13.3): a plugin for all projects and a plain
    // skills folder for selected ones, added in Edit profile › Skills; shells
    // get CLAUDE_CODE_PLUGIN_DIRS, Claude started by the app --plugin-dir.
    const teamPlugin = path.join(fx.root, 'skill-sources', 'team-plugin');
    fs.mkdirSync(path.join(teamPlugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(teamPlugin, '.claude-plugin', 'plugin.json'), '{"name":"team"}');
    fs.mkdirSync(path.join(teamPlugin, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(teamPlugin, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews the diff.\n---\n',
    );
    const plainSkills = path.join(fx.root, 'skill-sources', 'mine');
    fs.mkdirSync(path.join(plainSkills, 'hello'), { recursive: true });
    fs.writeFileSync(path.join(plainSkills, 'hello', 'SKILL.md'), '---\nname: hello\n---\n');
    const wrapper = path.join(path.dirname(configFile), 'plugins', 'work', 'mine');
    const addSource = `document.querySelector('dialog[open] [data-add-source]')`;
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Work"]');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-edit-tab=skills]')`,
      'Edit profile',
    );
    await page.eval(`document.querySelector('dialog[open] [data-edit-tab=skills]').click()`);
    await page.waitFor(`!!${addSource}`, 'the Skills tab');
    await answerFolderPanel(teamPlugin);
    await clickButtonText(page, 'Browse…', addSource);
    await page.waitFor(
      `${addSource}.querySelector('input[aria-label=Folder]').value === ${JSON.stringify(teamPlugin)}`,
      'the folder',
    );
    await clickButtonText(page, 'Add source', addSource);
    await page.waitFor(
      `document.querySelector('[data-source-skills="team-plugin"]')?.innerText.includes('/team:review · Reviews the diff.')`,
      'the plugin source',
    );
    await answerFolderPanel(plainSkills);
    await clickButtonText(page, 'Browse…', addSource);
    await page.waitFor(
      `${addSource}.querySelector('input[aria-label=Folder]').value === ${JSON.stringify(plainSkills)}`,
      'the folder',
    );
    await page.eval(
      `[...${addSource}.querySelectorAll('label')].find((l) => l.textContent.includes('Selected projects')).querySelector('input').click()`,
    );
    await clickButtonText(page, 'Add source', addSource);
    await page.waitFor(
      `document.querySelector('[data-source-skills="mine"]')?.innerText.includes('/mine:hello')`,
      'the wrapped source',
    );
    assert.equal(fs.readlinkSync(path.join(wrapper, 'skills')), plainSkills);
    await screenshot(page, screenshotDir, '14c-skill-sources.png');
    await clickButtonText(page, 'Close', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile closed');

    await clickProject(page, 'shop');
    await page.waitFor(`document.querySelector('h1')?.textContent === 'shop'`, 'shop');
    await clickButtonText(page, 'Open shell');
    await page.waitFor(`!!document.querySelector('[data-connected]')`, 'a project shell');
    await typeInTerminal(page, `printf '%s' "$CLAUDE_CODE_PLUGIN_DIRS" > "$HOME/plugin-dirs.txt"`);
    assert.equal(await waitForFile(path.join(fx.root, 'plugin-dirs.txt')), teamPlugin);
    // The project's Skills tab switches the selected-projects source on here.
    await page.eval(`document.querySelector('[data-project-tab=skills]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-project-source=mine] input')`,
      'the Skills tab',
    );
    await page.eval(`document.querySelector('[data-project-source=mine] input').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-project-source=mine] [data-source-skills]')`,
      'mine switched on',
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles[0].skills.map(
        (s: { projects?: string[] }) => s.projects ?? null,
      ),
      [null, ['shop']],
    );
    await clickButtonText(page, 'Start Claude here');
    const skillsRun = (await claudeRun(12)).split('\n');
    assert.deepEqual(
      skillsRun.filter((_a, i) => skillsRun[i - 1] === '--plugin-dir'),
      [teamPlugin, wrapper],
    );
    await clickLabel(page, 'Close shop · claude');
    await clickLabel(page, 'Close shop · shell');
    await page.waitFor(`${tabCount} === 0`, 'the project sessions to close');
    await page.eval(`document.querySelector('nav button[title^="PROJ-8 Linked cart"]').click()`);
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Linked cart'`,
      'the linked workspace again',
    );
    // Its Claude started before the sources were added (spec §13.3).
    await page.waitFor(`!!document.querySelector('[data-skills-changed]')`, 'Skills changed');

    // Workflow (spec §13.4, §13.5): set up in Edit profile › Workflow, read from
    // a status file in the worktree; a Stop at a gate is Awaiting approval with
    // one notification, and Continue types the prompt into Claude.
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Work"]');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-edit-tab=workflow]')`,
      'Edit profile',
    );
    await page.eval(`document.querySelector('dialog[open] [data-edit-tab=workflow]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-workflow-editor=profile]')`,
      'the Workflow tab',
    );
    await page.eval(
      `[...document.querySelectorAll('[data-workflow-editor=profile] label')].find((l) => l.textContent.includes('Read a workflow status')).querySelector('input').click()`,
    );
    const statuses: [string, string, string][] = [
      ['draft', 'Draft', 'step'],
      ['spec-review', 'Spec review', 'gate'],
      ['building', 'Building', 'step'],
      ['done', 'Done', 'final'],
    ];
    for (const [i, [value, label, kind]] of statuses.entries()) {
      await clickButtonText(
        page,
        '+ Add status',
        'document.querySelector("[data-workflow-editor=profile]")',
      );
      await typeInField(page, `[aria-label="Status ${i + 1} value"]`, value, false);
      await typeInField(page, `[aria-label="Status ${i + 1} label"]`, label, false);
      await page.eval(`(() => {
        const select = document.querySelector('[aria-label="Status ${i + 1} kind"]');
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(select, '${kind}');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    }
    // The Start prompt is the profile's (spec §13.5); a project may replace it.
    await typeInField(page, '#wf-start', 'Plan {id}: {title}.', false);
    // Match field, id, title and status fields and the tab's label wait under
    // Advanced, which says what they are while collapsed.
    const advanced = `document.querySelector('[data-workflow-advanced]')`;
    assert.equal(await page.eval(`${advanced}.open`), false);
    assert.match(
      await page.eval<string>(`${advanced}.querySelector('summary').innerText`),
      /branch is the branch, status in status, title from the first heading, tab specification\.md/,
    );
    await page.eval(`${advanced}.open = true`);
    await typeInField(page, '#wf-title-field', 'title', false);
    await typeInField(page, '#wf-document-label', 'Spec', false);
    // The gate's hint and answer button (spec §13.5).
    await typeInField(page, '[aria-label="Status 2 hint"]', 'Review and approve the spec', false);
    await typeInField(page, '[aria-label="Status 2 answer label"]', 'Approve spec', false);
    await typeInField(
      page,
      '[aria-label="Status 2 answer text"]',
      'I approve the spec of {id}.',
      false,
    );
    // The preview reads the linked workspace's worktree before anything is saved.
    const specPath = path.join(linkedTree, 'docs', 'specs', 'cart', 'specification.md');
    const specFile = (status: string, body = '# Cart\n') => {
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(
        specPath,
        `---\nbranch: PROJ-8-linked-cart\nstatus: ${status}\nticket: https://tracker.example.com/PROJ-8\n---\n${body}`,
      );
    };
    specFile('draft');
    await page.eval(`(() => {
      const select = document.querySelector('[aria-label="Workspace to preview"]');
      const option = [...select.options].find((o) => o.textContent.startsWith('PROJ-8'));
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(
      `document.querySelector('[data-preview-result]')?.textContent.startsWith('Status Draft (Step), 1 of 4')`,
      'the preview',
    );
    await screenshot(page, screenshotDir, '14d-workflow-settings.png');
    await clickButtonText(page, 'Save workflow', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the workflow saved');
    assert.equal(
      JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles[0].workflow.statuses[1].kind,
      'gate',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles[0].workflow.startPrompt,
      'Plan {id}: {title}.',
    );
    // The task lookup has its own tab (spec §13.7).
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Work"]');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-edit-tab=lookup]')`,
      'Edit profile',
    );
    await page.eval(`document.querySelector('dialog[open] [data-edit-tab=lookup]').click()`);
    await page.waitFor(`!!document.querySelector('[data-lookup-editor]')`, 'the Task lookup tab');
    // A task lookup (spec §13.7): a scratch command that knows FAKE-1 and
    // FAKE-7 (after a second, so "Looking up" shows) and SLOW-9 (after 30 s),
    // finds nothing for FAKE-404 and fails for anything else. Each run is
    // recorded in lookups.txt.
    const lookupScript = path.join(fx.root, 'bin', 'fake-lookup');
    fs.writeFileSync(
      lookupScript,
      `#!/bin/sh\necho "$1" >> "$HOME/lookups.txt"\ncase "$1" in\n  FAKE-1) sleep 1; echo "Fix the fake login" ;;\n  FAKE-7) sleep 1; echo "Tidy the cart" ;;\n  SLOW-9) sleep 30; echo "A slow task" ;;\n  FAKE-404) ;;\n  *) echo "no task $1" >&2; exit 3 ;;\nesac\n`,
      { mode: 0o755 },
    );
    // Ask Claude: the profile's own model unless one is named, ToolSearch with
    // a connector's tool, and Claude's reason when it finds no title.
    const chooseLookup = (label: string) =>
      page.eval(
        `[...document.querySelectorAll('[data-lookup-fields] label')].find((l) => l.textContent.includes('${label}')).querySelector('input').click()`,
      );
    await chooseLookup('Ask Claude');
    assert.equal(
      await page.eval<string>(`document.querySelector('#lookup-model').placeholder`),
      "Profile's default",
    );
    await typeInField(page, '#lookup-tools', 'mcp__tracker__get_issue', false);
    await typeInField(page, '[aria-label="Task id to test"]', 'FAKE-3', false);
    await clickButtonText(page, 'Test', 'document.querySelector("[data-lookup-fields]")');
    await page.waitFor(
      `document.querySelector('[data-lookup-detail]')?.innerText === 'Claude: The tracker has no task with that key.'`,
      "Claude's reason",
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-lookup-result]').innerText`),
      /Claude found no title/,
    );
    const lookupArgs = fs.readFileSync(path.join(fx.root, 'claude-lookup-args.txt'), 'utf8');
    const argList = lookupArgs.trimEnd().split('\n');
    assert.equal(argList.includes('--model'), false, "no --model: the profile's own");
    // Neither --tools nor --disallowedTools: both can hide connector tools.
    assert.equal(argList.includes('--tools') || argList.includes('--disallowedTools'), false);
    assert.deepEqual(
      JSON.parse(argList[argList.indexOf('--settings') + 1] as string).permissions.deny,
      LOOKUP_DENIED_TOOLS,
    );
    assert.equal(argList[argList.indexOf('--allowedTools') + 1], 'mcp__tracker__get_issue');
    await chooseLookup('Run a command');
    await typeInField(page, '#lookup-command', `${lookupScript} {id}`, false);
    const lookupResult = `document.querySelector('[data-lookup-result]')?.innerText`;
    await typeInField(page, '[aria-label="Task id to test"]', 'FAKE-1', false);
    await clickButtonText(page, 'Test', 'document.querySelector("[data-lookup-fields]")');
    await page.waitFor(`${lookupResult} === '✓ Fix the fake login'`, 'the lookup test');
    await typeInField(page, '[aria-label="Task id to test"]', 'FAKE-2', false);
    await clickButtonText(page, 'Test', 'document.querySelector("[data-lookup-fields]")');
    await page.waitFor(
      `${lookupResult}?.includes('The lookup failed (exit 3): no task FAKE-2')`,
      'the failed lookup test',
    );
    await clickButtonText(page, 'Save task lookup', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the task lookup saved');
    assert.equal(
      JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles[0].taskLookup.kind,
      'command',
    );

    // Export and Import (spec §13.9): the workflow as a file, nothing of the
    // profile in it; an import fills the form and lists what it would change.
    // Right after another dialog closes, Edit profile… now and then opens
    // nothing; a menu that was used gets one more try.
    const openEditProfile = async (profile: string, tab: string) => {
      const tabButton = `document.querySelector('dialog[open] [data-edit-tab=${tab}]')`;
      for (let attempt = 1; ; attempt++) {
        await mainProcess.eval('globalThis.__lastMenu = null');
        await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
        await openContextMenu(page, `[aria-label="Select ${profile}"]`);
        try {
          await page.waitFor(`!!${tabButton}`, 'Edit profile', 5000);
          break;
        } catch (error) {
          const used = await mainProcess.eval<boolean>('globalThis.__lastMenu !== null');
          if (attempt >= 2 || !used) throw error;
        }
      }
      await page.eval(`${tabButton}.click()`);
    };
    const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    await mainProcess.eval(`(() => {
      const { dialog } = process.mainModule.require('electron');
      globalThis.__savePanel = { answer: null };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.__savePanel.answer });
    })()`);
    const exportedFile = path.join(fx.root, 'shared-workflow.json');
    await mainProcess.eval(`globalThis.__savePanel.answer = ${JSON.stringify(exportedFile)}`);
    await openEditProfile('Work', 'workflow');
    const fileButtons = `document.querySelector('[data-workflow-file-buttons]')`;
    await page.waitFor(`!!${fileButtons}`, 'Import and Export');
    await clickButtonText(page, 'Export…', fileButtons);
    await page.waitFor(`!!document.querySelector('[data-exported]')`, 'the export');
    const exported = JSON.parse(fs.readFileSync(exportedFile, 'utf8'));
    assert.equal(exported.kind, `${BRAND.slug}-workflow`);
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.workflow.statuses[1].answer, {
      label: 'Approve spec',
      prompt: 'I approve the spec of {id}.',
    });
    assert.equal('lookup' in exported.workflow || 'taskLookup' in exported, false);
    // A colleague's version: the gate without its hint and answer, one more status.
    const theirs = structuredClone(exported);
    delete theirs.workflow.statuses[1].hint;
    delete theirs.workflow.statuses[1].answer;
    theirs.workflow.statuses.splice(3, 0, { value: 'qa', label: 'QA', kind: 'gate' });
    const importedFile = path.join(fx.root, 'their-workflow.json');
    fs.writeFileSync(importedFile, JSON.stringify(theirs));
    await answerFolderPanel(importedFile);
    await clickButtonText(page, 'Import…', fileButtons);
    await page.waitFor(`!!document.querySelector('[data-draft-notice]')`, 'the imported draft');
    const changesText = await page.eval<string>(
      `document.querySelector('[data-draft-notice] [data-workflow-changes]').innerText`,
    );
    assert.match(changesText, /Spec review: removes the hint "Review and approve the spec"/);
    assert.match(changesText, /Spec review: removes the answer button "Approve spec → /);
    assert.match(changesText, /Adds QA \(qa, Gate\)/);
    assert.equal(await page.eval(`document.querySelectorAll('[data-status-more]').length`), 5);
    // Nothing is saved until Save workflow.
    assert.equal(readConfig().profiles[0].workflow.statuses.length, 4);
    await screenshot(page, screenshotDir, '14d2-workflow-import.png');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile closed');

    // A skill source carrying the workflow file offers it (spec §13.9): over
    // an existing workflow, Use it first lists what would change.
    fs.writeFileSync(path.join(teamPlugin, `${BRAND.slug}-workflow.json`), JSON.stringify(theirs));
    await openEditProfile('Work', 'skills');
    const teamOffer = `document.querySelector('[data-skill-source=team-plugin] [data-workflow-offer]')`;
    await page.waitFor(`${teamOffer}?.dataset.workflowOffer === 'line'`, 'Includes a workflow');
    await clickButtonText(page, 'Use it', teamOffer);
    await page.waitFor(`${teamOffer}?.dataset.workflowOffer === 'confirm'`, 'Replace?');
    assert.match(
      await page.eval<string>(`${teamOffer}.innerText`),
      /Replace your current workflow\?[\s\S]*removes the answer button/,
    );
    await clickButtonText(page, 'Keep mine', teamOffer);
    await page.waitFor(`${teamOffer}?.dataset.workflowOffer === 'line'`, 'kept');
    assert.equal(readConfig().profiles[0].workflow.statuses[1].answer.label, 'Approve spec');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile closed');
    // Without a workflow, adding such a source offers it, and Use it saves it.
    // (Personal, for no projects, so its sessions don't change.)
    const sharedSource = path.join(fx.root, 'skill-sources', 'shared');
    fs.mkdirSync(path.join(sharedSource, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(sharedSource, 'plan', 'SKILL.md'), '---\nname: plan\n---\n');
    fs.copyFileSync(exportedFile, path.join(sharedSource, `${BRAND.slug}-workflow.json`));
    await openEditProfile('Personal', 'skills');
    const addShared = `document.querySelector('dialog[open] [data-add-source]')`;
    await page.waitFor(`!!${addShared}`, 'the Skills tab');
    await answerFolderPanel(sharedSource);
    await clickButtonText(page, 'Browse…', addShared);
    await page.waitFor(
      `${addShared}.querySelector('input[aria-label=Folder]').value === ${JSON.stringify(sharedSource)}`,
      'the folder',
    );
    await page.eval(
      `[...${addShared}.querySelectorAll('label')].find((l) => l.textContent.includes('Selected projects')).querySelector('input').click()`,
    );
    await clickButtonText(page, 'Add source', addShared);
    const sharedOffer = `document.querySelector('[data-skill-source=shared] [data-workflow-offer]')`;
    await page.waitFor(`${sharedOffer}?.dataset.workflowOffer === 'offer'`, 'the offer');
    assert.match(
      await page.eval<string>(`${sharedOffer}.innerText`),
      /This skill source includes a workflow\. Use it\?\n+Draft › ◆Spec review › Building › Done/,
    );
    await screenshot(page, screenshotDir, '14d3-workflow-offer.png');
    await clickButtonText(page, 'Use it', sharedOffer);
    await page.waitFor(`${sharedOffer}?.dataset.workflowOffer === 'in-use'`, 'in use');
    const personal = () => readConfig().profiles.find((p: { id: string }) => p.id === 'personal');
    assert.deepEqual(personal().workflow.statuses, exported.workflow.statuses);
    assert.equal('taskLookup' in personal(), false);
    // Personal goes back to no workflow for the rest of the run.
    await page.eval(`document.querySelector('dialog[open] [data-edit-tab=workflow]').click()`);
    await page.waitFor(`!!document.querySelector('[data-workflow-editor=profile]')`, 'Workflow');
    await page.eval(
      `[...document.querySelectorAll('[data-workflow-editor=profile] label')].find((l) => l.textContent.includes('Read a workflow status')).querySelector('input').click()`,
    );
    await clickButtonText(page, 'Save workflow', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Personal without a workflow');
    assert.equal('workflow' in personal(), false);

    // Set up from my skills (spec §13.10): a profile without workspaces that
    // have a status file is told to start a task first.
    await openEditProfile('Personal', 'workflow');
    await page.waitFor(
      `document.querySelector('[data-setup-blocked]')?.dataset.setupBlocked === 'no-status-file'`,
      'no status file yet',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile closed');
    // Work: Claude (the fake) reads the skill source and the linked
    // workspace's worktree, read-only, and its proposal fills the form.
    fs.writeFileSync(
      path.join(fx.root, 'proposal.json'),
      `${JSON.stringify({
        type: 'result',
        is_error: false,
        result: '',
        structured_output: {
          file: 'docs/specs/*/specification.md',
          matchField: 'branch',
          matchEquals: 'branch',
          statusField: 'status',
          idField: null,
          titleField: null,
          documentLabel: 'Spec',
          statuses: [
            { value: 'draft', label: 'Draft', kind: 'step' },
            {
              value: 'spec-review',
              label: 'Spec review',
              kind: 'gate',
              hint: 'Approve the spec',
              answerLabel: 'Approve',
              answerPrompt: 'Approved.',
            },
            { value: 'building', label: 'Building', kind: 'step' },
            { value: 'done', label: 'Done', kind: 'final' },
          ],
          startPrompt: '/team:review {id} {title}',
          continuePrompt: '/team:review continue {id}',
          lookupTool: 'mcp__tracker__get_issue',
          undetermined: ["Whether building is a gate: the skill doesn't say."],
        },
      })}\n`,
    );
    await openEditProfile('Work', 'workflow');
    // With a workflow already, it starts folded.
    await page.waitFor(
      `document.querySelector('[data-setup-from-skills]')?.dataset.setupFromSkills === 'closed'`,
      'Set up from my skills…',
    );
    await clickButtonText(
      page,
      'Set up from my skills…',
      'document.querySelector("[data-workflow-editor=profile]")',
    );
    await page.waitFor(`!!document.querySelector('#setup-workspace')`, 'the setup panel');
    assert.match(
      await page.eval<string>(
        `[...document.querySelector('#setup-workspace').options].map((o) => o.textContent).join('|')`,
      ),
      /Linked cart · docs\/specs\/cart\/specification\.md/,
    );
    await page.eval(`(() => {
      const select = document.querySelector('#setup-workspace');
      const option = [...select.options].find((o) => o.textContent.includes('Linked cart'));
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await typeInField(page, '#setup-model', 'haiku', false);
    await clickButtonText(
      page,
      'Propose a workflow',
      'document.querySelector("[data-setup-from-skills]")',
    );
    await page.waitFor(
      `!!document.querySelector('[data-draft-notice] [data-undetermined]')`,
      'the proposal',
    );
    const notice = await page.eval<string>(
      `document.querySelector('[data-draft-notice]').innerText`,
    );
    assert.match(notice, /Filled in from team-plugin and docs\/specs\/cart\/specification\.md in /);
    assert.match(notice, /Spec review: hint "Review and approve the spec" → "Approve the spec"/);
    assert.match(
      notice,
      /Couldn't determine:\n+Whether building is a gate: the skill doesn't say\./,
    );
    assert.match(
      notice,
      /Also set up the task lookup: ask Claude, with mcp__tracker__get_issue \(replaces your current task lookup\)/,
    );
    // The current task lookup is kept unless ticked.
    assert.equal(
      await page.eval(`document.querySelector('[data-take-lookup] input').checked`),
      false,
    );
    assert.equal(
      await page.eval(`document.querySelector('#wf-start').value`),
      '/team:review {id} {title}',
    );
    const proposalArgs = fs
      .readFileSync(path.join(fx.root, 'claude-proposal-args.txt'), 'utf8')
      .trimEnd()
      .split('\n');
    const argAfter = (flag: string) => proposalArgs[proposalArgs.indexOf(flag) + 1];
    assert.equal(argAfter('--add-dir'), teamPlugin);
    assert.equal(argAfter('--permission-mode'), 'dontAsk');
    assert.equal(argAfter('--model'), 'haiku');
    assert.deepEqual(JSON.parse(argAfter('--settings') as string).permissions.deny, [
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Task',
      'Agent',
      'Skill',
    ]);
    for (const flag of ['--allowedTools', '--plugin-dir']) {
      assert.equal(proposalArgs.includes(flag), false, flag);
    }
    assert.match(proposalArgs.join('\n'), /connectors: tracker\./);
    assert.equal(
      fs.realpathSync(
        fs.readFileSync(path.join(fx.root, 'claude-proposal-cwd.txt'), 'utf8').trim(),
      ),
      fs.realpathSync(linkedTree),
    );
    // The preview shows the workspace it read; nothing is saved yet.
    await page.waitFor(
      `document.querySelector('[data-preview-result]')?.textContent.startsWith('Status ')`,
      'the preview of the proposal',
    );
    await screenshot(page, screenshotDir, '14d4-workflow-proposal.png');
    assert.equal(readConfig().profiles[0].workflow.startPrompt, 'Plan {id}: {title}.');
    assert.equal(readConfig().profiles[0].taskLookup.kind, 'command');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile closed');
    await page.waitFor(
      `document.querySelector('[data-step-current]')?.dataset.stepCurrent === 'draft'`,
      'the stepper',
    );
    // Every status named while they fit; measured, so a narrow header
    // collapses them to ✓ or numbers, then to one pill (spec §13.5).
    const fit = `document.querySelector('[data-stepper-fit]')`;
    assert.equal(
      await page.eval(
        `${fit}.dataset.stepperFit + '|' + document.querySelector('[data-stepper]').textContent`,
      ),
      'full|Draft›◆Spec review›Building›Done',
    );
    await page.eval(`${fit}.style.maxWidth = '120px'`);
    await page.waitFor(`${fit}.dataset.stepperFit === 'collapsed'`, 'the collapsed stepper');
    assert.equal(
      await page.eval(`document.querySelector('[data-stepper]').textContent`),
      'Draft›2◆›3›4',
    );
    await page.eval(`${fit}.style.maxWidth = '30px'`);
    await page.waitFor(`${fit}.dataset.stepperFit === 'pill'`, 'the stepper as one pill');
    await page.eval(`${fit}.style.maxWidth = ''`);
    await page.waitFor(`${fit}.dataset.stepperFit === 'full'`, 'the full stepper again');
    const linkedRow = `document.querySelector('nav button[title^="PROJ-8 Linked cart"]')`;
    assert.equal(
      await page.eval(`${linkedRow}.querySelector('[data-workflow-label]')?.textContent`),
      'Draft',
    );

    const alertsBefore = (await notifications()).length;
    await typeInTerminal(page, 'prompt');
    await page.waitFor(`!!${linkedRow}.querySelector('[aria-label=Working]')`, 'Working');
    specFile('spec-review');
    await page.waitFor(
      `document.querySelector('[data-step-current]')?.dataset.stepCurrent === 'spec-review'`,
      'the gate in the stepper',
    );
    // A focused window showing this Claude tab gets no notification (spec §10.3).
    await mainProcess.eval(
      `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].blur()`,
    );
    await typeInTerminal(page, 'stop');
    await page.waitFor(
      `!!${linkedRow}.querySelector('[aria-label="Awaiting approval"]') && ${linkedRow}.innerText.includes('Spec review')`,
      'Awaiting approval at the gate',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[aria-label="Select Work"]').textContent`),
      /^Work1(⌘|Ctrl\+)1$/,
      'the tab badge counts the gate',
    );
    const gateAlerts = (await notifications()).slice(alertsBefore).map((n) => n.title);
    assert.deepEqual(gateAlerts, ['[Work] PROJ-8 waits for you: Review and approve the spec']);

    // The spec view (spec §13.8): Review at the gate opens the status file,
    // rendered and sanitized; images only from the worktree; live updates.
    fs.writeFileSync(
      path.join(path.dirname(specPath), 'flow.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    specFile(
      'spec-review',
      [
        '# Cart',
        '',
        'See [the ticket](https://tracker.example.com/PROJ-8) and [design](#design).',
        '',
        '![flow](flow.png) ![remote](https://example.com/x.png)',
        '',
        '<script>window.specXss = 1</script>',
        '<img src="x" onerror="window.specXss = 2">',
        '[bad](javascript:window.specXss=3)',
        '',
        '## Design',
        '',
        'Text.',
        '',
      ].join('\n'),
    );
    await page.waitFor(`!!document.querySelector('[data-review]')`, 'Review at the gate');
    await page.eval(`document.querySelector('[data-review]').click()`);
    const specBody = `document.querySelector('[data-spec-body]')`;
    await page.waitFor(
      `${specBody}?.querySelector('h1')?.textContent === 'Cart' && !!${specBody}.querySelector('img[src^="data:image/png"]')`,
      'the spec view with its image',
    );
    assert.equal(await page.eval(`document.querySelector('[data-spec-tab]').textContent`), '¶Spec');
    assert.equal(
      await page.eval(`document.querySelector('[data-spec-status]').textContent`),
      'Spec review',
    );
    assert.equal(
      await page.eval(`!!document.querySelector('[data-spec-link="ticket"]')`),
      true,
      'the ticket field as a link',
    );
    assert.deepEqual(
      await page.eval(`[
        ${specBody}.querySelectorAll('script, [onerror], a[href^="javascript"]').length,
        ${specBody}.querySelectorAll('img').length,
        ${specBody}.querySelectorAll('[data-doc-missing]').length,
        window.specXss ?? null,
      ]`),
      [0, 1, 2, null],
      'sanitized: no script or handler, one local image, the others as text',
    );
    await screenshot(page, screenshotDir, '14e-spec-view.png');
    specFile('spec-review', '# Cart\n\nUpdated by the skill.\n');
    await page.waitFor(
      `${specBody}?.innerText.includes('Updated by the skill.')`,
      'the spec view following the file',
    );
    // At a gate ⌘⇧↵ sends nothing: it leaves the spec view for the Claude
    // terminal, in focus, for the answer the gate waits for.
    await pressKey(page, 'Enter', CMD | MOD.shift);
    await page.waitFor(
      `!document.querySelector('[data-spec-view]') && document.activeElement?.classList.contains('xterm-helper-textarea')`,
      'the Claude terminal in focus',
    );
    assert.equal(fs.existsSync(path.join(fx.root, 'claude-input-11.txt')), false, 'nothing sent');
    // A gate shows its hint, Review and its answer button; never Continue.
    assert.deepEqual(
      await page.eval(`[
        document.querySelector('[data-workflow-hint]')?.textContent,
        !!document.querySelector('[data-review]'),
        document.querySelector('[data-answer]')?.textContent,
        !!document.querySelector('[data-continue]'),
      ]`),
      ['Review and approve the spec', true, 'Approve spec', false],
    );
    await screenshot(page, screenshotDir, '14e-workflow-gate.png');
    await page.eval(`document.querySelector('[data-answer]').click()`);
    const approval = /I approve the spec of PROJ-8\./;
    const typed = await waitForFile(path.join(fx.root, 'claude-input-11.txt'), { until: approval });
    assert.match(typed, approval);
    // At a step, Continue while Claude is idle.
    specFile('building');
    await page.waitFor(
      `document.querySelector('[data-step-current]')?.dataset.stepCurrent === 'building' && !!document.querySelector('[data-continue]') && !document.querySelector('[data-answer]')`,
      'Continue at a step',
    );
    await page.eval(`document.querySelector('[data-continue]').click()`);
    for (let i = 0; i < 50; i++) {
      if (
        /Continue with PROJ-8/.test(
          fs.readFileSync(path.join(fx.root, 'claude-input-11.txt'), 'utf8'),
        )
      )
        break;
      await sleep(100);
    }
    assert.match(
      fs.readFileSync(path.join(fx.root, 'claude-input-11.txt'), 'utf8'),
      /Continue with PROJ-8\. Its status is building\./,
    );
    specFile('done');
    await page.waitFor(
      `document.querySelector('[data-step-current]')?.dataset.stepCurrent === 'done' && !document.querySelector('[data-continue]')`,
      'the final status without Continue',
    );

    // Adopting a worktree made outside the app (spec §13.6): it appears in
    // the project's worktree folder, the notice offers Open as workspace with
    // the task from its branch, and the workspace deletes like any other.
    const adoptTree = path.join(path.dirname(linkedTree), 'ABC-9-adopt-me');
    fx.git(shop, 'worktree', 'add', '-q', '-b', 'ABC-9-adopt-me', adoptTree);
    // A skill's status file, without a title yet.
    const adoptSpec = path.join(adoptTree, 'docs', 'specs', 'adopt', 'specification.md');
    fs.mkdirSync(path.dirname(adoptSpec), { recursive: true });
    fs.writeFileSync(adoptSpec, '---\nbranch: ABC-9-adopt-me\nstatus: draft\n---\n');
    await page.waitFor(
      `document.querySelector('[data-app-notice]')?.innerText.includes('New worktree ABC-9-adopt-me in shop')`,
      'the new worktree notice',
      30_000,
    );
    await page.eval(`document.querySelector('[data-notice-action]').click()`);
    await page.waitFor(`!!document.querySelector('[data-adopt-dialog]')`, 'Open as workspace');
    assert.equal(await page.eval(`document.querySelector('#adopt-id').value`), 'ABC-9');
    assert.equal(await page.eval(`document.querySelector('#adopt-title').value`), 'adopt me');
    await screenshot(page, screenshotDir, '14f-adopt.png');
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'adopt me'`,
      'the adopted workspace',
    );
    assert.equal(fs.existsSync(path.join(adoptTree, BRAND.repoDirName)), false, 'nothing written');
    // Its title was only guessed from the branch: the status file's title
    // field replaces it once it has one (spec §13.5).
    fs.writeFileSync(
      adoptSpec,
      '---\nbranch: ABC-9-adopt-me\nstatus: draft\ntitle: Adopt me: from the file\n---\n',
    );
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Adopt me: from the file'`,
      'the title from the status file',
      10_000,
    );
    // Untracked files would make Delete ask more; the title stays without the file.
    fs.rmSync(path.join(adoptTree, 'docs'), { recursive: true });
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await openContextMenu(page, 'nav button[title^="ABC-9 Adopt me: from the file"]');
    await page.waitFor(`${dialogText}.includes('Delete')`, 'the delete dialog', 30_000);
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('nav button[title^="ABC-9 Adopt me"]')`,
      'deleted',
      30_000,
    );
    assert.equal(fs.existsSync(adoptTree), false, 'the adopted worktree is gone');
    await page.eval(`document.querySelector('nav button[title^="PROJ-8 Linked cart"]').click()`);
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Linked cart'`,
      'back to PROJ-8',
    );

    // Delete: a card per repository, then every worktree goes.
    await chooseFromNextContextMenu(mainProcess, 'Delete workspace…');
    await clickLabel(page, 'Workspace menu');
    await page.waitFor(
      `document.querySelectorAll('dialog[open] [data-repo-card]').length === 3`,
      'a card per repository',
      30_000,
    );
    await screenshot(page, screenshotDir, '15-linked-delete.png');
    const deleteLabel = (await page.eval<boolean>(hasButton('Delete anyway')))
      ? 'Delete anyway'
      : 'Delete';
    await clickButtonText(page, deleteLabel, 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'deleted', 30_000);
    assert.equal(fs.existsSync(linkedTree), false);
    assert.equal(fs.existsSync(apiTree), false);
    assert.equal(fs.existsSync(webTree), false);

    // A task id alone is looked up (spec §13.7). A failed lookup shows why and
    // creates nothing until Create anyway (↵), which names the branch after
    // what was typed; a found title creates the workspace with the branch from
    // it and the profile's Start prompt; no id, no Start prompt; an id the
    // lookup doesn't know is created right away, with a note.
    const runs = () => fs.readdirSync(fx.root).filter((f) => f.startsWith('claude-run-')).length;
    const submitLabel = `document.querySelector('dialog[open] button[type=submit]')?.textContent`;
    const appNotice = `(document.querySelector('[data-app-notice]')?.textContent ?? '')`;
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'FAKE-2', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `document.querySelector('dialog[open] [data-lookup-error]')?.textContent.includes("Couldn't look up FAKE-2: The lookup failed (exit 3): no task FAKE-2")`,
      'the lookup failure',
    );
    assert.match(await page.eval<string>(submitLabel), /^Create anyway/);
    assert.equal(fx.git(shop, 'branch', '--list', 'FAKE-2*').trim(), '', 'nothing created yet');
    await screenshot(page, screenshotDir, '14g-lookup-failed.png');
    const runsBeforeAnyway = runs();
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'FAKE-2'`,
      'the workspace created anyway',
      30_000,
    );
    assert.equal(
      fx.git(shop, 'branch', '--list', '--format=%(refname:short)', 'FAKE-2').trim(),
      'FAKE-2',
    );
    await claudeRun(runsBeforeAnyway);
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'FAKE-1', false);
    await sleep(600);
    const runsBefore = runs();
    await submitDialog(page);
    await page.waitFor(
      `document.querySelector('dialog[open] [data-lookup-running]')?.textContent.includes('Looking up FAKE-1')`,
      'Looking up',
    );
    await screenshot(page, screenshotDir, '14g-lookup.png');
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'Fix the fake login'`,
      'the looked-up workspace',
      30_000,
    );
    const lookedUp = await claudeRun(runsBefore);
    assert.equal(path.basename(lookedUp.split('\n')[0] as string), 'FAKE-1-fix-the-fake-login');
    assert.match(lookedUp, /^Plan FAKE-1: Fix the fake login\.$/m);
    // The app's log times the lookup and each phase of Create, up to Claude's
    // session start (spec §3.4); with Also in, a repository's phases name it.
    const appLog = path.join(path.dirname(configFile), 'app.log');
    const logged = async (pattern: RegExp) => {
      for (let i = 0; i < 100 && !pattern.test(fs.readFileSync(appLog, 'utf8')); i++)
        await sleep(100);
      assert.match(fs.readFileSync(appLog, 'utf8'), pattern);
    };
    await logged(/ create FAKE-1-fix-the-fake-login in \S+: total since Create \d+ ms$/m);
    const timings = fs.readFileSync(appLog, 'utf8');
    for (const line of [
      /Z lookup FAKE-1 \(\S+\): command \d+ ms$/m,
      /Z lookup FAKE-1 \(\S+\): found$/m,
      // The dialog asked the remote while it was open (spec §7.3).
      /Z create FAKE-1-fix-the-fake-login in \S+: git ls-remote origin \(shop\), asked earlier \d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: git fetch origin main \(shop\), asked earlier \d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: git worktree add (\(\S+\) )?\d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: Copying the \.worktreeinclude files (\(\S+\) )?\d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: Create done \d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: Claude spawned \d+ ms$/m,
      /Z create FAKE-1-fix-the-fake-login in \S+: Claude's session started \d+ ms$/m,
    ])
      assert.match(timings, line);
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'Plain experiment', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'Plain experiment'`,
      'the workspace without an id',
      30_000,
    );
    assert.doesNotMatch(
      await claudeRun(runsBefore + 1),
      /^Plan /m,
      'no Start prompt without an id',
    );
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'the dialog');
    await typeInField(page, '#ws-task', 'FAKE-404', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'FAKE-404'`,
      'the workspace for an id the lookup does not know',
      30_000,
    );
    assert.ok(
      (await page.eval<string>(appNotice)).includes(
        "FAKE-404 wasn't found; the branch is named after what you typed",
      ),
      'the note',
    );
    assert.equal(
      fx.git(shop, 'branch', '--list', '--format=%(refname:short)', 'FAKE-404').trim(),
      'FAKE-404',
    );
    await claudeRun(runsBefore + 2);

    // Looked up while typing (spec §13.7): 600 ms after an id alone, its title
    // shows under the field and ↵ uses it, without a second lookup; another
    // id cancels a lookup still running.
    const lookups = () => {
      const file = path.join(fx.root, 'lookups.txt');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
    };
    const titlePreview = `document.querySelector('dialog[open] [data-title-preview]')?.textContent`;
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the dialog for FAKE-7',
    );
    await typeInField(page, '#ws-task', 'FAKE-7', false);
    await page.waitFor(`${titlePreview} === 'Tidy the cart'`, 'the title looked up while typing');
    assert.deepEqual(
      lookups().filter((id) => id === 'FAKE-7'),
      ['FAKE-7'],
    );
    const runsBeforeTyped = runs();
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'Tidy the cart'`,
      'the workspace from the title looked up while typing',
      30_000,
    );
    assert.equal(lookups().filter((id) => id === 'FAKE-7').length, 1, 'no second lookup');
    assert.equal(
      path.basename((await claudeRun(runsBeforeTyped)).split('\n')[0] as string),
      'FAKE-7-tidy-the-cart',
    );
    // A title found before is remembered for the app's run (spec §13.7): the
    // same id again gets it without another lookup.
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the dialog for FAKE-7 again',
    );
    await typeInField(page, '#ws-task', 'FAKE-7', false);
    await page.waitFor(`${titlePreview} === 'Tidy the cart'`, 'the remembered title');
    const runsBeforeAgain = runs();
    await submitDialog(page);
    await page.waitFor(`!document.querySelector('dialog #ws-task')`, 'the second FAKE-7 workspace');
    assert.equal(
      path.basename((await claudeRun(runsBeforeAgain)).split('\n')[0] as string),
      'FAKE-7-tidy-the-cart-2',
    );
    assert.equal(lookups().filter((id) => id === 'FAKE-7').length, 1, 'remembered, not looked up');
    assert.match(
      fs.readFileSync(path.join(path.dirname(configFile), 'app.log'), 'utf8'),
      / lookup FAKE-7 \(\S+\): remembered$/m,
    );
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the dialog for SLOW-9',
    );
    await typeInField(page, '#ws-task', 'SLOW-9', false);
    await page.waitFor(`${titlePreview} === 'looking up…'`, 'the slow lookup');
    for (let i = 0; i < 50 && !lookups().includes('SLOW-9'); i++) await sleep(100);
    assert.ok(lookups().includes('SLOW-9'), 'SLOW-9 looked up while typing');
    await typeInField(page, '#ws-task', 'Something else', false);
    const appLogFile = path.join(path.dirname(configFile), 'app.log');
    for (
      let i = 0;
      i < 50 &&
      !/ lookup SLOW-9 \(\S+\): failed: Cancelled$/m.test(fs.readFileSync(appLogFile, 'utf8'));
      i++
    )
      await sleep(100);
    assert.match(
      fs.readFileSync(appLogFile, 'utf8'),
      / lookup SLOW-9 \(\S+\): failed: Cancelled$/m,
    );
    await pressKey(page, 'Escape');
    // Gone, not only closed: the app hears of Escape a moment after the browser.
    await page.waitFor(`!document.querySelector('dialog #ws-task')`, 'the dialog gone');
    // Create now (spec §13.7): while ↵ waits for the lookup, creates the
    // workspace at once without a title, the branch from the id, and stops it.
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(
      `!!document.querySelector('dialog[open] #ws-task')`,
      'the dialog for Create now',
    );
    await typeInField(page, '#ws-task', 'SLOW-9', false);
    await submitDialog(page);
    await page.waitFor(
      `document.querySelector('dialog[open] [data-lookup-running]')?.textContent.includes('Looking up SLOW-9')`,
      'Looking up SLOW-9',
    );
    const runsBeforeNow = runs();
    await clickButtonText(page, 'Create now', 'document.querySelector("dialog[open]")');
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'SLOW-9'`,
      'the workspace created now',
      30_000,
    );
    assert.equal(
      fx.git(shop, 'branch', '--list', '--format=%(refname:short)', 'SLOW-9').trim(),
      'SLOW-9',
    );
    await claudeRun(runsBeforeNow);
    for (
      let i = 0;
      i < 50 &&
      (
        fs.readFileSync(appLogFile, 'utf8').match(/ lookup SLOW-9 \(\S+\): failed: Cancelled$/gm) ??
        []
      ).length < 2;
      i++
    )
      await sleep(100);
    assert.equal(
      fs.readFileSync(appLogFile, 'utf8').match(/ lookup SLOW-9 \(\S+\): failed: Cancelled$/gm)
        ?.length,
      2,
      'the lookup stopped',
    );

    // Many linked repositories (spec §21.4): the primary chip in full, the
    // linked ones by name on one line, the rest under "+n more"; a tooltip
    // per chip, a menu per chip, a failed setup's mark.
    const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map((n) =>
      fx.localRepo(`service-${n}-backend`),
    );
    // One whose own setup fails (its repository file, spec §8.3).
    const broken = fx.localRepo('service-broken-backend');
    fs.mkdirSync(path.join(broken, BRAND.repoDirName));
    fs.writeFileSync(
      path.join(broken, BRAND.repoDirName, 'config.json'),
      JSON.stringify({ setup: ['exit 3'] }),
    );
    fx.git(broken, 'add', '.');
    fx.git(broken, 'commit', '-q', '-m', 'setup');
    for (const repo of [broken, ...many]) {
      assert.equal(outside(repo, '--profile', 'work').status, 0);
    }
    const manyNames = [broken, ...many].map((r) => path.basename(r));
    await clickLabel(page, 'New workspace in shop');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-also-in]')`, 'Also in');
    await page.eval(`(() => {
      const names = ${JSON.stringify(manyNames)};
      for (const label of document.querySelectorAll('[data-also-in] label')) {
        if (names.some((n) => label.textContent.includes(n))) label.querySelector('input').click();
      }
    })()`);
    // Also in remembers the last choice for shop (cartapi), so count what's ticked.
    const linkedCount = await page.eval<number>(
      `document.querySelectorAll('[data-also-in] input:checked').length`,
    );
    await typeInField(page, '#ws-task', 'PROJ-9 Many repos', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'Many repos'`,
      'the workspace in nine repositories',
      60_000,
    );
    const chips = `[...document.querySelectorAll('[data-repo-chips] [data-repo-chip]')]`;
    const more = `document.querySelector('[data-repo-more]')`;
    await page.waitFor(`!!${more}`, '"+n more"');
    const shownChips = await page.eval<{ ids: string[]; tops: number[]; more: string }>(`({
      ids: ${chips}.map((c) => c.dataset.repoChip),
      tops: [...${chips}, ${more}].map((c) => Math.round(c.getBoundingClientRect().top)),
      more: ${more}.textContent,
    })`);
    assert.equal(new Set(shownChips.tops).size, 1, 'one line');
    const hiddenCount = linkedCount - (shownChips.ids.length - 1);
    assert.ok(hiddenCount > 0 && shownChips.ids.length > 1, JSON.stringify(shownChips));
    assert.match(shownChips.more, new RegExp(`^\\+${hiddenCount} more`));
    // The branch only on the primary chip.
    assert.equal(
      await page.eval<number>(
        `${chips}.filter((c) => c.textContent.includes('PROJ-9-many-repos')).length`,
      ),
      1,
    );
    // The failed setup's mark, on its chip or on "+n more".
    await page.waitFor(
      `!!document.querySelector('[data-repo-chip="service-broken-backend"] [data-chip-mark=setup-failed]') || ${more}.textContent.includes('✕')`,
      "the failed setup's mark",
      30_000,
    );
    await screenshot(page, screenshotDir, '14h-many-repos.png');
    // The tooltip of a linked chip, on focus as on hover.
    const firstLinked = shownChips.ids[1] as string;
    await page.eval(`document.querySelector('[data-repo-chip="${firstLinked}"]').focus()`);
    await page.waitFor(
      `!!document.querySelector('[data-repo-tooltip="${firstLinked}"]')?.innerText`,
      'the chip tooltip',
    );
    const tooltip = await page.eval<string>(
      `document.querySelector('[data-repo-tooltip="${firstLinked}"]')?.innerText ?? ''`,
    );
    assert.match(tooltip, /^PROJ-9-many-repos ← main\n/, tooltip);
    assert.ok(tooltip.includes(firstLinked) && tooltip.includes('PROJ-9-many-repos'), tooltip);
    assert.match(tooltip, /Setup (passed or not needed|failed \(exit 3\))\nNo PR known$/, tooltip);
    // The chip's menu: New shell in it, Reveal, Show in Changes, Unlink.
    const shellTabs = () =>
      page.eval<number>(
        `[...document.querySelectorAll('[aria-label=Terminals] [role=tab]')].filter((t) => t.textContent.includes('${firstLinked}')).length`,
      );
    await chooseFromNextContextMenu(mainProcess, `New shell in ${firstLinked}`);
    await page.eval(`document.querySelector('[data-repo-chip="${firstLinked}"]').click()`);
    await page.waitFor(
      `[...document.querySelectorAll('[aria-label=Terminals] [role=tab]')].some((t) => t.textContent.includes('${firstLinked}'))`,
      'a shell in that repository',
    );
    assert.deepEqual(await mainProcess.eval('globalThis.__lastMenu'), [
      'Open in editor',
      `New shell in ${firstLinked}`,
      process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder',
      'Show in Changes',
      `Unlink ${firstLinked}…`,
    ]);
    assert.equal(await shellTabs(), 1);
    await mainProcess.eval(`(() => {
      const { shell } = process.mainModule.require('electron');
      globalThis.__revealed = [];
      shell.showItemInFolder = (p) => globalThis.__revealed.push(p);
    })()`);
    await chooseFromNextContextMenu(
      mainProcess,
      process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder',
    );
    await page.eval(`document.querySelector('[data-repo-chip="${firstLinked}"]').click()`);
    await mainProcess.waitFor('globalThis.__revealed.length === 1', 'Reveal in Finder');
    assert.equal(
      path.basename(
        path.dirname((await mainProcess.eval<string[]>('globalThis.__revealed'))[0] as string),
      ),
      firstLinked,
    );
    await chooseFromNextContextMenu(mainProcess, 'Show in Changes');
    await page.eval(`document.querySelector('[data-repo-chip="${firstLinked}"]').click()`);
    await page.waitFor(
      `!!document.querySelector('[data-changes-panel] [data-changes-repo="${firstLinked}"]')`,
      'its section in the Changes panel',
    );
    await clickLabel(page, 'Close changes');
    // "+n more" lists the rest; choosing one opens its menu.
    const lastHidden = path.basename(many.at(-1) as string);
    await mainProcess.eval(`(() => {
      const { Menu } = process.mainModule.require('electron');
      const popup = Menu.prototype.popup;
      const answers = [(label) => label.startsWith(${JSON.stringify(lastHidden)}), (label) => label === ${JSON.stringify(`Unlink ${lastHidden}…`)}];
      globalThis.__menus = [];
      Menu.prototype.popup = function (options) {
        const answer = answers.shift();
        if (answers.length === 0) Menu.prototype.popup = popup;
        globalThis.__menus.push(this.items.map((item) => item.label));
        this.items.find((item) => answer(item.label))?.click();
        options?.callback?.();
      };
    })()`);
    await page.eval(`${more}.click()`);
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-repo-card=${lastHidden}]')`,
      'Unlink from the "+n more" list',
      30_000,
    );
    const moreMenus = await mainProcess.eval<string[][]>('globalThis.__menus');
    assert.equal(moreMenus[0]?.length, hiddenCount, 'the hidden ones');
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Unlink cancelled');

    // Open in editor (spec §6.13): the first ⌘E asks for an editor, saved to
    // the profile; a project can use its own (IntelliJ IDEA for cartapi); the
    // chip menu, Open all with VS Code folders in one window and a question
    // above three windows, the Changes panel at a file's line, the project
    // view, and a plain error for a command that isn't there.
    const savedConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const selectValue = (selector: string, value: string) =>
      page.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(select, ${JSON.stringify(value)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    const manyTree = (name: string) =>
      page.eval<string>(`document.querySelector('[data-repo-chip="${name}"]')?.title ?? ''`);
    const shopTree9 = await manyTree('shop');
    assert.match(shopTree9, /PROJ-9-many-repos$/);
    await pressShortcut(page, 'openInEditor');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-choose-editor]')`,
      'Choose an editor',
    );
    await selectValue('dialog[open] [data-choose-editor] select', 'vscode');
    await clickButtonText(page, 'Save and open', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'the editor chosen');
    await waitForFile(path.join(fx.root, 'editor-code.log'));
    assert.deepEqual(editorCalls('code'), [[shopTree9]]);
    assert.deepEqual(savedConfig().profiles.find((p: { id: string }) => p.id === 'work').editor, {
      kind: 'vscode',
    });
    // cartapi, service-alpha and service-bravo use IntelliJ IDEA (their Setup tab).
    const projectEditor = async (name: string, value: string, saved = true) => {
      await clickProject(page, name);
      await page.waitFor(`!!document.querySelector('[data-project-tab=setup]')`, `${name}'s tabs`);
      await page.eval(`document.querySelector('[data-project-tab=setup]').click()`);
      await page.waitFor(
        `!!document.querySelector('[data-project-editor] select')`,
        'the Editor field',
      );
      await page.waitFor(
        `[...document.querySelectorAll('[data-project-editor] option')].some((o) => o.value === 'idea')`,
        'IntelliJ IDEA found',
      );
      await selectValue('[data-project-editor] select', value);
      if (!saved) return;
      await page.waitFor(
        `document.querySelector('[data-project-editor]').innerText.includes('Saved')`,
        `${name} saved`,
      );
    };
    for (const name of ['cartapi', 'service-alpha-backend', 'service-bravo-backend']) {
      await projectEditor(name, 'idea');
    }
    assert.deepEqual(
      savedConfig().projects.find((p: { name: string }) => p.name === 'cartapi').editor,
      { kind: 'idea' },
    );
    // The project view (service-bravo-backend's, the last one set): its main
    // checkout, in the project's editor.
    await clickButtonText(page, 'Open in editor');
    for (let i = 0; i < 50 && editorCalls('idea').length === 0; i++) await sleep(100);
    assert.deepEqual(editorCalls('idea'), [[many[1] as string]]);
    // Back to PROJ-9: the cartapi chip's Open in editor.
    await page.eval(`document.querySelector('nav button[title^="PROJ-9"]').click()`);
    await page.waitFor(`document.querySelector('h1')?.textContent === 'Many repos'`, 'PROJ-9');
    const cartapiTree9 = path.join(
      path.dirname(path.dirname(shopTree9)),
      'cartapi',
      'PROJ-9-many-repos',
    );
    await chooseFromNextContextMenu(mainProcess, 'Open in editor');
    await page.eval(`document.querySelector('[data-repo-chip="cartapi"]').click()`);
    for (let i = 0; i < 50 && editorCalls('idea').length < 2; i++) await sleep(100);
    assert.deepEqual(editorCalls('idea')[1], [cartapiTree9]);
    // Open all: ten repositories, three on IntelliJ IDEA, seven in one VS Code
    // window: four windows, so it asks first.
    await chooseFromNextContextMenu(mainProcess, 'Open all…');
    await clickLabel(page, 'More ways to open in editor');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-open-all]')`, 'Open all');
    await page.waitFor(
      `document.querySelectorAll('dialog[open] [data-open-all] input:checked').length === ${linkedCount + 1}`,
      'every repository ticked',
    );
    assert.match(await page.eval<string>(dialogText), /4 windows/);
    await clickButtonText(page, 'Open', 'document.querySelector("dialog[open]")');
    await page.waitFor(
      `document.querySelector('[data-open-all-confirm]')?.textContent === 'Open 4 editor windows?'`,
      'the question',
    );
    await clickButtonText(page, 'Open 4 windows', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'opened all');
    const workspaceFile = editorCalls('code').at(-1)?.[0] as string;
    assert.match(workspaceFile, /editor-workspaces\/.+-vscode\.code-workspace$/);
    const folders = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).folders.map(
      (f: { name: string }) => f.name,
    );
    assert.equal(folders.length, linkedCount + 1 - 3);
    assert.ok(folders.includes('shop') && !folders.includes('cartapi'), folders.join());
    assert.equal(editorCalls('idea').length, 2 + 3, 'one IntelliJ IDEA window each');
    // Unticked repositories stay closed; two windows don't ask.
    await chooseFromNextContextMenu(mainProcess, 'Open all…');
    await clickLabel(page, 'More ways to open in editor');
    await page.waitFor(
      `!!document.querySelector('dialog[open] [data-open-all]')`,
      'Open all again',
    );
    await page.eval(`(() => {
      for (const label of document.querySelectorAll('dialog[open] [data-open-all] label')) {
        if (/service-(alpha|bravo)-backend/.test(label.textContent)) label.querySelector('input').click();
      }
    })()`);
    await page.waitFor(`${dialogText}.includes('2 windows')`, 'two windows');
    await clickButtonText(page, 'Open', 'document.querySelector("dialog[open]")');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'opened without asking');
    assert.equal(editorCalls('idea').length, 6);
    // The Changes panel: a file at its first change, in its repository's editor.
    fs.writeFileSync(path.join(shopTree9, 'notes.txt'), '1\n2\n3\n4\n');
    fx.git(shopTree9, 'add', 'notes.txt');
    fx.git(shopTree9, 'commit', '-q', '-m', 'notes');
    fs.writeFileSync(path.join(shopTree9, 'notes.txt'), '1\n2\nthree\n4\n');
    await pressKey(page, 'KeyD', CMD | MOD.shift);
    await page.waitFor(
      `!!document.querySelector('[data-changes-repo=shop] [data-open-file="notes.txt"]')`,
      'notes.txt in the Changes panel',
      20_000,
    );
    const codeBefore = editorCalls('code').length;
    await page.eval(
      `[...document.querySelectorAll('[data-changes-repo=shop] [data-open-file="notes.txt"]')].at(-1).click()`,
    );
    for (let i = 0; i < 50 && editorCalls('code').length === codeBefore; i++) await sleep(100);
    assert.deepEqual(editorCalls('code').at(-1), ['-g', `${path.join(shopTree9, 'notes.txt')}:3`]);
    await page.eval(
      `[...document.querySelectorAll('[data-changes-repo=shop] [data-change-file="notes.txt"]')].at(-1).click()`,
    );
    await page.waitFor(`!!document.querySelector('[data-open-diff]')`, 'the diff header');
    await page.waitFor(
      `!!document.querySelector('[data-diff-editor] .monaco-diff-editor')`,
      'the diff',
    );
    await page.eval(`document.querySelector('[data-open-diff]').click()`);
    for (let i = 0; i < 50 && editorCalls('code').length === codeBefore + 1; i++) await sleep(100);
    assert.deepEqual(editorCalls('code').at(-1), ['-g', `${path.join(shopTree9, 'notes.txt')}:3`]);
    await screenshot(page, screenshotDir, '14i-open-in-editor.png');
    await clickLabel(page, 'Close changes');
    // A command that isn't there: said plainly, with the command and the setting.
    await projectEditor('service-charlie-backend', 'custom', false);
    await typeInField(page, '[data-project-editor] input', 'nothere-editor {path}', false);
    await page.waitFor(
      `document.querySelector('[data-project-editor]').innerText.includes('Saved')`,
      'the custom command saved',
    );
    await clickButtonText(page, 'Open in editor');
    await page.waitFor(
      `document.querySelector('[data-app-notice]')?.innerText.includes("Couldn't open Custom command: \`nothere-editor")`,
      'the error',
    );
    assert.match(
      await page.eval<string>(`document.querySelector('[data-app-notice]').innerText`),
      /was not found( \(.*\))?\. Check the editor in service-charlie-backend's Setup tab › Editor\./,
    );

    // Sidebar projects (spec §6.1): collapsed but for the last workspace's and
    // the ones expanded by hand; two counts; a collapsed project's status glyph.
    const sidebar = sidebarChecks(page);
    await page.eval(`document.querySelector('nav button[title^="PROJ-9"]').click()`);
    await page.waitFor(`document.querySelector('h1')?.textContent === 'Many repos'`, 'PROJ-9');
    assert.equal(await sidebar.expanded(), 'shop', 'only the open workspace’s project');
    const [shopLinked, shopOwn] = await sidebar.counts('shop');
    assert.equal(shopLinked, null);
    assert.deepEqual(shopOwn, [shopOwn?.[0], `${shopOwn?.[0]} workspaces`], 'its own workspaces');
    const linkedTitle = (n: number) =>
      n === 1
        ? 'Linked into 1 workspace of another project'
        : `Linked into ${n} workspaces of other projects`;
    const [apiLinked, apiOwn] = await sidebar.counts('cartapi');
    const linkedBefore = Number(apiLinked?.[0].replace('↗ ', ''));
    assert.ok(linkedBefore > 0, 'cartapi is linked into PROJ-9');
    assert.deepEqual(apiLinked, [`↗ ${linkedBefore}`, linkedTitle(linkedBefore)]);
    assert.equal(apiOwn, null, 'no own workspaces, no 0');
    assert.equal((await sidebar.counts('cartweb'))[1], null, 'no own workspaces, no 0');
    await sidebar.toggle('cartapi');
    await page.waitFor(`(${sidebar.expandedJs}) === 'cartapi,shop'`, 'cartapi expanded by hand');
    // A workspace in cartweb, linked into cartapi: cartweb expands, shop (open
    // only for PROJ-9) collapses, cartapi stays.
    await clickLabel(page, 'New workspace in cartweb');
    await page.waitFor(`!!document.querySelector('dialog[open] [data-also-in]')`, 'Also in');
    await page.eval(
      `[...document.querySelectorAll('[data-also-in] label')].find((l) => l.textContent.includes('cartapi')).querySelector('input').click()`,
    );
    await typeInField(page, '#ws-task', 'PROJ-10 Linked web', false);
    await sleep(600);
    await submitDialog(page);
    await page.waitFor(
      `!document.querySelector('dialog[open]') && document.querySelector('h1')?.textContent === 'Linked web'`,
      'PROJ-10',
      30_000,
    );
    await page.waitFor(`(${sidebar.expandedJs}) === 'cartapi,cartweb'`, 'shop collapsed again');
    assert.deepEqual((await sidebar.counts('cartapi'))[0], [
      `↗ ${linkedBefore + 1}`,
      linkedTitle(linkedBefore + 1),
    ]);
    assert.deepEqual((await sidebar.counts('cartweb'))[1], ['1', '1 workspace']);
    // PROJ-10 needs permission, then a linked row opens PROJ-9: its own project
    // (shop) expands, and the collapsed cartweb shows PROJ-10's glyph.
    await typeInTerminal(page, 'permission');
    // Its own row under cartweb; cartapi lists it too, as a linked row.
    const row10 = `document.querySelector('[data-project="cartweb"] ~ button[title^="PROJ-10 Linked web"]')`;
    await page.waitFor(
      `!!${row10}?.querySelector('[aria-label="Needs permission"]')`,
      'Permission',
    );
    assert.equal(await page.eval(sidebar.glyphJs('cartweb')), null, 'no glyph while expanded');
    // cartapi's Linked group (spec §6.1, §21.1) starts collapsed, with its most urgent glyph;
    // → expands it and moves into it, ← goes back to the group and collapses it.
    const group = `document.querySelector('[data-linked-group="cartapi"]')`;
    assert.equal(
      await page.eval(`${group}.querySelector('[aria-expanded]').getAttribute('aria-expanded')`),
      'false',
    );
    assert.equal(
      await page.eval(
        `document.querySelectorAll('[data-project="cartapi"] ~ [data-linked-row]').length`,
      ),
      0,
      'linked rows hidden while the group is collapsed',
    );
    assert.equal(
      await page.eval(
        `${group}.querySelector('[data-linked-glyph] [aria-label]')?.getAttribute('aria-label')`,
      ),
      'Needs permission',
    );
    await page.eval(`${group}.querySelector('[data-nav-focus]').focus()`);
    await pressKey(page, 'ArrowRight');
    await page.waitFor(
      `document.querySelectorAll('[data-project="cartapi"] ~ [data-linked-row]').length === ${linkedBefore + 1}`,
      'linked rows shown',
    );
    assert.equal(await page.eval(`!!${group}.querySelector('[data-linked-glyph]')`), false);
    await pressKey(page, 'ArrowRight');
    assert.match(String(await page.eval(navKey)), /^l:cartapi:/);
    await pressKey(page, 'ArrowLeft');
    assert.equal(await page.eval(navKey), 'g:cartapi');
    await pressKey(page, 'ArrowLeft');
    await page.waitFor(
      `document.querySelectorAll('[data-project="cartapi"] ~ [data-linked-row]').length === 0`,
      'group collapsed with ←',
    );
    await pressEnter(page);
    await page.waitFor(
      `document.querySelectorAll('[data-project="cartapi"] ~ [data-linked-row]').length > 0`,
      'group expanded with ↵',
    );
    await screenshot(page, screenshotDir, '16-linked-group.png');
    await page.eval(
      `[...document.querySelectorAll('[data-project="cartapi"] ~ [data-linked-row]')].find((b) => b.title.startsWith('PROJ-9')).click()`,
    );
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Many repos'`,
      'PROJ-9 again',
    );
    await page.waitFor(`(${sidebar.expandedJs}) === 'cartapi,shop'`, 'shop for the linked row');
    assert.deepEqual(await page.eval(sidebar.glyphJs('cartweb')), [
      'Needs permission',
      'Linked web · Needs permission',
    ]);
    await screenshot(page, screenshotDir, '16a-collapsed-glyph.png');
    // Collapsed by hand, cartapi shows it too: PROJ-10 is linked into it.
    await sidebar.toggle('cartapi');
    await page.waitFor(`(${sidebar.expandedJs}) === 'shop'`, 'cartapi collapsed');
    assert.equal((await page.eval<string[]>(sidebar.glyphJs('cartapi')))?.[0], 'Needs permission');
    // Clicking the glyph opens PROJ-10.
    await page.eval(
      `document.querySelector('[data-project="cartweb"] [data-project-glyph]').click()`,
    );
    await page.waitFor(
      `document.querySelector('h1')?.textContent === 'Linked web'`,
      'PROJ-10 again',
    );
    await page.waitFor(`(${sidebar.expandedJs}) === 'cartweb'`, 'only cartweb');
    // The keys move into a collapsed project and expand it.
    await page.eval(`(document.activeElement?.blur(), document.body.focus(), true)`);
    await pressKey(page, 'ArrowUp', MOD.alt);
    await page.waitFor(`document.querySelector('h1')?.textContent === 'Many repos'`, '⌥↑');
    await page.waitFor(`(${sidebar.expandedJs}) === 'shop'`, 'shop for ⌥↑');
    await pressKey(page, 'ArrowDown', MOD.alt);
    await page.waitFor(`(${sidebar.expandedJs}) === 'cartweb'`, 'cartweb for ⌥↓');

    // Reorder profile tabs (spec §6): drag Personal before Work; config.json
    // keeps the order and ⌘1 follows it; Move Right in the menu puts it back.
    const tabOrder = `[...document.querySelectorAll('[data-profile-tab]')].map((t) => t.dataset.profileTab).join()`;
    const savedOrder = () =>
      JSON.parse(fs.readFileSync(configFile, 'utf8'))
        .profiles.map((p: { id: string }) => p.id)
        .join();
    assert.equal(await page.eval<string>(tabOrder), 'work,personal');
    await page.eval(`(() => {
      window.__tabDrag = new DataTransfer();
      document.querySelector('[data-profile-tab=personal]').dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__tabDrag }));
    })()`);
    await sleep(100);
    await page.eval(`(() => {
      const work = document.querySelector('[data-profile-tab=work]').getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__tabDrag, clientX: work.left + 10, clientY: work.top + 10 };
      document.querySelector('[data-profile-tab=work]').dispatchEvent(new DragEvent('dragover', at));
    })()`);
    await page.waitFor(
      `getComputedStyle(document.querySelector('[data-profile-tab=work]'), '::before').width === '2px'`,
      'the drop marker',
    );
    await screenshot(page, screenshotDir, '16-tab-drag.png');
    await page.eval(`(() => {
      const work = document.querySelector('[data-profile-tab=work]').getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__tabDrag, clientX: work.left + 10, clientY: work.top + 10 };
      document.querySelector('[data-profile-tab=work]').dispatchEvent(new DragEvent('drop', at));
      document.querySelector('[data-profile-tab=personal]').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    })()`);
    await page.waitFor(`(${tabOrder}) === 'personal,work'`, 'Personal first');
    assert.equal(savedOrder(), 'personal,work');
    await clickLabel(page, 'Select Work');
    await pressKey(page, 'Digit1', CMD);
    await page.waitFor(
      `document.querySelector('[role=tab][aria-current=true]')?.getAttribute('aria-label') === 'Select Personal'`,
      '⌘1 selects Personal',
    );
    await chooseFromNextContextMenu(mainProcess, 'Move Right');
    await openContextMenu(page, '[aria-label="Select Personal"]');
    await page.waitFor(`(${tabOrder}) === 'work,personal'`, 'Work first again');
    assert.equal(savedOrder(), 'work,personal');

    page.close();
    mainProcess.close();
    // SIGTERM (a test runner, logout) quits without asking and stops the
    // sessions that still run (spec §5); no SIGKILL needed.
    const killed = await app.terminate();
    assert.equal(killed, false, 'the app quit on SIGTERM by itself');
    await assertExitedCleanly(app, 'SIGTERM');
    app = undefined;

    // After a restart (spec §6.1): only the last workspace's project is
    // expanded, showing it; then a project expanded by hand stays so too.
    const restart = async (expected: string) => {
      const running = await launchApp({ env: appEnv(), dev: devMode, electronArgs });
      app = running;
      const checks = sidebarChecks(running.page);
      await running.page.waitFor(
        `!!document.querySelector('[data-project="cartweb"] ~ button[title^="PROJ-10 Linked web"]')`,
        'the last workspace shown',
      );
      assert.equal(await checks.expanded(), expected, 'after a restart');
      // Claude was working when the app quit: the overview asks once (spec §9.7); Not now.
      const asked = await running.page
        .waitFor(`!!document.querySelector('[data-unfinished-overview]')`, 'the overview', 15_000)
        .then(
          () => true,
          () => false,
        );
      if (asked) {
        await pressKey(running.page, 'Escape');
        await running.page.waitFor(`!document.querySelector('dialog[open]')`, 'Not now');
      }
      return { running, checks };
    };
    const quit = async (running: RunningApp) => {
      running.page.close();
      running.main.close();
      // As a user quits; right after a launch the window still starts its sessions (spec §5).
      assert.equal(await running.stop(), false, 'the app quit by itself');
      app = undefined;
      await assertExitedCleanly(running, 'quit after a restart');
    };
    const afterRestart = await restart('cartweb');
    // The Changes panel's width and diff style lasted (spec §6.4), in the last workspace.
    await afterRestart.running.page.eval(
      `document.querySelector('[data-project="cartweb"] ~ button[title^="PROJ-10 Linked web"]').click()`,
    );
    await afterRestart.running.page.waitFor(
      `!!document.querySelector('[data-changes-toggle]')`,
      'the workspace',
    );
    await afterRestart.running.page.eval(`document.querySelector('[data-changes-toggle]').click()`);
    await afterRestart.running.page.waitFor(
      `Math.round(document.querySelector('[data-changes-panel]')?.getBoundingClientRect().width) === 520`,
      'the width after a restart',
    );
    assert.equal(
      await afterRestart.running.page.eval(`localStorage.getItem('changes-diff-style')`),
      'split',
      'the diff style after a restart',
    );
    // The file list's dragged height and Full view width lasted too.
    const restartedList = `document.querySelector('[data-changes-list]')`;
    await afterRestart.running.page.waitFor(
      `${restartedList}?.dataset.changesList === 'sized' && Math.round(${restartedList}.getBoundingClientRect().height) === Number(localStorage.getItem('changes-list-height'))`,
      'the list height after a restart',
    );
    await pressShortcut(afterRestart.running.page, 'changesFullView');
    await afterRestart.running.page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'true'`,
      'full view after a restart',
    );
    await afterRestart.running.page.waitFor(
      `Math.round(${restartedList}?.getBoundingClientRect().width) === 340`,
      'the column width after a restart',
    );
    await pressKey(afterRestart.running.page, 'Escape');
    await afterRestart.running.page.waitFor(
      `document.querySelector('[data-changes-panel]').dataset.full === 'false'`,
      'the side panel',
    );
    // This workspace has no changes, so no group header to click (the click
    // was checked above): collapsed as the click stores it, for the next restart.
    await afterRestart.running.page.eval(`localStorage.setItem('changes-list-collapsed', '1')`);
    await afterRestart.running.page.eval(`document.querySelector('[data-changes-toggle]').click()`);
    await afterRestart.running.page.waitFor(
      `!document.querySelector('[data-changes-panel]')`,
      'Changes closed',
    );
    await afterRestart.checks.toggle('shop');
    await afterRestart.running.page.waitFor(
      `(${afterRestart.checks.expandedJs}) === 'cartweb,shop'`,
      'shop by hand',
    );
    // Local storage reaches the disk shortly after a change.
    await sleep(1500);
    await quit(afterRestart.running);
    const again = (await restart('cartweb,shop')).running;
    // Collapsed after a restart too.
    await again.page.eval(
      `document.querySelector('[data-project="cartweb"] ~ button[title^="PROJ-10 Linked web"]').click()`,
    );
    await again.page.waitFor(`!!document.querySelector('[data-changes-toggle]')`, 'the workspace');
    await again.page.eval(`document.querySelector('[data-changes-toggle]').click()`);
    await again.page.waitFor(
      `!!document.querySelector('[data-changes-list-collapsed]')`,
      'the list collapsed after a restart',
    );
    await quit(again);
    console.log(`e2e smoke test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) {
      await screenshot(app.page, screenshotDir, 'failure.png').catch(() => {});
      const root = await app.page
        .eval<string>(`document.querySelector('#root')?.innerHTML.slice(0, 400) ?? 'no #root'`)
        .catch((e) => `unreadable: ${e}`);
      console.error(`#root: ${root}`);
      // An open dialog's text and fields, and where the focus is: what a step waited on.
      const dialog = await app.page
        .eval<string>(`(() => {
          const d = document.querySelector('dialog[open]');
          const active = document.activeElement;
          const focus = active ? active.tagName + (active.id ? '#' + active.id : '') : 'none';
          if (!d) return 'no open dialog; focus: ' + focus;
          const fields = [...d.querySelectorAll('input, textarea, select')]
            .map((f) => (f.id || f.name || f.type) + '=' + JSON.stringify(f.value)).join(' ');
          return d.innerText.replace(/\\s+/g, ' ').slice(0, 600) + '\\n  fields: ' + fields + '\\n  focus: ' + focus;
        })()`)
        .catch((e) => `unreadable: ${e}`);
      console.error(`dialog: ${dialog}`);
      if (app.page.log.length > 0)
        console.error(`console:\n  ${app.page.log.slice(-15).join('\n  ')}`);
      if (app.page.errors.length > 0) {
        console.error(`renderer errors:\n  ${app.page.errors.join('\n  ')}`);
      }
    }
    throw error;
  } finally {
    await app?.stop();
    fx.cleanup();
  }
}

main().catch((error) => {
  console.error(`e2e smoke test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
