import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from './store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  file = path.join(dir, 'nested', 'config.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (data: unknown) => fs.writeFileSync(file, JSON.stringify(data));
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const minimal = { version: 1, profiles: [{ id: 'work', name: 'Work' }] };

describe('ConfigStore', () => {
  it('creates a config without profiles on first load', () => {
    const store = new ConfigStore(file);
    const { config, error } = store.load();
    expect(store.created).toBe(true);
    expect(error).toBeNull();
    expect(config?.profiles).toEqual([]);
    expect(read()).toEqual({ version: 1, profiles: [], projects: [] });
  });

  it('leaves an existing config file as it is on load', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const profiles = [{ id: 'work', name: 'Work', suspendIdleMin: 0 }];
    const text = `${JSON.stringify({ version: 1, profiles, note: 'mine' }, null, 4)}\n`;
    fs.writeFileSync(file, text);
    expect(new ConfigStore(file).load().config?.profiles.map((p) => p.id)).toEqual(['work']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('adds the first profile to an empty config, keeping unknown fields', () => {
    const store = new ConfigStore(file);
    store.load();
    const raw = read();
    write({ ...raw, note: 'mine' });
    const config = store.update((r) => {
      (r.profiles as unknown[]).push({ id: 'work', name: 'Work', color: 'blue', unknown: 1 });
    });
    expect(config.profiles.map((p) => p.id)).toEqual(['work']);
    expect(read().note).toBe('mine');
    expect(read().profiles[0].unknown).toBe(1);
  });

  it('gives profiles that never chose a suspend delay the default on load (spec §9.8)', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    write({
      version: 1,
      note: 'mine',
      profiles: [
        { id: 'unset', name: 'Unset', unknown: 1 },
        { id: 'cleared', name: 'Cleared', suspendIdleMin: null },
        { id: 'off', name: 'Off', suspendIdleMin: 0 },
        { id: 'chosen', name: 'Chosen', suspendIdleMin: 30 },
      ],
    });
    const store = new ConfigStore(file);
    const { config } = store.load();
    expect(store.created).toBe(false);
    expect(store.suspendDefaulted).toEqual([
      { id: 'unset', name: 'Unset' },
      { id: 'cleared', name: 'Cleared' },
    ]);
    expect(config?.profiles.map((p) => p.suspendIdleMin)).toEqual([10, 10, 0, 30]);
    expect(read().profiles.map((p: { suspendIdleMin: number }) => p.suspendIdleMin)).toEqual([
      10, 10, 0, 30,
    ]);
    expect(read().profiles[0].unknown).toBe(1);
    expect(read().note).toBe('mine');
    // The next start finds nothing to change.
    const again = new ConfigStore(file);
    again.load();
    expect(again.suspendDefaulted).toEqual([]);
  });

  it('writes no suspend default into an invalid config', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ version: 2, profiles: [{ id: 'work', name: 'Work' }] });
    fs.writeFileSync(file, text);
    const store = new ConfigStore(file);
    expect(store.load().error).not.toBeNull();
    expect(store.suspendDefaulted).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('converts #rrggbb profile colors to palette names on load, keeping other fields', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    write({
      version: 1,
      note: 'mine',
      profiles: [
        { id: 'work', name: 'Work', color: '#2F6FEB' },
        { id: 'personal', name: 'Personal', color: '#16A34A' },
        { id: 'misc', name: 'Misc', color: '#6B7280' },
      ],
    });
    const { config } = new ConfigStore(file).load();
    expect(config?.profiles.map((p) => p.color)).toEqual(['blue', 'green', 'graphite']);
    expect(read().profiles.map((p: { color: string }) => p.color)).toEqual([
      'blue',
      'green',
      'graphite',
    ]);
    expect(read().note).toBe('mine');
  });

  it('keeps the first palette and the new colors as stored', () => {
    const store = new ConfigStore(file);
    store.load();
    const colors = ['blue', 'olive', 'graphite', 'indigo', 'plum', 'charcoal'];
    write({
      version: 1,
      profiles: colors.map((color, i) => ({ id: `p${i}`, name: `P${i}`, color })),
    });
    expect(store.reload().config?.profiles.map((p) => p.color)).toEqual(colors);
    expect(read().profiles.map((p: { color: string }) => p.color)).toEqual(colors);
  });

  it('falls back to graphite for unknown or missing color names', () => {
    const store = new ConfigStore(file);
    store.load();
    write({
      version: 1,
      profiles: [
        { id: 'a', name: 'A', color: 'pink' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C', color: 'Plum' },
      ],
    });
    expect(store.reload().config?.profiles.map((p) => p.color)).toEqual([
      'graphite',
      'graphite',
      'graphite',
    ]);
  });

  it('applies defaults to a minimal profile', () => {
    const store = new ConfigStore(file);
    store.load();
    write(minimal);
    const profile = store.reload().config?.profiles[0];
    expect(profile?.claude).toEqual({ command: 'claude', args: [], askBeforeLink: true });
    expect(profile?.defaults.baseBranch).toBe('main');
    expect(profile?.env).toEqual({});
  });

  it('keeps the last valid config and reports why the file is invalid', () => {
    const store = new ConfigStore(file);
    store.load();
    write(minimal);
    store.reload();
    fs.writeFileSync(file, '{ not json');
    const broken = store.reload();
    expect(broken.error).toMatch(/JSON/);
    expect(broken.config?.profiles).toHaveLength(1);
    expect(() => store.require()).toThrow(/invalid/);
  });

  it('rejects duplicate ids, unknown profiles and a repository in two profiles', () => {
    const store = new ConfigStore(file);
    store.load();
    write({
      version: 1,
      profiles: [
        { id: 'work', name: 'Work' },
        { id: 'work', name: 'Again' },
      ],
      projects: [
        { id: 'a', profileId: 'work', name: 'a', repoPath: '/r' },
        { id: 'b', profileId: 'nobody', name: 'b', repoPath: '/r' },
      ],
    });
    const { error } = store.reload();
    expect(error).toContain('duplicate profile id "work"');
    expect(error).toContain('unknown profile "nobody"');
    expect(error).toContain('registered more than once');
  });

  it('updates the file on disk, keeping fields it does not know', () => {
    const store = new ConfigStore(file);
    store.load();
    write({
      ...minimal,
      note: 'mine',
      profiles: [{ ...minimal.profiles[0], alerts: { sound: true } }],
    });
    store.reload();
    const config = store.update((raw) => {
      raw.projects = [{ id: 'p', profileId: 'work', name: 'p', repoPath: '/p' }];
    });
    expect(config.projects).toHaveLength(1);
    const onDisk = read();
    expect(onDisk.note).toBe('mine');
    expect(onDisk.profiles[0].alerts).toEqual({ sound: true });
    expect(store.get().config?.projects[0]?.id).toBe('p');
  });

  it('refuses an update that would make the config invalid', () => {
    const store = new ConfigStore(file);
    store.load();
    const before = fs.readFileSync(file, 'utf8');
    expect(() =>
      store.update((raw) => {
        raw.projects = [{ id: 'p', profileId: 'nobody', name: 'p', repoPath: '/p' }];
      }),
    ).toThrow(/unknown profile/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('notifies listeners on reload and update', () => {
    const store = new ConfigStore(file);
    store.load();
    const seen: Array<string | null> = [];
    const off = store.onChange((s) => seen.push(s.error));
    store.reload();
    fs.writeFileSync(file, '[]');
    store.reload();
    off();
    store.reload();
    expect(seen).toEqual([null, 'config.json must contain a JSON object']);
  });
});
