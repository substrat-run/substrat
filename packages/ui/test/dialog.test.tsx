// @vitest-environment jsdom
/**
 * The modal contract of `Dialog` (#2199): role and name, Escape, focus in / trapped / back.
 * Each behaviour has its negative twin beside it — a closed dialog ignores Escape, a busy one
 * ignores it too, Tab in the middle is left to the browser — so a handler that fires always
 * (or never) fails one of the two.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, type DialogProps } from '../src/components/Dialog';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: ReactNode) => act(async () => root.render(node));
const props = (over: Partial<DialogProps> = {}): DialogProps => ({
  open: true,
  title: 'Delete the thing',
  onCancel: () => {},
  onConfirm: () => {},
  ...over,
});
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(e));
  return e;
};
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('Dialog semantics', () => {
  it('is a modal dialog named by its title and described by its description', async () => {
    await render(<Dialog {...props({ description: 'This cannot be undone.' })} />);
    expect(panel().getAttribute('aria-modal')).toBe('true');
    const name = document.getElementById(panel().getAttribute('aria-labelledby')!);
    expect(name?.textContent).toBe('Delete the thing');
    const desc = document.getElementById(panel().getAttribute('aria-describedby')!);
    expect(desc?.textContent).toBe('This cannot be undone.');
  });

  it('points aria-describedby nowhere when there is no description, and renders nothing when closed', async () => {
    await render(<Dialog {...props()} />);
    expect(panel().hasAttribute('aria-describedby')).toBe(false);
    await render(<Dialog {...props({ open: false })} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('gives two open dialogs distinct ids', async () => {
    await render(<><Dialog {...props()} /><Dialog {...props({ title: 'Other' })} /></>);
    const ids = [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('Escape', () => {
  it('cancels an open dialog and stops there — a layer beneath on window does not also close', async () => {
    const onCancel = vi.fn();
    const below = vi.fn();
    window.addEventListener('keydown', below);
    await render(<Dialog {...props({ onCancel })} />);
    const e = key('Escape');
    window.removeEventListener('keydown', below);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(below).not.toHaveBeenCalled();
  });

  it('still cancels when focus was lost to body', async () => {
    const onCancel = vi.fn();
    await render(<Dialog {...props({ onCancel })} />);
    (document.activeElement as HTMLElement).blur();
    key('Escape', {}, document.body);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a closed dialog, and a closed dialog does not swallow the key', async () => {
    const onCancel = vi.fn();
    const below = vi.fn();
    window.addEventListener('keydown', below);
    await render(<Dialog {...props({ open: false, onCancel })} />);
    key('Escape', {}, document.body);
    window.removeEventListener('keydown', below);
    expect(onCancel).not.toHaveBeenCalled();
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('stops answering once the dialog has closed', async () => {
    const onCancel = vi.fn();
    await render(<Dialog {...props({ onCancel })} />);
    await render(<Dialog {...props({ open: false, onCancel })} />);
    key('Escape', {}, document.body);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ignores other keys', async () => {
    const onCancel = vi.fn();
    await render(<Dialog {...props({ onCancel })} />);
    key('Enter');
    key('a');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('leaves a dialog open while busy — cancel is dead then, and so is Escape', async () => {
    const onCancel = vi.fn();
    await render(<Dialog {...props({ onCancel, busy: true })} />);
    key('Escape');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('leaves it open when a control inside consumed the Escape, and when an IME owns it', async () => {
    const onCancel = vi.fn();
    await render(
      <Dialog {...props({ onCancel })}>
        <input aria-label="field" onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()} />
      </Dialog>,
    );
    const input = document.querySelector('input')!;
    input.focus();
    key('Escape', {}, input);
    expect(onCancel).not.toHaveBeenCalled();
    // The same input, without anything consuming: that Escape does cancel.
    input.onkeydown = null;
    await render(<Dialog {...props({ onCancel })}><input aria-label="field" /></Dialog>);
    key('Escape', { isComposing: true }, document.querySelector('input')!);
    expect(onCancel).not.toHaveBeenCalled();
    key('Escape', {}, document.querySelector('input')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape aimed at another overlay outside the dialog', async () => {
    const onCancel = vi.fn();
    const other = document.createElement('button');
    document.body.append(other);
    await render(<Dialog {...props({ onCancel })} />);
    key('Escape', {}, other);
    other.remove();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('focus', () => {
  it('moves into the dialog on open: the first tabbable, skipping disabled and tabindex=-1', async () => {
    await render(
      <Dialog {...props({ confirmDisabled: true })}>
        <button disabled>off</button>
        <button tabIndex={-1}>skipped</button>
        <input aria-label="name" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(document.querySelector('input'));
  });

  it('lands on Cancel when the body holds nothing tabbable', async () => {
    await render(<Dialog {...props()} />);
    expect(document.activeElement).toBe(button('Cancel'));
  });

  it('puts focus on the panel itself when nothing inside is tabbable, and keeps it there on Tab', async () => {
    await render(<Dialog {...props({ busy: true, onConfirm: undefined })} />);
    expect(document.activeElement).toBe(panel());
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panel());
  });

  it('returns focus to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    await render(<Dialog {...props()} />);
    expect(document.activeElement).not.toBe(opener);
    await render(<Dialog {...props({ open: false })} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not call focus() on an opener that left the document — and the twin that is still there gets exactly one', async () => {
    // jsdom's focus() on a detached element is a silent no-op, so the activeElement cannot tell
    // the guard from its absence; the call itself can.
    const stays = document.createElement('button');
    const leaves = document.createElement('button');
    document.body.append(stays, leaves);
    stays.focus();
    const staysFocus = vi.spyOn(stays, 'focus');
    await render(<Dialog {...props()} />);
    await render(<Dialog {...props({ open: false })} />);
    expect(staysFocus).toHaveBeenCalledTimes(1);

    leaves.focus();
    const leavesFocus = vi.spyOn(leaves, 'focus');
    await render(<Dialog {...props()} />);
    leaves.remove();
    await render(<Dialog {...props({ open: false })} />);
    expect(leavesFocus).not.toHaveBeenCalled();
    // Nowhere to go back to: focus rests on body, predictably, not on a stale node.
    expect(document.activeElement).toBe(document.body);
    stays.remove();
  });

  it('returns focus on unmount too — a caller that renders it conditionally', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    await render(<Dialog {...props()} />);
    await render(null);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not re-run the focus move on re-render while open', async () => {
    function Form() {
      const [n, setN] = useState(0);
      return (
        <Dialog {...props()}>
          <input aria-label="a" />
          <input aria-label="b" onChange={() => setN(n + 1)} />
        </Dialog>
      );
    }
    await render(<Form />);
    const b = document.querySelector<HTMLInputElement>('input[aria-label="b"]')!;
    b.focus();
    await render(<Form />);
    expect(document.activeElement).toBe(b);
  });
});

describe('Tab trap', () => {
  const body = (
    <Dialog {...props()}>
      <input aria-label="first" />
    </Dialog>
  );

  it('wraps forward from the last control to the first', async () => {
    await render(body);
    const first = document.querySelector('input')!;
    button('Confirm').focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('wraps backward from the first control to the last', async () => {
    await render(body);
    const first = document.querySelector('input')!;
    first.focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button('Confirm'));
  });

  it('wraps backward from the panel itself', async () => {
    await render(body);
    panel().focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(button('Confirm'));
  });

  it('leaves Tab alone in the middle — the browser moves it, and it stays inside', async () => {
    await render(body);
    document.querySelector('input')!.focus();
    expect(key('Tab').defaultPrevented).toBe(false);
    button('Cancel').focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('pulls focus back in when it had escaped to body', async () => {
    await render(body);
    (document.activeElement as HTMLElement).blur();
    expect(key('Tab', {}, document.body).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('input'));
    (document.activeElement as HTMLElement).blur();
    key('Tab', { shiftKey: true }, document.body);
    expect(document.activeElement).toBe(button('Confirm'));
  });

  it('does not trap while closed', async () => {
    await render(<Dialog {...props({ open: false })} />);
    expect(key('Tab', {}, document.body).defaultPrevented).toBe(false);
  });
});
