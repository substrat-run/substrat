import { describe, expect, it } from 'vitest';
import { errorCodeOf, scopeStoreObjectName, StoreError, toProblem } from '../src/index.js';

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

  it('builds an object name the vertical does not choose', () => {
    expect(scopeStoreObjectName('01TENANT', 'acme/crm', '01SCOPE', 'GRAPH')).toBe(
      '01TENANT/acme/crm/01SCOPE/GRAPH',
    );
  });
});
