/**
 * #1773: `shop/orders`, whose handler the platform now derives, answers what the hand-written
 * handler it replaced answered — the check plus `ctx.page` over orders. The oracle is the rows
 * on the scope's own database, the table named as a literal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type ShopWorld } from '../src/index.js';

type Row = Record<string, unknown>;

let dir: string;
let host: SqliteScopeHost;
let w: ShopWorld;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shop-derived-pins-'));
  host = buildShopHost(dir);
  w = await seedShop(host, dir);
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('derived reads answer what the handlers they replaced answered (#1773)', () => {
  it('shop/orders: the page is the rows', async () => {
    const astrid = await host.getScope(w.astrid, w.t1, w.s1);
    const elin = await host.getScope(w.elin, w.t1, w.s1);
    await astrid.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 5 });
    const cart = await elin.invoke<{ id: string }>('shop/create-cart');
    await elin.invoke('shop/add-to-cart', { cartId: cart.id, variantId: w.chelbesaVariantId, qty: 1 });
    await elin.invoke('shop/checkout', { cartId: cart.id, customerId: w.elinCustomerId, paymentMethod: 'invoice' });

    const page = await astrid.invoke<Page<Row>>('shop/orders', { limit: 100 });
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = new Map((db.prepare('SELECT * FROM shop_orders').all() as Row[]).map((r) => [r.id, r]));
    db.close();
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBe(rows.size);
    expect(page.entries).toStrictEqual(page.entries.map((e) => rows.get(e.id)));
  });
});
