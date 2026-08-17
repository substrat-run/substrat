/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 *
 * The journal is append-only, so `protocol_instances` (0001) and
 * `protocol_instances_v2` (the live table) both appear in it. Only the live one
 * is described by the registry, and that is the point of checking by table name
 * rather than by position.
 */
import { describe, expect, it } from 'vitest';
import { protocolEntities } from '../src/entities.js';
import { protocolModule } from '../src/index.js';

function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const sql = (protocolModule.migrations ?? []).map((m) => m.sql).join('\n');
  for (const [, table, body] of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const cols = new Set<string>();
    let depth = 0;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      // A CHECK (...) constraint spans lines; do not read its continuation as a column.
      const opens = (line.match(/\(/g) ?? []).length;
      const closes = (line.match(/\)/g) ?? []).length;
      const atTop = depth === 0;
      depth += opens - closes;
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
    expect(journal.get('protocol_instances_v2')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(protocolEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('describes only what the platform can point at', () => {
    // Eight tables, one entity. Templates, responses and signatures are rows
    // this engine owns and operates on — never the subject of an EntityRef.
    expect(Object.keys(protocolEntities)).toEqual(['protocol']);
    expect(journal.size).toBeGreaterThan(4);
  });

  it('declares no parent — the engine is entity-agnostic', () => {
    // An instance binds to whatever the vertical says, so only the vertical
    // knows where protocols hang. The absence is the design.
    // `in` rather than a property read: with `const` inference the key is absent
    // from the TYPE, not merely undefined — which is a stronger statement and
    // the one worth asserting.
    expect('parent' in protocolEntities.protocol).toBe(false);
  });
});
