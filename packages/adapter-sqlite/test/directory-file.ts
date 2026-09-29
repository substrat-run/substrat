import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ScopeDumpTable } from '@substrat-run/contracts';

/**
 * A host's directory as its file holds it: every table's DDL, columns and rows, in name order,
 * read through a connection of its own. `exportDirectory` reads the same, but records an
 * access-log row doing it, which a before/after comparison would trip over.
 */
export function readDirectoryFile(dir: string): ScopeDumpTable[] {
  const db = new Database(join(dir, '_directory.sqlite'), { readonly: true });
  try {
    const defs = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY name`)
      .all() as { name: string; sql: string }[];
    return defs.map(({ name, sql }) => {
      const stmt = db.prepare(`SELECT * FROM "${name}"`).raw(true);
      return { name, ddl: sql, rows: stmt.all() as unknown[][], columns: stmt.columns().map((c) => c.name) };
    });
  } finally {
    db.close();
  }
}
