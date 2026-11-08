/**
 * Monaco for the diff viewer (spec §6.4): bundled with the app and loaded on
 * first use, its worker from the app's own files, so nothing comes from the
 * network. Its colors come from the theme tokens (theme.css).
 */
import 'monaco-codicon.css';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** A CSS color (oklch included) as #rrggbbaa, through a canvas. */
function hex(cssColor: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#00000000';
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b, a].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

const token = (name: string) =>
  hex(getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim());

/**
 * Light only: Monaco's light syntax colors that read under 4.5:1 on the light
 * theme's background (spec §6), each replaced by an app text token of the same
 * hue. The dark theme keeps Monaco's own.
 */
const LIGHT_SYNTAX: Record<string, string> = {
  comment: 'diff-add',
  number: 'profile-teal',
  type: 'profile-sky',
  'variable.predefined': 'profile-blue',
  'tag.id.pug': 'profile-blue',
  'tag.class.pug': 'profile-blue',
  'keyword.flow': 'st-approval',
  'predefined.sql': 'st-input',
  constant: 'st-error',
  invalid: 'st-error',
  metatag: 'st-error',
  'metatag.content.html': 'st-error',
  'attribute.name': 'st-error',
  'string.sql': 'st-error',
  annotation: 'fg-subtle',
  'metatag.html': 'fg-subtle',
  'metatag.xml': 'fg-subtle',
  'operator.scss': 'fg-subtle',
  'operator.sql': 'fg-subtle',
  'operator.swift': 'fg-subtle',
};

/** Defines the app's theme from the current tokens and applies it. */
export function applyMonacoTheme(): void {
  const dark = document.documentElement.dataset.theme === 'dark';
  monaco.editor.defineTheme('app', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    // Rules take colors as rrggbb, without # or alpha.
    rules: dark
      ? []
      : Object.entries(LIGHT_SYNTAX).map(([syntax, name]) => ({
          token: syntax,
          foreground: token(name).slice(1, 7),
        })),
    colors: {
      'editor.background': token('term'),
      'editor.foreground': token('fg'),
      'editorLineNumber.foreground': token('fg-subtle'),
      'editorLineNumber.activeForeground': token('fg-muted'),
      'editorGutter.background': token('term'),
      'diffEditor.insertedLineBackground': token('diff-add-bg'),
      'diffEditor.removedLineBackground': token('diff-del-bg'),
      'diffEditor.insertedTextBackground': token('diff-add-bg'),
      'diffEditor.removedTextBackground': token('diff-del-bg'),
      'diffEditorGutter.insertedLineBackground': token('diff-add-bg'),
      'diffEditorGutter.removedLineBackground': token('diff-del-bg'),
      'diffEditor.unchangedRegionBackground': token('band-strong'),
      'diffEditor.unchangedRegionForeground': token('fg-subtle'),
      'editor.lineHighlightBackground': '#00000000',
      'scrollbarSlider.background': token('band-strong'),
    },
  });
  monaco.editor.setTheme('app');
}

/** Monaco's language id for a file, from its name; plain text otherwise. */
export function languageFor(file: string): string {
  const name = file.split('/').pop()?.toLowerCase() ?? '';
  const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
  const language = monaco.languages
    .getLanguages()
    .find(
      (l) =>
        l.filenames?.some((f) => f.toLowerCase() === name) ||
        (ext && l.extensions?.some((e) => e.toLowerCase() === ext)),
    );
  return language?.id ?? 'plaintext';
}

export { monaco };
