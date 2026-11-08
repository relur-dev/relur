import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { EnvService } from '../env/service';
import { aliasLine, appendLineOnce, shellKind, shellRcFile } from '../profiles/alias';
import { ProfileService } from './profiles';

let home: string;
let config: ConfigStore;
let profiles: ProfileService;
let file: string;

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const calls = () =>
  fs.existsSync(path.join(home, 'calls.txt'))
    ? fs.readFileSync(path.join(home, 'calls.txt'), 'utf8').trim().split('\n')
    : [];

/** A Claude config folder; `used` writes the `.claude.json` Claude creates on first use. */
function folder(name: string, state: { used?: boolean; signedIn?: boolean } = {}) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir);
  if (state.used ?? true) fs.writeFileSync(path.join(dir, '.claude.json'), '{}');
  if (state.signedIn) fs.writeFileSync(path.join(dir, 'fake-login'), '');
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Made-up account values.
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
echo "$* $dir" >> "$HOME/calls.txt"
case "$1" in
  --version) echo '9.9.9 (Claude Code)' ;;
  auth) if [ -f "$dir/fake-login" ]; then printf '{"loggedIn":true,"email":"test@example.com","configDirectory":"%s"}' "$dir"; else printf '{"loggedIn":false}'; exit 1; fi ;;
esac
`,
    { mode: 0o755 },
  );
  file = path.join(home, 'config', 'config.json');
  config = new ConfigStore(file);
  config.load();
  const env = new EnvService(
    config,
    Promise.resolve({
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      shell: '/bin/zsh',
      source: 'login-shell',
    }),
  );
  profiles = new ProfileService(config, env);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('ProfileService', () => {
  it('lists ~/.claude and ~/.claude-* with their state, running nothing in unused folders', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    folder('.claude', { used: false, signedIn: true });
    folder('.claude-work', { signedIn: true });
    folder('.claude-old');
    folder('.claude-empty', { used: false });
    folder('.claudette');
    fs.writeFileSync(path.join(home, '.claude-file'), '');

    const listed = await profiles.accountFolders();
    expect(listed.map((f) => [f.folder, f.state, f.email])).toEqual([
      ['~/.claude', 'signed-in', 'test@example.com'],
      ['~/.claude-empty', 'not-used', null],
      ['~/.claude-old', 'signed-out', null],
      ['~/.claude-work', 'signed-in', 'test@example.com'],
    ]);
    expect(calls().some((c) => c.includes('.claude-empty'))).toBe(false);
    expect(fs.readdirSync(path.join(home, '.claude-empty'))).toEqual([]);
  });

  it('creates a profile for each account choice, keeping unknown fields', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...read(), note: 'mine' }));
    config.reload();
    const existing = folder('.claude-work', { signedIn: true });

    const a = await profiles.create({
      name: 'Default',
      color: 'blue',
      account: { kind: 'default' },
    });
    const b = await profiles.create({
      name: 'Work',
      color: 'teal',
      account: { kind: 'existing', folder: existing },
    });
    const c = await profiles.create({
      name: 'Side project',
      color: 'green',
      account: { kind: 'new' },
    });

    expect([a.id, b.id, c.id]).toEqual(['default', 'work', 'side-project']);
    // The suspend delay is written: the default, as chosen (spec §9.8).
    expect(read().profiles).toEqual([
      { id: 'default', name: 'Default', color: 'blue', env: {}, suspendIdleMin: 10 },
      {
        id: 'work',
        name: 'Work',
        color: 'teal',
        env: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
        suspendIdleMin: 10,
      },
      {
        id: 'side-project',
        name: 'Side project',
        color: 'green',
        env: { CLAUDE_CONFIG_DIR: '~/.claude-side-project' },
        suspendIdleMin: 10,
      },
    ]);
    expect(read().note).toBe('mine');
    expect(fs.readdirSync(path.join(home, '.claude-side-project'))).toEqual([]);
    expect(
      (await profiles.accountFolders()).find((f) => f.folder === '~/.claude-work')?.usedBy,
    ).toEqual(['work']);
  });

  it('refuses a new account whose folder exists, and stores ~/.claude as the default', async () => {
    folder('.claude-work');
    await expect(
      profiles.create({ name: 'Work', color: 'blue', account: { kind: 'new' } }),
    ).rejects.toThrow(/already exists.*existing login/);
    expect(read().profiles).toEqual([]);

    folder('.claude', { used: false });
    await profiles.create({
      name: 'Main',
      color: 'blue',
      account: { kind: 'existing', folder: '~/.claude' },
    });
    expect(read().profiles[0].env).toEqual({});
  });

  it('edits name and color, and removes only a profile without projects', async () => {
    await profiles.create({ name: 'Work', color: 'blue', account: { kind: 'default' } });
    const raw = read();
    raw.profiles[0].extra = 1;
    raw.projects = [{ id: 'p', profileId: 'work', name: 'p', repoPath: '/r' }];
    fs.writeFileSync(file, JSON.stringify(raw));
    config.reload();

    profiles.update('work', { name: 'Job', color: 'olive' });
    expect(read().profiles[0]).toMatchObject({ name: 'Job', color: 'olive', extra: 1 });
    profiles.update('work', { name: 'Job', color: 'plum' });
    expect(read().profiles[0]).toMatchObject({ color: 'plum' });
    expect(() => profiles.update('work', { name: 'Job', color: 'mauve' })).toThrow(
      /Unknown color "mauve"/,
    );
    expect(read().profiles[0]).toMatchObject({ color: 'plum' });
    expect(profiles.removalRefusal('work')).toBe('Job still has 1 project');
    expect(() => profiles.remove('work')).toThrow(/still has 1 project/);

    config.update((r) => {
      r.projects = [];
    });
    profiles.remove('work');
    expect(read().profiles).toEqual([]);
  });

  it('moves a profile to a new position in config.json, keeping its fields', async () => {
    for (const name of ['A', 'B', 'C']) {
      await profiles.create({ name, color: 'blue', account: { kind: 'default' } });
    }
    const order = () => read().profiles.map((p: { id: string }) => p.id);
    profiles.move('c', 0);
    expect(order()).toEqual(['c', 'a', 'b']);
    profiles.move('c', 1);
    expect(order()).toEqual(['a', 'c', 'b']);
    profiles.move('a', 99);
    expect(order()).toEqual(['c', 'b', 'a']);
    expect(read().profiles[2]).toEqual({
      id: 'a',
      name: 'A',
      color: 'blue',
      env: {},
      suspendIdleMin: 10,
    });
    expect(() => profiles.move('nope', 0)).toThrow(/Unknown profile/);
  });

  it('writes alerts and the status line command only when they change', async () => {
    await profiles.create({ name: 'Work', color: 'blue', account: { kind: 'default' } });
    const off = {
      needsPermission: false,
      needsInput: false,
      awaitingApproval: false,
      done: false,
      error: false,
    };
    // All sounds are off by default.
    expect(profiles.update('work', { name: 'Work', color: 'blue' }).alerts.sounds).toEqual(off);
    profiles.update('work', {
      name: 'Work',
      color: 'blue',
      alerts: { sounds: off, doNotDisturb: false },
      statusLine: '',
    });
    expect(read().profiles[0]).toEqual({
      id: 'work',
      name: 'Work',
      color: 'blue',
      env: {},
      suspendIdleMin: 10,
    });
    // The old single switch isn't carried over, and goes once sounds are set.
    config.update((raw) => {
      (raw.profiles as { alerts?: unknown }[])[0] = {
        ...(raw.profiles as object[])[0],
        alerts: { sound: true },
      };
    });
    expect(config.get().config?.profiles[0]?.alerts.sounds).toEqual(off);
    profiles.update('work', {
      name: 'Work',
      color: 'blue',
      alerts: { sounds: { ...off, done: true }, doNotDisturb: true },
      statusLine: ' ~/bin/line.sh ',
    });
    expect(read().profiles[0]).toMatchObject({
      alerts: { sounds: { ...off, done: true }, doNotDisturb: true },
      claude: { statusLine: '~/bin/line.sh' },
    });
    expect(read().profiles[0].alerts).not.toHaveProperty('sound');
    profiles.update('work', { name: 'Work', color: 'blue', statusLine: null });
    expect(read().profiles[0]).not.toHaveProperty('claude');
    // Ask before Claude links a repository: on by default, so only off is written.
    expect(
      profiles.update('work', { name: 'Work', color: 'blue', askBeforeLink: true }).claude,
    ).toMatchObject({ askBeforeLink: true });
    expect(read().profiles[0]).not.toHaveProperty('claude');
    profiles.update('work', { name: 'Work', color: 'blue', askBeforeLink: false });
    expect(read().profiles[0]).toMatchObject({ claude: { askBeforeLink: false } });
    profiles.update('work', { name: 'Work', color: 'blue', askBeforeLink: true });
    expect(read().profiles[0]).not.toHaveProperty('claude');
  });

  it('writes the suspend delay, and Off as 0 (spec §9.8)', async () => {
    await profiles.create({ name: 'Work', color: 'blue', account: { kind: 'default' } });
    const update = (suspendIdleMin: 0 | 5 | 10 | 30) =>
      profiles.update('work', { name: 'Work', color: 'blue', suspendIdleMin });
    update(0);
    expect(read().profiles[0].suspendIdleMin).toBe(0);
    update(30);
    expect(read().profiles[0].suspendIdleMin).toBe(30);
    // Left out, it stays as it is.
    profiles.update('work', { name: 'Work', color: 'blue' });
    expect(read().profiles[0].suspendIdleMin).toBe(30);
  });

  it('keeps the commit identity: both fields or none (spec §3.1)', async () => {
    await profiles.create({ name: 'Work', color: 'blue', account: { kind: 'default' } });
    const update = (git: { commitName: string; commitEmail: string } | null) =>
      profiles.update('work', { name: 'Work', color: 'blue', git });
    update(null);
    expect(read().profiles[0]).not.toHaveProperty('git');
    expect(() => update({ commitName: 'Ada', commitEmail: ' ' })).toThrow(
      /both a name and an email/,
    );
    update({ commitName: ' Ada Example ', commitEmail: 'ada@example.com' });
    expect(read().profiles[0].git).toEqual({
      commitName: 'Ada Example',
      commitEmail: 'ada@example.com',
    });
    update({ commitName: '', commitEmail: '' });
    expect(read().profiles[0]).not.toHaveProperty('git');
  });

  it('writes the PR commands, removing empty ones and keeping the other pr fields', async () => {
    await profiles.create({ name: 'Work', color: 'blue', account: { kind: 'default' } });
    const update = (createCommand: string, statusCommand: string) =>
      profiles.update('work', {
        name: 'Work',
        color: 'blue',
        pr: { createCommand, statusCommand },
      });
    update(' ', '');
    expect(read().profiles[0]).not.toHaveProperty('pr');
    update(' gh pr create --fill ', 'pr-status.sh');
    expect(read().profiles[0].pr).toEqual({
      createCommand: 'gh pr create --fill',
      statusCommand: 'pr-status.sh',
    });
    config.update((raw) => {
      (
        (raw.profiles as { pr: Record<string, unknown> }[])[0] as { pr: Record<string, unknown> }
      ).pr.timeoutSec = 30;
    });
    update('', 'pr-status.sh');
    expect(read().profiles[0].pr).toEqual({ statusCommand: 'pr-status.sh', timeoutSec: 30 });
    update('', '');
    expect(read().profiles[0].pr).toEqual({ timeoutSec: 30 });
  });

  it('offers the alias for a profile with its own folder and appends it once', async () => {
    await profiles.create({ name: 'Default', color: 'blue', account: { kind: 'default' } });
    await profiles.create({ name: 'Side', color: 'green', account: { kind: 'new' } });
    expect(await profiles.alias('default')).toBeNull();

    const rc = path.join(home, '.zshrc');
    fs.writeFileSync(rc, 'export A=1');
    const alias = await profiles.alias('side');
    expect(alias).toEqual({
      line: "alias claude-side='CLAUDE_CONFIG_DIR=~/.claude-side claude'",
      file: rc,
      fileShown: '~/.zshrc',
      present: false,
    });
    expect(await profiles.addAlias('side')).toEqual({ added: true });
    expect(await profiles.addAlias('side')).toEqual({ added: false });
    expect(fs.readFileSync(rc, 'utf8')).toBe(
      "export A=1\nalias claude-side='CLAUDE_CONFIG_DIR=~/.claude-side claude'\n",
    );
    expect((await profiles.alias('side'))?.present).toBe(true);
  });
});

describe('alias helpers', () => {
  it('writes the line for each shell and picks its startup file', () => {
    expect(aliasLine('x', '~/.claude-x', shellKind('/bin/bash'))).toBe(
      "alias claude-x='CLAUDE_CONFIG_DIR=~/.claude-x claude'",
    );
    expect(aliasLine('x', '~/.claude-x', shellKind('/usr/local/bin/fish'))).toBe(
      "alias claude-x 'env CLAUDE_CONFIG_DIR=$HOME/.claude-x claude'",
    );
    expect(aliasLine('x', "/odd path/it's", 'zsh')).toBeNull();
    expect(shellRcFile('zsh', { ZDOTDIR: '/z' }, '/h')).toBe('/z/.zshrc');
    expect(shellRcFile('bash', {}, '/h')).toBe('/h/.bashrc');
    expect(shellRcFile('fish', {}, '/h')).toBe('/h/.config/fish/config.fish');
    expect(shellRcFile(shellKind('/bin/tcsh'), {}, '/h')).toBeNull();
  });

  it('creates a missing startup file and its folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
    try {
      const fish = path.join(dir, '.config', 'fish', 'config.fish');
      expect(appendLineOnce(fish, 'alias a b')).toBe(true);
      expect(fs.readFileSync(fish, 'utf8')).toBe('alias a b\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
