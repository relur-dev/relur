import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { envVar } from './src/shared/brand';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

/**
 * The React refresh preamble that Vite injects in dev is an inline script, so
 * the dev server relaxes script-src. Production builds keep the strict CSP.
 */
function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
  };
}

/**
 * The renderer's dev server port, when the e2e driver gives one: the window's
 * local storage belongs to its origin, port included, so a restarted app must
 * load from the same port to find what it remembered. Otherwise Vite takes the
 * first free port from 5173, which suites running at once share.
 */
function devServer() {
  const port = Number(process.env[envVar('DEV_RENDERER_PORT')]);
  return port ? { port, strictPort: true } : undefined;
}

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
  },
  renderer: {
    resolve: {
      alias: {
        ...alias,
        // Monaco's icon font (the diff's +/− signs); its ESM editor API doesn't load it.
        'monaco-codicon.css': resolve(
          __dirname,
          'node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css',
        ),
      },
    },
    plugins: [react(), tailwindcss(), devCsp()],
    server: devServer(),
  },
});
