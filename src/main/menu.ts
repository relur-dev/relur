import {
  APPEARANCE_LABEL,
  APPEARANCES,
  type Appearance,
  appearanceOf,
  writeAppearance,
} from '@shared/appearance';
import { BRAND } from '@shared/brand';
import { acceleratorOf } from '@shared/shortcuts';
import { QUIT_ON_CLOSE_LABEL } from '@shared/window-close';
import { dialog, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import type { ConfigStore } from './config/store';

/** A menu item the renderer handles with its own dialog. */
export type MenuRequest = 'install-cli' | 'close-tab' | 'guide';

/** The menu's update items (spec §15.7). */
export interface MenuUpdates {
  setAutomatic: (on: boolean) => void;
  checkNow: () => void;
}

/** Help › Report a Bug… and Request a Feature… (spec §6.12). */
export interface MenuFeedback {
  reportBug: () => void;
  requestFeature: () => void;
}

export function installAppMenu(
  config: ConfigStore,
  request: (what: MenuRequest) => void,
  updates: MenuUpdates,
  feedback: MenuFeedback,
): void {
  build(config, request, updates, feedback);
  // The checkboxes follow config.json, also after Reload Config.
  config.onChange(() => build(config, request, updates, feedback));
}

function setQuitOnClose(config: ConfigStore, quit: boolean): void {
  try {
    config.update((raw) => {
      if (quit) raw.quitOnWindowClose = true;
      else delete raw.quitOnWindowClose;
    });
  } catch (error) {
    dialog.showErrorBox(
      'Couldn’t save the setting',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** View › Appearance (spec §6): config.json, then nativeTheme follows (appearance.ts). */
function setAppearance(config: ConfigStore, appearance: Appearance): void {
  try {
    config.update((raw) => writeAppearance(raw, appearance));
  } catch (error) {
    dialog.showErrorBox(
      'Couldn’t save the setting',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function build(
  config: ConfigStore,
  request: (what: MenuRequest) => void,
  updates: MenuUpdates,
  feedback: MenuFeedback,
): void {
  const template = menuTemplate({
    isMac: process.platform === 'darwin',
    // Set by electron-vite's dev server only (see window.ts).
    isDev: Boolean(process.env.ELECTRON_RENDERER_URL),
    openConfig: () => void shell.openPath(config.file),
    reloadConfig: () => config.reload(),
    quitOnClose: config.get().config?.quitOnWindowClose === true,
    setQuitOnClose: (quit) => setQuitOnClose(config, quit),
    appearance: appearanceOf(config.get().config),
    setAppearance: (appearance) => setAppearance(config, appearance),
    request,
    updates: { ...updates, automatic: config.get().config?.checkForUpdates === true },
    feedback,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface MenuOptions {
  isMac: boolean;
  isDev: boolean;
  openConfig: () => void;
  reloadConfig: () => void;
  /** macOS: Quit When the Window Closes (spec §5). */
  quitOnClose: boolean;
  setQuitOnClose: (quit: boolean) => void;
  /** View › Appearance (spec §6). */
  appearance?: Appearance;
  setAppearance?: (appearance: Appearance) => void;
  request: (what: MenuRequest) => void;
  /** Check for Updates… and Check for Updates Automatically (spec §15.7). */
  updates?: MenuUpdates & { automatic: boolean };
  feedback?: MenuFeedback;
}

/**
 * The app menu. On Linux and Windows no item registers a key the shell in a
 * terminal uses (spec §6.6): the Edit items and Minimize leave Ctrl+Z, Ctrl+C,
 * Ctrl+M and the rest to the focused field or terminal, and the Window menu
 * has no Close (Ctrl+W).
 */
export function menuTemplate({
  isMac,
  isDev,
  openConfig,
  reloadConfig,
  quitOnClose,
  setQuitOnClose,
  appearance = 'system',
  setAppearance = () => {},
  request,
  updates,
  feedback,
}: MenuOptions): MenuItemConstructorOptions[] {
  // In the app menu on macOS, in Help elsewhere.
  const updateItems: MenuItemConstructorOptions[] = updates
    ? [
        { label: 'Check for Updates…', click: () => updates.checkNow() },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: updates.automatic,
          click: (item) => updates.setAutomatic(item.checked),
        },
      ]
    : [];
  // The command line tool for other terminals (spec §7.5); the renderer confirms first.
  const installCli: MenuItemConstructorOptions = {
    label: 'Install Command Line Tool…',
    click: () => request('install-cli'),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: BRAND.displayName,
            submenu: [
              { role: 'about' },
              ...updateItems,
              { type: 'separator' },
              installCli,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              // Off: closing the window keeps the app running (spec §5).
              {
                label: QUIT_ON_CLOSE_LABEL,
                type: 'checkbox',
                checked: quitOnClose,
                click: (item) => setQuitOnClose(item.checked),
              },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Config File', click: openConfig },
        { label: 'Reload Config', click: reloadConfig },
        ...(isMac ? [] : [installCli]),
        { type: 'separator' },
        // ⌘W closes the terminal tab (spec §6.6); the window asks before closing Claude.
        {
          label: 'Close Tab',
          accelerator: acceleratorOf('closeTab', isMac),
          click: () => request('close-tab'),
        },
        isMac
          ? {
              role: 'close',
              accelerator: acceleratorOf('closeWindow', isMac),
              label: 'Close Window',
            }
          : { role: 'quit' },
      ],
    },
    isMac
      ? { role: 'editMenu' }
      : {
          // Ctrl+C/V/X/A must reach the terminal on Linux and Windows. Text fields
          // keep them anyway; terminals copy and paste with Ctrl+Shift+C/V.
          label: 'Edit',
          submenu: [
            { role: 'undo', registerAccelerator: false },
            { role: 'redo', registerAccelerator: false },
            { type: 'separator' },
            { role: 'cut', registerAccelerator: false },
            { role: 'copy', registerAccelerator: false },
            { role: 'paste', registerAccelerator: false },
            { role: 'selectAll', registerAccelerator: false },
          ],
        },
    {
      // No key has two meanings (spec §6.6): ⌘R is Check again, so production
      // builds have no reload or DevTools items, and development builds move them.
      label: 'View',
      submenu: [
        ...(isDev
          ? ([
              { role: 'reload', accelerator: 'Alt+CmdOrCtrl+R' },
              { role: 'forceReload', accelerator: 'Alt+Shift+CmdOrCtrl+R' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] as const)
          : []),
        // Linux and Windows: Ctrl+0 is Profile home and Ctrl+- is the shell's undo.
        { role: 'resetZoom', registerAccelerator: isMac },
        { role: 'zoomIn' },
        { role: 'zoomOut', registerAccelerator: isMac },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: APPEARANCES.map((choice) => ({
            label: APPEARANCE_LABEL[choice],
            type: 'radio' as const,
            checked: appearance === choice,
            click: () => setAppearance(choice),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    isMac
      ? { role: 'windowMenu' }
      : { label: 'Window', submenu: [{ role: 'minimize', registerAccelerator: false }] },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : ([{ role: 'about' }, ...updateItems, { type: 'separator' }] as const)),
        {
          label: `${BRAND.displayName} Guide`,
          // The window handles the key itself (it works in terminals too); the menu shows it.
          accelerator: acceleratorOf('guide', isMac),
          registerAccelerator: false,
          click: () => request('guide'),
        },
        // The issue forms in the browser; nothing is sent (spec §6.12).
        ...(feedback
          ? ([
              { type: 'separator' },
              { label: 'Report a Bug…', click: () => feedback.reportBug() },
              { label: 'Request a Feature…', click: () => feedback.requestFeature() },
            ] as const)
          : []),
      ],
    },
  ];
  return template;
}
