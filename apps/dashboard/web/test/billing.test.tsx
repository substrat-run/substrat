import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { isExactUsageFigure } from '../src/lib/usage-precision';
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
    models: { state: 'empty', calls: null, reportedCalls: 0, inputTokens: null, outputTokens: null, estimated: false, lowerBound: false, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: null, newestRecordedAt: null, byVerticalModel: [], breakdownTruncated: false },
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

const modelUsagePayload = (models: object) => ({
  readAt: '2026-10-29T00:00:00Z',
  retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
  storage: { state: 'unavailable', bytes: null, estimated: false, basis: 'scope-databases', lowerBound: false, truncatedReason: null, sampled: 0, total: 0, failing: 0, oldestReadAt: null, excluded: [] },
  requests: { state: 'unavailable', requests: null, estimated: true, lowerBound: false, coveredDays: 0, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: null, byVertical: [], breakdownTruncated: false },
  models,
});

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
    models: { state: 'truncated', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: false, lowerBound: true, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [{ vertical: 'app', model: 'provider:model', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3 }], breakdownTruncated: false },
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

it.each([
  { name: 'mixed', calls: 2, reportedCalls: 1, inputTokens: 14, outputTokens: 7, tokens: 'At least 14 input', expectedLabel: '1 of 2 calls reported usage', exact: false },
  { name: 'all reported', calls: 2, reportedCalls: 2, inputTokens: 20, outputTokens: 10, tokens: '20 input', expectedLabel: '2 of 2 calls reported usage', exact: true },
  { name: 'none reported', calls: 1, reportedCalls: 0, inputTokens: null, outputTokens: null, tokens: 'Tokens not reported', expectedLabel: '0 of 1 calls reported usage', exact: false },
])('shows $name model token coverage without turning unreported calls into zeroes', async ({ calls, reportedCalls, inputTokens, outputTokens, tokens, expectedLabel, exact }) => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue(modelUsagePayload({
    state: 'complete', calls, reportedCalls, inputTokens, outputTokens,
    estimated: false, lowerBound: false, truncatedReason: null,
    since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z',
    byVerticalModel: [{ vertical: 'app', model: 'provider:model', calls, reportedCalls, inputTokens, outputTokens }], breakdownTruncated: false,
  }));
  await render();
  const text = container.textContent ?? '';
  const modelText = text.slice(text.indexOf('Model usage'));
  expect(modelText).toContain(`${calls} recorded calls`);
  expect(modelText).toContain(expectedLabel);
  expect(modelText).toContain(tokens);
  expect(modelText).toContain(`${reportedCalls} of ${calls} calls reported usage`);
  expect(modelText).toContain(`app · provider:model: ${calls} calls; ${reportedCalls} of ${calls} calls reported usage`);
  if (exact) expect(modelText).not.toContain('At least');
  else if (reportedCalls > 0) expect(modelText).toContain('At least');
  if (reportedCalls === 0) expect(modelText).not.toMatch(/0 input|0 output/);
});

it('labels new plane vocabulary as unknown and treats its figures as estimates and lower bounds', async () => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'new-storage-state', bytes: 8, estimated: 'new-estimate-mode', basis: 'scope-databases', lowerBound: false, truncatedReason: 'new-storage-reason', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: ['attachments', 'new-exclusion'] },
    requests: { state: 'new-request-state', requests: 7, estimated: 'new-estimate-mode', lowerBound: false, coveredDays: 1, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
    models: { state: 'new-model-state', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: 'new-estimate-mode', lowerBound: false, truncatedReason: 'new-model-reason', since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
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

it('shows numeric figures as lower bounds when coverage is incomplete or a new truncation reason is present', async () => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'complete', bytes: 8, estimated: false, basis: 'scope-databases', lowerBound: false, truncatedReason: 'new-storage-limit', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: [] },
    requests: { state: 'partial', requests: 7, estimated: true, lowerBound: false, coveredDays: 1, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
    models: { state: 'complete', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: false, lowerBound: false, truncatedReason: 'new-model-limit', since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
  });
  await render();
  expect(container.textContent).toContain('At least 8 bytes');
  expect(container.textContent).toContain('At least 7 estimated request counts');
  expect(container.textContent).toContain('At least 1 recorded calls');
  expect(container.textContent).toContain('At least 11 input');
  expect(container.textContent).toContain('new-storage-limit');
  expect(container.textContent).toContain('new-model-limit');
  expect(container.textContent).not.toContain('Estimate: no;');
});

const signalValues = ['', ' ', 'x', 0, false, null, undefined, 'maybe', true] as const;
const exactSignals = { truncated: false, reason: null, coverage: 'complete', estimated: false } as const;
const expectedExact: Record<keyof typeof exactSignals, readonly boolean[]> = {
  truncated: [false, false, false, false, true, false, false, false, false],
  reason: [false, false, false, false, false, true, true, false, false],
  coverage: [false, false, false, false, false, false, false, false, false],
  estimated: [false, false, false, false, true, false, false, false, false],
};
it('shows an exact figure only when all signals are positively known-good', () => {
  expect(isExactUsageFigure(exactSignals)).toBe(true);
  expect(isExactUsageFigure({ ...exactSignals, complete: false })).toBe(false);
});
for (const field of Object.keys(exactSignals) as (keyof typeof exactSignals)[]) {
  signalValues.forEach((value, index) => {
    it(`requires positively known-good ${field}=${String(value)} for an exact figure`, () => {
      const signals = { ...exactSignals, [field]: value };
      expect(isExactUsageFigure(signals)).toBe(expectedExact[field][index]);
    });
  });
}

it('shows whitespace truncation reasons as limited lower bounds', async () => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z', retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'complete', bytes: 8, estimated: false, basis: 'scope-databases', lowerBound: false, truncatedReason: ' ', sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: [] },
    requests: { state: 'complete', requests: 7, estimated: false, lowerBound: false, coveredDays: 30, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
    models: { state: 'complete', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: false, lowerBound: false, truncatedReason: ' ', since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
  });
  await render();
  expect(container.textContent).toContain('At least 8 bytes');
  expect(container.textContent).toContain('At least 1 recorded calls');
  expect(container.textContent).toContain('limited');
  const text = container.textContent ?? '';
  expect(text.slice(text.indexOf('Stored bytes'), text.indexOf('Router requests'))).not.toContain('Estimate: no;');
  expect(text.slice(text.indexOf('Model usage'))).not.toContain('Estimate: no;');
});

it.each([null, 0] as const)('treats absent, null, or numeric estimate metadata (%s) as estimated lower bounds', async (estimate) => {
  read.mockResolvedValue([]);
  readUsage.mockResolvedValue({
    readAt: '2026-10-29T00:00:00Z',
    retention: { storageMonths: 13, modelDays: 400, requestMonths: null },
    storage: { state: 'complete', bytes: 8, estimated: estimate, basis: 'scope-databases', lowerBound: false, truncatedReason: null, sampled: 1, total: 1, failing: 0, oldestReadAt: '2026-10-28T00:00:00Z', excluded: [] },
    requests: { state: 'complete', requests: 7, ...(estimate === null ? {} : { estimated: estimate }), lowerBound: false, coveredDays: 30, totalDays: 30, sinceDay: '2026-09-29', untilDay: '2026-10-28', lastReadAt: '2026-10-29T00:00:00Z', byVertical: [], breakdownTruncated: false },
    models: { state: 'complete', calls: 1, reportedCalls: 1, inputTokens: 11, outputTokens: 3, estimated: estimate, lowerBound: false, truncatedReason: null, since: '2026-09-29T00:00:00Z', until: '2026-10-29T00:00:00Z', oldestRecordedAt: '2026-10-28T12:00:00Z', newestRecordedAt: '2026-10-28T12:00:00Z', byVerticalModel: [], breakdownTruncated: false },
  });
  await render();
  expect(container.textContent).toContain('At least 8 bytes');
  expect(container.textContent).toContain('At least 7 estimated request counts');
  expect(container.textContent).toContain('At least 1 recorded calls');
  expect(container.textContent).toContain('Estimate: unknown or estimated; treat this figure as an estimate');
  if (estimate === 0) expect(container.textContent).toContain('unknown (0)');
  expect(container.textContent).not.toContain('Estimate: no;');
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
