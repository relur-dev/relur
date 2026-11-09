import { GLYPH_LABEL, type StatusGlyph as Glyph } from '@shared/status';
import { UNFINISHED_TOOLTIP } from '@shared/unfinished';

/** 12×12 status glyph: every state has its own shape, so color is never the only signal. */
export function StatusGlyph({ glyph, title }: { glyph: Glyph; title?: string }) {
  return (
    <span
      role="img"
      title={title ?? (glyph === 'unfinished' ? UNFINISHED_TOOLTIP : GLYPH_LABEL[glyph])}
      aria-label={GLYPH_LABEL[glyph]}
      className="inline-flex size-3 flex-none items-center justify-center"
    >
      {SHAPES[glyph]}
    </span>
  );
}

const SHAPES: Record<Glyph, React.ReactNode> = {
  working: (
    <span className="box-border size-[9px] animate-glyph-spin rounded-full border-[1.5px] border-fg-muted border-t-transparent" />
  ),
  permission: (
    <span className="h-[10px] w-[11px] bg-st-permission [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
  ),
  input: <span className="box-border size-[10px] rounded-full border-2 border-st-input" />,
  question: <span className="font-mono text-[12px] leading-none font-bold text-st-input">?</span>,
  approval: <span className="size-[7.5px] rotate-45 bg-st-approval" />,
  done: <span className="size-2 rounded-full bg-fg" />,
  exited: <span className="box-border size-2 border-[1.5px] border-fg-subtle" />,
  error: <span className="font-mono text-[11px] leading-none font-bold text-st-error">✕</span>,
  // Two bars, as a pause: Claude stopped mid-task when the app did (spec §9.7).
  unfinished: (
    <span className="flex gap-[2px]">
      <span className="h-[9px] w-[2.5px] rounded-[1px] bg-st-input" />
      <span className="h-[9px] w-[2.5px] rounded-[1px] bg-st-input" />
    </span>
  ),
};
