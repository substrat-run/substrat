import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
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

describe('the D-65 approval directory shape', () => {
  it('admits one live approval per release and keys revoke walks by approval', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(STORE_DRIVER_RELEASES_DDL);
    const insert = db.prepare(`INSERT INTO store_driver_approvals
      (approval_id, driver, sha256, source_commit, approved_by, approved_at, reason,
       source_references, isolation_review, schema, class_name, operations)
      VALUES (?, ?, ?, 'commit', 'staff', '2026-10-28', 'reviewed', '[]', '{}', 1, 'Store', '[]')`);
    const sha256 = 'a'.repeat(64);
    insert.run('first', 'graph', sha256);
    expect(() => insert.run('duplicate', 'graph', sha256)).toThrow(/UNIQUE constraint failed/);
    insert.run('other-driver', 'other', sha256);
    db.prepare('UPDATE store_driver_approvals SET revoked_at = ? WHERE approval_id = ?').run('2026-10-29', 'first');
    insert.run('second', 'graph', sha256);

    const walk = db.prepare(`INSERT INTO store_driver_revoke_walks
      (approval_id, cursor, actor, reason, rollout_seq)
      VALUES (?, NULL, 'staff', 'reviewed', 0)`);
    walk.run('first');
    walk.run('second');
    expect(db.prepare(`SELECT w.approval_id, a.driver, a.sha256 FROM store_driver_revoke_walks w
      JOIN store_driver_approvals a USING (approval_id) ORDER BY w.approval_id`).all()).toEqual([
      { approval_id: 'first', driver: 'graph', sha256 },
      { approval_id: 'second', driver: 'graph', sha256 },
    ]);
    expect(() => walk.run('missing')).toThrow(/FOREIGN KEY constraint failed/);
    db.exec(STORE_DRIVER_RELEASES_DDL);
    db.close();
  });
});

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
    const previousGood = () => storeDriverStateIn(sql, 'graph', nowMs).current?.previousGoodSha256;
    /** The error code a begin is refused with, or null when it begins (the row is then ended failed). */
    const refusedBegin = (sha256: string, action: StoreDriverRolloutAction = 'rollout') => {
      try {
        const row = beginStoreDriverRolloutIn(sql, { driver: 'graph', sha256, action, holder: 'h', actor: 'staff', at, nowMs });
        finishStoreDriverRolloutIn(sql, { driver: 'graph', seq: row.seq, holder: 'h', state: 'failed', detail: null, at, nowMs });
        return null;
      } catch (e) {
        return errorCodeOf(e);
      }
    };
    return { attempt, target, previousGood, refusedBegin };
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

  // The sequences the round-2 review probed, pinned (#2338). A, B, C are releases 1, 2, 3; B is
  // current after `base`.
  const [A, B, C] = [sha('1'), sha('2'), sha('3')];
  const base = () => {
    const t = fresh();
    t.attempt(A, 'good');
    t.attempt(B, 'good');
    return t;
  };

  it('keeps the target on the current release through a rollback onto it and a re-post of it, after another release diverged', () => {
    for (const ends of ['paused', 'diverged'] as const) {
      const { attempt, target } = base();
      attempt(C, 'diverged');
      attempt(B, ends, 'rollback');
      expect(target(), ends).toBe(B);
      attempt(B, 'paused');
      expect(target(), ends).toBe(B);
    }
  });

  it('goes back to the previous good release once a rollback onto the current one ends good', () => {
    const { attempt, target, previousGood } = base();
    attempt(C, 'diverged');
    attempt(B, 'good', 'rollback');
    expect(previousGood()).toBe(A);
    expect(target()).toBe(A);
  });

  it('keeps an unfinished rollback to the previous good release blocking, through a re-post before it and a failed post after it', () => {
    const { attempt, target, refusedBegin } = base();
    attempt(B, 'paused');
    expect(target()).toBe(A);
    attempt(A, 'paused', 'rollback');
    expect(target()).toBe(A);
    attempt(A, 'failed', 'rollback');
    expect(target()).toBe(A);
    expect(refusedBegin(C)).toBe('conflict');
    expect(refusedBegin(B)).toBe('conflict');
    expect(target()).toBe(A);
  });

  it('never moves the target on a failed row, of any release or action', () => {
    const { attempt, target } = base();
    attempt(C, 'failed');
    attempt(B, 'failed');
    attempt(A, 'failed', 'rollback');
    expect(target()).toBe(A);
    attempt(C, 'diverged');
    expect(target()).toBe(B);
    attempt(B, 'failed', 'rollback');
    attempt(C, 'failed');
    expect(target()).toBe(B);
  });

  it('keeps the previous good release across a re-post of the current one that ends good', () => {
    const { attempt, target, previousGood } = base();
    attempt(B, 'paused');
    attempt(B, 'good');
    expect(previousGood()).toBe(A);
    expect(target()).toBe(A);
  });

  it('reads only the rows since the newest good one: a pause before it no longer counts', () => {
    const { attempt, target, previousGood } = base();
    attempt(C, 'paused');
    expect(target()).toBe(B);
    attempt(C, 'good');
    expect(previousGood()).toBe(B);
    expect(target()).toBe(B);
    attempt(C, 'paused');
    expect(target()).toBe(B);
  });

  it('keeps the target on the current release when another release is re-posted after an unfinished rollback onto it', () => {
    const { attempt, target } = base();
    attempt(C, 'diverged');
    attempt(B, 'diverged', 'rollback');
    attempt(C, 'paused');
    expect(target()).toBe(B);
  });
});
