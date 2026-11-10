import {
  type BoardLayout,
  isDefaultLayout,
  parseBoardLayout,
  serializeBoardLayout,
} from '@shared/board-layout';
import { useState } from 'react';
import { remember } from '../ui/remember';

/**
 * The Board's columns as the profile arranged them (spec §6.7): one layout per
 * profile, the same on Home and in each project's view, remembered across
 * restarts in the window's local storage.
 */
const boardKey = (profileId: string) => `home-board-columns:${profileId}`;

export const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function useBoardLayout(profileId: string) {
  const [layout, setLayout] = useState<BoardLayout>(() =>
    parseBoardLayout(stored(boardKey(profileId))),
  );
  const change = (next: BoardLayout) => {
    setLayout(next);
    // The default is stored as none, so a later default reaches it.
    remember(boardKey(profileId), isDefaultLayout(next) ? null : serializeBoardLayout(next));
  };
  return [layout, change] as const;
}
