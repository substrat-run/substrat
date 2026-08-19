/**
 * Does the emitter reproduce the hand-written journal?
 *
 * This is the check that decides whether migrations can be DERIVED. The
 * registry and the journal are two descriptions of one schema
 * (`entities.test.ts` holds them to each other); if the emitter can produce the
 * journal's columns from the registry, the journal stops needing to be written.
 *
 * Compared by COLUMN SET, not by string: the hand-written DDL has its own
 * whitespace, column order and a `REFERENCES` clause the emitter places
 * differently. What must agree is what the database ends up with.
 *
 * **And by PRIMARY KEY.** Columns alone are not what the database ends up with:
 * a production vertical's parity check compared names, types and nullability
 * across 63 tables and reported 63/63 while 15 of the emitted tables had no
 * primary key at all (#804). A check that cannot fail on that is not a parity
 * check.
 */
import { describe, expect, it } from 'vitest';
import { emitTables, journalColumns, journalPrimaryKeys } from '@substrat-run/model-emit';
import { calloutEntities } from '../src/entities.js';
import { calloutMigrations } from '../src/migrations.js';

const journalSql = calloutMigrations.map((m) => m.sql).join('\n');
const emittedSql = emitTables(calloutEntities);
const handWritten = journalColumns(journalSql);
const emitted = journalColumns(emittedSql);
const handWrittenKeys = journalPrimaryKeys(journalSql);
const emittedKeys = journalPrimaryKeys(emittedSql);

describe('emitted DDL vs the hand-written journal', () => {
  it('parsed both sides', () => {
    expect(handWritten.size).toBeGreaterThan(0);
    expect(emitted.size).toBe(Object.keys(calloutEntities).length);
  });

  for (const [name, entity] of Object.entries(calloutEntities)) {
    it(`${name} → ${entity.table}: same columns`, () => {
      expect([...(emitted.get(entity.table) ?? [])].sort()).toEqual(
        [...(handWritten.get(entity.table) ?? [])].sort(),
      );
    });

    it(`${name} → ${entity.table}: same primary key`, () => {
      // Non-empty on both sides: two tables agreeing that neither has a key is
      // the failure this check exists to catch, not a pass.
      expect(emittedKeys.get(entity.table) ?? []).not.toEqual([]);
      expect(emittedKeys.get(entity.table)).toEqual(handWrittenKeys.get(entity.table));
    });
  }

  it('closes the NULL-primary-key hole the hand-written schema has', () => {
    // In SQLite `id TEXT PRIMARY KEY` accepts a NULL id — a non-INTEGER primary
    // key does not imply NOT NULL. The hand-written journal has that hole in
    // every table; the emitter cannot produce it.
    expect(calloutMigrations.map((m) => m.sql).join('\n')).toMatch(/id\s+TEXT PRIMARY KEY,/);
    expect(emitTables(calloutEntities)).not.toMatch(/id TEXT PRIMARY KEY,/);
    expect(emitTables(calloutEntities)).toContain('id TEXT PRIMARY KEY NOT NULL');
  });
});
