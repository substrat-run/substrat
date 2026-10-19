/**
 * #2402: `vertical_versions` is unique on `(vertical_slug, version)`, and a fixture's `version`
 * was the last four characters of its id. The kernel's ulid is monotonic only within a
 * millisecond; in a later one the random half is drawn afresh, so those four characters are 20
 * independent bits and a slug's versions collided on a push to `main` about once in 10^5 runs.
 *
 * The collision is too rare to wait for, so the test mints enough versions that the old spelling
 * collides for certain and asserts the new one does not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createUlid } from '@substrat-run/kernel';
import { fixtureVersion } from '../src/fixture-version.js';

// 2^20 = 1_048_576 four-character values; the chance that 20 000 independent draws are all
// distinct is about e^-190, so the control below cannot pass by luck.
const MINTED = 20_000;
const FIRST_MS = Date.UTC(2026, 0, 1);

/** `MINTED` ids from one mint, each in a later millisecond: the shape that re-draws the random half. */
const acrossMilliseconds = (): string[] => {
  const mint = createUlid();
  return Array.from({ length: MINTED }, (_, i) => mint(FIRST_MS + i));
};

describe('fixtureVersion (#2402)', () => {
  it('is distinct for every id minted in a different millisecond', () => {
    const ids = acrossMilliseconds();
    expect(new Set(ids.map((id) => fixtureVersion(id))).size).toBe(MINTED);
  });

  it('is distinct for every id minted in the same millisecond', () => {
    const mint = createUlid();
    const ids = Array.from({ length: MINTED }, () => mint(FIRST_MS));
    expect(new Set(ids.map((id) => fixtureVersion(id))).size).toBe(MINTED);
  });

  it('control: the four-character spelling it replaced collides on the same ids', () => {
    const ids = acrossMilliseconds();
    expect(new Set(ids.map((id) => `1.0.${id.slice(-4).toLowerCase()}`)).size).toBeLessThan(MINTED);
  });

  it('is lower case, carries the major, and is a non-empty label the registry accepts', () => {
    const id = createUlid()(FIRST_MS);
    expect(fixtureVersion(id)).toBe(`1.0.${id.toLowerCase()}`);
    expect(fixtureVersion(id, 3)).toBe(`3.0.${id.toLowerCase()}`);
    expect(fixtureVersion(id)).toBe(fixtureVersion(id).toLowerCase());
  });
});

describe('no suite spells a version from part of an id (#2402)', () => {
  it('has no `version:` built from a slice of an id in the suites', () => {
    const src = new URL('../src/', import.meta.url);
    const offenders = readdirSync(src)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        readFileSync(new URL(file, src), 'utf8')
          .split('\n')
          .map((line, i) => ({ at: `${file}:${i + 1}`, line }))
          .filter(({ line }) => /\bversion:/.test(line) && /\.slice\(-?\d/.test(line)),
      );
    expect(offenders).toEqual([]);
  });
});
