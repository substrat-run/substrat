import { describe, expect, it } from 'vitest';
import { bikeShopEntities, bikeShopModel } from '../src/entities.js';
import { bikeShopMigrations } from '../src/migrations.js';
import { bikeShopManifest } from '../src/manifest.js';

// ============================================================================
// The registry and the migration journal are TWO DESCRIPTIONS OF ONE SCHEMA.
//
// `src/entities.ts` declares the row shape as `ctx.sql` returns it; `0001-init`
// creates the table it returns rows from. Nothing derives one from the other
// yet, so nothing stops them drifting: rename a column in the journal, add its
// migration, and the registry goes stale while `tsc` stays green and every
// scenario assertion above still passes — the declaration would then be wrong
// about the very thing it exists to state.
//
// This is the check that makes that a red build. It is also the one worth
// copying when you replace the bike shop with your own domain: every entity you
// declare should be held to the table it names.
// ============================================================================

const journalSql = bikeShopMigrations.map((m) => m.sql).join('\n');

/** The columns each `CREATE TABLE` actually leaves behind, plus any `ADD COLUMN`. */
function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const [, table, body] of journalSql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      // Table constraints are not columns, and neither is a comment.
      if (!line || line.startsWith('--') || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line))
        continue;
      const name = /^([a-z_][a-z0-9_]*)\b/i.exec(line)?.[1];
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }
  for (const [, table, col] of journalSql.matchAll(
    /ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)/gi,
  )) {
    if (table && col) tables.get(table)?.add(col);
  }
  return tables;
}

describe('the registry agrees with the migration journal', () => {
  const journal = columnsFromJournal();

  it('parsed the journal at all', () => {
    // A comparison that silently parsed nothing would pass everything under it,
    // which is the one way this file could be worse than not existing.
    expect(journal.size).toBe(3);
    expect(journal.get('shop_customers')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(bikeShopEntities)) {
    it(`${name} → ${entity.table}: the declared fields ARE the table's columns`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('leaves the price list out — a table, not an entity', () => {
    // Stated as an assertion rather than an absence, so deleting the entity that
    // should not exist is a decision somebody made and not one that rotted away.
    expect(journal.has('shop_price_list')).toBe(true);
    expect(Object.values(bikeShopEntities).map((e) => e.table)).not.toContain('shop_price_list');
  });
});

describe('the declared model and the manifest describe one walk', () => {
  it('emits every declared entity, deterministically', () => {
    expect(Object.keys(bikeShopModel.entities)).toEqual(['bike', 'customer']);
    expect(bikeShopModel.entities.bike?.parents).toEqual(['customer']);
  });

  it("keeps the model's local edge and the manifest's in step", () => {
    // `entityRelations` is what `ctx.link` and the portal walk resolve against;
    // `parents` is the model's half of the same edge. Two spellings of one fact,
    // until the manifest is derived from the registry.
    expect(bikeShopManifest.entityRelations).toContainEqual({
      entityType: 'bike',
      parentType: 'customer',
    });
    // The hop the shop's own registry cannot produce: `workorder` is the ENGINE's
    // entity, and the portal walk (workorder → bike → customer) needs it.
    expect(bikeShopManifest.entityRelations).toContainEqual({
      entityType: 'workorder',
      parentType: 'bike',
    });
  });

  it('declares the identifying bike field erasable', () => {
    // A frame number points at its owner. An erasure that kept it would leave
    // that pointer behind, and an event payload carrying it could not be reached
    // at all — so the declaration is what keeps it out of one.
    expect(bikeShopEntities.bike.erasable).toContain('frame_no');
    expect(bikeShopEntities.customer.erasable).toEqual(['name', 'phone']);
  });
});
