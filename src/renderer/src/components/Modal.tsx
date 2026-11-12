import { matchShortcut } from '@shared/shortcuts';
import { type ReactNode, useEffect, useRef } from 'react';
import { isMac } from '../ui/controls';

/**
 * A modal built on <dialog>: focus trapping, focus restore and Escape come
 * from the browser. The first field gets focus, or the element marked
 * `data-autofocus` (destructive dialogs put it on Cancel). ⌘↵ submits the dialog's
 * form; clicking the scrim cancels only while nothing has been typed.
 *
 * Never taller than the window (spec §6.17): the title and the buttons stay in
 * view and only the ModalBody between them scrolls. A dialog's form takes
 * `modalForm`, its fields go in a ModalBody and its buttons in a ModalFooter
 * after it.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  icon,
  wide = false,
  tall = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Shown before the title, such as the profile dot. */
  icon?: ReactNode;
  /** 620px and closer to the top (the New profile wizard). */
  wide?: boolean;
  /** With `wide`: a fixed height, so switching tabs doesn't resize the dialog. */
  tall?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const typed = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    // showModal focuses the first focusable element (a "?" Guide link, say); an
    // element marked data-autofocus (Cancel in destructive dialogs) wins.
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      // React's StrictMode closes and reopens the dialog on mount; the queued
      // close event then arrives while it is open again and must be ignored.
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      onInput={() => {
        typed.current = true;
      }}
      onKeyDown={(event) => {
        if (matchShortcut('confirm', event.nativeEvent, isMac) !== -1) {
          event.preventDefault();
          // A nested dialog submits its own form only.
          event.stopPropagation();
          ref.current?.querySelector('form')?.requestSubmit();
        }
      }}
      onMouseDown={(event) => {
        // The dialog element itself is only hit outside its content box: the scrim.
        if (event.target === ref.current && !typed.current) ref.current?.close();
      }}
      className={`mx-auto max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-line-strong bg-raised p-0 text-fg shadow-dialog backdrop:bg-scrim open:flex ${
        wide
          ? 'mt-[min(3rem,6vh)] max-h-[calc(100vh-min(3rem,6vh)-1.5rem)] w-[620px]'
          : 'mt-[min(6rem,12vh)] max-h-[calc(100vh-min(6rem,12vh)-1.5rem)] w-[500px]'
      } ${tall ? 'h-[min(720px,calc(100vh-min(3rem,6vh)-1.5rem))]' : ''}`}
    >
      <div className="px-5 pt-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon}
          {title}
        </h2>
        {description ? <div className="mt-0.5 text-md text-fg-muted">{description}</div> : null}
      </div>
      {/* Scrolls as a whole only for content outside a ModalBody that doesn't fit. */}
      <div className="flex min-h-0 flex-auto flex-col overflow-y-auto px-5 pt-4 pb-5">
        {children}
      </div>
    </dialog>
  );
}

/** A dialog's form: passes the dialog's height limit on to its ModalBody. */
export const modalForm = 'flex min-h-0 flex-auto flex-col';

/**
 * The part of a dialog that scrolls when the window is too short for it (spec
 * §6.17), with a scrollbar that stays visible. It reaches the dialog's edges so
 * focus rings aren't cut off; the scrollbar sits in the right padding.
 */
export function ModalBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-modal-body
      className={`scroll-visible -mx-5 -my-1 min-h-0 flex-auto overflow-y-auto py-1 pr-2.5 pl-5 [scrollbar-gutter:stable] ${className}`}
    >
      {children}
    </div>
  );
}

/** Right-aligned dialog buttons: Cancel, then the primary action. Never scrolls away. */
export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div data-modal-footer className="mt-5 flex items-center justify-end gap-2">
      {children}
    </div>
  );
}
