/**
 * The coverage answer's own invariant.
 *
 * `covered` and `missing` are two readings of ONE answer to §5.1's assignment bound, and
 * a producer that let them part company would refuse for the caller that reads `covered`
 * and allow for the caller that reads `missing.length`. The union is what makes that
 * unrepresentable; these are the values it has to refuse for that to be true.
 */
import { describe, expect, it } from 'vitest';
import { permissionKey } from '../src/ids.js';
import { coverage } from '../src/permission.js';

const PERM = permissionKey.parse('billing:manage');

describe('coverage', () => {
  it('accepts a covered answer with nothing missing', () => {
    expect(coverage.parse({ covered: true, missing: [] })).toEqual({
      covered: true,
      missing: [],
    });
  });

  it('accepts a refusal that names what is missing', () => {
    expect(coverage.parse({ covered: false, missing: [PERM] })).toEqual({
      covered: false,
      missing: [PERM],
    });
  });

  /** The contradiction that used to parse: an allow that also names a missing permission. */
  it('refuses a covered answer that names a missing permission', () => {
    expect(() => coverage.parse({ covered: true, missing: [PERM] })).toThrow();
  });

  /** And its mirror: a refusal a person cannot act on, because it names nothing. */
  it('refuses a refusal with nothing missing', () => {
    expect(() => coverage.parse({ covered: false, missing: [] })).toThrow();
  });
});
