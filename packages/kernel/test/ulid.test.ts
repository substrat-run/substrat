import { describe, expect, it } from 'vitest';
import { createUlid, ulid, ulidTime } from '../src/ulid.js';

/** The last instant a ULID's 48-bit timestamp can hold. */
const MAX = 2 ** 48 - 1;

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

  it('ulidTime judges all 26 digits, not the ten it decodes', () => {
    // A sound timestamp half does not make the id sound: the random half is where
    // a truncate-and-pad or a hand-typed id goes wrong, and `ulidTime` promises to
    // refuse anything that is not a ULID — not "anything whose first ten are fine".
    expect(() => ulidTime('0000000000!!!!!!!!!!!!!!!!')).toThrow(/not a ULID/);
    // Crockford leaves out I, L, O and U precisely because they are mistyped for
    // 1, 1, 0 and V — so an id carrying one is a transcription error, not an id.
    for (const wrong of ['I', 'L', 'O', 'U']) {
      expect(() => ulidTime(ulid().slice(0, 25) + wrong)).toThrow(/not a ULID/);
    }
  });

  it('refuses to mint from an instant it cannot encode', () => {
    // Pre-epoch on a mint with no floor yet: `Date.parse` of anything before 1970
    // is negative, and the encoder used to index its alphabet with that and hand
    // back a string of `undefined`s — caught downstream by a schema complaining
    // about the id's shape, which says nothing about the clock that caused it.
    expect(() => createUlid()(Date.parse('1969-12-31T23:59:59.999Z'))).toThrow(RangeError);
    const mint = createUlid();
    expect(() => mint(2 ** 48)).toThrow(RangeError); // one past what 48 bits hold
    expect(() => mint(Number.NaN)).toThrow(RangeError); // an unparseable instant
    expect(() => mint(1.5)).toThrow(RangeError); // not a whole millisecond
    // The mint is unharmed by the refusals: its floor never moved.
    expect(ulidTime(mint(1_700_000_000_000))).toBe(1_700_000_000_000);
  });

  it('lets the floor absorb a rewind rather than calling it unencodable', () => {
    // The range is judged on what is ENCODED, not on what is handed in — otherwise
    // this would throw, and a rewound clock holding at the floor is the documented
    // behaviour (`event-id-clock.test.ts`), not an error. 1969 is just a big rewind.
    const mint = createUlid();
    const anchor = mint(1_700_000_000_000);
    const rewound = mint(Date.parse('1969-12-31T23:59:59.999Z'));
    expect(rewound > anchor).toBe(true);
    expect(ulidTime(rewound)).toBe(1_700_000_000_000);
  });

  it('mints exactly the range ulidTime accepts', () => {
    // The two halves of one contract — anything `createUlid` will stamp, `ulidTime`
    // reads back, and nothing it refuses can be minted in the first place.
    expect(ulidTime(createUlid()(0))).toBe(0);
    expect(ulidTime(createUlid()(MAX))).toBe(MAX);
    expect(() => createUlid()(MAX + 1)).toThrow(RangeError);
  });

  it('ulidTime refuses a timestamp that does not fit 48 bits', () => {
    // Right length, right alphabet, first digit above 7 — ten base32 digits can
    // spell 50 bits and the timestamp is 48, so this is not a far-future id, it is
    // a malformed one. It used to decode to a millisecond past the encodable range.
    expect(() => ulidTime('80000000000000000000000000')).toThrow(/not a ULID/);
    expect(() => ulidTime('ZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow(/not a ULID/);
    // The digit either side of the boundary: `7ZZZ…` is the last decodable instant.
    expect(ulidTime('7ZZZZZZZZZ0000000000000000')).toBe(MAX);
  });
});

describe('seedFrom — the floor survives the mint that held it (#1335)', () => {
  const T = Date.UTC(2026, 0, 2, 3, 4, 5);
  const REWOUND = Date.UTC(2025, 5, 1);

  it('mints above a seeded id even when the clock is behind it', () => {
    // The reproduction in the issue, with the storage taken out: the id below is
    // what a previous mint persisted, and this mint has stamped nothing yet.
    const persisted = createUlid()(T);
    const revived = createUlid();
    revived.seedFrom(persisted);

    const next = revived(REWOUND);
    expect(next > persisted).toBe(true);
    // Held at the seed's instant rather than following the clock down — the same
    // thing the in-memory floor does for a rewind within one mint's life.
    expect(ulidTime(next)).toBe(T);
  });

  it('is what makes the difference — without it the new id sorts underneath', () => {
    // Spelled out so the assertion above cannot be "fixed" into one a bare mint
    // would also pass: this is the bug, reproduced.
    const persisted = createUlid()(T);
    expect(createUlid()(REWOUND) > persisted).toBe(false);
  });

  it('never lowers a floor the mint has already reached', () => {
    const mint = createUlid();
    const high = mint(T);
    mint.seedFrom(createUlid()(REWOUND));
    expect(mint(REWOUND) > high).toBe(true);
  });

  it('takes the random half too, so a same-millisecond seed still wins', () => {
    // Both ids carry the same instant, so only the random digits separate them. A
    // seed that moved `lastTime` alone would re-randomize and could land below.
    const persisted = `${createUlid()(T).slice(0, 10)}ZZZZZZZZZZZZZZZP`;
    const revived = createUlid();
    revived.seedFrom(persisted);
    expect(revived(T) > persisted).toBe(true);
  });

  it('carries the seed on the timestamp when the random half overflows', () => {
    // All 16 digits at their maximum: there is no increment left, so the mint steps
    // the millisecond and re-randomizes. Still strictly greater, one ms later.
    const persisted = `${createUlid()(T).slice(0, 10)}ZZZZZZZZZZZZZZZZ`;
    const revived = createUlid();
    revived.seedFrom(persisted);
    const next = revived(T);
    expect(next > persisted).toBe(true);
    expect(ulidTime(next)).toBe(T + 1);
  });

  it('is a no-op for a same-millisecond seed the mint is already above', () => {
    const mint = createUlid();
    const own = mint(T);
    mint.seedFrom(`${own.slice(0, 10)}0000000000000000`);
    expect(mint(T) > own).toBe(true);
  });

  it('refuses a string that is not a ULID rather than seeding from a prefix', () => {
    expect(() => createUlid().seedFrom('not-a-ulid')).toThrow(/not a ULID/);
    expect(() => createUlid().seedFrom('80000000000000000000000000')).toThrow(/not a ULID/);
  });
});
