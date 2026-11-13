import { describe, expect, it } from 'vitest';
import { wcOrder, wcProduct } from '../src/api.js';
import { gmtInstant, orderChange, productChange } from '../src/commerce.js';
import { currencyCode } from '@substrat-run/contracts';
import { ORDERS, product } from './fixture.js';

/**
 * Mapping refuses rather than reshapes: a value that does not fit the neutral shape names the row
 * and field it came from, and never lands as something close to it.
 */
const SEK = currencyCode.parse('SEK');

describe('woocommerce → commerce mapping', () => {
  it('reads a zone-less `_gmt` date as UTC', () => {
    expect(gmtInstant('2026-11-01T10:00:00', 'x')).toBe('2026-11-01T10:00:00.000Z');
  });

  it.each([
    [{ price: '12.5.0' }, /price: '12.5.0' is not a decimal/],
    [{ price: '1e3' }, /price: '1e3' is not a decimal/],
    [{ date_modified_gmt: null, date_created_gmt: null }, /neither a modified nor a created date/],
    [{ date_modified_gmt: 'yesterday' }, /'yesterday' is not a date/],
  ])('refuses a product with %j', (over, error) => {
    expect(() => productChange('c1', SEK, wcProduct.parse(product(1, '2026-11-01T10:00:00', over)), [])).toThrow(error);
  });

  it.each([
    [{ total: '' }, /order 501 total: '' is not a decimal/],
    [{ currency: 'kr' }, /currency/],
    [{ line_items: [{ id: 9, name: 'Tyg', product_id: 5, variation_id: 0, quantity: 1.5, subtotal: '1.00', total: '1.00', total_tax: '0.00' }] }, /quantity 1.5 is not whole/],
  ])('refuses an order with %j', (over, error) => {
    expect(() => orderChange('c1', wcOrder.parse({ ...ORDERS()[0], ...over }))).toThrow(error);
  });
});
