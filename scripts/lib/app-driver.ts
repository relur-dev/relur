/**
 * Drives the app for scripted tests: launches it with debugging ports, talks to
 * the renderer over the Chrome DevTools Protocol and to the main process over
 * the Node inspector. Test use only; packaged builds disable both (M7).
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { envVar } from '../../src/shared/brand';
import { chordsOf, SHORTCUTS, type ShortcutId } from '../../src/shared/shortcuts';

export const appDir = path.resolve(import.meta.dirname, '..', '..');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export async function debuggerUrl(port: number, type?: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const target = list.find((t) => !type || t.type === type);
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`no debugger target on port ${port}`);
}

const SEND_TIMEOUT_MS = 30_000;

/** An exception thrown by an expression evaluated in the page, with the expression. */
export class PageException extends Error {
  constructor(details: Record<string, unknown>, expression: string) {
    const exception = details.exception as { description?: string } | undefined;
    const description = (exception?.description ?? String(details.text ?? 'exception')).split(
      '\n',
    )[0];
    super(`${description} in: ${expression.replace(/\s+/g, ' ').slice(0, 160)}`);
    this.name = 'PageException';
  }
}

export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      /** The call, with the caller's stack, for a disconnect. */
      origin: Error;
    }
  >();
  private readonly ws: WebSocket;
  private readonly opened: Promise<unknown>;

  /** Renderer exceptions and console errors, printed when a test fails. */
  readonly errors: string[] = [];
  /** Every console message, newest last, for diagnosing failures. */
  readonly log: string[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        this.pending.get(message.id)?.resolve(message);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
      } else if (message.method === 'Runtime.consoleAPICalled') {
        this.log.push(
          `${message.params.type}: ${message.params.args
            .map((a: { value?: unknown; description?: string }) => a.value ?? a.description)
            .join(' ')}`.slice(0, 300),
        );
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(
          message.params.args
            .map((a: { value?: unknown; description?: string }) => a.value ?? a.description)
            .join(' '),
        );
      }
    };
    this.opened = new Promise((resolve) => {
      this.ws.onopen = resolve;
    });
    // A crashed renderer or exited app must fail the test, not hang it.
    this.ws.onclose = () => {
      for (const { reject, origin } of this.pending.values()) {
        origin.message = `debugger disconnected during ${origin.message}`;
        reject(origin);
      }
      this.pending.clear();
    };
  }

  async send(method: string, params: Record<string, unknown> = {}) {
    await this.opened;
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    // Which call hung or was cut off, so an intermittent failure says where it was.
    const what = typeof params.expression === 'string' ? params.expression : params.type;
    const detail = what ? ` (${String(what).replace(/\s+/g, ' ').slice(0, 120)})` : '';
    const origin = new Error(`${method}${detail}`);
    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply in ${SEND_TIMEOUT_MS / 1000} s${detail}`));
      }, SEND_TIMEOUT_MS);
      const settle = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (m) => {
          settle();
          resolve(m);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
        origin,
      });
    });
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return message.result as Record<string, unknown>;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new PageException(result.exceptionDetails as Record<string, unknown>, expression);
    return (result.result as { value: T }).value;
  }

  /**
   * Waits until `expression` is truthy. An exception in it (an element that
   * isn't there yet) counts as not yet, so a page that's still rendering
   * doesn't fail the test; the last one is reported if time runs out.
   */
  async waitFor(expression: string, what = expression, timeoutMs = 10_000): Promise<void> {
    let last: PageException | null = null;
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      try {
        if (await this.eval<boolean>(expression)) return;
        last = null;
      } catch (error) {
        if (!(error instanceof PageException)) throw error;
        last = error;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last.message})` : ''}`);
  }

  close() {
    this.ws.close();
  }
}

export interface RunningApp {
  process: ChildProcess;
  page: Cdp;
  main: Cdp;
  /**
   * Quits as a user does (⌘Q on macOS, the menu's Quit elsewhere, again to
   * confirm the quit dialog), then SIGTERM and SIGKILL if it's still running
   * after 10 s each; true when it had to signal. Closes `main` first.
   */
  stop(): Promise<boolean>;
  /** SIGTERM (as at logout or from a test runner), then SIGKILL after 10 s; true when it had to kill. */
  terminate(): Promise<boolean>;
  /** Electron's main process. */
  pid: number;
  /** Connects to the window again, once a new one has opened and its UI is ready. */
  reconnect(): Promise<Cdp>;
  /** Whether the app exits by itself, without a signal, within the time. */
  exited(timeoutMs?: number): Promise<boolean>;
}

/**
 * Starts the production build in out/ (or, with `dev`, its main process and
 * preload with the renderer from `electron-vite dev --rendererOnly`, which
 * leaves out/ alone, so suites can run at once) and connects to it once the
 * UI is ready. With `visible: false` (the default)
 * the app keeps its window away from the real mouse and keyboard
 * (`testWindows` in src/main/window.ts): input comes only from here.
 */
/** The renderer's dev server port for every launch in this process (one suite). */
let devRendererPort: number | undefined;

export async function launchApp(options: {
  env: Record<string, string>;
  dev?: boolean;
  visible?: boolean;
  electronArgs?: string[];
}): Promise<RunningApp> {
  const [cdpPort, inspectPort] = [await freePort(), await freePort()];
  const debugArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--inspect=${inspectPort}`,
    // An unfocused or covered window must keep rendering at full speed.
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    // Linux: X gives a window off every screen (the test window's place) a
    // vsync of one frame a second; input and transitions wait for frames.
    ...(process.platform === 'linux' ? ['--disable-frame-rate-limit'] : []),
  ];
  // E2E_VISIBLE=1 shows test windows normally, for debugging the tests themselves.
  const visible = options.visible || process.env.E2E_VISIBLE === '1';
  const shown = visible ? options.env : { ...options.env, [envVar('TEST_WINDOW')]: 'background' };
  // The dev server's port is the window's origin, and so where its local
  // storage lives: every launch of this suite uses the same one, or a restart
  // would find nothing it remembered (suites running at once take each other's).
  if (options.dev) devRendererPort ??= await freePort();
  const env = options.dev
    ? { ...shown, [envVar('DEV_RENDERER_PORT')]: String(devRendererPort) }
    : shown;
  const extra = options.electronArgs ?? [];
  const bin = (name: string) => path.join(appDir, 'node_modules', '.bin', name);
  const child = options.dev
    ? spawn(bin('electron-vite'), ['dev', '--rendererOnly', '--', ...debugArgs, ...extra], {
        cwd: appDir,
        // The given PATH stays (the onboarding test leaves out every claude); electron-vite needs node on it.
        env: { ...env, PATH: env.PATH || process.env.PATH || '' },
        // Vite reports dependency re-optimisation and page reloads on stdout.
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      })
    : spawn(bin('electron'), ['.', ...debugArgs, ...extra], {
        cwd: appDir,
        env,
        stdio: ['ignore', 'ignore', 'inherit'],
        detached: true,
      });
  // In dev mode the child is electron-vite; Electron's own pid comes from its inspector.
  let electronPid: number | undefined;
  const alive = (pid: number | undefined) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (pid: number | undefined, sig: NodeJS.Signals) => {
    if (!pid) return;
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  // Quitting stops the app's sessions first, so give it time, then kill what
  // is left. Resolves to true when it had to kill. SIGTERM goes to Electron's
  // main process first, as `kill <pid>` does, and to the process group (dev
  // mode's electron-vite) only once it's gone: on Linux, with Chromium's
  // sandbox on, a zygote killed alongside it can't be replaced and the app
  // aborts before it saves the window's local storage.
  const gone = async (timeoutMs: number) => {
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      if (!alive(electronPid)) return true;
      await sleep(100);
    }
    return false;
  };
  // ⌘Q, the app menu's Quit, the Dock's Quit and logout send Cocoa's
  // terminate: on macOS; elsewhere the menu's Quit calls app.quit. Sent from a
  // connection of its own: an attached inspector keeps the app from exiting.
  const quitOnce = async () => {
    try {
      const main = new Cdp(await debuggerUrl(inspectPort));
      await main.eval(
        process.platform === 'darwin'
          ? `void setTimeout(() => process.mainModule.require('electron').Menu.sendActionToFirstResponder('terminate:'))`
          : `void setTimeout(() => process.mainModule.require('electron').app.quit())`,
      );
      main.close();
    } catch {
      // already quitting
    }
  };
  /** The suite's own connection to the main process (`main`), once there is one. */
  let attached: Cdp | null = null;
  const stop = async () => {
    // Node waits at exit for an attached inspector ("Waiting for the debugger
    // to disconnect"): with it attached the app never ends by itself.
    attached?.close();
    attached = null;
    if (alive(electronPid)) {
      await quitOnce();
      // While sessions run, the quit dialog asks; quitting again confirms it
      // (components.md: ⌘Q again confirms).
      if (!(await gone(1500))) await quitOnce();
      // Electron's command line wrapper (or electron-vite) exits with it.
      if ((await gone(10_000)) && (await exited(10_000))) return false;
    }
    await terminate();
    return true;
  };
  const terminate = async () => {
    signal(electronPid ?? (child.pid && -child.pid), 'SIGTERM');
    for (const end = Date.now() + 10_000; Date.now() < end; ) {
      if (!alive(electronPid)) break;
      await sleep(100);
    }
    signal(child.pid && -child.pid, 'SIGTERM');
    for (const end = Date.now() + 10_000; Date.now() < end; ) {
      if (!alive(electronPid) && !alive(child.pid)) return false;
      await sleep(100);
    }
    signal(electronPid, 'SIGKILL');
    signal(child.pid && -child.pid, 'SIGKILL');
    await sleep(200);
    return true;
  };
  const connectPage = async () => {
    const page = new Cdp(await debuggerUrl(cdpPort, 'page'));
    await page.send('Runtime.enable');
    await page.waitFor(`!!document.querySelector('[data-app-ready]')`, 'the UI', 30_000);
    return page;
  };
  const exited = async (timeoutMs = 10_000) => {
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      if (!alive(electronPid) && !alive(child.pid)) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    const page = await connectPage();
    // The UI being ready means the main module has loaded and can be patched.
    const main = new Cdp(await debuggerUrl(inspectPort));
    await main.send('Runtime.enable');
    electronPid = await main.eval<number>('process.pid');
    attached = main;
    return {
      process: child,
      page,
      main,
      stop,
      terminate,
      pid: electronPid,
      reconnect: connectPage,
      exited,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Asserts that the production build's Electron ended with exit code 0, not by
 * a signal: Electron's command line wrapper exits with 1 when the app aborts
 * ("quit unexpectedly"). In dev mode electron-vite exits with 0 either way, so
 * there's nothing to check.
 */
export async function assertExitedCleanly(app: RunningApp, what: string): Promise<void> {
  const child = app.process;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (child.spawnfile.endsWith('electron-vite')) return;
  assert.equal(child.exitCode, 0, `${what}: the app exited cleanly, without crashing`);
}

/** Only the given environment, plus what's needed to reach the display server. */
export function withDisplayEnv(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    const value = process.env[key];
    if (value) result[key] = value;
  }
  return result;
}

/**
 * Off macOS, the window must not show Mac-only text: ⌘ ⌥ ⇧ ⌃ key symbols,
 * Finder or the Dock (spec §15.5), in its text, tooltips or labels.
 * Terminals' contents are left out: they show what the programs print.
 */
export async function assertNoMacText(page: Cdp, where: string): Promise<void> {
  if (process.platform === 'darwin') return;
  const found = await page.eval<string[]>(`(() => {
    const bad = /[⌘⌥⇧⌃]|\\bFinder\\b|(?<!Ubuntu |Dash to )\\bDock\\b/;
    const out = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (bad.test(node.textContent)) out.push(node.textContent.trim().slice(0, 80));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.xterm')) return;
      for (const name of ['title', 'aria-label', 'placeholder']) {
        const value = node.getAttribute(name);
        if (value && bad.test(value)) out.push(name + '=' + value.slice(0, 80));
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(document.body);
    return out;
  })()`);
  if (found.length > 0)
    throw new Error(`Mac-only text on ${process.platform} (${where}): ${found.join(' | ')}`);
}

export async function screenshot(page: Cdp, dir: string | undefined, name: string) {
  await assertNoMacText(page, name);
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  // Let the latest DOM changes reach the screen first.
  await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const { data } = (await page.send('Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'));
}

/**
 * Reloads the page and waits for the new one's UI. The old page stays (and
 * stays ready) for a while after Page.reload, slower in dev mode; a mark set
 * on it tells the two apart.
 */
export async function reloadPage(page: Cdp): Promise<void> {
  await page.eval('window.__beforeReload = true');
  await page.send('Page.reload');
  await page.waitFor(
    `!window.__beforeReload && !!document.querySelector('[data-app-ready]')`,
    'the UI after reload',
    30_000,
  );
}

/**
 * Waits for a file to have content, and returns it trimmed. A file written in
 * several steps (a command's output, then its exit status) can be read between
 * them: `until` waits until its trimmed text matches.
 */
export async function waitForFile(
  file: string,
  { until, timeoutMs = 10_000 }: { until?: RegExp; timeoutMs?: number } = {},
): Promise<string> {
  let text = '';
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, 'utf8').trim();
      if (text && (!until || until.test(text))) return text;
    }
    await sleep(100);
  }
  throw new Error(
    until && text
      ? `timed out waiting for ${file} to match ${until}; it has ${JSON.stringify(text)}`
      : `timed out waiting for ${file}`,
  );
}

/** ↵ as typed, with its text (a new line in a text field unless a handler takes it); `modifiers` as MOD. */
export async function pressEnter(page: Cdp, modifiers = 0): Promise<void> {
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    modifiers,
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    modifiers,
  });
}

/** CDP modifier bits for Input.dispatchKeyEvent. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
/** The platform's command modifier: ⌘ on macOS, Ctrl elsewhere. */
export const CMD = process.platform === 'darwin' ? MOD.meta : MOD.ctrl;
const KEYS: Record<string, { key: string; vk: number }> = {
  ArrowUp: { key: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', vk: 36 },
  End: { key: 'End', vk: 35 },
  Tab: { key: 'Tab', vk: 9 },
  Escape: { key: 'Escape', vk: 27 },
  Enter: { key: 'Enter', vk: 13 },
  Backspace: { key: 'Backspace', vk: 8 },
  Slash: { key: '/', vk: 191 },
  Period: { key: '.', vk: 190 },
  BracketLeft: { key: '[', vk: 219 },
  F5: { key: 'F5', vk: 116 },
};

/**
 * Presses one key with modifiers as real input (Input.dispatchKeyEvent), so it
 * goes through the focused element, xterm and the window's listeners. `code`
 * is a KeyboardEvent code: ArrowUp, Tab, KeyJ, Digit1…
 */
export async function pressKey(page: Cdp, code: string, modifiers = 0): Promise<void> {
  const known = KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  const key = known?.key ?? letter?.toLowerCase() ?? digit ?? code;
  const vk = known?.vk ?? (letter ?? digit ?? '').charCodeAt(0);
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Presses a shortcut as this platform has it (src/shared/shortcuts.ts):
 * ⌘L on macOS, Ctrl+Shift+L on Linux. `index` picks one of its chords.
 */
export async function pressShortcut(page: Cdp, id: ShortcutId, index = 0): Promise<void> {
  const mac = process.platform === 'darwin';
  const chord = chordsOf(SHORTCUTS[id], mac)[index];
  if (!chord) throw new Error(`${id} has no chord ${index}`);
  const modifiers =
    (chord.mod ? CMD : 0) |
    (chord.ctrl ? MOD.ctrl : 0) |
    (chord.alt ? MOD.alt : 0) |
    (chord.shift ? MOD.shift : 0);
  await pressKey(page, chord.code, modifiers);
}

/** Types text into the visible terminal, followed by Enter unless `enter` is false. */
export async function typeInTerminal(page: Cdp, text: string, enter = true): Promise<void> {
  // The shown, connected terminal: while tabs switch, the one leaving can
  // still be in the page, and keys sent to it would be lost.
  await page.waitFor(
    `(() => {
      const terminal = [...document.querySelectorAll('[data-terminal][data-connected]')].find((t) => t.offsetParent);
      const input = terminal?.querySelector('.xterm-helper-textarea');
      input?.focus();
      return !!input && document.activeElement === input;
    })()`,
    'the terminal',
  );
  // One key event per character, as typed. xterm ignores Input.insertText while
  // it thinks a key is down, which happens when a keyup went to another element.
  for (const char of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
  }
  if (enter) await pressEnter(page);
}

/** Home's Terminal tab (spec §6.7), with its shell connected. */
export async function showHomeTerminal(page: Cdp): Promise<void> {
  await page.waitFor(`!!document.querySelector('[data-home-tab=terminal]')`, 'Home');
  await page.eval(`document.querySelector('[data-home-tab=terminal]').click()`);
  await page.waitFor(
    `[...document.querySelectorAll('[data-terminal][data-connected]')].some((t) => t.offsetParent)`,
    'the home terminal',
  );
}

/** Replaces the text of an input field and presses Enter. */
export async function typeInField(page: Cdp, selector: string, text: string, enter = true) {
  await page.eval(
    `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`,
  );
  await page.send('Input.insertText', { text });
  if (enter) await pressEnter(page);
}

/** The open dialog's text, as an expression; parenthesized so `.includes(…)` applies to all of it. */
export const dialogText = `(document.querySelector('dialog[open]')?.innerText ?? '')`;

/** Clicks the open dialog's submit button once it is enabled. */
export async function submitDialog(page: Cdp): Promise<void> {
  const button = `document.querySelector('dialog[open] button[type=submit]')`;
  await page.waitFor(`${button} && !${button}.disabled`, 'the submit button to be enabled');
  await page.eval(`${button}.click()`);
}

/**
 * Clicks the element with this aria-label once it is there and enabled. A
 * change made outside the page (such as `add` from the command line) reaches
 * it through a subscription, a render later; on a slow machine that can be
 * after the next step's click.
 */
export async function clickLabel(page: Cdp, label: string): Promise<void> {
  const element = `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  await page.waitFor(`!!${element} && !${element}.disabled`, `"${label}"`);
  await page.eval(`${element}.click()`);
}

/** A button's label without its shortcut hint (<kbd>), as an expression on `b`. */
const buttonLabel = `[...b.childNodes].filter((n) => n.nodeName !== 'KBD').map((n) => n.textContent).join('').trim()`;

/** Whether a button with this label (shortcut hints ignored) exists, as an expression. */
export const hasButton = (text: string, scope = 'document') =>
  `[...${scope}.querySelectorAll('button')].some((b) => ${buttonLabel} === ${JSON.stringify(text)})`;

export const clickButtonText = (page: Cdp, text: string, scope = 'document') =>
  page.eval(
    `[...${scope}.querySelectorAll('button')].find((b) => ${buttonLabel} === ${JSON.stringify(text)}).click()`,
  );

/**
 * Clicks a button that closes its own window or quits the app (Close Window,
 * Quit): the click waits a tick, so the reply arrives before the page goes
 * away; otherwise a busy machine can drop it and the test sees a disconnect.
 */
export const clickClosingButton = (page: Cdp, text: string, scope = 'document') =>
  page.eval(
    `(() => { const b = [...${scope}.querySelectorAll('button')].find((b) => ${buttonLabel} === ${JSON.stringify(text)}); void setTimeout(() => b.click()); })()`,
  );

/**
 * Records the output of and input to every PTY started from now on, in
 * `globalThis.__pty` of the main process: one entry per PTY, in start order.
 */
export async function recordPtys(main: Cdp): Promise<void> {
  await main.eval(`(() => {
    // Resolved from the app's folder, so it is the instance the app loaded.
    const pty = process.mainModule.constructor.createRequire(${JSON.stringify(path.join(appDir, 'package.json'))})('node-pty');
    const spawn = pty.spawn;
    globalThis.__pty = [];
    pty.spawn = (file, args, options) => {
      const child = spawn(file, args, options);
      const record = {
        file, args, cwd: options.cwd, pid: child.pid,
        configDir: options.env?.CLAUDE_CONFIG_DIR ?? null, output: '', input: '',
      };
      globalThis.__pty.push(record);
      child.onData((data) => { record.output += data; });
      const write = child.write.bind(child);
      child.write = (data) => { record.input += data; return write(data); };
      return child;
    };
  })()`);
}

export interface PtyRecord {
  file: string;
  args: string[];
  cwd: string;
  output: string;
  input: string;
}

export const ptyRecords = (main: Cdp) => main.eval<PtyRecord[]>('globalThis.__pty');

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPES = [
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC
  `${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, // CSI
  `${ESC}[()][0-9A-Za-z]|${ESC}[78=>]`, // charset, cursor save and restore, keypad
].map((source) => new RegExp(source, 'g'));

/** Output with escape sequences removed, for matching text on screen. */
export function plainText(output: string): string {
  return ESCAPES.reduce((text, re) => text.replace(re, ''), output);
}

/**
 * Makes the next native context menu choose the item with this label, as if
 * the user had clicked it.
 */
export const chooseFromNextContextMenu = (main: Cdp, label: string) =>
  main.eval(`(() => {
    const { Menu } = process.mainModule.require('electron');
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) {
      Menu.prototype.popup = popup;
      globalThis.__lastMenu = this.items.map((item) => item.label);
      this.items.find((item) => item.label === ${JSON.stringify(label)})?.click();
      options?.callback?.();
    };
  })()`);

export const openContextMenu = (page: Cdp, selector: string) =>
  page.eval(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);

/**
 * A Board card's details (spec §6.7): opens them with the card's ⓘ, reads them
 * ("<title>\n<line>\n…\n<hint>") and closes them with Esc. `card` is an
 * expression for the card's element.
 */
export async function readCardDetails(page: Cdp, card: string): Promise<string> {
  await page.eval(`(${card}).querySelector('[data-card-info]').click()`);
  await page.waitFor(`!!document.querySelector('[data-card-details]')`, 'the card details');
  const text = await page.eval<string>(`document.querySelector('[data-card-details]').innerText`);
  await pressKey(page, 'Escape');
  await page.waitFor(`!document.querySelector('[data-card-details]')`, 'the card details closed');
  // The ⓘ has focus again: give it up, so the card folds back.
  await page.eval(`document.activeElement?.blur()`);
  return text;
}

/** Reads a card's details until they match, as their lines change while shown. */
export async function waitForCardDetails(
  page: Cdp,
  card: string,
  pattern: RegExp,
  what: string,
  timeoutMs = 10_000,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const text = await readCardDetails(page, card);
    if (pattern.test(text)) return text;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${text}`);
    await sleep(500);
  }
}
