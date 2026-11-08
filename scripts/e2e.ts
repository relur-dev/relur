/**
 * Runs the e2e suites listed in scripts/e2e-suites.json, the only list of
 * them: `npm run e2e`, scripts/linux-check-run.sh and CI's e2e job all run
 * this (spec §15.6). Each suite runs on the production build in out/ and then
 * on the dev server; the first failure stops the run with its exit code. A
 * summary of each run's time is printed at the end.
 *
 *   tsx scripts/e2e.ts [--xvfb] [--jobs n] [--mode prod|dev] [suite…]
 *
 * --xvfb runs each suite under its own `xvfb-run -a` (Linux without a display);
 * --mode runs one of the two only; named suites run alone, in the list's order.
 * --jobs runs up to n suites at once (default 3, or 1 with --xvfb, whose
 * `xvfb-run -a` picks its display racily). Each suite has its own HOME and
 * debugging ports; the ones that use the system clipboard never overlap, and
 * on the dev server a short suite runs alone first so it fills Vite's
 * dependency cache before the others read it. The longest suites start first. With more than one job a suite's output
 * is printed in one piece when it ends.
 * Builds nothing: `npm run build` first.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { E2E_SUITES, suiteFile } from './lib/e2e-suites';

/** Suites that write the system clipboard and paste it: one at a time. */
const CLIPBOARD = new Set(['smoke', 'markers']);

/**
 * The longest suites (a few minutes each), started first when several run at
 * once so none is left running alone at the end. The rest keep the list's order.
 */
const SLOWEST = ['onboarding', 'smoke', 'board', 'suspend'];

/** A suite of a few seconds: on the dev server it fills Vite's dependency cache alone. */
const WARM_UP = 'appearance';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { xvfb: { type: 'boolean' }, mode: { type: 'string' }, jobs: { type: 'string' } },
});
const jobs = values.jobs === undefined ? (values.xvfb ? 1 : 3) : Number(values.jobs);
const unknown = positionals.filter((name) => !E2E_SUITES.includes(name));
if (
  unknown.length > 0 ||
  (values.mode && !['prod', 'dev'].includes(values.mode)) ||
  !Number.isInteger(jobs) ||
  jobs < 1
) {
  console.error(
    `usage: tsx scripts/e2e.ts [--xvfb] [--jobs n] [--mode prod|dev] [suite…]\nsuites: ${E2E_SUITES.join(' ')}`,
  );
  process.exit(2);
}
const suites =
  positionals.length > 0 ? E2E_SUITES.filter((s) => positionals.includes(s)) : E2E_SUITES;
const modes = values.mode ? [values.mode] : ['prod', 'dev'];

const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const times: string[] = [];
const started = Date.now();
const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

interface Failure {
  label: string;
  status: number;
  reason: string;
}

/** Runs one suite; resolves to its failure, or null. */
function runSuite(suite: string, mode: string): Promise<Failure | null> {
  const args = [
    '--tsconfig',
    'tsconfig.node.json',
    suiteFile(suite),
    ...(mode === 'dev' ? ['--dev'] : []),
  ];
  const [command, commandArgs] = values.xvfb ? ['xvfb-run', ['-a', tsx, ...args]] : [tsx, args];
  const label = `${suite}${mode === 'dev' ? ' --dev' : ''}`;
  const buffered = jobs > 1;
  if (!buffered) console.log(`\n=== e2e ${label}`);
  const start = Date.now();
  const child = spawn(command, commandArgs, {
    cwd: root,
    stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const output: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
  return new Promise((resolve) => {
    const done = (status: number, reason: string) => {
      times.push(`${label.padEnd(24)}${minutes(Date.now() - start)}`);
      if (buffered) {
        console.log(`\n=== e2e ${label}`);
        process.stdout.write(Buffer.concat(output));
      }
      resolve(status === 0 ? null : { label, status, reason });
    };
    child.on('error', (error) => done(1, error.message));
    child.on('close', (code, signal) => done(code ?? 1, signal ?? `exit ${code}`));
  });
}

/**
 * Runs the suites of one mode, up to `jobs` at once, never two clipboard
 * suites together. After a failure no new suite starts; the running ones end.
 */
async function runMode(mode: string): Promise<Failure | null> {
  const rank = (s: string) => (SLOWEST.includes(s) ? SLOWEST.indexOf(s) : SLOWEST.length);
  const waiting = jobs > 1 ? [...suites].sort((a, b) => rank(a) - rank(b)) : [...suites];
  const running = new Set<string>();
  let failure: Failure | null = null;
  if (mode === 'dev' && jobs > 1 && waiting.length > 1) {
    const index = waiting.includes(WARM_UP) ? waiting.indexOf(WARM_UP) : waiting.length - 1;
    failure = await runSuite(waiting.splice(index, 1)[0] as string, mode);
    if (failure) return failure;
  }
  await new Promise<void>((finished) => {
    const startNext = () => {
      while (!failure && running.size < jobs) {
        const clipboardBusy = [...running].some((s) => CLIPBOARD.has(s));
        const index = waiting.findIndex((s) => !(CLIPBOARD.has(s) && clipboardBusy));
        if (index < 0) break;
        const [suite] = waiting.splice(index, 1) as [string];
        running.add(suite);
        void runSuite(suite, mode).then((result) => {
          running.delete(suite);
          failure ??= result;
          startNext();
        });
      }
      if (running.size === 0) finished();
    };
    startNext();
  });
  return failure;
}

void (async () => {
  for (const mode of modes) {
    const failure = await runMode(mode);
    if (failure) {
      console.error(`\n=== e2e ${failure.label} failed (${failure.reason})`);
      console.error(times.join('\n'));
      process.exit(failure.status || 1);
    }
  }
  console.log(
    `\n=== e2e passed\n${times.join('\n')}\n${'total'.padEnd(24)}${minutes(Date.now() - started)}`,
  );
})();
