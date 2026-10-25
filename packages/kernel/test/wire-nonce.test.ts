/** RFC wire-signing §4: the nonce store's one claim, against a real SQLite. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { SwitchSql } from '../src/system-switch.js';
import { WIRE_NONCE_DDL, WIRE_NONCE_PURGE_BATCH, claimWireNonceIn, isWireNonceWrite } from '../src/wire-nonce.js';

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
const counted = (db: DatabaseSync) => (db.prepare(`SELECT live FROM _substrat_wire_nonce_count`).get() as { live: number }).live;

describe('claimWireNonceIn', () => {
  it('answers true once for a nonce, then false while it is held', () => {
    const { sql } = store();
    expect(claimWireNonceIn(sql, nonce(1), 200, 100)).toBe(true);
    expect(claimWireNonceIn(sql, nonce(1), 200, 101)).toBe(false);
  });

  it('answers false for a claim made after `until`, and records nothing; at `until` it is in time', () => {
    const { db, sql } = store();
    expect(claimWireNonceIn(sql, nonce(1), 100, 101)).toBe(false);
    expect(rows(db)).toBe(0);
    expect(claimWireNonceIn(sql, nonce(1), 100, 100)).toBe(true);
  });

  it('keeps a nonce through its last second, so it is still a replay then', () => {
    const { sql } = store();
    claimWireNonceIn(sql, nonce(1), 150, 100);
    expect(claimWireNonceIn(sql, nonce(1), 150, 150)).toBe(false);
  });

  it('purges at most a batch of expired rows per claim, and keeps the count in step', () => {
    const { db, sql } = store();
    for (let i = 0; i < WIRE_NONCE_PURGE_BATCH + 5; i++) claimWireNonceIn(sql, nonce(1000 + i), 10, 5);
    claimWireNonceIn(sql, nonce(1), 500, 100);
    expect(rows(db)).toBe(5 + 1);
    expect(counted(db)).toBe(6);
  });

  it('the cap: claims up to it are admitted, the next is full, and expiry frees it', () => {
    const { sql } = store();
    const cap = 3;
    for (let i = 1; i <= cap; i++) expect(claimWireNonceIn(sql, nonce(i), 200, 100, cap)).toBe(true);
    expect(claimWireNonceIn(sql, nonce(9), 500, 150, cap)).toBe('full');
    // Once the window has passed, the purge runs before the cap is judged.
    expect(claimWireNonceIn(sql, nonce(9), 500, 201, cap)).toBe(true);
  });

  it('refuses a nonce or a time that is not one before writing anything', () => {
    const { sql, writes } = store();
    for (const bad of ['', `${nonce(1).slice(0, 21)}B`, `${nonce(1)}A`]) expect(() => claimWireNonceIn(sql, bad, 200, 100)).toThrow(TypeError);
    for (const t of [-1, 1.5, Number.NaN]) expect(() => claimWireNonceIn(sql, nonce(1), t, 100)).toThrow(TypeError);
    expect(() => claimWireNonceIn(sql, nonce(1), 200, Number.NaN)).toThrow(TypeError);
    expect(writes).toEqual([]);
  });

  it('writes only the statements isWireNonceWrite admits, and it admits no other', () => {
    const { sql, writes } = store();
    claimWireNonceIn(sql, nonce(1), 200, 100);
    claimWireNonceIn(sql, nonce(2), 200, 300);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(isWireNonceWrite(w)).toBe(true);
    expect(isWireNonceWrite('DELETE FROM _substrat_wire_nonces')).toBe(false);
  });
});
