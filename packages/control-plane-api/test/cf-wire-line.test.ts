import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

/**
 * RFC wire-signing §8: the platform entry writes one `{ substrat: 'wire' }` line per request it
 * judged, with the refusal's reason on it, sharing the request's id. It is the platform's counter,
 * so no reader may return it: not the tenant-grain view, not the service-grain view a confined
 * principal reads for its own services, not the request list. Every `events` query the faked
 * Cloudflare answers here carries one beside the lines the reader is for.
 */

/** Only the wire line carries this outcome, so finding it anywhere in an answer means the line leaked. */
const LEAKED = 'legacy-accepted';

const wireLine = (requestId: string) => ({
  timestamp: 1003,
  source: {
    substrat: 'wire',
    state: 'dual',
    issuer: 'router',
    kind: 'route',
    outcome: LEAKED,
    reason: 'signature',
    fault: null,
    legacy: 'valid',
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    versionId: null,
  },
  $metadata: { id: `01WIRE${requestId}`, requestId, service: 'acme-widgets' },
});

const invocation = {
  timestamp: 1000,
  source: {
    substrat: 'invocation',
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    vertical: 'acme/widgets',
    method: 'POST',
    path: '/api/orders',
    status: 200,
    threw: false,
    durationMs: 42,
    level: 'info',
    invocationId: '01JZ0000000000000000INV001',
  },
  $metadata: { id: '01EV', requestId: 'req-01EV', service: 'acme-widgets' },
};

const ownLine = {
  timestamp: 1001,
  source: { level: 'error', message: 'the vertical’s own line' },
  $metadata: { id: '01OWN', requestId: 'req-01EV', level: 'error', message: 'the vertical’s own line', service: 'acme-widgets' },
};

function fakedCloudflare() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { view?: string };
      const result = body.view === 'events' ? { events: { events: [wireLine('req-01EV'), invocation, ownLine] } } : { calculations: [] };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }),
  );
  return createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });
}

afterEach(() => vi.unstubAllGlobals());

describe('no reader returns the platform’s wire line', () => {
  const lines: Array<[string, (reader: ReturnType<typeof fakedCloudflare>) => Promise<unknown[]>]> = [
    ['the fleet view', (r) => r.recentLogs({ hours: 24, limit: 50 })],
    ['the service-grain view of one service', (r) => r.recentLogs({ services: ['acme-widgets'], hours: 24, limit: 50 })],
    ['the service-grain view of several', (r) => r.recentLogs({ services: ['acme-widgets', 'acme-widgets-v2'], hours: 24, limit: 50 })],
    ['the tenant view', (r) => r.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 50 })],
    ['the tenant view’s error read', (r) => r.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 50 })],
    ['the tenant view of one invocation', (r) => r.tenantLogs!({ tenantId: '01TENANT', invocationId: '01JZ0000000000000000INV001', hours: 24, limit: 50 })],
    ['the tenant request list', (r) => r.tenantRequests!({ tenantId: '01TENANT', services: ['acme-widgets'], from: 0, to: 2000, limit: 50 })],
  ];

  it.each(lines)('%s: the lines it is for, and not the wire line', async (_, read) => {
    const answer = await read(fakedCloudflare());
    expect(answer.length).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain(LEAKED);
    expect(JSON.stringify(answer)).not.toContain('"wire"');
  });

  it('the field-coverage read, which counts the lines it reads, counts none of it', async () => {
    const report = await fakedCloudflare().fieldCoverage!({
      tenantId: '01TENANT',
      vertical: 'acme/widgets',
      scopeId: '01SCOPE',
      services: ['acme-widgets'],
      hours: 24,
    });
    expect(JSON.stringify(report)).not.toContain(LEAKED);
  });
});
