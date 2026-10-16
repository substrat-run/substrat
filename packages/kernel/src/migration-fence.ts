/**
 * The data-loss fence: an authored migration may not lose data a scope holds unless it says so (#115).
 *
 * The planner (`@substrat-run/model-emit`) refuses every destructive diff when it writes a
 * migration, but nothing judged what an AUTHORED migration does to the rows already there: a
 * hand-written `DROP TABLE`, a `DROP COLUMN`, a `DELETE`, or a create-copy-rename rebuild that
 * forgot a column ran unchecked against a scope full of data. This is the check, and it reads
 * what the SQL DID rather than what its text says, so there is no SQL grammar to get wrong.
 *
 * **Measured, not parsed.** Parsing decides only whether to measure: a migration made only of
 * provably additive statements (`CREATE …`, `ALTER TABLE … ADD …`) cannot lose anything and is not
 * measured. Any other statement (any DML, `DROP`, `ALTER … RENAME`/`DROP COLUMN`, `PRAGMA`, `WITH`,
 * a shape nobody listed) measures EVERY module table, not just the ones it names, so a trigger or a
 * foreign-key cascade that reaches another table is seen too. Measured, per table: the rows, and
 * per column the values in each storage class (`typeof`). Once before the first statement and
 * once after the last, inside the migration's transaction, so the intermediate states of a rebuild
 * do not matter and a refusal rolls the whole migration back.
 *
 * **Production data is rows that exist.** A table with no rows may be dropped or rebuilt freely,
 * whatever else is true of the scope; the same migration is refused in a scope where it would
 * lose something. There is no phase flag to forget to flip.
 *
 * **What counts as a loss**, for a table that held rows: it is gone (under its own name, every
 * name `ALTER TABLE … RENAME TO` gave it, and its original name, so a rebuild back into place
 * keeps it); it has fewer rows; one of its columns that held values is gone (`RENAME COLUMN` is
 * followed) or holds fewer of them in some storage class — which is how a narrowing retype shows,
 * `'1.50'` turning into `1`. `NOT NULL` without a default needs no rule: SQLite refuses it itself.
 * What this does not see: values rewritten in place at the same count and class.
 *
 * **Declared losses pass.** `SqlMigration.moves` names data that went elsewhere, and is verified:
 * the target must GAIN at least what its sources held, per class. `SqlMigration.discards` names
 * data deliberately given up, with the reason a reviewer reads. A declaration naming a table or
 * column the scope does not hold before the migration (a move's target excepted, which the
 * migration may create) is an authoring error and refuses the migration too.
 *
 * Kernel-derived DDL is exempt: its tables are indexes, rebuilt from the data this protects.
 */
import { namesSpineTable, substratError, tokenizeSql } from '@substrat-run/contracts';
import type { ScopedSql, SqlMigration } from './scope-host.js';
import { executableSqlStatements } from './sql-statements.js';

/** The storage classes a value can have; NULL is not a value. */
const CLASSES = ['integer', 'real', 'text', 'blob'] as const;
type Classes = Record<(typeof CLASSES)[number], number>;

interface TableCount {
  readonly rows: number;
  /** Lowercased column name → values per storage class. */
  readonly columns: ReadonlyMap<string, Classes>;
}
type Measure = ReadonlyMap<string, TableCount>;

/** Columns measured per query, so a wide table stays far under SQLite's result-column limit. */
const COLUMNS_PER_SCAN = 64;

const lower = (s: string): string => s.toLowerCase();
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const total = (c: Classes): number => CLASSES.reduce((n, k) => n + c[k], 0);
const NONE: Classes = { integer: 0, real: 0, text: 0, blob: 0 };

/** The words of one statement, keywords lowercased; quoted names are kept apart from keywords. */
function words(statement: string): { text: string; quoted: boolean }[] {
  return tokenizeSql(statement).map((t) => ({ text: t.quoted ? t.text : lower(t.text), quoted: t.quoted }));
}

/** A statement that can only define something: it fires nothing and removes nothing. */
function additive(statement: string): boolean {
  const w = words(statement);
  const kw = (i: number): string | undefined => (w[i] && !w[i]!.quoted ? w[i]!.text : undefined);
  if (kw(0) === 'create') return true;
  // `ALTER TABLE <name> ADD [COLUMN] …` — the name is one token, dotted or not.
  return kw(0) === 'alter' && kw(1) === 'table' && kw(3) === 'add';
}

/**
 * The tables this fence measures: the scope's own, without the spine, SQLite's and workerd's
 * internals, and virtual tables with their shadows — an FTS index holds no data of its own.
 */
function measuredTables(sql: ScopedSql): string[] {
  const rows = sql.query<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
  const own = rows.filter((r) => {
    const n = lower(r.name);
    return !namesSpineTable(n) && !n.startsWith('sqlite_') && !n.startsWith('_cf_');
  });
  const virtual = own.filter((r) => /^\s*create\s+virtual\b/i.test(r.sql ?? '')).map((r) => lower(r.name));
  return own
    .map((r) => r.name)
    .filter((name) => !virtual.some((v) => lower(name) === v || lower(name).startsWith(`${v}_`)));
}

function measure(sql: ScopedSql): Measure {
  const out = new Map<string, TableCount>();
  for (const table of measuredTables(sql)) {
    const names = sql.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table]).map((c) => c.name);
    const rows = Number(sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quote(table)}`)[0]!.n);
    const columns = new Map<string, Classes>();
    for (let at = 0; at < names.length && rows > 0; at += COLUMNS_PER_SCAN) {
      const chunk = names.slice(at, at + COLUMNS_PER_SCAN);
      const select = chunk.flatMap((c, i) => CLASSES.map((k) => `COALESCE(SUM(typeof(${quote(c)}) = '${k}'), 0) AS c${i}_${k}`));
      const r = sql.query<Record<string, number>>(`SELECT ${select.join(', ')} FROM ${quote(table)}`)[0]!;
      chunk.forEach((c, i) => {
        columns.set(lower(c), Object.fromEntries(CLASSES.map((k) => [k, Number(r[`c${i}_${k}`])])) as Classes);
      });
    }
    if (rows === 0) for (const c of names) columns.set(lower(c), NONE);
    out.set(lower(table), { rows, columns });
  }
  return out;
}

/** `table` or `table.column`, lowercased. */
interface Target {
  readonly table: string;
  readonly column?: string;
}
function targetOf(spec: string): Target | undefined {
  const parts = spec.trim().split('.');
  if (parts.length > 2 || parts.some((p) => p === '')) return undefined;
  return parts.length === 1 ? { table: lower(parts[0]!) } : { table: lower(parts[0]!), column: lower(parts[1]!) };
}
const show = (t: Target): string => (t.column ? `${t.table}.${t.column}` : t.table);

/** How each table and column was renamed, statement by statement, in the order they ran. */
interface Renames {
  /** Original table → every name it carried, in order. */
  readonly tables: Map<string, string[]>;
  /** Original table → original column → current column name. */
  readonly columns: Map<string, Map<string, string>>;
}

function followRenames(statements: readonly string[], before: Measure): Renames {
  const tables = new Map([...before.keys()].map((t) => [t, [t]]));
  const columns = new Map([...before].map(([t, c]) => [t, new Map([...c.columns.keys()].map((k) => [k, k]))]));
  const holderOf = (current: string): string | undefined =>
    [...tables].find(([, names]) => names[names.length - 1] === current)?.[0];
  for (const statement of statements) {
    const w = words(statement);
    const kw = (i: number): string | undefined => (w[i] && !w[i]!.quoted ? w[i]!.text : undefined);
    if (kw(0) !== 'alter' || kw(1) !== 'table' || kw(3) !== 'rename' || !w[2]) continue;
    const table = lower(w[2].text.replace(/^main\./i, ''));
    const original = holderOf(table);
    if (!original) continue;
    if (kw(4) === 'to' && w[5]) {
      tables.get(original)!.push(lower(w[5].text.replace(/^main\./i, '')));
    } else {
      // RENAME [COLUMN] a TO b
      const k = kw(4) === 'column' ? 5 : 4;
      if (!w[k] || kw(k + 1) !== 'to' || !w[k + 2]) continue;
      const from = lower(w[k]!.text);
      const to = lower(w[k + 2]!.text);
      for (const [orig, current] of columns.get(original)!) if (current === from) columns.get(original)!.set(orig, to);
    }
  }
  return { tables, columns };
}

/** One loss the fence found, and the declaration that would excuse it. */
interface Loss {
  readonly target: Target;
  readonly what: string;
}

/**
 * Compare the two measures: every table that held rows, and every column that held values, must
 * still hold at least as much — following renames — unless it is moved or discarded.
 */
function lossesOf(before: Measure, after: Measure, renames: Renames): Loss[] {
  const losses: Loss[] = [];
  for (const [table, b] of before) {
    if (b.rows === 0) continue;
    const names = renames.tables.get(table)!;
    // The chain's end, then the original name (a rebuild back into place), then any earlier name.
    const end = [names[names.length - 1]!, table, ...[...names].reverse()].find((n) => after.has(n));
    if (end === undefined) {
      losses.push({ target: { table }, what: `table ${table} held ${b.rows} row(s) and is gone` });
      continue;
    }
    const a = after.get(end)!;
    if (a.rows < b.rows) losses.push({ target: { table }, what: `table ${table} held ${b.rows} row(s), now ${a.rows}` });
    const followed = end === names[names.length - 1];
    for (const [column, held] of b.columns) {
      if (total(held) === 0) continue;
      const now = followed ? renames.columns.get(table)!.get(column)! : column;
      const kept = a.columns.get(now);
      const target = { table, column };
      // A kernel-derived column (`_substrat_archived_at`, …) leaving is the kernel's own check's to
      // refuse, right after this one in the same transaction (#2090), with the remedy that fits:
      // no declaration can excuse it. Its VALUES are still held here.
      if (kept === undefined && namesSpineTable(column)) continue;
      if (kept === undefined) {
        losses.push({ target, what: `column ${table}.${column} held ${total(held)} value(s) and is gone` });
        continue;
      }
      const short = CLASSES.filter((k) => kept[k] < held[k]);
      if (short.length > 0) {
        losses.push({
          target,
          what:
            `column ${table}.${column} held ${total(held)} value(s), now ${total(kept)}` +
            (total(kept) >= total(held) ? ` (${short.map((k) => `${k} ${held[k]} → ${kept[k]}`).join(', ')}: retyped)` : ''),
        });
      }
    }
  }
  return losses;
}

const declarationError = (key: string, message: string) =>
  substratError('validation_failed', `migration ${key}: ${message} (#115)`, { reason: 'migration_declaration' });

/**
 * What a declaration counts: a column's values per class, or a table's rows — carried in one
 * class slot so a move compares tables and columns with the same loop.
 */
function countOf(m: Measure, t: Target): Classes | undefined {
  const table = m.get(t.table);
  if (!table) return undefined;
  if (!t.column) return { ...NONE, integer: table.rows };
  return table.columns.get(t.column);
}

/**
 * Wrap one authored migration's execution in the fence. `run` executes every statement of it; it
 * runs inside the caller's transaction, so a throw from here rolls all of it back.
 */
export function fenceMigration(sql: ScopedSql, migration: SqlMigration, key: string, run: () => void): void {
  const statements = executableSqlStatements(migration.sql);
  const moves = Object.entries(migration.moves ?? {});
  const discards = Object.entries(migration.discards ?? {});
  if (moves.length === 0 && discards.length === 0 && statements.every(additive)) {
    run();
    return;
  }
  const before = measure(sql);

  // Every declaration is read before anything runs, so a malformed one changes nothing.
  const parsedMoves = moves.map(([from, to]) => {
    const source = targetOf(from);
    const target = targetOf(to);
    if (!source || !target) throw declarationError(key, `moves: { '${from}': '${to}' } is not 'table' → 'table' or 'table.column' → 'table.column'`);
    if (!source.column !== !target.column) throw declarationError(key, `moves: { '${from}': '${to}' } moves a table to a column or a column to a table`);
    if (!countOf(before, source)) throw declarationError(key, `moves names ${show(source)}, which this scope does not hold before the migration`);
    return { source, target };
  });
  const parsedDiscards = discards.map(([spec, why]) => {
    const target = targetOf(spec);
    if (!target) throw declarationError(key, `discards: { '${spec}': … } is not 'table' or 'table.column'`);
    if (typeof why !== 'string' || why.trim() === '') throw declarationError(key, `discards: { '${spec}': … } gives no reason; the reason is what a reviewer reads`);
    if (!countOf(before, target)) throw declarationError(key, `discards names ${show(target)}, which this scope does not hold before the migration`);
    return target;
  });

  run();

  const after = measure(sql);
  const renames = followRenames(statements, before);
  const covers = (declared: Target, lost: Target) =>
    declared.table === lost.table && (declared.column === undefined || declared.column === lost.column);

  // A move is verified: what its target gained covers what its sources held, per class.
  const failures: string[] = [];
  const byTarget = new Map<string, { target: Target; sources: Target[] }>();
  for (const m of parsedMoves) {
    const entry = byTarget.get(show(m.target)) ?? { target: m.target, sources: [] };
    entry.sources.push(m.source);
    byTarget.set(show(m.target), entry);
  }
  for (const { target, sources } of byTarget.values()) {
    const now = countOf(after, target);
    if (!now) {
      failures.push(`moves names ${show(target)} as a target, which does not exist after the migration`);
      continue;
    }
    const had = countOf(before, target) ?? NONE;
    for (const k of CLASSES) {
      const need = sources.reduce((n, s) => n + countOf(before, s)![k], 0);
      const gained = now[k] - had[k];
      if (gained < need) {
        const unit = target.column ? `${k} value(s)` : 'row(s)';
        failures.push(
          `moves into ${show(target)} from ${sources.map(show).join(', ')}: the sources held ${need} ${unit}, the target gained ${gained}`,
        );
      }
    }
  }
  const unexcused = lossesOf(before, after, renames).filter(
    (l) => !parsedDiscards.some((d) => covers(d, l.target)) && !parsedMoves.some((m) => covers(m.source, l.target)),
  );
  if (failures.length === 0 && unexcused.length === 0) return;

  const lines = [...failures, ...unexcused.map((l) => l.what)];
  const remedy =
    unexcused.length === 0
      ? ''
      : ` If this is intended, declare it on the migration — discards: { ${unexcused
          .map((l) => `'${show(l.target)}': '<why this data may go>'`)
          .join(', ')} } — or, where the data moved, moves: { '<source>': '<where it went>' }.`;
  throw substratError(
    'forbidden',
    `migration ${key} would lose data this scope holds, so it was not applied (#115): ${lines.join('; ')}.${remedy}`,
    { reason: 'data_loss' },
  );
}
