import type { PromptLine } from '@shared/prompt-line';
import {
  TERMINAL_PORT_CHANNEL,
  type TerminalClientMessage,
  type TerminalPortInfo,
} from '@shared/terminal-protocol';
import { MessageChannelMain, type WebContents } from 'electron';
import type { SessionHost } from './host';

function isInput(message: unknown): message is Extract<TerminalClientMessage, { type: 'input' }> {
  const m = message as { type?: unknown; data?: unknown } | null;
  return m?.type === 'input' && typeof m.data === 'string';
}

/** A view's report of Claude's input box (spec §9.8): checked, as it comes from a renderer. */
function promptOf(message: unknown): PromptLine | null | undefined {
  const m = message as { type?: unknown; line?: unknown } | null;
  if (m?.type !== 'prompt') return undefined;
  if (m.line === null) return null;
  const line = m.line as Partial<PromptLine> | undefined;
  if (
    typeof line?.text !== 'string' ||
    line.text.length > 100_000 ||
    !Number.isInteger(line.cursor) ||
    !Number.isInteger(line.lines)
  ) {
    return undefined;
  }
  return { text: line.text, cursor: line.cursor as number, lines: line.lines as number };
}

/**
 * Attaches a window's terminal view to a session over a new MessagePort. The
 * session is detached when the window closes the port, reloads or goes away.
 */
export function attachToWindow(
  host: SessionHost,
  contents: WebContents,
  info: TerminalPortInfo,
): void {
  const { port1, port2 } = new MessageChannelMain();
  let open = true;
  const attachment = host.attach(info.sessionId, {
    send: (message) => {
      if (open) port1.postMessage(message);
    },
    close: () => {
      open = false;
      port1.close();
    },
  });
  port1.on('message', (event) => {
    if (isInput(event.data)) attachment.input(event.data.data);
    else {
      const line = promptOf(event.data);
      if (line !== undefined) attachment.prompt(line);
    }
  });
  port1.on('close', () => {
    open = false;
    attachment.detach();
  });
  port1.start();
  contents.postMessage(TERMINAL_PORT_CHANNEL, info, [port2]);
}
