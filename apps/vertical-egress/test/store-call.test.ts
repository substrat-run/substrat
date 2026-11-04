import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_CALL_URL } from '@substrat-run/contracts';
import worker, { type Env } from '../src/worker.js';

/** The egress worker's half of a scope-store call (#2207), where the workerd hop cannot reach. */

afterEach(() => {
  vi.restoreAllMocks();
});

const SCOPE = '01J00000000000000000000S01';

function storeCall(invoke: NonNullable<Env['STORE_CALLS']>['invoke']): Promise<Response> {
  const env: Env = {
    ROUTER: { fetch: async () => new Response('routed') } as unknown as Fetcher,
    PLATFORM_BASE_DOMAINS: 'substrat.run',
    PLATFORM_CP_URL: 'https://console.substrat.net',
    OUTBOUND_POLICY: { slug: 'docs', tenant: '01JTESTATTACHTENANT000000A', hosts: [], scope: SCOPE },
    STORE_CALLS: { invoke },
  };
  return worker.fetch(
    new Request(STORE_CALL_URL, {
      method: 'POST',
      body: JSON.stringify({ scopeId: SCOPE, binding: 'GRAPH', operation: 'read' }),
    }),
    env,
  );
}

describe('a store call through egress', () => {
  it('answers a router that fails as unavailable, and logs nothing of the failure', async () => {
    const lines: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(...args));
    }
    const res = await storeCall(() => Promise.reject(new Error('Traceback: secret row s1')));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'substrat.unavailable', status: 503, body: 'the router could not be reached' } });
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it("answers a store's code reserved to the platform as a bad envelope, whatever the router passed on (#2815)", async () => {
    const res = await storeCall(async () => ({ ok: true, status: 403, body: { error: { code: 'substrat.refused', status: 403 } } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'substrat.bad_envelope', status: 502 } });
  });
});
