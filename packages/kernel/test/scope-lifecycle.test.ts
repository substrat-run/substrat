import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ScopeLifecycle } from '@substrat-run/contracts';
import {
  isLifecycleWrite,
  lifecycleAfterLoad,
  lifecycleReceipt,
  lifecycleRefusal,
  readLifecycle,
  settleLifecycleAfterLoad,
  writeLifecycle,
  WRITE_LIFECYCLE_SQL,
  type SwitchSql,
} from '../src/index.js';

/**
 * The lifecycle a CP-less deployment holds a scope by (#1713): the one refusal predicate both the
 * request doors and the background entry points ask, the newest-read-wins write, and what a load
 * leaves. The adapters' own suites drive these through a real scope store; this pins the rules.
 */
describe('scope lifecycle (#1713)', () => {
  const fresh = (): SwitchSql => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return {
      all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
      run: (q, ...p) => {
        db.prepare(q).run(...p);
      },
    };
  };
  const at = (minute: number) => `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z` as ScopeLifecycle['at'];
  const life = (scope: ScopeLifecycle['scope'], tenant: ScopeLifecycle['tenant'], minute: number): ScopeLifecycle => ({
    scope,
    tenant,
    at: at(minute),
  });

  describe('lifecycleRefusal — the directory\'s gate, in its words', () => {
    it('passes no lifecycle, and active/active', () => {
      expect(lifecycleRefusal(null)).toBeNull();
      expect(lifecycleRefusal(life('active', 'active', 0))).toBeNull();
    });
    it('judges the tenant first, then the scope, as scopeAccessRefusal does', () => {
      const ids = { tenantId: 'T', scopeId: 'S' };
      expect(lifecycleRefusal(life('suspended', 'suspended', 0), ids)).toBe('tenant not active (status: suspended): T');
      expect(lifecycleRefusal(life('suspended', 'active', 0), ids)).toBe('scope not active (status: suspended): S');
    });
    it.each(['suspended', 'archiving', 'archived', 'provisioning', 'reaped'] as const)('holds a %s scope', (scope) => {
      expect(lifecycleRefusal(life(scope, 'active', 0))).not.toBeNull();
    });
    it.each(['suspended', 'deleting', 'reaped'] as const)('holds a scope under a %s tenant', (tenant) => {
      expect(lifecycleRefusal(life('active', tenant, 0))).not.toBeNull();
    });
  });

  describe('writeLifecycle — the newest read wins', () => {
    it('stores the first delivery and reports the gate moving', () => {
      const sql = fresh();
      expect(writeLifecycle(sql, life('suspended', 'active', 1))).toEqual({
        applied: true,
        changed: true,
        lifecycle: life('suspended', 'active', 1),
      });
      expect(readLifecycle(sql)).toEqual(life('suspended', 'active', 1));
    });
    it('keeps a newer one over a late delivery, and answers what it holds', () => {
      const sql = fresh();
      writeLifecycle(sql, life('suspended', 'active', 2));
      expect(writeLifecycle(sql, life('active', 'active', 1))).toEqual({
        applied: false,
        changed: false,
        lifecycle: life('suspended', 'active', 2),
      });
    });
    it('an equal read is a repeat: applied, nothing moved', () => {
      const sql = fresh();
      writeLifecycle(sql, life('suspended', 'active', 1));
      expect(writeLifecycle(sql, life('suspended', 'active', 1))).toMatchObject({ applied: true, changed: false });
    });
    it('suspended → archived is a newer state with the same answer: changed is false', () => {
      const sql = fresh();
      writeLifecycle(sql, life('suspended', 'active', 1));
      expect(writeLifecycle(sql, life('archived', 'active', 2))).toMatchObject({ applied: true, changed: false });
    });
    it('writes through the one statement the scope DO admits as bookkeeping, and no other', () => {
      const seen: string[] = [];
      const sql = fresh();
      writeLifecycle({ all: sql.all, run: (q, ...p) => (seen.push(q), sql.run(q, ...p)) }, life('active', 'active', 1));
      expect(seen).toEqual([WRITE_LIFECYCLE_SQL]);
      expect(isLifecycleWrite(`  ${WRITE_LIFECYCLE_SQL.replace(/ /g, '\n ')} `)).toBe(true);
      expect(isLifecycleWrite("INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('write_revision', ?)")).toBe(false);
    });
    it('a stored value that does not parse reads as none, and is replaced', () => {
      const sql = fresh();
      sql.run("INSERT INTO _substrat_meta (key, value) VALUES ('scope_lifecycle', 'not json')");
      expect(readLifecycle(sql)).toBeNull();
      expect(writeLifecycle(sql, life('suspended', 'active', 1)).applied).toBe(true);
    });
  });

  describe('lifecycleAfterLoad — what a load leaves', () => {
    const older = life('active', 'active', 1);
    const newer = life('suspended', 'active', 2);
    it('a return keeps the newer of the store and the dump', () => {
      expect(lifecycleAfterLoad(newer, older, false)).toEqual(newer); // a backup from before the suspension
      expect(lifecycleAfterLoad(older, newer, false)).toEqual(newer);
      expect(lifecycleAfterLoad(null, newer, false)).toEqual(newer); // a carry into a fresh store
      expect(lifecycleAfterLoad(newer, null, false)).toEqual(newer);
      expect(lifecycleAfterLoad(null, null, false)).toBeNull();
    });
    it("a copy keeps only its own, never the source's", () => {
      expect(lifecycleAfterLoad(null, newer, true)).toBeNull();
      expect(lifecycleAfterLoad(older, newer, true)).toEqual(older);
    });
    it('settleLifecycleAfterLoad puts the merged row in place, or removes it', () => {
      const sql = fresh();
      writeLifecycle(sql, newer); // what the dump brought
      settleLifecycleAfterLoad(sql, older, false);
      expect(readLifecycle(sql)).toEqual(newer);
      writeLifecycle(sql, newer);
      settleLifecycleAfterLoad(sql, null, true); // a copy with no row of its own
      expect(sql.all('SELECT * FROM _substrat_meta')).toEqual([]);
    });
  });

  it('lifecycleReceipt is the statuses, never the read time', () => {
    expect(lifecycleReceipt(life('suspended', 'active', 1))).toBe('suspended/active');
    expect(lifecycleReceipt(life('suspended', 'active', 1))).toBe(lifecycleReceipt(life('suspended', 'active', 9)));
  });
});
