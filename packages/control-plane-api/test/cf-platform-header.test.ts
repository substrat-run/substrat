import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

/**
 * The runtime's record of a request carries its headers, and one written while invocation logs
 * were on holds the platform credential in `x-substrat-platform`. No reader returns its value.
 */
const CREDENTIAL = 'credential-value-never-returned';

const runtimeRecord = (requestId: string) => ({
  timestamp: 1002,
  $metadata: { id: `01RT${requestId}`, requestId, type: 'cf-worker-event', service: 'acme-widgets' },
  $workers: {
    requestId,
    outcome: 'ok',
    cpuTimeMs: 3,
    event: { request: { url: 'https://acme.test/internal/drain', method: 'POST', headers: { 'X-Substrat-Platform': CREDENTIAL, accept: '*/*' } } },
  },
});

function fakedCloudflare() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { view?: string };
      const events = [runtimeRecord('req-01RT')];
      const result = body.view === 'events' ? { events: { events } } : { calculations: [] };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }),
  );
  return createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });
}

afterEach(() => vi.unstubAllGlobals());

describe('no reader returns the platform credential from a runtime record', () => {
  it.each([
    ['the fleet view', { hours: 24, limit: 50 }],
    ['the service-grain view', { services: ['acme-widgets'], hours: 24, limit: 50 }],
  ])('%s keeps the record and drops the value', async (_, input) => {
    const { events } = await fakedCloudflare().recentLogs(input);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(events)).toContain('"accept":"*/*"');
  });
});
