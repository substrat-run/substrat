import { afterEach, describe, expect, it } from 'vitest';
import { connectionId } from '@substrat-run/contracts';
import { ulid, type FetchLike } from '@substrat-run/kernel';
import {
  bindWooCommerceScope,
  prepareWooCommerceCandidate,
  probeWooCommerceConnection,
  sweepWooCommerce,
  woocommerceCredentialSummary,
} from '../src/index.js';
import { WooCommerceMock } from '../src/mock.js';
import { ORDERS, PRODUCTS } from './fixture.js';
import { OPERATION, RECORD, world, type World } from './world.js';

/**
 * #3219: a WooCommerce connection is one store. The platform keys it on the store the probe names,
 * so a key for another store is a connection of its own; the connector opens each by its store, and
 * pins every key it is handed to the store it reads, so a connection made before keying (which holds
 * no store) cannot be handed another store's key either.
 */
let w: World | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});

const prepare = (mock: WooCommerceMock, previous?: Record<string, string>, candidate: Record<string, string> = mock.secret) =>
  prepareWooCommerceCandidate({ fetch: mock.fetch })(candidate, previous);

describe('woocommerce — a key is pinned to its store', () => {
  it('records the store a key reads, by the address the store gives itself', async () => {
    const mock = new WooCommerceMock({ storeUrl: 'https://shop.example.com', homeUrl: 'https://www.shop.example.com/' });
    const { secret } = await prepare(mock);
    expect(secret).toEqual({ ...mock.secret, store: 'www.shop.example.com' });
  });

  it.each([
    ['a keyed connection of the same store', { storeUrl: 'https://shop.example.com', store: 'www.shop.example.com' }],
    ['an unkeyed one pasted with the address the store gives itself', { storeUrl: 'https://www.shop.example.com' }],
    ['an unkeyed one pasted with the same address', { storeUrl: 'https://SHOP.example.com/' }],
  ])('replaces the key of %s', async (_, held) => {
    const mock = new WooCommerceMock({ storeUrl: 'https://shop.example.com', homeUrl: 'https://www.shop.example.com' });
    const previous = { consumerKey: 'ck_old', consumerSecret: 'cs_old', ...held };
    await expect(prepare(mock, previous)).resolves.toMatchObject({ secret: { store: 'www.shop.example.com' } });
  });

  it.each([
    ['a keyed connection of another store', { storeUrl: 'https://shop.example.com', store: 'other.example.com' }],
    ['an unkeyed connection of another store', { storeUrl: 'https://other.example.com' }],
  ])('refuses, storing nothing, a key for another store than %s', async (_, held) => {
    const mock = new WooCommerceMock();
    const previous = { consumerKey: 'ck_old', consumerSecret: 'cs_old', ...held };
    await expect(prepare(mock, previous)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/reads the store at shop\.example\.com, and this connection is for other\.example\.com/),
    });
  });

  it('refuses a key the store refuses (422), and answers 503 when the store does not answer', async () => {
    const mock = new WooCommerceMock({ consumerSecret: 'cs_right' });
    await expect(prepare(mock, undefined, { ...mock.secret, consumerSecret: 'cs_wrong' })).rejects.toMatchObject({ status: 422 });
    await expect(prepare(mock, undefined, { ...mock.secret, storeUrl: 'https://gone.example.com' })).rejects.toMatchObject({ status: 503 });
  });
});

describe('woocommerce — two stores in one app', () => {
  it('sweeps, probes and shows each connection with its own store key', async () => {
    const a = new WooCommerceMock({ storeUrl: 'https://a.example.com', consumerKey: 'ck_a', products: PRODUCTS(), orders: ORDERS() });
    const b = new WooCommerceMock({ storeUrl: 'https://b.example.com', consumerKey: 'ck_b', products: PRODUCTS(), orders: ORDERS() });
    // Each address is its own store; the platform's fetch reaches both.
    const fetch = (async (input: string, init?: unknown) =>
      (input.startsWith(b.storeUrl) ? b.fetch : a.fetch)(input, init as never)) as unknown as FetchLike;
    w = await world(a, { account: 'a.example.com' });
    const bId = connectionId.parse(ulid());
    await w.host.admin.createConnection(w.staff, {
      id: bId,
      tenantId: w.tenantId,
      vertical: 'shop',
      provider: 'woocommerce',
      label: 'Second store',
      secret: b.secret,
      externalAccountRef: 'b.example.com',
    });
    await w.host.admin.grantToConnection(w.staff, { connectionId: bId, permission: RECORD, node: { tenantId: w.tenantId, scopeId: w.scopeId }, grantedBy: w.staff });
    await w.bind();
    const bindB = (externalAccountRef: string | null) =>
      bindWooCommerceScope(w!.host, {
        connectionId: bId,
        tenantId: w!.tenantId,
        scopeId: w!.scopeId,
        vertical: 'shop',
        operation: OPERATION,
        permission: RECORD,
        externalAccountRef,
      });

    // A binding that names no store cannot tell the two apart, and lands nothing.
    await bindB(null);
    expect((await sweepWooCommerce(w.host, bId, w.options({ fetch }))).failed).toEqual([
      { scopeId: w.scopeId, error: expect.stringMatching(/multiple live 'woocommerce' connections/) },
    ]);
    await bindB('b.example.com');

    expect(await w.sweep({ fetch })).toMatchObject({ failed: [] });
    expect(await sweepWooCommerce(w.host, bId, w.options({ fetch }))).toMatchObject({ failed: [] });
    // Each connection's records came from its own store, and each store was read with its own key only.
    const from = (id: string) => w!.landed.filter((c) => c.connectionId === id).length;
    expect([from(w.connId), from(bId)]).toEqual([6, 6]);
    expect(a.requests.length).toBeGreaterThan(0);
    expect(b.requests.length).toBeGreaterThan(0);

    const row = (id: typeof bId, account: string) => ({ id, tenantId: w!.tenantId, vertical: 'shop', externalAccountRef: account });
    expect(await probeWooCommerceConnection(w.host, row(bId, 'b.example.com'), { fetch })).toMatchObject({ ok: true, accountRef: 'b.example.com' });
    expect((await woocommerceCredentialSummary(w.host, row(w.connId, 'a.example.com'))).fields[0]).toMatchObject({ value: 'https://a.example.com' });
    // The row and the store it names must agree: the credential that reads is the connection asked about.
    await expect(probeWooCommerceConnection(w.host, row(bId, 'a.example.com'), { fetch })).rejects.toThrow(/is .* not|Re-bind/);
  });
});
