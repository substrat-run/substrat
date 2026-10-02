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
  /**
   * Column-level CHECK expressions, by column, each normalised by `normaliseSql`
   * (`status in ('a','b')`). A table-level `CHECK (…)` is not attributed to any
   * column and is not here: nothing the model emits is written that way.
   */
  readonly checks: ReadonlyMap<string, readonly string[]>;
}

/** Keywords that open a table constraint rather than a column definition. */
const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;

/** Skip whitespace and comments from `i`; the index of the next significant character. */
function skipTrivia(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
    if (s[i] === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    return i;
  }
}

/**
 * Walk `s` at paren depth, quote- and comment-aware, calling `visit` with each
 * significant character's index and the depth BEFORE it. Returns nothing; the
 * visitor returns `false` to stop.
 */
function walk(s: string, from: number, visit: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i] as string;
    if (CLOSING[c]) {
      if (visit(i, depth) === false) return;
      i = endOfQuoted(s, i) - 1;
      continue;
    }
    if ((c === '-' && s[i + 1] === '-') || (c === '/' && s[i + 1] === '*')) {
      i = skipTrivia(s, i) - 1;
      continue;
    }
    if (visit(i, depth) === false) return;
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
}

/** The parenthesised run opening at `open`, without its parens. */
function parenthesised(s: string, open: number): string {
  let close = s.length;
  walk(s, open, (i, depth) => {
    if (s[i] === ')' && depth === 1) {
      close = i;
      return false;
    }
  });
  return s.slice(open + 1, close);
}

/** An identifier as SQLite reads it: quotes stripped, a doubled quote unescaped. */
function unquote(id: string): string {
  const close = CLOSING[id[0] as string];
  if (!close || id[0] === "'") return id;
  return id.slice(1, -1).split(close + close).join(close);
}

/**
 * One spelling for one expression, so the same CHECK written two ways compares
 * equal: comments dropped, whitespace collapsed (and removed just inside parens and
 * around commas), keywords and identifiers lower-cased, simple quoted identifiers
 * unquoted. String literals are kept exactly — `'Open'` and `'open'` are
 * different values.
 */
export function normaliseSql(expr: string): string {
  let out = '';
  // A space is only written once the next token shows it is needed: never
  // beside a paren or a comma, never at either end.
  let space = false;
  const emit = (token: string) => {
    if (space && out && !/[(,]$/.test(out) && !/^[),]/.test(token)) out += ' ';
    space = false;
    out += token;
  };
  let i = 0;
  while (i < expr.length) {
    const c = expr[i] as string;
    if (/\s/.test(c) || (c === '-' && expr[i + 1] === '-') || (c === '/' && expr[i + 1] === '*')) {
      i = skipTrivia(expr, i);
      space = true;
      continue;
    }
    if (c === "'") {
      const end = endOfQuoted(expr, i);
      emit(expr.slice(i, end));
      i = end;
      continue;
    }
    if (CLOSING[c]) {
      const end = endOfQuoted(expr, i);
      const id = unquote(expr.slice(i, end));
      emit(/^[A-Za-z_][A-Za-z0-9_]*$/.test(id) ? id.toLowerCase() : expr.slice(i, end));
      i = end;
      continue;
    }
    emit(c.toLowerCase());
    i++;
  }
  return out;
}

/**
 * The column-level CHECKs a stored `CREATE TABLE` declares.
 *
 * This reads SQLite's OWN copy of the statement (`sqlite_schema.sql`), not the
 * journal's: after the replay it already carries every `ADD COLUMN`, every
 * `RENAME COLUMN` (SQLite rewrites the expression) and every rebuild-and-rename,
 * so the only parsing left is splitting one statement into its definitions. No
 * PRAGMA reports a CHECK, which is why there is any parsing at all.
 */
export function columnChecks(createSql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let open = -1;
  walk(createSql, 0, (i, depth) => {
    if (createSql[i] === '(' && depth === 0) {
      open = i;
      return false;
    }
  });
  if (open === -1) return out;
  const body = parenthesised(createSql, open);

  // Top-level definitions: split on the commas at depth 0.
  const parts: string[] = [];
  let start = 0;
  walk(body, 0, (i, depth) => {
    if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(body.slice(start));

  for (const raw of parts) {
    const part = raw.slice(skipTrivia(raw, 0));
    if (!part || TABLE_CONSTRAINT.test(part)) continue;
    const nameEnd = CLOSING[part[0] as string] ? endOfQuoted(part, 0) : (/^[^\s(]+/.exec(part)?.[0].length ?? 0);
    const column = unquote(part.slice(0, nameEnd));
    const checks: string[] = [];
    walk(part, nameEnd, (i, depth) => {
      if (depth !== 0 || !/^CHECK\b/i.test(part.slice(i, i + 6)) || /[A-Za-z0-9_]/.test(part[i - 1] ?? ' ')) return;
      const open = skipTrivia(part, i + 5);
      if (part[open] !== '(') return;
      checks.push(normaliseSql(parenthesised(part, open)));
    });
    if (checks.length) out.set(column, checks);
  }
  return out;
}

/**
 * One replay per journal string.
 *
 * `planMigration` asks for columns, keys, uniques and checks off the same journal, and
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
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name`)
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

      const create = db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(name) as
        | { sql: string }
        | undefined;
      const checks = columnChecks(create?.sql ?? '');

      schema.set(name, { columns: info.map((c) => c.name), primaryKey, uniques, checks });
    }

    cache.set(sql, schema);
    return schema;
  } finally {
    db.close();
  }
}
