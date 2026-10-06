import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '@substrat-run/kernel';
import { SPLIT_CASES } from '@substrat-run/contract-tests';

/**
 * #2068, Codex #2084 r4 — `splitSqlStatements` held to SQLite itself, differentially.
 *
 * Each case runs once as a whole blob (`exec`, which SQLite splits itself) and once statement by
 * statement through the splitter, on two fresh databases, and the two must end identical: schema,
 * temp schema and every row. A split that cuts a statement or glues two together either fails to
 * execute or leaves a different database. This host runs every authored migration through the
 * splitter, so this is also the proof that it executes what `exec` of the whole blob used to.
 */
function snapshot(db: Database.Database): unknown {
  const schema = db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all() as { type: string; name: string }[];
  const temp = db.prepare('SELECT type, name, sql FROM temp.sqlite_master ORDER BY type, name').all();
  const rows = schema
    .filter((o) => o.type === 'table' && !o.name.startsWith('sqlite_'))
    .map((o) => [o.name, db.prepare(`SELECT * FROM "${o.name.replace(/"/g, '""')}"`).all()]);
  return { schema, temp, rows };
}

describe('splitSqlStatements against better-sqlite3 (#2068)', () => {
  for (const c of SPLIT_CASES) {
    it(`${c.name}: statement by statement leaves the database the whole blob leaves`, () => {
      const pieces = splitSqlStatements(c.sql);
      expect(pieces).toHaveLength(c.statements);
      const whole = new Database(':memory:');
      whole.exec(c.sql);
      const split = new Database(':memory:');
      for (const piece of pieces) split.exec(piece);
      expect(snapshot(split)).toEqual(snapshot(whole));
    });
  }
});
