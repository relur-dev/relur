import { describe, expect, it } from 'vitest';
import { FLAG_NOTE_MAX, flagNote, flagTooltip } from './flag';

describe('flagNote (spec §6.7)', () => {
  it('keeps one trimmed line', () => {
    expect(flagNote('  Check Safari\n\tthen   the e2e \r\n')).toBe('Check Safari then the e2e');
    expect(flagNote('   ')).toBe('');
  });

  it('cuts it at 200 characters, without splitting a character', () => {
    expect(flagNote('a'.repeat(300))).toHaveLength(FLAG_NOTE_MAX);
    expect(Array.from(flagNote('🚩'.repeat(250)))).toHaveLength(FLAG_NOTE_MAX);
    expect(flagNote(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
  });

  it('gives the tooltip with the note under what a click does', () => {
    expect(flagTooltip('')).toBe('Flagged · click to clear');
    expect(flagTooltip('Write the e2e')).toBe('Flagged · click to clear\nWrite the e2e');
  });
});
