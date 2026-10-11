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

/** Is `el`, or an ancestor up to (not including) `root`, hidden from the tab order and from sight? */
function hiddenWithin(el: HTMLElement, root: HTMLElement): boolean {
  if (getComputedStyle(el).visibility === 'hidden') return true;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) {
    if (n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true') return true;
    if (getComputedStyle(n).display === 'none') return true;
    // A closed <details> shows only its first <summary>.
    const parent: HTMLElement | null = n.parentElement;
    if (parent instanceof HTMLDetailsElement && !parent.open && n !== parent.querySelector(':scope > summary')) return true;
  }
  return false;
}

/** Disabled itself, or inside a disabled <fieldset> (its first <legend> is exempt, as in browsers). */
function disabledByFieldset(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true;
  for (let fs = el.closest('fieldset[disabled]'); fs; fs = fs.parentElement?.closest('fieldset[disabled]') ?? null) {
    const legend = fs.querySelector(':scope > legend');
    if (!legend?.contains(el)) return true;
  }
  return false;
}

/** Only one radio per named group is tabbable: the checked one, else the first in DOM order. */
function radioTabbable(el: HTMLInputElement, root: HTMLElement): boolean {
  if (!el.name) return true;
  const group = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (r) => r.name === el.name && r.form === el.form && !disabledByFieldset(r) && !hiddenWithin(r, root),
  );
  return (group.find((r) => r.checked) ?? group[0]) === el;
}

/**
 * Tabbable descendants, in DOM order. jsdom has no layout, so this reads what it does have:
 * the `inert`/`aria-hidden` attributes, closed <details>, disabled <fieldset>, and computed
 * `display`/`visibility` (inline and stylesheet rules alike — which is how `hidden` is seen).
 * What only a real browser can answer — an element clipped to zero size, off-screen, covered —
 * it cannot.
 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !disabledByFieldset(el) &&
      el.getAttribute('tabindex') !== '-1' &&
      el.getAttribute('type') !== 'hidden' &&
      !hiddenWithin(el, root) &&
      (!(el instanceof HTMLInputElement) || el.type !== 'radio' || radioTabbable(el, root)),
  );
}

/**
 * Open dialogs, oldest first; the last is the one the keyboard belongs to. A dialog rendered
 * inside another's children mounts (and so registers) first, so a registration slots beneath
 * any already-registered panel it contains, which keeps the outer one below the inner one.
 */
interface Entry {
  el: HTMLElement;
  /** Where focus goes back to when this one closes while topmost. */
  before: HTMLElement | null;
}
const stack: Entry[] = [];
function register(el: HTMLElement, before: HTMLElement | null): () => HTMLElement | null | false {
  const entry: Entry = { el, before };
  const above = stack.findIndex((o) => el.contains(o.el));
  if (above < 0) stack.push(entry);
  else stack.splice(above, 0, entry);
  // Returns what to refocus, or `false` when this was not the topmost (nothing to restore).
  return () => {
    const at = stack.indexOf(entry);
    stack.splice(at, 1);
    if (at < stack.length) {
      // Closed beneath others: whoever sits above and would hand focus back into this dialog
      // inherits this one's opener instead, so the page still gets focus when the last closes.
      // (An opener of `null` — focus was on <body> — is inherited by nobody: focus then ends on
      // <body>, not on the page, as it would have with no dialog above. Not a regression.)
      for (const o of stack.slice(at)) if (o.before && el.contains(o.before)) o.before = entry.before;
      return false;
    }
    return entry.before;
  };
}

/**
 * The modal contract while `open`: focus moves in (a child that already took it, e.g. through
 * `autoFocus`, keeps it; else the first tabbable; else the panel itself) and goes back to where
 * it was on close; Tab wraps inside; Escape cancels.
 *
 * One `document` listener, not a React handler on the panel, so the keys still work when
 * focus was lost to `body`. Only the topmost open dialog answers, and only it gives focus back,
 * so stacked dialogs unwind last-in first-out — closing the upper returns focus into the lower
 * one, not to the page. Escape is stopped here, so a window-level layer underneath (a
 * slide-over's own Escape) does not also close. A control inside that consumes Escape itself
 * calls `preventDefault`/`stopPropagation` — React runs before this listener — and the dialog
 * stays open. Not while `busy`: cancel is dead then, and Escape is cancel. If the opener has
 * left the document when the dialog closes, focus is left where the browser puts it: `body`.
 */
function useModal(open: boolean, panel: RefObject<HTMLDivElement>, busy: boolean | undefined, onCancel?: () => void) {
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };

  // The opener is read while rendering, not in the effect: React commits a child's `autoFocus`
  // and runs the child's effects before this component's, so by then `activeElement` is already
  // the dialog's own child. Until the effect below has run, every render of an open dialog
  // re-reads it, which keeps the write idempotent (StrictMode's second render, or a render that
  // was thrown away, sees the same element — nothing inside this dialog has been committed yet).
  // The effect pins it by setting `pinned`; its cleanup lets the next opening capture afresh.
  const opener = useRef<HTMLElement | null>(null);
  const pinned = useRef(false);
  if (open && !pinned.current) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    pinned.current = true;
    const unregister = register(el, opener.current);
    if (!el.contains(document.activeElement)) (tabbables(el)[0] ?? el).focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1)?.el !== el) return;
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
      pinned.current = false;
      document.removeEventListener('keydown', onKey);
      const back = unregister();
      if (back && back.isConnected) back.focus();
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
