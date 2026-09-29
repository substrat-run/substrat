import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../src/components/CommandPalette';
import type { PaletteContext } from '../src/lib/palette';

/** #1921: the ⌘K overlay — keyboard first, one entry point for jumping and for support. */
const CTX: PaletteContext = {
  apps: [{ scopeId: 'A1', name: 'Helpdesk', host: null, status: 'active' }],
  currentApp: 'A1',
  models: { A1: { lifecycles: ['conversation'], entities: ['conversation'] } },
};

describe('CommandPalette', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { ticket0?: unknown }).ticket0;
    vi.restoreAllMocks();
  });

  const render = async (props: Partial<Parameters<typeof CommandPalette>[0]> = {}) => {
    const onGo = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(<CommandPalette ctx={CTX} onGo={onGo} onClose={onClose} {...props} />));
    return { onGo, onClose };
  };
  const key = (k: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: k })));
  const type = async (text: string) => {
    const input = container.querySelector('input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('filters as you type and opens the selected row with Enter', async () => {
    const { onGo, onClose } = await render();
    await type('conversation');
    expect(container.textContent).toContain('Process maps');
    await key('Enter');
    expect(onGo).toHaveBeenCalledWith({ kind: 'path', path: '/observability?app=A1&view=map&entity=conversation' });
    expect(onClose).toHaveBeenCalled();
  });

  it('moves with the arrows', async () => {
    const { onGo } = await render();
    await key('ArrowDown');
    await key('Enter');
    // The first row is the app, the second its process map.
    expect(onGo.mock.calls[0]![0]).toMatchObject({ path: '/observability?app=A1&view=map&entity=conversation' });
  });

  it('opens a pasted request id in the app the reader is in', async () => {
    const { onGo } = await render();
    await type('01J8ZQ4C7X0000000000000001');
    await key('Enter');
    expect(onGo.mock.calls[0]![0]).toMatchObject({ kind: 'request', scopeId: 'A1', invocationId: '01J8ZQ4C7X0000000000000001' });
  });

  it('switches to support with Tab, and opens the desk’s own conversation', async () => {
    const open = vi.fn();
    (window as { ticket0?: unknown }).ticket0 = { unmount: vi.fn(), open };
    const { onClose } = await render();
    await key('Tab');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Support');
    await key('Enter');
    expect(open).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('points at the bubble when the desk serves a widget without the verb, and says so when there is no desk', async () => {
    (window as { ticket0?: unknown }).ticket0 = { unmount: vi.fn() };
    const { onClose } = await render({ initialMode: 'support' });
    await key('Enter');
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('the bubble at the bottom right');
    delete (window as { ticket0?: unknown }).ticket0;
    await key('Enter');
    expect(container.textContent).toContain('Support is not set up on this deployment.');
  });

  it('closes on Escape', async () => {
    const { onClose } = await render();
    await key('Escape');
    expect(onClose).toHaveBeenCalled();
  });
});
