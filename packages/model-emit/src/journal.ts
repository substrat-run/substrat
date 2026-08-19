/**
 * Reading a migration journal — the verification half of `emitTables`.
 *
 * The emitter's claim is "what this emits is what the database ends up with";
 * this is how that gets checked. They live together because they are two halves
 * of one statement, and a reader that drifts from its emitter checks nothing.
 *
 * The three readers below share one scanner, because they used to share one
 * defect (#807): they split a `CREATE TABLE` body on NEWLINES, so the same table
 * written with two columns on a line reported one of them. A journal is under no
 * obligation to format itself for a parser — `a TEXT, b TEXT` is the same schema
 * as one column per line, and a reader that disagrees is the one that is wrong.
 * Splitting on top-level commas instead is what `splitTopLevel` is for.
 */

/** The quote characters SQLite accepts around an identifier or a literal. */
const CLOSING: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * Index of the character after the quoted run starting at `i`.
 *
 * A doubled quote is an escape, not a close — `'it''s'` is one literal. Every
 * scan below goes through here rather than counting characters itself, so a
 * comma, a paren or the word UNIQUE inside a string cannot be read as syntax.
 */
function endOfQuoted(s: string, i: number): number {
  const close = CLOSING[s[i] as string] as string;
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === close) {
      if (s[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/**
 * The journal with its comments removed, string literals and quoted identifiers
 * left intact.
 *
 * A comment is not somewhere a schema fact can live, but it IS somewhere the
 * word UNIQUE can appear — and a reader matching text rather than structure read
 * `-- b is UNIQUE (b) per the spec` as a constraint the database does not have.
 * That is the dangerous direction: the planner reports "up to date" over a
 * uniqueness guarantee nothing enforces.
 *
 * Newlines are kept so nothing downstream has to care that this ran.
 */
function withoutComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (CLOSING[c]) {
      const end = endOfQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Index of the `)` that closes the paren opened just before `from`, or -1.
 *
 * This is what replaced looking for a `);` at the end of a line. That test made
 * a whole class of ordinary table invisible — a `CREATE TABLE` written on one
 * line, and any table with a `) STRICT;` or `) WITHOUT ROWID;` suffix — and an
 * invisible table is not a refusal: `planMigration` read it as new and emitted a
 * second `CREATE TABLE` for a table that already existed.
 */
function matchingParen(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i] as string;
    if (CLOSING[c]) {
      i = endOfQuoted(s, i) - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The comma-separated parts of a `CREATE TABLE` body, at paren depth zero. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (CLOSING[c]) {
      i = endOfQuoted(body, i) - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * The identifier a fragment starts with, unquoted.
 *
 * `"order" TEXT NOT NULL` declares a column named `order`. A bare-word-only
 * reader dropped it, and dropped the primary key along with it when the quoted
 * name was the key.
 */
function leadingIdent(s: string): string | undefined {
  const m = /^(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([a-z_][a-z0-9_]*))/i.exec(s.trim());
  return m ? ((m[1] ?? m[2] ?? m[3] ?? m[4]) as string) : undefined;
}

/** True when a body part is a table-level constraint rather than a column. */
const isConstraint = (part: string) => /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part);

/** A part with its parenthesised groups blanked, so a keyword inside a `CHECK (…)` is not read as one. */
const outsideParens = (part: string) => {
  let out = '';
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part[i] as string;
    if (CLOSING[c]) {
      i = endOfQuoted(part, i) - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0) out += c;
  }
  return out;
};

/** Every `CREATE TABLE` in the journal, as its name and its body. */
function createTables(sql: string): Array<{ table: string; parts: string[] }> {
  const out: Array<{ table: string; parts: string[] }> = [];
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const open = (m.index as number) + m[0].length;
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    out.push({ table: m[1] as string, parts: splitTopLevel(sql.slice(open, close)) });
  }
  return out;
}

/** The column list of a `(a, b DESC)` clause — the column is the first word of each. */
const columnList = (inner: string) =>
  splitTopLevel(inner)
    .map((c) => leadingIdent(c))
    .filter((c): c is string => !!c);

/**
 * Column names per table, read out of a migration journal's SQL.
 *
 * Three engines had hand-rolled a copy of this and the copies had already
 * drifted — none followed `RENAME TO`, so a journal that rebuilds a table under
 * a temporary name would report the pre-rebuild columns forever.
 *
 * It exists because a registry and a journal are two descriptions of one schema
 * until migrations are derived from the registry. Holding them to each other is
 * what keeps that duplication safe in the meantime.
 *
 * Handles what real journals do: multi-line `CHECK (...)` constraints, several
 * columns on one line, quoted identifiers, `ADD COLUMN`, `DROP TABLE`,
 * `RENAME COLUMN` and `RENAME TO` — append-only journals rebuild a table by
 * creating a `_new`, copying, dropping the original and renaming onto its name.
 */
export function journalColumns(sql: string): Map<string, Set<string>> {
  const clean = withoutComments(sql);
  const tables = new Map<string, Set<string>>();

  for (const { table, parts } of createTables(clean)) {
    const cols = new Set<string>();
    for (const part of parts) {
      if (isConstraint(part)) continue;
      const name = leadingIdent(part);
      if (name) cols.add(name);
    }
    tables.set(table, cols);
  }

  // Replayed in statement order: a journal may add a column and later rename the
  // table, or rename onto a name it has just dropped.
  for (const m of clean.matchAll(
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
 * `journalColumns` deliberately skips constraint parts — it answers "which
 * columns exist". But a declared `key` is a schema fact too, and adding one to
 * an entity that already has a table is a change SQLite cannot make in place.
 * Without this the planner reported "up to date" over a missing constraint.
 *
 * All THREE spellings of a uniqueness rule are read, because real journals use
 * all three and reading only the table-level one (#807) made two of CRM-EFF's
 * four remaining refusals: table-level `UNIQUE (b)`, column-level
 * `b TEXT UNIQUE`, and `CREATE UNIQUE INDEX … ON t (b)`, which is the same
 * constraint by a different route.
 *
 * A PARTIAL index (`… WHERE deleted_at IS NULL`) is deliberately NOT read: it
 * constrains a subset of the rows, so treating it as a whole-table key would
 * claim a guarantee the database does not make.
 *
 * Normalised to `a, b` (single space, declaration order preserved) so the same
 * constraint written two ways compares equal.
 */
export function journalUniques(sql: string): Map<string, Set<string>> {
  const clean = withoutComments(sql);
  const tables = new Map<string, Set<string>>();

  for (const { table, parts } of createTables(clean)) {
    const found = new Set<string>();
    for (const part of parts) {
      // Table-level: `UNIQUE (a, b)`, optionally named.
      const table_level = /^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*\(/i.exec(part);
      if (table_level) {
        const open = table_level[0].length;
        const close = matchingParen(part, open);
        if (close > 0) found.add(columnList(part.slice(open, close)).join(', '));
        continue;
      }
      if (isConstraint(part)) continue;
      // Column-level: `b TEXT NOT NULL UNIQUE`. Read outside parens so the word
      // inside a `CHECK (…)` cannot be mistaken for the keyword.
      const name = leadingIdent(part);
      if (name && /\bUNIQUE\b/i.test(outsideParens(part))) found.add(name);
    }
    tables.set(table, found);
  }

  // `CREATE UNIQUE INDEX ux ON t (a, b)` — the same constraint, declared apart
  // from the table. Read after the tables so an index always finds its table.
  for (const m of clean.matchAll(
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_]*\s+ON\s+([a-z_][a-z0-9_]*)\s*\(/gi,
  )) {
    const table = m[1] as string;
    const open = (m.index as number) + m[0].length;
    const close = matchingParen(clean, open);
    if (close < 0) continue;
    // A trailing WHERE makes it partial, which is a different constraint.
    if (/^\s*WHERE\b/i.test(clean.slice(close + 1))) continue;
    tables.get(table)?.add(columnList(clean.slice(open, close)).join(', '));
  }

  // Replayed in statement order, like `journalColumns`.
  for (const m of clean.matchAll(
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

/**
 * The primary key per table, read out of a journal.
 *
 * `journalColumns` answers "which columns exist" and `journalUniques` "which
 * uniqueness rules"; neither says which columns *identify* a row, and that gap
 * is what made #804 invisible. A production vertical's parity check compared
 * names, types and nullability across 63 tables and reported 63/63 while 15 of
 * the emitted tables had no primary key at all.
 *
 * Both spellings are read, because journals use both: inline
 * (`id TEXT PRIMARY KEY NOT NULL`) for one column, and a table-level
 * `PRIMARY KEY (a, b)` for several. A table with no primary key maps to an
 * EMPTY array rather than being absent — "the journal never built this table"
 * and "the journal built it without a key" are different answers, and only one
 * of them is a bug.
 *
 * Reading the key WRONG is worse than not reading it, which is why #807 was
 * fixed here first: a missing column produces a refusal that says "add it", but
 * a misread key produces one that says "rebuild the table or drop the
 * declaration" — and both of those are damage, done on the reader's word.
 *
 * Order is preserved: a composite primary key is the index its columns are
 * searched by, so `(a, b)` and `(b, a)` are not the same key.
 */
export function journalPrimaryKeys(sql: string): Map<string, string[]> {
  const clean = withoutComments(sql);
  const tables = new Map<string, string[]>();

  for (const { table, parts } of createTables(clean)) {
    let key: string[] = [];
    for (const part of parts) {
      // Table-level. Written as its own clause, so it wins over any inline
      // spelling — a table cannot legally have both, and if one somehow did,
      // the explicit list is the one a reader would believe.
      const composite = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(/i.exec(part);
      if (composite) {
        const open = composite[0].length;
        const close = matchingParen(part, open);
        if (close > 0) key = columnList(part.slice(open, close));
        continue;
      }
      if (isConstraint(part)) continue;

      // Inline, on the column that carries it.
      const name = leadingIdent(part);
      if (name && /\bPRIMARY\s+KEY\b/i.test(outsideParens(part)) && key.length === 0) key = [name];
    }
    tables.set(table, key);
  }

  // Replayed in statement order, like `journalColumns`. A rebuild renames a
  // table onto another's name and the key travels with it; `ADD COLUMN` cannot
  // introduce one, because SQLite refuses to add a PRIMARY KEY column.
  for (const m of clean.matchAll(
    /(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*))|(?:ALTER TABLE ([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*))|(?:DROP TABLE (?:IF EXISTS )?([a-z_][a-z0-9_]*))/gi,
  )) {
    const [, renTable, renFrom, renTo, fromTable, toTable, dropped] = m;
    if (dropped) {
      tables.delete(dropped);
    } else if (renTable && renFrom && renTo) {
      const key = tables.get(renTable);
      if (key) tables.set(renTable, key.map((c) => (c === renFrom ? renTo : c)));
    } else if (fromTable && toTable) {
      const key = tables.get(fromTable);
      if (key) {
        tables.delete(fromTable);
        tables.set(toTable, key);
      }
    }
  }
  return tables;
}
