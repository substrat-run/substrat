// `node:sqlite`, as facet-events.test.ts: the kernel declares no better-sqlite3.
//
// #2166: the host's read of the updated stamps, unit by unit — what it reads and when it reads
// nothing. The adapters' own suites (`updatedStampsContractSuite`) hold the whole behaviour on
// each one's real spine; this pins the parts a suite cannot see: the reads themselves.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITY_ARCHIVED, errorCodeOf, principalId, type UpdatedStampDeclaration } from '@substrat-run/contracts';
import { addUpdatedStampPlans, watchUpdatedStamps, type UpdatedStampPlan } from '../src/entity-stamps.js';
import type { SqlValue } from '../src/scope-host.js';

const NOW = '2026-10-11T10:00:00.000Z';
const ME = principalId.parse('01JAAAAAAAAAAAAAAAAAAAAAAA');
const ctx = { now: () => NOW, principal: ME };

const DOC: UpdatedStampDeclaration = { entityType: 'doc', table: 'docs', idColumn: 'id', at: 'updated_at', by: 'updated_by' };

function scope(): { db: DatabaseSync; reads: string[]; sql: { query<T>(q: string, p?: readonly SqlValue[]): T[] } } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE _substrat_outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL);
           CREATE TABLE docs (id TEXT PRIMARY KEY, updated_at TEXT, updated_by TEXT);`);
  const reads: string[] = [];
  return {
    db,
    reads,
    sql: {
      query: <T>(q: string, p: readonly SqlValue[] = []) => {
        reads.push(q);
        return db.prepare(q).all(...(p as never[])) as T[];
      },
    },
  };
}

const plansOf = (...declarations: UpdatedStampDeclaration[]): Map<string, UpdatedStampPlan> => {
  const plans = new Map<string, UpdatedStampPlan>();
  addUpdatedStampPlans(plans, '@test/m', declarations);
  return plans;
};

let n = 0;
const emit = (db: DatabaseSync, entityType: string, entityId: string, type = 'doc.touched') =>
  db.prepare('INSERT INTO _substrat_outbox (id, type, entity_type, entity_id) VALUES (?, ?, ?, ?)').run(String(++n).padStart(6, '0'), type, entityType, entityId);
const write = (db: DatabaseSync, id: string, at: string, by: string) =>
  db.prepare('INSERT INTO docs (id, updated_at, updated_by) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(id, at, by);
const refused = (f: () => void): string | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    return errorCodeOf(e);
  }
};

describe('watchUpdatedStamps (#2166)', () => {
  it('reads nothing at all, before or after, when no entity declares the pair', () => {
    const s = scope();
    expect(watchUpdatedStamps(s.sql, new Map())).toBeUndefined();
    expect(s.reads).toEqual([]);
  });

  it('reads only the mark before, and only the outbox after when nothing stamped was emitted about', () => {
    const s = scope();
    const watch = watchUpdatedStamps(s.sql, plansOf(DOC))!;
    expect(s.reads).toHaveLength(1);
    emit(s.db, 'plain', 'p1');
    watch.assertHeld(ctx, 'op');
    // The mark and the outbox — no read of any entity's table.
    expect(s.reads).toHaveLength(2);
    expect(s.reads.some((q) => q.includes('docs'))).toBe(false);
  });

  it('holds only what was emitted after the mark: an older stale row is not this call’s', () => {
    const s = scope();
    write(s.db, 'old', '2000-01-01T00:00:00.000Z', 'someone');
    emit(s.db, 'doc', 'old');
    const watch = watchUpdatedStamps(s.sql, plansOf(DOC))!;
    write(s.db, 'd1', NOW, ME);
    emit(s.db, 'doc', 'd1');
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBeUndefined();
  });

  it.each([
    ['a stale time', '2000-01-01T00:00:00.000Z', ME],
    ['another principal', NOW, 'someone-else'],
    ['no time at all', null, ME],
  ])('refuses %s, internal', (_, at, by) => {
    const s = scope();
    const watch = watchUpdatedStamps(s.sql, plansOf(DOC))!;
    s.db.prepare('INSERT INTO docs (id, updated_at, updated_by) VALUES (?, ?, ?)').run('d1', at, by);
    emit(s.db, 'doc', 'd1');
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBe('internal');
  });

  it('skips a row that is gone, and a kernel-authored event about a stale row', () => {
    const s = scope();
    write(s.db, 'filed', '2000-01-01T00:00:00.000Z', 'someone');
    const watch = watchUpdatedStamps(s.sql, plansOf(DOC))!;
    emit(s.db, 'doc', 'deleted');
    emit(s.db, 'doc', 'filed', ENTITY_ARCHIVED);
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBeUndefined();
    // Its positive twin: the same stale row named by a module event is refused.
    emit(s.db, 'doc', 'filed');
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBe('internal');
  });

  it('holds only the declared half: an entity stamping `at` alone is not asked for a principal', () => {
    const s = scope();
    const { by: _by, ...atOnly } = DOC;
    const watch = watchUpdatedStamps(s.sql, plansOf(atOnly))!;
    write(s.db, 'd1', NOW, 'someone-else');
    emit(s.db, 'doc', 'd1');
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBeUndefined();
  });

  it('reads the rows in chunks under the 100-parameter limit, and finds a stale one in a later chunk', () => {
    const s = scope();
    const watch = watchUpdatedStamps(s.sql, plansOf(DOC))!;
    for (let i = 0; i < 200; i++) {
      write(s.db, `d${i}`, i === 199 ? '2000-01-01T00:00:00.000Z' : NOW, ME);
      emit(s.db, 'doc', `d${i}`);
    }
    expect(refused(() => watch.assertHeld(ctx, 'op'))).toBe('internal');
    const rowReads = s.reads.filter((q) => q.includes('FROM "docs"'));
    expect(rowReads).toHaveLength(3);
    for (const q of rowReads) expect((q.match(/\?/g) ?? []).length).toBeLessThanOrEqual(90);
  });

  it('one owner per entity type', () => {
    const plans = plansOf(DOC);
    expect(() => addUpdatedStampPlans(plans, '@test/other', [DOC])).toThrow(
      "updated stamps: 'doc' is stamped by both '@test/m' and '@test/other' — one entity type, one owner",
    );
  });
});
