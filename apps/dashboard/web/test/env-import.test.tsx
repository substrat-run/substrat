import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EnvImport } from '../src/views/EnvImport';

it('shows line errors before saving and submits valid entries with secret flags', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSave = vi.fn(async () => undefined);
  const render = () => root.render(<EnvImport spec={[{ key: 'API_TOKEN', description: '', required: false, secret: true }]} values={[]} onSave={onSave} onClose={() => undefined} />);
  await act(async () => render());
  const area = container.querySelector('textarea')!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { set.call(area, 'API_TOKEN=first\ninvalid\nPUBLIC_URL=https://example.test'); area.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).toContain('Line 2');
  expect([...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.disabled).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => { set.call(area, 'API_TOKEN=first\nPUBLIC_URL=https://example.test'); area.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click());
  expect(onSave).toHaveBeenCalledWith([
    { key: 'API_TOKEN', value: 'first', secret: true },
    { key: 'PUBLIC_URL', value: 'https://example.test', secret: true },
  ]);
  expect(container.textContent).not.toContain('first');
  await act(async () => root.unmount());
  container.remove();
});
