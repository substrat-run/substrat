import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventId } from '@substrat-run/contracts';
import { walkEventCause, type ScopedSql } from '../src/index.js';

/**
 * The causal walk (#1237), against a REAL outbox.
 *
 * A hand-rolled fake `query` would test the fake: the walk is a SQL read, and what
 * it reads has to come back through SQLite's own types and nullability or the test
 * agrees with the test rather than with the column. `node:sqlite` in memory, the same
 * move `tools/spine-ddl-drift.mjs` makes.
 *
 * Three of the five terminals cannot be reached through a host at all any more, which
 * is exactly why they are pinned here. `unrecorded` needs a row with no cause AND no
 * operation — a pre-#1237 consumer emit, which nothing can create now that causes are
 * recorded, and which `ctx.sql` rightly refuses to forge. `missing` needs a cause
 * naming an absent event, and `cycle` a cause younger than its effect — neither of
 * which an append-only spine with monotonic ids can produce.
 */

// The columns the walk reads. Kept to those, deliberately: if `HISTORY_COLUMNS` grows
// a column this table lacks, the SELECT fails loudly here instead of the walk quietly
// learning to tolerate a partial row.
const DDL = `
  CREATE TABLE _substrat_outbox (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT,
    authorization TEXT,
    impersonation TEXT,
    pii_class TEXT NOT NULL,
    subject_id TEXT,
    operation TEXT,
    version TEXT,
    caused_by TEXT
  )`;

/** A ULID-shaped id, since `eventId` is branded and the walk binds it as one. */
const id = (n: number) => eventId.parse(`01J${String(n).padStart(23, '0')}`);

interface Row {
  n: number;
  operation?: string | null;
  causedBy?: number | null;
}

function readerOver(rows: Row[]): { sql: Pick<ScopedSql, 'query'>; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const insert = db.prepare(
    `INSERT INTO _substrat_outbox
       (id, type, occurred_at, actor, payload, pii_class, operation, caused_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      id(r.n),
      `test.step${r.n}`,
      `2026-05-0${r.n}T00:00:00.000Z`,
      JSON.stringify('01JPRINCIPAL0000000000000'),
      JSON.stringify({ n: r.n }),
      'none',
      r.operation ?? null,
      r.causedBy === undefined || r.causedBy === null ? null : id(r.causedBy),
    );
  }
  return {
    sql: {
      query: (<T>(sql: string, params?: unknown[]) =>
        db.prepare(sql).all(...((params ?? []) as never[])) as T[]) as ScopedSql['query'],
    },
    db,
  };
}

describe('walkEventCause (#1237)', () => {
  it('walks back to the operation that started the chain', () => {
    // 3 ← 2 ← 1, where 1 was emitted by an operation and the other two by consumers.
    const { sql } = readerOver([
      { n: 1, operation: 'billing/close-period' },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 2 },
    ]);
    const result = walkEventCause({ sql }, id(3));
    expect(result.chain.map((e) => e.type)).toEqual(['test.step3', 'test.step2', 'test.step1']);
    // COMPLETE: the first event names its invocation, so the walk reached the start.
    expect(result.terminal).toBe('operation');
    expect(result.chain.at(-1)!.operation).toBe('billing/close-period');
  });

  it('says UNRECORDED, not complete, when the trail predates cause recording', () => {
    // The load-bearing case. A consumer emit records no operation, so an old row with
    // neither field is a chain that was CUT, not one that ended. Reporting `operation`
    // here would tell a reader a consumer began a chain it only continued.
    const { sql } = readerOver([{ n: 1 }, { n: 2, causedBy: 1 }]);
    const result = walkEventCause({ sql }, id(2));
    expect(result.chain).toHaveLength(2);
    expect(result.terminal).toBe('unrecorded');
  });

  it('keeps the two null-cause endings apart on the very first event', () => {
    // No walking involved — the distinction has to hold for a chain of one, which is
    // what a reader sees when they ask "why" of an event nothing caused.
    const direct = readerOver([{ n: 1, operation: 'billing/close-period' }]);
    expect(walkEventCause({ sql: direct.sql }, id(1)).terminal).toBe('operation');

    const legacy = readerOver([{ n: 1 }]);
    expect(walkEventCause({ sql: legacy.sql }, id(1)).terminal).toBe('unrecorded');
  });

  it('reports the cap rather than trimming the chain silently', () => {
    const { sql } = readerOver([
      { n: 1, operation: 'op' },
      { n: 2, causedBy: 1 },
      { n: 3, causedBy: 2 },
      { n: 4, causedBy: 3 },
    ]);
    const result = walkEventCause({ sql }, id(4), 2);
    expect(result.chain).toHaveLength(2);
    // A cut chain that claimed to be complete is the whole failure mode here.
    expect(result.terminal).toBe('depth');
  });

  it('reports MISSING when a cause names an event the outbox does not hold', () => {
    // Should be impossible on an append-only spine, which is why it is reported
    // rather than smoothed over: stopping quietly would look exactly like a
    // complete chain, and this is a reader's only signal that the spine lost a row.
    const { sql } = readerOver([{ n: 2, causedBy: 1 }]);
    const result = walkEventCause({ sql }, id(2));
    expect(result.chain).toHaveLength(1);
    expect(result.terminal).toBe('missing');
  });

  it('reports MISSING for an event this scope never had', () => {
    const { sql } = readerOver([{ n: 1, operation: 'op' }]);
    const result = walkEventCause({ sql }, id(9));
    expect(result.chain).toEqual([]);
    expect(result.terminal).toBe('missing');
  });

  it('reports a cycle as CYCLE, not as the depth cap, and does not hang on it', () => {
    // Unreachable by construction — ids are monotonic and a cause is always older —
    // but a read on the audit spine must not be ABLE to spin, and the guard costs a
    // Set. Its own terminal, because `depth` promises more chain above and a cycle
    // has none: a corrupted spine must read as an integrity failure, not a long story.
    const { sql } = readerOver([
      { n: 1, causedBy: 2 },
      { n: 2, causedBy: 1 },
    ]);
    const result = walkEventCause({ sql }, id(1));
    expect(result.terminal).toBe('cycle');
    expect(result.chain.length).toBeLessThanOrEqual(2);
    // Well inside the cap, so the two cannot be confused by the chain's length either.
    expect(walkEventCause({ sql }, id(1), 10).terminal).toBe('cycle');
  });

  it('decodes each step as history, not as raw columns', () => {
    // The walk returns HistoryEntry, so the payload is decoded and the actor is the
    // union the column encodes — a caller should never re-parse either.
    const { sql } = readerOver([{ n: 1, operation: 'op' }]);
    const [entry] = walkEventCause({ sql }, id(1)).chain;
    expect(entry!.payload).toEqual({ n: 1 });
    expect(entry!.actor).toBe('01JPRINCIPAL0000000000000');
    // And the nulls stay facts rather than becoming absent keys.
    expect(entry!.authorization).toBeNull();
    expect(entry!.impersonation).toBeNull();
    expect(entry!.causedBy).toBeNull();
  });
});
