import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  STORE_DRIVER_RELEASES_DDL,
  beginStoreDriverRolloutIn,
  finishStoreDriverRolloutIn,
  holdStoreDriverIn,
  recordStoreDriverReleaseIn,
  storeDriverStateIn,
  type StoreDriverRolloutAction,
  type StoreDriverRolloutState,
  type SwitchSql,
} from '../src/index.js';

/**
 * Where a rollback goes (D-63, #2300), against a real SQLite, for the rows paging adds (#2312).
 * Each adapter runs these same functions over its own directory; the store-driver contract suite
 * holds both to them end to end.
 */
describe('the rollback target while a rollout is paged (#2312)', () => {
  const sha = (c: string) => c.repeat(64);
  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(STORE_DRIVER_RELEASES_DDL);
    const sql: SwitchSql = {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
    const at = '2026-10-16T00:00:00.000Z';
    const nowMs = Date.parse(at);
    expect(holdStoreDriverIn(sql, { driver: 'graph', holder: 'h', mode: 'exclusive', nowMs, ttlMs: 60_000 })).toBe(true);
    for (const c of ['1', '2', '3']) {
      recordStoreDriverReleaseIn(sql, { driver: 'graph', sha256: sha(c), sourceCommit: 'c'.repeat(40), actor: 'staff', at });
    }
    const attempt = (sha256: string, state: Exclude<StoreDriverRolloutState, 'rolling'>, action: StoreDriverRolloutAction = 'rollout') => {
      const row = beginStoreDriverRolloutIn(sql, { driver: 'graph', sha256, action, holder: 'h', actor: 'staff', at, nowMs });
      finishStoreDriverRolloutIn(sql, { driver: 'graph', seq: row.seq, holder: 'h', state, detail: null, at, nowMs, ...(state === 'paused' ? { walked: [] } : {}) });
    };
    const target = () => storeDriverStateIn(sql, 'graph', nowMs).rollbackTarget;
    return { attempt, target };
  };

  it('stays on the previous good release while the current release is re-posted, whatever the re-post ends', () => {
    for (const ends of ['paused', 'diverged'] as const) {
      const { attempt, target } = fresh();
      attempt(sha('1'), 'good');
      attempt(sha('2'), 'good');
      attempt(sha('2'), ends);
      attempt(sha('2'), ends);
      expect(target(), ends).toBe(sha('1'));
    }
  });

  it('turns onto the current release once a rollout of another release is part way, and a later re-post of the current one does not turn it back', () => {
    const { attempt, target } = fresh();
    attempt(sha('1'), 'good');
    attempt(sha('2'), 'good');
    attempt(sha('3'), 'paused');
    expect(target()).toBe(sha('2'));
    attempt(sha('2'), 'paused');
    expect(target()).toBe(sha('2'));
  });
});
