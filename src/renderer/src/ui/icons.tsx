/**
 * Small line icons (components.md: Icons), 14px, stroked in the current text
 * colour so they follow both themes. Decorative: the control carries the
 * label (aria-label and a tooltip with its shortcut).
 */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Responses: a speech bubble. */
export const ResponsesIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </Icon>
);

/** Notes: a page with lines. */
export const NotesIcon = () => (
  <Icon>
    <path d="M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
  </Icon>
);

/** Open in editor: a square with an arrow out of it. */
export const EditorIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" />
  </Icon>
);

/** Changes: plus over minus. */
export const ChangesIcon = () => (
  <Icon>
    <path d="M8 2.5v6M5 5.5h6M5 12.5h6" />
  </Icon>
);

/** Delete: a trash can. */
export const TrashIcon = () => (
  <Icon>
    <path d="M2.5 4.5h11M6.5 4.5v-2h3v2M4 4.5l.7 8.6a.5.5 0 0 0 .5.4h5.6a.5.5 0 0 0 .5-.4l.7-8.6M6.7 7v4M9.3 7v4" />
  </Icon>
);

/** Details: an i in a circle (a Board card's ⓘ). */
export const InfoIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Icon>
);
