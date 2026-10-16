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

/**
 * The fence's verdict on the same sequence, as both adapters run it: inside one transaction.
 * `temp`: refused before running because it makes a TEMP object, which a Durable Object refuses.
 */
function fenced(setup: string, statements: readonly string[]): 'applied' | 'refused' | 'temp' {
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
    if (errorCodeOf(err) === 'validation_failed' && /creates a TEMP object/.test((err as Error).message)) return 'temp';
    if (errorCodeOf(err) !== 'forbidden') throw err;
    return 'refused';
  }
}

const tablesOf = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

/**
 * Every sequence of 1…`max` items, depth first. A sequence SQLite refuses is `prune`d, and none
 * that extends it is generated: it would fail at the same statement. Most of the space is refused,
 * so this is what keeps the walk to a few thousand migrations.
 */
function* sequences<T>(items: readonly T[], max: number, prefix: T[] = []): Generator<{ seq: T[]; prune: () => void }> {
  for (const item of items) {
    const seq = [...prefix, item];
    let dead = false;
    yield { seq, prune: () => (dead = true) };
    if (!dead && seq.length < max) yield* sequences(items, max, seq);
  }
}

/** A bound for a walk on a slow, shared CI runner; it takes a few seconds locally. */
const WALK_TIMEOUT_MS = 120_000;

describe('the data-loss fence agrees with ground truth on every short migration (#115)', () => {
  /**
   * Table level: `names` are the tables a statement may name; the first three exist and hold rows
   * (2, 3 and 1), any further one starts free. `kinds` picks the statements. Every sequence up to
   * `max`, in two catalogue orders.
   */
  const tableLevel = (names: readonly string[], kinds: readonly string[], max: number) => {
    const N = names.slice(0, 3);
    const ROWS: Record<string, number> = { a: 2, b: 3, c: 1 };
    const tags = (t: string) => Array.from({ length: ROWS[t]! }, (_, i) => `${t}${i + 1}`);
    const create = (t: string) => `CREATE TABLE ${t} (tag TEXT); INSERT INTO ${t} VALUES ${tags(t).map((g) => `('${g}')`).join(', ')};`;
    const setups = [N.map(create).join('\n'), [...N].reverse().map(create).join('\n')];

    const statements: string[] = [];
    for (const x of names) {
      if (kinds.includes('drop')) statements.push(`DROP TABLE ${x}`);
      if (kinds.includes('create')) statements.push(`CREATE TABLE ${x} (tag TEXT)`);
      if (kinds.includes('delete')) statements.push(`DELETE FROM ${x}`);
      for (const y of names) {
        if (x === y) continue;
        if (kinds.includes('rename')) statements.push(`ALTER TABLE ${x} RENAME TO ${y}`);
        if (kinds.includes('copy')) statements.push(`INSERT INTO ${x} SELECT * FROM ${y}`);
        if (kinds.includes('create-as')) statements.push(`CREATE TABLE ${x} AS SELECT * FROM ${y}`);
        if (kinds.includes('qualified')) statements.push(`ALTER TABLE main.${x} RENAME TO "${y}"`);
      }
      if (kinds.includes('qualified')) statements.push(`DROP TABLE "${x}"`, `DROP TABLE IF EXISTS "main"."${x}"`);
      if (kinds.includes('temp')) statements.push(`CREATE TEMP TABLE ${x} (tag TEXT)`, `CREATE TABLE temp.${x} (tag TEXT)`);
    }
    /** A statement's table name, as SQLite resolves it: unquoted, `main.` stripped. */
    const nameOf = (word: string) => word.replace(/"/g, '').replace(/^main\./, '');

    let checked = 0;
    const unexplained: string[] = [];
    for (const setup of setups) {
      for (const { seq, prune } of sequences(statements, max)) {
        const truth = raw(setup, seq);
        if (!truth) {
          prune();
          continue;
        }
        checked += 1;
        // A TEMP object is refused whatever else the migration does, so nothing extends it.
        if (seq.some((s) => /^CREATE (TEMP |TABLE temp\.)/.test(s))) {
          prune();
          const verdict = fenced(setup, seq);
          if (verdict !== 'temp') unexplained.push(`a TEMP object was ${verdict}, not refused: ${seq.join('; ')}`);
          continue;
        }
        // Which original table holds each name at the end, as SQLite resolves them in order.
        const holder = new Map(N.map((t) => [t, t]));
        const dropped = new Set<string>();
        for (const s of seq) {
          const w = s.replace('IF EXISTS ', '').split(' ');
          if (w[0] === 'DROP') {
            const id = holder.get(nameOf(w[2]!));
            holder.delete(nameOf(w[2]!));
            if (id && N.includes(id)) dropped.add(id);
          } else if (w[0] === 'CREATE') holder.set(w[2]!, `new:${w[2]}`);
          else if (w[0] === 'ALTER') {
            holder.set(nameOf(w[5]!), holder.get(nameOf(w[2]!))!);
            holder.delete(nameOf(w[2]!));
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
        // The residual classes, by name: what counting cannot tell from a lossless migration.
        const explained = (t: string): 'in-place' | 'recreated' | undefined => {
          const at = identityOf(t);
          if (at !== undefined && !dropped.has(t) && rowsOf(at).length >= ROWS[t]!) return 'in-place';
          // Made AGAIN: the name is held by a table a CREATE made, never by one renamed onto it.
          if (dropped.has(t) && holder.get(t)?.startsWith('new:') && rowsOf(t).length >= ROWS[t]!) return 'recreated';
          return undefined;
        };
        const verdict = fenced(setup, seq);
        const label = `${setup.startsWith('CREATE TABLE a') ? 'abc' : 'cba'}: ${seq.join('; ')}`;
        if (verdict === 'applied') {
          for (const t of lost) if (!explained(t)) unexplained.push(`applied but ${t} lost rows: ${label}`);
        } else if (lost.length === 0 && N.every(preserved)) {
          // Anything else refused without a loss is `copied`: rows living under another identity.
          unexplained.push(`refused though every table kept its rows: ${label}`);
        }
      }
    }
    return { checked, unexplained };
  };

  it('table level: drops, creates, renames, copies and deletes over three populated tables', () => {
    const { checked, unexplained } = tableLevel(['a', 'b', 'c'], ['drop', 'create', 'delete', 'rename', 'copy', 'create-as'], 3);
    expect(unexplained).toEqual([]);
    expect(checked).toBeGreaterThan(3_000);
  }, WALK_TIMEOUT_MS);

  it('table level: drops, renames and rebuilds with a free fourth name', () => {
    const { checked, unexplained } = tableLevel(['a', 'b', 'c', 'd'], ['drop', 'rename', 'create-as'], 3);
    expect(unexplained).toEqual([]);
    expect(checked).toBeGreaterThan(1_000);
  }, WALK_TIMEOUT_MS);

  it('table level: the same through qualified and quoted names, and TEMP objects, which are refused', () => {
    const { checked, unexplained } = tableLevel(['a', 'b', 'c', 'd'], ['qualified', 'temp', 'create-as'], 3);
    expect(unexplained).toEqual([]);
    expect(checked).toBeGreaterThan(1_000);
  }, WALK_TIMEOUT_MS);

  it('column level: drops, adds and renames of columns, with the table moved aside and back and rebuilt in place', () => {
    const setup = `CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT, w TEXT);
      INSERT INTO a VALUES ('1', 'v1', 'w1'), ('2', 'v2', 'w2');`;
    const C = ['v', 'w', 'u'];
    const steps: string[] = ['MOVE', 'REBUILD'];
    for (const x of C) {
      steps.push(`DROP COLUMN ${x}`, `ADD COLUMN ${x} TEXT`);
      for (const y of C) if (x !== y) steps.push(`RENAME COLUMN ${x} TO ${y}`);
    }
    /**
     * The statements a step sequence is, with the table's current name filled in. `REBUILD` is the
     * rebuild back into place — copy aside, drop, rename the copy onto the original name — which
     * is where the column lookup falls back to original names; it is a rebuild only under the
     * table's original name, so elsewhere it is made a statement SQLite refuses, and pruned.
     */
    const toSql = (seq: readonly string[]): string[] => {
      let at = 'a';
      return seq.flatMap((step) => {
        if (step === 'REBUILD') {
          if (at !== 'a') return ['SELECT * FROM not_a_rebuild'];
          return ['CREATE TABLE n AS SELECT * FROM a', 'DROP TABLE a', 'ALTER TABLE n RENAME TO a'];
        }
        if (step !== 'MOVE') return [`ALTER TABLE ${at} ${step}`];
        const to = at === 'a' ? 'z' : 'a';
        const s = `ALTER TABLE ${at} RENAME TO ${to}`;
        at = to;
        return [s];
      });
    };

    let checked = 0;
    const disagree: string[] = [];
    for (const { seq, prune } of sequences(steps, 4)) {
      const statements = toSql(seq);
      const truth = raw(setup, statements);
      if (!truth) {
        prune();
        continue;
      }
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
  }, WALK_TIMEOUT_MS);
});
