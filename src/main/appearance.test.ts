import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAppearance } from '@shared/appearance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeTheme = vi.hoisted(() => {
  let source = 'system';
  const sets: string[] = [];
  return {
    sets,
    get themeSource() {
      return source;
    },
    set themeSource(value: string) {
      source = value;
      sets.push(value);
    },
  };
});
vi.mock('electron', () => ({ nativeTheme }));
const { followAppearance } = await import('./appearance');
const { ConfigStore } = await import('./config/store');

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-'));
  file = path.join(dir, 'config.json');
  nativeTheme.sets.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('followAppearance', () => {
  it('applies the stored choice at once, before anything else happens', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [], appearance: 'dark' }));
    const config = new ConfigStore(file);
    config.load();
    followAppearance(config);
    expect(nativeTheme.themeSource).toBe('dark');
  });

  it('follows a new choice, and leaves nativeTheme alone on other config changes', () => {
    const config = new ConfigStore(file);
    config.load();
    followAppearance(config);
    expect(nativeTheme.sets).toEqual(['system']);

    config.update((raw) => writeAppearance(raw, 'light'));
    expect(nativeTheme.themeSource).toBe('light');
    config.update((raw) => {
      raw.quitOnWindowClose = true;
    });
    config.update((raw) => writeAppearance(raw, 'system'));
    expect(nativeTheme.sets).toEqual(['system', 'light', 'system']);
  });

  it('is remembered: a new start reads it from config.json', () => {
    const first = new ConfigStore(file);
    first.load();
    first.update((raw) => writeAppearance(raw, 'dark'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).appearance).toBe('dark');

    const next = new ConfigStore(file);
    next.load();
    followAppearance(next);
    expect(nativeTheme.themeSource).toBe('dark');
  });
});
