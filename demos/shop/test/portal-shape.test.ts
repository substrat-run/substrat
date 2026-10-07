/**
 * The portal grant is a declared shape, so a key added to it reaches the customers who already
 * held it (#2083) — including the ones granted key by key before the shape grant existed.
 *
 * An instance as an older release left it: provisioned, one order, and Kerstin given a key of
 * the `customer` shape on her customer's record one key at a time, with no holder marker. The
 * shape the reconcile carries is the declared one grown by the key she lacks (`order:read`, the
 * key `shop/portal-orders` walks). Until the reconcile she sees nothing; after it she sees the
 * order, because the `'grantee'` holder found her by the key she already held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, principalId, scopeId, tenantId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { SHOP_PERM } from '../src/module.js';
import { buildShopHost, ENTITY_GRANTS, portalPerms, provisionShop } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let orderId: string;
const staff = platformActorId.parse(ulid());
const owner = principalId.parse(ulid());
const kerstin = principalId.parse(ulid());
const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shop-portal-shape-'));
  host = buildShopHost(dir);
  await provisionShop(host, { ...node, owner, slug: 'acme', name: 'Acme Rosteri' });
  const admin = await host.getScope(owner, node.tenantId, node.scopeId);
  const product = await admin.invoke<{ id: string }>('shop/create-product', { slug: 'p', name: 'P', origin: 'O', notes: 'N', roast: 1 });
  const variant = await admin.invoke<{ id: string }>('shop/add-variant', {
    productId: product.id, sku: 'P-1', grind: 'Hela bönor', sizeLabel: '250 g', priceAmount: '100',
  });
  await admin.invoke('shop/set-stock', { variantId: variant.id, onHand: 5 });
  await admin.invoke('shop/publish-product', { productId: product.id });
  const customer = await admin.invoke<{ id: string }>('shop/create-customer', { number: 'K-1', name: 'Café Acme' });
  const cart = await admin.invoke<{ id: string }>('shop/create-cart');
  await admin.invoke('shop/add-to-cart', { cartId: cart.id, variantId: variant.id, qty: 1 });
  orderId = (await admin.invoke<{ order: { id: string } }>('shop/checkout', { cartId: cart.id, customerId: customer.id, paymentMethod: 'invoice' })).order.id;

  await host.admin.assignRole(staff, { principalId: kerstin, roleKey: 'shopper', node });
  // The older shape, granted the old way: one key, no marker.
  await host.admin.grant(staff, {
    principalId: kerstin,
    permission: SHOP_PERM.browse,
    node,
    entity: { entityType: 'customer', entityId: customer.id },
    grantedBy: owner,
  });
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const sees = async () =>
  (await (await host.getScope(kerstin, node.tenantId, node.scopeId)).invoke<Page<{ id: string }>>('shop/portal-orders')).entries.map(
    (o) => o.id,
  );

describe('a key the portal shape gains reaches a customer granted before markers (#2083)', () => {
  it('the declared shape is a bootstrap shape whose holder is whoever holds a key of it', () => {
    expect(ENTITY_GRANTS).toEqual([{ entityType: 'customer', permissions: portalPerms, bootstrap: true, holder: 'grantee' }]);
  });

  it('before the reconcile she sees nothing', async () => {
    expect(await sees()).toEqual([]);
  });

  it('after it, she sees her customer’s order', async () => {
    const grown = ENTITY_GRANTS.map((g) => ({ ...g, permissions: [SHOP_PERM.browse, ...g.permissions] }));
    await host.admin.reconcileEntityGrantShapes(staff, node, grown);
    expect(await sees()).toEqual([orderId]);
  });
});
