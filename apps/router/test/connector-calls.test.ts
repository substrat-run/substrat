import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_CALL_PATH, CONNECTOR_PROBE_PATH, PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import { handleConnectorCall, type Env } from '../src/worker.js';

/**
 * The router's connector-call entrypoint (vertical-connectors.md §6.3). What it owes: a
 * connector runs under the outbound policy of the version it was dispatched to, and nothing
 * incoherent is dispatched at all.
 */

const TENANT = '01JZ0000000000000000TENANT';
const OTHER_TENANT = '01JZ00000000000000000THER0';
const SCOPE = '01JZ0000000000000000SC0PE0';
const OTHER_SCOPE = '01JZ0000000000000000SC0PE1';
const SECRET = 'platform-shhh';

const CONNECTION = {
  id: '01JZ00000000000000C0NNECT0',
  tenantId: TENANT,
  vertical: 'acme-crm',
  provider: 'acme.docbox',
  externalAccountRef: null,
  expiresAt: null,
  secret: { user: 'u', password: 'p' },
};
const BINDING = { scopeId: SCOPE, operation: 'docs/land', permission: 'documents:land', options: {}, declared: {}, boundAt: '2026-10-01T00:00:00.000Z' };

const target = (over: Record<string, unknown> = {}) => ({
  deploymentRef: 'acme-crm--v3',
  slug: 'acme-crm',
  tenantId: TENANT,
  scopeId: SCOPE,
  hosts: ['api.docbox.example'],
  ...over,
});
const sweep = (over: Record<string, unknown> = {}) => ({
  role: 'sweep',
  provider: 'acme.docbox',
  connection: CONNECTION,
  binding: BINDING,
  state: [],
  ...over,
});

/** A dispatch namespace recording the script, the outbound parameters and the request. */
function dispatch(response: () => Response = () => Response.json({ ok: true, result: { landed: 2, more: false }, state: [], uses: [] })) {
  const seen: { name: string; outbound: Record<string, unknown> | undefined; request?: Request }[] = [];
  const ns = {
    get: (name: string, _args: unknown, options?: { outbound?: Record<string, unknown> }) => {
      const entry: (typeof seen)[number] = { name, outbound: options?.outbound };
      seen.push(entry);
      return {
        fetch: async (request: Request) => {
          entry.request = request;
          return response();
        },
      } as unknown as Fetcher;
    },
  };
  return Object.assign(ns, { seen: () => seen });
}

const call = (env: Partial<Env>, t: unknown, r: unknown) =>
  handleConnectorCall({ PLATFORM_SECRET: SECRET, ...env } as unknown as Env, t, r);

afterEach(() => vi.restoreAllMocks());

describe('ConnectorCalls', () => {
  it.each([
    ['PLATFORM_SECRET', { PLATFORM_SECRET: undefined }],
    ['DISPATCH', { DISPATCH: undefined }],
  ])('refuses every call, loudly, when %s is missing', async (_, missing) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ns = dispatch();
    const out = await call({ DISPATCH: ns, ...missing } as Partial<Env>, target(), sweep());
    expect(out.status).toBe(503);
    expect(ns.seen()).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });

  it.each([
    ['a target with no deployment', target({ deploymentRef: '' }), sweep()],
    ['a target with a host outside the grammar', target({ hosts: ['*'] }), sweep()],
    ['a request with no role', target(), { provider: 'acme.docbox' }],
  ])('answers 400 without dispatching for %s', async (_, t, r) => {
    const ns = dispatch();
    const out = await call({ DISPATCH: ns }, t, r);
    expect(out).toEqual({ status: 400, body: { error: expect.stringMatching(/connector call refused: the (target|request) is malformed/) } });
    expect(ns.seen()).toHaveLength(0);
  });

  it.each([
    ['a connection of another tenant', target({ tenantId: OTHER_TENANT }), sweep(), /another tenant/],
    ['a connection of another vertical', target({ slug: 'acme-other' }), sweep(), /another vertical/],
    ['a sweep of another scope', target({ scopeId: OTHER_SCOPE }), sweep(), /sweep call names another scope/],
    ['a bind with no target scope', target({ scopeId: null }), { role: 'bind', provider: 'acme.docbox', connection: CONNECTION, scopeId: SCOPE, options: {} }, /bind call is scoped, and its target names no scope/],
    ['a probe whose target names a scope', target(), { role: 'probe', provider: 'acme.docbox', connection: CONNECTION, state: [] }, /probe call is connection-level/],
    ['a probe-candidate whose target names a scope', target(), { role: 'probe-candidate', provider: 'acme.docbox', secret: { user: 'u' } }, /probe-candidate call is connection-level/],
  ])('refuses %s without dispatching', async (_, t, r, message) => {
    const ns = dispatch();
    const out = await call({ DISPATCH: ns }, t, r);
    expect(out).toEqual({ status: 400, body: { error: expect.stringMatching(message) } });
    expect(ns.seen()).toHaveLength(0);
  });

  it("dispatches under the target version's outbound policy, with the platform secret and the request as the body", async () => {
    const ns = dispatch();
    const out = await call({ DISPATCH: ns }, target(), sweep());
    expect(out).toEqual({ status: 200, body: { ok: true, result: { landed: 2, more: false }, state: [], uses: [] } });
    const [seen] = ns.seen();
    expect(seen!.name).toBe('acme-crm--v3');
    expect(seen!.outbound).toEqual({
      OUTBOUND_POLICY: { slug: 'acme-crm', tenant: TENANT, hosts: ['api.docbox.example'], scope: SCOPE, calls: [], stores: null, depth: 0, primary: true },
    });
    const sent = seen!.request!;
    expect(sent.method).toBe('POST');
    expect(new URL(sent.url).pathname).toBe(CONNECTOR_CALL_PATH);
    expect(sent.headers.get(PLATFORM_SECRET_HEADER)).toBe(SECRET);
    expect(sent.headers.get('x-substrat-vertical')).toBe('acme-crm');
    expect(await sent.json()).toEqual(sweep());
  });

  it('dispatches a connection-level probe with an empty scope, so egress gives it no scope identity', async () => {
    const ns = dispatch(() => new Response('upstream exploded', { status: 500 }));
    const out = await call({ DISPATCH: ns }, target({ scopeId: null }), { role: 'probe', provider: 'acme.docbox', connection: CONNECTION, state: [] });
    // Status passes through; a body that is not JSON comes back as null.
    expect(out).toEqual({ status: 500, body: null });
    expect((ns.seen()[0]!.outbound!.OUTBOUND_POLICY as { scope: string }).scope).toBe('');
    expect(new URL(ns.seen()[0]!.request!.url).pathname).toBe(CONNECTOR_PROBE_PATH);
  });
});
