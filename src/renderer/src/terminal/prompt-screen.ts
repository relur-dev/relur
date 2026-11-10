import { type PromptLine, readPromptLine, type Screen, type ScreenCell } from '@shared/prompt-line';
import type { Terminal } from '@xterm/xterm';

/** The terminal's active buffer as the prompt reader sees it. */
export function screenOf(term: Terminal): Screen {
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();
  return {
    cursorY: buffer.baseY + buffer.cursorY,
    cursorX: buffer.cursorX,
    line(y) {
      const line = buffer.getLine(y);
      if (!line) return null;
      const cells: ScreenCell[] = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x, scratch);
        if (!cell) break;
        cells.push({ chars: cell.getChars(), width: cell.getWidth(), dim: cell.isDim() !== 0 });
      }
      return cells;
    },
  };
}

/** How long after a key, and after output, the screen is read: Claude has drawn by then. */
const SETTLE_MS = 150;

/**
 * Reports Claude's input box as the screen shows it (spec §9.8): once the
 * output has settled after keys or output, when it changed or keys came
 * since the last report. `input()` is called for every key sent.
 */
export function watchPrompt(term: Terminal, report: (line: PromptLine | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typed = false;
  let keyAt = 0;
  let last: string | undefined;
  const read = () => {
    timer = undefined;
    const wait = keyAt + SETTLE_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(read, wait);
      return;
    }
    const line = readPromptLine(screenOf(term));
    const key = JSON.stringify(line);
    if (!typed && key === last) return;
    typed = false;
    last = key;
    report(line);
  };
  const schedule = () => {
    timer ??= setTimeout(read, SETTLE_MS);
  };
  const parsed = term.onWriteParsed(schedule);
  return {
    input() {
      typed = true;
      keyAt = Date.now();
      schedule();
    },
    dispose() {
      parsed.dispose();
      if (timer) clearTimeout(timer);
    },
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: mouse reports start with ESC.
const MOUSE_REPORT = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

/** Whether the terminal's data is only mouse reports (SGR or X10). */
export const isMouseReport = (data: string): boolean => MOUSE_REPORT.test(data);
