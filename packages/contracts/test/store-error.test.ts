import { describe, expect, it } from 'vitest';
import { errorCodeOf, scopeStoreObjectName, STORE_BODY_MAX_BYTES, StoreError, storeResponse, toProblem } from '../src/index.js';

describe('StoreError (#2209)', () => {
  it('derives the taxonomy code from the status and keeps the store’s own code', () => {
    const err = new StoreError({ code: 'not_a_node', status: 404, body: { id: 'n1' } });
    expect(errorCodeOf(err)).toBe('not_found');
    expect(err.storeCode).toBe('not_a_node');
    expect(err.extensions.storeCode).toBe('not_a_node');
    expect(err.extensions.storeBody).toEqual({ id: 'n1' });
    expect(toProblem(err).storeCode).toBe('not_a_node');
  });

  it('maps a status the taxonomy does not list to unavailable, and still carries the body', () => {
    const err = new StoreError({ code: 'teapot', status: 418, body: 'short' });
    expect(errorCodeOf(err)).toBe('unavailable');
    expect(toProblem(err).detail).toMatch(/418/);
    expect(toProblem(err).storeBody).toBe('short');
  });

  it('maps a 5xx to unavailable and keeps its body in the store', () => {
    const err = new StoreError({ code: 'broke', status: 500, body: 'disk' });
    expect(errorCodeOf(err)).toBe('unavailable');
    expect(toProblem(err).detail).toMatch(/500/);
    expect(err.storeBody).toBeUndefined();
    expect(toProblem(err).storeBody).toBeUndefined();
  });

  it('carries no body for a status that is not an HTTP error, a body too large, or one that is not JSON', () => {
    for (const status of [200, 302, 399, -1, 600]) {
      const err = new StoreError({ code: 'odd', status, body: 'x' });
      expect(err.storeBody, `status ${status}`).toBeUndefined();
      expect(toProblem(err).storeBody, `status ${status}`).toBeUndefined();
    }
    const fits = 'a'.repeat(STORE_BODY_MAX_BYTES - 2);
    expect(new StoreError({ code: 'big', status: 409, body: fits }).storeBody).toBe(fits);
    expect(new StoreError({ code: 'big', status: 409, body: `${fits}a` }).storeBody).toBeUndefined();
    expect(new StoreError({ code: 'bigint', status: 409, body: { n: 1n } }).storeBody).toBeUndefined();
    // The bound is bytes, not characters: 600 'é' is 602 characters of JSON and 1202 bytes.
    expect(new StoreError({ code: 'wide', status: 409, body: 'é'.repeat(600) }).storeBody).toBeUndefined();
  });

  it('reads an error envelope only with a status from 400 to 599', () => {
    expect(storeResponse.safeParse({ error: { code: 'no', status: 404 } }).success).toBe(true);
    expect(storeResponse.safeParse({ error: { code: 'no', status: 599 } }).success).toBe(true);
    for (const status of [200, 399, 600, -1]) {
      expect(storeResponse.safeParse({ error: { code: 'no', status } }).success, `status ${status}`).toBe(false);
    }
  });

  it('builds an object name the vertical does not choose', () => {
    expect(scopeStoreObjectName('01TENANT', 'acme/crm', '01SCOPE', 'GRAPH')).toBe(
      '01TENANT/acme/crm/01SCOPE/GRAPH',
    );
  });
});
