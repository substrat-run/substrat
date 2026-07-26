import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker.js';

/**
 * The router's job is small and the ways it can be wrong are not: forwarding to the
 * wrong vertical, or letting a caller name its own tenant, both read as "it works"
 * right up until they don't.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';

interface Row {
  tenant_id: string;
  scope_id: string;
  vertical_slug: string | null;
  surface: string;
  region: string | null;
  status: string;
  deployment_ref?: string | null;
}

const row = (over: Partial<Row> = {}): Row => ({
  tenant_id: T,
  scope_id: S,
  vertical_slug: 'fsm',
  surface: 'app',
  region: null,
  status: 'active',
  ...over,
});

/**
 * A control-plane namespace that enforces what workerd enforces.
 *
 * A Durable Object stub is an I/O object owned by the request that created it. Using
 * one from an earlier request throws "Cannot perform I/O on behalf of a different
 * request" — and only from the SECOND request onward, so a suite that sends one
 * request per test cannot see it. That is exactly how this shipped, and why the fake
 * models the constraint instead of merely counting calls.
 *
 * `beginRequest()` marks a request boundary, the way a new invocation would.
 */
function directory(rows: Record<string, Row>) {
  let request = 0;
  let stubs = 0;
  const ns = {
    idFromName: () => 'id',
    get: () => {
      stubs += 1;
      const bornIn = request;
      return {
        readHostname: async (hostname: string) => {
          if (bornIn !== request) {
            throw new Error(
              'Cannot perform I/O on behalf of a different request. I/O objects ' +
                '(such as streams, request/response bodies, and others) created in the ' +
                'context of one request handler cannot be accessed from a different ' +
                "request's handler.",
            );
          }
          return rows[hostname];
        },
      };
    },
  };
  return Object.assign(ns as unknown as DurableObjectNamespace, {
    beginRequest: () => {
      request += 1;
    },
    stubs: () => stubs,
  });
}

/** A vertical that echoes back what it was asked, so we can assert on the assertion. */
function spyVertical(): { binding: Fetcher; seen: () => Request } {
  let last: Request | undefined;
  return {
    binding: {
      fetch: async (req: Request) => {
        last = req;
        return new Response('ok');
      },
    } as unknown as Fetcher,
    seen: () => {
      if (!last) throw new Error('vertical was never called');
      return last;
    },
  };
}

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe('router', () => {
  it('resolves the hostname and forwards to that vertical', async () => {
    const fsm = spyVertical();
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: fsm.binding,
    } as unknown as Env;

    const res = await worker.fetch(get('https://acme.example.com/api/repairs'), env);

    expect(res.status).toBe(200);
    const seen = fsm.seen();
    expect(seen.headers.get('x-substrat-tenant')).toBe(T);
    expect(seen.headers.get('x-substrat-scope')).toBe(S);
    expect(seen.headers.get('x-substrat-surface')).toBe('app');
    expect(seen.headers.get('x-substrat-vertical')).toBe('fsm');
    // The path and method survive — this is a forward, not a redirect.
    expect(new URL(seen.url).pathname).toBe('/api/repairs');
  });

  it('STRIPS a client-supplied assertion before making its own', async () => {
    // The whole trust boundary in one test. If a caller can smuggle these through,
    // the vertical serves whichever tenant the caller named.
    const fsm = spyVertical();
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: fsm.binding,
    } as unknown as Env;

    await worker.fetch(
      get('https://acme.example.com/', {
        'x-substrat-tenant': '01JZ00000000000000000000EV',
        'x-substrat-scope': '01JZ00000000000000000000IL',
        'x-substrat-router': 'i-guessed-the-secret',
        'x-substrat-surface': 'back-office',
      }),
      env,
    );

    const seen = fsm.seen();
    expect(seen.headers.get('x-substrat-tenant')).toBe(T);
    expect(seen.headers.get('x-substrat-scope')).toBe(S);
    expect(seen.headers.get('x-substrat-surface')).toBe('app');
    // No secret is configured here, so none should be forwarded — the caller's
    // guess must not survive as one.
    expect(seen.headers.get('x-substrat-router')).toBeNull();
  });

  it('preserves headers it does not own', async () => {
    const fsm = spyVertical();
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: fsm.binding,
    } as unknown as Env;

    await worker.fetch(
      get('https://acme.example.com/', { cookie: 'session=abc', 'x-request-id': 'r1' }),
      env,
    );

    expect(fsm.seen().headers.get('cookie')).toBe('session=abc');
    expect(fsm.seen().headers.get('x-request-id')).toBe('r1');
  });

  it('presents the router secret when one is configured', async () => {
    const fsm = spyVertical();
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: fsm.binding,
      ROUTER_SECRET: 'shhh',
    } as unknown as Env;

    await worker.fetch(get('https://acme.example.com/'), env);
    expect(fsm.seen().headers.get('x-substrat-router')).toBe('shhh');
  });

  it('sends two surfaces of one scope to the binding, distinguished by header', async () => {
    // A scope fronts a storefront and a back office. Same vertical, same data,
    // different app — the vertical needs to be told which.
    const shop = spyVertical();
    const env = {
      CONTROL_PLANE: directory({
        'shop.example.com': row({ vertical_slug: 'shop', surface: 'storefront' }),
        'admin.shop.example.com': row({ vertical_slug: 'shop', surface: 'back-office' }),
      }),
      VERTICAL_SHOP: shop.binding,
    } as unknown as Env;

    await worker.fetch(get('https://shop.example.com/'), env);
    expect(shop.seen().headers.get('x-substrat-surface')).toBe('storefront');

    await worker.fetch(get('https://admin.shop.example.com/'), env);
    expect(shop.seen().headers.get('x-substrat-surface')).toBe('back-office');
  });

  // -- dispatch on the bound version (orchestration.md §5.4) -----------------

  it('dispatches on the scope bound version through the namespace', async () => {
    let dispatched: string | undefined;
    const fsm = spyVertical();
    const DISPATCH = {
      get: (name: string) => {
        dispatched = name;
        return fsm.binding;
      },
    };
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row({ deployment_ref: 'fsm-01ky535a' }) }),
      DISPATCH,
    } as unknown as Env;

    const res = await worker.fetch(get('https://acme.example.com/api/x'), env);
    expect(res.status).toBe(200);
    // It dispatched on the deploymentRef, not the slug.
    expect(dispatched).toBe('fsm-01ky535a');
    expect(fsm.seen().headers.get('x-substrat-tenant')).toBe(T);
    expect(fsm.seen().headers.get('x-substrat-scope')).toBe(S);
  });

  it('falls back to the static binding when the scope has no bound version', async () => {
    const fsm = spyVertical();
    const DISPATCH = {
      get: () => {
        throw new Error('should not dispatch a route with no version');
      },
    };
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }), // no deployment_ref
      DISPATCH,
      VERTICAL_FSM: fsm.binding,
    } as unknown as Env;
    expect((await worker.fetch(get('https://acme.example.com/'), env)).status).toBe(200);
  });

  it('maps a dashed slug to its binding name', async () => {
    const bikes = spyVertical();
    const env = {
      CONTROL_PLANE: directory({ 'bikes.example.com': row({ vertical_slug: 'bike-shop' }) }),
      VERTICAL_BIKE_SHOP: bikes.binding,
    } as unknown as Env;

    expect((await worker.fetch(get('https://bikes.example.com/'), env)).status).toBe(200);
  });

  it('404s an unknown hostname', async () => {
    const env = { CONTROL_PLANE: directory({}) } as unknown as Env;
    expect((await worker.fetch(get('https://nobody.example.com/'), env)).status).toBe(404);
  });

  it('404s a hostname that is bound but not yet active', async () => {
    // Still validating DNS, or its certificate failed. From outside, all the same:
    // which of those it is belongs in the console, not in a public response.
    const env = {
      CONTROL_PLANE: directory({ 'soon.example.com': row({ status: 'pending' }) }),
      VERTICAL_FSM: spyVertical().binding,
    } as unknown as Env;
    expect((await worker.fetch(get('https://soon.example.com/'), env)).status).toBe(404);
  });

  it('502s when the map names a vertical nothing is bound to', async () => {
    // Our misconfiguration, not the caller's, so it must not read as 404.
    const env = {
      CONTROL_PLANE: directory({ 'orphan.example.com': row({ vertical_slug: 'ghost' }) }),
    } as unknown as Env;
    expect((await worker.fetch(get('https://orphan.example.com/'), env)).status).toBe(502);
  });

  it('does not leak which tenant a 404 nearly matched', async () => {
    const env = { CONTROL_PLANE: directory({ 'acme.example.com': row() }) } as unknown as Env;
    const body = await (await worker.fetch(get('https://typo.example.com/'), env)).text();
    expect(body).not.toContain(T);
    expect(body).not.toContain('acme');
  });

  // -- transient dispatch failures (K-28's second finding) -------------------

  /** A vertical that fails the first N attempts the way a cold colo does. */
  function flakyVertical(failures: number, message = 'Worker not found.') {
    let attempts = 0;
    return {
      binding: {
        fetch: async () => {
          attempts += 1;
          if (attempts <= failures) throw new Error(message);
          return new Response('ok');
        },
      } as unknown as Fetcher,
      attempts: () => attempts,
    };
  }

  const envWith = (binding: Fetcher) =>
    ({
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: binding,
    }) as unknown as Env;

  it('retries once when the vertical is briefly not found', async () => {
    // The window we measured was ~15s and self-healing. Failing the tenant outright,
    // which is Cloudflare's documented advice for this error, would turn a
    // propagation gap into a hard error for whoever landed in a cold colo.
    const fsm = flakyVertical(1);
    const res = await worker.fetch(get('https://acme.example.com/'), envWith(fsm.binding));
    expect(res.status).toBe(200);
    expect(fsm.attempts()).toBe(2);
  });

  it('gives up after one retry rather than hanging on a script that is really gone', async () => {
    // Same error, permanent cause: a deleted vertical or a bad channel pointer. A
    // misconfiguration must fail fast, not retry forever.
    const fsm = flakyVertical(99);
    const res = await worker.fetch(get('https://acme.example.com/'), envWith(fsm.binding));
    expect(res.status).toBe(502);
    expect(fsm.attempts()).toBe(2);
  });

  it('does NOT retry a request with a body', async () => {
    // If the first attempt reached the vertical, replaying it could run the same
    // mutation twice. A double-charged customer is worse than a 502.
    const fsm = flakyVertical(1);
    const post = new Request('https://acme.example.com/api/orders', {
      method: 'POST',
      body: JSON.stringify({ total: '100.00' }),
    });
    await expect(worker.fetch(post, envWith(fsm.binding))).rejects.toThrow(/Worker not found/);
    expect(fsm.attempts()).toBe(1);
  });

  it('does not retry an unrelated error', async () => {
    // Only the propagation signature is retryable. Retrying real bugs hides them
    // and doubles their blast radius.
    const fsm = flakyVertical(1, 'TypeError: undefined is not a function');
    await expect(worker.fetch(get('https://acme.example.com/'), envWith(fsm.binding))).rejects.toThrow(
      /TypeError/,
    );
    expect(fsm.attempts()).toBe(1);
  });

  it('re-asserts the node on the retry, rather than reusing a consumed request', async () => {
    let seen: Request | undefined;
    let attempts = 0;
    const binding = {
      fetch: async (req: Request) => {
        attempts += 1;
        if (attempts === 1) throw new Error('Worker not found.');
        seen = req;
        return new Response('ok');
      },
    } as unknown as Fetcher;
    await worker.fetch(get('https://acme.example.com/'), envWith(binding));
    expect(seen?.headers.get('x-substrat-tenant')).toBe(T);
    expect(seen?.headers.get('x-substrat-scope')).toBe(S);
  });

  it('builds a fresh Durable Object stub for EVERY request', async () => {
    // The regression. A stub cached across requests throws "Cannot perform I/O on
    // behalf of a different request" — but not until the second request, so the
    // first one succeeds and it looks healthy. Only the namespace may be held.
    const cp = directory({ 'acme.example.com': row() });
    const env = { CONTROL_PLANE: cp, VERTICAL_FSM: spyVertical().binding } as unknown as Env;

    for (let i = 0; i < 3; i++) {
      cp.beginRequest();
      await worker.fetch(get('https://acme.example.com/'), env);
    }

    expect(cp.stubs()).toBe(3);
  });

  it('serves the second request as well as the first', async () => {
    // Stated separately from the stub count because this is the SYMPTOM: production
    // returned 1101 on every request after the first, while the first looked fine.
    const cp = directory({ 'acme.example.com': row() });
    const env = { CONTROL_PLANE: cp, VERTICAL_FSM: spyVertical().binding } as unknown as Env;

    cp.beginRequest();
    expect((await worker.fetch(get('https://acme.example.com/'), env)).status).toBe(200);
    // The one that returned 1101 in production.
    cp.beginRequest();
    expect((await worker.fetch(get('https://acme.example.com/'), env)).status).toBe(200);
  });

  it('meters every resolved request: tenant-keyed datapoint + structured log line', async () => {
    // design/observability.md §4.2/§4.3 — the router stamps the one dimension
    // Cloudflare cannot know (which tenant). Blob/double order is a published shape.
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: spyVertical().binding,
      ANALYTICS: { writeDataPoint: (p: (typeof points)[number]) => points.push(p) },
    } as unknown as Env;

    try {
      const res = await worker.fetch(
        get('https://acme.example.com/api/repairs', { 'cf-ray': '8f2ab-ARN' }),
        env,
      );
      expect(res.status).toBe(200);

      expect(points).toHaveLength(1);
      expect(points[0]!.indexes).toEqual([T]);
      expect(points[0]!.blobs).toEqual(['fsm', S, 'app', '2xx', '8f2ab-ARN']);
      const [durationMs, status] = points[0]!.doubles!;
      expect(status).toBe(200);
      expect(durationMs).toBeGreaterThanOrEqual(0);

      const line = JSON.parse(logs.find((l) => l.includes('"router":"request"'))!);
      expect(line).toMatchObject({
        tenantId: T,
        scopeId: S,
        vertical: 'fsm',
        surface: 'app',
        hostname: 'acme.example.com',
        rayId: '8f2ab-ARN',
        status: 200,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('meters the failure paths too — a 502 with no binding, and an unmetered 404', async () => {
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      // No VERTICAL_FSM binding → dispatch answers 502; that must still be metered.
      ANALYTICS: { writeDataPoint: (p: (typeof points)[number]) => points.push(p) },
    } as unknown as Env;

    try {
      expect((await worker.fetch(get('https://acme.example.com/'), env)).status).toBe(502);
      expect(points).toHaveLength(1);
      expect(points[0]!.blobs?.[3]).toBe('5xx');
      expect(points[0]!.doubles?.[1]).toBe(502);

      // An unresolved hostname has no tenant to write under — no datapoint.
      expect((await worker.fetch(get('https://unknown.example.com/'), env)).status).toBe(404);
      expect(points).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a metering failure never fails the request', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = {
      CONTROL_PLANE: directory({ 'acme.example.com': row() }),
      VERTICAL_FSM: spyVertical().binding,
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error('daily limit exceeded');
        },
      },
    } as unknown as Env;

    try {
      expect((await worker.fetch(get('https://acme.example.com/'), env)).status).toBe(200);
    } finally {
      logSpy.mockRestore();
    }
  });
});
