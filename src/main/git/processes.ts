import type { ChildProcess } from 'node:child_process';

/**
 * Every git process the app started and that still runs, each the leader of
 * its own process group (the ssh it started is in that group). Quitting stops
 * them all, so none outlives the app (spec §5, §16).
 */
const running = new Set<ChildProcess>();
let stopping = false;

/** Whether git may start: not once the app is quitting. */
export function gitMayStart(): boolean {
  return !stopping;
}

/** Keeps `child` (spawned `detached`, so it leads a group) until it has closed. */
export function trackGit(child: ChildProcess): void {
  if (!child.pid) return;
  running.add(child);
  child.once('close', () => running.delete(child));
  child.once('error', () => running.delete(child));
}

export function runningGitCount(): number {
  return running.size;
}

/** Sends `signal` to the whole process group of `child`. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

const closed = (child: ChildProcess) =>
  running.has(child)
    ? new Promise<void>((resolve) => child.once('close', () => resolve()))
    : Promise.resolve();

/**
 * At quit (spec §5): no git starts any more; each running one's group gets
 * SIGTERM, then SIGKILL after `graceMs`, and this resolves once they have
 * closed (at most about `graceMs` + 1 s).
 */
export async function stopGitProcesses(graceMs = 1500): Promise<void> {
  stopping = true;
  const children = [...running];
  if (children.length === 0) return;
  for (const child of children) signalGroup(child, 'SIGTERM');
  const all = Promise.all(children.map(closed));
  const timeout = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
  await Promise.race([all, timeout(graceMs)]);
  for (const child of children) if (running.has(child)) signalGroup(child, 'SIGKILL');
  await Promise.race([all, timeout(1000)]);
}

/** The last resort as the process exits: SIGKILL to every group still running. */
export function killGitProcessesNow(): void {
  stopping = true;
  for (const child of running) signalGroup(child, 'SIGKILL');
}

/** For tests: lets git start again. */
export function resetGitProcessesForTests(): void {
  stopping = false;
}
