import readline from 'node:readline';
import type { MergeCliResponse } from '../main/bridge/server';
import { BRAND, envVar } from '../shared/brand';
import {
  MERGE_METHOD_LABEL,
  type MergePrsPreflight,
  type MergePrsReport,
  NO_UNDO_TEXT,
  reportSummary,
} from '../shared/merge-prs';
import { callApp, type Output, stdio } from './bridge';

const USAGE = `usage: ${BRAND.cliCommand} merge [--yes] [--order <repo>,<repo>…] [--method <repo>=squash|merge|rebase]… [--keep-branch]`;
/** The preflight fetches and runs a status command per repository. */
const PREFLIGHT_TIMEOUT_MS = 5 * 60 * 1000;
/** Merging waits for the confirmation in the app (10 minutes at most), then for each host in turn. */
const MERGE_TIMEOUT_MS = 70 * 60 * 1000;

export interface MergeArgs {
  yes: boolean;
  order: string[];
  methods: Record<string, string>;
  deleteBranch: boolean;
}

/** The command line's options, or why they are wrong. */
export function parseMergeArgs(args: string[]): MergeArgs | { error: string } | 'help' {
  const out: MergeArgs = { yes: false, order: [], methods: {}, deleteBranch: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = () => {
      const [, inline] = arg.split(/=(.*)/s);
      if (arg.includes('=') && arg.startsWith('--order')) return inline ?? '';
      return args[++i] ?? '';
    };
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--keep-branch') out.deleteBranch = false;
    else if (arg === '--order' || arg.startsWith('--order=')) {
      out.order = value()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (out.order.length === 0) return { error: '--order needs repository names' };
    } else if (arg === '--method') {
      const [repo, method] = (args[++i] ?? '').split('=');
      if (!repo || !method) return { error: '--method takes <repo>=<method>' };
      out.methods[repo] = method;
    } else return { error: `Unknown option ${arg}` };
  }
  return out;
}

const MARK = { ready: '✓', merged: '✓', failed: '✕' } as const;

/** The preflight as a table: one line per repository, its problems under it. */
export function preflightLines(branch: string, p: MergePrsPreflight): string[] {
  const width = Math.max(0, ...p.repos.map((r) => r.name.length));
  const lines = [`Merge all PRs of ${branch}, in this order:`];
  p.repos.forEach((r, i) => {
    const method = r.method && r.result !== 'merged' ? MERGE_METHOD_LABEL[r.method] : '';
    const state = r.result === 'merged' ? 'merged already, skipped' : r.result;
    lines.push(
      `  ${i + 1}. ${r.name.padEnd(width)}  ${r.branch} → ${r.baseBranch}  ${MARK[r.result]} ${state}${
        method ? ` · ${method}` : ''
      }${r.prUrl ? `  ${r.prUrl}` : ''}`,
    );
    for (const problem of r.problems) lines.push(`       ${problem}`);
  });
  return lines;
}

/** The report: one line per repository, then the summary. */
export function reportLines(report: MergePrsReport): string[] {
  const lines = report.repos.map((r) => {
    switch (r.outcome) {
      case 'merged': {
        const commit = r.commitUrl ?? r.commit;
        const branch =
          r.branchDeleted === true
            ? ', remote branch deleted'
            : r.branchDeleted === false
              ? `; couldn't delete the remote branch: ${r.deleteError}`
              : '';
        const warning = r.warning ? `\n  ⚠ ${r.warning}` : '';
        return `✓ ${r.name}: merged${commit ? ` (${commit})` : ''}${r.prUrl ? `  ${r.prUrl}` : ''}${branch}${warning}`;
      }
      case 'already-merged':
        return `✓ ${r.name}: merged already`;
      case 'failed':
        return `✕ ${r.name}: ${r.reason ?? 'failed'}`;
      case 'skipped':
        return `– ${r.name}: skipped`;
    }
    return '';
  });
  lines.push(reportSummary(report));
  if (report.stopped && report.repos.some((r) => r.outcome === 'merged')) {
    lines.push('The pull requests merged before the failure stay merged.');
  }
  return lines;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * `<slug> merge` (spec §21.10): Merge all PRs from a workspace's Claude or
 * terminals. Prints the preflight; when every repository passes, asks
 * (unless `--yes`), then waits for the merge to be confirmed in the app,
 * which merges in order, and prints the report. Exit codes: 0
 * merged (or nothing left to merge), 1 refused, a failed preflight or
 * stopped, 2 the app isn't running.
 */
export async function runMerge(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Output = stdio,
  ask: (question: string) => Promise<boolean> | null = (q) =>
    process.stdin.isTTY ? confirm(q) : null,
): Promise<number> {
  const parsed = parseMergeArgs(args);
  if (parsed === 'help') {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if ('error' in parsed) {
    io.err(`${parsed.error}\n${USAGE}\n`);
    return 1;
  }
  const request = {
    workspaceId: env[envVar('WORKSPACE_ID')] ?? null,
    order: parsed.order,
    methods: parsed.methods,
    deleteBranch: parsed.deleteBranch,
    byClaude: Boolean(env.CLAUDECODE),
  };
  const checked = await callApp<MergeCliResponse>(
    env,
    '/merge',
    { ...request, action: 'preflight' },
    PREFLIGHT_TIMEOUT_MS,
    io,
  );
  if (checked === 2) return 2;
  if (!checked.ok) {
    io.err(`${checked.error}\n`);
    return 1;
  }
  const preflight = checked.preflight as MergePrsPreflight;
  io.out(`${preflightLines(checked.branch, preflight).join('\n')}\n`);
  if (preflight.repos.some((r) => r.result === 'failed')) {
    io.err('Not merging: fix the problems above, then run it again.\n');
    return 1;
  }
  const ready = preflight.repos.filter((r) => r.result === 'ready').length;
  if (ready === 0) {
    io.out('Nothing to merge: every pull request was merged already.\n');
    return 0;
  }
  io.out(`${NO_UNDO_TEXT}\n`);
  if (!parsed.yes) {
    const answer = ask(`Merge ${ready} pull request${ready === 1 ? '' : 's'}? [y/N] `);
    if (answer === null) {
      io.err('Run it with --yes to merge: there is no terminal to ask in.\n');
      return 1;
    }
    if (!(await answer)) {
      io.err('Nothing was merged.\n');
      return 1;
    }
  }
  // Only a click in the app merges (spec §21.10): --yes skips the question above, not that.
  io.out(`Waiting for you to confirm in ${BRAND.displayName} (up to 10 minutes)…\n`);
  const done = await callApp<MergeCliResponse>(
    env,
    '/merge',
    // Merge in the order shown: the preflight's.
    { ...request, order: preflight.repos.map((r) => r.projectId), action: 'merge' },
    MERGE_TIMEOUT_MS,
    io,
  );
  if (done === 2) return 2;
  if (!done.ok) {
    io.err(`${done.error}\n`);
    return 1;
  }
  const report = done.report as MergePrsReport;
  io.out(`${reportLines(report).join('\n')}\n`);
  return report.stopped ? 1 : 0;
}
