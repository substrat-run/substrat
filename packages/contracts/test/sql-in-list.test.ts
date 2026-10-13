import { describe, it, expect } from 'vitest';
import { inList } from '../src/index.js';

/**
 * The shape only. What the SQL does on each adapter — 250 values, the empty list, the
 * hand-built twin refused — is `sqlLimitsContractSuite`'s, run on node and on workerd.
 */
describe('inList (#2248)', () => {
  it('binds the whole list as ONE JSON parameter, however long it is', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const list = inList(ids);
    expect(list.sql).toBe('(SELECT value FROM json_each(?))');
    expect(list.params).toHaveLength(1);
    expect(JSON.parse(list.params[0])).toEqual(ids);
  });

  it('keeps numbers numbers, so they meet an INTEGER column as numbers', () => {
    expect(inList([1, 2.5, -3]).params).toEqual(['[1,2.5,-3]']);
  });

  it('takes the empty list', () => {
    expect(inList([]).params).toEqual(['[]']);
  });

  it('refuses what JSON would silently turn into null', () => {
    expect(() => inList([1, Number.NaN])).toThrow(/NaN is not a string or a finite number/);
    expect(() => inList([Number.POSITIVE_INFINITY])).toThrow(TypeError);
    // Outside the type, but a caller with `any` in hand gets the refusal too.
    expect(() => inList([null as unknown as string])).toThrow(TypeError);
    expect(() => inList([10n as unknown as number])).toThrow(TypeError);
  });
});
