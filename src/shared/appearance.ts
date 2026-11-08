/**
 * View › Appearance (spec §6): System follows the OS, Light and Dark keep that
 * theme whatever the OS uses. Stored as `appearance` in config.json, left out
 * for System.
 */
export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const APPEARANCE_LABEL: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** The chosen appearance; System when the config has none (or isn't valid yet). */
export function appearanceOf(config: { appearance?: Appearance } | null | undefined): Appearance {
  return config?.appearance ?? 'system';
}

/** Writes the choice into the raw config: System removes the key. */
export function writeAppearance(raw: Record<string, unknown>, appearance: Appearance): void {
  if (appearance === 'system') delete raw.appearance;
  else raw.appearance = appearance;
}
