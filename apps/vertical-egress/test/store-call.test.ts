import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_CALL_URL } from '@substrat-run/contracts';
import worker, { type Env } from '../src/worker.js';

/** The egress worker's half of a scope-store call (#2207), where the workerd hop cannot reach. */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a store call through egress', () => {
  it('answers a router that fails as unavailable, and logs nothing of the failure', async () => {
    const lines: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(...args));
    }
    const env: Env = {
      ROUTER: { fetch: async () => new Response('routed') } as unknown as Fetcher,
      PLATFORM_BASE_DOMAINS: 'substrat.run',
      PLATFORM_CP_URL: 'https://console.substrat.net',
      OUTBOUND_POLICY: { slug: 'docs', tenant: '01JTESTATTACHTENANT000000A', hosts: [], scope: '01J00000000000000000000S01' },
      STORE_CALLS: { invoke: () => Promise.reject(new Error('Traceback: secret row s1')) },
    };
    const res = await worker.fetch(
      new Request(STORE_CALL_URL, {
        method: 'POST',
        body: JSON.stringify({ scopeId: '01J00000000000000000000S01', binding: 'GRAPH', operation: 'read' }),
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'unavailable', status: 503, body: 'the router could not be reached' } });
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});
