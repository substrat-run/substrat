import { describe, it, expect } from 'vitest';
import { instant } from '../src/ids.js';

/**
 * `Instant` is compared LEXICOGRAPHICALLY everywhere it is used — grant liveness is
 * `expires_at > now` in JS and as SQL, in both adapters. Lexicographic order only
 * agrees with chronological order when the texts share a zone and a shape, so the
 * parse is where a wire value is normalised (#963).
 */
describe('instant', () => {
  it('normalises a UTC offset to the equivalent Z text', () => {
    expect(instant.parse('2026-08-28T10:00:00+02:00')).toBe('2026-08-28T08:00:00.000Z');
    expect(instant.parse('2026-08-28T10:00:00-05:30')).toBe('2026-08-28T15:30:00.000Z');
  });

  it('gives every instant the same shape, so text order is time order', () => {
    // Without normalisation this pair compares the wrong way round: the offset text
    // sorts after the Z text while naming the earlier moment.
    const offset = instant.parse('2026-08-28T10:00:00+02:00'); // 08:00Z
    const z = instant.parse('2026-08-28T09:00:00Z');
    expect('2026-08-28T10:00:00+02:00' > '2026-08-28T09:00:00.000Z').toBe(true); // the bug
    expect(offset < z).toBe(true); // the fix
  });

  it('pads a second-precision Z instant to milliseconds', () => {
    // Same reason: '…T09:00:00Z' sorts BEFORE '…T09:00:00.000Z' though they are one moment.
    expect(instant.parse('2026-08-28T09:00:00Z')).toBe('2026-08-28T09:00:00.000Z');
  });

  it('leaves an already-normalised instant alone', () => {
    expect(instant.parse('2026-08-28T09:00:00.000Z')).toBe('2026-08-28T09:00:00.000Z');
  });

  it('still refuses what is not an ISO instant', () => {
    expect(() => instant.parse('2026-08-28')).toThrow();
    expect(() => instant.parse('2026-08-28T09:00:00')).toThrow(); // no zone
    expect(() => instant.parse('yesterday')).toThrow();
  });
});
