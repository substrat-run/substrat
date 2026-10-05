import { describe, expect, it } from 'vitest';
import { assertNoReservedColumnWrite } from '../src/index.js';

/**
 * The SET scanner, generated (#119, Codex r2): random assignment lists whose VALUES carry
 * everything that confused the first two scanners — nested `CASE … END`, subqueries with their
 * own `FROM`/`WHERE`, strings and comments holding `END`, commas and `_substrat_…`, and every
 * identifier quote style — in each statement a target can sit in. The guard must refuse
 * EXACTLY when some target is a `_substrat_*` column, never because a value mentions one.
 *
 * Seeded, so a failure names a reproducible case.
 */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plain targets include every keyword the scanners key on that SQLite also accepts as an
 * unquoted identifier (asked of SQLite itself: end, begin, replace, ignore, rename, with, temp…).
 * The reserved ones (set, case, where, from, returning, order, limit, as, to, on) cannot be.
 */
const PLAIN = ['title', '"title"', '[owner]', '`owner`', '"weird, END name"', 'done', 'end', 'begin', 'replace', 'ignore', 'rename', 'with', 'temp'];
const RESERVED = ['_substrat_trashed_at', '"_substrat_archived_at"', '[_SUBSTRAT_TRASHED_AT]', '`_substrat_archived_at`'];

describe('assertNoReservedColumnWrite: generated SET lists', () => {
  const next = rng(119);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;

  const value = (depth: number): string => {
    const leaves = [
      '1',
      'NULL',
      "'END'",
      "'a, _substrat_trashed_at = NULL'",
      '"title"',
      '_substrat_archived_at',
      "'it''s END, really'",
      'end',
      'begin',
      'replace',
      '(SELECT title AS end FROM other)',
      '(SELECT 1 AS begin)',
      '(SELECT ignore AS "returning" FROM other WHERE with = 1)',
    ];
    if (depth >= 3) return pick(leaves);
    switch (Math.floor(next() * 8)) {
      case 0:
        return `CASE WHEN ${value(depth + 1)} THEN ${value(depth + 1)} ELSE ${value(depth + 1)} END`;
      case 1:
        return `CASE ${value(depth + 1)} WHEN 1 THEN ${value(depth + 1)} END`;
      case 2:
        return `(SELECT title FROM other WHERE id = 'x' AND _substrat_trashed_at IS NULL ORDER BY 1 LIMIT 1)`;
      case 3:
        return `replace(${value(depth + 1)}, ',', 'END')`;
      case 4:
        return `${value(depth + 1)} || ${value(depth + 1)}`;
      case 5:
        return `/* END, _substrat_trashed_at = NULL */ ${value(depth + 1)}`;
      case 6:
        return `coalesce(${value(depth + 1)}, (${value(depth + 1)}))`;
      default:
        return pick(leaves);
    }
  };

  const assignments = (): { sql: string; reserved: boolean } => {
    const n = 1 + Math.floor(next() * 4);
    const parts: string[] = [];
    let reserved = false;
    for (let a = 0; a < n; a += 1) {
      const bad = next() < 0.3;
      reserved ||= bad;
      const target = () => (bad ? pick(RESERVED) : pick(PLAIN));
      if (next() < 0.15) {
        // A row-value target: one reserved name in it is enough.
        const names = [pick(PLAIN), target()];
        parts.push(`(${names.join(', ')}) = (${value(1)}, ${value(1)})`);
      } else {
        parts.push(`${target()} = ${value(0)}`);
      }
    }
    return { sql: parts.join(', '), reserved };
  };

  const forms = [
    (list: string) => `UPDATE docs SET ${list} WHERE id = 'x' AND _substrat_trashed_at IS NULL`,
    (list: string) => `UPDATE OR ABORT docs SET ${list}`,
    (list: string) =>
      `INSERT INTO docs (id, title) VALUES ('x', 't') ON CONFLICT (id) DO UPDATE SET ${list} WHERE excluded.id = 'x'`,
    (list: string) => `CREATE TRIGGER tr AFTER INSERT ON other BEGIN UPDATE docs SET ${list}; END`,
    (list: string) => `UPDATE docs SET title = 1; UPDATE docs SET ${list} RETURNING id`,
    // Keywords-as-identifiers around the list: a CTE named `end`, a table aliased `begin`.
    (list: string) => `WITH end AS (SELECT 1 AS begin) UPDATE docs SET ${list} WHERE id IN (SELECT begin FROM end)`,
    (list: string) => `UPDATE docs AS begin SET ${list} WHERE begin.id = 'x'`,
  ];

  const cases = Array.from({ length: 600 }, (_, n) => {
    const { sql, reserved } = assignments();
    return { n, sql: pick(forms)(sql), reserved };
  });

  it('generates both kinds of case in quantity', () => {
    expect(cases.filter((c) => c.reserved).length).toBeGreaterThan(150);
    expect(cases.filter((c) => !c.reserved).length).toBeGreaterThan(150);
  });

  it('refuses exactly the statements that assign a _substrat_* column', () => {
    for (const c of cases) {
      const refused = (() => {
        try {
          assertNoReservedColumnWrite(c.sql);
          return false;
        } catch {
          return true;
        }
      })();
      expect(refused, `case ${c.n}: ${c.sql}`).toBe(c.reserved);
    }
  });

  it('refuses the round-2 bypass: a CASE … END before the reserved target', () => {
    expect(() =>
      assertNoReservedColumnWrite(`UPDATE docs SET title = CASE WHEN 1 THEN 'x' ELSE title END, _substrat_trashed_at = NULL`),
    ).toThrow(/platform's column/);
  });
});
