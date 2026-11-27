import { describe, expect, it, vi } from 'vitest';
import { lakePayloadSealOf } from '../src/lake-seal.js';

describe('LAKE_PAYLOAD_SEAL (#3464)', () => {
  it('is off unset and when off, on when on, and seals on a value it does not know', () => {
    const warn = vi.fn();
    expect([undefined, '', 'off', ' OFF '].map((v) => lakePayloadSealOf(v, warn))).toEqual([false, false, false, false]);
    expect(lakePayloadSealOf('on', warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    // A typo guards personal data the safe way: sealed, and said so.
    expect(lakePayloadSealOf('yes', warn)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });
});
