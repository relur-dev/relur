import { describe, expect, it } from 'vitest';
import {
  atMenu,
  backgroundNote,
  GLYPH_LABEL,
  glyphFor,
  needsYou,
  STATE_LABEL,
  soundKey,
  type WorkspaceState,
} from './status';

describe('glyphFor', () => {
  it('maps the spec states to the design glyphs', () => {
    const cases: [WorkspaceState, boolean, string | null][] = [
      ['starting', false, null],
      ['working', false, 'working'],
      ['needs-permission', false, 'permission'],
      ['needs-input', false, 'input'],
      ['needs-answer', false, 'question'],
      ['awaiting-approval', false, 'approval'],
      ['done', true, 'done'],
      ['done', false, null],
      ['interrupted', false, null],
      ['exited', false, 'exited'],
      ['error', false, 'error'],
    ];
    for (const [state, unread, glyph] of cases) expect(glyphFor(state, unread)).toBe(glyph);
  });

  it('shows the spinner for Starting only while Claude launches', () => {
    expect(glyphFor('starting', false, true)).toBe('working');
    expect(glyphFor('starting', false, false)).toBeNull();
  });

  it('counts permission, input, a question and approval as needing you', () => {
    expect(
      ['needs-permission', 'needs-input', 'needs-answer', 'awaiting-approval'].every((s) =>
        needsYou(s as WorkspaceState),
      ),
    ).toBe(true);
    expect(needsYou('done')).toBe(false);
    expect(needsYou('error')).toBe(false);
  });
});

describe('backgroundNote', () => {
  it('says what the background count means in Working and Done (spec §10.2)', () => {
    expect(backgroundNote('working', 2)).toBe('2 in background');
    expect(backgroundNote('done', 1)).toBe('1 still running in the background');
    expect(backgroundNote('done', 0)).toBeNull();
    expect(backgroundNote('needs-input', 3)).toBeNull();
  });
});

describe('a question Claude asked (spec §10.2)', () => {
  it('reads Asked a question, in the input sound, at a menu keys answer', () => {
    expect(STATE_LABEL['needs-answer']).toBe('Asked a question');
    expect(GLYPH_LABEL.question).toBe('Asked a question');
    expect(soundKey('needs-answer')).toBe('needsInput');
    expect(soundKey('needs-permission')).toBe('needsPermission');
    expect(atMenu('needs-answer')).toBe(true);
    expect(atMenu('needs-permission')).toBe(true);
    expect(atMenu('needs-input')).toBe(false);
  });
});
