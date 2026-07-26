/**
 * The textual gate in front of the scope SQL console (`HostAdmin.queryScope`, #219).
 *
 * `readScopeTable` is safe by construction — no user SQL ever reaches the DB. The
 * console breaks that, so read-only-ness has to be ENFORCED per statement, in two
 * layers: this shared scan (both adapters, same rejections, so a query that runs in
 * dev runs in prod), and an adapter-authoritative backstop behind it —
 * better-sqlite3's `prepare().readonly` (sqlite3_stmt_readonly) on the pure adapter,
 * and a transaction that always rolls back on the DO, whose `exec` exposes no
 * read-only flag.
 *
 * The scan works on bare tokens OUTSIDE comments, string literals, and quoted
 * identifiers ('…', "…", `…`, […]), so a `;` or an "update" inside a string never
 * trips it. It rejects:
 *  - anything that isn't a single statement (no `;` chaining — a trailing `;` is fine);
 *  - a first keyword outside SELECT / WITH / VALUES / EXPLAIN;
 *  - any bare write/DDL/session keyword ANYWHERE — because `WITH … INSERT INTO` is
 *    valid SQLite, the first keyword alone proves nothing.
 *
 * Deliberately over-strict: a bare token like `attach` used as an (unquoted) column
 * name is rejected even where SQLite would allow it. False positives cost a quoted
 * identifier in a console query; a false negative writes the spine. Callers get the
 * trimmed statement back and must pass THAT to the DB, so what was checked is what runs.
 */

const FIRST_KEYWORDS = new Set(['select', 'with', 'values', 'explain']);

// Every SQLite verb that writes, alters schema, or changes session state. INTO is
// listed on its own: SQLite has no `SELECT INTO`, and forbidding it closes
// `REPLACE INTO` without banning the bare token `replace` (a builtin function).
const FORBIDDEN = new Set([
  'insert',
  'into',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'pragma',
  'attach',
  'detach',
  'vacuum',
  'reindex',
  'analyze',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
]);

/**
 * Assert `sql` is one read-only statement; returns the trimmed statement to run.
 * Throws an `Error` whose message names the offending token — it crosses the RPC
 * boundary and lands in the console UI, so it is written for the person typing.
 */
export function assertReadOnlyQuery(sql: string): string {
  const tokens: string[] = [];
  let statementEnded = false;
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // String literal or quoted identifier; the closing quote doubles to escape.
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      if (statementEnded) throw new Error('read-only console: only a single statement is allowed');
      continue;
    }
    if (c === '[') {
      while (i < n && sql[i] !== ']') i += 1;
      i += 1;
      if (statementEnded) throw new Error('read-only console: only a single statement is allowed');
      continue;
    }
    if (c === ';') {
      // A trailing `;` is fine; any content after it is a second statement.
      statementEnded = true;
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      if (statementEnded) throw new Error('read-only console: only a single statement is allowed');
      tokens.push(sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    if (statementEnded && /\S/.test(c)) throw new Error('read-only console: only a single statement is allowed');
    i += 1;
  }

  const first = tokens[0];
  if (!first) throw new Error('read-only console: empty statement');
  if (!FIRST_KEYWORDS.has(first)) {
    throw new Error(`read-only console: statement must start with SELECT, WITH, VALUES, or EXPLAIN (got '${first.toUpperCase()}')`);
  }
  for (const t of tokens) {
    if (FORBIDDEN.has(t)) {
      throw new Error(
        `read-only console: '${t.toUpperCase()}' is not allowed (quote it if it names a column or table)`,
      );
    }
  }

  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
}
