import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EnvImport } from '../src/views/EnvImport';
import { button, disabled, type } from './wa';

it('shows line errors before saving and submits valid entries with secret flags', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSave = vi.fn(async () => undefined);
  const render = () => root.render(<EnvImport spec={[{ key: 'API_TOKEN', description: '', required: false, secret: true }]} values={[]} onSave={onSave} onClose={() => undefined} />);
  await act(async () => render());
  const area = container.querySelector('wa-textarea')!;
  await act(async () => type(area, 'API_TOKEN=first\ninvalid\nPUBLIC_URL=https://example.test'));
  expect(container.textContent).toContain('Line 2');
  expect(disabled(button('Save', container)!)).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => type(area, 'API_TOKEN=first\nPUBLIC_URL=https://example.test'));
  await act(async () => button('Save', container)!.click());
  expect(onSave).toHaveBeenCalledWith([
    { key: 'API_TOKEN', value: 'first', secret: true },
    { key: 'PUBLIC_URL', value: 'https://example.test', secret: true },
  ]);
  expect(container.textContent).not.toContain('first');
  await act(async () => root.unmount());
  container.remove();
});
