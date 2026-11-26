import { describe, expect, it, vi } from 'vitest';
import {
  createReadModelRouteResolver,
  RouteMemoryCache,
  ROUTE_MEMORY_TTL_MS,
  ROUTE_NEGATIVE_TTL_MS,
  routeKvKey,
  type RouteEntry,
} from '@substrat-run/adapter-cloudflare/routing';
import worker, { type Env } from '../src/worker.js';

/**
 * #3395: the router reads routes from the KV read model the control plane publishes, falling back
 * to the directory. What must hold: a stale answer is bounded, a miss asks the directory (and asks
 * it to publish), nothing request-bound outlives its request, and `compare` never serves from KV.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';

const entry = (hostname: string, over: Partial<RouteEntry> = {}): RouteEntry => ({
  v: 1,
  tenant_id: T,
  scope_id: S,
  vertical_slug: 'fsm',
  surface: 'app',
  region: null,
  primary: true,
  scope_hostnames: [hostname],
  dispatch: { kind: 'none' },
  ...over,
});

function kv(entries: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

/**
 * A directory that enforces what workerd enforces: a stub belongs to the request that created it,
 * and using it from a later one throws. `beginRequest()` marks a request boundary.
 */
function directory(rows: Record<string, ReturnType<typeof entry> | undefined>) {
  let request = 0;
  const reads: Array<{ hostname: string; publish: boolean }> = [];
  const ns = {
    idFromName: () => 'id',
    get: () => {
      const bornIn = request;
      return {
        readRoute: async (hostname: string, opts?: { publish?: boolean }) => {
          if (bornIn !== request) throw new Error('Cannot perform I/O on behalf of a different request.');
          reads.push({ hostname, publish: opts?.publish === true });
          const r = rows[hostname];
          return r ? { ...r, deployment_ref: null, outbound_json: null, calls_json: null, scope_stores_json: null } : undefined;
        },
      };
    },
  };
  return Object.assign(ns as unknown as DurableObjectNamespace, { reads, beginRequest: () => (request += 1) });
}

describe('#3395: the router reads routes from the read model', () => {
  it('serves a published route without asking the directory, and a stale one only within its bound', async () => {
    let now = 1_000;
    const host = 'bound.example.com';
    const routes = kv({ [routeKvKey(host)]: entry(host) });
    const dir = directory({}); // suspended: the directory routes nothing
    const resolve = createReadModelRouteResolver({ controlPlane: dir, kv: routes, cache: new RouteMemoryCache(), mode: 'on', now: () => now });

    expect(await resolve(host)).toMatchObject({ tenantId: T, scopeId: S });
    expect(dir.reads).toEqual([]);

    // The suspension is published as a refusal. An isolate that read the route keeps it at most
    // ROUTE_MEMORY_TTL_MS (KV's own edge cache is the other half of the stated bound)…
    routes.store.set(routeKvKey(host), { v: 1, refused: true });
    now += ROUTE_MEMORY_TTL_MS - 1;
    expect(await resolve(host)).toMatchObject({ scopeId: S });
    now += 2;
    // …and then refuses it from KV, without falling back to the directory.
    expect(await resolve(host)).toBeUndefined();
    expect(dir.reads).toEqual([]);
  });

  it('a miss asks the directory to publish; an unknown hostname is remembered briefly, then asked again', async () => {
    let now = 1_000;
    const known = 'known.example.com';
    const dir = directory({ [known]: entry(known) });
    const resolve = createReadModelRouteResolver({ controlPlane: dir, kv: kv(), cache: new RouteMemoryCache(), mode: 'on', now: () => now });

    // Several requests, each its own: nothing the first created is used by a later one.
    for (let i = 0; i < 3; i++) {
      dir.beginRequest();
      expect(await resolve('Known.Example.com')).toMatchObject({ scopeId: S });
      expect(await resolve('nobody.example.com')).toBeUndefined();
      // Past both TTLs, so each round asks the directory afresh.
      now += Math.max(ROUTE_MEMORY_TTL_MS, ROUTE_NEGATIVE_TTL_MS) + 1;
    }
    expect(dir.reads.filter((r) => r.hostname === known)).toEqual(Array(3).fill({ hostname: known, publish: true }));
    expect(dir.reads.filter((r) => r.hostname === 'nobody.example.com')).toHaveLength(3);

    // Within the negative TTL, the directory is not asked again.
    await resolve('nobody.example.com');
    await resolve('nobody.example.com');
    expect(dir.reads.filter((r) => r.hostname === 'nobody.example.com')).toHaveLength(4);
  });

  it('a serving route whose vertical policy is missing is a miss, never a route without its policy', async () => {
    const host = 'policy.example.com';
    const dir = directory({ [host]: entry(host) });
    const routes = kv({ [routeKvKey(host)]: entry(host, { dispatch: { kind: 'serving', ref: 'fsm-serving', vertical: 'fsm' } }) });
    const resolve = createReadModelRouteResolver({ controlPlane: dir, kv: routes, cache: new RouteMemoryCache(), mode: 'on' });
    expect(await resolve(host)).toMatchObject({ scopeId: S, deploymentRef: null });
    expect(dir.reads).toEqual([{ hostname: host, publish: true }]);
  });

  it('the worker picks the mode from ROUTE_READ_MODEL; `compare` serves the directory and logs a disagreement', async () => {
    const vertical = { fetch: vi.fn(async () => new Response('ok')) } as unknown as Fetcher;
    const base = { ROUTER_SECRET: 'shhh', VERTICAL_FSM: vertical };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // `on`: KV answers, the directory is never asked.
      const onHost = 'on.example.com';
      const onDir = directory({});
      const on = await worker.fetch(new Request(`https://${onHost}/`), {
        ...base, CONTROL_PLANE: onDir, ROUTES: kv({ [routeKvKey(onHost)]: entry(onHost) }), ROUTE_READ_MODEL: 'on',
      } as unknown as Env);
      expect(on.status).toBe(200);
      expect(onDir.reads).toEqual([]);

      // `compare`: the directory says `app`, KV says `admin`. The directory is served, KV is reported.
      const cmpHost = 'compare.example.com';
      const pending: Promise<unknown>[] = [];
      const cmp = await worker.fetch(
        new Request(`https://${cmpHost}/`),
        {
          ...base, CONTROL_PLANE: directory({ [cmpHost]: entry(cmpHost) }),
          ROUTES: kv({ [routeKvKey(cmpHost)]: entry(cmpHost, { surface: 'admin' }) }), ROUTE_READ_MODEL: 'compare',
        } as unknown as Env,
        { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
      );
      await Promise.all(pending);
      expect(cmp.status).toBe(200);
      const reports = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"route-read-model"'));
      expect(reports).toHaveLength(1);
      expect(JSON.parse(reports[0]!)).toMatchObject({
        hostname: cmpHost, outcome: 'mismatch', directory: { surface: 'app' }, readModel: { surface: 'admin' },
      });

      // Anything else is off: KV is not read at all.
      const offRoutes = kv({ [routeKvKey(onHost)]: entry(onHost) });
      await worker.fetch(new Request(`https://${onHost}/`), {
        ...base, CONTROL_PLANE: directory({ [onHost]: entry(onHost) }), ROUTES: offRoutes, ROUTE_READ_MODEL: 'yes',
      } as unknown as Env);
      expect(offRoutes.get).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
