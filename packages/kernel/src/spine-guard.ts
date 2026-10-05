/**
 * The runtime half of *"never write to `_substrat_*`"* (#954).
 *
 * The rule is in CLAUDE.md and in `tools/boundary-lint.mjs`, and until now that was
 * the whole of it — a source scan. `ctx.sql` handed module code the same connection
 * `ctx.emit`, `ctx.grant`, `ctx.link` and `ctx.requestPlatform` write the spine
 * through, so one `INSERT INTO _substrat_tuples …` forged a grant and one
 * `UPDATE _substrat_outbox …` rewrote an event that had already been announced.
 * Lint cannot reach that: it does not run on the hosted push path, so a vertical
 * that never passed through this repo's CI reached production with the rule
 * unenforced.
 *
 * So the guard lives where the connection is handed over. Both adapters wrap their
 * module-facing `ScopedSql` in `guardSpine` and nothing else changes: the kernel's
 * own spine writes go through the raw `better-sqlite3` handle / `SqlStorage`, which
 * this never sees.
 *
 * What is refused: a statement whose write TARGET is a `_substrat_*` table —
 * `INSERT`/`REPLACE INTO`, `UPDATE`, `DELETE FROM`, `DROP`, `ALTER`, `CREATE` — and
 * the second table a statement can reach past the one it names first: `CREATE
 * TRIGGER … ON`, `CREATE INDEX … ON`, `ALTER TABLE … RENAME TO`, and a `REFERENCES` clause
 * naming the spine (`assertNoSpineReference`, #1898).
 * What is allowed, deliberately: every read of the spine, including one that feeds
 * a write — `INSERT INTO my_timeline SELECT … FROM _substrat_events` is the
 * projection pattern CLAUDE.md explicitly blesses, and only the target is judged.
 * Out of scope, stated rather than hidden: `PRAGMA`/`ATTACH`/`VACUUM` are not
 * inspected here. They are a different reach (the file, not the spine), the DO
 * runtime refuses them outright, and widening this guard to cover them would make
 * it a second read-only console rather than a rule about forging.
 *
 * The scan is `tokenizeSql` from `@substrat-run/contracts`, the one reading of the grammar
 * the dump checks share: comments and string literals skipped, quoted identifiers kept as
 * tokens, dotted names merged into one, and every part of one checked.
 * Multiple statements in one string are walked in full: the DO's `sql.exec` accepts
 * them, so a forge chained after a legitimate write must not slip past.
 */
import { namesSpineTable, referencedTablesIn, substratError, tokenizeSql, type SqlToken } from '@substrat-run/contracts';
import type { ScopedSql, SqlValue } from './scope-host.js';

/**
 * Tokens that may stand between a write verb and the table it names. The first
 * following token that is NOT one of these (or that is quoted) is the target.
 */
const MODIFIERS: Readonly<Record<string, ReadonlySet<string>>> = {
  insert: new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore', 'into']),
  replace: new Set(['into']),
  update: new Set(['or', 'rollback', 'abort', 'replace', 'fail', 'ignore']),
  delete: new Set(['from']),
  drop: new Set(['table', 'index', 'view', 'trigger', 'if', 'exists']),
  alter: new Set(['table']),
  create: new Set([
    'temp',
    'temporary',
    'unique',
    'virtual',
    'table',
    'index',
    'view',
    'trigger',
    'if',
    'not',
    'exists',
  ]),
};

/**
 * A SECOND table a statement can reach, past the one it names first.
 *
 * `CREATE TRIGGER t BEFORE INSERT ON _substrat_outbox …` and `CREATE INDEX ix ON
 * _substrat_tuples (…)` both name a harmless new object first and the spine table
 * after `ON`; a trigger installed there makes every later kernel write fail with
 * `SQLITE_CONSTRAINT`, which is denial of the spine rather than forgery of it, and
 * just as much a reach past `ctx.sql`. `ALTER TABLE todos RENAME TO _substrat_x` is
 * the same shape with `TO`.
 */
const SECOND_TARGET: Readonly<Record<string, string>> = { create: 'on', alter: 'to' };

/** The first token at or after `from` that names the spine, following this verb's grammar. */
function spineTargetFrom(tokens: SqlToken[], from: number, verb: string): SqlToken | undefined {
  const first = tokens[from];
  if (first && namesSpineTable(first.text)) return first;
  const keyword = SECOND_TARGET[verb];
  if (!keyword) return undefined;
  for (let k = from; k < tokens.length; k += 1) {
    if (tokens[k]!.quoted || tokens[k]!.text.toLowerCase() !== keyword) continue;
    const after = tokens[k + 1];
    return after && namesSpineTable(after.text) ? after : undefined;
  }
  return undefined;
}

/**
 * Refuse a statement whose write target is a `_substrat_*` table.
 *
 * Throws a `forbidden` (`reason: 'spine_write'`) — module code reaching the spine
 * is a fault in the module, not in the caller's permissions, and the message names
 * the table so the author sees which line to delete.
 */
export function assertNoSpineWrite(sql: string, statefulTables?: ReadonlySet<string>): void {
  const tokens = tokenizeSql(sql);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.quoted) continue;
    const verb = token.text.toLowerCase();
    const modifiers = MODIFIERS[verb];
    if (!modifiers) continue;
    let j = i + 1;
    while (j < tokens.length && !tokens[j]!.quoted && modifiers.has(tokens[j]!.text.toLowerCase())) {
      j += 1;
    }
    const target = spineTargetFrom(tokens, j, verb);
    if (!target) continue;
    throw substratError(
      'forbidden',
      `ctx.sql cannot write the platform spine: ${verb.toUpperCase()} on '${target.text}'. ` +
        'Reads are fine; writes go through ctx.emit / ctx.link / ctx.grant.',
      { reason: 'spine_write' },
    );
  }
  refuseSpineReference(referencedTablesIn(tokens), 'ctx.sql');
  assertNoReservedColumnWrite(sql, statefulTables);
}

/**
 * Refuse a statement that WRITES a `_substrat_*` column of a module's own table (#119).
 *
 * The kernel keeps state on module rows — `_substrat_archived_at`, `_substrat_trashed_at` —
 * and a row's way into or out of the trash must be `ctx.trash`/`ctx.restore`, which check the
 * declared key and emit the event. A module that could `UPDATE todo_lists SET
 * _substrat_trashed_at = NULL` would restore without the key and without a record, which is
 * the forgery the table rule above exists to stop, one level down.
 *
 * Judged by POSITION, so reading the columns stays allowed — in a `SELECT`, and in the `WHERE`
 * of a write (`UPDATE … SET done = 1 WHERE _substrat_trashed_at IS NULL`). Refused:
 *
 * - an assignment target after `SET` — `UPDATE … SET`, an upsert's `DO UPDATE SET`, and a
 *   trigger body's `UPDATE`, row-value targets `SET (a, b) = …` included;
 * - a name in an `INSERT`/`REPLACE` column list;
 * - any reserved name in an `ALTER TABLE` (add, rename or drop the column itself);
 * - into a table that CARRIES the columns (`statefulTables`, lowercased names): an `INSERT`
 *   with no column list — `VALUES (…)` and `SELECT …` fill the columns by position, the
 *   reserved ones included, without ever naming them — and any `REPLACE` / `INSERT OR
 *   REPLACE`, which deletes the existing row and writes a new one with the columns NULL, so
 *   it un-archives and un-trashes without the key. An `INSERT … (columns) SELECT` and an
 *   upsert's `DO UPDATE SET` are judged by the rules above.
 *
 * Below this sits a trigger on each such table that refuses a row born archived or trashed
 * (`entityStateMigrations`), so a form this scan misses still cannot set the state.
 *
 * The prefix is reserved whole, not the two names: the next kernel-owned column is covered
 * without anyone remembering to list it here.
 */
export function assertNoReservedColumnWrite(sql: string, statefulTables?: ReadonlySet<string>): void {
  // Every token is a substring of the text, so a statement that never spells the prefix names
  // no reserved column — and that is nearly every statement, which then skips the second scan.
  // A positional write names no column at all, so it is looked for whenever a stateful table
  // exists and the statement could be one.
  const positional = statefulTables !== undefined && statefulTables.size > 0 && /\b(insert|replace)\b/i.test(sql);
  if (!positional && !/_substrat/i.test(sql)) return;
  const tokens = tokenizeSql(sql, { punctuation: true });
  const refuse = (column: string, how: string): never => {
    throw substratError(
      'forbidden',
      `ctx.sql cannot write the platform's column '${column}' (${how}). ` +
        'Reads are fine; archive and trash go through ctx.archive / ctx.trash / ctx.restore.',
      { reason: 'spine_write' },
    );
  };
  const refuseRow = (table: string, why: string): never => {
    throw substratError(
      'forbidden',
      `ctx.sql cannot write '${table}' this way: ${why}. Name the columns you write; ` +
        'archive and trash go through ctx.archive / ctx.trash / ctx.restore.',
      { reason: 'spine_write' },
    );
  };
  const word = (k: number) => {
    const t = tokens[k];
    return t && !t.quoted && !t.punct ? t.text.toLowerCase() : undefined;
  };
  const isPunct = (k: number, c: string) => tokens[k]?.punct === true && tokens[k]!.text === c;
  // Names inside one parenthesised group starting at `open`; returns the index after `)`.
  const namesInParens = (open: number, onName: (text: string) => void): number => {
    let depth = 0;
    let k = open;
    for (; k < tokens.length; k += 1) {
      const t = tokens[k]!;
      if (t.punct && t.text === '(') depth += 1;
      else if (t.punct && t.text === ')') {
        depth -= 1;
        if (depth === 0) return k + 1;
      } else if (!t.punct && depth === 1) onName(t.text);
    }
    return k;
  };
  /** Keywords that end an assignment list when they stand at its own depth. */
  const SET_ENDS = new Set(['where', 'from', 'returning', 'order', 'limit']);

  /**
   * The assignment targets of the `SET` list starting after `start`, judged by STRUCTURE.
   *
   * Everything that can hold a comma, a keyword or another `SET` is nested: a parenthesised
   * expression or subquery, and a `CASE … END`, each pushed on one stack, so an `END` closes a
   * `CASE` that is open and ends the list only when none is (the trigger body's `END`). Strings,
   * comments and quoted identifiers never reach here as keywords — `tokenizeSql` keeps a quoted
   * token apart. A target is the first token of the list and the first after each comma at the
   * list's own depth; a `(a, b)` there is a row-value target, every name in it a target.
   */
  const setTargets = (start: number, onTarget: (name: string) => void): void => {
    const nesting: ('paren' | 'case')[] = [];
    let expectTarget = true;
    for (let k = start; k < tokens.length; k += 1) {
      const t = tokens[k]!;
      const kw = t.quoted || t.punct ? undefined : t.text.toLowerCase();
      if (nesting.length === 0) {
        if (t.punct && (t.text === ';' || t.text === ')')) return;
        if (kw === 'end' || (kw !== undefined && SET_ENDS.has(kw))) return;
        if (t.punct && t.text === ',') {
          expectTarget = true;
          continue;
        }
        if (expectTarget) {
          expectTarget = false;
          if (t.punct && t.text === '(') {
            k = namesInParens(k, onTarget) - 1;
            continue;
          }
          if (!t.punct) {
            onTarget(t.text);
            continue;
          }
        }
      }
      if (t.punct && t.text === '(') nesting.push('paren');
      else if (kw === 'case') nesting.push('case');
      else if (t.punct && t.text === ')') {
        while (nesting.length && nesting.pop() !== 'paren');
      } else if (kw === 'end' && nesting[nesting.length - 1] === 'case') nesting.pop();
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const verb = word(i);
    if (verb === 'set') {
      setTargets(i + 1, (name) => {
        if (namesSpineTable(name)) refuse(name, 'SET target');
      });
      continue;
    }
    if (verb === 'insert' || verb === 'replace') {
      // `replace(` is SQLite's string function, not the statement — which always reads
      // `REPLACE INTO`. Read as a statement, its argument list became a "column list".
      if (verb === 'replace' && word(i + 1) !== 'into') continue;
      let k = i + 1;
      let replaces = verb === 'replace';
      while (word(k) !== undefined && MODIFIERS[verb]!.has(word(k)!)) {
        if (word(k) === 'replace') replaces = true;
        k += 1;
      }
      const target = tokens[k];
      if (!target || target.punct) continue;
      k += 1; // past the target table
      if (word(k) === 'as') k += 2; // an alias
      const table = target && !target.punct ? (target.text.split('.').pop() ?? '').toLowerCase() : '';
      if (statefulTables?.has(table)) {
        if (replaces) refuseRow(target!.text, 'REPLACE deletes the row and writes it back with no archive or trash state');
        if (!isPunct(k, '(') && word(k) !== 'default') {
          refuseRow(target!.text, 'an INSERT with no column list fills the archive/trash columns by position');
        }
      }
      if (isPunct(k, '(')) {
        namesInParens(k, (name) => {
          if (namesSpineTable(name)) refuse(name, 'INSERT column');
        });
      }
      continue;
    }
    if (verb === 'alter') {
      // ALTER TABLE <t> …: the table is judged above; here, every other name in the statement.
      let k = i + 1;
      while (word(k) !== undefined && MODIFIERS.alter!.has(word(k)!)) k += 1;
      for (k += 1; k < tokens.length && !isPunct(k, ';'); k += 1) {
        const t = tokens[k]!;
        if (!t.punct && namesSpineTable(t.text)) refuse(t.text, 'ALTER TABLE');
      }
    }
  }
}

/**
 * Refuse a statement whose `REFERENCES` clause names a `_substrat_*` table (#1898), for the
 * same reason `CREATE TRIGGER … ON` is refused above: the spine's rows become the parent of a
 * module's, and with foreign keys enforced the kernel's own writes to that table (a revoke, a
 * restore's re-point, an outbox prune) then fail on the module's rows. That denies the spine
 * rather than forging it. `what` names the SQL's source in the message.
 *
 * `ctx.sql` passes through here (`assertNoSpineWrite`), and so does every migration a scope
 * applies, which reaches the database on the kernel's own handle rather than through
 * `ctx.sql`. A dump's replayed DDL is held to the same rule by `assertReplayableDump`.
 */
export function assertNoSpineReference(sql: string, what: string): void {
  refuseSpineReference(referencedTablesIn(tokenizeSql(sql)), what);
}

/** The refusal itself, over a statement's `REFERENCES` targets. */
function refuseSpineReference(referenced: readonly string[], what: string): void {
  const target = referenced.find(namesSpineTable);
  if (target === undefined) return;
  throw substratError(
    'forbidden',
    `${what} cannot declare a foreign key to the platform spine: REFERENCES '${target}'. ` +
      'A module table may reference its own tables; spine rows are reached through the kernel, never as a parent.',
    { reason: 'spine_write' },
  );
}

/**
 * Wrap a module-facing `ScopedSql` so every statement passes `assertNoSpineWrite`
 * first. `query` is guarded too: SQLite runs `INSERT … RETURNING` perfectly well
 * through a `.all()`, so guarding only `exec` would leave the door open.
 */
export function guardSpine(
  inner: ScopedSql,
  /** The module tables that carry archive/trash columns (#119), lowercased — see `assertNoReservedColumnWrite`. */
  statefulTables?: ReadonlySet<string>,
): ScopedSql {
  return {
    query: <T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[] => {
      assertNoSpineWrite(sql, statefulTables);
      return inner.query<T>(sql, params);
    },
    exec: (sql: string, params?: readonly SqlValue[]) => {
      assertNoSpineWrite(sql, statefulTables);
      return inner.exec(sql, params);
    },
  };
}
