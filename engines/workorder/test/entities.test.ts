/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/contracts';
import { workorderEntities } from '../src/entities.js';
import { workorderModule } from '../src/index.js';


describe('the registry agrees with the migration journal', () => {
  const journal = journalColumns((workorderModule.migrations ?? []).map((m) => m.sql).join('\n'));

  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('workorder_orders')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(workorderEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('describes only what the platform can point at', () => {
    // Three tables, one entity: time entries and material lines are rows this
    // engine owns and totals, never the subject of an EntityRef.
    expect(Object.keys(workorderEntities)).toEqual(['workorder']);
    expect(journal.size).toBeGreaterThan(2);
  });

  it("names no parent — the parent is the vertical's noun", () => {
    // Callout leaves it at the manifest's `facility`; Handlebar hangs work
    // orders off a bike. entityRelations is an allowlist, so both coexist.
    expect('parents' in workorderEntities.workorder).toBe(false);
    expect(workorderModule.manifest.entityRelations).toContainEqual({
      entityType: 'workorder',
      parentType: 'facility',
    });
  });
});
