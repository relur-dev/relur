import { PROFILE_COLORS, type ProfileColor } from './profile-colors';

/** An id from a name: `My Work` → `my-work`, unique among `taken` (`my-work-2`). */
export function uniqueSlug(name: string, taken: readonly string[], fallback: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** A profile id from its name: `My Work` → `my-work`, unique among `taken` (`my-work-2`). */
export const profileIdFor = (name: string, taken: readonly string[]) =>
  uniqueSlug(name, taken, 'profile');

/** The account folder a new account gets (spec §6.11). */
export const newAccountFolder = (profileId: string) => `~/.claude-${profileId}`;

/**
 * The palette split into colors no other profile uses and the used ones, each
 * in palette order. A new profile starts with the first free one (spec §6.11).
 */
export function colorChoices(usedByOthers: readonly string[]): {
  free: ProfileColor[];
  used: ProfileColor[];
} {
  return {
    free: PROFILE_COLORS.filter((c) => !usedByOthers.includes(c)),
    used: PROFILE_COLORS.filter((c) => usedByOthers.includes(c)),
  };
}

/** How a new profile gets its Claude account (spec §6.11). */
export type AccountChoice =
  | { kind: 'default' }
  | { kind: 'existing'; folder: string }
  | { kind: 'new' };

/** An account folder as the wizard lists it. */
export interface AccountFolder {
  /** As written in config.json: `~/.claude-work`. */
  folder: string;
  /**
   * `not-used`: no `.claude.json`, so Claude has never used it and nothing
   * was run there. `unknown`: claude couldn't be run to ask.
   */
  state: 'signed-in' | 'signed-out' | 'not-used' | 'unknown';
  email: string | null;
  /** Ids of the profiles using this folder. */
  usedBy: string[];
}
