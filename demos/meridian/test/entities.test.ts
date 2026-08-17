/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { meridianEntities, meridianModel } from '../src/entities.js';
import { meridianMigrations } from '../src/migrations.js';

const journal = journalColumns(meridianMigrations.map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('hr_employees')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(meridianEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(meridianModel.entities).length).toBe(Object.keys(meridianEntities).length);
    expect(JSON.stringify(meridianModel)).toBe(JSON.stringify(meridianModel));
  });
});
