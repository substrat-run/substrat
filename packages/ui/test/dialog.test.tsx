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

  it('returns focus to the real opener when a child takes focus itself (autoFocus) — the opener, not the child that is gone', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    await render(
      <Dialog {...props()}>
        <input aria-label="a" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(document.querySelector('input'));
    await render(<Dialog {...props({ open: false })} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('captures the opener afresh on each opening, and keeps it through re-renders while open', async () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    document.body.append(a, b);
    const ui = (open: boolean, n = 0) => (
      <Dialog {...props({ open, onCancel: () => void n })}>
        <input aria-label="a" autoFocus />
      </Dialog>
    );
    a.focus();
    await render(ui(true));
    await render(ui(true, 1)); // re-render while open: focus is in the child, must not become the opener
    await render(ui(false));
    expect(document.activeElement).toBe(a);
    b.focus();
    await render(ui(true));
    await render(ui(false));
    expect(document.activeElement).toBe(b);
    a.remove();
    b.remove();
  });

  it('returns focus to the real opener under StrictMode too', async () => {
    const { StrictMode } = await import('react');
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const ui = (open: boolean) => (
      <StrictMode>
        <Dialog {...props({ open })}>
          <input aria-label="a" autoFocus />
        </Dialog>
      </StrictMode>
    );
    await render(ui(true));
    await render(ui(false));
    expect(document.activeElement).toBe(opener);
    opener.remove();
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

  it('does not re-run the focus move when the dialog re-renders with a fresh onCancel — focus stays where the user put it', async () => {
    function Form() {
      const [n, setN] = useState(0);
      return (
        <Dialog {...props({ onCancel: () => void n })}>
          <input aria-label="a" />
          <button onClick={() => setN(n + 1)}>bump {n}</button>
        </Dialog>
      );
    }
    // A real opener: with body as the opener, restoring focus to it is a no-op and hides a re-run.
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    await render(<Form />);
    expect(document.activeElement).toBe(document.querySelector('input'));
    const bump = document.querySelector<HTMLButtonElement>('button')!;
    bump.focus();
    await act(async () => bump.click());
    expect(bump.textContent).toBe('bump 1'); // it did re-render
    expect(document.activeElement).toBe(bump);
    opener.remove();
  });

  it('leaves focus on a child that took it itself (autoFocus) — and the twin without one lands on the first tabbable', async () => {
    await render(
      <Dialog {...props()}>
        <input aria-label="a" />
        <input aria-label="b" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="b"]'));
    await render(null);
    await render(
      <Dialog {...props()}>
        <input aria-label="a" />
        <input aria-label="b" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="a"]'));
  });
});

describe('stacked dialogs', () => {
  function Stack({ outerCancel, innerCancel, innerOpen }: { outerCancel: () => void; innerCancel: () => void; innerOpen: boolean }) {
    return (
      <Dialog {...props({ title: 'Outer', onCancel: outerCancel })}>
        <input aria-label="outer-field" />
        <button id="opens-inner">open inner</button>
        <Dialog {...props({ title: 'Inner', open: innerOpen, onCancel: innerCancel })}>
          <input aria-label="inner-field" />
        </Dialog>
      </Dialog>
    );
  }
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];

  it('Escape closes only the topmost, then the one beneath', async () => {
    const outer = vi.fn(), inner = vi.fn();
    await render(<Stack outerCancel={outer} innerCancel={inner} innerOpen />);
    key('Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    await render(<Stack outerCancel={outer} innerCancel={inner} innerOpen={false} />);
    key('Escape');
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('Escape and Tab belong to the inner one even when the outer listener is the first to run', async () => {
    // The inner opens later, so the outer's document listener is registered first and sees the
    // key while the target is inside both and nothing has called preventDefault yet. Only the
    // topmost check keeps it from handling the key.
    const outer = vi.fn(), inner = vi.fn();
    await render(<Stack outerCancel={outer} innerCancel={inner} innerOpen={false} />);
    await render(<Stack outerCancel={outer} innerCancel={inner} innerOpen />);
    key('Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    const [outerPanel, innerPanel] = dialogs();
    const innerConfirm = [...innerPanel!.querySelectorAll('button')].find((b) => b.textContent === 'Confirm')!;
    innerConfirm.focus();
    key('Tab');
    expect(innerPanel!.contains(document.activeElement)).toBe(true);
    expect(outerPanel!.contains(innerPanel!)).toBe(true);
  });

  it('Tab wraps inside the topmost one only', async () => {
    await render(<Stack outerCancel={() => {}} innerCancel={() => {}} innerOpen />);
    const [, inner] = dialogs();
    const field = inner!.querySelector('input')!;
    field.focus();
    const confirm = [...inner!.querySelectorAll('button')].find((b) => b.textContent === 'Confirm')!;
    confirm.focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field); // the inner's first, not the outer's
  });

  it('closing the top returns focus into the dialog beneath, not the page', async () => {
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    await render(<Stack outerCancel={() => {}} innerCancel={() => {}} innerOpen={false} />);
    const opens = document.getElementById('opens-inner')!;
    opens.focus();
    await render(<Stack outerCancel={() => {}} innerCancel={() => {}} innerOpen />);
    expect(dialogs()[1]!.contains(document.activeElement)).toBe(true);
    await render(<Stack outerCancel={() => {}} innerCancel={() => {}} innerOpen={false} />);
    expect(document.activeElement).toBe(opens);
    expect(dialogs()[0]!.contains(document.activeElement)).toBe(true);
    page.remove();
  });

  it('opened from inside another dialog\'s autoFocus child: closing the inner returns to that child, closing the outer to the page opener', async () => {
    const page = document.createElement('button');
    document.body.append(page);
    page.focus();
    function Nested({ outer, inner }: { outer: boolean; inner: boolean }) {
      return (
        <>
          <Dialog {...props({ title: 'Outer', open: outer })}>
            <button id="auto" autoFocus>auto</button>
          </Dialog>
          <Dialog {...props({ title: 'Inner', open: inner })}>
            <input aria-label="inner-auto" autoFocus />
          </Dialog>
        </>
      );
    }
    await render(<Nested outer inner={false} />);
    const auto = document.getElementById('auto')!;
    expect(document.activeElement).toBe(auto);
    await render(<Nested outer inner />);
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="inner-auto"]'));
    await render(<Nested outer inner={false} />);
    expect(document.activeElement).toBe(auto);
    await render(<Nested outer={false} inner={false} />);
    expect(document.activeElement).toBe(page);
    page.remove();
  });

  it('a lower dialog closing under an open one does not steal focus back from it', async () => {
    const lower = document.createElement('div');
    const upper = document.createElement('div');
    const page = document.createElement('button');
    document.body.append(page, lower, upper);
    page.focus(); // what the lower dialog would hand focus back to
    const a = createRoot(lower), b = createRoot(upper);
    await act(async () => a.render(<Dialog {...props({ title: 'Lower' })}><input aria-label="l" /></Dialog>));
    await act(async () => b.render(<Dialog {...props({ title: 'Upper' })}><input aria-label="u" /></Dialog>));
    const field = upper.querySelector('input')!;
    expect(document.activeElement).toBe(field);
    await act(async () => a.render(<Dialog {...props({ title: 'Lower', open: false })} />));
    expect(document.activeElement).toBe(field);
    await act(async () => { a.unmount(); b.unmount(); });
    lower.remove();
    upper.remove();
    page.remove();
  });

  it('lower closing first, then the upper: focus ends on the original page opener, not body', async () => {
    const page = document.createElement('button');
    const lower = document.createElement('div');
    const upper = document.createElement('div');
    document.body.append(page, lower, upper);
    page.focus();
    const a = createRoot(lower), b = createRoot(upper);
    await act(async () => a.render(<Dialog {...props({ title: 'Lower' })}><input aria-label="l" /><button id="go">go</button></Dialog>));
    document.getElementById('go')!.focus(); // the control in the lower dialog that opens the upper
    await act(async () => b.render(<Dialog {...props({ title: 'Upper' })}><input aria-label="u" /></Dialog>));
    await act(async () => a.render(<Dialog {...props({ title: 'Lower', open: false })} />));
    expect(upper.contains(document.activeElement)).toBe(true);
    await act(async () => b.render(<Dialog {...props({ title: 'Upper', open: false })} />));
    expect(document.activeElement).toBe(page);
    await act(async () => { a.unmount(); b.unmount(); });
    lower.remove();
    upper.remove();
    page.remove();
  });

  it('with focus lost to body, the newest sibling answers Escape and Tab alone', async () => {
    const first = vi.fn(), second = vi.fn();
    await render(
      <>
        <Dialog {...props({ title: 'One', onCancel: first })}><input aria-label="one" /></Dialog>
        <Dialog {...props({ title: 'Two', onCancel: second })}><input aria-label="two" /></Dialog>
      </>,
    );
    (document.activeElement as HTMLElement).blur();
    key('Escape', {}, document.body);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    key('Tab', {}, document.body);
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="two"]'));
  });

  it('two sibling dialogs: the later one answers Escape alone', async () => {
    const first = vi.fn(), second = vi.fn();
    await render(
      <>
        <Dialog {...props({ title: 'One', onCancel: first })} />
        <Dialog {...props({ title: 'Two', onCancel: second })} />
      </>,
    );
    key('Escape');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
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

describe('Tab trap: what counts as tabbable', () => {
  // With the footer disabled (busy, no confirm) the body's controls are the edges, so an element
  // the browser would skip but a naive selector keeps moves the wrap point and lets focus leave.
  const trapped = (body: ReactNode) => <Dialog {...props({ busy: true, onConfirm: undefined })}>{body}</Dialog>;
  const visible = <input aria-label="visible" />;
  const wrapsAt = (which: 'last' | 'first') => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="visible"]')!;
    input.focus();
    return key('Tab', { shiftKey: which === 'first' }).defaultPrevented;
  };

  const skipped: [string, ReactNode][] = [
    ['hidden attribute', <input aria-label="x" hidden />],
    ['display:none ancestor', <div style={{ display: 'none' }}><input aria-label="x" /></div>],
    ['visibility:hidden', <input aria-label="x" style={{ visibility: 'hidden' }} />],
    ['inert subtree', <div {...{ inert: '' }}><input aria-label="x" /></div>],
    ['aria-hidden subtree', <div aria-hidden="true"><input aria-label="x" /></div>],
    ['closed <details>', <details><summary>more</summary><input aria-label="x" /></details>],
    ['disabled <fieldset>', <fieldset disabled><input aria-label="x" /></fieldset>],
  ];

  for (const [name, hidden] of skipped) {
    it(`wraps past ${name} at the end, and at the start`, async () => {
      await render(trapped(<>{visible}{hidden}</>));
      // The closed <details>' own <summary> is tabbable, so the sole-control premise needs it out.
      const summary = document.querySelector('summary');
      if (summary) summary.setAttribute('tabindex', '-1');
      expect(wrapsAt('last')).toBe(true);
      await render(trapped(<>{hidden}{visible}</>));
      const s2 = document.querySelector('summary');
      if (s2) s2.setAttribute('tabindex', '-1');
      expect(wrapsAt('first')).toBe(true);
    });
  }

  it('twin: the same controls made reachable are not skipped — Tab from the first is left to the browser', async () => {
    await render(trapped(<>{visible}<input aria-label="x" /></>));
    expect(wrapsAt('last')).toBe(false);
    await render(trapped(<><details open><summary>more</summary><input aria-label="x" /></details>{visible}</>));
    document.querySelector('summary')!.setAttribute('tabindex', '-1');
    expect(wrapsAt('first')).toBe(false);
    await render(trapped(<><fieldset disabled><legend><input aria-label="x" /></legend></fieldset>{visible}</>));
    expect(wrapsAt('first')).toBe(false); // the first <legend> is exempt from a disabled fieldset
  });

  it('keeps an open <details>’ summary tabbable and a closed one’s too, but not the closed one’s content', async () => {
    await render(trapped(<><details><summary>more</summary><input aria-label="x" /></details>{visible}</>));
    const summary = document.querySelector('summary')!;
    summary.focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true); // summary is first
    visibleFocus();
    expect(key('Tab').defaultPrevented).toBe(true); // visible is last: x (closed) is not
  });

  it('counts one radio per named group: the checked one, else the first — never an unchecked last', async () => {
    await render(
      trapped(
        <>
          {visible}
          <input type="radio" name="g" aria-label="r1" defaultChecked />
          <input type="radio" name="g" aria-label="r2" />
        </>,
      ),
    );
    document.querySelector<HTMLInputElement>('input[aria-label="r1"]')!.focus();
    expect(key('Tab').defaultPrevented).toBe(true); // r1 is the group's stop, and the last
    await render(
      trapped(
        <>
          {visible}
          <input type="radio" name="g" aria-label="r1" />
          <input type="radio" name="g" aria-label="r2" />
        </>,
      ),
    );
    document.querySelector<HTMLInputElement>('input[aria-label="r1"]')!.focus();
    expect(key('Tab').defaultPrevented).toBe(true); // none checked: the first is the stop
    document.querySelector<HTMLInputElement>('input[aria-label="r2"]')!.focus();
    expect(key('Tab').defaultPrevented).toBe(false); // r2 is not a stop; the browser decides
  });

  it('a group is per form: same-named radios in different forms, or one outside any form, are each a stop', async () => {
    await render(
      trapped(
        <>
          <form><input type="radio" name="g" aria-label="r1" /></form>
          <form><input type="radio" name="g" aria-label="r2" /></form>
          <input type="radio" name="g" aria-label="r3" />
        </>,
      ),
    );
    const radio = (n: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${n}"]`)!;
    radio('r1').focus();
    expect(key('Tab').defaultPrevented).toBe(false); // r2 and r3 are stops after it
    radio('r3').focus();
    expect(key('Tab').defaultPrevented).toBe(true); // r3 is the last stop
    radio('r2').focus();
    expect(key('Tab').defaultPrevented).toBe(false);
  });

  it('twin: radios in different groups are each a stop', async () => {
    await render(
      trapped(
        <>
          <input type="radio" name="g1" aria-label="r1" />
          <input type="radio" name="g2" aria-label="r2" />
        </>,
      ),
    );
    document.querySelector<HTMLInputElement>('input[aria-label="r1"]')!.focus();
    expect(key('Tab').defaultPrevented).toBe(false);
  });
});

function visibleFocus() {
  document.querySelector<HTMLInputElement>('input[aria-label="visible"]')!.focus();
}
