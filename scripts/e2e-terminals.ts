/**
 * End-to-end test of switching terminals (spec §6.3, §6.8): two workspaces
 * whose Claude tabs have different prompt markers, switched back and forth
 * with the project view in between, in a wide and a narrow window and in
 * Claude's full-screen mode. After every switch the page has one terminal,
 * every prompt marker shown is that terminal's own (one of its numbers,
 * never another workspace's), and the terminal was repainted when shown.
 * In dark mode the terminal area is never white and has no broken image
 * while switching, and a lost WebGL context gives the DOM renderer at once.
 * A full-screen session with more output than the replay keeps comes back
 * from another profile still in the alternate screen, with no marks (D9).
 * Runs with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-terminals.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { SEED_CONFIG } from '../src/main/test-support/seed-config';
import {
  clickLabel,
  launchApp,
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

/** What the page shows: its terminals, and each visible prompt marker with its terminal. */
interface Shown {
  title: string | null;
  terminals: number;
  terminal: string | null;
  repaints: number;
  marks: { n: string; terminal: string | null }[];
}

const shownJs = `(() => {
  const terminals = [...document.querySelectorAll('[data-terminal]')];
  const shown = terminals.find((t) => t.offsetParent) ?? null;
  const marks = [...document.querySelectorAll('[data-prompt-mark]')]
    .filter((m) => m.style.display !== 'none' && m.offsetParent)
    .map((m) => ({ n: m.dataset.promptMark, terminal: m.closest('[data-terminal]')?.dataset.terminal ?? null }));
  return {
    title: document.querySelector('h1')?.textContent ?? null,
    terminals: terminals.length,
    terminal: shown?.dataset.terminal ?? null,
    repaints: Number(shown?.dataset.repaints ?? 0),
    marks,
  };
})()`;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const { clone: repo } = fx.cloneWithRemote('api', 'main');
    fs.writeFileSync(path.join(fx.root, '.zshrc'), '');
    // A stand-in for Claude: a line `p <text>` is a prompt (printed, then the
    // UserPromptSubmit hook, then an answer); `r <text>` a response (printed,
    // then the Stop hook); `fullscreen` and `classic` enter and leave the
    // alternate screen; `flood` prints more than the replay keeps, as Claude's
    // full-screen renderer does over time. Scripted tests never start the real one.
    const fakeClaude = path.join(fx.root, 'bin', 'fake-claude');
    fs.mkdirSync(path.dirname(fakeClaude));
    fs.writeFileSync(
      fakeClaude,
      `#!/bin/sh
case "$1" in
  --version) echo '9.9.9 (Claude Code)'; exit 0 ;;
  auth) printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}\\n' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; exit 0 ;;
esac
settings=""; prev=""
for arg in "$@"; do [ "$prev" = --settings ] && settings="$arg"; prev="$arg"; done
helper=$(sed -n "s/.*\\"command\\": \\"'\\(.*\\)' hook SessionStart\\".*/\\1/p" "$settings")
hook() { printf '%s' "$2" | "$helper" hook "$1"; }
hook SessionStart '{"session_id":"s","transcript_path":"/dev/null"}' > /dev/null
while IFS= read -r line; do
  case "$line" in
    p\\ *) t="\${line#p }"; printf '\\342\\235\\257 %s\\n' "$t"; hook UserPromptSubmit "{\\"prompt\\":\\"$t\\"}"
      i=0; while [ $i -lt 6 ]; do printf 'answer %s to %s\\n' $i "$t"; i=$((i+1)); done ;;
    r\\ *) t="\${line#r }"; printf '\\342\\217\\272 %s\\n\\n' "$t"; hook Stop "{\\"last_assistant_message\\":\\"$t\\"}" ;;
    flood) yes 'Full-screen redraw of the conversation' | head -n 60000; echo 'Flood done' ;;
    fullscreen) printf '\\033[?1049h\\033[HFull screen\\n' ;;
    classic) printf '\\033[?1049l' ;;
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

    app = await launchApp({ env: withDisplayEnv(fx.env), dev: devMode, electronArgs });
    const { page, main: mainProcess } = app;
    const setSize = (width: number, height: number) =>
      mainProcess.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setSize(${width}, ${height})`,
      );
    await setSize(1600, 1000);
    await page.waitFor(`!!document.querySelector('[aria-label="New workspace in api"]')`, 'app');

    const newWorkspace = async (task: string, prompts: string[]) => {
      await clickLabel(page, 'New workspace in api');
      await page.waitFor(`!!document.querySelector('dialog[open] #ws-task')`, 'New workspace');
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, `${task} created`);
      for (const prompt of prompts) {
        await typeInTerminal(page, `p ${prompt}`);
        await sleep(300);
      }
      if (prompts.length === 0) return;
      await page.waitFor(
        `!!document.querySelector('[data-prompt-mark="${prompts.length}"]')`,
        `${task}'s markers`,
      );
    };
    await newWorkspace('AAA-1 Alpha', ['first', 'second', 'third']);
    await newWorkspace('BBB-2 Beta', ['only']);

    const open = (title: string) =>
      page.eval(
        `[...document.querySelectorAll('nav button')].find((b) => (b.title || '').startsWith(${JSON.stringify(title)})).click()`,
      );
    const openProject = () =>
      page.eval(
        `[...document.querySelectorAll('nav li button')].find((b) => b.textContent === 'api').click()`,
      );
    const terminalOf: Record<string, string> = {};
    /**
     * Opens the workspace and checks what it shows once its terminal is
     * connected and repainted: only its own markers, with `expected` the
     * numbers it may show (all of them visible when `all`).
     */
    const check = async (title: string, name: string, expected: string[], all: boolean) => {
      await open(title);
      await page.waitFor(
        `(() => { const s = ${shownJs}; return s.title === ${JSON.stringify(name)} && s.repaints > 0 && !!document.querySelector('[data-terminal][data-connected]'); })()`,
        `${name} shown and repainted`,
      );
      // Markers are placed once the replay's lines are found, which can take
      // a while after the repaint (slower with the dev server): with `all`,
      // wait for every one; a timeout leaves the comparison below to report.
      if (all) {
        const want = JSON.stringify([...expected].sort());
        await page
          .waitFor(
            `JSON.stringify((${shownJs}).marks.map((m) => m.n).sort()) === ${JSON.stringify(want)}`,
            `${name}: all its markers`,
          )
          .catch(() => {});
      } else {
        await sleep(200);
      }
      const shown = await page.eval<Shown>(shownJs);
      assert.equal(shown.terminals, 1, `${name}: one terminal on the page`);
      terminalOf[name] ??= shown.terminal ?? '';
      assert.equal(shown.terminal, terminalOf[name], `${name}: its own session`);
      for (const mark of shown.marks) {
        assert.equal(mark.terminal, shown.terminal, `${name}: marker ${mark.n} is its own`);
        assert.ok(expected.includes(mark.n), `${name}: marker ${mark.n} is one of its numbers`);
      }
      const numbers = shown.marks.map((m) => m.n).sort();
      if (all) assert.deepEqual(numbers, expected, `${name}: all its markers`);
      return numbers;
    };

    // Wide: every marker in view. Quick switches, with the project view between.
    for (let round = 0; round < 4; round++) {
      await check('AAA-1', 'Alpha', ['1', '2', '3'], true);
      await check('BBB-2', 'Beta', ['1'], true);
      await openProject();
      await page.waitFor(`!document.querySelector('[data-terminal]')`, 'the project view');
    }
    for (let i = 0; i < 12; i++) {
      await open(i % 2 ? 'AAA-1' : 'BBB-2');
      await sleep(i % 3 ? 40 : 5);
    }
    await check('BBB-2', 'Beta', ['1'], true);
    await check('AAA-1', 'Alpha', ['1', '2', '3'], true);
    await screenshot(page, screenshotDir, 'terminals-1-wide.png');

    // Narrow: Alpha's early prompts scroll out of view; Beta still shows only its own 1.
    await setSize(820, 520);
    // Markers are placed again once the output settles after a resize (spec
    // §6.8); on Linux the window can take several resizes to get there.
    await page.waitFor(
      `(${shownJs}).marks.some((m) => m.n === '3')`,
      "Alpha's last marker after the resize",
    );
    const narrow = await check('AAA-1', 'Alpha', ['1', '2', '3'], false);
    assert.ok(narrow.includes('3'), 'the last prompt is in view');
    await check('BBB-2', 'Beta', ['1'], true);
    await check('AAA-1', 'Alpha', ['1', '2', '3'], false);
    await screenshot(page, screenshotDir, 'terminals-2-narrow.png');

    // A resize and a theme change repaint the shown terminal.
    const repaints = async () => (await page.eval<Shown>(shownJs)).repaints;
    let before = await repaints();
    await setSize(1600, 1000);
    await page.waitFor(`(${shownJs}).repaints > ${before}`, 'a repaint after the resize');
    before = await repaints();
    // The other theme than the one shown: Linux under Xvfb starts light.
    const other =
      (await page.eval<string>('document.documentElement.dataset.theme')) === 'light'
        ? 'dark'
        : 'light';
    await mainProcess.eval(
      `process.mainModule.require('electron').nativeTheme.themeSource = '${other}'`,
    );
    await page.waitFor(`(${shownJs}).repaints > ${before}`, 'a repaint after the theme change');
    await mainProcess.eval(
      `process.mainModule.require('electron').nativeTheme.themeSource = 'dark'`,
    );
    await page.waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark');

    // Never white, never a broken image (spec §6.3): every frame while
    // switching workspaces in dark mode, the terminal area has no image
    // without a loaded source, and neither it nor anything in it is white.
    await page.eval(`(() => {
      window.__terminalArea = [];
      const white = (el) => /^rgba?\\(255, 255, 255(, 1)?\\)$/.test(getComputedStyle(el).backgroundColor);
      const sample = () => {
        for (const area of document.querySelectorAll('[data-terminal]')) {
          const wrapper = area.parentElement;
          for (const img of wrapper.querySelectorAll('img')) {
            if (!img.complete || img.naturalWidth === 0) window.__terminalArea.push('an image without a loaded source');
          }
          for (const el of [wrapper, area, ...area.querySelectorAll('.xterm, .xterm-viewport, .xterm-screen, canvas')]) {
            if (white(el)) window.__terminalArea.push('white: ' + (el.className || el.tagName));
          }
        }
        if (window.__terminalArea) window.__terminalFrame = requestAnimationFrame(sample);
      };
      sample();
    })()`);
    for (let i = 0; i < 10; i++) {
      await open(i % 2 ? 'AAA-1' : 'BBB-2');
      await sleep(i % 3 ? 60 : 250);
    }
    await check('BBB-2', 'Beta', ['1'], true);
    const terminalArea = await page.eval<string[]>(
      `(() => { cancelAnimationFrame(window.__terminalFrame); const seen = window.__terminalArea; window.__terminalArea = null; return [...new Set(seen)]; })()`,
    );
    assert.deepEqual(terminalArea, [], 'the terminal area while switching in dark mode');

    // A lost WebGL context (the GPU process restarting) switches the shown
    // terminal to its DOM renderer at once, with its text, rather than after
    // xterm's 3 s wait for Chromium to restore it.
    await check('AAA-1', 'Alpha', ['1', '2', '3'], true);
    const shownTerminal = `[...document.querySelectorAll('[data-terminal]')].find((t) => t.offsetParent)`;
    if ((await page.eval<string>(`${shownTerminal}.dataset.renderer`)) === 'webgl') {
      await page.eval(`(() => {
        const canvas = [...${shownTerminal}.querySelectorAll('.xterm-screen > canvas')].find((c) => !c.className);
        canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
      })()`);
      await page.waitFor(
        `${shownTerminal}.dataset.renderer === 'dom' && ${shownTerminal}.querySelector('.xterm-rows')?.textContent.includes('answer 5 to third')`,
        'the DOM renderer with the text, at once after a lost context',
        1_000,
      );
      assert.equal(
        await page.eval(
          `[...${shownTerminal}.querySelectorAll('canvas')].filter((c) => !c.className).length`,
        ),
        0,
        'no lost canvas left',
      );
      await screenshot(page, screenshotDir, 'terminals-lost-context.png');
    }

    // Full screen in Alpha: no markers there, and Beta still shows its own.
    await check('AAA-1', 'Alpha', ['1', '2', '3'], true);
    await typeInTerminal(page, 'fullscreen');
    await page.waitFor(
      `document.querySelector('[data-terminal]')?.xterm.buffer.active.type === 'alternate'`,
      'the alternate screen',
    );
    await check('BBB-2', 'Beta', ['1'], true);
    assert.deepEqual(await check('AAA-1', 'Alpha', [], false), [], 'none in full screen');
    await screenshot(page, screenshotDir, 'terminals-3-full-screen.png');
    await typeInTerminal(page, 'classic');
    await page.waitFor(
      `document.querySelector('[data-terminal]')?.xterm.buffer.active.type === 'normal'`,
      'the normal screen',
    );
    await check('BBB-2', 'Beta', ['1'], true);
    await check('AAA-1', 'Alpha', ['1', '2', '3'], true);

    // To the Personal profile and back to Work: the shown terminal attaches again.
    const otherProfile = async () => {
      await page.eval(`document.querySelector('[data-profile-tab="personal"]').click()`);
      await page.waitFor(
        `document.querySelector('[data-profile-tab="personal"]').getAttribute('aria-selected') === 'true' && !!document.querySelector('[data-terminal][data-connected]')`,
        'the Personal profile',
      );
      await sleep(300);
      await page.eval(`document.querySelector('[data-profile-tab="work"]').click()`);
      await page.waitFor(
        `document.querySelector('[data-profile-tab="work"]').getAttribute('aria-selected') === 'true'`,
        'the Work profile',
      );
    };
    /** Each placed mark's line in the shown terminal: its kind, number and the line's text. */
    const markLinesJs = `(() => {
        const c = [...document.querySelectorAll('[data-terminal]')].find((t) => t.offsetParent);
        return c.aids.marks.filter((m) => m.marker && !m.marker.isDisposed).map((m) =>
          m.mark.kind + ' ' + c.xterm.buffer.active.getLine(m.marker.line).translateToString(true).trim());
      })()`;
    const markLines = () => page.eval<string[]>(markLinesJs);
    /** What the conversation aids show in the terminal: prompt numbers, Copy buttons, the navigator. */
    const aidsShown = `(() => {
      const visible = (s) => [...document.querySelectorAll(s)].filter((m) => m.style.display !== 'none' && m.offsetParent).length;
      return { prompts: visible('[data-prompt-mark]'), copies: visible('[data-response-mark]'), navigator: visible('[data-prompt-navigator]') };
    })()`;

    // Classic: after a switch of profiles, the marks are on their own lines.
    await otherProfile();
    await check('AAA-1', 'Alpha', ['1', '2', '3'], true);
    assert.deepEqual(
      await markLines(),
      ['prompt ❯ first', 'prompt ❯ second', 'prompt ❯ third'],
      'Alpha: each marker on its prompt',
    );

    // Full screen, with more output than the replay keeps (its ?1049h trimmed
    // off): back from another profile, the terminal is still in the alternate
    // screen and shows no prompt numbers, Copy buttons or navigator (D9).
    await newWorkspace('CCC-3 Gamma', []);
    const gammaTerminal = `[...document.querySelectorAll('[data-terminal]')].find((t) => t.offsetParent)`;
    const bufferType = `${gammaTerminal}?.xterm.buffer.active.type`;
    await typeInTerminal(page, 'fullscreen');
    await page.waitFor(`${bufferType} === 'alternate'`, 'Gamma in the alternate screen');
    await typeInTerminal(page, 'flood');
    const screenText = `(() => { const b = ${gammaTerminal}.xterm.buffer.active; let s = ''; for (let y = 0; y < b.length; y++) s += b.getLine(y).translateToString(true) + '\\n'; return s; })()`;
    await page.waitFor(`${screenText}.includes('Flood done')`, 'the flood', 60_000);
    for (const [prompt, response] of [
      ['one', 'Answer one.'],
      ['two', 'Answer two.'],
      ['three', 'Answer three.'],
    ]) {
      await typeInTerminal(page, `p ${prompt}`);
      await page.waitFor(`${screenText}.includes('answer 5 to ${prompt}')`, `prompt ${prompt}`);
      await typeInTerminal(page, `r ${response}`);
      await page.waitFor(`${screenText}.includes('⏺ ${response}')`, `response ${response}`);
    }
    await sleep(800);
    const none = { prompts: 0, copies: 0, navigator: 0 };
    assert.deepEqual(await page.eval(aidsShown), none, 'Gamma: no aids in full screen');
    for (let round = 0; round < 2; round++) {
      await otherProfile();
      await page.waitFor(
        `(() => { const t = ${gammaTerminal}; return !!t?.dataset.connected && Number(t.dataset.repaints ?? 0) > 0; })()`,
        'Gamma shown again',
      );
      await sleep(800);
      assert.equal(await page.eval(bufferType), 'alternate', 'Gamma: still the alternate screen');
      assert.deepEqual(await page.eval(aidsShown), none, 'Gamma: no aids after the switch');
      await screenshot(page, screenshotDir, `terminals-4-full-screen-switch-${round}.png`);
    }
    // Back to classic: a prompt there gets its marks on its own lines.
    await typeInTerminal(page, 'classic');
    await page.waitFor(`${bufferType} === 'normal'`, 'Gamma in the normal screen');
    await typeInTerminal(page, 'p four');
    await page.waitFor(`${screenText}.includes('answer 5 to four')`, 'prompt four');
    await typeInTerminal(page, 'r Answer four.');
    await page.waitFor(`(${aidsShown}).copies === 1`, "Gamma's Copy button");
    await otherProfile();
    await page.waitFor(`(${aidsShown}).copies === 1`, "Gamma's Copy button after the switch");
    // The marks are placed again once the replay's output settles (spec §6.8).
    const gammaLines = ['prompt ❯ four', 'response ⏺ Answer four.'];
    await page
      .waitFor(
        `JSON.stringify(${markLinesJs}) === ${JSON.stringify(JSON.stringify(gammaLines))}`,
        "Gamma's marks",
      )
      .catch(() => {});
    assert.deepEqual(await markLines(), gammaLines, 'Gamma: marks on their own lines');

    console.log(`e2e terminals test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) {
      await screenshot(app.page, screenshotDir, 'terminals-failure.png').catch(() => {});
      const shown = await app.page.eval(shownJs).catch((e) => `unreadable: ${e}`);
      console.error(`shown: ${JSON.stringify(shown)}`);
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
  console.error(`e2e terminals test failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
