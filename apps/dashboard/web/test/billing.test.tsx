import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { Billing } from '../src/views/Billing';

const read = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  teamApi: () => ({ listEntitlements: read }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  read.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (canRead = true) => act(async () => { root.render(<Billing teamId="team-a" canRead={canRead} />); });

it('shows unavailable when the entitlement read fails, with no sample plan or invoice', async () => {
  read.mockRejectedValue(new Error('unavailable'));
  await render();
  expect(container.textContent).toContain('Entitlements are unavailable');
  expect(container.textContent).not.toMatch(/Documents engine|€480|Paid|VISA/);
});

it('asks a member to contact an owner or admin without reading grants', async () => {
  await render(false);
  expect(container.textContent).toContain('Ask a team owner or admin to view entitlements.');
  expect(read).not.toHaveBeenCalled();
});

it('shows the owner/admin refusal for a handwritten API 403', async () => {
  read.mockRejectedValue(new ApiError(403, 'Forbidden'));
  await render();
  expect(container.textContent).toContain('Ask a team owner or admin to view entitlements.');
  expect(container.textContent).not.toContain('Entitlements are unavailable');
});

it('shows exactly the granted keys and supplied quota or expiry', async () => {
  read.mockResolvedValue([{ key: 'app', quota: 7 }, { key: 'reports', expiresAt: '2027-01-01T00:00:00Z' }]);
  await render();
  expect(container.textContent).toContain('app');
  expect(container.textContent).toContain('Quota: 7');
  expect(container.textContent).toContain('reports');
  expect(container.textContent).toContain('2027-01-01');
  expect(container.textContent).not.toMatch(/Documents engine|€480|Paid|VISA/);
});
