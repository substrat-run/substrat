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
 * `INSERT`/`REPLACE INTO`, `UPDATE`, `DELETE FROM`, `DROP`, `ALTER`, `CREATE`.
 * What is allowed, deliberately: every read of the spine, including one that feeds
 * a write — `INSERT INTO my_timeline SELECT … FROM _substrat_events` is the
 * projection pattern CLAUDE.md explicitly blesses, and only the target is judged.
 * Out of scope, stated rather than hidden: `PRAGMA`/`ATTACH`/`VACUUM` are not
 * inspected here. They are a different reach (the file, not the spine), the DO
 * runtime refuses them outright, and widening this guard to cover them would make
 * it a second read-only console rather than a rule about forging.
 *
 * The scan tokenises OUTSIDE comments and string literals but KEEPS quoted
 * identifiers as tokens — `INSERT INTO "_substrat_tuples"` is the first thing
 * anyone tries, and a scanner that skips quotes hands it through. Dotted names
 * (`main._substrat_tuples`) merge into one token, and every part is checked.
 * Multiple statements in one string are walked in full: the DO's `sql.exec` accepts
 * them, so a forge chained after a legitimate write must not slip past.
 */
import { substratError } from '@substrat-run/contracts';
import type { ScopedSql, SqlValue } from './scope-host.js';

/** The platform spine's table prefix — the same one `isSystemTable` groups on. */
const SPINE_PREFIX = '_substrat';

interface Token {
  /** The identifier text, unquoted; dotted names joined with `.`. */
  readonly text: string;
  /** A quoted identifier or string literal — never read as a keyword. */
  readonly quoted: boolean;
}

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

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  // Set when the previous token ended on a `.`, so `main . tbl` folds into one name.
  let continues = false;

  const push = (text: string, quoted: boolean): void => {
    const prev = tokens[tokens.length - 1];
    if (continues && prev) {
      tokens[tokens.length - 1] = { text: `${prev.text}.${text}`, quoted: prev.quoted || quoted };
    } else {
      tokens.push({ text, quoted });
    }
    // Look ahead past whitespace for the dot that joins this name to the next part.
    let j = i;
    while (j < n && /\s/.test(sql[j]!)) j += 1;
    if (sql[j] === '.') {
      continues = true;
      i = j + 1;
    } else {
      continues = false;
    }
  };

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
      // A quoted identifier, or a string literal SQLite would still accept as one
      // in a table position. The closing quote doubles to escape itself.
      i += 1;
      let text = '';
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            text += c;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      push(text, true);
      continue;
    }
    if (c === '[') {
      i += 1;
      let text = '';
      while (i < n && sql[i] !== ']') {
        text += sql[i];
        i += 1;
      }
      i += 1;
      push(text, true);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j += 1;
      const text = sql.slice(i, j);
      i = j;
      push(text, false);
      continue;
    }
    // Whitespace does not break a dotted name (`main . tbl` is one); anything else does.
    if (!/\s/.test(c)) continues = false;
    i += 1;
  }
  return tokens;
}

/** True when any part of a (possibly dotted, possibly quoted) name is spine. */
function namesSpine(token: Token): boolean {
  return token.text
    .split('.')
    .some((part) => part.toLowerCase().startsWith(SPINE_PREFIX));
}

/**
 * Refuse a statement whose write target is a `_substrat_*` table.
 *
 * Throws a `forbidden` (`reason: 'spine_write'`) — module code reaching the spine
 * is a fault in the module, not in the caller's permissions, and the message names
 * the table so the author sees which line to delete.
 */
export function assertNoSpineWrite(sql: string): void {
  const tokens = tokenize(sql);
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
    const target = tokens[j];
    if (!target || !namesSpine(target)) continue;
    throw substratError(
      'forbidden',
      `ctx.sql cannot write the platform spine: ${verb.toUpperCase()} on '${target.text}'. ` +
        'Reads are fine; writes go through ctx.emit / ctx.link / ctx.grant.',
      { reason: 'spine_write' },
    );
  }
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
