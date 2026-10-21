import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppRow } from '../src/lib/api';
import { EmailSenderPermission } from '../src/views/AppDetail';

const client = vi.hoisted(() => ({ appEmailSender: vi.fn(), setAppEmailSender: vi.fn() }));
vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()), teamApi: () => client,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client.appEmailSender.mockResolvedValue({ slug: 'acme/app', emailSender: false });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
const render = () => act(async () => root.render(<EmailSenderPermission teamId="team" app={{ app_scope_id: 'scope' } as AppRow} />));
const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!;
it('enables and revokes email sending using the returned grant', async () => {
  await render();
  expect(toggle().checked).toBe(false);
  for (const granted of [true, false]) {
    client.setAppEmailSender.mockResolvedValue({ slug: 'acme/app', emailSender: granted });
    await act(async () => toggle().click());
    expect(client.setAppEmailSender).toHaveBeenLastCalledWith({ scopeId: 'scope', granted });
    expect(toggle().checked).toBe(granted);
  }
  expect(container.textContent).toContain('every installation');
});
it('keeps the grant unchanged and displays a refused change', async () => {
  await render();
  client.setAppEmailSender.mockRejectedValue(new Error('permission denied'));
  await act(async () => toggle().click());
  expect(toggle().checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('permission denied');
});
