/**
 * `shop/portal-orders` walks the order table with `pageVisible` (#2080).
 *
 * It used to read every order in the scope, check each one, and only then cut a page — one
 * permission check per order in the shop, whatever `limit` asked for. Now a page costs the
 * checks it takes to fill it, at most `VISIBLE_SCAN_BUDGET`, and never hands out the position
 * of an order the caller cannot see.
 *
 * Elin's and Otto's orders are real checkouts, interleaved, so every page boundary of one
 * customer's walk sits next to the other's. The bulk the scan-bound beats need is written
 * straight into `shop_orders` by the harness: an order no checkout linked to a customer, which
 * every portal caller is refused — the cheapest stand-in for "the rest of the shop's history".
 * Checks are counted by wrapping the checker the host built, as ticket0's desk kit does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VISIBLE_SCAN_BUDGET, VISIBLE_SCAN_BUDGET_MIN, type Page } from '@substrat-run/contracts';
import { ulid, type PermissionChecker, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type OrderRow, type ShopWorld } from '../src/index.js';

let dir: string;
let host: SqliteScopeHost;
let w: ShopWorld;
let astrid: ScopeStub;
let elin: ScopeStub;
let otto: ScopeStub;
/** Newest first, as the walk returns them. */
const hers: string[] = [];
const his: string[] = [];
/** Harness-written orders so far — every one of them in front of every real order. */
let orphans = 0;
/** `order:read` checks on an order, since the last reset. */
let orderChecks = 0;

async function walk(who: ScopeStub, limit: number) {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await who.invoke<Page<OrderRow>>('shop/portal-orders', { limit, ...(cursor ? { cursor } : {}) });
    ids.push(...page.entries.map((o) => o.id));
    if (page.nextCursor === null) return { ids, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

async function checkout(who: ScopeStub, customerId: string): Promise<string> {
  const cart = await who.invoke<{ id: string }>('shop/create-cart');
  await who.invoke('shop/add-to-cart', { cartId: cart.id, variantId: w.chelbesaVariantId, qty: 1 });
  const placed = await who.invoke<{ order: OrderRow }>('shop/checkout', { cartId: cart.id, customerId });
  return placed.order.id;
}

/**
 * Orders no checkout linked to a customer, numbered above every order so far — newer than all
 * of them. `customer_id` is a required column, so it names Otto's; visibility rides the link
 * edge a checkout writes, not the column, so Otto is refused these as well.
 */
function orphanOrders(count: number): void {
  const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`));
  try {
    const top = (db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM shop_orders').get() as { n: number }).n;
    const insert = db.prepare(
      `INSERT INTO shop_orders (id, number, cart_id, customer_id, owner, status, payment_method,
         subtotal_amount, discount_amount, total_amount, currency, placed_at)
       VALUES (?, ?, 'cart', ?, 'nobody', 'placed', 'invoice', '1', '0', '1', 'SEK', '2026-01-01T00:00:00.000Z')`,
    );
    db.transaction(() => {
      for (let i = 1; i <= count; i++) insert.run(ulid(), top + i, w.ottoCustomerId);
    })();
    orphans += count;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shop-portal-walk-'));
  host = buildShopHost(dir);
  w = await seedShop(host, dir);
  astrid = await host.getScope(w.astrid, w.t1, w.s1);
  elin = await host.getScope(w.elin, w.t1, w.s1);
  otto = await host.getScope(w.otto, w.t1, w.s1);
  await astrid.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 100 });
  // Two of Otto's between each of Elin's, so her page boundaries sit beside his orders.
  for (let i = 0; i < 4; i++) {
    hers.unshift(await checkout(elin, w.elinCustomerId!));
    his.unshift(await checkout(otto, w.ottoCustomerId!));
    his.unshift(await checkout(otto, w.ottoCustomerId!));
  }

  const wrapped = host as unknown as { checker: PermissionChecker };
  const inner = wrapped.checker;
  wrapped.checker = {
    covers: (...args) => inner.covers(...args),
    check: (subject, permission, node, entity) => {
      if (permission === 'order:read' && entity?.entityType === 'order') orderChecks += 1;
      return inner.check(subject, permission, node, entity);
    },
  };
});

beforeEach(() => {
  orderChecks = 0;
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('shop/portal-orders walks with pageVisible (#2080)', () => {
  for (const limit of [1, 2, 3]) {
    it(`limit ${limit}: each customer reaches every own order with sealed cursors`, async () => {
      for (const [who, own] of [
        [elin, hers],
        [otto, his],
      ] as const) {
        const { ids, cursors } = await walk(who, limit);
        expect(ids).toEqual(own);
        expect(cursors.length).toBeGreaterThan(0);
        for (const c of cursors) {
          expect(c).toMatch(/^sc1\./);
          for (const id of [...hers, ...his]) expect(c).not.toContain(id);
        }
      }
    });
  }

  it('the staff walk sees both, interleaved — so the portal pages above were cut between hidden orders', async () => {
    const all = (await astrid.invoke<Page<OrderRow>>('shop/orders', { limit: 200 })).entries.map((o) => o.id);
    const portal = all.filter((id) => hers.includes(id) || his.includes(id));
    expect(portal.slice(0, 6)).toEqual([his[0], his[1], hers[0], his[2], his[3], hers[1]]);
  });

  describe('with the rest of the shop’s history in front of her', () => {
    // Runs after the walks above, which these orders would otherwise sit in front of.
    beforeAll(() => orphanOrders(300));

    it('a page costs the checks it takes to fill it, not one per order in the shop', async () => {
      const page = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 2 });
      expect(page.entries.map((o) => o.id)).toEqual(hers.slice(0, 2));
      // The orphans, then Otto's two, Elin's first, Otto's next two, Elin's second — and stop.
      expect(orderChecks).toBe(orphans + 6);
      expect(page.nextCursor).toMatch(/^sc1\./);
    });

    it('the next page starts after her own order, not after a refused one', async () => {
      const first = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 2 });
      orderChecks = 0;
      const second = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 2, cursor: first.nextCursor! });
      expect(second.entries.map((o) => o.id)).toEqual(hers.slice(2, 4));
      expect(orderChecks).toBe(6);
    });
  });

  // Elin's newest order is row `orphans + 3` of her walk: the orphans, then Otto's two newest.
  describe(`the scan budget (${VISIBLE_SCAN_BUDGET_MIN}–${VISIBLE_SCAN_BUDGET} rows a call)`, () => {
    let atHerNewest: string;

    it('her newest order at the maximum budget boundary is eventually found', async () => {
      orphanOrders(VISIBLE_SCAN_BUDGET - 3 - orphans);
      let cursor: string | undefined;
      for (let i = 0; i < 2; i++) {
        orderChecks = 0;
        const page = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 1, cursor });
        expect(page.nextCursor).toMatch(/^sc1\./);
        expect(orderChecks).toBeLessThanOrEqual(VISIBLE_SCAN_BUDGET);
        if (page.entries.length > 0) {
          expect(page.entries.map((o) => o.id)).toEqual([hers[0]]);
          atHerNewest = page.nextCursor!;
          break;
        }
        expect(orderChecks).toBeGreaterThanOrEqual(VISIBLE_SCAN_BUDGET_MIN);
        cursor = page.nextCursor!;
      }
      expect(atHerNewest).toBeDefined();
    });

    it('one row further returns an empty page with a continuation, then reaches her order', async () => {
      orphanOrders(1);
      const page = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 1 });
      expect(page.entries).toEqual([]);
      expect(page.nextCursor).toMatch(/^sc1\./);
      expect(orderChecks).toBeGreaterThanOrEqual(VISIBLE_SCAN_BUDGET_MIN);
      expect(orderChecks).toBeLessThanOrEqual(VISIBLE_SCAN_BUDGET);
      let cursor = page.nextCursor!;
      let found = false;
      for (let i = 0; i < 2; i++) {
        orderChecks = 0;
        const resumed = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 1, cursor });
        expect(resumed.nextCursor).toMatch(/^sc1\./);
        expect(orderChecks).toBeLessThanOrEqual(VISIBLE_SCAN_BUDGET);
        if (resumed.entries.length > 0) {
          expect(resumed.entries.map((o) => o.id)).toEqual([hers[0]]);
          found = true;
          break;
        }
        cursor = resumed.nextCursor!;
      }
      expect(found).toBe(true);
    });

    it('her cursor carries the walk on past the budget, from her own order', async () => {
      const page = await elin.invoke<Page<OrderRow>>('shop/portal-orders', { limit: 2, cursor: atHerNewest });
      expect(page.entries.map((o) => o.id)).toEqual(hers.slice(1, 3));
      expect(orderChecks).toBe(6);
    });
  });
});
