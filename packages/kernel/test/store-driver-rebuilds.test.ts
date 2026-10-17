import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import {
  STORE_DRIVER_RELEASES_DDL,
  advanceStoreDriverRebuildIn,
  claimStoreDriverRebuildIn,
  type SwitchSql,
} from '../src/index.js';

/**
 * The fleet rebuild's row (#2309), against a real SQLite. Each adapter runs these same functions
 * over its own directory; the store-driver contract suite holds both to them end to end.
 */
describe('a store driver\'s fleet rebuild row (#2309)', () => {
  const fresh = (): SwitchSql => {
    const db = new DatabaseSync(':memory:');
    db.exec(STORE_DRIVER_RELEASES_DDL);
    return {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
  };
  const at = (ms: number) => new Date(ms).toISOString();
  const claim = (db: SwitchSql, holder: string, ms: number, extra: { restart?: boolean; attestedBy?: string } = {}) =>
    claimStoreDriverRebuildIn(db, { driver: 'graph', fingerprint: 'f', holder, nowMs: ms, ttlMs: 60_000, at: at(ms), ...extra });
  const advance = (db: SwitchSql, holder: string, ms: number, input: { cursor: string | null; done: boolean; verified?: boolean }) =>
    advanceStoreDriverRebuildIn(db, { driver: 'graph', fingerprint: 'f', holder, failures: [], nowMs: ms, ttlMs: 60_000, release: true, at: at(ms), ...input });

  it('records proof only for a done walk', () => {
    const db = fresh();
    claim(db, 'a', 0);
    let code: unknown;
    try {
      advance(db, 'a', 1, { cursor: 'm', done: false, verified: true });
    } catch (e) {
      code = errorCodeOf(e);
    }
    expect(code).toBe('validation_failed');
    // Nothing was written by the refusal: A's lease lapses, and B finds the walk where A began it.
    expect(claim(db, 'b', 60_000)).toMatchObject({ cursor: null, verifiedAt: null });
    expect(advance(db, 'b', 60_001, { cursor: 'z', done: true, verified: true }).verifiedAt).toBe(at(60_001));
  });

  it('continues an attested walk under way when attested again, and starts a fresh one over', () => {
    const db = fresh();
    // A plain walk under way: an attestation starts it over, from its first script.
    claim(db, 'a', 0);
    advance(db, 'a', 1, { cursor: 'm', done: false });
    const attested = claim(db, 'b', 2, { attestedBy: 'p1' })!;
    expect(attested).toMatchObject({ cursor: null, attestedBy: 'p1', startedAt: at(2) });
    // The attested walk pauses part way; attested again (by anyone), it is continued, not restarted.
    advance(db, 'b', 3, { cursor: 'k', done: false });
    expect(claim(db, 'c', 4, { attestedBy: 'p2' })).toMatchObject({ cursor: 'k', attestedBy: 'p1', startedAt: at(2) });
    // Once done, a further attested run starts a new walk, carrying its own attestation.
    advance(db, 'c', 5, { cursor: 'z', done: true, verified: true });
    expect(claim(db, 'd', 6, { attestedBy: 'p2', restart: true })).toMatchObject({ cursor: null, attestedBy: 'p2', startedAt: at(6) });
    // New lists clear it, and an attested claim at them starts fresh.
    advance(db, 'd', 7, { cursor: 'q', done: false });
    const fresher = claimStoreDriverRebuildIn(db, { driver: 'graph', fingerprint: 'g', holder: 'e', nowMs: 8, ttlMs: 60_000, at: at(8) });
    expect(fresher).toMatchObject({ cursor: null, attestedBy: null, verifiedAt: null });
  });
});
