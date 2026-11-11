/** A workspace's flag (spec §6.7): flagged to come back to later, with a one-line note. */

/** The longest note kept, in characters. */
export const FLAG_NOTE_MAX = 200;

/** A note as kept: one line (line breaks and tabs become spaces), trimmed, at most 200 characters. */
export function flagNote(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, FLAG_NOTE_MAX).join('').trimEnd();
}

/** The flag's tooltip: what a click does, then the note. */
export const flagTooltip = (note: string) =>
  note ? `Flagged · click to clear\n${note}` : 'Flagged · click to clear';
