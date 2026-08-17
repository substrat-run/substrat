/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { shopEntities, shopModel } from '../src/entities.js';
import { shopModule } from '../src/module.js';

const journal = journalColumns((shopModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('shop_customers')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(shopEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(shopModel.entities).length).toBe(Object.keys(shopEntities).length);
    expect(JSON.stringify(shopModel)).toBe(JSON.stringify(shopModel));
  });
});
