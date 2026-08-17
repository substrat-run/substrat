/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry (#680/#685 step 2), this holds
 * them to each other — every disagreement is a defect in one, and the failure
 * says which.
 *
 * Handlebar keeps its journal inline in `module.ts` rather than in a separate
 * `migrations.ts` as Callout does, so this reads the registration.
 */
import { describe, expect, it } from 'vitest';
import { handlebarEntities, handlebarModel } from '../src/entities.js';
import { bikeShopModule } from '../src/module.js';

function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const sql = (bikeShopModule.migrations ?? []).map((m) => m.sql).join('\n');

  for (const [, table, body] of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--') || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = /^([a-z_][a-z0-9_]*)\b/i.exec(line)?.[1];
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }
  for (const [, table, col] of sql.matchAll(/ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)/gi)) {
    if (table && col) tables.get(table)?.add(col);
  }
  return tables;
}

describe('the registry agrees with the migration journal', () => {
  const journal = columnsFromJournal();

  it('parsed the journal at all', () => {
    // A comparison that silently parsed nothing passes everything under it.
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('bike_shop_customers')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(handlebarEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('leaves the price list out — a table, not an entity', () => {
    expect(journal.has('bike_shop_price_list')).toBe(true);
    expect(Object.values(handlebarEntities).map((e) => e.table)).not.toContain('bike_shop_price_list');
  });
});

describe('the manifest edges', () => {
  const relations = bikeShopModule.manifest.entityRelations ?? [];

  it('derives the local edge rather than restating it', () => {
    expect(relations).toContainEqual({ entityType: 'bike', parentType: 'customer' });
  });

  it('keeps the full permission walk: protocol → workorder → bike → customer', () => {
    // The walk is what the portal depends on; the middle edge crosses the
    // ownership boundary, which is why `foreignChildOf` exists.
    expect(relations).toContainEqual({ entityType: 'workorder', parentType: 'bike' });
    expect(relations).toContainEqual({ entityType: 'protocol', parentType: 'workorder' });
  });

  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(handlebarModel.entities)).toEqual(['bike', 'customer']);
    expect(handlebarModel.entities.bike?.parent).toBe('customer');
  });
});
