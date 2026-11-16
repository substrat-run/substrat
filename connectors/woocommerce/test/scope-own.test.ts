import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, scopeId, type ConnectionId, type ScopeId } from '@substrat-run/contracts';
import { ulid, type FetchLike } from '@substrat-run/kernel';
import {
  bindWooCommerceScope,
  probeWooCommerceConnection,
  sweepWooCommerce,
  woocommerceCredentialSummary,
  type WooCommerceBinding,
} from '../src/index.js';
import { WooCommerceMock } from '../src/mock.js';
import { order, product } from './fixture.js';
import { OPERATION, RECORD, world, type World } from './world.js';

/**
 * #3201: each store of a tenant is its own scope with its own shop, connected as that scope's OWN
 * connection. Orders carry customers' names, emails and addresses, so a scope must be delivered its
 * own shop's records and never a sibling's — not even to throw away.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

/** Two shops, each selling one product and taking one order whose customer is that shop's alone. */
const shops = () => {
  const shop = (host: string, id: number, email: string) => {
    const placed = order(id * 10, '2026-11-02T10:00:00');
    (placed.billing as Record<string, unknown>).email = email;
    return new WooCommerceMock({ storeUrl: `https://${host}`, consumerKey: `ck_${id}`, products: [product(id, '2026-11-01T10:00:00')], orders: [placed] });
  };
  const a = shop('a.example.com', 1, 'a-customer@example.com');
  const b = shop('b.example.com', 2, 'b-customer@example.com');
  const fetch = (async (input: string, init?: unknown) => (input.startsWith(b.storeUrl) ? b.fetch : a.fetch)(input, init as never)) as unknown as FetchLike;
  return { a, b, fetch };
};

/** Scope `s`'s own connection to `mock`, keyed on its store, granted and bound on `s`. */
async function own(w: World, s: ScopeId, mock: WooCommerceMock, store: string): Promise<ConnectionId> {
  const id = connectionId.parse(ulid());
  await w.host.admin.createConnection(w.staff, {
    id, tenantId: w.tenantId, vertical: 'shop', provider: 'woocommerce', label: store, secret: mock.secret, externalAccountRef: store, ownerScopeId: s,
  });
  await w.host.admin.grantToConnection(w.staff, { connectionId: id, permission: RECORD, node: { tenantId: w.tenantId, scopeId: s }, grantedBy: w.staff });
  await bindWooCommerceScope(w.host, {
    connectionId: id, tenantId: w.tenantId, scopeId: s, vertical: 'shop', operation: OPERATION, permission: RECORD, externalAccountRef: store, ownerScopeId: s,
  });
  return id;
}

describe("woocommerce — a scope's own shop (#3201)", () => {
  it("lands each shop in the scope that owns its connection, and none of it in the other", async () => {
    const { a, b, fetch } = shops();
    // The world's own tenant connection is to shop A, bound nowhere: the tenant's is never read for a scope's own.
    w = await world(a, { grant: false });
    const sA = w.scopeId;
    const sB = scopeId.parse(ulid());
    await w.host.provisionScope(w.staff, { tenantId: w.tenantId, scopeId: sB, jurisdiction: 'eu', vertical: 'shop' });
    await w.host.admin.activateScope(w.staff, w.tenantId, sB);
    const connA = await own(w, sA, a, 'a.example.com');
    const connB = await own(w, sB, b, 'b.example.com');

    for (const id of [connA, connB]) expect(await sweepWooCommerce(w.host, id, w.options({ fetch }))).toMatchObject({ found: 1, failed: [] });

    const into = (s: ScopeId) => w!.landedIn.filter((l) => l.scopeId === s).map((l) => l.change);
    expect(into(sA).map((c) => c.connectionId)).toEqual([connA, connA]);
    expect(into(sB).map((c) => c.connectionId)).toEqual([connB, connB]);
    // The customer data is where it belongs, and nowhere else.
    expect(JSON.stringify(into(sA))).toContain('a-customer@example.com');
    expect(JSON.stringify(into(sA))).not.toContain('b-customer@example.com');
    expect(JSON.stringify(into(sB))).not.toContain('a-customer@example.com');

    // Each inspection opens the scope's own credential: its store, its key.
    const row = (id: ConnectionId, store: string, owner: ScopeId) => ({ id, tenantId: w!.tenantId, vertical: 'shop', externalAccountRef: store, ownerScopeId: owner });
    expect(await probeWooCommerceConnection(w.host, row(connB, 'b.example.com', sB), { fetch })).toMatchObject({ ok: true, accountRef: 'b.example.com' });
    expect((await woocommerceCredentialSummary(w.host, row(connA, 'a.example.com', sA))).fields[0]).toMatchObject({ value: 'https://a.example.com' });
  });

  it("refuses to bind or sweep a scope's own connection into another scope, reading nothing", async () => {
    const { a, b, fetch } = shops();
    w = await world(a, { grant: false });
    const sB = scopeId.parse(ulid());
    await w.host.provisionScope(w.staff, { tenantId: w.tenantId, scopeId: sB, jurisdiction: 'eu', vertical: 'shop' });
    await w.host.admin.activateScope(w.staff, w.tenantId, sB);
    const connB = await own(w, sB, b, 'b.example.com');
    const into = { connectionId: connB, tenantId: w.tenantId, scopeId: w.scopeId, vertical: 'shop', operation: OPERATION, permission: RECORD, ownerScopeId: sB };

    await expect(bindWooCommerceScope(w.host, { ...into, grantPreflighted: true })).rejects.toThrow(/own, and lands in that scope alone/);
    // A binding that got there some other way is refused at the sweep, before the store is asked.
    const stray: WooCommerceBinding = { ...into, externalAccountRef: 'b.example.com', boundAt: '2026-11-16T00:00:00.000Z' };
    await w.host.admin.putConnectorState(connB, `woocommerce:binding:${w.scopeId}`, stray);
    const asked = b.requests.length;
    const swept = await sweepWooCommerce(w.host, connB, w.options({ fetch }));
    expect(swept.failed).toEqual([{ scopeId: w.scopeId, error: expect.stringMatching(/is scope .*'s own, and is bound to/) }]);
    expect(w.landedIn.filter((l) => l.scopeId === w!.scopeId)).toEqual([]);
    expect(b.requests.length).toBeGreaterThan(asked); // sB's own binding was swept
    expect(w.landedIn.every((l) => l.scopeId === sB)).toBe(true);
  });
});
