/**
 * One SQL scanner, for every place that has to read a table name out of SQL text it did not
 * write: the spine write guard (`assertNoSpineWrite`, #954), a dump's replay check
 * (`assertReplayableDump`, #1898), and the CLI's foreign-key ordering of a dump. The CLI's
 * was a regex wanting whitespace after `REFERENCES`, so a comment there, which SQLite reads as
 * whitespace, hid the table from it.
 *
 * The scan tokenises OUTSIDE comments and string literals but KEEPS quoted identifiers as
 * tokens — `INSERT INTO "_substrat_tuples"` is the first thing anyone tries, and a scanner
 * that skips quotes hands it through. Dotted names (`main._substrat_tuples`) merge into one
 * token.
 */

/**
 * The platform spine's table prefix — the same one `isSystemTable` groups on, the one the
 * spine guard protects, and the one a restore builds from the kernel's DDL (`isSpineTable`,
 * #1883). Compared lowercased: SQLite matches table names without regard to case, so
 * `_SUBSTRAT_TUPLES` is the tuples table.
 */
export const SPINE_PREFIX = '_substrat';

export interface SqlToken {
  /** The identifier text, unquoted; dotted names joined with `.`. */
  readonly text: string;
  /** A quoted identifier or string literal — never read as a keyword. */
  readonly quoted: boolean;
  /**
   * One of `( ) , = ;`, present only when asked for (`{ punctuation: true }`). A reader that
   * has to know WHERE in a statement a name sits — an assignment target, a column list — needs
   * these; one that only looks for table names does not, and gets the same tokens it always did.
   */
  readonly punct?: true;
}

const PUNCTUATION = new Set(['(', ')', ',', '=', ';']);

/** The statement text as identifier and keyword tokens, comments and whitespace dropped. */
export function tokenizeSql(sql: string, options?: { readonly punctuation?: boolean }): SqlToken[] {
  const tokens: SqlToken[] = [];
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
    // Look ahead for the dot that joins this name to the next part. SQLite treats a
    // COMMENT as whitespace, so `main /* … */ . _substrat_tuples` is one qualified
    // name — skipping only spaces here would record `main` as the target and miss it.
    let j = i;
    for (;;) {
      if (j < n && /\s/.test(sql[j]!)) {
        j += 1;
        continue;
      }
      if (sql[j] === '-' && sql[j + 1] === '-') {
        while (j < n && sql[j] !== '\n') j += 1;
        continue;
      }
      if (sql[j] === '/' && sql[j + 1] === '*') {
        j += 2;
        while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j += 1;
        j += 2;
        continue;
      }
      break;
    }
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
    if (options?.punctuation && PUNCTUATION.has(c)) tokens.push({ text: c, quoted: false, punct: true });
    i += 1;
  }
  return tokens;
}

/** True when any part of a (possibly dotted, possibly quoted) name is a spine table. */
export function namesSpineTable(name: string): boolean {
  return name.split('.').some((part) => part.toLowerCase().startsWith(SPINE_PREFIX));
}

/**
 * The tables a statement's `REFERENCES` clauses name, in order, unquoted and as spelled.
 * A `REFERENCES` that is itself quoted (a column called "references") is not a keyword.
 */
export function referencedTables(sql: string): string[] {
  return referencedTablesIn(tokenizeSql(sql));
}

/** `referencedTables` over a statement already tokenized, for a caller that scans it anyway. */
export function referencedTablesIn(tokens: readonly SqlToken[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]!;
    if (!token.quoted && token.text.toLowerCase() === 'references') out.push(tokens[i + 1]!.text);
  }
  return out;
}
