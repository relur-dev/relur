import type { Profile } from '@shared/schemas';
import { formatChord, hint } from '@shared/shortcuts';
import { type DragEvent, useState } from 'react';
import { iconButton, isMac, Kbd } from '../ui/controls';
import { PROFILE_TOP_EDGE, ProfileDot } from '../ui/profile-color';

/**
 * The window's profile tab strip; on macOS it is the title bar, with the
 * traffic lights at its left. Every profile is a tab in the one window until
 * M5 adds windows. Tabs are dragged within the strip to reorder them;
 * dropped anywhere else nothing happens (moving between windows is M5).
 */
export function ProfileTabs({
  profiles,
  activeId,
  attention,
  onSelect,
  onNewProfile,
  onContextMenu,
  onMove,
  guideActive,
  onGuide,
}: {
  profiles: Profile[];
  activeId: string | null;
  /** Workspaces needing permission, input or approval, by profile id. */
  attention: Record<string, number>;
  onSelect: (profileId: string) => void;
  /** The + after the last tab: opens the New profile wizard (spec §6.11). */
  onNewProfile: (() => void) | null;
  /** Right-click or ⇧F10 on a tab: Edit profile…, Check setup, Remove profile…. */
  onContextMenu: (profile: Profile) => void;
  /** A tab dropped at a new position: its index in the reordered list. */
  onMove: (profileId: string, index: number) => void;
  /** The pinned Guide tab before the profiles (components.md, Guide tab). */
  guideActive: boolean;
  onGuide: () => void;
}) {
  // The dragged tab and where it would land: an insertion point, 0…profiles.length.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const insertionPoint = (event: DragEvent<HTMLElement>): number => {
    const tabs = [...event.currentTarget.querySelectorAll('[data-profile-tab]')];
    const at = tabs.findIndex((tab) => {
      const box = tab.getBoundingClientRect();
      return event.clientX < box.left + box.width / 2;
    });
    return at === -1 ? tabs.length : at;
  };
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const from = dragging ? profiles.findIndex((p) => p.id === dragging) : -1;
  return (
    <div
      className={`flex h-[42px] shrink-0 items-end gap-0.5 border-b border-line bg-chrome [-webkit-app-region:drag] ${isMac ? 'pl-[84px]' : 'pl-2'}`}
    >
      <button
        type="button"
        data-guide-tab
        aria-pressed={guideActive}
        aria-label="Guide"
        title={`Guide ${hint('guide', isMac)}`}
        onClick={onGuide}
        className={`relative -mb-px flex items-center gap-2 rounded-t-lg pr-3 pl-2.5 text-md [-webkit-app-region:no-drag] max-[900px]:w-[34px] max-[900px]:justify-center max-[900px]:px-0 ${
          guideActive
            ? 'h-[33px] border border-b-0 border-line bg-canvas font-medium text-fg'
            : 'h-8 text-fg-muted hover:bg-raised hover:text-fg'
        }`}
      >
        <span className="flex size-[15px] flex-none items-center justify-center rounded-full border border-current text-[9.5px] font-semibold">
          ?
        </span>
        <span className="max-[900px]:hidden">Guide</span>
      </button>
      <span className="mx-1 mb-2 h-4 w-px flex-none bg-line-strong" aria-hidden />
      <div
        role="tablist"
        aria-label="Profiles"
        className="flex items-end gap-0.5 [-webkit-app-region:no-drag]"
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropAt(insertionPoint(event));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(event) => {
          if (!dragging) return;
          event.preventDefault();
          const at = insertionPoint(event);
          // The insertion point counts the dragged tab itself; its new index doesn't.
          const index = at > from ? at - 1 : at;
          if (index !== from) onMove(dragging, index);
          endDrag();
        }}
      >
        {profiles.map((profile, index) => {
          const active = profile.id === activeId;
          const count = attention[profile.id] ?? 0;
          // A bar at the edge where the dragged tab would land.
          const marker =
            dropAt === null || dropAt === from || dropAt === from + 1
              ? ''
              : dropAt === index
                ? 'before:absolute before:top-1.5 before:bottom-1.5 before:-left-[3px] before:w-0.5 before:rounded-full before:bg-fg-muted'
                : dropAt === profiles.length && index === profiles.length - 1
                  ? 'after:absolute after:top-1.5 after:bottom-1.5 after:-right-[3px] after:w-0.5 after:rounded-full after:bg-fg-muted'
                  : '';
          return (
            <button
              key={profile.id}
              type="button"
              data-profile-tab={profile.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', profile.name);
                setDragging(profile.id);
              }}
              onDragEnd={endDrag}
              role="tab"
              aria-selected={active}
              aria-label={`Select ${profile.name}`}
              aria-current={active || undefined}
              onClick={() => onSelect(profile.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(profile);
              }}
              className={`relative -mb-px flex w-[184px] items-center gap-2 rounded-t-lg px-3 text-md [-webkit-app-region:no-drag] max-[900px]:w-[150px] ${dragging === profile.id ? 'opacity-50' : ''} ${marker} ${
                active
                  ? `h-[33px] border border-b-0 border-line bg-canvas font-medium text-fg ${PROFILE_TOP_EDGE[profile.color]}`
                  : 'h-8 text-fg-muted hover:bg-raised hover:text-fg'
              }`}
            >
              <ProfileDot color={profile.color} />
              <span className="truncate">{profile.name}</span>
              {count > 0 ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-st-permission px-1 font-mono text-2xs font-semibold text-on-permission">
                  {count}
                </span>
              ) : null}
              {index < 9 ? (
                <span className="ml-auto">
                  <Kbd>{formatChord({ mod: true, code: `Digit${index + 1}` }, isMac)}</Kbd>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={`${iconButton} mb-1 ml-1 size-7 text-lg [-webkit-app-region:no-drag]`}
        title="New profile"
        aria-label="New profile"
        disabled={!onNewProfile}
        onClick={onNewProfile ?? undefined}
      >
        +
      </button>
    </div>
  );
}
