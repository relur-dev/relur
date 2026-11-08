import { describe, expect, it } from 'vitest';
import { PROFILE_COLORS, profileColorLabel, toProfileColor } from './profile-colors';

describe('PROFILE_COLORS', () => {
  it('is the first six, then the six added after them (spec §3.1)', () => {
    expect(PROFILE_COLORS).toEqual([
      'blue',
      'sky',
      'teal',
      'green',
      'olive',
      'graphite',
      'indigo',
      'slate',
      'petrol',
      'pine',
      'plum',
      'charcoal',
    ]);
  });

  it('shows each name capitalized', () => {
    expect(profileColorLabel('blue')).toBe('Blue');
    expect(profileColorLabel('charcoal')).toBe('Charcoal');
  });
});

describe('toProfileColor', () => {
  it('keeps palette names, the first six and the new ones', () => {
    for (const name of PROFILE_COLORS) expect(toProfileColor(name)).toBe(name);
  });

  it('maps hex values to the nearest name of the first six, as before the new colors', () => {
    expect(toProfileColor('#2F6FEB')).toBe('blue');
    expect(toProfileColor('#0EA5E9')).toBe('sky');
    expect(toProfileColor('#0D9488')).toBe('teal');
    expect(toProfileColor('#16A34A')).toBe('green');
    expect(toProfileColor('#808000')).toBe('olive');
    expect(toProfileColor('#6B7280')).toBe('graphite');
    expect(toProfileColor('#000000')).toBe('graphite');
    // Purples and indigos map to blue, as they always did, never to a new color.
    expect(toProfileColor('#6366F1')).toBe('blue');
    expect(toProfileColor('#7C3AED')).toBe('blue');
  });

  it('falls back to graphite for anything else', () => {
    expect(toProfileColor('pink')).toBe('graphite');
    expect(toProfileColor('Plum')).toBe('graphite');
    expect(toProfileColor('#abc')).toBe('graphite');
    expect(toProfileColor('')).toBe('graphite');
    expect(toProfileColor(null)).toBe('graphite');
    expect(toProfileColor(undefined)).toBe('graphite');
    expect(toProfileColor(42)).toBe('graphite');
  });
});
