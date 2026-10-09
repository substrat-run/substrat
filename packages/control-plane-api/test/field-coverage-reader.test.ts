import { afterEach, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

afterEach(() => vi.unstubAllGlobals());

it('queries only one tenant and one app family, then joins router rate before returning counts', async () => {
  const tenant = '01JZ0000000000000000TEN001';
  const id = '01JZ0000000000000000000001';
  const requests: Array<{ filters: unknown[] }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { parameters: { filters: unknown[] } };
    requests.push(body.parameters);
    const router = body.parameters.filters.some((f) => JSON.stringify(f).includes('"router"'));
    const source = router
      ? { router: 'request', tenantId: tenant, scopeId: 'scope-a', vertical: 'acme/widgets', fieldCoverageId: id, fieldCoverageRate: 0.2 }
      : { substrat: 'invocation', tenantId: tenant, vertical: 'acme/widgets', versionId: 'v1',
          method: 'GET', operation: 'acme/get', fieldCoverageId: id,
          outputFields: { present: ['id'], empty: [], absent: [] } };
    const service = router ? 'substrat-router' : 'acme-widgets';
    return new Response(JSON.stringify({ success: true, result: { events: { events: [{ source, $metadata: { service } }] } } }),
      { status: 200 });
  }));
  const read = await createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok' }).fieldCoverage!({
    tenantId: tenant, vertical: 'acme/widgets', scopeId: 'scope-a', services: ['acme-widgets'], versionId: 'v1',
    declared: { 'acme/get': ['id'] }, hours: 1,
  });
  expect(requests).toHaveLength(3); // vertical plus both router environments
  expect(requests.every((r) => JSON.stringify(r.filters).includes(tenant))).toBe(true);
  expect(requests.every((r) => JSON.stringify(r.filters).includes('acme/widgets'))).toBe(true);
  // The router queries are narrowed to the page's scope, read off the router's own line.
  expect(requests.filter((r) => JSON.stringify(r.filters).includes('"router"'))
    .every((r) => JSON.stringify(r.filters).includes('"scopeId"') && JSON.stringify(r.filters).includes('scope-a'))).toBe(true);
  expect(read.groups[0]?.sampleRate).toBe(0.2);
  expect(read.groups[0]?.operations[0]?.fields[0]?.present).toBe(1);
});
