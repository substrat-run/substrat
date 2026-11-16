import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  assertAllowed,
  runPlatformSweep,
  ulid,
  undeclaredOperations,
  webCryptoSecretBox,
  type ConnectionBinder,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CommerceChange,
  type ConnectionId,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  WooCommerceMock,
  bindWooCommerceScope,
  listWooCommerceBindings,
  prepareWooCommerceCandidate,
  probeWooCommerceSecret,
  sweepWooCommerce,
  unbindWooCommerceScope,
} from '@substrat-run/connector-woocommerce';
import {
  ConnectionRelayError,
  connectionBindingOptions,
  relayConnectionBind,
  relayConnectionBindings,
  relayConnectionUpsert,
  type ConnectionBindingRelayOptions,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * #3201, end to end: a tenant runs several stores, each its own scope of one vertical, and each has
 * its own WooCommerce shop. Each store connects its shop as its OWN connection through the upsert
 * relay (`owner: 'scope'`), binds it through the `on-request` landing its version declares, and the
 * platform sweep runs. Orders carry customers' names, emails and addresses, so the property held
 * here is that a store is never delivered another store's records — not even to discard them.
 *
 * The connector is wired as the control plane's registration wires it (`scopeOwned`, the binder
 * handing the row's account and owner to `bindWooCommerceScope`).
 */
describe("a store's own WooCommerce shop lands in that store alone (#3201)", () => {
  const SLUG = 'acme-stores';
  const RECORD = permissionKey.parse('commerce:record');
  const OPERATION = 'stores/record-commerce';
  const actor = platformActorId.parse(ulid());
  const person = principalId.parse(ulid());

  let dir: string;
  let host: SqliteScopeHost;
  let t: ReturnType<typeof tenantId.parse>;
  let a: ScopeId;
  let b: ScopeId;
  /** What each store's landing operation was handed, by the scope it ran in. */
  let landed: { scopeId: string; change: CommerceChange }[];

  /** Each store's shop: one product, and one order whose customer is that shop's alone. */
  const shop = (host: string, id: number, email: string) => {
    const mock = new WooCommerceMock({ storeUrl: `https://${host}`, consumerKey: `ck_store_${id}`, consumerSecret: `cs_store_${id}` });
    mock.products.push({ id, name: `Product ${id}`, slug: `p-${id}`, permalink: '', type: 'simple', status: 'publish', sku: '', price: '10.00', regular_price: '10.00', sale_price: '', date_modified_gmt: '2026-11-01T10:00:00', date_modified: '2026-11-01T10:00:00' });
    mock.orders.push(orderOf(id * 10, email, '2026-11-02T10:00:00'));
    return mock;
  };
  const orderOf = (id: number, email: string, at: string) => ({
    id, number: String(id), status: 'processing', currency: 'SEK', prices_include_tax: true, discount_total: '0.00', shipping_total: '0.00',
    total: '10.00', total_tax: '2.00', customer_id: 7, customer_note: '',
    billing: { first_name: 'Ada', last_name: email, company: '', address_1: 'Storgatan 1', address_2: '', city: 'Umeå', state: '', postcode: '903 26', country: 'SE', email, phone: '' },
    shipping: { first_name: 'Ada', last_name: email, company: '', address_1: 'Storgatan 1', address_2: '', city: 'Umeå', state: '', postcode: '903 26', country: 'SE' },
    date_created_gmt: at, date_modified: at, date_modified_gmt: at, date_paid_gmt: at, date_completed_gmt: null, line_items: [],
  });
  let shopA: WooCommerceMock;
  let shopB: WooCommerceMock;
  let fetch: FetchLike;

  const binder: ConnectionBinder = {
    list: (h, row) => listWooCommerceBindings(h, row.id),
    bind: (h, row, target) =>
      bindWooCommerceScope(h, {
        ...(target as Parameters<typeof bindWooCommerceScope>[1]),
        connectionId: row.id,
        externalAccountRef: row.externalAccountRef,
        ownerScopeId: row.ownerScopeId,
      }),
    bindBeforeGrant: (h, row, target) =>
      bindWooCommerceScope(h, {
        ...(target as Parameters<typeof bindWooCommerceScope>[1]),
        connectionId: row.id,
        externalAccountRef: row.externalAccountRef,
        ownerScopeId: row.ownerScopeId,
        grantPreflighted: true,
      }),
    options: (raw, current) => {
      const schema = connectionBindingOptions('woocommerce');
      return schema.parse({ ...(current ? schema.strip().parse(current) : {}), ...(raw ?? {}) });
    },
    unbind: (h, row, s) => unbindWooCommerceScope(h, row.id, s),
  };
  const landings = (): ConnectionBindingRelayOptions['landings'] => ({
    read: (slug, versionId) => host.versionConnectionLandings(slug, versionId),
    binders: { woocommerce: binder },
  });

  /** A store connects its own shop, as the vertical's worker does on the request it serves. */
  const connect = async (s: ScopeId, mock: WooCommerceMock): Promise<ConnectionId> => {
    const prepare = prepareWooCommerceCandidate({ fetch });
    const result = await relayConnectionUpsert(
      host,
      actor,
      { tenantId: t, scopeId: s, provider: 'woocommerce', owner: 'scope', label: 'Our shop', secret: mock.secret, createdBy: person },
      {
        probeCandidate: async (_, secret) => probeWooCommerceSecret(secret, { fetch }),
        prepareCandidate: () => prepare,
        accountFromProbe: (p) => p === 'woocommerce',
        scopeOwned: { proven: true, scopeOwnable: (p) => p === 'woocommerce', readLandings: (slug, v) => host.versionConnectionLandings(slug, v) },
      },
    );
    await relayConnectionBind(host, actor, { tenantId: t, scopeId: s, connectionId: result.connectionId, options: {}, boundBy: person }, { proven: true, landings: landings() });
    return result.connectionId;
  };

  /** The platform's pass: every connection swept, every landing reconciled. */
  const pass = () =>
    runPlatformSweep(host, {
      actor,
      fetch,
      sweepers: { woocommerce: (h, id, o) => sweepWooCommerce(h, id, { fetch: o.fetch }) },
      drainRetries: false,
      recordFailure: () => {},
      connectionLandings: landings(),
    });

  const into = (s: ScopeId) => landed.filter((l) => l.scopeId === s).map((l) => l.change);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'woocommerce-scope-own-'));
    landed = [];
    shopA = shop('a.example.com', 1, 'a-customer@example.com');
    shopB = shop('b.example.com', 2, 'b-customer@example.com');
    fetch = (async (input: string, init?: unknown) =>
      (input.startsWith(shopB.storeUrl) ? shopB.fetch : shopA.fetch)(input, init as never)) as unknown as FetchLike;
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch });
    const module: ModuleRegistration = {
      manifest: moduleManifest.parse({
        id: '@acme/stores',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [{ key: RECORD, description: 'land a store record' }],
        events: { emits: [], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entitlementKey: SLUG,
      }),
      ...undeclaredOperations('a test fixture standing in for the vertical\'s landing operation', {
        [OPERATION]: (async (ctx, input: CommerceChange) => {
          assertAllowed(await ctx.check(RECORD));
          landed.push({ scopeId: ctx.scopeId, change: input });
          return { ok: true };
        }) as OperationHandler<never, unknown>,
      }),
    };
    host.registerModule(module);
    t = tenantId.parse(ulid());
    a = scopeId.parse(ulid());
    b = scopeId.parse(ulid());
    await host.admin.createTenant(actor, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(actor, t, SLUG);
    await host.admin.registerVertical(actor, { slug: SLUG, name: 'Acme Stores', source: 'builtin' });
    for (const s of [a, b]) {
      await host.provisionScope(actor, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: SLUG });
      await host.admin.activateScope(actor, t, s);
    }
    // The vertical lands WooCommerce on request: each store binds its own shop.
    const id = ulid();
    await host.admin.publishVersion(actor, await heldVersion({
      id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      manifestJson: JSON.stringify({
        registry: {
          permissions: [{ key: RECORD, description: 'land a store record', declaredBy: ['@acme/stores'] }],
          roles: [],
          entityGrants: [],
          connections: [{ provider: 'woocommerce', operation: OPERATION, permission: RECORD, bind: 'on-request', declaredBy: ['@acme/stores'] }],
        },
      }),
    }));
    await host.admin.admitVersion(actor, id);
    for (const s of [a, b]) await host.admin.bindScopeVersion(actor, t, s, id);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers each store only its own shop's products and orders, and revoking one stops only that store's sync", async () => {
    const connA = await connect(a, shopA);
    const connB = await connect(b, shopB);
    // Keyed on its store and owned by its scope.
    const rows = await host.admin.listConnections(actor, { tenantId: t, vertical: SLUG });
    expect(rows.map((r) => [r.id, r.externalAccountRef, r.ownerScopeId]).sort()).toEqual(
      [[connA, 'a.example.com', a], [connB, 'b.example.com', b]].sort(),
    );
    // What a bind answers as the binding's options is what a rebind takes back: the store and the
    // owner the binding records are its metadata, not options (a WooCommerce binding has none).
    const bindA = (options: Record<string, unknown>) =>
      relayConnectionBind(host, actor, { tenantId: t, scopeId: a, connectionId: connA, options, boundBy: person }, { proven: true, landings: landings() });
    const rebound = await bindA({});
    expect(rebound.options).toEqual({});
    const listed = await relayConnectionBindings(host, actor, { tenantId: t, scopeId: a }, { proven: true, bindings: (h, row) => listWooCommerceBindings(h, row.id) });
    expect(listed.bindings).toEqual([expect.objectContaining({ connectionId: connA, options: {} })]);
    await expect(bindA(rebound.options)).resolves.toMatchObject({ connectionId: connA, scopeId: a });
    // Another store's own connection is not one a scope can bind.
    await expect(
      relayConnectionBind(host, actor, { tenantId: t, scopeId: b, connectionId: connA, options: {}, boundBy: person }, { proven: true, landings: landings() }),
    ).rejects.toMatchObject({ status: 404 });

    await pass();

    expect(into(a).map((c) => c.connectionId)).toEqual([connA, connA]);
    expect(into(b).map((c) => c.connectionId)).toEqual([connB, connB]);
    expect(JSON.stringify(into(a))).toContain('a-customer@example.com');
    expect(JSON.stringify(into(a))).not.toContain('b-customer@example.com');
    expect(JSON.stringify(into(b))).not.toContain('a-customer@example.com');
    // Each shop was read with its own key only, and only to land in its own store.
    expect(await host.connectionGrantsInScope(t, a)).toEqual([expect.objectContaining({ connectionId: connA })]);
    expect(await host.connectionGrantsInScope(t, b)).toEqual([expect.objectContaining({ connectionId: connB })]);

    // Store A disconnects its shop. Both shops take a new order; only store B's sync goes on.
    await host.admin.revokeConnection(actor, connA);
    shopA.orders.push(orderOf(11, 'a-later@example.com', '2026-11-03T10:00:00'));
    shopB.orders.push(orderOf(21, 'b-later@example.com', '2026-11-03T10:00:00'));
    const before = landed.length;
    await pass();
    const after = landed.slice(before);
    expect(after.map((l) => [l.scopeId, l.change.record === 'order' ? l.change.orderId : null])).toEqual([[b, '21']]);
  });

  it("a store cannot connect a shop as its own unless its version lands WooCommerce on request", async () => {
    // A third scope whose version declares no on-request landing: the relay refuses before the probe.
    const c = scopeId.parse(ulid());
    await host.provisionScope(actor, { tenantId: t, scopeId: c, jurisdiction: 'eu', vertical: SLUG });
    await host.admin.activateScope(actor, t, c);
    const asked = shopA.requests.length;
    const refused = await relayConnectionUpsert(
      host,
      actor,
      { tenantId: t, scopeId: c, provider: 'woocommerce', owner: 'scope', secret: shopA.secret, createdBy: person },
      {
        probeCandidate: async (_, secret) => probeWooCommerceSecret(secret, { fetch }),
        accountFromProbe: (p) => p === 'woocommerce',
        scopeOwned: { proven: true, scopeOwnable: (p) => p === 'woocommerce', readLandings: (slug, v) => host.versionConnectionLandings(slug, v) },
      },
    ).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectionRelayError);
    expect((refused as ConnectionRelayError).status).toBe(409);
    expect(shopA.requests.length).toBe(asked);
  });
});
