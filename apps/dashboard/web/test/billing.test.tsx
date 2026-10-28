import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { Billing } from '../src/views/Billing';

const read = vi.hoisted(() => vi.fn());
const readUsage = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  teamApi: () => ({ listEntitlements: read, readMeteredUsage: readUsage }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  read.mockReset();
  readUsage.mockReset();
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'unavailable', bytes: null, estimated: false, basis: 'scope-databases', sampled: 0, total: 0, failing: 0, oldestReadAt: null, excluded: ['attachments', 'tenant-stores', 'lake'] },
    requests: { state: 'unavailable', requests: null, estimated: true, lowerBound: false, coveredDays: 0, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: null, byVertical: [], breakdownTruncated: false },
    models: { state: 'empty', calls: null, inputTokens: null, outputTokens: null, estimated: false, lowerBound: false, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: null, newestRecordedAt: null, byVerticalModel: [], breakdownTruncated: false },
  });
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
  expect(readUsage).not.toHaveBeenCalled();
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

it('distinguishes unavailable sources from no model usage, without displaying zeros', async () => {
  read.mockResolvedValue([]);
  await render();
  expect(container.textContent).toContain('not available');
  expect(container.textContent).toContain('No model usage recorded');
  expect(container.textContent).not.toMatch(/0 bytes|0 requests|0 recorded calls/);
});

it('shows metered usage coverage, estimate and freshness without prices', async () => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'complete', bytes: 65_536, estimated: false, basis: 'scope-databases', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: ['attachments', 'tenant-stores', 'lake'] },
    requests: { state: 'partial', requests: 7, estimated: true, lowerBound: true, coveredDays: 1, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [{ vertical: 'app', requests: 7 }], breakdownTruncated: false },
    models: { state: 'truncated', calls: 1, inputTokens: 11, outputTokens: 3, estimated: false, lowerBound: true, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [{ vertical: 'app', model: 'provider:model', calls: 1, inputTokens: 11, outputTokens: 3 }], breakdownTruncated: false },
  });
  await render();
  expect(container.textContent).toContain('65,536');
  expect(container.textContent).toContain('7');
  expect(container.textContent).toContain('estimated');
  expect(container.textContent).toContain('as reported');
  expect(container.textContent).toContain('At least');
  expect(container.textContent).toContain('truncated');
  expect(container.textContent).toContain('13 months');
  expect(container.textContent).toContain('400 days');
  expect(container.textContent).toContain('2026-10-28');
  expect(container.textContent).not.toMatch(/price|margin|usd|cost|amount|invoice|checkout|payment/i);
});

it('labels new plane vocabulary as unknown and treats its figures as estimates and lower bounds', async () => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'new-storage-state', bytes: 8, estimated: 'new-estimate-mode', basis: 'scope-databases', lowerBound: false, truncatedReason: 'new-storage-reason', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: ['attachments', 'new-exclusion'] },
    requests: { state: 'new-request-state', requests: 7, estimated: 'new-estimate-mode', lowerBound: false, coveredDays: 1, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
    models: { state: 'new-model-state', calls: 1, inputTokens: 11, outputTokens: 3, estimated: 'new-estimate-mode', lowerBound: false, truncatedReason: 'new-model-reason', since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
  });
  await render();
  expect(container.textContent).toContain('unknown (new-storage-state)');
  expect(container.textContent).toContain('unknown (new-request-state)');
  expect(container.textContent).toContain('unknown (new-model-state)');
  expect(container.textContent).toContain('other (new-exclusion)');
  expect(container.textContent).toContain('At least 8 bytes');
  expect(container.textContent).toContain('At least 7 estimated');
  expect(container.textContent).toContain('At least 1 recorded calls');
  expect(container.textContent).toContain('Estimate: unknown; treat this figure as an estimate');
  expect(container.textContent).not.toContain('· complete');
});

it('shows usage unavailable on read failure and recognizes a handwritten 403 refusal', async () => {
  read.mockResolvedValue([]);
  readUsage.mockRejectedValue(new Error('offline'));
  await render();
  expect(container.textContent).toContain('Usage is unavailable');
  act(() => root.unmount());
  root = createRoot(container);
  read.mockResolvedValue([{ key: 'private-grant' }]);
  readUsage.mockRejectedValue(new ApiError(403, 'Forbidden'));
  await render();
  expect(container.textContent).toContain('Ask a team owner or admin to view entitlements.');
  expect(container.textContent).not.toContain('Usage is unavailable');
  expect(container.textContent).not.toContain('private-grant');
});
