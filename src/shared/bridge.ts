import type { TrpcTransport } from './trpc-ipc/protocol';

/** Everything the preload script exposes to windows, as `window.bridge`. */
export interface PreloadBridge {
  trpc: TrpcTransport;
  /**
   * The path of a file dropped on the window (spec §6.16), from Electron's
   * webUtils; empty for a file that isn't on disk.
   */
  pathForFile: (file: File) => string;
}
