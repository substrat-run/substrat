/** RFC wire-signing §4: the nonce store's one claim, against a real SQLite. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { SwitchSql } from '../src/system-switch.js';
import {
  WIRE_NONCE_CAP,
  WIRE_NONCE_DDL,
  WIRE_NONCE_PURGE_BATCH,
  WIRE_NONCE_TABLE_NAMES,
  claimWireNonceIn,
  isWireNonceTable,
  isWireNonceWrite,
} from '../src/wire-nonce.js';

function store(): { db: DatabaseSync; sql: SwitchSql; writes: string[] } {
  const db = new DatabaseSync(':memory:');
  db.exec(WIRE_NONCE_DDL);
  const writes: string[] = [];
  const sql: SwitchSql = {
    all: (q, ...p) => {
      if (!/^\s*SELECT/i.test(q)) writes.push(q);
      return db.prepare(q).all(...p) as Record<string, unknown>[];
    },
    run: (q, ...p) => {
      writes.push(q);
      db.prepare(q).run(...p);
    },
  };
  return { db, sql, writes };
}

/** A canonical 22-character nonce, distinct per `i`. */
const nonce = (i: number) => `${i.toString(36).padStart(21, 'a')}A`;
const rows = (db: DatabaseSync) => Number((db.prepare('SELECT COUNT(*) AS n FROM _substrat_wire_nonces').get() as { n: number }).n);
const counted = (db: DatabaseSync) =>
  (db.prepare(`SELECT live FROM _substrat_wire_nonce_count WHERE slot = 'live'`).get() as { live: number } | undefined)?.live;

describe('claimWireNonceIn', () => {
  it('answers true once for a nonce, then false while it is held', () => {
    const { db, sql } = store();
    expect(claimWireNonceIn(sql, nonce(1), 200, 100)).toBe(true);
    expect(claimWireNonceIn(sql, nonce(1), 200, 101)).toBe(false);
    expect(claimWireNonceIn(sql, nonce(2), 200, 101)).toBe(true);
    expect(rows(db)).toBe(2);
    expect(counted(db)).toBe(2);
  });

  it('answers false for a claim made after `until`, and records nothing', () => {
    const { db, sql } = store();
    expect(claimWireNonceIn(sql, nonce(1), 100, 101)).toBe(false);
    expect(rows(db)).toBe(0);
    // At `until` itself it is still in time.
    expect(claimWireNonceIn(sql, nonce(1), 100, 100)).toBe(true);
  });

  it('forgets a nonce only once its window has passed, so a held one is never purged early', () => {
    const { db, sql } = store();
    claimWireNonceIn(sql, nonce(1), 150, 100);
    claimWireNonceIn(sql, nonce(2), 300, 100);
    // At 150 the first is still held (purged only when until < now).
    claimWireNonceIn(sql, nonce(3), 400, 150);
    expect(rows(db)).toBe(3);
    claimWireNonceIn(sql, nonce(4), 400, 151);
    const left = (db.prepare('SELECT nonce FROM _substrat_wire_nonces ORDER BY nonce').all() as { nonce: string }[]).map((r) => r.nonce);
    expect(left).toEqual([nonce(2), nonce(3), nonce(4)].sort());
    expect(counted(db)).toBe(3);
  });

  it('purges at most a batch per claim, and keeps the count in step', () => {
    const { db, sql } = store();
    const insert = db.prepare('INSERT INTO _substrat_wire_nonces (nonce, until_s) VALUES (?, ?)');
    for (let i = 0; i < WIRE_NONCE_PURGE_BATCH * 2 + 5; i++) insert.run(nonce(1000 + i), 10);
    expect(claimWireNonceIn(sql, nonce(1), 500, 100)).toBe(true);
    // The store from before the count row is counted once, then one batch goes and one row comes.
    expect(rows(db)).toBe(WIRE_NONCE_PURGE_BATCH + 5 + 1);
    expect(counted(db)).toBe(rows(db));
    claimWireNonceIn(sql, nonce(2), 500, 100);
    claimWireNonceIn(sql, nonce(3), 500, 100);
    expect(rows(db)).toBe(3);
    expect(counted(db)).toBe(3);
  });

  describe('the cap', () => {
    const cap = 3;
    it('admits a claim at cap - 1 live rows, answers full at cap, and stays full past it', () => {
      const { db, sql } = store();
      expect(claimWireNonceIn(sql, nonce(1), 500, 100, cap)).toBe(true);
      expect(claimWireNonceIn(sql, nonce(2), 500, 100, cap)).toBe(true);
      // cap - 1 rows live: the third is admitted.
      expect(claimWireNonceIn(sql, nonce(3), 500, 100, cap)).toBe(true);
      // cap rows live: full, and nothing is written.
      expect(claimWireNonceIn(sql, nonce(4), 500, 100, cap)).toBe('full');
      // A store somehow past the cap (cap + 1, filled by hand) is full too, never admitted.
      db.prepare('INSERT INTO _substrat_wire_nonces (nonce, until_s) VALUES (?, ?)').run(nonce(5), 500);
      db.prepare(`UPDATE _substrat_wire_nonce_count SET live = 4`).run();
      expect(claimWireNonceIn(sql, nonce(6), 500, 100, cap)).toBe('full');
      expect(rows(db)).toBe(cap + 1);
    });

    it('at the cap a spent nonce is refused as well, never admitted', () => {
      const { sql } = store();
      for (let i = 1; i <= cap; i++) claimWireNonceIn(sql, nonce(i), 500, 100, cap);
      expect(claimWireNonceIn(sql, nonce(1), 500, 100, cap)).toBe('full');
    });

    it('frees capacity once the window has passed: the purge runs before the cap is judged', () => {
      const { db, sql } = store();
      for (let i = 1; i <= cap; i++) claimWireNonceIn(sql, nonce(i), 200, 100, cap);
      expect(claimWireNonceIn(sql, nonce(9), 500, 150, cap)).toBe('full');
      expect(claimWireNonceIn(sql, nonce(9), 500, 201, cap)).toBe(true);
      expect(rows(db)).toBe(1);
      expect(counted(db)).toBe(1);
    });

    it('is sized as its comment says: the object ceiling over the longest life, ten times the platform peak', () => {
      const longestLife = 120 + 30 + 30;
      expect(WIRE_NONCE_CAP).toBe(1_000 * longestLife);
      expect(WIRE_NONCE_CAP).toBe(10 * 100 * longestLife);
    });
  });

  it('refuses a nonce or a time that is not one before writing anything', () => {
    const { db, sql, writes } = store();
    for (const bad of ['', 'short', `${nonce(1).slice(0, 21)}B`, `${nonce(1)}A`, 'a'.repeat(21) + '=']) {
      expect(() => claimWireNonceIn(sql, bad, 200, 100)).toThrow(TypeError);
    }
    for (const t of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => claimWireNonceIn(sql, nonce(1), t, 100)).toThrow(TypeError);
      expect(() => claimWireNonceIn(sql, nonce(1), 200, t)).toThrow(TypeError);
    }
    expect(writes).toEqual([]);
    expect(rows(db)).toBe(0);
  });

  it('writes only the statements isWireNonceWrite admits', () => {
    const { sql, writes } = store();
    claimWireNonceIn(sql, nonce(1), 200, 100);
    claimWireNonceIn(sql, nonce(1), 200, 100);
    claimWireNonceIn(sql, nonce(2), 50, 100);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isWireNonceWrite(w)).toBe(true);
    expect(isWireNonceWrite(`  ${writes[0]!.replace(/ /g, '\n ')} `)).toBe(true);
    expect(isWireNonceWrite('DELETE FROM _substrat_wire_nonces')).toBe(false);
    expect(isWireNonceWrite("INSERT INTO _substrat_meta (key, value) VALUES ('write_revision', '1')")).toBe(false);
  });
});

describe('the store is store-local', () => {
  it('names its tables, which a dump leaves out', () => {
    for (const name of WIRE_NONCE_TABLE_NAMES) {
      expect(isWireNonceTable(name)).toBe(true);
      expect(isWireNonceTable(name.toUpperCase())).toBe(true);
    }
    expect(isWireNonceTable('_substrat_meta')).toBe(false);
    expect(isWireNonceTable('_substrat_wire_nonces_until')).toBe(false);
  });
});
