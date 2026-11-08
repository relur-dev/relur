import { describe, expect, it } from 'vitest';
import { colorChoices, newAccountFolder, profileIdFor } from './profiles';
import { IdSchema } from './schemas';

describe('profileIdFor', () => {
  it('slugs the name into a valid, unique id', () => {
    expect(profileIdFor('Work', [])).toBe('work');
    expect(profileIdFor('My Side Project!', [])).toBe('my-side-project');
    expect(profileIdFor('Café Ünïcode', [])).toBe('cafe-unicode');
    expect(profileIdFor('Work', ['work', 'work-2'])).toBe('work-3');
    expect(profileIdFor('???', [])).toBe('profile');
    for (const name of ['Work', '  -x- ', '日本', 'A.B']) {
      expect(IdSchema.safeParse(profileIdFor(name, [])).success).toBe(true);
    }
  });

  it('gives a new account the folder ~/.claude-<id>', () => {
    expect(newAccountFolder('side')).toBe('~/.claude-side');
  });
});

describe('colorChoices', () => {
  it('splits free and used colors, keeping palette order', () => {
    expect(colorChoices(['green', 'plum', 'blue'])).toEqual({
      free: ['sky', 'teal', 'olive', 'graphite', 'indigo', 'slate', 'petrol', 'pine', 'charcoal'],
      used: ['blue', 'green', 'plum'],
    });
    expect(colorChoices([]).used).toEqual([]);
  });

  it('offers a new color once the first six are taken', () => {
    expect(colorChoices(['blue', 'sky', 'teal', 'green', 'olive', 'graphite']).free[0]).toBe(
      'indigo',
    );
  });
});
