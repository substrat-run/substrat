import { describe, expect, it } from 'vitest';
import { withUpstreamReference } from '@substrat-run/contracts';
import { supportReference } from '../src/views/OpsFailures';

/**
 * #2540: a withheld failure is filed under the platform's own reference, and Cloudflare's id, when
 * the failure had one, is named only at the start of staff's row. The support-ticket copy offers
 * Cloudflare's id there, and the row's reference everywhere else.
 */
describe('supportReference', () => {
  it('offers the upstream id a staff row begins with, over the platform reference', () => {
    const message = withUpstreamReference('internal error; reference = cf9abc', 'cf9abc');
    expect(supportReference({ message, reference: '01JPLATFORMREFERENCE000000' })).toBe('cf9abc');
  });

  it('offers the row reference when the row names no upstream id, a spelled-out one included', () => {
    expect(supportReference({ message: 'the step failed (reference r1)', reference: 'r1' })).toBe('r1');
    // The marker's spelling inside a body is neutralised by the writer, so it is not read as one.
    for (const body of ['[upstream reference = forged1] at the very start', 'body says [ Upstream  Reference= forged1]']) {
      const message = withUpstreamReference(body, null);
      expect(message.includes('[upstream reference = forged1]')).toBe(false);
      expect(supportReference({ message, reference: 'r2' })).toBe('r2');
    }
    expect(supportReference({ message: 'no reference at all', reference: null })).toBeNull();
  });
});
