import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type ShopWorld } from '../src/index.js';

/**
 * A cart hold lapses after its OWN duration (#812).
 *
 * The scenario suite's §8 already covers lazy TTL release, but it gets there by
 * passing `holdSeconds: 0` — so what it proves is that an already-elapsed hold is
 * swept, not that a hold survives its window and then does not. The interesting
 * branch (still held at 14 minutes, gone at 16) was unreachable, because reaching
 * it against the wall clock means sleeping for a quarter of an hour.
 *
 * With an injected clock it is two assertions and no elapsed real time. This is
 * the case #812 was filed for: not tidiness, a test that could not previously be
 * written.
 */
describe('cart hold expiry, on a clock the test controls (#812)', () => {
  const HOLD_MINUTES = 15; // DEFAULT_HOLD_SECONDS = 900
  let dir: string;
  let host: SqliteScopeHost;
  let w: ShopWorld;
  let astrid: ScopeStub;
  let guest: ScopeStub;
  let otto: ScopeStub;
  const clock = manualClock('2026-03-02T09:00:00.000Z');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-shop-clock-'));
    host = buildShopHost(dir, { clock: clock.read });
    w = await seedShop(host, dir);
    astrid = await host.getScope(w.astrid, w.t1, w.s1);
    guest = await host.getScope(w.guest, w.t1, w.s1);
    otto = await host.getScope(w.otto, w.t1, w.s1);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the unit for its full window, then releases it — with no real time elapsed', async () => {
    await astrid.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 1 });

    const guestCart = await guest.invoke<{ id: string }>('shop/create-cart');
    await guest.invoke('shop/add-to-cart', {
      cartId: guestCart.id,
      variantId: w.chelbesaVariantId!,
      qty: 1,
    });

    // One minute short of the window: still held, so the only unit is not sellable.
    clock.advance((HOLD_MINUTES - 1) * 60_000);
    const ottoCart = await otto.invoke<{ id: string }>('shop/create-cart');
    await expect(
      otto.invoke('shop/add-to-cart', { cartId: ottoCart.id, variantId: w.chelbesaVariantId, qty: 1 }),
    ).rejects.toThrow(/out of stock/);

    // Two minutes later the hold has lapsed and the same call succeeds.
    clock.advance(2 * 60_000);
    const reserved = await otto.invoke<{ availableAfter: number }>('shop/add-to-cart', {
      cartId: ottoCart.id,
      variantId: w.chelbesaVariantId!,
      qty: 1,
    });
    expect(reserved.availableAfter).toBe(0);
  });

  it('stamps every row in one operation with the same instant', async () => {
    clock.set('2026-03-02T11:30:00.000Z');
    const product = await astrid.invoke<{ id: string }>('shop/create-product', {
      slug: 'clock-test',
      name: 'Clock Test',
      origin: 'Nowhere',
      notes: 'stamped by the injected clock',
    });
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const row = db
      .prepare('SELECT created_at FROM shop_products WHERE id = ?')
      .get(product.id) as { created_at: string };
    db.close();
    expect(row.created_at).toBe('2026-03-02T11:30:00.000Z');
  });
});
