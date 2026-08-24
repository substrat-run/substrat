import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildShopHost, seedShop, type ShopWorld, type OrderRow, type OrderLineRow } from '../src/index.js';
import { manualClock } from '@substrat-run/kernel';

/**
 * The scenario from spec/concept.md §9 — headless end-to-end:
 * migrations → catalogue → the OVERSELL throw → denials (roles, cart ownership,
 * cross-tenant) → priced checkout mot faktura → the invoicing engine builds a
 * invoice basis from the RETAIL event (reuse + additive consume) → portal
 * isolation → lazy TTL release → the order state machine can't skip → the
 * warehouse's on-hand/reserved view stays behind stock:manage, and drafts stay
 * behind catalog:manage.
 */
describe('Kallkälla Kaffe e-commerce scenario (concept §9)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  /**
   * A clock §8 can move (#812). The scenario used to reach an elapsed hold by
   * asking for a zero-second one, which the operation's declared input has
   * always forbidden (`holdSeconds` is `.positive()`) — nothing parsed it, so
   * nothing said so until the host began to (#893). Shrinking the window to
   * zero is also the thing the house rule names instead of `manualClock`.
   */
  const clock = manualClock('2026-03-02T09:00:00.000Z');
  let w: ShopWorld;
  let astrid: ScopeStub;
  let gustav: ScopeStub;
  let elin: ScopeStub;
  let otto: ScopeStub;
  let guest: ScopeStub;
  let cartE: string;
  let orderId: string;

  interface CatalogProduct {
    slug: string;
    variants: { id: string; sku: string; available: number }[];
  }
  interface StockOverviewRow {
    sku: string;
    onHand: number;
    reserved: number;
    available: number;
  }
  const availabilityOf = (cat: CatalogProduct[], sku: string): number =>
    cat.flatMap((p) => p.variants).find((v) => v.sku === sku)?.available ?? -1;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-shop-'));
    host = buildShopHost(dir, { clock: clock.read });
    w = await seedShop(host, dir);
    astrid = await host.getScope(w.astrid, w.t1, w.s1);
    gustav = await host.getScope(w.gustav, w.t1, w.s1);
    elin = await host.getScope(w.elin, w.t1, w.s1);
    otto = await host.getScope(w.otto, w.t1, w.s1);
    guest = await host.getScope(w.guest, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and journals the vertical + reused invoicing engine', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const modules = (
      db.prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id').all() as {
        module_id: string;
      }[]
    ).map((r) => r.module_id);
    const shopVersions = (
      db
        .prepare("SELECT version FROM _substrat_migrations WHERE module_id = '@substrat-run/demo-shop' ORDER BY version")
        .all() as { version: string }[]
    ).map((v) => v.version);
    db.close();
    expect(modules).toEqual(['@substrat-run/demo-shop', '@substrat-run/engine-invoicing']);
    // The hand-written journal, plus the two list indexes the KERNEL provisions
    // from this module's declared `paged.over` walks (#811). Their version IS the
    // declaration — add a sortable column and the version changes and re-runs —
    // so asserting them here is what makes a widened walk visible in a diff
    // rather than something that silently reshapes the schema.
    expect(shopVersions).toEqual([
      '0001-init',
      'list/order:number+placed_at:customer_id+status',
      'list/product:name+slug+created_at:published',
    ]);
  });

  it('2. the catalogue shows the micro-lot with genuine scarcity', async () => {
    const cat = (await elin.invoke<Page<CatalogProduct>>('shop/catalog')).entries;
    expect(availabilityOf(cat, 'GICH-250-HB')).toBe(1); // the micro-lot
    expect(availabilityOf(cat, 'CHEL-250-HB')).toBe(20);
  });

  it('3. NO OVERSELL: two carts race for the last bag — exactly one wins', async () => {
    const cart = await elin.invoke<{ id: string }>('shop/create-cart');
    cartE = cart.id;
    const reserved = await elin.invoke<{ reserved: number; availableAfter: number }>('shop/add-to-cart', {
      cartId: cartE,
      variantId: w.microLotVariantId,
      qty: 1,
    });
    expect(reserved).toEqual({ lineId: expect.any(String), reserved: 1, availableAfter: 0 });

    const ottoCart = await otto.invoke<{ id: string }>('shop/create-cart');
    await expect(
      otto.invoke('shop/add-to-cart', { cartId: ottoCart.id, variantId: w.microLotVariantId, qty: 1 }),
    ).rejects.toThrow(/out of stock/);
  });

  it('4. the denials hold: role, cart ownership, and cross-tenant', async () => {
    // warehouse CAN adjust stock…
    await expect(gustav.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 20 })).resolves.toBeTruthy();
    // …but NOT the catalogue, discounts, or reading nothing it lacks.
    await expect(
      gustav.invoke('shop/create-product', { slug: 'x', name: 'X', origin: 'Y', notes: 'Z' }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      gustav.invoke('shop/create-discount', { code: 'HACK', kind: 'pct', value: '90' }),
    ).rejects.toThrow(/permission denied/);

    // the anonymous shopper cannot read the order book.
    await expect(guest.invoke('shop/orders')).rejects.toThrow(/permission denied/);

    // cart isolation: Otto cannot touch Elin's cart.
    await expect(otto.invoke('shop/cart', { cartId: cartE })).rejects.toThrow(/permission denied/);

    // cross-tenant: Rurik (Bönfeber) fails the pair check, then holds no tuples in t1.
    await expect(host.getScope(w.rurik, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    const rurik = await host.getScope(w.rurik, w.t1, w.s1);
    await expect(rurik.invoke('shop/orders')).rejects.toThrow(/permission denied/);
    await expect(rurik.invoke('shop/catalog')).rejects.toThrow(/permission denied/);
    await expect(rurik.invoke('shop/portal-orders')).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
  });

  it('5. priced checkout mot faktura: discount exact to the öre, order frozen', async () => {
    const result = await elin.invoke<{ order: OrderRow; lines: OrderLineRow[] }>('shop/checkout', {
      cartId: cartE,
      customerId: w.elinCustomerId,
      paymentMethod: 'invoice',
      discountCode: 'KALLKALLA10',
    });
    orderId = result.order.id;
    expect(result.order.status).toBe('placed');
    expect(result.order.subtotal_amount).toBe('189'); // 1 × 189
    expect(result.order.discount_amount).toBe('18.9'); // 10 %
    expect(result.order.total_amount).toBe('170.1'); // net
    expect(result.lines).toHaveLength(1);

    // the last bag is now sold.
    const cat = (await elin.invoke<Page<CatalogProduct>>('shop/catalog')).entries;
    expect(availabilityOf(cat, 'GICH-250-HB')).toBe(0);

    // the cart is placed → immutable; no more writes, no double checkout.
    await expect(
      elin.invoke('shop/add-to-cart', { cartId: cartE, variantId: w.microLotVariantId, qty: 1 }),
    ).rejects.toThrow(/not open/);
    await expect(
      elin.invoke('shop/checkout', { cartId: cartE, customerId: w.elinCustomerId }),
    ).rejects.toThrow(/not open/);
  });

  it('6. star topology: invoicing built an invoice basis from the RETAIL event', async () => {
    const { entries: underlag } = await astrid.invoke<
      Page<{ id: string; status: string; total: string }>
    >('invoicing/list');
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('170.1'); // product line + discount line, net

    const detail = await astrid.invoke<
      { lines: { document_type: string; document_id: string; source_type: string | null }[] }
    >('invoicing/get', {
      underlagId: underlag[0]!.id,
    });
    expect(detail.lines).toHaveLength(2); // the bag + the discount line
    // Document-level provenance: the retail order these lines came from (#328).
    expect(detail.lines.every((l) => l.document_type === 'order' && l.document_id === orderId)).toBe(true);
    // commerce.order-placed carries no per-line provenance, so it is honestly absent.
    expect(detail.lines.every((l) => l.source_type === null)).toBe(true);
  });

  it('7. portal isolation: Elin sees her order, Otto and the guest see nothing', async () => {
    const elins = (await elin.invoke<Page<OrderRow>>('shop/portal-orders')).entries;
    expect(elins.map((o) => o.id)).toEqual([orderId]);
    await expect(otto.invoke('shop/portal-orders')).resolves.toEqual({ entries: [], nextCursor: null });
    await expect(guest.invoke('shop/portal-orders')).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    await expect(elin.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
  });

  it('8. lazy TTL release: an elapsed hold frees the unit on the next read', async () => {
    await astrid.invoke('shop/set-stock', { variantId: w.chelbesaVariantId, onHand: 1 });

    const guestCart = await guest.invoke<{ id: string }>('shop/create-cart');
    // A one-minute hold, then a clock that walks past it: the reservation is
    // elapsed by the time Otto reads, without a zero-length window or a sleep.
    await guest.invoke('shop/add-to-cart', {
      cartId: guestCart.id,
      variantId: w.chelbesaVariantId,
      qty: 1,
      holdSeconds: 60,
    });
    clock.advance(120_000);

    const ottoCart = await otto.invoke<{ id: string }>('shop/create-cart');
    const reserved = await otto.invoke<{ availableAfter: number }>('shop/add-to-cart', {
      cartId: ottoCart.id,
      variantId: w.chelbesaVariantId,
      qty: 1,
    });
    expect(reserved.availableAfter).toBe(0); // it succeeded — the guest's hold had lapsed
  });

  it('9. the order state machine cannot skip: placed → fulfilled → closed', async () => {
    const fulfilled = await astrid.invoke<OrderRow>('shop/fulfil-order', { orderId });
    expect(fulfilled.status).toBe('fulfilled');
    await expect(astrid.invoke('shop/fulfil-order', { orderId })).rejects.toThrow(/invalid transition/);

    const closed = await astrid.invoke<OrderRow>('shop/close-order', { orderId });
    expect(closed.status).toBe('closed');
    await expect(astrid.invoke('shop/close-order', { orderId })).rejects.toThrow(/invalid transition/);
  });

  it('10. the warehouse view splits on-hand from reserved; browse never sees either', async () => {
    // Otto's hold from §8 is still live: 1 on the shelf, 1 held, 0 sellable.
    const rows = (await gustav.invoke<Page<StockOverviewRow>>('shop/stock-overview')).entries;
    const chelbesa = rows.find((r) => r.sku === 'CHEL-250-HB');
    expect(chelbesa).toMatchObject({ onHand: 1, reserved: 1, available: 0 });

    // The storefront's own read exposes availability and nothing behind it — a
    // shopper must never be able to infer the reservation ledger.
    const cat = (await elin.invoke<Page<CatalogProduct>>('shop/catalog')).entries;
    const browseVariant = cat.flatMap((p) => p.variants).find((v) => v.sku === 'CHEL-250-HB');
    expect(browseVariant).toBeDefined();
    expect(browseVariant).not.toHaveProperty('onHand');
    expect(browseVariant).not.toHaveProperty('reserved');

    // stock:manage gates the view: a shopper and a guest are turned away.
    await expect(elin.invoke('shop/stock-overview')).rejects.toThrow(/permission denied/);
    await expect(guest.invoke('shop/stock-overview')).rejects.toThrow(/permission denied/);
  });

  it('11. drafts are catalogue-authors-only, even though browse is public', async () => {
    const draft = await astrid.invoke<{ id: string; published: number }>('shop/create-product', {
      slug: 'kommande-lot',
      name: 'Kommande lot',
      origin: 'Ej klar',
      notes: 'Utkast',
    });
    expect(draft.published).toBe(0);

    const slugs = (c: CatalogProduct[]) => c.map((p) => p.slug);
    // catalog:manage sees the draft…
    const asAdmin = (
      await astrid.invoke<Page<CatalogProduct>>('shop/catalog', { includeUnpublished: true })
    ).entries;
    expect(slugs(asAdmin)).toContain('kommande-lot');
    // …the published storefront never does…
    expect(slugs((await astrid.invoke<Page<CatalogProduct>>('shop/catalog')).entries)).not.toContain('kommande-lot');
    expect(slugs((await guest.invoke<Page<CatalogProduct>>('shop/catalog')).entries)).not.toContain('kommande-lot');

    // …and asking for it without catalog:manage is denied, not silently ignored.
    // Gustav holds stock:manage + shop:browse, which is the near-miss that matters.
    await expect(guest.invoke('shop/catalog', { includeUnpublished: true })).rejects.toThrow(/permission denied/);
    await expect(gustav.invoke('shop/catalog', { includeUnpublished: true })).rejects.toThrow(/permission denied/);
  });
});
