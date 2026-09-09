import { describe, expect, it } from 'vitest';
import { createUlid, ulid, ulidTime } from '../src/ulid.js';

describe('ulid', () => {
  it('is a 26-character Crockford base32 id', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('carries the millisecond it was minted at', () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(ulidTime(createUlid()(t))).toBe(t);
  });

  it('sorts in creation order within a millisecond', () => {
    const mint = createUlid();
    const ids = Array.from({ length: 50 }, () => mint(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not go backwards when its own clock does', () => {
    const mint = createUlid();
    const a = mint(1_700_000_000_000);
    const b = mint(1_600_000_000_000);
    expect(b > a).toBe(true);
    // Floored at the last instant it stamped, not the one it was handed.
    expect(ulidTime(b)).toBe(1_700_000_000_000);
  });

  it('gives each mint its OWN floor (#956)', () => {
    // The whole point of `createUlid`: a writer stamping from an injected clock
    // must not be dragged forward by an unrelated wall-clock mint elsewhere in the
    // isolate. With one shared floor this id would carry `Date.now()`.
    ulid();
    const past = Date.UTC(2020, 0, 1);
    expect(ulidTime(createUlid()(past))).toBe(past);
  });

  it('ulidTime refuses a string that is not a ULID', () => {
    // Right length, wrong alphabet — and a truncated id, which would otherwise
    // decode to a plausible-looking millisecond.
    expect(() => ulidTime('not-a-ulid-at-all-nope!!!!!')).toThrow(/not a ULID/);
    expect(() => ulidTime(ulid().slice(0, 20))).toThrow(/not a ULID/);
  });
});
