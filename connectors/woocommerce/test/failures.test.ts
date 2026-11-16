import { describe, expect, it } from 'vitest';
import { substratError } from '@substrat-run/contracts';
import { WooCommerceApiError, WooCommerceMappingError } from '../src/index.js';
import { verdictOf } from '../src/failures.js';
import { wcProduct } from '../src/api.js';

/** The hosted hop's landing failure, as the control-plane client throws it: a status and the raw body. */
const hop = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status, body: '{}' });
/** The connector's wrapper around an app's own refusal (#3235). */
const refusal = (cause: unknown) => Object.assign(new Error('refused', { cause }), { name: 'WooCommerceLandingRefusal', said: 'the app refused it' });

describe('woocommerce — how a failure on one record is judged (#3241)', () => {
  it.each([
    ['a mapping refusal', new WooCommerceMappingError('price'), 'unreadable'],
    ["a row Zod refuses", (() => { try { wcProduct.parse({ id: 1, price: 3 }); } catch (e) { return e; } })(), 'unreadable'],
    ['the store refusing the key', new WooCommerceApiError('no', 401), 'pass'],
    ['the store rate-limiting', new WooCommerceApiError('slow', 429), 'pass'],
    ["the store failing on the record's variations", new WooCommerceApiError('boom', 500), 'failing'],
    ['the app refusing the record (in process)', refusal(substratError('conflict', 'UNIQUE')), 'failing'],
    ['the landing key gone (in process)', refusal(substratError('permission_denied', 'no')), 'pass'],
    ['an undeclared throw (in process)', new Error('oops'), 'failing'],
    ['the app refusing the record (hosted)', refusal(hop(400)), 'failing'],
    ['the landing key gone (hosted)', refusal(hop(403)), 'pass'],
    ['the operation missing (hosted)', hop(404), 'pass'],
    ['the platform failing (hosted)', hop(502), 'pass'],
  ])('%s → %s', (_, err, verdict) => {
    expect(verdictOf(err)).toBe(verdict);
  });
});
