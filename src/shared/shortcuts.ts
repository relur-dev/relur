/**
 * Every keyboard shortcut of the app, in one place (components.md, Keyboard
 * shortcuts). The window's key handlers, the menu accelerators, the hints on
 * buttons and the Guide's Keyboard shortcuts page all read these, so a change
 * here changes all of them.
 */

/** One key with modifiers. `mod` is ⌘ on macOS and Ctrl elsewhere; `ctrl` is the Control key itself. */
export interface Chord {
  code: string;
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type ShortcutGroup =
  | 'Profiles and windows'
  | 'Workspaces'
  | 'Tabs and terminals'
  | 'Claude'
  | 'Guide'
  | 'Dialogs';

export interface Shortcut {
  group: ShortcutGroup;
  label: string;
  /** Alternatives shown with " / " (previous / next), or a range's first and last key. */
  chords: Chord[];
  /** `chords` are the two ends of a range of digits (⌘1 – ⌘9). */
  range?: boolean;
  /** Only on this platform. */
  platform?: 'mac' | 'other';
  /**
   * Linux and Windows chords in place of `chords`, where Ctrl for ⌘ would take
   * a key the shell in a terminal uses (Ctrl+L, Ctrl+W, …; spec §6.6).
   */
  other?: Chord[];
  /** Handled by the app menu (Electron accelerator) rather than the window. */
  menu?: boolean;
}

const digits = (chord: Omit<Chord, 'code'>): Chord[] => [
  { ...chord, code: 'Digit1' },
  { ...chord, code: 'Digit9' },
];

export const SHORTCUTS = {
  profile: {
    group: 'Profiles and windows',
    label: 'Switch profile (in tab order)',
    chords: digits({ mod: true }),
    range: true,
  },
  home: {
    group: 'Profiles and windows',
    label: 'Profile home',
    chords: [{ mod: true, code: 'Digit0' }],
  },
  guide: {
    group: 'Profiles and windows',
    label: 'Guide',
    chords: [{ mod: true, shift: true, code: 'Slash' }],
  },
  closeWindow: {
    group: 'Profiles and windows',
    label: 'Close window',
    chords: [{ mod: true, shift: true, code: 'KeyW' }],
    menu: true,
    platform: 'mac',
  },
  quit: {
    group: 'Profiles and windows',
    label: 'Quit',
    chords: [{ mod: true, code: 'KeyQ' }],
    menu: true,
  },

  newWorkspace: {
    group: 'Workspaces',
    label: 'New workspace',
    chords: [{ mod: true, code: 'KeyN' }],
    other: [{ ctrl: true, shift: true, code: 'KeyN' }],
  },
  addProject: {
    group: 'Workspaces',
    label: 'Add project',
    chords: [{ mod: true, code: 'KeyO' }],
    other: [{ ctrl: true, shift: true, code: 'KeyO' }],
  },
  startClaude: {
    group: 'Workspaces',
    label: 'Start Claude here (Home, project)',
    chords: [{ mod: true, code: 'KeyL' }],
    other: [{ ctrl: true, shift: true, code: 'KeyL' }],
  },
  nextNeedingYou: {
    group: 'Workspaces',
    label: 'Next workspace that needs you',
    chords: [{ mod: true, code: 'KeyJ' }],
    other: [{ ctrl: true, shift: true, code: 'KeyJ' }],
  },
  workspaceStep: {
    group: 'Workspaces',
    label: 'Previous / next workspace of this profile',
    chords: [
      { alt: true, code: 'ArrowUp' },
      { alt: true, code: 'ArrowDown' },
    ],
  },
  changes: {
    group: 'Workspaces',
    label: 'Show or hide the Changes panel',
    chords: [{ mod: true, shift: true, code: 'KeyD' }],
  },
  changesFullView: {
    group: 'Workspaces',
    label: 'Changes panel: full view or back',
    chords: [{ mod: true, shift: true, code: 'KeyM' }],
  },
  notes: {
    group: 'Workspaces',
    label: 'Show or hide the Notes panel',
    chords: [{ mod: true, shift: true, code: 'KeyK' }],
  },
  addNote: {
    group: 'Workspaces',
    label: 'Add a note (opens the Notes panel)',
    // Ctrl+Alt+N on Linux and Windows: no shell or desktop key there (spec §6.6).
    chords: [{ mod: true, alt: true, code: 'KeyN' }],
  },
  noteSendNow: {
    group: 'Workspaces',
    label: 'In a note: send it now',
    // Ctrl+Enter and Alt+Enter type nothing in a text field on Linux, and
    // aren't shell keys; ⌘↵ is also Confirm, but only in dialogs (spec §6.15).
    chords: [{ mod: true, code: 'Enter' }],
  },
  noteQueue: {
    group: 'Workspaces',
    label: 'In a note: send it when Claude is done',
    chords: [{ alt: true, code: 'Enter' }],
  },
  noteEditor: {
    group: 'Workspaces',
    label: 'In a note: open it in the large editor, or back',
    // F for full view, as the Responses panel's ⇧⌘F; Ctrl+Alt+F on Linux and
    // Windows, as ⌥⌘N is Ctrl+Alt+N: it types nothing in a text field and
    // isn't a desktop key, unlike Alt+letters (menus) or Ctrl+Shift+U (IBus).
    chords: [{ mod: true, alt: true, code: 'KeyF' }],
  },
  changesFileStep: {
    group: 'Workspaces',
    label: 'Changes panel: previous / next file',
    // ⌥⌘↑↓ in a read-only diff would only add cursors; Ctrl+Alt+arrows switch
    // desktops on Linux, so Ctrl+Shift there (spec §6.4).
    chords: [
      { mod: true, alt: true, code: 'ArrowUp' },
      { mod: true, alt: true, code: 'ArrowDown' },
    ],
    other: [
      { ctrl: true, shift: true, code: 'ArrowUp' },
      { ctrl: true, shift: true, code: 'ArrowDown' },
    ],
  },
  continueWorkflow: {
    group: 'Workspaces',
    label: 'Continue the workflow; at a gate, go to Claude',
    chords: [{ mod: true, shift: true, code: 'Enter' }],
  },
  openInEditor: {
    group: 'Workspaces',
    label: 'Open in editor (workspace or project)',
    chords: [{ mod: true, code: 'KeyE' }],
    other: [{ ctrl: true, shift: true, code: 'KeyE' }],
  },

  newShell: {
    group: 'Tabs and terminals',
    label: 'New shell tab',
    chords: [{ mod: true, code: 'KeyT' }],
    other: [{ ctrl: true, shift: true, code: 'KeyT' }],
  },
  closeTab: {
    group: 'Tabs and terminals',
    label: 'Close tab',
    chords: [{ mod: true, code: 'KeyW' }],
    menu: true,
    other: [{ ctrl: true, shift: true, code: 'KeyW' }],
  },
  terminalTab: {
    group: 'Tabs and terminals',
    label: 'Terminal tab 1–9; on Home, Overview and Terminal',
    chords: digits({ ctrl: true }),
    range: true,
    platform: 'mac',
  },
  cycleTabs: {
    group: 'Tabs and terminals',
    label: 'Next / previous tab',
    chords: [
      { ctrl: true, code: 'Tab' },
      { ctrl: true, shift: true, code: 'Tab' },
    ],
  },
  terminalCopy: {
    group: 'Tabs and terminals',
    label: 'Copy in a terminal',
    chords: [{ ctrl: true, shift: true, code: 'KeyC' }],
    platform: 'other',
  },
  terminalPaste: {
    group: 'Tabs and terminals',
    label: 'Paste in a terminal',
    chords: [{ ctrl: true, shift: true, code: 'KeyV' }],
    platform: 'other',
  },
  terminalNewline: {
    group: 'Tabs and terminals',
    label: 'New line in a terminal (Claude takes it as a new line in the prompt)',
    chords: [{ shift: true, code: 'Enter' }],
  },
  terminalDeleteLine: {
    group: 'Tabs and terminals',
    label: 'Delete to the start of the line in a terminal',
    chords: [{ mod: true, code: 'Backspace' }],
    platform: 'mac',
  },

  promptStep: {
    group: 'Claude',
    label: 'Previous / next prompt (classic mode)',
    chords: [
      { mod: true, code: 'ArrowUp' },
      { mod: true, code: 'ArrowDown' },
    ],
  },
  copyResponse: {
    group: 'Claude',
    label: 'Copy the last response',
    chords: [{ alt: true, code: 'KeyC' }],
  },
  responses: {
    group: 'Claude',
    label: 'Show or hide the Responses panel',
    chords: [{ mod: true, shift: true, code: 'KeyR' }],
  },
  responsesFullView: {
    group: 'Claude',
    label: 'Responses panel: full view or back',
    chords: [{ mod: true, shift: true, code: 'KeyF' }],
  },
  restartClaude: {
    group: 'Claude',
    label: 'Restart Claude in an exited Claude tab',
    chords: [{ code: 'Enter' }],
  },

  guideSearch: { group: 'Guide', label: 'Search the Guide', chords: [{ mod: true, code: 'KeyF' }] },
  guideBack: {
    group: 'Guide',
    label: 'Back to where the link was',
    chords: [{ mod: true, code: 'BracketLeft' }],
  },

  confirm: { group: 'Dialogs', label: 'Confirm', chords: [{ mod: true, code: 'Enter' }] },
  cancel: { group: 'Dialogs', label: 'Cancel', chords: [{ code: 'Escape' }] },
  browse: {
    group: 'Dialogs',
    label: 'Browse (in a path field)',
    chords: [{ mod: true, code: 'KeyB' }],
  },
  checkAgain: {
    group: 'Dialogs',
    // ⌘R also retries a failed setup: both mean "try again" and never show together (spec §6.6).
    label: 'Check again (setup check), Retry (failed setup)',
    chords: [{ mod: true, code: 'KeyR' }],
    other: [{ code: 'F5' }],
  },
} satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const GROUP_ORDER: ShortcutGroup[] = [
  'Profiles and windows',
  'Workspaces',
  'Tabs and terminals',
  'Claude',
  'Guide',
  'Dialogs',
];

const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  ArrowUp: ['↑', 'Up'],
  ArrowDown: ['↓', 'Down'],
  ArrowLeft: ['←', 'Left'],
  ArrowRight: ['→', 'Right'],
  Enter: ['↵', 'Enter'],
  Backspace: ['⌫', 'Backspace'],
  Escape: ['Esc', 'Esc'],
  Tab: ['Tab', 'Tab'],
  Slash: ['/', '/'],
  Period: ['.', '.'],
  BracketLeft: ['[', '['],
  Backslash: ['\\', '\\'],
};

function keyName(code: string, mac: boolean): string {
  const named = KEY_NAMES[code];
  if (named) return mac ? named[0] : named[1];
  return code.replace(/^(Key|Digit)/, '');
}

/** A chord as shown: `⇧⌘D` on macOS (Apple's modifier order), `Ctrl+Shift+D` elsewhere. */
export function formatChord(chord: Chord, mac: boolean): string {
  const key = keyName(chord.code, mac);
  if (mac) {
    const ctrl = chord.ctrl ? '⌃' : '';
    const alt = chord.alt ? '⌥' : '';
    const shift = chord.shift ? '⇧' : '';
    const cmd = chord.mod ? '⌘' : '';
    return `${ctrl}${alt}${shift}${cmd}${key}`;
  }
  const parts = [
    chord.mod || chord.ctrl ? 'Ctrl' : null,
    chord.alt ? 'Alt' : null,
    chord.shift ? 'Shift' : null,
    key,
  ].filter(Boolean);
  return parts.join('+');
}

/** A shortcut's chords on this platform: its `other` ones on Linux and Windows, if any. */
export const chordsOf = (shortcut: Shortcut, mac: boolean): Chord[] =>
  (!mac && shortcut.other) || shortcut.chords;

/** A shortcut's keys as shown, e.g. `⌘1 – ⌘9` or `⌥↑ / ⌥↓`. */
export function formatShortcut(shortcut: Shortcut, mac: boolean): string {
  const shown = chordsOf(shortcut, mac).map((c) => formatChord(c, mac));
  return shown.join(shortcut.range ? ' – ' : ' / ');
}

/** One chord of a shortcut (the first by default), as a button hint. */
export const hint = (id: ShortcutId, mac: boolean, index = 0) =>
  formatChord(chordsOf(SHORTCUTS[id], mac)[index] as Chord, mac);

/** All of a shortcut's keys, as the Keyboard shortcuts page shows them. */
export const hints = (id: ShortcutId, mac: boolean) => formatShortcut(SHORTCUTS[id], mac);

/** The Electron menu accelerator of a chord. */
export function accelerator(chord: Chord): string {
  const parts = [
    chord.mod ? 'CmdOrCtrl' : null,
    chord.ctrl ? 'Ctrl' : null,
    chord.alt ? 'Alt' : null,
    chord.shift ? 'Shift' : null,
    keyName(chord.code, false),
  ].filter(Boolean);
  return parts.join('+');
}

/** A shortcut's first chord on this platform as an Electron menu accelerator. */
export const acceleratorOf = (id: ShortcutId, mac: boolean) =>
  accelerator(chordsOf(SHORTCUTS[id], mac)[0] as Chord);

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function chordMatches(chord: Chord, e: KeyLike, mac: boolean): boolean {
  // ⌘ on macOS, Ctrl elsewhere; the other one must not be held.
  const wantMeta = mac ? Boolean(chord.mod) : false;
  const wantCtrl = mac ? Boolean(chord.ctrl) : Boolean(chord.mod || chord.ctrl);
  return (
    e.metaKey === wantMeta &&
    e.ctrlKey === wantCtrl &&
    e.altKey === Boolean(chord.alt) &&
    e.shiftKey === Boolean(chord.shift) &&
    (e.code === chord.code ||
      // ⇧/ types ? on most layouts; some report the shifted key's code.
      (chord.code === 'Slash' && e.code === 'IntlRo'))
  );
}

/**
 * Which chord of the shortcut the key event is: its index, or for a range
 * the digit (1–9); -1 when it isn't this shortcut.
 */
export function matchShortcut(id: ShortcutId, e: KeyLike, mac: boolean): number {
  const shortcut: Shortcut = SHORTCUTS[id];
  if (shortcut.platform && shortcut.platform !== (mac ? 'mac' : 'other')) return -1;
  if (shortcut.range) {
    const [first] = shortcut.chords as [Chord, Chord];
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!digit || !chordMatches({ ...first, code: e.code }, e, mac)) return -1;
    return Number(digit);
  }
  return chordsOf(shortcut, mac).findIndex((chord) => chordMatches(chord, e, mac));
}

/** The shortcuts shown on this platform, grouped in Guide order. */
export function shortcutsByGroup(mac: boolean): { group: ShortcutGroup; shortcuts: Shortcut[] }[] {
  const all: Shortcut[] = Object.values(SHORTCUTS);
  return GROUP_ORDER.map((group) => ({
    group,
    shortcuts: all.filter(
      (s) => s.group === group && (!s.platform || s.platform === (mac ? 'mac' : 'other')),
    ),
  })).filter((g) => g.shortcuts.length > 0);
}
