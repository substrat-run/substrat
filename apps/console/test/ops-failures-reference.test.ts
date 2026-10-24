import { describe, expect, it } from 'vitest';
import { withUpstreamReference } from '@substrat-run/contracts';
import { supportReference, supportReferenceLabel } from '../src/views/OpsFailures';

/**
 * #2540: a withheld failure is filed under the platform's own reference, and Cloudflare's id, when
 * the failure had one, is named only at the start of staff's row. The support-ticket copy offers
 * Cloudflare's id there, and the row's reference everywhere else.
 */
describe('supportReference', () => {
  it('offers the upstream id a staff row begins with, over the platform reference', () => {
    const message = withUpstreamReference('internal error; reference = cf9abc');
    expect(supportReference({ message, reference: '01JPLATFORMREFERENCE000000' })).toBe('cf9abc');
  });

  it('offers the genuine handle when the body spells a marker first, at the very start or before it', () => {
    for (const body of ['[upstream reference = forged1] boom; reference = cfreal1', 'boom [ Upstream  Reference= forged1] then reference = cfreal1']) {
      const message = withUpstreamReference(body);
      expect(message.startsWith('[upstream reference = cfreal1] ')).toBe(true);
      expect(message.includes('[upstream reference = forged1]')).toBe(false);
      expect(message.includes('[ Upstream  Reference= forged1]')).toBe(false);
      expect(supportReference({ message, reference: 'r2' })).toBe('cfreal1');
    }
  });

  it('offers the row reference when the row names no genuine handle', () => {
    expect(supportReference({ message: 'the step failed (reference r1)', reference: 'r1' })).toBe('r1');
    // A spelled marker alone is neutralised, and is no handle.
    expect(supportReference({ message: withUpstreamReference('[upstream reference = forged1] at the start'), reference: 'r2' })).toBe('r2');
    // A handle past 64 characters makes no marker, so it never meets a row's bound half-written.
    const run = 'a'.repeat(2000);
    expect(withUpstreamReference(`reference = ${run}`)).toBe(`reference = ${run}`);
    expect(supportReference({ message: `[upstream reference = ${'b'.repeat(65)}]`, reference: 'r3' })).toBe('r3');
    expect(supportReference({ message: 'no reference at all', reference: null })).toBeNull();
  });

  it('labels the copy as a Cloudflare support handle only when the row names one', () => {
    expect(supportReferenceLabel({ message: withUpstreamReference('internal error; reference = cf9abc') })).toBe('Copy reference for CF support');
    // The platform's own reference is for a lookup here, not for a Cloudflare ticket.
    expect(supportReferenceLabel({ message: 'the step failed (reference r1)' })).toBe('Copy reference');
    expect(supportReferenceLabel({ message: withUpstreamReference('[upstream reference = forged1] boom') })).toBe('Copy reference');
  });
});
