/**
 * Where one SQL statement ends and the next begins — a faithful port of SQLite's own
 * `sqlite3_complete()` (src/complete.c), the state machine SQLite uses to decide whether a
 * string holds a complete statement.
 *
 * Every place the kernel or an adapter has to run SQL one statement at a time goes through
 * `splitSqlStatements`: a Durable Object's `exec` takes one statement, and the table-ownership
 * record (#2068) diffs the schema around each one. An ad-hoc splitter disagreed with SQLite on
 * valid SQL — a `CASE … END;` inside a trigger body ended the trigger early, a `;` inside a
 * quoted identifier split it, and a comment between two keywords glued them together — so this
 * one does not interpret the language at all beyond what `sqlite3_complete()` does:
 *
 * - tokens: `;`; whitespace and comments (`--…`, `/* … *\/`); string and quoted identifiers
 *   (`'…'`, `"…"`, `` `…` ``, `[…]`); identifier words, of which only CREATE, TEMP/TEMPORARY,
 *   TRIGGER, END and EXPLAIN matter; and any other single character;
 * - states: the transition table below, verbatim, which carries `CREATE [TEMP] TRIGGER … END;`
 *   through the semicolons inside its body and through a `CASE … END` there;
 * - a statement ends at a `;` that returns the machine to START.
 *
 * It never rewrites text: each statement is the ORIGINAL substring, comments preserved, with only
 * the surrounding whitespace and the terminating `;` removed. Text that holds no token but
 * whitespace and comments is no statement. An unterminated string or comment ends the input as
 * one last statement, for SQLite to refuse when it runs.
 *
 * **Source.** `sqlite3_complete()` in `src/complete.c` of the SQLite source tree — the build
 * without SQLITE_OMIT_TRIGGER, whose table carries the trigger states. It was ported from that
 * function's documented token classes and transition table, not machine-translated, and it is held
 * to SQLite by behaviour rather than by a version stamp: `SPLIT_CASES` runs differentially against
 * the SQLite better-sqlite3 bundles (3.53.4 at the time of writing) and statement by statement in
 * workerd's (3.47.0). If SQLite ever changes what completes a statement, those tests are where it
 * shows.
 *
 * **Why this is not built on `tokenizeSql` (contracts), and should not be "unified" with it.**
 * The two answer different questions. `tokenizeSql` finds the NAMES a statement touches, for the
 * spine guard and the dump checks: it folds string literals and quoted identifiers into one
 * "quoted" class, merges dotted names, drops whitespace and most punctuation, and carries no source
 * offsets. Where a statement ENDS is a different grammar — SQLite's own, with its trigger nesting —
 * and it needs offsets into the original text so nothing is ever spliced. Re-deriving that rule
 * over a tokenizer built for the other job is how the hand-rolled splitter this replaced came to
 * cut `CASE … END;`, split a quoted `;` and glue `CREATE/*c*\/TABLE`. One splitter, and it is
 * SQLite's rule.
 */

const TK_SEMI = 0;
const TK_WS = 1;
const TK_OTHER = 2;
const TK_EXPLAIN = 3;
const TK_CREATE = 4;
const TK_TEMP = 5;
const TK_TRIGGER = 6;
const TK_END = 7;

/** complete.c's `trans[8][8]`: [state][token] → next state. State 1 is START. */
const TRANS: readonly (readonly number[])[] = [
  /*                SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END */
  /* 0 INVALID: */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1   START: */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2  NORMAL: */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 EXPLAIN: */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4  CREATE: */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 TRIGGER: */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6    SEMI: */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7     END: */ [1, 7, 5, 5, 5, 5, 5, 5],
];
const START = 1;

/** SQLite's `IdChar`: ASCII letters, digits, `_`, `$`, and every byte at or above 0x80. */
const isIdChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

const KEYWORDS: Readonly<Record<string, number>> = {
  create: TK_CREATE,
  temp: TK_TEMP,
  temporary: TK_TEMP,
  trigger: TK_TRIGGER,
  end: TK_END,
  explain: TK_EXPLAIN,
};

/** One statement's place in the source: its span, and the comment spans inside it. */
interface ScannedStatement {
  readonly start: number;
  readonly end: number;
  readonly comments: readonly (readonly [number, number])[];
}

/** The scanner both functions below share: complete.c's tokens and transitions, nothing else. */
function scanSqlStatements(sql: string): ScannedStatement[] {
  const out: ScannedStatement[] = [];
  const n = sql.length;
  let state = 0;
  let start = 0;
  let comments: [number, number][] = [];
  /** Whether a token other than whitespace or a comment has been seen since `start`. */
  let substantive = false;
  let i = 0;
  const emit = (end: number): void => {
    if (substantive && sql.slice(start, end).trim()) out.push({ start, end, comments });
  };
  while (i < n) {
    const c = sql[i]!;
    let token: number;
    let next = i + 1;
    if (c === ';') {
      token = TK_SEMI;
    } else if (c === ' ' || c === '\r' || c === '\t' || c === '\n' || c === '\f') {
      token = TK_WS;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      next = close === -1 ? n : close + 2;
      comments.push([i, next]);
      token = TK_WS;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      next = nl === -1 ? n : nl + 1;
      comments.push([i, next]);
      token = TK_WS;
    } else if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      next = close === -1 ? n : close + 1;
      token = TK_OTHER;
    } else if (c === '`' || c === '"' || c === "'") {
      // As complete.c scans it: to the next same quote. A doubled quote is the next token
      // starting at once with the same quote, which lands in the same place.
      const close = sql.indexOf(c, i + 1);
      next = close === -1 ? n : close + 1;
      token = TK_OTHER;
    } else if (isIdChar(c)) {
      while (next < n && isIdChar(sql[next]!)) next += 1;
      token = KEYWORDS[sql.slice(i, next).toLowerCase()] ?? TK_OTHER;
    } else {
      token = TK_OTHER;
    }
    if (token !== TK_WS && token !== TK_SEMI) substantive = true;
    state = TRANS[state]![token]!;
    if (token === TK_SEMI && state === START) {
      emit(i);
      start = next;
      comments = [];
      substantive = false;
    }
    i = next;
  }
  emit(n);
  return out;
}

/**
 * The statements in `sql`, in order, each its original text without the terminating `;`.
 * Name and signature are stable: every caller that needs a statement's TEXT — to log it, to show
 * it, to hash it, to read which tables it names — uses it.
 */
export function splitSqlStatements(sql: string): string[] {
  return scanSqlStatements(sql).map((st) => sql.slice(st.start, st.end).trim());
}

/**
 * The same statements, at the same boundaries, as the text to EXECUTE: every comment replaced
 * by whitespace of the same length (a newline stays a newline), strings and quoted identifiers
 * untouched. Every caller that runs SQL statement by statement — a module's migrations, the
 * kernel's own DDL, on both adapters — runs this, never `splitSqlStatements`' text.
 *
 * Why: SQLite stores a `CREATE TABLE`'s text as written, and its `ALTER TABLE … DROP COLUMN`
 * rewrites that stored text. workerd's SQLite fails the rewrite with "incomplete input" when the
 * dropped column is the last one and line comments come before it — so a module whose migration
 * created a commented table could never drop that column later, and a failed migration closes the
 * scope. Blanking the comments before execution keeps the stored DDL free of them on both hosts.
 * The one scanner decides what a comment is, so there is no second grammar to drift.
 */
export function executableSqlStatements(sql: string): string[] {
  return scanSqlStatements(sql).map((st) => {
    let text = '';
    let at = st.start;
    for (const [from, to] of st.comments) {
      text += sql.slice(at, from) + sql.slice(from, to).replace(/[^\n]/g, ' ');
      at = to;
    }
    return (text + sql.slice(at, st.end)).trim();
  });
}
