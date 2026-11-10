/**
 * The Guide's screenshots (spec §6.12), in src/renderer/src/guide/images/:
 * `<name>-dark.webp` and `<name>-light.webp` for every `![alt](images/<name>.webp)`
 * in its pages. A believable morning of work from made-up data: a throwaway
 * home folder, generic projects (web-app, api-service, shared-ui), tickets
 * ABC-133 to ABC-160 and a stand-in for Claude
 * (scripts/guide-screenshots/fake-claude.sh). It never reads the real home
 * folder, profiles or repositories, and never starts the real Claude.
 *
 *   npm run build && npm run guide:screenshots [-- --out=<dir>] [-- --only=<name,…>]
 *
 * The window is 1280×800 at 2x (1480 wide for Home's Board); memory numbers are fixed (TEST_MEMORY), so
 * only clocks ("for 2 min") change between runs. Each file is WebP, at the
 * best quality that stays under 150 KB.
 */
import './lib/clean-env';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { envVar } from '../src/shared/brand';
import { composePrompt } from '../src/shared/notes';
import {
  type Cdp,
  CMD,
  chooseFromNextContextMenu,
  clickLabel,
  launchApp,
  MOD,
  openContextMenu,
  pressKey,
  type RunningApp,
  sleep,
  submitDialog,
  typeInField,
  withDisplayEnv,
} from './lib/app-driver';

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = path.resolve(
  arg('out') ?? path.join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'guide', 'images'),
);
const only = arg('only')?.split(',');

const WIDTH = 1280;
const HEIGHT = 800;
/** Home's Board shot is wider, so its five columns fit (scaled down like the rest). */
const BOARD_WIDTH = 1480;
/** The Guide's column is 660 px; images are shown at half their pixel size. */
const MAX_PIXEL_WIDTH = 1320;
const MAX_BYTES = 150 * 1024;
/** A minute lasts this long here, so "suspend after 10 minutes" is 10 seconds. */
const MINUTE_MS = 1000;
/** Both profiles' suspend delay, the default (spec §9.8). Written, so the
 * one-time "now suspends" notice for profiles without one never shows. */
const SUSPEND_MIN = 10;

/** The memory panel's story: about 2.4 GB, one workspace with a big dev server (MB). */
const MEMORY = {
  total: 16384,
  app: 400,
  sessions: {
    'ABC-142': { claude: 320, other: { 'node dev server': 1110, 'node MCP server': 80 } },
    'ABC-139': { claude: 260, other: { 'node MCP server': 50 } },
    'ABC-147': { claude: 130, other: { zsh: 6 } },
    'ABC-151': { claude: 120, other: { zsh: 8 } },
  },
};

// ANSI styles for the made-up conversations.
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const orange = (s: string) => `\x1b[38;5;173m${s}\x1b[39m`;
const prompt = (s: string) => `${bold('❯')} ${s}\r\n\r\n`;
const say = (s: string) => `${green('⏺')} ${s}\r\n\r\n`;
const tool = (name: string, arg: string, result: string) =>
  `${green('⏺')} ${bold(name)}(${arg})\r\n  ${dim(`⎿  ${result}`)}\r\n\r\n`;

const SCREENS: Record<string, string> = {
  'ABC-142': [
    prompt(
      'Add rate limiting to POST /login: 5 attempts per minute per IP, then 429 with a Retry-After header.',
    ),
    say("I'll start with the login route and the existing middleware."),
    tool('Read', 'src/routes/login.ts', 'Read 18 lines'),
    tool('Search', 'pattern: "rateLimit", path: "src"', 'Found 0 files'),
    say(
      "There is no rate limiter yet. I'll add a small sliding-window limiter keyed by client IP\r\n  and use it on the login route only.",
    ),
    tool('Write', 'src/middleware/rate-limit.ts', 'Wrote 16 lines to src/middleware/rate-limit.ts'),
    tool(
      'Update',
      'src/routes/login.ts',
      'Updated src/routes/login.ts with 3 additions and 1 removal',
    ),
    tool('Bash', 'npm test -- login', 'Running…'),
    `${orange('✻')} ${orange('Running the login tests…')} ${dim('(esc to interrupt)')}\r\n`,
  ].join(''),
  'ABC-139': [
    prompt('/team:plan-task ABC-139 Checkout page redesign'),
    say('Reading the ticket and the current checkout flow in web-app, api-service and shared-ui.'),
    tool('Read', 'web-app/src/pages/Checkout.tsx', 'Read 212 lines'),
    tool('Read', 'api-service/src/routes/orders.ts', 'Read 131 lines'),
    tool('Write', 'docs/specs/checkout-page-redesign/specification.md', 'Wrote 41 lines'),
    say(
      `The spec is ready for review: ${bold('docs/specs/checkout-page-redesign/specification.md')}.\r\n  Approve it, or tell me what to change.`,
    ),
  ].join(''),
  'ABC-151': [
    prompt('The DatePicker test fails about one run in ten on CI. Find out why and fix it.'),
    tool('Read', 'src/components/DatePicker.test.tsx', 'Read 88 lines'),
    say('The test builds "today" from the real clock. I\'ll freeze the clock and run it 50 times.'),
    `${bold('Bash command')}\r\n  npx vitest run DatePicker --repeat 50\r\n\r\nDo you want to proceed?\r\n${bold('❯ 1. Yes')}\r\n  2. No\r\n`,
  ].join(''),
  'ABC-147': [
    prompt('Move the colors in shared-ui to design tokens, with a dark variant for each.'),
    tool('Write', 'src/theme/tokens.css', 'Wrote 92 lines'),
    tool('Bash', 'npm test', green('42 passed')),
    say('All colors now come from tokens.css. I committed the change.'),
  ].join(''),
  'ABC-133': [
    prompt('/team:plan-task ABC-133 Upgrade the payment SDK'),
    say("Drafting the spec. The SDK's v5 changes the webhook signature check."),
  ].join(''),
};

/** Each task's conversation as Claude's transcript (Responses, and something to resume). */
const TRANSCRIPTS: Record<string, [string, string][]> = {
  'ABC-142': [
    [
      'Add rate limiting to POST /login: 5 attempts per minute per IP, then 429 with a Retry-After header.',
      [
        "Here's the plan for the login rate limit:",
        '',
        '1. **A sliding-window limiter** in `src/middleware/rate-limit.ts`, keyed by client IP, kept in memory.',
        '2. **Only on `POST /login`**, so other routes are unaffected.',
        '3. **A clear refusal:** status `429` with `Retry-After` in seconds.',
      ].join('\n'),
    ],
    [
      'Should it survive a restart or run across several instances?',
      [
        'Not with the in-memory store: each instance counts on its own, and a restart clears the counts.',
        '',
        '| Store | Shared across instances | Survives restarts |',
        '| --- | --- | --- |',
        '| In memory | No | No |',
        '| Redis | Yes | Yes |',
        '',
        'For one instance behind the load balancer, memory is enough.',
      ].join('\n'),
    ],
    [
      'Keep it in memory for now. Add tests.',
      [
        'Added `test/login-rate-limit.test.ts`:',
        '',
        '- five attempts pass, the sixth gets `429`;',
        '- `Retry-After` counts down as the window moves;',
        '- another IP is not affected.',
        '',
        'Running the login tests now.',
      ].join('\n'),
    ],
  ],
  'ABC-133': [['Upgrade the payment SDK to v5.', 'Drafting the spec now.']],
  'ABC-139': [
    ['Plan ABC-139.', 'The spec is ready for review. Approve it, or tell me what to change.'],
  ],
  'ABC-147': [['Move the colors to design tokens.', 'Done, and committed.']],
  'ABC-151': [['Fix the flaky DatePicker test.', 'Freezing the clock in the test.']],
  'ABC-136': [['Keep the focus in the search box.', 'Done: it keeps the focus after a search.']],
  'ABC-131': [['Add pagination to the table.', 'Adding a page size picker…']],
  'ABC-110': [['Warn before the session times out.', 'Done, and committed.']],
  'ABC-104': [['Retry failed webhooks with backoff.', 'Done, and committed.']],
};

const TITLES: Record<string, string> = {
  'ABC-133': 'Upgrade the payment SDK',
  'ABC-139': 'Checkout page redesign',
  'ABC-142': 'Rate limit the login endpoint',
};

const SPEC = `---
id: ABC-139
title: Checkout page redesign
branch: ABC-139-checkout-page-redesign
status: spec-review
ticket: https://tracker.example.com/browse/ABC-139
---

# Checkout page redesign

## Goal

Split checkout into three short steps and show the order total from the start.

## Steps

1. **Address** — saved addresses first, a new one below.
2. **Delivery** — options with their price and date.
3. **Payment** — the order preview, then pay.
`;

const STATUS_FILE = (id: string, title: string, branch: string, status: string) =>
  `---\nid: ${id}\ntitle: ${title}\nbranch: ${branch}\nstatus: ${status}\n---\n\n# ${title}\n`;

const LOGIN_ROUTE = `import { Router } from 'express';
import { verifyPassword } from '../auth/passwords';
import { users } from '../db';

export const login = Router();

login.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = await users.findByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, name: user.name });
});
`;

const RATE_LIMIT = `export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: () => void) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      res.set('Retry-After', String(Math.ceil((recent[0] + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts' });
    }
    hits.set(req.ip, [...recent, now]);
    next();
  };
}
`;

/**
 * What a shot covers: the window, or the box around the first match of each
 * selector with some margin; `bottom` ends it below the last match of a selector.
 */
type Region = { selectors: string[]; pad?: number; bottom?: string; below?: number } | null;

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    // Resolved (/private/var/…, not /var/…), so the app shows paths under it as ~/….
    const home = fs.realpathSync(fx.root);
    fs.writeFileSync(path.join(home, '.zshrc'), '');
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    fs.mkdirSync(path.join(home, '.claude-personal'));
    fs.writeFileSync(path.join(home, '.claude-personal', '.claude.json'), '{}');
    for (const dir of ['screens', 'transcripts']) fs.mkdirSync(path.join(home, dir));
    for (const [id, text] of Object.entries(SCREENS)) {
      fs.writeFileSync(path.join(home, 'screens', `${id}.ans`), text);
    }
    for (const [id, turns] of Object.entries(TRANSCRIPTS)) {
      const lines = turns.flatMap(([q, a], i) => [
        { type: 'user', message: { role: 'user', content: q } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: a }] },
          timestamp: `2026-10-30T09:${String(12 + i * 7).padStart(2, '0')}:00Z`,
        },
      ]);
      fs.writeFileSync(
        path.join(home, 'transcripts', `${id}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
    }
    // The stand-in, first on PATH too, so no `claude` outside the fixture is ever found.
    const bin = path.join(home, 'bin');
    const fakeClaude = path.join(bin, 'claude');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      fakeClaude,
      fs
        .readFileSync(path.join(import.meta.dirname, 'guide-screenshots', 'fake-claude.sh'), 'utf8')
        .replace('@BRANCH_VAR@', envVar('BRANCH')),
      { mode: 0o755 },
    );
    const env = { ...fx.env, HOME: home, PATH: `${bin}${path.delimiter}${fx.env.PATH}` };

    // Repositories with a little real code, so the Changes panel has a diff.
    const repo = (name: string, files: Record<string, string>) => {
      const { clone } = fx.cloneWithRemote(name, 'main');
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
        fs.writeFileSync(path.join(clone, file), text);
      }
      fx.git(clone, 'add', '.');
      fx.git(clone, 'commit', '-q', '-m', 'Project files');
      fx.git(clone, 'push', '-q', 'origin', 'main');
      return fs.realpathSync(clone);
    };
    const projects = {
      'web-app': repo('web-app', {
        'package.json': '{ "name": "web-app", "private": true }\n',
        'src/pages/Checkout.tsx': 'export function Checkout() {\n  return null;\n}\n',
      }),
      'api-service': repo('api-service', {
        'package.json': '{ "name": "api-service", "private": true }\n',
        'src/routes/login.ts': LOGIN_ROUTE,
      }),
      'shared-ui': repo('shared-ui', {
        'package.json': '{ "name": "shared-ui", "private": true }\n',
        'src/theme/colors.ts': "export const accent = '#3b82f6';\n",
      }),
    };
    const notes = fs.realpathSync(fx.localRepo('notes'));

    const configFile = path.join(
      appConfigDir({ platform: process.platform, env: {}, homeDir: home }),
      'config.json',
    );
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const claude = { command: fakeClaude, args: [] };
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: 'work',
            name: 'Work',
            color: 'blue',
            claude,
            env: {},
            defaults: { baseBranch: 'main' },
            suspendIdleMin: SUSPEND_MIN,
            workflow: {
              file: 'docs/specs/*/specification.md',
              match: { field: 'branch', equals: 'branch' },
              idField: 'id',
              titleField: 'title',
              documentLabel: 'Spec',
              statuses: [
                { value: 'draft', label: 'Draft', kind: 'step' },
                {
                  value: 'spec-review',
                  label: 'Spec review',
                  kind: 'gate',
                  hint: 'Read the spec, then approve it or say what to change',
                  answer: { label: 'Approve spec', prompt: 'I approve the spec.' },
                },
                { value: 'implementing', label: 'Implementing', kind: 'step' },
                {
                  value: 'code-review',
                  label: 'Code review',
                  kind: 'gate',
                  hint: 'Review the changes',
                  answer: { label: 'Approve changes', prompt: 'The changes look good.' },
                },
                { value: 'done', label: 'Done', kind: 'final' },
              ],
            },
            // Slow on purpose: the screenshot catches it looking up.
            taskLookup: {
              kind: 'command',
              command: 'sleep 120; echo "Single sign-on"',
              timeoutSec: 300,
            },
          },
          {
            id: 'personal',
            name: 'Personal',
            color: 'green',
            claude,
            env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' },
            defaults: { baseBranch: 'main' },
            suspendIdleMin: SUSPEND_MIN,
          },
        ],
        projects: [
          ...Object.entries(projects).map(([name, repoPath]) => ({
            id: name,
            profileId: 'work',
            name,
            repoPath,
            baseBranch: 'main',
            // The PR state of the Board's merged workspaces, from a file per
            // branch (spec §12.3); nothing for the others. In the project, so
            // Edit profile's PR fields stay empty.
            pr: { statusCommand: `cat "$HOME/pr/$${envVar('BRANCH')}" 2>/dev/null || true` },
          })),
          { id: 'notes', profileId: 'personal', name: 'notes', repoPath: notes, remote: null },
        ],
      }),
    );
    // Never the real Claude: `claude` on the app's PATH is the stand-in.
    const found = execFileSync('sh', ['-c', 'command -v claude'], { env, encoding: 'utf8' }).trim();
    if (found !== fakeClaude || !configFile.startsWith(home)) {
      throw new Error(`refusing to run: claude is ${found}, the config is ${configFile}`);
    }

    app = await launchApp({
      env: withDisplayEnv({
        ...env,
        [envVar('SUSPEND_MINUTE_MS')]: String(MINUTE_MS),
        [envVar('TEST_MEMORY')]: JSON.stringify(MEMORY),
      }),
      dev: false,
    });
    const { page, main: mainProcess } = app;
    await mainProcess.eval(
      `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(${WIDTH}, ${HEIGHT})`,
    );
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitFor(`!!document.querySelector('[data-project="api-service"]')`, 'the sidebar');
    // The question about update checks isn't part of any shot.
    const noThanks = `[...document.querySelectorAll('button')].find((b) => b.textContent === 'No thanks')`;
    await page.waitFor(`!!${noThanks}`, 'the update question');
    await page.eval(`${noThanks}.click()`);
    if (await page.eval<boolean>(`!!document.querySelector('[data-suspend-notice]')`)) {
      throw new Error('the one-time suspend notice shows: give every profile a suspendIdleMin');
    }

    const control = async (id: string, command: string) => {
      const fifo = path.join(home, 'ctl', id);
      for (let i = 0; i < 100 && !fs.existsSync(fifo); i++) await sleep(100);
      fs.writeFileSync(fifo, `${command}\n`);
      await sleep(400);
    };
    const worktreeOf = (id: string) => fs.readFileSync(path.join(home, 'runs', id), 'utf8').trim();
    const heading = (text: string) =>
      page.waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(text)}`, text);
    const rowOf = (title: string) =>
      `[...document.querySelectorAll('nav [data-nav-key^="w:"]')].find((b) => b.title.startsWith(${JSON.stringify(title)}) && !b.dataset.linkedRow)`;
    const openRow = async (title: string) => {
      await page.eval(`(${rowOf(title)}).click()`);
      await sleep(300);
    };
    // Until the profile's setup check has passed, New workspace shows the check instead.
    const openNewWorkspace = async (project: string) => {
      const open = `!!document.querySelector('dialog[open] #ws-task')`;
      for (let attempt = 0; attempt < 20; attempt++) {
        await clickLabel(page, `New workspace in ${project}`);
        for (let i = 0; i < 20 && !(await page.eval<boolean>(open)); i++) await sleep(100);
        if (await page.eval<boolean>(open)) return;
        await pressKey(page, 'Digit0', CMD);
        await sleep(500);
      }
      throw new Error(`New workspace in ${project} didn't open`);
    };
    const newWorkspace = async (project: string, task: string, alsoIn: string[] = []) => {
      await openNewWorkspace(project);
      // Exactly these: the dialog remembers a project's last choice.
      await page.eval(`(() => {
        const wanted = ${JSON.stringify(alsoIn)};
        for (const label of document.querySelectorAll('[data-also-in] label:not([data-claude-may-link])')) {
          const input = label.querySelector('input');
          const want = wanted.some((other) => label.textContent.includes(other));
          if (input && input.checked !== want) input.click();
        }
      })()`);
      await typeInField(page, '#ws-task', task, false);
      await sleep(600);
      await submitDialog(page);
      await page.waitFor(`!document.querySelector('dialog[open]')`, task, 30_000);
      const id = task.split(' ')[0] as string;
      for (let i = 0; i < 100 && !fs.existsSync(path.join(home, 'runs', id)); i++) await sleep(100);
    };
    const keepRunning = async (id: string) => {
      await chooseFromNextContextMenu(mainProcess, 'Keep Claude Running');
      await page.eval(`(${rowOf(id)}).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      await sleep(300);
    };
    const statusFile = (id: string, status: string, text?: string) => {
      const tree = worktreeOf(id);
      const branch = path.basename(tree);
      const title = TITLES[id] ?? id;
      const file = path.join(
        tree,
        'docs',
        'specs',
        branch.replace(/^[A-Z]+-\d+-/, ''),
        'specification.md',
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text ?? STATUS_FILE(id, title, branch, status));
    };

    // A morning's work: suspended, finished, waiting, asking and working tasks.
    await newWorkspace('api-service', 'ABC-133 Upgrade the payment SDK');
    statusFile('ABC-133', 'draft');
    await newWorkspace('shared-ui', 'ABC-147 Dark mode tokens');
    await keepRunning('ABC-147');
    await control('ABC-147', 'working');
    await newWorkspace('shared-ui', 'ABC-151 Fix the flaky DatePicker test');
    await keepRunning('ABC-151');
    await control('ABC-151', 'working');
    await newWorkspace('web-app', 'ABC-139 Checkout page redesign', ['api-service', 'shared-ui']);
    await keepRunning('ABC-139');
    await control('ABC-139', 'working');
    statusFile('ABC-139', 'spec-review', SPEC);
    await newWorkspace('api-service', 'ABC-142 Rate limit the login endpoint');
    await keepRunning('ABC-142');
    statusFile('ABC-142', 'implementing');
    // A hook makes the app read the status file.
    await control('ABC-142', 'stop');
    await control('ABC-142', 'working');
    await control('ABC-142', 'usage');
    // ABC-147 committed its work: ready to ship.
    const tokensTree = worktreeOf('ABC-147');
    fs.mkdirSync(path.join(tokensTree, 'src/theme'), { recursive: true });
    fs.writeFileSync(
      path.join(tokensTree, 'src/theme/tokens.css'),
      ':root { --accent: #3b82f6; }\n',
    );
    fx.git(tokensTree, 'add', '.');
    fx.git(tokensTree, 'commit', '-q', '-m', 'ABC-147 Move colors to design tokens');
    // Finished or waiting while ABC-142 is shown, so they stay unread.
    await control('ABC-147', 'stop');
    await control('ABC-139', 'stop');
    await control('ABC-151', 'permission');
    await control('ABC-133', 'stop');
    // The changes Claude made so far.
    const apiTree = worktreeOf('ABC-142');
    fs.writeFileSync(
      path.join(apiTree, 'src/routes/login.ts'),
      LOGIN_ROUTE.replace(
        "import { users } from '../db';",
        "import { users } from '../db';\nimport { rateLimit } from '../middleware/rate-limit';",
      ).replace(
        "login.post('/login', async (req, res) => {",
        "// Five attempts per minute and client, then 429 with Retry-After.\nlogin.post('/login', rateLimit({ limit: 5, windowMs: 60_000 }), async (req, res) => {",
      ),
    );
    fs.mkdirSync(path.join(apiTree, 'src/middleware'), { recursive: true });
    fs.writeFileSync(path.join(apiTree, 'src/middleware/rate-limit.ts'), RATE_LIMIT);
    // Every project of the profile expanded, so the sidebar shows the rows.
    for (const id of Object.keys(projects)) {
      const caret = `document.querySelector('[data-project="${id}"] [aria-expanded]')`;
      if ((await page.eval(`${caret}.getAttribute('aria-expanded')`)) !== 'true') {
        await page.eval(`${caret}.click()`);
        await sleep(100);
      }
    }
    await heading('Rate limit the login endpoint');
    await page.waitFor(
      `!!document.querySelector('nav [aria-label="Needs permission"]') && !!document.querySelector('nav [aria-label="Awaiting approval"]')`,
      'the sidebar states',
      20_000,
    );
    // ABC-133 is idle and not shown: suspended after its 10 "minutes".
    await page.waitFor(
      `(${rowOf('ABC-133')})?.dataset.suspended === 'true'`,
      'ABC-133 suspended',
      SUSPEND_MIN * MINUTE_MS + 30_000,
    );
    await sleep(1500);

    const shots: string[] = [];
    const shoot = async (name: string, region: Region, redraw?: () => Promise<void>) => {
      if (only && !only.includes(name)) return;
      for (const theme of ['dark', 'light'] as const) {
        await mainProcess.eval(
          `process.mainModule.require('electron').nativeTheme.themeSource = '${theme}'`,
        );
        await page.waitFor(`document.documentElement.dataset.theme === '${theme}'`, theme);
        await sleep(800);
        await redraw?.();
        const file = path.join(out, `${name}-${theme}.webp`);
        const size = await capture(page, file, region);
        shots.push(`${path.basename(file)} ${Math.round(size / 1024)} KB`);
      }
    };

    // 1. The sidebar with every state.
    await shoot('sidebar', { selectors: ['aside'], bottom: 'aside nav [data-nav-key]' });

    // 2. The Changes panel with the diff of login.ts.
    const openDiff = async () => {
      await pressKey(page, 'KeyD', CMD | MOD.shift);
      await page.waitFor(
        `!!document.querySelector('[data-change-file="src/routes/login.ts"]')`,
        'the Changes panel',
        20_000,
      );
      await page.eval(`document.querySelector('[data-change-file="src/routes/login.ts"]').click()`);
      await page.waitFor(
        `!!document.querySelector('[data-diff-editor] .monaco-diff-editor')`,
        'the diff',
        20_000,
      );
      await sleep(1500);
    };
    await openDiff();
    // The diff is opened again in each theme, so it's drawn fresh in it.
    await shoot('changes-panel', null, async () => {
      await pressKey(page, 'KeyD', CMD | MOD.shift);
      await page.waitFor(`!document.querySelector('[data-changes-panel]')`, 'the panel closed');
      await openDiff();
    });
    await pressKey(page, 'KeyD', CMD | MOD.shift);

    // 3. The Notes panel: two notes sent together while Claude works (its
    // answer then written to the transcript, so they lead to it), one queued
    // for when Claude is done, and two unsent, the first being edited.
    await pressKey(page, 'KeyK', CMD | MOD.shift);
    await page.waitFor(`!!document.querySelector('[data-notes-panel]')`, 'the Notes panel');
    const noteWith = (text: string) =>
      `[...document.querySelectorAll('[data-note]')].find((n) => (n.querySelector('[data-note-text]')?.value ?? n.querySelector('[data-note-text]')?.textContent ?? '').trim() === ${JSON.stringify(text)})`;
    const addNote = async (text: string) => {
      const count = `document.querySelectorAll('[data-notes-open] [data-note]').length`;
      const before = await page.eval<number>(count);
      await pressKey(page, 'KeyN', CMD | MOD.alt);
      await page.waitFor(
        `${count} === ${before + 1} && document.activeElement?.matches('[data-note-text]')`,
        'a new note',
      );
      await page.send('Input.insertText', { text });
      await sleep(700);
    };
    const together = [
      'Use a sliding window, not a fixed one.',
      'Keep it in memory for now; Redis later.',
    ];
    for (const text of together) await addNote(text);
    for (const text of together) {
      await page.eval(`${noteWith(text)}.querySelector('[data-note-select]').click()`);
    }
    await page.eval(`document.querySelector('[data-notes-send-selected]').click()`);
    await page.waitFor(
      `document.querySelectorAll('[data-notes-sent] [data-note]').length === 2`,
      'the two notes sent',
    );
    fs.appendFileSync(
      path.join(home, 'transcripts', 'ABC-142.jsonl'),
      `${[
        { type: 'user', message: { role: 'user', content: composePrompt(together) } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: "Switched to a sliding window over the last 60 seconds, kept in a `Map` keyed by IP. A Redis store can replace it later without changing the middleware's signature.",
              },
            ],
          },
          timestamp: new Date().toISOString(),
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    );
    await page.waitFor(
      `!${noteWith(together[0] as string)}?.querySelector('[data-note-view-response]')?.disabled`,
      'View response',
      20_000,
    );
    await addNote('When the tests pass, add a line to the PR about the 5-per-minute limit.');
    await page.eval(
      `${noteWith('When the tests pass, add a line to the PR about the 5-per-minute limit.')}.querySelector('[data-note-hold]').click()`,
    );
    await page.waitFor(`!!document.querySelector('[data-notes-queued] [data-note]')`, 'queued');
    const editing =
      "Count only failed logins? A user who mistypes once and then gets in shouldn't burn an attempt.";
    await addNote(editing);
    await addNote('Add a test for two users behind the same proxy (X-Forwarded-For).');
    await page.eval(`${noteWith(editing)}.querySelector('[data-note-text]').focus()`);
    await sleep(800);
    await shoot('notes-panel', null);
    await pressKey(page, 'KeyK', CMD | MOD.shift);
    await page.waitFor(`!document.querySelector('[data-notes-panel]')`, 'the Notes panel closed');

    // 4. The Responses panel, with the notes' entry.
    await pressKey(page, 'KeyR', CMD | MOD.shift);
    await page.waitFor(
      `document.querySelectorAll('[data-responses-panel] [data-response]').length === 4`,
      'the Responses panel',
    );
    // Entries open collapsed (spec §6.8): the first is expanded for the picture.
    await page.eval(
      `document.querySelector('[data-responses-panel] [data-response="1"] [data-response-header]').click()`,
    );
    await sleep(800);
    await shoot('responses-panel', null);
    await pressKey(page, 'KeyR', CMD | MOD.shift);

    // 5. The memory panel.
    await page.waitFor(`!!document.querySelector('footer [data-memory]')`, 'Memory', 20_000);
    const openMemory = async () => {
      if (await page.eval<boolean>(`!document.querySelector('[data-memory-panel]')`)) {
        await page.eval(`document.querySelector('footer [data-memory]').click()`);
      }
      await page.waitFor(
        `!!document.querySelector('[data-memory-panel] [data-memory-largest]')`,
        'the memory panel',
      );
      await sleep(400);
    };
    await openMemory();
    await shoot(
      'memory-panel',
      { selectors: ['[data-memory-panel]', 'footer [data-memory]'], pad: 12 },
      openMemory,
    );
    await page.eval(`document.querySelector('footer [data-memory]').click()`);
    await page.waitFor(`!document.querySelector('[data-memory-panel]')`, 'the panel to close');

    // 6. A workflow gate, and a workspace across repositories.
    await openRow('ABC-139');
    await heading('Checkout page redesign');
    await page.waitFor(`!!document.querySelector('[data-review]')`, 'the gate');
    await sleep(800);
    await shoot('workflow-gate', { selectors: ['main header'] });
    // Its chip's tooltip would show the throwaway home's full path: no hover.
    await shoot('linked-workspace', {
      selectors: ['main header h1', '[data-repo-chips]'],
      pad: 14,
      bottom: '[data-repo-chips]',
      below: 6,
    });

    // 7. The project view: its Board, and the suspended workspace's card.
    await page.eval(
      `document.querySelector('[data-project="api-service"] [data-nav-focus]').click()`,
    );
    await page.waitFor(`!!document.querySelector('main [data-suspended]')`, 'the project view');
    await page.eval('document.activeElement?.blur()');
    // Wide enough for all five columns, as Home's Board below.
    const setWidth = (width: number) =>
      mainProcess.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(${width}, ${HEIGHT})`,
      );
    await setWidth(BOARD_WIDTH);
    await sleep(800);
    await shoot('project-board', null);
    await setWidth(WIDTH);
    await shoot('suspended-workspace', {
      selectors: ['main [data-board-card]:has([data-suspended])'],
      pad: 8,
    });

    // 8. Edit profile.
    const openEdit = async () => {
      if (
        await page.eval<boolean>(`!document.querySelector('dialog[open] #edit-profile-suspend')`)
      ) {
        await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
        await openContextMenu(page, '[aria-label="Select Work"]');
        await page.waitFor(
          `!!document.querySelector('dialog[open] #edit-profile-suspend')`,
          'Edit profile',
        );
      }
      await page.eval('document.activeElement?.blur()');
      // Down to Suspend idle sessions, at its default.
      await page.eval(
        `document.querySelector('dialog[open] [data-suspend-settings]').scrollIntoView({ block: 'end' })`,
      );
      await sleep(400);
    };
    await openEdit();
    // Its lower settings, down to Suspend idle sessions: the dialog is taller than the window.
    await shoot(
      'edit-profile',
      {
        selectors: ['dialog[open] [data-sounds]', 'dialog[open] [data-suspend-settings]'],
        pad: 14,
        bottom: 'dialog[open] [data-suspend-settings]',
        below: 8,
      },
      openEdit,
    );
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'Edit profile to close');

    // 9. New workspace, looking up a task.
    await openNewWorkspace('api-service');
    await typeInField(page, '#ws-task', 'ABC-160', false);
    await sleep(400);
    await submitDialog(page);
    await page.waitFor(
      `!!document.querySelector('dialog[open]')?.textContent.replace(/\\s+/g, ' ').match(/Looking up ?ABC-160/)`,
      'the lookup',
    );
    await sleep(600);
    await shoot('new-workspace-lookup', { selectors: ['dialog[open]'], pad: 6 });
    await pressKey(page, 'Escape');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'New workspace to close');

    // 10. Home's Board, last: more of the morning, so every column has cards.
    // Idle: one finished and then suspended, one interrupted with Esc.
    await newWorkspace('web-app', 'ABC-136 Search box focus');
    await control('ABC-136', 'working');
    await control('ABC-136', 'stop');
    await newWorkspace('shared-ui', 'ABC-131 Pagination');
    await keepRunning('ABC-131');
    await control('ABC-131', 'working');
    await page.waitFor(`(${rowOf('ABC-131')})?.title.includes('Working')`, 'ABC-131 working');
    await page.waitFor(
      `(() => {
        const input = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent)?.querySelector('.xterm-helper-textarea');
        input?.focus();
        return !!input && document.activeElement === input;
      })()`,
      'the terminal of ABC-131',
    );
    await pressKey(page, 'Escape');
    await page.waitFor(
      `(${rowOf('ABC-131')})?.title.includes('Interrupted')`,
      'ABC-131 interrupted',
    );
    // Merged: committed, pushed from Home, and their pull requests merged.
    const merged = { 'ABC-110': 198, 'ABC-104': 187 };
    for (const [id, n] of Object.entries(merged)) {
      await newWorkspace(
        id === 'ABC-110' ? 'web-app' : 'api-service',
        `${id} ${id === 'ABC-110' ? 'Session timeout banner' : 'Retry failed webhooks'}`,
      );
      await keepRunning(id);
      const tree = worktreeOf(id);
      fs.writeFileSync(path.join(tree, `${id}.md`), `${id}\n`);
      fx.git(tree, 'add', '.');
      fx.git(tree, 'commit', '-q', '-m', `${id} ${n}`);
      const branch = fx.git(tree, 'branch', '--show-current').trim();
      fs.mkdirSync(path.join(home, 'pr'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'pr', branch),
        JSON.stringify({ state: 'merged', url: `https://git.example.com/acme/pull/${n}` }),
      );
      await control(id, 'working');
      await control(id, 'stop');
    }
    await pressKey(page, 'Digit0', CMD);
    for (const id of Object.keys(merged)) {
      const push = `[...document.querySelectorAll('[data-board-card]')].find((r) => r.querySelector('[data-card-info]')?.getAttribute('aria-label').startsWith('Details for ${id}'))?.querySelector('[data-home-action=push]')`;
      await page.waitFor(`!!${push}`, `Push on ${id}`, 30_000);
      await page.eval(`${push}.click()`);
    }
    await page.waitFor(
      `(${rowOf('ABC-136')})?.dataset.suspended === 'true'`,
      'ABC-136 suspended',
      SUSPEND_MIN * MINUTE_MS + 30_000,
    );
    const count = (column: string) =>
      `document.querySelector('[data-board-column=${column}] [data-board-count]')?.textContent`;
    await page.waitFor(
      `${count('idle')} === '2' && ${count('merged')} === '2'`,
      'every column with cards',
      60_000,
    );
    await page.eval('document.activeElement?.blur()');
    // Wide enough for all five columns at their 220 px minimum, beside the sidebar.
    const resize = (width: number) =>
      mainProcess.eval(
        `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(${width}, ${HEIGHT})`,
      );
    await resize(BOARD_WIDTH);
    await page.waitFor(
      `(() => { const b = document.querySelector('[data-board-column=merged]').getBoundingClientRect(); return b.right <= window.innerWidth; })()`,
      'the Merged column in view',
    );
    await sleep(800);
    await shoot('home-board', null);
    await resize(WIDTH);

    console.log(`${shots.length} screenshots in ${out}:\n  ${shots.join('\n  ')}`);
  } catch (error) {
    if (app) await capture(app.page, path.join(out, '..', 'failure.webp'), null).catch(() => {});
    throw error;
  } finally {
    await app?.stop();
    fx.cleanup();
  }
}

/**
 * Captures the window, or a region around elements, as WebP: scaled down to
 * at most MAX_PIXEL_WIDTH, at the best quality under MAX_BYTES. Returns its size.
 */
async function capture(page: Cdp, file: string, region: Region): Promise<number> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const box = await page.eval<{ x: number; y: number; width: number; height: number }>(
    region
      ? `(() => {
          const boxes = ${JSON.stringify(region.selectors)}.map((s) => {
            const e = document.querySelector(s);
            if (!e) throw new Error('nothing matches ' + s);
            return e.getBoundingClientRect();
          });
          const pad = ${region.pad ?? 0};
          const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - pad);
          const y = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad);
          const right = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + pad);
          const last = [...document.querySelectorAll(${JSON.stringify(region.bottom ?? ':not(*)')})].at(-1);
          const bottom = Math.min(
            innerHeight,
            last ? last.getBoundingClientRect().bottom + ${region.below ?? 12} : Math.max(...boxes.map((b) => b.bottom)) + pad,
          );
          return { x, y, width: right - x, height: bottom - y };
        })()`
      : `({ x: 0, y: 0, width: innerWidth, height: innerHeight })`,
  );
  const scale = Math.min(1, MAX_PIXEL_WIDTH / (box.width * 2));
  for (let quality = 90; quality >= 30; quality -= 6) {
    const { data } = (await page.send('Page.captureScreenshot', {
      format: 'webp',
      quality,
      clip: { ...box, scale },
    })) as { data: string };
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length <= MAX_BYTES || quality - 6 < 30) {
      if (bytes.length > MAX_BYTES) {
        throw new Error(`${path.basename(file)} is ${bytes.length} bytes at the lowest quality`);
      }
      fs.writeFileSync(file, bytes);
      return bytes.length;
    }
  }
  throw new Error('unreachable');
}

main().catch((error) => {
  console.error(`guide screenshots failed: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
