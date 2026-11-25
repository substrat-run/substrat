import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { EntityErasure } from '@substrat-run/contracts';
import { readSubjectPage, type ModuleErasurePlan } from '@substrat-run/kernel';

/**
 * `readSubjectPage`'s record paging (#3303) against a real table, for the two shapes the contract
 * suite's module does not have: a composite primary key (the row-value seek) and a manifest derived
 * before the erasure declaration carried the key (the offset fallback, which the page must name).
 * The walk starts at the records cursor `r:0:0`, so no outbox is needed.
 */
describe('subject access record paging (#3303)', () => {
  const WHO = '01JZ000000000000000000SUBJ';

  const fixture = (primaryKey?: string[]) => {
    const db = new Database(':memory:');
    // Inserted out of key order, so scan order and key order differ.
    db.exec(`CREATE TABLE visits (day TEXT NOT NULL, seq INTEGER NOT NULL, guest TEXT, note TEXT, PRIMARY KEY (day, seq));
      INSERT INTO visits VALUES ('2026-02-01', 1, '${WHO}', 'c'), ('2026-01-01', 2, '${WHO}', 'b'), ('2026-01-01', 1, '${WHO}', 'a'),
        ('2026-01-01', 3, 'someone-else', 'x');`);
    const entity: EntityErasure = {
      entityType: 'visit',
      table: 'visits',
      mode: 'blank',
      subjects: ['guest'],
      ...(primaryKey ? { primaryKey } : {}),
      fields: [{ name: 'note', blank: null }],
    };
    const plans: ModuleErasurePlan[] = [
      { moduleId: '@test/visits', declaration: { tables: ['visits'], entities: [entity] }, ownTables: new Set(['visits']) },
    ];
    const sql = { query: <T>(q: string, params: readonly unknown[] = []) => db.prepare(q).all(...params) as T[] };
    return { db, read: (cursor: string, limit?: number) => readSubjectPage({ sql, plans, subjectId: WHO, page: { cursor, ...(limit ? { limit } : {}) } }) };
  };

  const walk = (primaryKey?: string[]) => {
    const { db, read } = fixture(primaryKey);
    const notes: unknown[] = [];
    const paging = new Set<string | undefined>();
    let cursor: string | null = 'r:0:0';
    let first = true;
    while (cursor) {
      const page = read(cursor, 1);
      for (const r of page.records) {
        paging.add(r.paging);
        notes.push(...r.rows.map((row) => row.note));
      }
      if (first) {
        // A write between pages, behind the first row in key order: a key walk resumes past it.
        db.prepare('INSERT INTO visits VALUES (?, ?, ?, ?)').run('2025-12-31', 1, WHO, 'behind');
        first = false;
      }
      cursor = page.nextCursor;
    }
    return { notes, paging: [...paging] };
  };

  it('seeks a composite key in key order, past a row written behind the cursor', () => {
    expect(walk(['day', 'seq'])).toEqual({ notes: ['a', 'b', 'c'], paging: ['key'] });
  });

  it('falls back to offset paging without a declared key, and says so', () => {
    const { notes, paging } = walk();
    expect(paging).toEqual(['offset']);
    expect(notes).toHaveLength(4);
  });

  it('refuses a key cursor that does not fit the entity', () => {
    const { read } = fixture(['day', 'seq']);
    const encode = (text: string) => `r:0:k:${Buffer.from(text).toString('base64url')}`;
    for (const cursor of [encode('["2026-01-01"]'), encode('not json'), encode('[{}]')]) {
      expect(() => read(cursor)).toThrow(/not a cursor/);
    }
  });
});
