// `node:sqlite` needs Node >= 22.13. The CI LIKE/GLOB pattern-limit shim patches
// better-sqlite3 connections only, so it does not apply here — harmless, since the facet
// read uses no LIKE or GLOB.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { facetEvents, type ScopedSql } from '../src/index.js';

/**
 * The payload facet's personal-data rule (#1762), against a real SQLite outbox.
 *
 * The contract suite holds the classes an `emit` can write, on both adapters. What it
 * cannot reach is the fail-closed half: a `pii_class` that is NULL or a value no emit
 * writes. The adapters' outbox refuses NULL (`NOT NULL`), so this table deliberately
 * drops that constraint — an old or hand-restored row is exactly where a fail-open
 * predicate would leak, and it is the case nothing else can construct.
 */
const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    operation TEXT,
    version TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT,
    pii_class TEXT,
    invocation_id TEXT
  )`;

interface Row {
  pii: string | null;
  /** `undefined` = payload NULL (shredded, or never written). */
  email?: string;
}

function readerOver(rows: Row[]): Pick<ScopedSql, 'query'> {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const ins = db.prepare(
    `INSERT INTO _substrat_outbox (id, type, occurred_at, actor, entity_type, entity_id, payload, pii_class)
     VALUES (?, 'lead.created', ?, '"a"', 'lead', ?, ?, ?)`,
  );
  rows.forEach((r, n) =>
    ins.run(
      `e${n}`,
      `2026-09-26T00:00:${String(n).padStart(2, '0')}.000Z`,
      `lead-${n}`,
      r.email === undefined ? null : JSON.stringify({ email: r.email }),
      r.pii,
    ),
  );
  return {
    query: (<T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
  };
}

const byEmail = { groupBy: { kind: 'payload' as const, field: 'email' } };

describe('facetEvents: a payload grouping withholds personal data (#1762)', () => {
  it('groups only events classed none, and counts every other class apart', () => {
    const sql = readerOver([
      { pii: 'none', email: 'ops@acme.test' },
      { pii: 'none', email: 'ops@acme.test' },
      { pii: 'pseudonymous', email: 'anna@acme.test' },
      { pii: 'direct', email: 'bo@acme.test' },
      { pii: 'direct' }, // shredded
    ]);
    const r = facetEvents({ sql }, byEmail);
    expect(r.buckets).toEqual([{ value: 'ops@acme.test', count: 2, lastSeen: '2026-09-26T00:00:01.000Z' }]);
    expect(r.withheldPersonal).toBe(2);
    expect(r.erased).toBe(1);
    expect(r.total).toBe(5);
  });

  it('fails closed: a NULL or unrecognised class is withheld, never grouped', () => {
    const sql = readerOver([
      { pii: null, email: 'anna@acme.test' },
      { pii: 'Direct', email: 'bo@acme.test' },
      { pii: 'sensitive', email: 'cy@acme.test' },
      { pii: 'none', email: 'ops@acme.test' },
    ]);
    const r = facetEvents({ sql }, byEmail);
    expect(r.buckets.map((b) => b.value)).toEqual(['ops@acme.test']);
    expect(r.withheldPersonal).toBe(3);
    expect(r.erased).toBe(0);
  });

  it('a NULL class with no payload is counted, not dropped from every total', () => {
    // Before #1762 the erased predicate was `!= 'none'`, which is NULL for a NULL class:
    // the row matched neither the erased count nor the grouped rows and vanished.
    const sql = readerOver([{ pii: null }, { pii: 'none', email: 'ops@acme.test' }]);
    const r = facetEvents({ sql }, byEmail);
    expect(r.erased).toBe(1);
    expect(r.buckets.reduce((n, b) => n + b.count, 0) + r.erased + r.withheldPersonal).toBe(r.total);
  });

  it('partitions total: grouped + erased + withheld, under a type filter too', () => {
    const sql = readerOver([
      { pii: 'none', email: 'x@acme.test' },
      { pii: 'none' }, // payload-less, classed none: an extraction-null bucket, not erased
      { pii: 'pseudonymous', email: 'y@acme.test' },
      { pii: 'direct' },
      { pii: null, email: 'z@acme.test' },
    ]);
    const r = facetEvents({ sql }, { ...byEmail, type: 'lead.created' });
    expect(r.buckets.find((b) => b.value === null)?.count).toBe(1);
    expect([r.erased, r.withheldPersonal, r.total]).toEqual([1, 2, 5]);
    expect(r.buckets.reduce((n, b) => n + b.count, 0) + r.erased + r.withheldPersonal).toBe(r.total);
  });

  it('leaves an envelope grouping alone: every class is counted, nothing withheld', () => {
    const sql = readerOver([
      { pii: 'none', email: 'a@acme.test' },
      { pii: 'direct', email: 'b@acme.test' },
      { pii: 'direct' },
    ]);
    const r = facetEvents({ sql }, { groupBy: { kind: 'piiClass' } });
    expect(r.buckets.map((b) => [b.value, b.count])).toEqual([
      ['direct', 2],
      ['none', 1],
    ]);
    expect([r.erased, r.withheldPersonal, r.total]).toEqual([0, 0, 3]);
  });
});
