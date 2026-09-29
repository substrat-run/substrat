import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEscapeLayer } from '../src/lib/escape-stack';

/** #1921: with a record, a request and the ⌘K overlay open, one Escape closes only the top. */
function Layer({ name, onClose }: { name: string; onClose: (n: string) => void }) {
  useEscapeLayer(() => onClose(name));
  return <div>{name}</div>;
}

describe('useEscapeLayer', () => {
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
  });
  const esc = () => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

  it('hands Escape to the newest layer only, then to the one beneath once it closes', async () => {
    const closed = vi.fn();
    const draw = (open: string[]) => act(async () => root.render(<>{open.map((n) => <Layer key={n} name={n} onClose={closed} />)}</>));
    await draw(['record', 'request']);
    await esc();
    expect(closed.mock.calls).toEqual([['request']]);
    await draw(['record']);
    await esc();
    expect(closed.mock.calls).toEqual([['request'], ['record']]);
  });

  it('puts a later layer on top even when mounted beside existing ones — the overlay above the panels', async () => {
    const closed = vi.fn();
    await act(async () => root.render(<><Layer name="record" onClose={closed} /></>));
    await act(async () => root.render(<><Layer name="record" onClose={closed} /><Layer name="overlay" onClose={closed} /></>));
    await esc();
    expect(closed.mock.calls).toEqual([['overlay']]);
  });

  it('does nothing once every layer has closed', async () => {
    const closed = vi.fn();
    await act(async () => root.render(<Layer name="only" onClose={closed} />));
    await act(async () => root.render(<></>));
    await esc();
    expect(closed).not.toHaveBeenCalled();
  });
});
