import type { PreloadBridge } from '@shared/bridge';
import { TERMINAL_PORT_CHANNEL, type TerminalPortInfo } from '@shared/terminal-protocol';
import { type ServerMessage, TRPC_CHANNEL } from '@shared/trpc-ipc/protocol';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const bridge: PreloadBridge = {
  trpc: {
    send: (message) => ipcRenderer.send(TRPC_CHANNEL, message),
    onMessage: (listener) => {
      ipcRenderer.removeAllListeners(TRPC_CHANNEL);
      ipcRenderer.on(TRPC_CHANNEL, (_event, message: ServerMessage) => listener(message));
    },
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('bridge', bridge);

// MessagePorts can't cross the context bridge; hand them to the page with
// window.postMessage instead (see shared/terminal-protocol.ts).
ipcRenderer.on(TERMINAL_PORT_CHANNEL, (event, info: TerminalPortInfo) => {
  window.postMessage({ channel: TERMINAL_PORT_CHANNEL, ...info }, '*', event.ports);
});
