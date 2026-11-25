/**
 * The helper executable (spec §16): Claude Code's hooks and status line run
 * it, and the command line tool's `add` goes through it. Compiled with
 * `bun build --compile` (scripts/build-helper.ts); it must start in well under
 * 100 ms, so it imports nothing but the brand constants.
 *
 *   <helper> hook <event>     stdin: hook JSON. POSTs it to the bridge; always exits 0, prints nothing.
 *   <helper> statusline       stdin: status line JSON. Forwards rate_limits, prints the profile's own status line.
 *   <helper> add [path] …     The command line tool (§7.5).
 *   <helper> link <project>   Links a repository to the workspace it runs in (§21.9).
 *   <helper> projects         The profile's projects (§21.9).
 *   <helper> merge [--yes] …  Merges the workspace's pull requests on their hosts (§21.10).
 *   <helper> apply-update <plan.json>   Replaces the app after it quit, with a staged update (§15.7).
 *   <helper> identity app|appimage <path>   Prints an app's id and version, as an update checks them (§15.7).
 */
import { BRAND, envVar } from '../shared/brand';
import { runAdd } from './add';
import { runIdentity } from './app-identity';
import { runApplyUpdate } from './apply-update';
import { readStdin } from './bridge';
import { runHook } from './hook';
import { runLink, runProjects } from './link';
import { runMerge } from './merge';
import { runStatusLine } from './statusline';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case 'hook':
      return runHook(args[0] ?? '', await readStdin().catch(() => ''), process.env);
    case 'statusline':
      return runStatusLine(await readStdin().catch(() => ''), process.env);
    case 'add':
      return runAdd(args);
    case 'link':
      return runLink(args);
    case 'projects':
      return runProjects(args);
    case 'merge':
      return runMerge(args);
    case 'apply-update':
      return runApplyUpdate(args);
    case 'identity':
      return runIdentity(args);
    case '--version':
      process.stdout.write(`${process.env[envVar('APP_VERSION')] ?? ''}\n`);
      return 0;
    default:
      process.stderr.write(
        `usage: ${BRAND.helperCommand} hook <event> | statusline | add [path] | link <project> | projects | merge\n`,
      );
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  // Hooks and the status line must never fail Claude.
  () => process.exit(command === 'hook' || command === 'statusline' ? 0 : 1),
);
