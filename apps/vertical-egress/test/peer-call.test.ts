import { afterEach, describe, expect, it, vi } from 'vitest';
import { PEER_CALL_URL } from '@substrat-run/contracts';
import worker, { type Env, type OutboundPolicy } from '../src/worker.js';

/**
 * The egress worker's half of a peer call (#1706).
 *
 * What it decides is narrow and load-bearing: a call to the reserved address is a PEER call,
 * its caller is the dispatch's own parameters, and it never becomes a request to the
 * internet. Everything about what the caller may then do is decided later — by the router
 * (which instance answers) and by the target's door (which operation, holding which keys).
 */

/** The router's peer entrypoint, recording what it was handed. */
function peerCalls(outcome: unknown = { ok: true, result: { ok: 1 } }) {
  const calls: { caller: unknown; request: unknown }[] = [];
  return {
    binding: {
      invoke: async (caller: unknown, request: unknown) => {
        calls.push({ caller, request });
        return outcome as never;
      },
    },
    calls,
  };
}

const policy = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
  slug: 'acme/board-room',
  tenant: '01JZ0000000000000000TENANT',
  hosts: [],
  scope: '01JZ0000000000000000CA11R2',
  calls: ['acme/crm'],
  depth: 0,
  ...over,
});

const envWith = (over: Partial<Env> = {}): Env => ({
  ROUTER: { fetch: async () => new Response('routed') } as unknown as Fetcher,
  PLATFORM_BASE_DOMAINS: 'substrat.run',
  PLATFORM_CP_URL: 'https://console.substrat.net',
  ...over,
});

const call = (env: Env, body: unknown = { vertical: 'acme/crm', operation: 'customer/list' }) =>
  worker.fetch(new Request(PEER_CALL_URL, { method: 'POST', body: JSON.stringify(body) }), env);

afterEach(() => vi.unstubAllGlobals());

describe('a peer call through egress (#1706)', () => {
  it('hands the call to the router with the DISPATCH’s caller, and never to the internet', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);
    const peer = peerCalls();

    const res = await call(envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: policy() }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: 1 } });
    expect(peer.calls).toHaveLength(1);
    // The caller is the dispatch parameters, whole — the request contributed none of it.
    expect(peer.calls[0]!.caller).toEqual({
      vertical: 'acme/board-room',
      tenantId: '01JZ0000000000000000TENANT',
      scopeId: '01JZ0000000000000000CA11R2',
      calls: ['acme/crm'],
      depth: 0,
    });
    expect(peer.calls[0]!.request).toEqual({ vertical: 'acme/crm', operation: 'customer/list' });
    expect(internet).not.toHaveBeenCalled();
  });

  it('a body that tries to name its own caller is refused — the schema is strict', async () => {
    const peer = peerCalls();
    const res = await call(
      envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: policy() }),
      { vertical: 'acme/crm', operation: 'customer/list', caller: 'acme/somebody-else' },
    );
    expect(res.status).toBe(400);
    expect(peer.calls).toHaveLength(0);
  });

  it('a dispatch with no identity is refused, not forwarded: the message says where a peer call is made from', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);
    const peer = peerCalls();

    for (const missing of [undefined, policy({ slug: null }), policy({ scope: undefined })]) {
      const res = await call(envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: missing }));
      expect(res.status).toBe(403);
      expect((await res.json<{ error: string }>()).error).toMatch(/carries no caller identity/);
    }
    expect(peer.calls).toHaveLength(0);
    expect(internet).not.toHaveBeenCalled();
  });

  it('an environment with no peer binding refuses — an unroutable address is never a fetch', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);
    const res = await call(envWith({ OUTBOUND_POLICY: policy() }));
    expect(res.status).toBe(503);
    expect(internet).not.toHaveBeenCalled();
    // The refusal NAMES the missing binding and the worker it belongs on: this is a
    // deployment step, and the developer reading it is looking at a vertical's code.
    const { error } = await res.json<{ error: string }>();
    expect(error).toContain('PEER_CALLS');
    expect(error).toContain('substrat-vertical-egress');
  });

  it('the router’s refusal is passed through with its status and reason', async () => {
    const peer = peerCalls({ ok: false, status: 404, code: 'not_found', message: "vertical 'acme/crm' is not installed in this tenant" });
    const res = await call(envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: policy() }));
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toMatch(/not installed in this tenant/);
  });

  it('carries the chain depth, so the router can bound A→B→A', async () => {
    const peer = peerCalls();
    await call(envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: policy({ depth: 3 }) }));
    expect((peer.calls[0]!.caller as { depth: number }).depth).toBe(3);
  });

  it('a version that predates `substrat.calls` carries null, which the router reads as unenforced', async () => {
    const peer = peerCalls();
    await call(envWith({ PEER_CALLS: peer.binding, OUTBOUND_POLICY: policy({ calls: undefined }) }));
    expect((peer.calls[0]!.caller as { calls: string[] | null }).calls).toBeNull();
  });

  it('THE property behind the unresolvable address: without the peer branch, the policy refuses it — it is never fetched', async () => {
    // `peer.substrat.internal` is in no DNS zone and in no vertical's declared outbound
    // surface. This asserts the fallback if the peer branch above were ever removed: the
    // outbound policy answers 403 rather than letting the address reach the internet. The
    // runtime half — a fetch from inside a Durable Object, which this worker never sees —
    // then fails to resolve, which is the whole reason the address is unroutable.
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);
    const res = await worker.fetch(
      new Request('https://peer.substrat.internal/invoke', { method: 'POST', body: '{}' }),
      // An env with NO peer binding is the closest a test can come to "the branch is not there":
      // the call must still not become a fetch.
      envWith({ OUTBOUND_POLICY: policy({ hosts: ['api.example.com'] }) }),
    );
    expect([403, 503]).toContain(res.status);
    expect(internet).not.toHaveBeenCalled();
  });

  it('a third-party host still meets the outbound policy — the peer branch changed nothing else', async () => {
    const internet = vi.fn(async () => new Response('third party'));
    vi.stubGlobal('fetch', internet);

    const allowed = await worker.fetch(
      new Request('https://api.example.com/v1'),
      envWith({ OUTBOUND_POLICY: policy({ hosts: ['api.example.com'] }) }),
    );
    expect(allowed.status).toBe(200);
    expect(internet).toHaveBeenCalledOnce();

    const refused = await worker.fetch(
      new Request('https://not-declared.example.com/v1'),
      envWith({ OUTBOUND_POLICY: policy({ hosts: ['api.example.com'] }) }),
    );
    expect(refused.status).toBe(403);
    expect(internet).toHaveBeenCalledOnce();
  });
});
