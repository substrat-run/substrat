/**
 * The journal, read by REPLAYING it.
 *
 * Every reader in this package used to parse SQL with regular expressions, and
 * every one of them was wrong in a way nobody could have predicted from reading
 * it. #807 reported two defects; probing the same cause found five more in ten
 * minutes — a `CREATE TABLE` on one line, a `) STRICT;` suffix, a wrapped
 * `PRIMARY KEY (` list, a quoted `"order"` identifier, the word UNIQUE inside a
 * comment. That is not a list of bugs, it is a shape: a regex over SQL text has
 * no bottom, and every fix is a patch against the next spelling.
 *
 * So this does not read SQL. It runs it, into a throwaway in-memory database,
 * and asks SQLite what the schema is. The answer is the one the production
 * database would give, because it comes from the same engine — which is the
 * whole claim `emitTables` makes and the reason a reader exists at all.
 *
 * **Only schema statements are replayed.** A journal's `INSERT`s do not change
 * its schema, and skipping them is what lets a vertical's journal be read on its
 * own: two of this repo's verticals hand data to an engine with
 * `INSERT … SELECT` into a table that lives in the ENGINE's journal (the
 * decision-28 extraction handoff), which no amount of replaying the vertical
 * alone can satisfy. Foreign keys stay off — SQLite's default — so a
 * `REFERENCES` pointing into another module's journal is created, not refused.
 *
 * Node-only, deliberately. This package is a devDependency in all of its
 * dependents and no `src/` file imports it, so nothing here reaches a worker
 * bundle or a scope; the builder runs its gates as shell commands in a
 * container. `node:sqlite` is a builtin, so this costs no dependency.
 */
import { DatabaseSync } from 'node:sqlite';

/** The quote characters SQLite accepts around an identifier or a literal. */
const CLOSING: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/** Index after the quoted run starting at `i`; a doubled quote is an escape. */
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
 * The journal's statements, split on the semicolons that actually end one.
 *
 * Quote- and comment-aware, because a `;` inside a string literal or a `--`
 * comment ends nothing. This is the only text scanning left in the package, and
 * it exists because the statements have to be filtered before they are run —
 * `db.exec` would happily run the `INSERT`s too.
 */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    if (CLOSING[c]) {
      i = endOfQuoted(sql, i) - 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === ';') {
      const s = sql.slice(start, i).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const last = sql.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Statements that change the schema — the only ones worth replaying. */
const isSchemaStatement = (s: string): boolean =>
  /^(CREATE|ALTER|DROP)\b/i.test(s.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ''));

export interface TableSchema {
  /** Declaration order, as `PRAGMA table_info` reports it. */
  readonly columns: string[];
  /** Key order, not declaration order — `(a, b)` and `(b, a)` are different keys. Empty when the table has none. */
  readonly primaryKey: string[];
  /** Each constraint normalised to `a, b`. Excludes the primary key and any PARTIAL index. */
  readonly uniques: string[];
}

/**
 * One replay per journal string.
 *
 * `planMigration` asks for columns, keys and uniques off the same journal, and
 * building three identical databases to answer three questions about one schema
 * would be silly. Keyed on the SQL itself, which is what makes it safe: the
 * readers are pure functions of their input, and this does not change that.
 */
const cache = new Map<string, Map<string, TableSchema>>();

/**
 * The schema a journal leaves behind, as SQLite sees it.
 *
 * Throws if a schema statement does not apply — which is a feature, not a
 * regression. A journal that cannot be replayed is a journal that will not apply
 * to a real scope either, and the old readers answered anyway.
 */
export function readSchema(sql: string): Map<string, TableSchema> {
  const hit = cache.get(sql);
  if (hit) return hit;

  const db = new DatabaseSync(':memory:');
  try {
    for (const statement of statements(sql)) {
      if (!isSchemaStatement(statement)) continue;
      try {
        db.exec(statement);
      } catch (cause) {
        const head = statement.replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(
          `journal: a schema statement does not apply — ${(cause as Error).message}\n  in: ${head}…\n` +
            'The journal is replayed into SQLite to read its schema, so a statement that cannot ' +
            'run here would not run against a scope either.',
          { cause },
        );
      }
    }

    const schema = new Map<string, TableSchema>();
    const names = db
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as unknown as Array<{ name: string }>;

    for (const { name } of names) {
      const info = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as unknown as Array<{ name: string }>;
      const primaryKey = (
        db.prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(name) as unknown as Array<{
          name: string;
        }>
      ).map((r) => r.name);

      const uniques: string[] = [];
      const indexes = db
        .prepare(`SELECT name, "unique" AS uniq, partial, origin FROM pragma_index_list(?)`)
        .all(name) as unknown as Array<{ name: string; uniq: number; partial: number; origin: string }>;
      for (const index of indexes) {
        // `pk` is the primary key wearing an index; it has its own reader.
        // A PARTIAL index constrains a subset of the rows, so reading it as a
        // key would claim a guarantee the database does not make.
        if (!index.uniq || index.partial || index.origin === 'pk') continue;
        const cols = (
          db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(index.name) as unknown as Array<{
            name: string;
          }>
        ).map((r) => r.name);
        uniques.push(cols.join(', '));
      }

      schema.set(name, { columns: info.map((c) => c.name), primaryKey, uniques });
    }

    cache.set(sql, schema);
    return schema;
  } finally {
    db.close();
  }
}
