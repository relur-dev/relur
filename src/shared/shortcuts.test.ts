import { describe, expect, it } from 'vitest';
import {
  acceleratorOf,
  chordsOf,
  formatChord,
  formatShortcut,
  matchShortcut,
  SHORTCUTS,
  type Shortcut,
} from './shortcuts';

const key = (
  code: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
) => ({
  code,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
});

describe('shortcuts', () => {
  it('shows keys the macOS way and the Linux way', () => {
    expect(formatShortcut(SHORTCUTS.guide, true)).toBe('⇧⌘/');
    expect(formatShortcut(SHORTCUTS.guide, false)).toBe('Ctrl+Shift+/');
    expect(formatShortcut(SHORTCUTS.profile, true)).toBe('⌘1 – ⌘9');
    expect(formatShortcut(SHORTCUTS.workspaceStep, true)).toBe('⌥↑ / ⌥↓');
    expect(formatShortcut(SHORTCUTS.cycleTabs, true)).toBe('⌃Tab / ⌃⇧Tab');
    expect(acceleratorOf('closeTab', true)).toBe('CmdOrCtrl+W');
    expect(acceleratorOf('closeTab', false)).toBe('Ctrl+Shift+W');
  });

  it('matches ⌘ on macOS and Ctrl elsewhere, with exact modifiers', () => {
    expect(matchShortcut('newWorkspace', key('KeyN', { meta: true }), true)).toBe(0);
    expect(matchShortcut('newWorkspace', key('KeyN', { ctrl: true }), true)).toBe(-1);
    expect(matchShortcut('newWorkspace', key('KeyN', { ctrl: true }), false)).toBe(-1);
    expect(matchShortcut('newWorkspace', key('KeyN', { ctrl: true, shift: true }), false)).toBe(0);
    expect(matchShortcut('home', key('Digit0', { ctrl: true }), false)).toBe(0);
    expect(matchShortcut('newWorkspace', key('KeyN', { meta: true, shift: true }), true)).toBe(-1);
    expect(matchShortcut('workspaceStep', key('ArrowDown', { alt: true }), true)).toBe(1);
    expect(matchShortcut('cycleTabs', key('Tab', { ctrl: true, shift: true }), true)).toBe(1);
    expect(matchShortcut('terminalNewline', key('Enter', { shift: true }), true)).toBe(0);
    expect(matchShortcut('terminalNewline', key('Enter', { shift: true }), false)).toBe(0);
    expect(matchShortcut('terminalNewline', key('Enter'), true)).toBe(-1);
    expect(matchShortcut('terminalDeleteLine', key('Backspace', { meta: true }), true)).toBe(0);
    expect(matchShortcut('terminalDeleteLine', key('Backspace', { ctrl: true }), false)).toBe(-1);
    expect(formatShortcut(SHORTCUTS.terminalDeleteLine, true)).toBe('⌘⌫');
  });

  it('gives the digit of a range, and keeps platform-only keys to their platform', () => {
    expect(matchShortcut('profile', key('Digit3', { meta: true }), true)).toBe(3);
    expect(matchShortcut('terminalTab', key('Digit2', { ctrl: true }), true)).toBe(2);
    expect(matchShortcut('terminalTab', key('Digit2', { ctrl: true }), false)).toBe(-1);
    expect(matchShortcut('terminalCopy', key('KeyC', { ctrl: true, shift: true }), true)).toBe(-1);
    expect(matchShortcut('terminalCopy', key('KeyC', { ctrl: true, shift: true }), false)).toBe(0);
  });

  it('gives each chord one shortcut per platform', () => {
    for (const mac of [true, false]) {
      const seen = new Map<string, string>();
      for (const [id, shortcut] of Object.entries(SHORTCUTS) as [string, Shortcut][]) {
        if (shortcut.platform && shortcut.platform !== (mac ? 'mac' : 'other')) continue;
        for (const chord of chordsOf(shortcut, mac)) {
          const shown = formatChord(chord, mac);
          expect(seen.get(shown), `${shown}: ${id}`).toBeUndefined();
          seen.set(shown, id);
        }
      }
    }
    expect(formatShortcut(SHORTCUTS.responses, true)).toBe('⇧⌘R');
    expect(formatShortcut(SHORTCUTS.notes, true)).toBe('⇧⌘K');
    expect(formatShortcut(SHORTCUTS.notes, false)).toBe('Ctrl+Shift+K');
    expect(formatShortcut(SHORTCUTS.addNote, true)).toBe('⌥⌘N');
    expect(formatShortcut(SHORTCUTS.addNote, false)).toBe('Ctrl+Alt+N');
    expect(formatShortcut(SHORTCUTS.responsesFullView, true)).toBe('⇧⌘F');
    expect(formatShortcut(SHORTCUTS.changesFullView, true)).toBe('⇧⌘M');
    expect(formatShortcut(SHORTCUTS.changesFullView, false)).toBe('Ctrl+Shift+M');
    expect(formatShortcut(SHORTCUTS.changesFileStep, true)).toBe('⌥⌘↑ / ⌥⌘↓');
    expect(formatShortcut(SHORTCUTS.changesFileStep, false)).toBe(
      'Ctrl+Shift+Up / Ctrl+Shift+Down',
    );
    expect(
      matchShortcut('changesFileStep', key('ArrowDown', { meta: true, alt: true }), true),
    ).toBe(1);
    // ⌥↓ alone stays the next workspace.
    expect(matchShortcut('changesFileStep', key('ArrowDown', { alt: true }), true)).toBe(-1);
  });

  it("leaves the shell's keys to terminals on Linux (spec §6.6)", () => {
    // Shortcuts that also work while a terminal has focus; the Guide's keys and
    // the dialogs' work where no terminal is.
    const inTerminals = (Object.entries(SHORTCUTS) as [string, Shortcut][]).filter(
      ([, s]) => s.group !== 'Guide' && s.group !== 'Dialogs' && s.platform !== 'mac',
    );
    for (const [id, shortcut] of inTerminals) {
      for (const chord of chordsOf(shortcut, false)) {
        const shown = formatChord(chord, false);
        // Ctrl with a letter or [ alone is a shell key; Ctrl+Q stays Quit.
        expect(shown, id).not.toMatch(/^Ctrl\+([A-PR-Z]|\[)$/);
      }
    }
    expect(formatShortcut(SHORTCUTS.checkAgain, false)).toBe('F5');
    expect(formatShortcut(SHORTCUTS.openInEditor, false)).toBe('Ctrl+Shift+E');
  });

  it("keeps Ctrl+Shift+C and Ctrl+Shift+V for the terminal's copy and paste, and Ctrl+Shift+U for IBus", () => {
    for (const [id, shortcut] of Object.entries(SHORTCUTS) as [string, Shortcut][]) {
      if (shortcut.platform === 'mac') continue;
      for (const chord of chordsOf(shortcut, false)) {
        const shown = formatChord(chord, false);
        if (id === 'terminalCopy' || id === 'terminalPaste') continue;
        expect(['Ctrl+Shift+C', 'Ctrl+Shift+V', 'Ctrl+Shift+U'], id).not.toContain(shown);
      }
    }
  });
});
