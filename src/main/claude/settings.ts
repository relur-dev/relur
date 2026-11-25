import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '@shared/brand';

/** The hook events the app listens to (spec §9.3). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

const TOOL_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse'];

/**
 * The ask rules for linking (spec §21.9): the command line tool and the
 * helper's own subcommand, so calling the helper directly asks too. Claude
 * Code matches them by the command's name, so a full path (quoted, with
 * spaces) asks as well (checked live).
 */
export const LINK_ASK_RULES = [
  `Bash(${BRAND.cliCommand} link:*)`,
  `Bash(${BRAND.helperCommand} link:*)`,
];

/**
 * The ask rules for merging pull requests (spec §21.10): always set, so
 * Claude Code asks before Claude runs `<slug> merge`, `--yes` or not.
 */
export const MERGE_ASK_RULES = [
  `Bash(${BRAND.cliCommand} merge:*)`,
  `Bash(${BRAND.helperCommand} merge:*)`,
];

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The settings file passed to every workspace's Claude with `--settings`
 * (spec §9.1, §9.3). It lives in the app data dir and is rewritten on every
 * app start. Each hook event runs `<helper> hook <event>`, and the status
 * line runs `<helper> statusline`, which prints the profile's own one.
 *
 * With `askBeforeLink`, ask permission rules make Claude ask before it runs
 * `<slug> link` or `<helper> link` (spec §21.9), in auto mode too. Claude
 * always asks before `<slug> merge` (spec §21.10).
 *
 * `markersDir` is the §9.3 smoke test (dev flag `<PREFIX>SMOKE_MARKERS`):
 * every event also appends its name to `injected.log` there, and the status
 * line prints `injected-statusline` and appends to `statusline.log`.
 */
export function claudeSettings({
  helper,
  markersDir,
  askBeforeLink = false,
}: {
  helper?: string | null;
  markersDir?: string;
  askBeforeLink?: boolean;
} = {}): Record<string, unknown> {
  const permissions = {
    permissions: { ask: [...(askBeforeLink ? LINK_ASK_RULES : []), ...MERGE_ASK_RULES] },
  };
  const log = (file: string, text: string) =>
    `printf '%s\\n' ${quote(text)} >> ${quote(path.join(markersDir ?? '', file))}`;
  const commands = (event: string) => [
    ...(helper ? [{ type: 'command', command: `${quote(helper)} hook ${event}` }] : []),
    ...(markersDir ? [{ type: 'command', command: log('injected.log', event) }] : []),
  ];
  if (!helper && !markersDir) return permissions;
  return {
    ...permissions,
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ ...(TOOL_EVENTS.includes(event) ? { matcher: '*' } : {}), hooks: commands(event) }],
      ]),
    ),
    statusLine: {
      type: 'command',
      command: markersDir
        ? `${log('statusline.log', 'injected')}; printf 'injected-statusline'`
        : `${quote(helper ?? '')} statusline`,
    },
  };
}

/** Writes a settings file and returns its path. */
export function writeClaudeSettings(
  dataDir: string,
  settings = claudeSettings(),
  name = 'settings.json',
): string {
  const file = path.join(dataDir, 'claude', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return file;
}
