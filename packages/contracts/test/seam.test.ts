import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineSeam, errorCodeOf, isSubstratError } from '../src/index.js';

/**
 * The seam helper, now that it is shared (#970).
 *
 * The per-engine suites (`engines/*\/test/seam.test.ts`) are the ones that matter:
 * they move a table under a running engine and assert the caller gets a throw
 * rather than wrong data. What is tested HERE is only what those cannot see now
 * that the implementation left them — that the engine name each supplies is what
 * comes back in the failure, so a seam refusal still says which engine drifted.
 */
describe('engineSeam', () => {
  const { returns, columnsOf } = engineSeam('engine-example');
  const row = z.object({ id: z.string(), order_id: z.string() });

  it('returns the parsed value when the shape matches', () => {
    expect(returns(row, 'getThing', { id: 'a', order_id: 'b' })).toEqual({ id: 'a', order_id: 'b' });
  });

  it('refuses as internal, naming the engine, the surface and the field', () => {
    let thrown: unknown;
    try {
      returns(row, 'getThing', { id: 'a' });
    } catch (e) {
      thrown = e;
    }
    expect(isSubstratError(thrown)).toBe(true);
    // `internal`, not `validation_failed`: the caller's input was already parsed —
    // it is this engine's own stored row that no longer matches what it publishes.
    expect(errorCodeOf(thrown)).toBe('internal');
    expect((thrown as Error).message).toContain('engine-example');
    expect((thrown as Error).message).toContain('getThing');
    expect((thrown as Error).message).toContain('order_id');
  });

  it('derives the SELECT list from the schema, in declaration order', () => {
    expect(columnsOf(row)).toBe('id, order_id');
  });

  it('refuses a schema key that is not a column name, naming the engine', () => {
    expect(() => columnsOf(z.object({ 'drop table': z.string() }))).toThrow(/engine-example/);
  });

  it('binds one name per engine — two seams do not share it', () => {
    const other = engineSeam('engine-other');
    expect(() => other.returns(row, 'getThing', {})).toThrow(/engine-other/);
    expect(() => returns(row, 'getThing', {})).toThrow(/engine-example/);
  });
});
