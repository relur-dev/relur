import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../test-support/git-fixtures';
import { Git, gitReason } from './git';
import { resetGitProcessesForTests, runningGitCount, stopGitProcesses } from './processes';

let fx: Fixture;

beforeAll(() => {
  fx = createFixture();
});
afterAll(() => fx.cleanup());
afterEach(() => resetGitProcessesForTests());

describe('git processes at quit (spec §5)', () => {
  it('stops every running git with what it started, and starts none after', async () => {
    // A git that starts a child, as fetch starts ssh, and ignores SIGTERM.
    const slow = path.join(fx.root, 'slow-git');
    fs.writeFileSync(
      slow,
      `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho $! > "${fx.root}/child"\nwait\n`,
      { mode: 0o755 },
    );
    const git = new Git({ gitPath: slow, env: fx.env });
    const running = git.run(fx.root, ['status']).catch((e: unknown) => e);
    const childFile = path.join(fx.root, 'child');
    while (!fs.existsSync(childFile) || !fs.readFileSync(childFile, 'utf8').trim()) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runningGitCount()).toBe(1);
    const started = Date.now();
    await stopGitProcesses(300);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(runningGitCount()).toBe(0);
    await running;
    const child = Number(fs.readFileSync(childFile, 'utf8'));
    expect(() => process.kill(child, 0)).toThrow();
    expect(gitReason(await git.run(fx.root, ['status']).catch((e: unknown) => e))).toBe(
      'not started: the app is quitting',
    );
  });
});
