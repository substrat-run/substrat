import { describe, expect, it, vi } from 'vitest';
import {
  createPeerCallResolver,
  peerCallKvKey,
  RouteMemoryCache,
  ROUTE_MEMORY_TTL_MS,
  servingPolicyKvKey,
  type PeerCallEntry,
  type PeerReadModelComparison,
} from '@substrat-run/adapter-cloudflare/routing';
import { PEER_CALL_DEPTH_MAX, peerCaller } from '@substrat-run/contracts';
import { handlePeerCall, type Env } from '../src/worker.js';

/**
 * #3395 follow-up: peer-call answers from the routing read model, behind `PEER_READ_MODEL`. What
 * must hold: off reads no KV whatever else is bound, a published answer is stale only within its
 * bound, `compare` serves the directory and asks it to publish, and the gates that read only the
 * dispatch parameters never read the read model.
 */

const T = '01JZ0000000000000000TENANT';
const CALLER = '01JZ0000000000000000CA11R2';
const TARGET = '01JZ0000000000000000TARGET';
const caller = peerCaller.parse({ vertical: 'acme/board-room', tenantId: T, scopeId: CALLER, calls: ['acme/crm'], depth: 0 });
const key = { tenantId: T, callerScopeId: CALLER, callerVertical: 'acme/board-room', vertical: 'acme/crm' };

const entry: PeerCallEntry = {
  v: 1,
  peer: true,
  caller_tenant_slug: 'acme',
  target: { scope_id: TARGET, tenant_id: T, vertical: 'acme/crm', dispatch: { kind: 'serving', ref: 'crm-serving' } },
};
const policy = { v: 1, serving_ref: 'crm-serving', outbound_json: '["api.example"]', calls_json: '[]', scope_stores_json: null };

function kv(entries: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(entries));
  return { store, get: vi.fn(async (k: string) => store.get(k) ?? null) };
}

/** A directory answering `state` for the caller, recording every call's arguments. */
function directory(state: 'ok' | 'inactive' = 'ok') {
  const asked: unknown[][] = [];
  const ns = {
    idFromName: () => 'id',
    get: () => ({
      peerCallTarget: async (...args: unknown[]) => {
        asked.push(args);
        return {
          caller: { state, status: state === 'ok' ? 'active' : 'suspended', tenantSlug: 'acme' },
          outcome: 'resolved',
          count: 0,
          target: { scope_id: TARGET, tenant_id: T, vertical: 'acme/crm', deployment_ref: 'crm-serving', outbound_json: '["api.example"]', calls_json: '[]' },
        };
      },
    }),
  };
  return Object.assign(ns as unknown as DurableObjectNamespace, { asked });
}

describe('#3395 follow-up: the router reads peer-call answers from the read model', () => {
  it('serves a published answer without the directory, and a revoked one only within its bound', async () => {
    let now = 1_000;
    const routes = kv({ [peerCallKvKey(key)]: entry, [servingPolicyKvKey('acme/crm')]: policy });
    const dir = directory('inactive'); // the caller was suspended after the answer was published
    const resolve = createPeerCallResolver(dir, { kv: routes, cache: new RouteMemoryCache(), mode: 'on', now: () => now });

    expect(await resolve(caller, 'acme/crm')).toMatchObject({
      outcome: 'dispatch', scopeId: TARGET, deploymentRef: 'crm-serving', outboundHosts: ['api.example'], callerTenantSlug: 'acme', depth: 1,
    });
    expect(dir.asked).toEqual([]);

    // The publisher deleted the entry. This isolate keeps its copy at most ROUTE_MEMORY_TTL_MS…
    routes.store.delete(peerCallKvKey(key));
    now += ROUTE_MEMORY_TTL_MS - 1;
    expect(await resolve(caller, 'acme/crm')).toMatchObject({ outcome: 'dispatch' });
    // …then misses, and the directory refuses, asked to publish.
    now += 1;
    expect(await resolve(caller, 'acme/crm')).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(dir.asked).toEqual([[T, CALLER, 'acme/board-room', 'acme/crm', { publish: true }]]);
  });

  it('the depth and the declaration are refused before any read, the read model included', async () => {
    const routes = kv();
    const dir = directory();
    const resolve = createPeerCallResolver(dir, { kv: routes, cache: new RouteMemoryCache(), mode: 'on' });
    expect(await resolve({ ...caller, depth: PEER_CALL_DEPTH_MAX }, 'acme/crm')).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(await resolve(caller, 'acme/ledger')).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect([routes.get.mock.calls.length, dir.asked.length]).toEqual([0, 0]);
  });

  it('`compare` serves the directory, asks it to publish, and reports a read model that decides otherwise', async () => {
    const routes = kv({ [peerCallKvKey(key)]: entry, [servingPolicyKvKey('acme/crm')]: policy });
    const dir = directory('inactive');
    const reports: PeerReadModelComparison[] = [];
    const resolve = createPeerCallResolver(dir, {
      kv: routes, cache: new RouteMemoryCache(), mode: 'compare', report: (c) => reports.push(c),
    });
    expect(await resolve(caller, 'acme/crm')).toMatchObject({ outcome: 'refused' });
    expect(dir.asked).toEqual([[T, CALLER, 'acme/board-room', 'acme/crm', { publish: true }]]);
    expect(reports).toEqual([
      expect.objectContaining({ key, outcome: 'mismatch', directory: expect.objectContaining({ outcome: 'refused' }), readModel: expect.objectContaining({ outcome: 'dispatch' }) }),
    ]);
  });

  it('the worker reads no KV unless PEER_READ_MODEL asks, whatever ROUTE_READ_MODEL says', async () => {
    const routes = kv({ [peerCallKvKey(key)]: entry, [servingPolicyKvKey('acme/crm')]: policy });
    const dispatch = { get: () => ({ fetch: async () => Response.json({ result: { ok: 1 } }) }) };
    const run = (over: Partial<Env>) => {
      const dir = directory();
      const env = { PLATFORM_SECRET: 's', CONTROL_PLANE: dir, ROUTES: routes, ROUTE_READ_MODEL: 'on', DISPATCH: dispatch, ...over } as unknown as Env;
      return handlePeerCall(env, caller, { vertical: 'acme/crm', operation: 'customer/list' }).then((outcome) => ({ outcome, dir }));
    };

    const off = await run({});
    expect(off.outcome).toEqual({ ok: true, result: { ok: 1 } });
    // Exactly the call a router before this change made: four arguments, no publish.
    expect(off.dir.asked).toEqual([[T, CALLER, 'acme/board-room', 'acme/crm']]);
    expect(routes.get).not.toHaveBeenCalled();

    const on = await run({ PEER_READ_MODEL: 'on' });
    expect(on.outcome).toEqual({ ok: true, result: { ok: 1 } });
    expect(on.dir.asked).toEqual([]);
  });
});
