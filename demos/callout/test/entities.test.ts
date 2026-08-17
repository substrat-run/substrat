/**
 * The registry and the migration journal are two descriptions of one schema.
 *
 * That is the defect class this whole effort exists to remove, so declaring
 * entities without checking them against the DDL would be adding an instance of
 * it while claiming to fix one. Until migrations are DERIVED from the registry
 * (#680/#685 step 2), this test holds the two to each other — every disagreement
 * is a defect in one of them, and the failure says which.
 *
 * The journal is append-only, so a table's columns are the union of its CREATE
 * plus every later ALTER. Both are read here.
 */
import { describe, expect, it } from 'vitest';
import { emitModel } from '@substrat-run/contracts';
import { calloutEntities } from '../src/entities.js';
import { calloutMigrations } from '../src/migrations.js';

/** Column names per table, accumulated across the whole journal. */
function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const sql = calloutMigrations.map((m) => m.sql).join('\n');

  const creates = sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi);
  for (const [, table, body] of creates) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      // Skip blanks, comments and table-level constraints.
      if (!line || line.startsWith('--') || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = /^([a-z_][a-z0-9_]*)\b/i.exec(line)?.[1];
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }

  const alters = sql.matchAll(/ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)/gi);
  for (const [, table, col] of alters) {
    if (table && col) tables.get(table)?.add(col);
  }
  return tables;
}

describe('the registry agrees with the migration journal', () => {
  const journal = columnsFromJournal();

  it('parsed the journal at all', () => {
    // A comparison that silently parsed nothing would pass every assertion
    // below while checking none of them.
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('callout_customers')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(calloutEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      const declared = Object.keys(entity.fields.shape).sort();
      expect(declared).toEqual([...(actual ?? [])].sort());
    });
  }
});

describe('emitted model', () => {
  it('is deterministic and covers every declared entity', () => {
    const model = emitModel(calloutEntities);
    expect(Object.keys(model.entities)).toEqual(['customer', 'facility']);
    expect(model.entities.facility?.parents).toEqual(['customer']);
    expect(JSON.stringify(emitModel(calloutEntities))).toBe(JSON.stringify(model));
  });

  it('does not claim tables that are not entities', () => {
    // callout_price_list is a table, not an entity: no id, never an EntityRef,
    // never a permission-walk node.
    const tables = Object.values(calloutEntities).map((e) => e.table);
    expect(tables).not.toContain('callout_price_list');
    expect(journalHas('callout_price_list')).toBe(true);
  });
});

function journalHas(table: string): boolean {
  return columnsFromJournal().has(table);
}
