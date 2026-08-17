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
 */
import { describe, expect, it } from 'vitest';
import { emitTables, journalColumns } from '@substrat-run/model-emit';
import { handlebarEntities } from '../src/entities.js';
import { bikeShopModule } from '../src/module.js';

const handWritten = journalColumns((bikeShopModule.migrations ?? []).map((m) => m.sql).join('\n'));
const emitted = journalColumns(emitTables(handlebarEntities));

describe('emitted DDL vs the hand-written journal', () => {
  it('parsed both sides', () => {
    expect(handWritten.size).toBeGreaterThan(0);
    expect(emitted.size).toBe(Object.keys(handlebarEntities).length);
  });

  for (const [name, entity] of Object.entries(handlebarEntities)) {
    it(`${name} → ${entity.table}: same columns`, () => {
      expect([...(emitted.get(entity.table) ?? [])].sort()).toEqual(
        [...(handWritten.get(entity.table) ?? [])].sort(),
      );
    });
  }

  it('closes the NULL-primary-key hole the hand-written schema has', () => {
    // In SQLite `id TEXT PRIMARY KEY` accepts a NULL id — a non-INTEGER primary
    // key does not imply NOT NULL. The hand-written journal has that hole in
    // every table; the emitter cannot produce it.
    expect((bikeShopModule.migrations ?? []).map((m) => m.sql).join('\n')).toMatch(/id\s+TEXT PRIMARY KEY,/);
    expect(emitTables(handlebarEntities)).not.toMatch(/id TEXT PRIMARY KEY,/);
    expect(emitTables(handlebarEntities)).toContain('id TEXT PRIMARY KEY NOT NULL');
  });
});
