import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ Menu: {}, shell: {} }));
const { menuTemplate } = await import('./menu');

/** Electron's own accelerators for the roles the menu uses, on Linux and Windows. */
const ROLE_KEYS: Record<string, string> = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectAll: 'Ctrl+A',
  close: 'Ctrl+W',
  minimize: 'Ctrl+M',
  quit: 'Ctrl+Q',
  resetZoom: 'Ctrl+0',
  zoomIn: 'Ctrl+Plus',
  zoomOut: 'Ctrl+-',
  togglefullscreen: 'F11',
  reload: 'Ctrl+R',
  forceReload: 'Ctrl+Shift+R',
  toggleDevTools: 'Ctrl+Shift+I',
};

function registered(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => {
    const sub = Array.isArray(item.submenu) ? registered(item.submenu) : [];
    if (item.registerAccelerator === false) return sub;
    if (item.role === 'windowMenu' || item.role === 'editMenu') {
      return [...sub, `role:${item.role}`];
    }
    const key = item.accelerator ?? (item.role ? ROLE_KEYS[item.role] : undefined);
    return key ? [...sub, String(key).replace('CmdOrCtrl', 'Ctrl')] : sub;
  });
}

describe('menuTemplate', () => {
  const noop = () => {};
  for (const isDev of [false, true]) {
    it(`leaves the terminal's keys alone on Linux${isDev ? ' (development)' : ''}`, () => {
      const keys = registered(
        menuTemplate({
          isMac: false,
          isDev,
          openConfig: noop,
          reloadConfig: noop,
          quitOnClose: false,
          setQuitOnClose: noop,
          request: noop,
        }),
      );
      for (const key of keys) {
        // Ctrl with a letter, [, - or 0 alone is a shell key; Ctrl+Q stays Quit (spec §6.6).
        expect(key, key).not.toMatch(/^Ctrl\+([A-PR-Z0\-[]|Alt\+.)$/);
        expect(key, key).not.toMatch(/^Ctrl\+Shift\+[CVU]$/);
        expect(key, key).not.toMatch(/^role:/);
      }
      expect(keys).toContain('Ctrl+Shift+W');
      expect(keys).toContain('Ctrl+Q');
    });
  }

  for (const isMac of [true, false]) {
    it(`has Report a Bug… and Request a Feature… under the Guide in Help (${isMac ? 'macOS' : 'Linux'})`, () => {
      const chosen: string[] = [];
      const template = menuTemplate({
        isMac,
        isDev: false,
        openConfig: noop,
        reloadConfig: noop,
        quitOnClose: false,
        setQuitOnClose: noop,
        request: noop,
        feedback: {
          reportBug: () => chosen.push('bug'),
          requestFeature: () => chosen.push('feature'),
        },
      });
      const help = template.find((m) => m.role === 'help')?.submenu as MenuItemConstructorOptions[];
      const items = help.map((i) => i.label ?? i.role ?? i.type);
      expect(items.slice(-4)).toEqual([
        expect.stringMatching(/ Guide$/),
        'separator',
        'Report a Bug…',
        'Request a Feature…',
      ]);
      for (const item of help.slice(-2)) {
        item.click?.({} as never, undefined, {} as never);
      }
      expect(chosen).toEqual(['bug', 'feature']);
    });

    it(`has Appearance in View with System, Light and Dark (${isMac ? 'macOS' : 'Linux'})`, () => {
      const chosen: string[] = [];
      const view = (appearance?: 'system' | 'light' | 'dark') => {
        const template = menuTemplate({
          isMac,
          isDev: false,
          openConfig: noop,
          reloadConfig: noop,
          quitOnClose: false,
          setQuitOnClose: noop,
          appearance,
          setAppearance: (choice) => chosen.push(choice),
          request: noop,
        });
        const items = template.find((m) => m.label === 'View')
          ?.submenu as MenuItemConstructorOptions[];
        return items.find((i) => i.label === 'Appearance')?.submenu as MenuItemConstructorOptions[];
      };
      const choices = view('dark');
      expect(choices.map((i) => [i.label, i.type, i.checked])).toEqual([
        ['System', 'radio', false],
        ['Light', 'radio', false],
        ['Dark', 'radio', true],
      ]);
      // Unset: System is checked.
      expect(view().map((i) => i.checked)).toEqual([true, false, false]);
      for (const item of choices) item.click?.({} as never, undefined, {} as never);
      expect(chosen).toEqual(['system', 'light', 'dark']);
    });
  }
});
