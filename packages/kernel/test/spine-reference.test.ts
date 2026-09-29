import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { assertNoSpineReference, assertNoSpineWrite, guardSpine, type ScopedSql } from '../src/index.js';

/**
 * #1898, the module half: a foreign key from a module's table to the spine makes the
 * kernel's own writes to that spine table fail on the module's rows (a revoke, a restore's
 * re-point, an outbox prune). `ctx.sql` refuses it through `assertNoSpineWrite`, and the
 * adapters call `assertNoSpineReference` on every migration, which runs on the kernel's own
 * handle. The grammar is `referencedTables`, the one the dump check reads with.
 */
describe('a REFERENCES clause naming the spine', () => {
  const refused = [
    'CREATE TABLE notes (t TEXT REFERENCES _substrat_tuples(subject))',
    'CREATE TABLE IF NOT EXISTS notes (t TEXT, FOREIGN KEY (t) REFERENCES "_Substrat_Outbox" (id))',
    'ALTER TABLE notes ADD COLUMN t TEXT REFERENCES _substrat_tuples(subject)',
    'CREATE TABLE notes (t TEXT REFERENCES/**/_substrat_tuples(subject))',
    // Behind a legitimate statement in the same migration.
    'CREATE TABLE lists (id TEXT PRIMARY KEY);\nCREATE TABLE notes (t TEXT REFERENCES [_SUBSTRAT_TUPLES](subject));',
  ];
  for (const sql of refused) {
    it(`refuses ${JSON.stringify(sql)} from a migration and from ctx.sql`, () => {
      expect(() => assertNoSpineReference(sql, 'migration m@0001')).toThrow(/migration m@0001 cannot declare a foreign key to the platform spine/);
      expect(() => assertNoSpineWrite(sql)).toThrow(/ctx\.sql cannot declare a foreign key to the platform spine/);
    });
  }

  it('answers the taxonomy as a forbidden spine_write', () => {
    try {
      assertNoSpineReference(refused[0]!, 'migration m@0001');
      throw new Error('not refused');
    } catch (err) {
      expect(errorCodeOf(err)).toBe('forbidden');
      expect((err as { extensions: Record<string, unknown> }).extensions.reason).toBe('spine_write');
    }
  });

  // The twins: a module's foreign keys to its own tables, and reads of the spine, still run.
  const accepted = [
    'CREATE TABLE notes (id TEXT PRIMARY KEY, list_id TEXT REFERENCES lists(id))',
    'CREATE TABLE notes (t TEXT, FOREIGN KEY (t) REFERENCES "lists" (id) ON DELETE CASCADE)',
    "CREATE TABLE notes (t TEXT DEFAULT 'REFERENCES _substrat_tuples')",
    'INSERT INTO my_timeline SELECT id FROM _substrat_outbox',
  ];
  for (const sql of accepted) {
    it(`accepts ${JSON.stringify(sql)}`, () => {
      expect(() => assertNoSpineReference(sql, 'migration m@0001')).not.toThrow();
      expect(() => assertNoSpineWrite(sql)).not.toThrow();
    });
  }

  it('guardSpine refuses it before the statement reaches the connection', () => {
    const seen: string[] = [];
    const inner: ScopedSql = {
      query: () => [],
      exec: (sql) => {
        seen.push(sql);
        return { changes: 0 };
      },
    };
    const guarded = guardSpine(inner);
    expect(() => guarded.exec(refused[0]!)).toThrow(/foreign key to the platform spine/);
    guarded.exec(accepted[0]!);
    expect(seen).toEqual([accepted[0]]);
  });
});
