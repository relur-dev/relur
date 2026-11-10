import { matchShortcut } from '@shared/shortcuts';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type {
  TerminalClientMessage,
  TerminalMark,
  TerminalServerMessage,
} from '@shared/terminal-protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationAids, type NavigatorState } from '../terminal/conversation';
import { useFileDrop } from '../terminal/file-drop';
import { openTerminalPort } from '../terminal/ports';
import { isMouseReport, watchPrompt } from '../terminal/prompt-screen';
import { mouseWheelHandler } from '../terminal/wheel';
import { trpcClient } from '../trpc';
import { keyHint } from '../ui/controls';
import { ansiPalette, tokenColor } from '../ui/theme';

const isMac = navigator.userAgent.includes('Mac');

// JetBrains Mono, bundled (styles/theme.css). xterm measures its cells when it
// opens, so it must not open before the font has loaded.
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const FONT_SIZE = 12.5;
let fontsLoaded = false;
const fontsReady = Promise.all([
  document.fonts.load(`400 ${FONT_SIZE}px "JetBrains Mono"`),
  document.fonts.load(`700 ${FONT_SIZE}px "JetBrains Mono"`),
])
  .catch(() => undefined)
  .then(() => {
    fontsLoaded = true;
  });

/** Terminal colors from the theme tokens; in dark the ANSI palette stays xterm's own. */
function xtermTheme(): ITheme {
  return {
    background: tokenColor('--color-term'),
    foreground: tokenColor('--color-fg'),
    cursor: tokenColor('--color-term-cursor'),
    cursorAccent: tokenColor('--color-term'),
    selectionBackground: tokenColor('--color-term-sel'),
    ...ansiPalette(),
  };
}

function exitLine(message: Extract<TerminalServerMessage, { type: 'exit' }>): string {
  const how = message.signal ? `signal ${message.signal}` : `code ${message.exitCode ?? '?'}`;
  return `\r\n\x1b[2m[process exited with ${how}]\x1b[0m\r\n`;
}

/** Plain and OSC 8 links open in the browser through the main process (http and https only). */
const openLink = (uri: string) => void trpcClient.shell.openExternal.mutate({ url: uri });

export function TerminalView({
  sessionId,
  conversation,
  resuming = false,
  focusOnConnect = true,
  files,
  filesRequest = null,
  onFilesHandled,
}: {
  sessionId: string;
  /**
   * Takes dropped files (spec §6.16): into Claude's prompt (`claude`) or as a
   * shell's quoted paths (`shell`). Left out, a drop does nothing.
   */
  files?: 'claude' | 'shell';
  /** Files chosen with Add files, to insert as a drop would; `at` tells requests apart. */
  filesRequest?: { paths: string[]; at: number } | null;
  onFilesHandled?: () => void;
  /** Whether it takes the focus once connected; read then, so a late connection follows it. */
  focusOnConnect?: boolean;
  /**
   * A suspended Claude that resumes (spec §9.8): "Resuming…" over the
   * terminal, and keys typed meanwhile aren't sent, with a note saying so.
   */
  resuming?: boolean;
  /** A workspace's Claude tab: prompt markers, navigator and Copy buttons (spec §6.8). */
  conversation?: {
    workspaceId: string;
    onState?: (state: NavigatorState) => void;
    /** The aids while the terminal is open, for the Responses panel's scroll to (spec §6.8). */
    onAids?: (aids: ConversationAids | null) => void;
  };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const aidsRef = useRef<ConversationAids | null>(null);
  const [nav, setNav] = useState<NavigatorState>({
    count: 0,
    current: 0,
    alternate: false,
    hidden: false,
  });
  const workspaceId = conversation?.workspaceId ?? null;
  // The workspace's view follows the navigator's state (spec §6.8).
  const onState = conversation?.onState;
  useEffect(() => onState?.(nav), [nav, onState]);
  const onAids = conversation?.onAids;
  const onAidsRef = useRef(onAids);
  onAidsRef.current = onAids;
  const [fontReady, setFontReady] = useState(fontsLoaded);
  const resumingRef = useRef(resuming);
  resumingRef.current = resuming;
  const focusOnConnectRef = useRef(focusOnConnect);
  focusOnConnectRef.current = focusOnConnect;
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!resuming) setBlocked(false);
  }, [resuming]);
  useEffect(() => {
    if (!fontReady) void fontsReady.then(() => setFontReady(true));
  }, [fontReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !fontReady) return;
    const initialTheme = xtermTheme();
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: FONT_SIZE,
      fontWeight: 400,
      fontWeightBold: 700,
      // 12.5px text on 19px lines (theme.css --text-md).
      lineHeight: 1.15,
      scrollback: 10_000,
      cursorBlink: true,
      theme: initialTheme,
      // Animates mouse-wheel notches over 125 ms, as VS Code does; trackpad
      // scrolling is detected and never delayed.
      smoothScrollDuration: 125,
      // xterm's defaults: trackpads scroll pixel by pixel, Alt+wheel 5x faster.
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      // Decorations (the conversation aids, spec §6.8) are a proposed xterm API.
      allowProposedApi: true,
      // OSC 8 hyperlinks (Claude Code prints them). Without a handler xterm asks
      // with confirm() and then calls window.open, which the app blocks.
      linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(container);
    term.attachCustomWheelEventHandler(
      mouseWheelHandler(term, () => container.querySelector('.xterm-screen')?.clientHeight ?? 0),
    );
    let disposed = false;
    let webgl: WebglAddon | null = null;
    // A full redraw (spec §6.3): when the terminal is shown, after a resize,
    // after a theme change and after a lost WebGL context, every row is drawn
    // again from the buffer and the glyph atlas rebuilt, so nothing drawn
    // before (by this terminal or another) can remain. A precaution: stale
    // content was reported but not reproduced. One per frame at most.
    let repaintFrame = 0;
    const repaint = () => {
      cancelAnimationFrame(repaintFrame);
      repaintFrame = requestAnimationFrame(() => {
        if (disposed) return;
        webgl?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
        // Scripted checks count them.
        container.dataset.repaints = String(Number(container.dataset.repaints ?? 0) + 1);
      });
    };
    // A lost WebGL context (the GPU process restarting, after switching apps
    // or with too many contexts) leaves its canvas empty, or Chromium's
    // broken-image icon on white, until Chromium restores it, and xterm waits
    // 3 s for that. The terminal switches to its DOM renderer at once instead
    // (spec §6.3); the next view of it starts with WebGL again.
    const toDom = () => {
      if (!webgl) return;
      const addon = webgl;
      webgl = null;
      addon.dispose();
      container.dataset.renderer = 'dom';
      repaint();
    };
    const onContextLost = () => toDom();
    container.addEventListener('webglcontextlost', onContextLost, true);
    // The canvas the addon draws on, to free its GPU context when the view goes
    // rather than at garbage collection (Chromium keeps 16 at most).
    let glCanvas: HTMLCanvasElement | null = null;
    const releaseContext = () =>
      glCanvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(toDom);
      const before = new Set(container.querySelectorAll('canvas'));
      term.loadAddon(addon);
      glCanvas = [...container.querySelectorAll('canvas')].find((c) => !before.has(c)) ?? null;
      webgl = addon;
      container.dataset.renderer = 'webgl';
    } catch {
      // No WebGL (common in VMs): xterm keeps its DOM renderer.
      container.dataset.renderer = 'dom';
    }

    // Clipboard goes through the main process; the renderer has no clipboard permission.
    const copy = () => {
      const text = term.getSelection();
      if (text) void trpcClient.clipboard.writeText.mutate({ text });
    };
    const paste = async () => {
      const text = await trpcClient.clipboard.readText.mutate();
      if (text) term.paste(text);
    };
    // Copy and paste events come from the Edit menu (⌘C/⌘V on macOS).
    const onCopy = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      copy();
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void paste();
    };
    // For the e2e tests: the colors applied (background, cursor, ANSI red).
    const showColors = (theme: ITheme) => {
      container.dataset.colors = [theme.background, theme.cursor, theme.red ?? 'xterm'].join('|');
    };
    showColors(initialTheme);
    // Follow theme changes (<html data-theme>, set from nativeTheme and View › Appearance).
    const themeObserver = new MutationObserver(() => {
      const theme = xtermTheme();
      term.options.theme = theme;
      showColors(theme);
      repaint();
    });
    themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] });

    container.addEventListener('copy', onCopy, true);
    container.addEventListener('paste', onPaste, true);
    // Ctrl+C and Ctrl+V belong to the shell on Linux and Windows; terminals use Ctrl+Shift.
    const aids = workspaceId
      ? new ConversationAids(term, {
          copy: (text) => void trpcClient.clipboard.writeText.mutate({ text }),
          change: setNav,
        })
      : null;
    aidsRef.current = aids;
    onAidsRef.current?.(aids);
    // Scripted checks read the buffer and the aids' markers.
    Object.assign(container, { xterm: term, aids });
    termRef.current = term;
    // Marks apply where the output has got to, so they wait for earlier writes.
    const addMark = (mark: TerminalMark) =>
      term.write('', () => {
        // A failing aid must never stop the terminal's output.
        try {
          aids?.add(mark);
        } catch (error) {
          console.warn('conversation aid', error);
        }
      });
    term.attachCustomKeyEventHandler((event) => {
      // Previous and next prompt (spec §6.8).
      const prompt = matchShortcut('promptStep', event, isMac);
      if (aids && prompt !== -1 && !aids.hidden) {
        if (event.type === 'keydown') aids.step(prompt === 0 ? -1 : 1);
        event.preventDefault();
        return false;
      }
      // xterm sends ⇧↵ as a plain ↵; ESC ↵ is the new line Claude Code reads (spec §6.3).
      if (matchShortcut('terminalNewline', event, isMac) !== -1) {
        if (event.type === 'keydown') term.input('\x1b\r');
        event.preventDefault();
        return false;
      }
      // ⌘⌫ deletes to the start of the line, as ⌃U, like other macOS terminals (spec §6.3).
      if (matchShortcut('terminalDeleteLine', event, isMac) !== -1) {
        if (event.type === 'keydown') term.input('\x15');
        event.preventDefault();
        return false;
      }
      // Copy and paste on Linux and Windows, where Ctrl+C and Ctrl+V belong to the terminal.
      if (event.type !== 'keydown') return true;
      if (matchShortcut('terminalCopy', event, isMac) !== -1) copy();
      else if (matchShortcut('terminalPaste', event, isMac) !== -1) void paste();
      else return true;
      event.preventDefault();
      return false;
    });

    let port: MessagePort | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sendSize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void trpcClient.sessions.resize.mutate({ sessionId, cols: term.cols, rows: term.rows });
      }, 50);
    };
    // Also when it is shown again after being hidden (its size goes from 0).
    const fitToContainer = () => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit();
        repaint();
      }
    };
    const observer = new ResizeObserver(fitToContainer);
    observer.observe(container);
    fitToContainer();
    term.onResize(sendSize);
    // Keystrokes before the port connects are queued, not dropped.
    const queued: string[] = [];
    const send = (data: string) => {
      port?.postMessage({ type: 'input', data } satisfies TerminalClientMessage);
      prompt.input();
    };
    // What Claude's input box shows, after keys and output (spec §9.8): the
    // main process reads a draft from it; other sessions' reports are dropped.
    const prompt = watchPrompt(term, (line) =>
      port?.postMessage({ type: 'prompt', line } satisfies TerminalClientMessage),
    );
    // A click that focuses the terminal only focuses it (spec §6.3): its mouse
    // reports don't reach the program, where Claude would move its cursor.
    let focusing = false;
    const onMouseDown = () => {
      focusing = document.activeElement !== term.textarea;
    };
    const onMouseUp = () => {
      // After xterm sends the release, from its own listener.
      if (focusing) setTimeout(() => (focusing = false), 0);
    };
    container.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    term.onData((data) => {
      if (focusing && isMouseReport(data)) return;
      // Resuming: keys go nowhere, and the overlay says so (spec §9.8).
      if (resumingRef.current) {
        setBlocked(true);
        return;
      }
      if (port) send(data);
      else queued.push(data);
    });

    openTerminalPort(sessionId)
      .then((opened) => {
        if (disposed) {
          opened.close();
          return;
        }
        port = opened;
        port.onmessage = (event: MessageEvent<TerminalServerMessage>) => {
          const message = event.data;
          if (message.type === 'exit') term.write(exitLine(message));
          else if (message.type === 'mark') addMark(message.mark);
          else if (message.type === 'data') term.write(message.data);
          else {
            // Nothing of the aids shows until the replay is drawn (spec §6.8, D9).
            aids?.replay(true);
            // The replay in pieces, each mark after the output it followed.
            let from = 0;
            for (const { at, mark } of message.marks ?? []) {
              term.write(message.data.slice(from, at));
              addMark(mark);
              from = at;
            }
            term.write(message.data.slice(from));
            // Shown with its own output: once the replay is drawn, everything again.
            term.write('', () => {
              aids?.replay(false);
              repaint();
            });
          }
        };
        port.start();
        for (const data of queued.splice(0)) send(data);
        container.dataset.connected = 'true';
        sendSize();
        if (focusOnConnectRef.current) term.focus();
      })
      .catch((error: unknown) => {
        term.write(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(repaintFrame);
      clearTimeout(resizeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      container.removeEventListener('copy', onCopy, true);
      container.removeEventListener('paste', onPaste, true);
      container.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      prompt.dispose();
      port?.close();
      aids?.dispose();
      aidsRef.current = null;
      onAidsRef.current?.(null);
      container.removeEventListener('webglcontextlost', onContextLost, true);
      // Released before disposing; the loss it reports is no longer handled.
      if (webgl) {
        webgl = null;
        releaseContext();
      }
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, fontReady, workspaceId]);

  // Dropped and chosen files (spec §6.16): the main process checks Claude
  // and types them there; a shell's text is pasted here, so xterm wraps it as
  // a paste only where the shell asked for that.
  const [refusal, setRefusal] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal(null), 5000);
    return () => clearTimeout(timer);
  }, [refusal]);
  const insertFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setRefusal(null);
      try {
        const result = await trpcClient.sessions.insertFiles.mutate({ sessionId, paths });
        if ('paste' in result) termRef.current?.paste(result.paste);
        termRef.current?.focus();
      } catch (error) {
        setRefusal({
          text: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        });
      }
    },
    [sessionId],
  );
  const onFilesHandledRef = useRef(onFilesHandled);
  onFilesHandledRef.current = onFilesHandled;
  useEffect(() => {
    if (!filesRequest) return;
    onFilesHandledRef.current?.();
    void insertFiles(filesRequest.paths);
  }, [filesRequest, insertFiles]);
  const drop = useFileDrop(files !== undefined, (paths) => void insertFiles(paths));

  return (
    // The padding sits outside the terminal's own parent: the fit addon measures
    // that parent's border-box width, padding included. Claude tabs keep a 36px
    // gutter for prompt numbers (components.md).
    <div
      className={`relative h-full w-full bg-term pt-2 ${workspaceId ? 'pl-9' : 'pl-3.5'}`}
      {...drop.handlers}
    >
      <div ref={containerRef} data-terminal={sessionId} className="h-full w-full bg-term" />
      {drop.over ? (
        <div
          data-drop-target={files}
          className="pointer-events-none absolute inset-0 z-20 flex items-end justify-center bg-focus/5 pb-6 ring-2 ring-focus ring-inset"
        >
          <span className="rounded-full border border-line-strong bg-raised px-3 py-1 text-md text-fg shadow-overlay">
            {files === 'claude' ? "Add to Claude's prompt" : 'Insert the paths'}
          </span>
        </div>
      ) : null}
      {refusal ? (
        <div
          key={refusal.at}
          role="alert"
          data-drop-refusal
          className="absolute inset-x-0 bottom-6 z-20 flex justify-center px-4"
        >
          <span className="flex max-w-full items-center gap-2 rounded-md border border-line-strong bg-raised py-1 pr-1 pl-3 text-md text-fg shadow-overlay">
            <span className="min-w-0 select-text">{refusal.text}</span>
            <button
              type="button"
              className="size-5 shrink-0 rounded text-fg-muted hover:bg-selected hover:text-fg"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => setRefusal(null)}
            >
              ×
            </button>
          </span>
        </div>
      ) : null}
      {resuming ? (
        <div
          data-resuming
          role="status"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-term/85 text-md text-fg-muted"
        >
          <span>Resuming…</span>
          {blocked ? (
            <span data-resuming-blocked className="text-sm text-fg-subtle">
              Keys you type now aren't sent. Type again once Claude is ready.
            </span>
          ) : null}
        </div>
      ) : null}
      {nav.count > 0 && !nav.hidden ? (
        <div
          data-prompt-navigator
          className="absolute top-2 right-4 z-10 flex h-6 items-center gap-1 rounded-full border border-line-strong bg-raised pr-1 pl-2.5 text-xs text-fg-muted shadow-overlay"
        >
          <span className="font-mono">
            Prompt {Math.max(nav.current, 1)} of {nav.count}
          </span>
          <button
            type="button"
            title={`Previous prompt (${keyHint('promptStep', 0)})`}
            className="size-5 rounded-full hover:bg-selected hover:text-fg"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => aidsRef.current?.step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            title={`Next prompt (${keyHint('promptStep', 1)})`}
            className="size-5 rounded-full hover:bg-selected hover:text-fg"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => aidsRef.current?.step(1)}
          >
            ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}
