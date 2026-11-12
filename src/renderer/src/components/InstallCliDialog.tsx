import { BRAND } from '@shared/brand';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { GuideLink } from '../guide/link';
import { useTRPC } from '../trpc';
import { button, Kbd, keyHint } from '../ui/controls';
import { Modal, ModalBody, ModalFooter, modalForm } from './Modal';
import { CommandBlock } from './SetupCheck';

/**
 * Install Command Line Tool… (spec §7.5): shows where the launcher goes,
 * writes it after confirmation (never with sudo), then says how to put
 * ~/.local/bin on PATH if it isn't.
 */
export function InstallCliDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const info = useQuery(trpc.cli.info.queryOptions(undefined, { staleTime: 0 }));
  const install = useMutation(trpc.cli.install.mutationOptions());
  const done = install.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (done) onClose();
    else install.mutate();
  };

  return (
    <Modal title="Install the command line tool?" onClose={onClose}>
      <form onSubmit={submit} className={`${modalForm} text-md`}>
        <ModalBody className="flex flex-col gap-3">
          <p className="text-fg-muted">
            <span className="float-right ml-2">
              <GuideLink to="cli" label="The command line tool" before={onClose} />
            </span>
            Lets you add projects from any terminal with{' '}
            <span className="font-mono text-fg">
              {BRAND.cliCommand} add [path] --profile &lt;id&gt;
            </span>
            .{` ${BRAND.displayName}`} writes one small script, without administrator rights:
          </p>
          <div
            data-cli-target
            className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm select-text"
          >
            {info.data?.target ?? '…'}
          </div>
          {info.data?.foreign ? (
            <p className="text-st-error">
              ✕ A different file is already there; it isn't replaced. Remove it first.
            </p>
          ) : null}
          {info.data?.replaces && !done ? (
            <p data-cli-replaces className="text-sm text-fg-muted">
              Replaces the launcher installed earlier, which runs{' '}
              <span className="font-mono break-all text-fg">{info.data.replaces}</span>.
            </p>
          ) : null}
          {info.data?.removesLegacy && !done ? (
            <p data-cli-removes-legacy className="text-sm text-fg-muted">
              Also removes {BRAND.legacy.displayName}'s launcher,{' '}
              <span className="font-mono break-all text-fg">{info.data.removesLegacy}</span>.
            </p>
          ) : null}
          {info.data && !info.data.available ? (
            <p className="text-st-error">✕ The helper is missing from this build.</p>
          ) : null}
          {done ? (
            <>
              <p data-cli-installed className="text-diff-add">
                ✓ Installed. Run {BRAND.cliCommand} add in a new terminal.
              </p>
              {!done.onPath ? (
                <>
                  <p className="text-fg-muted">
                    ~/.local/bin isn't on your login shell's PATH. Add this line to your shell's
                    startup file, then open a new terminal:
                  </p>
                  <CommandBlock command={done.exportLine} />
                </>
              ) : null}
            </>
          ) : null}
          {install.error ? (
            <p role="alert" className="text-st-error select-text">
              ✕ {install.error.message}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          {done ? null : (
            <button
              type="button"
              data-autofocus
              className={button('ghost', 'lg')}
              onClick={onClose}
            >
              Cancel <Kbd>Esc</Kbd>
            </button>
          )}
          <button
            type="submit"
            className={button('primary', 'lg')}
            disabled={
              !done &&
              (!info.data || info.data.foreign || !info.data.available || install.isPending)
            }
          >
            {done ? 'Done' : 'Install'} <Kbd onFg>{keyHint('confirm')}</Kbd>
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
