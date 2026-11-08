import { describe, expect, it } from 'vitest';
import { appearanceOf, writeAppearance } from './appearance';
import { ConfigSchema } from './schemas';

const base = { version: 1, profiles: [] };

describe('appearance', () => {
  it('is System without a choice', () => {
    expect(appearanceOf(null)).toBe('system');
    expect(appearanceOf({})).toBe('system');
    expect(appearanceOf({ appearance: 'dark' })).toBe('dark');
  });

  it('accepts the three choices in config.json and nothing else', () => {
    for (const appearance of ['system', 'light', 'dark']) {
      expect(ConfigSchema.parse({ ...base, appearance }).appearance).toBe(appearance);
    }
    expect(ConfigSchema.parse(base).appearance).toBeUndefined();
    for (const appearance of ['Dark', 'auto', true, '']) {
      expect(ConfigSchema.safeParse({ ...base, appearance }).success, String(appearance)).toBe(
        false,
      );
    }
  });

  it('writes Light and Dark, and removes the key for System', () => {
    const raw: Record<string, unknown> = { version: 1, note: 'mine' };
    writeAppearance(raw, 'dark');
    expect(raw).toEqual({ version: 1, note: 'mine', appearance: 'dark' });
    writeAppearance(raw, 'light');
    expect(raw.appearance).toBe('light');
    writeAppearance(raw, 'system');
    expect(raw).toEqual({ version: 1, note: 'mine' });
  });
});
