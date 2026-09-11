import { describe, expect, it } from 'vitest';
import { declaredEventSurface } from '../src/deploy.js';

/**
 * The declared event surface is REPARSED wherever a retained manifest is read, and the
 * pusher at that boundary is whoever holds a token rather than necessarily this CLI. So
 * the grammar here has to be the same one a module manifest is held to: a looser
 * `min(1)` let a name no module could ever declare be persisted and then reported as a
 * finding about an event that cannot exist.
 */
describe('declaredEventSurface (#1234)', () => {
  it('accepts the names a module manifest can actually carry', () => {
    expect(
      declaredEventSurface.parse({ moduleId: 'crm', type: 'receipt.landed', direction: 'emits' }),
    ).toEqual({ moduleId: 'crm', type: 'receipt.landed', direction: 'emits' });
  });

  it('refuses a name outside the canonical event grammar', () => {
    for (const type of ['Not An Event Name', 'nodot', 'Upper.Case', 'trailing.', '.leading', 'a b.c']) {
      expect(declaredEventSurface.safeParse({ moduleId: 'crm', type, direction: 'emits' }).success).toBe(false);
    }
  });

  it('refuses a direction that is neither side of the seam', () => {
    expect(
      declaredEventSurface.safeParse({ moduleId: 'crm', type: 'receipt.landed', direction: 'observes' }).success,
    ).toBe(false);
  });
});
