import { afterEach, describe, expect, it } from 'vitest';
import { commerceChange, type CommerceChange } from '@substrat-run/contracts';

/**
 * What every commerce-source connector does, whichever store platform it reads (#3136) — written
 * against a harness rather than against one store, so each connector runs the same assertions on
 * its own mock. Extracted from two implementations, WooCommerce and Shopify, as the vocabulary in
 * `@substrat-run/contracts` (`commerce-source.ts`) said it would be: what is asserted here is what
 * both hold, and a rule only one store has (WooCommerce's variant id for a simple product) is the
 * connector's own test, not this suite's.
 */
export interface CommerceSourceHarness {
  /**
   * A store holding a product sold without variants, a product sold in two or more variants, and an
   * order that sells one of each; bound to a scope and not yet swept. The product sold without
   * variants is the one {@link renameSimpleProduct} renames.
   */
  seed(): Promise<void>;
  /** One sweep of the bound connection. */
  sweep(): Promise<void>;
  /** Everything the landing operation was handed, in order. */
  landed(): CommerceChange[];
  /** A merchant saving the product sold without variants, renaming it to `name`. */
  renameSimpleProduct(name: string): Promise<void>;
  close(): void;
}

export function commerceSourceSuite(provider: string, harness: () => CommerceSourceHarness): void {
  describe(`${provider}: commerce-source behaviour`, () => {
    let h: CommerceSourceHarness | undefined;
    const start = async () => {
      h = harness();
      await h.seed();
      await h.sweep();
      return h;
    };
    afterEach(() => {
      h?.close();
      h = undefined;
    });

    it('lands records in the neutral shape: every product sells a variant, every order line names one it carries', async () => {
      const store = await start();
      const landed = store.landed();
      for (const change of landed) expect(commerceChange.safeParse(change).success).toBe(true);
      const products = landed.filter((c) => c.record === 'product' && c.change === 'upsert');
      const orders = landed.filter((c) => c.record === 'order' && c.change === 'upsert');
      expect(products.length).toBeGreaterThanOrEqual(2);
      expect(orders.length).toBeGreaterThanOrEqual(1);
      // A product sold without variants lands ONE: untitled and picked by no option. Its id is the
      // store's to choose — the product's own on WooCommerce, the default variant's on Shopify.
      expect(products.some((p) => p.variants.length === 1 && p.variants[0]?.title === null && p.variants[0]?.options.length === 0)).toBe(true);
      expect(products.some((p) => p.variants.length >= 2)).toBe(true);
      const variants = new Set(products.flatMap((p) => p.variants.map((v) => v.variantId)));
      const sold = orders.flatMap((o) => o.lines.map((l) => l.variantId)).filter((v) => v !== null);
      expect(sold.length).toBeGreaterThan(0);
      for (const v of sold) expect(variants.has(v)).toBe(true);
    });

    it('lands nothing again when nothing changed, and a changed record again under the same id', async () => {
      const store = await start();
      const before = store.landed().length;
      const simple = store.landed().find((c) => c.record === 'product' && c.change === 'upsert' && c.variants.length === 1)!;
      await store.sweep();
      expect(store.landed().length).toBe(before);

      await store.renameSimpleProduct('Renamed');
      await store.sweep();
      const again = store.landed().slice(before);
      expect(again).toEqual([expect.objectContaining({ record: 'product', productId: simple.record === 'product' ? simple.productId : '', name: 'Renamed' })]);
    });
  });
}
