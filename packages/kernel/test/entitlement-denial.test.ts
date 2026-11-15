import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { refuseEntitlement, type EntitlementDenialLine } from '../src/entitlement-denial.js';

// #3105: a tenant holding A, B and C, refused an operation that needs D. The caller reads the
// operation and D; the line an operator reads names all four, keyed by the request id.
describe('refuseEntitlement', () => {
  it('keeps the held keys out of the refusal and puts them on the server-side line', () => {
    const lines: EntitlementDenialLine[] = [];
    const err = refuseEntitlement(
      {
        operation: 'desk/act',
        requiredKey: 'desk',
        held: [
          { key: 'alpha', expired: false },
          { key: 'bravo', expired: true },
          { key: 'charlie', expired: false },
        ],
        tenantId: 't1',
        scopeId: 's1',
        requestId: 'req-1',
      },
      (line) => lines.push(line),
    );

    expect(errorCodeOf(err)).toBe('not_found');
    expect(err.message).toBe("operation not entitled: desk/act — tenant does not hold 'desk'");
    expect(err.message).not.toMatch(/alpha|bravo|charlie|holds/);
    expect(lines).toEqual([
      expect.objectContaining({
        substrat: 'entitlement-denied',
        level: 'warn',
        tenantId: 't1',
        scopeId: 's1',
        requestId: 'req-1',
        operation: 'desk/act',
        required: 'desk',
        held: ['alpha', 'bravo (expired)', 'charlie'],
      }),
    ]);
  });
});
