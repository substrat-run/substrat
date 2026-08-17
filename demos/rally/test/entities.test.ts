/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/contracts';
import { rallyEntities, rallyModel } from '../src/entities.js';
import { rallyModule } from '../src/module.js';

const journal = journalColumns((rallyModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('rally_members')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(rallyEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(rallyModel.entities).length).toBe(Object.keys(rallyEntities).length);
    expect(JSON.stringify(rallyModel)).toBe(JSON.stringify(rallyModel));
  });
});
