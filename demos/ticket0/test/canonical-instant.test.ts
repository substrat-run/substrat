/**
 * The snooze sweep's canonical-instant guard, split into pieces a Durable Object will run
 * (#1646) — and still the same guard.
 *
 * The guard was one 92-byte GLOB. A Durable Object's SQLite refuses a LIKE or GLOB pattern
 * over 50 bytes, so on a hosted desk `ticket0/wake-snoozed` failed every run with "LIKE or
 * GLOB pattern too complex" — invisible here, because node's SQLite allows 50 000. It is
 * now three GLOBs over three substrings plus a length (`canonicalInstant`).
 *
 * Splitting a guard is only safe if it still refuses what it refused, and that is what this
 * file holds: node's SQLite runs the ORIGINAL pattern happily, so both predicates are
 * evaluated side by side over canonical instants and near misses, and must agree on every
 * one. The near misses are the shapes the guard exists for — an offset instead of `Z`, no
 * milliseconds, a separator out of place, a stray character at either end — plus the ones
 * a split could plausibly get wrong: a string of the right length with a piece shifted, and
 * a string whose pieces are each fine but whose length is not.
 *
 * The workerd suite (`test/workerd/sweeper.test.ts`) is the other half: there the sweep
 * runs on a real Durable Object and wakes a due snooze.
 */
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CANONICAL_INSTANT_PARTS, canonicalInstant } from '../src/module.js';

/** The guard as it shipped in #1133 — the reference the pieces must agree with. */
const WHOLE = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';

/** A Durable Object's SQLite limit on a LIKE/GLOB pattern, in bytes. */
const DO_PATTERN_LIMIT = 50;

const CANONICAL = [
  '2026-03-09T09:00:00.000Z',
  '2020-01-01T00:00:00.000Z',
  '0000-00-00T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
];

const NEAR_MISSES = [
  '2026-03-09T11:00:00-02:00', // an offset, not UTC — sorts before 11:00Z though it is 13:00Z
  '2026-03-09T11:00:00.000+02:00',
  '2026-03-09T09:00:00Z', // no milliseconds
  '2026-03-09T09:00:00.0000Z', // microsecond-ish: one digit too many
  '2026-03-09T09:00:00.00Z', // one too few
  '2026-03-09T09:00:00,000Z', // comma for the decimal point
  '2026-03-09 09:00:00.000Z', // space for T
  '2026-03-09t09:00:00.000z', // lower case
  '2026-03-09T09:00:00.000', // no zone at all
  '2026-03-0xT09:00:00.000Z', // a letter where a digit goes
  '2026-3-09T09:00:00.000Z', // unpadded month
  '+2026-03-09T09:00:00.000Z', // expanded year
  ' 2026-03-09T09:00:00.000Z', // stray leading character
  '2026-03-09T09:00:00.000Z ', // stray trailing character
  '2026-03-09T09:00:00.000ZZ',
  '2026-03-09T09:00:00.00Z0', // right length, last piece shifted
  '2026-03-09TT9:00:00.000Z', // right length, separator doubled into the time
  '2026-03-0909:00:00T.000Z', // right length, T moved
  '２０２６-03-09T09:00:00.000Z', // full-width digits: right length, not ASCII digits
  '',
  '0',
  '2026-03-09',
];

// The node suites run with a Durable Object's 50-byte pattern limit on (`tools/vitest/like-pattern-limit.cjs`,
// #1655). This file's oracle IS the 92-byte pattern the limit refuses, so this one connection lifts it — the
// pieces are held to the limit by the byte-count test below.
const { liftLimit } = createRequire(import.meta.url)('../../../tools/vitest/like-pattern-limit.cjs') as {
  liftLimit: (db: Database.Database) => Database.Database;
};
const db = liftLimit(new Database(':memory:'));
afterAll(() => db.close());

/** Both predicates over one value: [the original single GLOB, the pieces]. */
function verdicts(value: string | null): [number, number] {
  const row = db
    .prepare(`SELECT COALESCE(v GLOB ?, 0) AS whole, COALESCE(${canonicalInstant('v')}, 0) AS pieces FROM (SELECT ? AS v)`)
    // Placeholders in text order: the whole pattern, the three pieces, then the value.
    .get(WHOLE, ...CANONICAL_INSTANT_PARTS, value) as { whole: number; pieces: number };
  return [row.whole, row.pieces];
}

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('canonicalInstant — the snooze guard, in pieces a Durable Object runs (#1646)', () => {
  it('the whole pattern is over the limit, which is the bug; every piece is under it', () => {
    expect(bytes(WHOLE)).toBeGreaterThan(DO_PATTERN_LIMIT);
    for (const part of CANONICAL_INSTANT_PARTS) expect(bytes(part)).toBeLessThanOrEqual(DO_PATTERN_LIMIT);
  });

  it('accepts every canonical instant the whole pattern accepts', () => {
    for (const value of CANONICAL) expect([value, ...verdicts(value)]).toEqual([value, 1, 1]);
  });

  it('refuses every near miss the whole pattern refuses', () => {
    for (const value of NEAR_MISSES) expect([value, ...verdicts(value)]).toEqual([value, 0, 0]);
  });

  it('refuses NULL, as the whole pattern does', () => {
    expect(verdicts(null)).toEqual([0, 0]);
  });
});
