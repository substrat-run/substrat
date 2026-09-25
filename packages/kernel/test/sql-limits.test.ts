import { describe, expect, it } from 'vitest';
import { DO_SQL_LIMITS, assertWithinSqlLimits, guardSqlLimits, type ScopedSql } from '../src/index.js';

/**
 * The scanner behind `guardSqlLimits` (#1741). What the hosted values ARE is pinned against a
 * real Durable Object in adapter-cloudflare; what the adapters do with a statement end to end
 * is the contract suite. This is the scanner's own edge cases — the ones where a naive count
 * refuses a statement a DO runs, or runs one it refuses.
 */
const { compoundTerms: T, boundParameters: P } = DO_SQL_LIMITS;
const terms = (n: number, op = 'UNION ALL'): string => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(` ${op} `);

describe('compound terms', () => {
  it('counts operands, not operators: the limit passes, one more is refused', () => {
    expect(() => assertWithinSqlLimits(terms(T))).not.toThrow();
    expect(() => assertWithinSqlLimits(terms(T + 1))).toThrow('too many terms in compound SELECT: SQLITE_ERROR');
  });

  it('counts mixed operators as one chain', () => {
    expect(() => assertWithinSqlLimits('SELECT 1 UNION SELECT 2 UNION ALL SELECT 3 INTERSECT SELECT 4 EXCEPT SELECT 5 UNION SELECT 6')).toThrow(/compound/);
  });

  it('is case-insensitive', () => {
    expect(() => assertWithinSqlLimits(terms(T + 1, 'union all'))).toThrow(/compound/);
  });

  it('gives each parenthesised subquery its own count', () => {
    const sub = `(${terms(T)})`;
    expect(() => assertWithinSqlLimits(`SELECT * FROM ${sub} WHERE x IN ${sub} UNION ALL SELECT 1`)).not.toThrow();
    expect(() => assertWithinSqlLimits(`SELECT * FROM (${terms(T + 1)})`)).toThrow(/compound/);
  });

  it('starts a new count after a semicolon', () => {
    expect(() => assertWithinSqlLimits(`${terms(T)}; ${terms(T)}`)).not.toThrow();
  });

  it('ignores the words in strings, quoted identifiers and comments, and a column named so', () => {
    expect(() =>
      assertWithinSqlLimits(
        `SELECT 'a UNION b UNION c UNION d UNION e UNION f', "UNION", [union], \`union\`, t.union /* UNION UNION UNION UNION UNION UNION */ -- UNION UNION UNION UNION UNION UNION\n FROM t`,
      ),
    ).not.toThrow();
  });

  it('does not lose its place after an escaped quote', () => {
    expect(() => assertWithinSqlLimits(`SELECT 'it''s' ${'UNION ALL SELECT 1 '.repeat(T)}`)).toThrow(/compound/);
  });

  it('does not count a UNION that is only part of a longer word', () => {
    expect(() => assertWithinSqlLimits(`SELECT ${Array.from({ length: 20 }, (_, i) => `unions${i}`).join(', ')} FROM t`)).not.toThrow();
  });
});

describe('bound parameters', () => {
  const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

  it('counts the highest number: P pass, P + 1 refused with the offset SQLite reports', () => {
    expect(() => assertWithinSqlLimits(`SELECT ${marks(P)}`)).not.toThrow();
    expect(() => assertWithinSqlLimits(`SELECT ${marks(P + 1)}`)).toThrow(`too many SQL variables at offset ${'SELECT '.length + 2 * P}: SQLITE_ERROR`);
  });

  it('numbers explicit ?N as SQLite does, so a gap counts', () => {
    expect(() => assertWithinSqlLimits(`SELECT ?${P}`)).not.toThrow();
    expect(() => assertWithinSqlLimits(`SELECT ?${P + 1}`)).toThrow(`variable number must be between ?1 and ?${P} at offset 7: SQLITE_ERROR`);
    expect(() => assertWithinSqlLimits('SELECT ?0')).toThrow(/variable number must be between/);
    expect(() => assertWithinSqlLimits(`SELECT ?${P}, ?`)).toThrow(/too many SQL variables/);
  });

  it('counts a named parameter once, however often it is written', () => {
    const sql = `SELECT ${Array.from({ length: P * 2 }, () => ':a').join('+')}, @b, $c`;
    expect(() => assertWithinSqlLimits(sql)).not.toThrow();
    expect(() => assertWithinSqlLimits(`SELECT ${Array.from({ length: P + 1 }, (_, i) => `:p${i}`).join(',')}`)).toThrow(/too many SQL variables/);
  });

  it('reads an extended $name as ONE token, the way SQLite tokenizes it (::, and a (…) suffix)', () => {
    // 60 distinct extended names is 60 variables. A scanner that stopped at `::` or `(` would
    // read each as several and refuse this statement, which a Durable Object runs.
    const sql = `SELECT ${Array.from({ length: 60 }, (_, i) => `$ns${i}::part(arg${i})`).join(' + ')}`;
    expect(() => assertWithinSqlLimits(sql)).not.toThrow();
    expect(() => assertWithinSqlLimits(`SELECT ${Array.from({ length: 60 }, () => '$a::b(c) + $a::b(c)').join(' + ')}`)).not.toThrow();
    // A(b c) ends at the space: `$a(b` is the parameter, and `c)` are other tokens.
    expect(() => assertWithinSqlLimits('SELECT $a(b c) FROM t')).not.toThrow();
    // …and the count is still right past the limit.
    const over = `SELECT ${Array.from({ length: P + 1 }, (_, i) => `$ns${i}::part(arg)`).join(' + ')}`;
    expect(() => assertWithinSqlLimits(over)).toThrow(/too many SQL variables/);
  });

  it('counts one slot per DISTINCT token, sigil included: :x twice is one, :x and @x are two', () => {
    const many = (token: string, n: number): string => `SELECT ${Array.from({ length: n }, () => token).join('+')}`;
    expect(() => assertWithinSqlLimits(many(':x', P * 3))).not.toThrow();
    const both = `SELECT ${Array.from({ length: P / 2 + 1 }, (_, i) => `:x${i} + @x${i}`).join(' + ')}`;
    expect(() => assertWithinSqlLimits(both)).toThrow(/too many SQL variables/);
    const same = `SELECT ${Array.from({ length: P }, (_, i) => `:x${i} + :x${i}`).join(' + ')}`;
    expect(() => assertWithinSqlLimits(same)).not.toThrow();
  });

  it('numbers again from one in each statement of a multi-statement string', () => {
    expect(() => assertWithinSqlLimits(`SELECT ${marks(P)}; SELECT ${marks(P)}`)).not.toThrow();
  });

  it('does not read a question mark in a string, a comment or a quoted name as a parameter', () => {
    expect(() => assertWithinSqlLimits(`SELECT '${'?'.repeat(P * 2)}' /* ${'?'.repeat(P * 2)} */ -- ${'?'.repeat(P * 2)}\n, "${'?'.repeat(P * 2)}"`)).not.toThrow();
  });

  it('reports the offset in bytes, as SQLite does', () => {
    expect(() => assertWithinSqlLimits(`SELECT 'é', ${marks(P + 1)}`)).toThrow(`at offset ${"SELECT 'é', ".length + 1 + 2 * P}:`);
  });
});

describe('statement length', () => {
  it('is measured in UTF-8 bytes, not characters', () => {
    const at = (bytes: number): string => `SELECT '${'a'.repeat(bytes - 9)}'`;
    expect(() => assertWithinSqlLimits(at(DO_SQL_LIMITS.statementBytes))).not.toThrow();
    expect(() => assertWithinSqlLimits(at(DO_SQL_LIMITS.statementBytes + 1))).toThrow('statement too long: SQLITE_TOOBIG');
    expect(() => assertWithinSqlLimits(`SELECT '${'é'.repeat(DO_SQL_LIMITS.statementBytes / 2)}'`)).toThrow('statement too long');
  });
});

describe('guardSqlLimits', () => {
  it('judges both doors, and reaches the inner connection only for a statement within the limits', () => {
    const seen: string[] = [];
    const inner: ScopedSql = {
      query: (sql) => (seen.push(sql), []),
      exec: (sql) => (seen.push(sql), { changes: 0 }),
    };
    const guarded = guardSqlLimits(inner);
    guarded.query('SELECT 1');
    guarded.exec('DELETE FROM t');
    expect(() => guarded.query(terms(T + 1))).toThrow(/compound/);
    expect(() => guarded.exec(`DELETE FROM t WHERE id IN (${Array.from({ length: P + 1 }, () => '?').join(',')})`)).toThrow(/too many SQL variables/);
    expect(seen).toEqual(['SELECT 1', 'DELETE FROM t']);
  });
});
