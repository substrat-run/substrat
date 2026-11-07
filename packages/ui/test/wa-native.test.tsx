// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, Select } from '../src/wa';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the wrappers keep what the native element did', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('a Dialog unmounted while open gives focus back to its opener', async () => {
    vi.useFakeTimers();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    let close = () => {};
    function View() {
      const [open, setOpen] = useState(true);
      close = () => setOpen(false);
      return open ? <Dialog open title="Add" /> : null;
    }
    act(() => root.render(<View />));
    opener.blur();
    act(() => close());
    vi.runAllTimers();
    vi.useRealTimers();
    // The opener was focused as the dialog opened, and blurred as focus moved into it.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('a Select says nothing on a re-pick of the current option, and draws that option even when disabled', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Select
          value="a"
          options={[
            { value: 'a', label: 'A', disabled: true },
            { value: 'b', label: 'B', disabled: true },
          ]}
          onChange={onChange}
        />,
      ),
    );
    const select = container.querySelector('wa-select') as HTMLElement & { value: string };
    const pick = (v: string) =>
      act(() => {
        select.value = v;
        select.dispatchEvent(new Event('input', { bubbles: true }));
      });
    pick('a');
    expect(onChange).not.toHaveBeenCalled();
    pick('b');
    expect(onChange).toHaveBeenCalledTimes(1);
    const [a, b] = container.querySelectorAll('wa-option');
    expect(a!.hasAttribute('disabled')).toBe(false);
    expect(b!.hasAttribute('disabled')).toBe(true);
  });
});
