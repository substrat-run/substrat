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
export function assertNoSpineWrite(sql: string): void {
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
export function guardSpine(inner: ScopedSql): ScopedSql {
  return {
    query: <T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[] => {
      assertNoSpineWrite(sql);
      return inner.query<T>(sql, params);
    },
    exec: (sql: string, params?: readonly SqlValue[]) => {
      assertNoSpineWrite(sql);
      return inner.exec(sql, params);
    },
  };
}
