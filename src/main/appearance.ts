import { type Appearance, appearanceOf } from '@shared/appearance';
import { nativeTheme } from 'electron';
import type { ConfigStore } from './config/store';

/**
 * Keeps nativeTheme on View › Appearance (spec §6): the window, its terminals,
 * the Guide and native menus and dialogs follow nativeTheme. Applied when the
 * choice changes only, so other config edits leave nativeTheme alone.
 */
export function followAppearance(config: ConfigStore): void {
  let applied: Appearance | null = null;
  const apply = () => {
    const appearance = appearanceOf(config.get().config);
    if (appearance === applied) return;
    applied = appearance;
    nativeTheme.themeSource = appearance;
  };
  apply();
  config.onChange(apply);
}
