import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
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

const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';

/** Tabbable descendants, in DOM order: enabled, not `tabindex=-1`, not hidden. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('tabindex') !== '-1' &&
      el.getAttribute('type') !== 'hidden' &&
      !el.closest('[hidden]'),
  );
}

/**
 * The modal contract while `open`: focus moves in (the first tabbable, else the panel
 * itself) and goes back to where it was on close; Tab wraps inside; Escape cancels.
 *
 * One `document` listener, not a React handler on the panel, so the keys still work when
 * focus was lost to `body`. Escape is stopped here, so a window-level layer underneath
 * (a slide-over's own Escape) does not also close. A control inside that consumes Escape
 * itself calls `preventDefault`/`stopPropagation` — React runs before this listener — and
 * the dialog stays open. Not while `busy`: cancel is dead then, and Escape is cancel.
 */
function useModal(open: boolean, panel: RefObject<HTMLDivElement>, busy: boolean | undefined, onCancel?: () => void) {
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (tabbables(el)[0] ?? el).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof Node ? e.target : null;
      const inside = !!target && el.contains(target);
      // Focus on another overlay is that overlay's business; `body` means focus was lost.
      if (!inside && target !== document.body && target !== document.documentElement && target !== document) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!latest.current.busy) latest.current.onCancel?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = tabbables(el);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        el.focus();
      } else if (!el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before?.isConnected) before.focus();
    };
  }, [open, panel]);
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
  const panel = useRef<HTMLDivElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  useModal(open, panel, busy, onCancel);

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
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          outline: 'none',
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
            id={titleId}
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
              id={descId}
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
