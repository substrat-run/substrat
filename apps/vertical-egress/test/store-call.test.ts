import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORE_CALL_URL } from '@substrat-run/contracts';
import worker, { type Env } from '../src/worker.js';

/** The egress worker's half of a scope-store call (#2207), where the workerd hop cannot reach. */

afterEach(() => {
  vi.restoreAllMocks();
});

const SCOPE = '01J00000000000000000000S01';

function storeCall(
  invoke: NonNullable<Env['STORE_CALLS']>['invoke'],
  call: object = { scopeId: SCOPE, binding: 'GRAPH', operation: 'read' },
): Promise<Response> {
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
      body: JSON.stringify(call),
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
    const res = await storeCall(async () => ({ ok: true, status: 403, body: { error: { code: 'substrat.too_large', status: 413 } } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'substrat.bad_envelope', status: 502 } });
  });

  it("passes on the router's rule code, and derives one from the status for a router that sends none (#2406)", async () => {
    const coded = await storeCall(async () => ({ ok: false, status: 404, code: 'substrat.undeclared_binding', message: 'not declared' }));
    expect([coded.status, await coded.json()]).toEqual([404, { error: { code: 'substrat.undeclared_binding', status: 404, body: 'not declared' } }]);
    // A router deployed before #2406 sends no code, and a code outside the platform's is not passed on.
    for (const [status, code, sent] of [[403, 'substrat.refused', undefined], [503, 'substrat.unavailable', 'session.unknown']] as const) {
      const older = await storeCall(async () => ({ ok: false, status, message: 'm', ...(sent ? { code: sent } : {}) }));
      expect(await older.json()).toEqual({ error: { code, status, body: 'm' } });
    }
  });

  it('refuses a reserved operation itself, with its rule code, before the router', async () => {
    const invoke = vi.fn();
    const res = await storeCall(invoke, { scopeId: SCOPE, binding: 'GRAPH', operation: 'substrat.wipe' });
    expect([res.status, await res.json()]).toEqual([
      403,
      { error: { code: 'substrat.reserved_operation', status: 403, body: "store operation 'substrat.wipe' is reserved for the platform" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
