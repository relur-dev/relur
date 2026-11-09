import { BRAND } from '@shared/brand';
import type { StatusGlyph as Glyph } from '@shared/status';

/** The status glyph legend (`:::glyphs`): glyph, name, shape and meaning. */
export const GLYPHS: [Glyph, string, string, string][] = [
  ['working', 'Working', 'Spinner', 'Claude is working, or setup is running. Nothing to do yet.'],
  [
    'permission',
    'Needs permission',
    'Amber triangle',
    'Claude wants to run a command or edit a file and waits for your OK.',
  ],
  ['input', 'Waiting for input', 'Pink ring', 'Claude finished its turn and waits for your reply.'],
  [
    'question',
    'Asked a question',
    'Pink ?',
    'Claude asks you to choose in its question menu. On the Board, its card shows the options.',
  ],
  [
    'approval',
    'Awaiting approval',
    'Purple diamond',
    "Your skills stopped at a workflow gate and wait for you. The row shows the gate's name.",
  ],
  [
    'done',
    'Done, not looked at yet',
    'Filled dot',
    'Claude finished its turn. The dot clears when you open the workspace.',
  ],
  ['exited', 'Exited', 'Hollow square', 'The Claude process has ended. Start it again in its tab.'],
  ['error', 'Error', '✕', 'Something failed: setup, or Claude could not start.'],
  [
    'unfinished',
    'Unfinished',
    'Two bars',
    `${BRAND.displayName} closed while Claude was at work there. Open it to continue or dismiss.`,
  ],
];
