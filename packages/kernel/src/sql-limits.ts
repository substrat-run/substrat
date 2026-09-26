/**
 * The SQLite limits a Durable Object enforces and node does not (#1741).
 *
 * A vertical's `ctx.sql` runs on `better-sqlite3` in every local suite and on a Durable
 * Object's SQLite when it is deployed, and the DO's build sets several limits far below
 * stock SQLite's. A statement over one passed every node suite and failed only on a
 * deployed scope — `customer/get` in an adopter vertical counted rows with a 29-term
 * `UNION ALL` and broke on the first hosted call. #1655 closed the same gap for a `LIKE`
 * pattern (`tools/vitest/like-pattern-limit.cjs`, which has to patch the driver because
 * `better-sqlite3` exposes no `sqlite3_limit`). Three of the four limits below can be judged
 * from the statement text, so the adapter judges them itself, and a vertical's OWN suite sees
 * what a Durable Object sees. The pattern limit cannot: a pattern is often built at run time,
 * and judging it exactly means replacing `like()` on every connection, a JavaScript call per
 * row that also switches off SQLite's `LIKE` prefix index optimisation. That cost is fine in a
 * test preload and not in an adapter self-hosters run, so it stays a preload's job.
 *
 * The values are MEASURED, not read from documentation:
 * `packages/adapter-cloudflare/test/do-sql-limits.test.ts` drives a real Durable Object's
 * SQL to each limit and pins the value and the refusal message it gave. If workerd moves
 * one, that test goes red first.
 *
 * | limit                         | value          | DO's refusal                                        |
 * |-------------------------------|----------------|-----------------------------------------------------|
 * | terms in one compound SELECT  | 5              | `too many terms in compound SELECT`                 |
 * | bound parameters              | 100            | `too many SQL variables at offset N`                |
 * | statement length              | 100 000 bytes  | `statement too long` (`SQLITE_TOOBIG`)              |
 * | `LIKE`/`GLOB` pattern length  | 50 bytes       | `LIKE or GLOB pattern too complex` (not judged here: preload only) |
 * | columns in a table            | 100            | `too many columns on <table>`                       |
 * | columns in a result set       | 100            | `too many columns in result set`                    |
 *
 * The two column limits cannot be judged from the text: a `SELECT *` or a `RETURNING *` is as
 * wide as the tables under it. The node adapter reads the width from the driver instead — a
 * prepared statement's `columns()` for a result set, and the schema AFTER a migration ran for a
 * table (#1811). Neither is done here, because this wrapper sees only `ScopedSql`.
 *
 * What is NOT a limit, measured: a multi-row `VALUES` list — SQLite does not count its rows
 * as compound terms; 5 000 rows ran on the DO. So `INSERT … VALUES (…),(…),…` is bounded by
 * the parameter count and the statement length only.
 *
 * Judged here, from the text, exactly as SQLite counts:
 *  - **compound terms** — `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT` at one parenthesis
 *    level chain their operands into one compound; the limit is on the operands (operators + 1).
 *    A subquery, a CTE body and a view body each start their own count.
 *  - **bound parameters** — SQLite's own numbering: each `?` takes the next number, `?N`
 *    takes N, a `:name`/`@name`/`$name` takes the next number the first time it is seen. The
 *    limit is on the highest number, not on how many are written or how many are bound.
 *  - **statement length** — the whole string the caller passed, in UTF-8 bytes (a multi-
 *    statement string counts once, as on the DO).
 *
 * The messages are the DO's own, suffix included, so a suite that matches on one matches
 * both adapters. Only MODULE-facing SQL is wrapped: platform-internal statements are the
 * platform's own responsibility, and they already run on a real DO in the workerd suites.
 */
import type { ScopedSql, SqlValue } from './scope-host.js';

/** The limits a Durable Object's SQLite enforces — measured, see the file header. */
export const DO_SQL_LIMITS = {
  /** Terms (operands) in one compound `SELECT`. */
  compoundTerms: 5,
  /** Bound parameters — the highest parameter number — in one statement. */
  boundParameters: 100,
  /** Statement length, in UTF-8 bytes, of the whole string handed to `sql.exec`. */
  statementBytes: 100_000,
  /** `LIKE`/`GLOB` pattern length, in UTF-8 bytes. Enforced by `tools/vitest/like-pattern-limit.cjs`. */
  likePatternBytes: 50,
  /** Columns in one table, and in one result set. Measured by a 1–2001 binary search on workerd (#1811). */
  columns: 100,
} as const;

// Declared locally, as `secret-box.ts` does: the kernel builds without DOM or node typings.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

/** The offset SQLite reports is in BYTES from the start of the statement. */
const byteOffset = (sql: string, index: number): number => byteLength(sql.slice(0, index));

const COMPOUND_OPERATORS = new Set(['union', 'intersect', 'except']);
const isWord = (c: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * Where a `:name`, `@name` or `$name` parameter token ends — SQLite's own tokenizer rule
 * (`sqlite3GetToken`, the variable case), which is wider than an identifier:
 *  - identifier characters (letters, digits, `_`, `$`, anything non-ASCII) continue it;
 *  - `::` continues it, so `$a::b` is ONE parameter (the pair adds nothing to the name);
 *  - a `(` starts a Tcl-style suffix that runs to the next `)` or whitespace, and ends the
 *    token: `$a(b c)` is not one parameter but `$a(b` and, past the space, other words.
 * A scanner that stopped at the first `:` or `(` counted the rest as more parameters, so a
 * valid statement could be refused for holding over 100 variables.
 */
function endOfNamedParameter(sql: string, from: number): number {
  const n = sql.length;
  let i = from + 1;
  while (i < n) {
    const c = sql[i]!;
    if (isWord(c)) {
      i += 1;
    } else if (c === '(') {
      i += 1;
      while (i < n && !/\s/.test(sql[i]!) && sql[i] !== ')') i += 1;
      if (sql[i] === ')') i += 1;
      break;
    } else if (c === ':' && sql[i + 1] === ':') {
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Refuse a statement a Durable Object's SQLite would refuse for its length, its compound
 * `SELECT` terms, or its bound parameters. Throws the DO's own message.
 */
export function assertWithinSqlLimits(sql: string): void {
  // Cheap first: UTF-16 length is at most the byte length, so a string under
  // a third of the limit cannot be over it, and most statements skip the encode.
  if (sql.length * 3 > DO_SQL_LIMITS.statementBytes && byteLength(sql) > DO_SQL_LIMITS.statementBytes) {
    throw new Error('statement too long: SQLITE_TOOBIG');
  }

  const n = sql.length;
  // Operators seen at each open parenthesis level of the statement being scanned.
  let operators: number[] = [0];
  let nVar = 0;
  const named = new Map<string, number>();
  const tooManyVariables = (at: number): Error =>
    new Error(`too many SQL variables at offset ${byteOffset(sql, at)}: SQLITE_ERROR`);
  const bindOne = (at: number, number_: number): void => {
    if (number_ > DO_SQL_LIMITS.boundParameters) throw tooManyVariables(at);
  };

  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    // Comments are whitespace to SQLite.
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // String literals and quoted identifiers; a doubled quote is an escaped one.
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '[') {
      while (i < n && sql[i] !== ']') i += 1;
      i += 1;
      continue;
    }
    if (c === '(') {
      operators.push(0);
      i += 1;
      continue;
    }
    if (c === ')') {
      if (operators.length > 1) operators.pop();
      i += 1;
      continue;
    }
    if (c === ';') {
      // A new statement: its own compound chain and its own parameter numbering.
      operators = [0];
      nVar = 0;
      named.clear();
      i += 1;
      continue;
    }
    if (c === '?') {
      const start = i;
      i += 1;
      let digits = '';
      while (i < n && sql[i]! >= '0' && sql[i]! <= '9') digits += sql[i++];
      if (digits === '') {
        nVar += 1;
        bindOne(start, nVar);
      } else {
        const number_ = Number(digits);
        if (number_ < 1 || number_ > DO_SQL_LIMITS.boundParameters) {
          throw new Error(
            `variable number must be between ?1 and ?${DO_SQL_LIMITS.boundParameters} at offset ${byteOffset(sql, start)}: SQLITE_ERROR`,
          );
        }
        if (number_ > nVar) nVar = number_;
      }
      continue;
    }
    if (c === ':' || c === '@' || c === '$') {
      const start = i;
      i = endOfNamedParameter(sql, i);
      // SQLite keys a slot on the WHOLE token, sigil included: `:a` and `@a` are two variables.
      const token = sql.slice(start, i);
      if (token.length > 1 && !named.has(token)) {
        nVar += 1;
        named.set(token, nVar);
        bindOne(start, nVar);
      }
      continue;
    }
    if (isWord(c)) {
      const start = i;
      while (i < n && isWord(sql[i]!)) i += 1;
      // `t.union` is a column, not an operator; a reserved word cannot be a bare name otherwise.
      const word = sql.slice(start, i).toLowerCase();
      if (COMPOUND_OPERATORS.has(word) && sql[start - 1] !== '.') {
        const level = operators.length - 1;
        operators[level] = operators[level]! + 1;
        if (operators[level]! + 1 > DO_SQL_LIMITS.compoundTerms) {
          throw new Error('too many terms in compound SELECT: SQLITE_ERROR');
        }
      }
      continue;
    }
    i += 1;
  }
}

/** The DO's refusal of a result set wider than `DO_SQL_LIMITS.columns`. */
export const TOO_MANY_RESULT_COLUMNS = 'too many columns in result set: SQLITE_ERROR';

/** The DO's refusal of a table wider than `DO_SQL_LIMITS.columns`. */
export const tooManyTableColumns = (table: string): string => `too many columns on ${table}: SQLITE_ERROR`;

/**
 * Wrap a module-facing `ScopedSql` so every statement passes `assertWithinSqlLimits` first.
 * The node adapter wraps `ctx.sql` in it; the DO needs no wrapper — its SQLite is the
 * source of these limits.
 */
export function guardSqlLimits(inner: ScopedSql): ScopedSql {
  return {
    query: <T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[] => {
      assertWithinSqlLimits(sql);
      return inner.query<T>(sql, params);
    },
    exec: (sql: string, params?: readonly SqlValue[]) => {
      assertWithinSqlLimits(sql);
      return inner.exec(sql, params);
    },
  };
}
