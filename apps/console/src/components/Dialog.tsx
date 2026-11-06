import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type {} from '@substrat-run/elements/jsx';
import { Button } from './controls';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  /**
   * The confirm's work is in flight: the confirm spins, and nothing dismisses the dialog,
   * because one closed mid-request leaves the operator not knowing whether it happened.
   */
  busy?: boolean;
  onCancel?: () => void;
  children?: ReactNode;
  width?: number;
}

/**
 * `wa-dialog` under a view's `open`. Web Awesome closes itself on Escape, on its close
 * button and on a backdrop click; here each of those is a request. `wa-hide` is refused
 * and handed to `onCancel`, and the dialog closes when `open` says so. A `wa-hide` from a
 * `wa-select` inside bubbles up here too, so only the dialog's own counts. The element
 * stays mounted while closed: its focus goes back to the opener only as it closes itself.
 */
export function Dialog({
  open,
  title,
  description,
  danger,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  confirmDisabled,
  busy,
  onCancel,
  children,
  width = 440,
}: DialogProps) {
  const dialog = useRef<HTMLElement & { open: boolean }>(null);
  const latest = useRef({ open, busy, onCancel });
  latest.current = { open, busy, onCancel };

  useEffect(() => {
    const el = dialog.current!;
    const hide = (e: Event) => {
      if (e.target !== el || !latest.current.open) return;
      e.preventDefault();
      if (!latest.current.busy) latest.current.onCancel?.();
    };
    el.addEventListener('wa-hide', hide);
    return () => el.removeEventListener('wa-hide', hide);
  }, []);

  useEffect(() => {
    dialog.current!.open = open;
  }, [open]);

  return (
    <wa-dialog ref={dialog as never} label={title} light-dismiss with-footer style={{ '--width': `${width}px` }}>
      {open && (
        <>
          {description && (
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', lineHeight: 'var(--lh-base)', marginBottom: children ? 16 : 0 }}>
              {description}
            </div>
          )}
          {children}
          <div slot="footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={confirmDisabled || !onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </wa-dialog>
  );
}
