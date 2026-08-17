/**
 * The registry and the migration journal are two descriptions of one schema.
 * Until migrations are derived from the registry, this holds them to each other.
 *
 * The journal is append-only and REWRITES tables: 0002 builds
 * `protocol_instances_v2`, copies rows into it, drops `protocol_instances`, and
 * renames the new one over the old. So the columns of a live table are not the
 * columns of any single `CREATE TABLE` — they are what is left after replaying
 * the journal in order. `columnsFromJournal` replays it, which is why the
 * registry can name `protocol_instances` (the table a live scope actually has)
 * rather than the intermediate `_v2` name.
 */
import { describe, expect, it } from 'vitest';
import { protocolEntities } from '../src/entities.js';
import { protocolModule } from '../src/index.js';

/**
 * Replay the journal's DDL and return the columns each surviving table ends with.
 *
 * Ordered, because `CREATE` / `DROP` / `RENAME` / `ADD COLUMN` are not
 * commutative: reading all the CREATEs and then all the ALTERs gets the right
 * answer only until a migration renames a table, at which point later ALTERs
 * name a table no CREATE ever mentioned.
 */
function columnsFromJournal(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const sql = (protocolModule.migrations ?? []).map((m) => m.sql).join('\n');

  const statements = [
    ...sql.matchAll(
      new RegExp(
        [
          // CREATE TABLE <name> ( <body> );
          String.raw`CREATE TABLE (?:IF NOT EXISTS )?(?<created>[a-z_][a-z0-9_]*)\s*\((?<body>[\s\S]*?)\n\s*\);`,
          // DROP TABLE <name>;
          String.raw`DROP TABLE (?:IF EXISTS )?(?<dropped>[a-z_][a-z0-9_]*)`,
          // ALTER TABLE <name> RENAME TO <name>;
          String.raw`ALTER TABLE (?<renamed>[a-z_][a-z0-9_]*)\s+RENAME TO\s+(?<renamedTo>[a-z_][a-z0-9_]*)`,
          // ALTER TABLE <name> ADD COLUMN <col>
          String.raw`ALTER TABLE (?<altered>[a-z_][a-z0-9_]*)\s+ADD COLUMN\s+(?<column>[a-z_][a-z0-9_]*)`,
        ].join('|'),
        'gi',
      ),
    ),
  ];

  for (const { groups } of statements) {
    if (!groups) continue;
    if (groups.created && groups.body !== undefined) {
      const cols = new Set<string>();
      let depth = 0;
      for (const raw of groups.body.split('\n')) {
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
      tables.set(groups.created, cols);
    } else if (groups.dropped) {
      tables.delete(groups.dropped);
    } else if (groups.renamed && groups.renamedTo) {
      const cols = tables.get(groups.renamed);
      if (cols) {
        tables.delete(groups.renamed);
        tables.set(groups.renamedTo, cols);
      }
    } else if (groups.altered && groups.column) {
      tables.get(groups.altered)?.add(groups.column);
    }
  }
  return tables;
}

describe('the registry agrees with the migration journal', () => {
  const journal = columnsFromJournal();

  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('protocol_instances')?.size).toBeGreaterThan(1);
  });

  it('replays the 0002 rebuild rather than reading CREATEs in isolation', () => {
    // The intermediate name is gone by the end of the journal, and the surviving
    // table carries the rebuilt shape — `frozen_hash` exists only on the v2
    // CREATE, and `document_attachment_id` only on an ALTER that names the
    // post-rename table. A parser that ignored DROP/RENAME would report the
    // 0001 columns under this name and miss both.
    expect(journal.has('protocol_instances_v2')).toBe(false);
    expect(journal.get('protocol_instances')?.has('frozen_hash')).toBe(true);
    expect(journal.get('protocol_instances')?.has('document_attachment_id')).toBe(true);
  });

  for (const [name, entity] of Object.entries(protocolEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no live table '${entity.table}' after replaying the journal`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('describes only what the platform can point at', () => {
    // Templates, responses and signatures are rows this engine owns and operates
    // on — never the subject of an EntityRef.
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
