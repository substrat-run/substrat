/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { manyfoldEntities, manyfoldModel } from '../src/entities.js';
import { manyfoldMigrations } from '../src/migrations.js';

const journal = journalColumns(manyfoldMigrations.map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('manyfold_entry')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(manyfoldEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(manyfoldModel.entities).length).toBe(Object.keys(manyfoldEntities).length);
    expect(JSON.stringify(manyfoldModel)).toBe(JSON.stringify(manyfoldModel));
  });
});
