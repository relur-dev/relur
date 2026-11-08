import path from 'node:path';
import { BRAND, envVar } from '@shared/brand';
import { app, BrowserWindow, nativeTheme, screen, session } from 'electron';

/** The app icon for unpackaged runs, where no bundle supplies it (dev Dock, Linux window). */
export const devIconPath = () => path.join(app.getAppPath(), 'build', 'icons', '512x512.png');

/** Linux: the icon for the window and notifications; packaged builds carry it in resources. */
export const linuxIconPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : devIconPath();

/**
 * Scripted test runs (scripts/lib/app-driver.ts) keep their windows away from
 * the real mouse and keyboard of someone using the machine: placed beyond
 * every screen, unable to take the focus, transparent and letting the mouse
 * through. Input comes only from the driver, over the DevTools protocol.
 */
export const testWindows = () => process.env[envVar('TEST_WINDOW')] === 'background';

const WIDTH = 1280;
const HEIGHT = 800;

/** Left of every screen, with room to spare: no pointer gets there. */
function offScreen(): { x: number; y: number } {
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  return { x: left - WIDTH - 2000, y: 0 };
}

export function createMainWindow(): BrowserWindow {
  const background = testWindows();
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...(background ? { ...offScreen(), focusable: false, enableLargerThanScreen: true } : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: BRAND.displayName,
    // The theme's --color-chrome, so the window doesn't flash before the page paints;
    // nativeTheme already follows View › Appearance (appearance.ts).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#c4c2bd',
    // macOS: the profile tab strip is the title bar, with the traffic lights in it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    ...(process.platform === 'linux' ? { icon: linuxIconPath() } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  win.once('ready-to-show', () => {
    if (!background) {
      win.show();
      return;
    }
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    // macOS may move a window onto a screen as it is shown.
    win.setPosition(offScreen().x, offScreen().y);
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

/**
 * Brings the window to the front with the focus, as a click on the Dock icon
 * does; in scripted test runs it stays where it is, without the focus.
 */
export function bringForward(win: BrowserWindow): void {
  if (testWindows()) {
    if (!win.isVisible()) win.showInactive();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Puts the window's remembered preferences (its local storage) on disk now
 * (spec §5). Chromium writes local storage on its own schedule; at the end of
 * a desktop session every process of the app may be signalled at once, and
 * the app can end, its helper processes gone, before Chromium got to it.
 */
export function saveWindowState(): void {
  session.defaultSession.flushStorageData();
}

let saveSoon: NodeJS.Timeout | null = null;
/** The window changed a remembered preference: on disk within a moment. */
export function windowStateChanged(): void {
  if (saveSoon) return;
  saveSoon = setTimeout(() => {
    saveSoon = null;
    saveWindowState();
  }, 200);
}
