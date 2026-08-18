/**
 * Reading a migration journal — the verification half of `emitTables`.
 *
 * The emitter's claim is "what this emits is what the database ends up with";
 * this is how that gets checked. They live together because they are two halves
 * of one statement, and a reader that drifts from its emitter checks nothing.
 */
/**
 * Column names per table, read out of a migration journal's SQL.
 *
 * Three engines had hand-rolled a copy of this and the copies had already drifted — none followed `RENAME TO`, so a journal that
 * rebuilds a table under a temporary name would report the pre-rebuild columns
 * forever.
 *
 * It exists because a registry and a journal are two descriptions of one schema
 * until migrations are derived from the registry. Holding them to each other is
 * what keeps that duplication safe in the meantime.
 *
 * Handles what real journals do: multi-line `CHECK (...)` constraints (tracked
 * by paren depth, so a continuation line is not read as a column), `ADD COLUMN`,
 * `DROP TABLE`, `RENAME COLUMN` and `RENAME TO` — append-only journals rebuild a table by
 * creating a `_new`, copying, dropping the original and renaming onto its name.
 */
export function journalColumns(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

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

  // Replayed in statement order: a journal may add a column and later rename the
  // table, or rename onto a name it has just dropped.
  for (const m of sql.matchAll(
    // `RENAME COLUMN` comes first: `RENAME TO` must not swallow it. Without this
    // branch a renamed column reads as its old name forever, and a planner that
    // derives migrations would emit the same rename on every run.
    /(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*))|(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*))|(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*))|(?:DROP TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*))/gi,
  )) {
    const [, addTable, addCol, renTable, renFrom, renTo, fromTable, toTable, dropped] = m;
    if (addTable && addCol) tables.get(addTable)?.add(addCol);
    else if (dropped) tables.delete(dropped);
    else if (renTable && renFrom && renTo) {
      const cols = tables.get(renTable);
      if (cols?.delete(renFrom)) cols.add(renTo);
    } else if (fromTable && toTable) {
      const cols = tables.get(fromTable);
      if (cols) {
        tables.delete(fromTable);
        tables.set(toTable, cols);
      }
    }
  }
  return tables;
}

/**
 * UNIQUE constraints per table, read out of a journal.
 *
 * `journalColumns` deliberately skips constraint lines — it answers "which
 * columns exist". But a declared `key` is a schema fact too, and adding one to
 * an entity that already has a table is a change SQLite cannot make in place.
 * Without this the planner reported "up to date" over a missing constraint.
 *
 * Normalised to `a, b` (single space, declaration order preserved) so the same
 * constraint written two ways compares equal.
 */
export function journalUniques(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  for (const [, table, body] of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi,
  )) {
    if (!table || !body) continue;
    const found = new Set<string>();
    for (const [, cols] of body.matchAll(/\bUNIQUE\s*\(([^)]*)\)/gi)) {
      if (!cols) continue;
      found.add(
        cols
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .join(', '),
      );
    }
    tables.set(table, found);
  }

  // Replayed in statement order, like `journalColumns`.
  for (const m of sql.matchAll(
    /(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*))|(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*))|(?:DROP TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*))/gi,
  )) {
    const [, renTable, renFrom, renTo, fromTable, toTable, dropped] = m;
    if (dropped) {
      tables.delete(dropped);
    } else if (renTable && renFrom && renTo) {
      // SQLite rewrites the constraint when a column is renamed — verified
      // against a real database — so the reader has to as well. Missing this
      // makes a renamed key look like a key the journal never had.
      const cs = tables.get(renTable);
      if (cs) {
        tables.set(
          renTable,
          new Set(
            [...cs].map((c) =>
              c
                .split(', ')
                .map((col) => (col === renFrom ? renTo : col))
                .join(', '),
            ),
          ),
        );
      }
    } else if (fromTable && toTable) {
      // A rebuild renames a table onto another's name; constraints travel with it.
      const c = tables.get(fromTable);
      if (c) {
        tables.delete(fromTable);
        tables.set(toTable, c);
      }
    }
  }
  return tables;
}
