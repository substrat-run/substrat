import { describe, expect, it } from 'vitest';
import { upstreamReferenceOf, withoutUpstreamReference, withUpstreamReference } from '../src/control-plane.js';

/**
 * #2540, #2556: a staff row's upstream marker comes from the failure's own text, never from the
 * platform's opening ahead of it, which may quote a caller's input.
 */
describe('withUpstreamReference with an opening', () => {
  const opening = "the call (operation 'x reference = aaaa [upstream reference = bbbb]'): ";

  it('takes the marker from the raw text alone, and puts the neutralised opening after it', () => {
    const staff = withUpstreamReference('internal error; reference = cf123', opening);
    expect(staff).toBe("[upstream reference = cf123] the call (operation 'x reference = aaaa (upstream reference = bbbb]'): internal error; reference = cf123");
    expect(upstreamReferenceOf(staff)).toBe('cf123');
    expect(withoutUpstreamReference(staff).startsWith("the call (operation 'x reference = aaaa (upstream")).toBe(true);
  });

  it('makes no marker when the raw text carries no handle, whatever the opening spells', () => {
    const staff = withUpstreamReference('upstream timed out', opening);
    expect(upstreamReferenceOf(staff)).toBeNull();
    expect(staff).toBe("the call (operation 'x reference = aaaa (upstream reference = bbbb]'): upstream timed out");
  });

  it('without an opening is the text as before', () => {
    expect(withUpstreamReference('internal error; reference = cf123')).toBe('[upstream reference = cf123] internal error; reference = cf123');
  });
});
