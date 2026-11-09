import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BRAND } from '@shared/brand';
import type { Release } from '@shared/updates';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeDummyPackage } from '../test-support/dummy-app';
import { downloadFile } from './download';
import type { UpdateWay } from './install';
import { type InstallState, UpdateInstaller } from './installer';
import { updateRoot } from './stage';

const mac = process.platform === 'darwin';
const asset = mac ? 'App-mac-arm64.zip' : 'App-linux-x64.AppImage';

let dir: string;
let dataDir: string;
let server: http.Server;
let base: string;
/** What the server serves, by path; `slow` sends the asset in pieces. */
let files: Record<string, Buffer>;
let slow = false;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  files = {};
  slow = false;
  server = http.createServer(async (req, res) => {
    const body = files[req.url ?? ''];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    if (!slow) {
      res.end(body);
      return;
    }
    for (let i = 0; i < body.length && !res.destroyed; i += 1024) {
      res.write(body.subarray(i, i + 1024));
      await new Promise((r) => setTimeout(r, 20));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A release of `version` with the dummy package and its SHA256SUMS on the server. */
function publish(version: string, { badSum = false } = {}): Release {
  const { file } = makeDummyPackage(path.join(dir, 'release', version), asset, {
    version,
    marker: path.join(dir, 'started'),
  });
  const body = fs.readFileSync(file);
  const digest = badSum ? 'f'.repeat(64) : createHash('sha256').update(body).digest('hex');
  files[`/${version}/${asset}`] = body;
  files[`/${version}/SHA256SUMS`] = Buffer.from(`${digest}  ${asset}\n`);
  return {
    version,
    url: 'https://example.com/release',
    assets: {
      [asset]: `${base}/${version}/${asset}`,
      SHA256SUMS: `${base}/${version}/SHA256SUMS`,
    },
  };
}

const self: UpdateWay = {
  kind: 'self',
  app: mac ? 'app' : 'appimage',
  target: path.join(os.tmpdir(), 'never-replaced'),
  asset,
};

function installer(overrides: { way?: UpdateWay; helper?: string | null } = {}) {
  let quits = 0;
  const it = new UpdateInstaller({
    dataDir,
    version: '1.0.0',
    way: overrides.way ?? self,
    helper: overrides.helper ?? null,
    allowHttp: true,
    quit: () => {
      quits++;
    },
    launchEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: dir }),
    launch: 'exec',
    pid: 4242,
  });
  const states: InstallState[] = [];
  it.onChange(() => states.push(it.view().install));
  return { it, states, quits: () => quits };
}

describe('downloadFile', () => {
  it('refuses a plain http link unless allowed', async () => {
    await expect(
      downloadFile(`${base}/x`, path.join(dir, 'x'), {
        userAgent: 'test',
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow('Not an https link');
  });

  it('stops while a piece is being written, without an error after it, and keeps nothing', async () => {
    files['/big'] = Buffer.alloc(64 * 1024);
    slow = true;
    const file = path.join(dir, 'big');
    const abort = new AbortController();
    // Cancel right after a piece went to the file, while its write is still under way.
    await expect(
      downloadFile(`${base}/big`, file, {
        userAgent: 'test',
        signal: abort.signal,
        allowHttp: true,
        onProgress: ({ received }) => {
          if (received >= 4 * 1024) abort.abort();
        },
      }),
    ).rejects.toThrow();
    // An error from the destroyed stream would surface as an uncaught exception here.
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.part`)).toBe(false);
  });
});

describe('UpdateInstaller', () => {
  it('downloads with progress, checks, stages and is ready', async () => {
    const { it: inst, states } = installer();
    await inst.install(publish('2.0.0'));
    expect(inst.view().install).toEqual({ phase: 'ready', version: '2.0.0', later: false });
    expect(states[0]).toEqual({ phase: 'downloading', version: '2.0.0', received: 0, total: null });
    const last = states.filter((s) => s.phase === 'downloading').at(-1);
    expect(last).toMatchObject({ received: files[`/2.0.0/${asset}`]?.length });
    expect(states.some((s) => s.phase === 'checking')).toBe(true);
    // Later keeps it ready, and so does a restart of the app.
    inst.later();
    expect(inst.view().install).toEqual({ phase: 'ready', version: '2.0.0', later: true });
    expect(installer().it.view().install).toEqual({
      phase: 'ready',
      version: '2.0.0',
      later: true,
    });
  });

  it('fails on a checksum that does not match, and removes the download', async () => {
    const { it: inst } = installer();
    await inst.install(publish('2.0.0', { badSum: true }));
    expect(inst.view().install).toEqual({
      phase: 'failed',
      version: '2.0.0',
      reason: `${asset} doesn't match its checksum in SHA256SUMS`,
    });
    expect(fs.existsSync(path.join(updateRoot(dataDir), '2.0.0'))).toBe(false);
    inst.dismissFailure();
    expect(inst.view().install).toEqual({ phase: 'idle' });
  });

  it('fails when the release has no package for this platform', async () => {
    const { it: inst } = installer();
    await inst.install({ version: '2.0.0', url: '', assets: {} });
    expect(inst.view().install).toMatchObject({
      phase: 'failed',
      reason: `The release has no ${asset}`,
    });
  });

  it('Cancel stops the download and keeps nothing', async () => {
    const release = publish('2.0.0');
    // Big enough to still be downloading when Cancel comes (a dummy AppImage is tiny).
    files[`/2.0.0/${asset}`] = Buffer.alloc(512 * 1024);
    slow = true;
    const { it: inst } = installer();
    const running = inst.install(release);
    for (let i = 0; i < 100 && inst.view().install.phase !== 'downloading'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 100));
    inst.cancel();
    await running;
    expect(inst.view().install).toEqual({ phase: 'idle' });
    expect(fs.existsSync(path.join(updateRoot(dataDir), '2.0.0'))).toBe(false);
  });

  it('Restart now quits; the helper starts only at a normal quit, with the plan', async () => {
    // A stand-in helper that records how it was started.
    const helper = path.join(dir, 'helper');
    const args = path.join(dir, 'args');
    fs.writeFileSync(helper, `#!/bin/sh\necho "$@" > '${args}'\n`, { mode: 0o755 });
    const { it: inst, quits } = installer({ helper });
    expect(inst.applyAtQuit({ normalQuit: true })).toBe(false);
    await inst.install(publish('2.0.0'));
    inst.restart();
    expect(quits()).toBe(1);
    expect(inst.applyAtQuit({ normalQuit: false })).toBe(false);
    expect(inst.applyAtQuit({ normalQuit: true })).toBe(true);
    const planFile = path.join(updateRoot(dataDir), 'plan.json');
    for (let i = 0; i < 100 && !fs.existsSync(args); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(fs.readFileSync(args, 'utf8').trim()).toBe(`apply-update ${planFile}`);
    // It holds the user's environment.
    expect(fs.statSync(planFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(planFile, 'utf8'))).toMatchObject({
      pid: 4242,
      target: self.target,
      version: '2.0.0',
      relaunch: true,
      launch: 'exec',
      resultFile: path.join(updateRoot(dataDir), 'result.json'),
    });
    // The helper runs from a copy, outside the app it replaces.
    expect(fs.existsSync(path.join(updateRoot(dataDir), BRAND.helperCommand))).toBe(true);
  });

  it('a cancelled quit question forgets the restart', async () => {
    const helper = path.join(dir, 'helper');
    fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o755 });
    const { it: inst } = installer({ helper });
    await inst.install(publish('2.0.0'));
    inst.restart();
    inst.quitCancelled();
    inst.applyAtQuit({ normalQuit: true });
    const plan = JSON.parse(fs.readFileSync(path.join(updateRoot(dataDir), 'plan.json'), 'utf8'));
    expect(plan.relaunch).toBe(false);
  });

  it('shows a failed replacement at the next start, until dismissed', () => {
    fs.mkdirSync(updateRoot(dataDir), { recursive: true });
    const result = path.join(updateRoot(dataDir), 'result.json');
    fs.writeFileSync(result, JSON.stringify({ version: '2.0.0', ok: false, error: 'no room' }));
    const { it: inst } = installer();
    expect(inst.view().failure).toEqual({ version: '2.0.0', reason: 'no room' });
    inst.dismissFailure();
    expect(inst.view().failure).toBeNull();
    expect(fs.existsSync(result)).toBe(false);
    // A success leaves nothing to show.
    fs.writeFileSync(result, JSON.stringify({ version: '2.0.0', ok: true }));
    expect(installer().it.view().failure).toBeNull();
  });

  it('only a self-updating installation downloads', async () => {
    const { it: inst } = installer({ way: { kind: 'deb' } });
    expect(inst.view().way).toEqual({ kind: 'deb' });
    await expect(inst.install(publish('2.0.0'))).rejects.toThrow(/can't update itself/);
  });
});
