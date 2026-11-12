import { BRAND } from '@shared/brand';
import { QUIT_ON_CLOSE_LABEL } from '@shared/window-close';
import { type FormEvent, useEffect, useRef } from 'react';
import { button, Kbd, keyHint } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';

/**
 * The first time ever the window closes on macOS (spec §5): the app keeps
 * running. Shown once; Close Window has the focus, Cancel keeps the window open.
 */
export function CloseNotice({ onAnswer }: { onAnswer: (close: boolean) => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => closeButton.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer(true);
  };
  return (
    <Modal
      title={`${BRAND.displayName} keeps running`}
      description={`Closing the window doesn’t stop Claude: sessions finish their work and notifications still arrive. Click ${BRAND.displayName} in the Dock to bring the window back, and quit with ${keyHint('quit')}.`}
      onClose={() => onAnswer(false)}
    >
      <form className={modalForm} onSubmit={submit} data-close-notice>
        <ModalBody>
          <p className="text-md text-fg-muted">
            To quit whenever the window closes, choose{' '}
            <span className="text-fg">{QUIT_ON_CLOSE_LABEL}</span> in the {BRAND.displayName} menu.
            This message isn’t shown again.
          </p>
        </ModalBody>
        <ModalFooter>
          <button type="button" className={button('ghost', 'lg')} onClick={() => onAnswer(false)}>
            Cancel <Kbd>Esc</Kbd>
          </button>
          <button ref={closeButton} type="submit" className={button('primary', 'lg')}>
            Close Window
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
