import type { ReactNode } from 'react';
import { Button } from './Button';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Destructive confirm styling. */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  /** Disable the confirm button (e.g. a type-to-confirm guard not yet satisfied). */
  confirmDisabled?: boolean;
  /**
   * The confirm's work is in flight: the confirm spins, and cancel — along with the
   * click-outside backdrop — stops answering, because a dialog dismissed mid-request
   * leaves the operator with no idea whether the thing happened.
   */
  busy?: boolean;
  onCancel?: () => void;
  /** Optional form body. */
  children?: ReactNode;
  width?: number;
}

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
  if (!open) return null;

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14,16,23,0.4)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: '100%',
          background: 'var(--surface-raised)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-popover)',
          fontFamily: 'var(--font-sans)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 20px 0' }}>
          <div
            style={{
              fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)',
              letterSpacing: 'var(--tracking-tight)',
            }}
          >
            {title}
          </div>
          {description && (
            <div
              style={{
                fontSize: 'var(--text-base)',
                color: 'var(--text-secondary)',
                marginTop: 6,
                lineHeight: 'var(--lh-base)',
              }}
            >
              {description}
            </div>
          )}
        </div>
        {children && <div style={{ padding: '16px 20px 0' }}>{children}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 20 }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            disabled={confirmDisabled || !onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
