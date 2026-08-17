/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 */
import { describe, expect, it } from 'vitest';
import { workorderEntities } from '../src/entities.js';
import { workorderModule } from '../src/index.js';

function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const sql = (workorderModule.migrations ?? []).map((m) => m.sql).join('\n');
  for (const [, table, body] of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    let depth = 0;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      const atTop = depth === 0;
      depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (!atTop) continue;
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
