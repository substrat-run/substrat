import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
import { runMigrationStatements, type ScopedSql, type SqlValue } from '../src/index.js';

/**
 * #115 — the data-loss fence against ground truth, over every short migration a small grammar
 * makes. Three rounds of review found holes by brute force; this keeps that search in the suite.
 *
 * Each sequence runs twice on a fresh in-memory scope: once raw, to see what really happened to
 * every tagged value, and once through `runMigrationStatements`, for the fence's verdict. A
 * sequence SQLite refuses is skipped. The verdict must agree with the ground truth, except in the
 * residual classes counting cannot see, which are named here and nowhere else:
 *
 * - `in-place`: a table that kept its identity holds as many rows as before, but not the same ones
 *   (`DELETE` + `INSERT`), so it passes although rows are gone;
 * - `recreated`: a table was dropped and its original name made again holding as many rows, which
 *   counts as the create-copy-drop-rename rebuild the fence must accept;
 * - `copied`: every value survives, but a table's rows now live under another table's identity —
 *   refused until `moves` declares it, by design.
 *
 * Deterministic and bounded: every sequence up to a fixed length, in two catalogue orders.
 */

type Db = DatabaseSync;
const sqlOf = (db: Db): ScopedSql => ({
  query: <T>(q: string, p: readonly SqlValue[] = []) => db.prepare(q).all(...(p as never[])) as T[],
  exec: (q: string, p: readonly SqlValue[] = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
});

/** Run `statements` raw; undefined when SQLite refuses one (the sequence is not a migration). */
function raw(setup: string, statements: readonly string[]): Db | undefined {
  const db = new DatabaseSync(':memory:');
  db.exec(setup);
  try {
    for (const s of statements) db.exec(s);
    return db;
  } catch {
    return undefined;
  }
}

/** The fence's verdict on the same sequence, as both adapters run it: inside one transaction. */
function fenced(setup: string, statements: readonly string[]): 'applied' | 'refused' {
  const db = new DatabaseSync(':memory:');
  db.exec(setup);
  db.exec('BEGIN');
  try {
    runMigrationStatements(sqlOf(db), { version: '0002', sql: statements.map((s) => `${s};`).join('\n') }, (st) => db.exec(st), {
      key: 'p@0002',
      authored: true,
    });
    db.exec('COMMIT');
    return 'applied';
  } catch (err) {
    db.exec('ROLLBACK');
    if (errorCodeOf(err) !== 'forbidden') throw err;
    return 'refused';
  }
}

const tablesOf = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

/** Every sequence of 1…`max` items. */
function* sequences<T>(items: readonly T[], max: number, prefix: T[] = []): Generator<T[]> {
  if (prefix.length > 0) yield prefix;
  if (prefix.length === max) return;
  for (const item of items) yield* sequences(items, max, [...prefix, item]);
}

describe('the data-loss fence agrees with ground truth on every short migration (#115)', () => {
  it('table level: drops, creates, renames, copies and deletes over three populated tables', () => {
    const N = ['a', 'b', 'c'];
    const ROWS: Record<string, number> = { a: 2, b: 3, c: 1 };
    const tags = (t: string) => Array.from({ length: ROWS[t]! }, (_, i) => `${t}${i + 1}`);
    const create = (t: string) => `CREATE TABLE ${t} (tag TEXT); INSERT INTO ${t} VALUES ${tags(t).map((g) => `('${g}')`).join(', ')};`;
    const setups = [N.map(create).join('\n'), [...N].reverse().map(create).join('\n')];

    const statements: string[] = [];
    for (const x of N) {
      statements.push(`DROP TABLE ${x}`, `CREATE TABLE ${x} (tag TEXT)`, `DELETE FROM ${x}`);
      for (const y of N) {
        if (x === y) continue;
        statements.push(`ALTER TABLE ${x} RENAME TO ${y}`, `INSERT INTO ${x} SELECT * FROM ${y}`, `CREATE TABLE ${x} AS SELECT * FROM ${y}`);
      }
    }

    let checked = 0;
    const unexplained: string[] = [];
    for (const setup of setups) {
      for (const seq of sequences(statements, 3)) {
        const truth = raw(setup, seq);
        if (!truth) continue;
        checked += 1;
        // Which original table holds each name at the end, as SQLite resolves them in order.
        const holder = new Map(N.map((t) => [t, t]));
        const dropped = new Set<string>();
        for (const s of seq) {
          const w = s.split(' ');
          if (w[0] === 'DROP') {
            const id = holder.get(w[2]!);
            holder.delete(w[2]!);
            if (id && N.includes(id)) dropped.add(id);
          } else if (w[0] === 'CREATE') holder.set(w[2]!, `new:${w[2]}`);
          else if (w[0] === 'ALTER') {
            holder.set(w[5]!, holder.get(w[2]!)!);
            holder.delete(w[2]!);
          }
        }
        const rowsOf = (t: string): string[] => (truth.prepare(`SELECT tag FROM ${t}`).all() as { tag: string }[]).map((r) => r.tag);
        const everywhere = new Set(tablesOf(truth).flatMap(rowsOf));
        const identityOf = (t: string) => [...holder].find(([, id]) => id === t)?.[0];
        const lost = N.filter((t) => tags(t).some((g) => !everywhere.has(g)));
        const preserved = (t: string) => {
          const at = identityOf(t);
          return at !== undefined && tags(t).every((g) => rowsOf(at).includes(g));
        };
        const explained = (t: string): string | undefined => {
          const at = identityOf(t);
          if (at !== undefined && !dropped.has(t) && rowsOf(at).length >= ROWS[t]!) return 'in-place';
          if (dropped.has(t) && tablesOf(truth).includes(t) && rowsOf(t).length >= ROWS[t]!) return 'recreated';
          return undefined;
        };
        const verdict = fenced(setup, seq);
        const label = `${setup.startsWith('CREATE TABLE a') ? 'abc' : 'cba'}: ${seq.join('; ')}`;
        if (verdict === 'applied') {
          for (const t of lost) if (!explained(t)) unexplained.push(`applied but ${t} lost rows: ${label}`);
        } else if (lost.length === 0 && N.every(preserved)) {
          unexplained.push(`refused though every table kept its rows: ${label}`);
        }
      }
    }
    expect(unexplained).toEqual([]);
    expect(checked).toBeGreaterThan(3_000);
  });

  it('column level: drops, adds and renames of columns, with the table moved aside and back', () => {
    const setup = `CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT, w TEXT);
      INSERT INTO a VALUES ('1', 'v1', 'w1'), ('2', 'v2', 'w2');`;
    const C = ['v', 'w', 'u'];
    const steps: string[] = ['MOVE'];
    for (const x of C) {
      steps.push(`DROP COLUMN ${x}`, `ADD COLUMN ${x} TEXT`);
      for (const y of C) if (x !== y) steps.push(`RENAME COLUMN ${x} TO ${y}`);
    }
    /** The statements a step sequence is, with the table's current name filled in. */
    const toSql = (seq: readonly string[]): string[] => {
      let at = 'a';
      return seq.map((step) => {
        if (step !== 'MOVE') return `ALTER TABLE ${at} ${step}`;
        const to = at === 'a' ? 'z' : 'a';
        const s = `ALTER TABLE ${at} RENAME TO ${to}`;
        at = to;
        return s;
      });
    };

    let checked = 0;
    const disagree: string[] = [];
    for (const seq of sequences(steps, 4)) {
      const statements = toSql(seq);
      const truth = raw(setup, statements);
      if (!truth) continue;
      checked += 1;
      const table = tablesOf(truth)[0]!;
      const names = (truth.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
      const values = new Set(
        names.flatMap((n) => (truth.prepare(`SELECT "${n}" AS v FROM ${table}`).all() as { v: string | null }[]).map((r) => r.v)),
      );
      const lost = ['v1', 'v2', 'w1', 'w2'].some((g) => !values.has(g));
      const verdict = fenced(setup, statements);
      if ((verdict === 'refused') !== lost) disagree.push(`${verdict} but ${lost ? 'values were lost' : 'nothing was lost'}: ${statements.join('; ')}`);
    }
    expect(disagree).toEqual([]);
    expect(checked).toBeGreaterThan(1_000);
  });
});
