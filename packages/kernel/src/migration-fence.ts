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
 * do not matter and a refusal rolls the whole migration back. Every measuring query stays inside a
 * Durable Object's own limits (`DO_SQL_LIMITS`), or the fence would close a scope for a reason of
 * its own.
 *
 * **Production data is rows that exist.** A table with no rows may be dropped or rebuilt freely,
 * whatever else is true of the scope; the same migration is refused in a scope where it would
 * lose something. There is no phase flag to forget to flip.
 *
 * **What counts as a loss**, for a table that held rows: it is gone (under the name `ALTER TABLE …
 * RENAME TO` last gave it, or under its original name, so a rebuild back into place keeps it —
 * each table after the migration is claimed by one table before it, a rename first, and a `DROP
 * TABLE` releases the name it removed); it has fewer
 * rows; one of its columns that held values is gone (`RENAME COLUMN` is followed) or holds fewer
 * of them in some storage class — which is how a retype shows, `'1.50'` turning into `1`. Counts
 * cannot tell a faithful widening (`5` → `5.0`) from a rewrite (`5` → `0.05`), so any change of
 * storage class is reported, and one made on purpose is declared with `discards`. `NOT NULL`
 * without a default needs no rule: SQLite refuses it itself.
 *
 * **What it does not see**, because it counts — the residual classes, each named in the property
 * test (`migration-fence.property.test.ts`) that holds the rest to ground truth:
 * - in-place replacement: values rewritten at the same count and class (`UPDATE`), rows replaced
 *   by as many other rows (`DELETE` + `INSERT`), or a column dropped, re-added and refilled;
 * - a dropped table whose name is continued by a table the migration created, filled from
 *   somewhere else, holding at least as many rows, even renamed away again (`DROP TABLE a; CREATE
 *   TABLE a AS SELECT * FROM b`, or `…; CREATE TABLE n AS SELECT * FROM b; ALTER TABLE n RENAME TO
 *   a; ALTER TABLE a RENAME TO d`): counts cannot tell it from the create-copy-drop-rename
 *   rebuild, or a rename after it, which the fence must accept;
 * - which source a move's target gained from: a target is credited with everything it gained.
 * And one refusal by design: data copied under another table's name is refused until `moves`
 * declares it.
 *
 * **Declared losses pass.** `SqlMigration.moves` names data that went elsewhere, and is verified:
 * the target must GAIN at least what its sources held, per class — and for a table moved whole,
 * every source column that held values must arrive in a target column of the same name, unless
 * that column is moved or discarded by name itself. `SqlMigration.discards` names data
 * deliberately given up, with the reason a reviewer reads. A declaration naming a table or column
 * the scope does not hold before the migration (a move's target excepted, which the migration may
 * create) is an authoring error and refuses the migration too.
 *
 * **TEMP objects are refused.** A Durable Object refuses them outright, so a migration making one
 * could never run on the hosted adapter, and a TEMP table shadows the scope's own tables for every
 * unqualified statement after it. An authored migration that makes one is refused before it runs,
 * on both adapters, and every measuring read names `main` so nothing else can answer for a table.
 *
 * **ATTACH and DETACH are refused** for the same first reason (#2321): a Durable Object refuses
 * them, so the migration could never run hosted. And an attached database is a FILE, which the
 * fence does not measure and a replay outside a host (`substrat push`) would otherwise create on
 * the machine running it. Refused before anything runs, on both adapters.
 *
 * Kernel-derived DDL is exempt: its tables are indexes, rebuilt from the data this protects.
 */
import { namesSpineTable, substratError, tokenizeSql } from '@substrat-run/contracts';
import type { ScopedSql, SqlMigration } from './scope-host.js';
import { DO_SQL_LIMITS } from './sql-limits.js';
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

/**
 * Columns measured per query: each one is a result column per storage class, and a Durable
 * Object refuses a result set wider than `DO_SQL_LIMITS.columns`.
 */
const COLUMNS_PER_SCAN = Math.floor(DO_SQL_LIMITS.columns / CLASSES.length);

/** SQLite folds ASCII letters only: `"ä"` and `"Ä"` are two tables, and must stay two keys. */
const lower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const total = (c: Classes): number => CLASSES.reduce((n, k) => n + c[k], 0);
const NONE: Classes = { integer: 0, real: 0, text: 0, blob: 0 };

interface Word {
  readonly text: string;
  readonly quoted: boolean;
  readonly parts?: readonly string[];
}

/** The words of one statement, keywords lowercased; quoted names are kept apart from keywords. */
function words(statement: string): Word[] {
  return tokenizeSql(statement).map((t) => ({ text: t.quoted ? t.text : lower(t.text), quoted: t.quoted, parts: t.parts }));
}

/**
 * The schema a name token names, and the name in it, as SQLite reads them: `main.n` and
 * `"main"."n"` are `main` and `n`; `"main.n"` is ONE identifier, a name with a dot in it and no
 * schema. The one reading of a qualifier, for the `temp` check and for following `main` names.
 */
function schemaAndName(w: Word): { schema?: string; name: string } {
  const parts = w.parts ?? [w.text];
  return parts.length === 2 ? { schema: lower(parts[0]!), name: parts[1]! } : { name: parts.join('.') };
}

/** A table name as the main schema holds it, or a name no main table has if another schema is named. */
function mainName(w: Word): string {
  const { schema, name } = schemaAndName(w);
  return schema === undefined || schema === 'main' ? lower(name) : `\u0000${schema}.${lower(name)}`;
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
 * The tables a virtual-table module keeps behind each virtual table, by suffix. Only these exact
 * names are left out: a real table that merely starts with a virtual table's name is measured. A
 * module not listed here has its shadow tables measured too, which can refuse a migration that
 * only reshaped an index — the conservative answer.
 */
const SHADOW_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  fts5: ['data', 'idx', 'content', 'docsize', 'config'],
  fts4: ['content', 'segments', 'segdir', 'docsize', 'stat'],
  fts3: ['content', 'segments', 'segdir', 'docsize', 'stat'],
  rtree: ['node', 'parent', 'rowid'],
};

/**
 * The tables the fence measures, as SQLite names them: the scope's own, without the spine,
 * SQLite's and workerd's internals, virtual tables (an index over data held elsewhere, or a
 * module's own store the fence cannot count without its content table) and their shadow tables.
 * Exported so a replay outside a host (`lint:migration-fence`) populates exactly what is measured.
 */
export function fencedTables(sql: ScopedSql): string[] {
  const rows = sql.query<{ name: string; sql: string | null }>("SELECT name, sql FROM main.sqlite_master WHERE type = 'table'");
  const own = rows.filter((r) => {
    const n = lower(r.name);
    return !namesSpineTable(n) && !n.startsWith('sqlite_') && !n.startsWith('_cf_');
  });
  const skip = new Set<string>();
  for (const r of own) {
    const m = /^\s*create\s+virtual\s+table\s+.*?\busing\s+(\w+)/is.exec(r.sql ?? '');
    if (!m) continue;
    const name = lower(r.name);
    skip.add(name);
    for (const suffix of SHADOW_SUFFIXES[lower(m[1]!)] ?? []) skip.add(`${name}_${suffix}`);
  }
  return own.map((r) => r.name).filter((name) => !skip.has(lower(name)));
}

function measure(sql: ScopedSql): Measure {
  const out = new Map<string, TableCount>();
  for (const table of fencedTables(sql)) {
    // Qualified: a TEMP object of the same name would otherwise answer for the scope's table.
    const names = sql.query<{ name: string }>("SELECT name FROM pragma_table_info(?, 'main')", [table]).map((c) => c.name);
    const rows = Number(sql.query<{ n: number }>(`SELECT COUNT(*) AS n FROM main.${quote(table)}`)[0]!.n);
    const columns = new Map<string, Classes>();
    for (let at = 0; at < names.length && rows > 0; at += COLUMNS_PER_SCAN) {
      const chunk = names.slice(at, at + COLUMNS_PER_SCAN);
      const select = chunk.flatMap((c, i) => CLASSES.map((k) => `COALESCE(SUM(typeof(${quote(c)}) = '${k}'), 0) AS c${i}_${k}`));
      const r = sql.query<Record<string, number>>(`SELECT ${select.join(', ')} FROM main.${quote(table)}`)[0]!;
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
  /** Original table → original column → current column name, or `DROPPED`. */
  readonly columns: Map<string, Map<string, string>>;
  /** Original tables a `DROP TABLE` removed, under whatever name they carried then. */
  readonly dropped: ReadonlySet<string>;
  /** Dropped tables a rebuild continued under their original name (see `followRenames`). */
  readonly rebuilt: ReadonlySet<string>;
}

/** What a column a `DROP COLUMN` removed maps to: a name no column after the migration has. */
const DROPPED = '\u0000dropped';

/**
 * Statement by statement, which original table holds each name right now. A name is held by at
 * most one table — SQLite refuses a rename onto a name that exists — so a `DROP TABLE` releases it
 * and a later rename onto it is that table's alone, whatever order the scope created them in.
 *
 * A table this migration made, renamed onto a dropped table's ORIGINAL name, continues the dropped
 * one: that is the create-copy-drop-rename rebuild, which the counts then judge, and its later
 * renames, of the table or its columns, are followed. A bare `CREATE TABLE` at that name is not a
 * continuation: renames after it are not followed, which can only refuse.
 */
function followRenames(statements: readonly string[], before: Measure): Renames {
  const tables = new Map([...before.keys()].map((t) => [t, [t]]));
  const columns = new Map([...before].map(([t, c]) => [t, new Map([...c.columns.keys()].map((k) => [k, k]))]));
  const holder = new Map([...before.keys()].map((t) => [t, t]));
  const dropped = new Set<string>();
  const rebuilt = new Set<string>();
  const rebuiltAt = (name: string): void => {
    if (!dropped.has(name) || holder.has(name)) return;
    dropped.delete(name);
    rebuilt.add(name);
    holder.set(name, name);
    tables.get(name)!.push(name);
  };
  for (const statement of statements) {
    const w = words(statement);
    const kw = (i: number): string | undefined => (w[i] && !w[i]!.quoted ? w[i]!.text : undefined);
    if (kw(0) === 'drop' && kw(1) === 'table') {
      const at = kw(2) === 'if' && kw(3) === 'exists' ? 4 : 2;
      if (!w[at]) continue;
      const name = mainName(w[at]!);
      const original = holder.get(name);
      if (original === undefined) continue;
      holder.delete(name);
      dropped.add(original);
      continue;
    }
    if (kw(0) !== 'alter' || kw(1) !== 'table' || !w[2]) continue;
    const table = mainName(w[2]);
    const original = holder.get(table);
    if (!original) {
      // A table this migration made, renamed onto a dropped table's original name: the rebuild.
      if (kw(3) === 'rename' && kw(4) === 'to' && w[5]) rebuiltAt(mainName(w[5]));
      continue;
    }
    const renamed = columns.get(original)!;
    if (kw(3) === 'drop') {
      // DROP [COLUMN] c: the column is gone, and its name is free for a later rename.
      const k = kw(4) === 'column' ? 5 : 4;
      if (!w[k]) continue;
      const name = lower(w[k]!.text);
      for (const [orig, current] of renamed) if (current === name) renamed.set(orig, DROPPED);
      continue;
    }
    if (kw(3) !== 'rename') continue;
    if (kw(4) === 'to' && w[5]) {
      holder.delete(table);
      holder.set(mainName(w[5]), original);
      tables.get(original)!.push(mainName(w[5]));
    } else {
      // RENAME [COLUMN] a TO b
      const k = kw(4) === 'column' ? 5 : 4;
      if (!w[k] || kw(k + 1) !== 'to' || !w[k + 2]) continue;
      const from = lower(w[k]!.text);
      const to = lower(w[k + 2]!.text);
      for (const [orig, current] of renamed) if (current === from) renamed.set(orig, to);
    }
  }
  return { tables, columns, dropped, rebuilt };
}

/**
 * Which table after the migration each table before it became, one to one. A table renamed onto a
 * name that exists afterwards, and not dropped since, claims it first; every other table falls
 * back to its original name, then (unless it was dropped) to an earlier name it carried — never
 * to a name another table already claimed. So
 * `DROP TABLE b; ALTER TABLE a RENAME TO b` leaves `b` to `a`, and the `b` that was dropped is
 * gone. Undefined: the table is gone.
 */
function endsOf(before: Measure, after: Measure, renames: Renames): Map<string, { end: string; followed: boolean } | undefined> {
  const ends = new Map<string, { end: string; followed: boolean } | undefined>();
  const claimed = new Set<string>();
  for (const [table, names] of renames.tables) {
    const last = names[names.length - 1]!;
    // `holder` gave each name to one table at a time, so two undropped tables cannot end on one.
    if (names.length > 1 && !renames.dropped.has(table) && after.has(last)) {
      // A rebuilt table may carry a column under its original name, so it is not followed strictly.
      ends.set(table, { end: last, followed: !renames.rebuilt.has(table) });
      claimed.add(last);
    }
  }
  for (const [table, names] of renames.tables) {
    if (ends.has(table) || !before.has(table)) continue;
    // A dropped table may come back only under its original name — a rebuild back into place. A
    // name it carried before the drop now belongs to whatever was created there afterwards.
    const candidates = renames.dropped.has(table) ? [table] : [table, ...[...names].reverse()];
    const end = candidates.find((n) => after.has(n) && !claimed.has(n));
    if (end !== undefined) claimed.add(end);
    // Followed strictly only when the table never moved: a table rebuilt back into place (moved
    // aside, or dropped and recreated) may carry a column under its original name.
    const followed = names.length === 1 && !renames.dropped.has(table);
    ends.set(table, end === undefined ? undefined : { end, followed });
  }
  return ends;
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
  const ends = endsOf(before, after, renames);
  for (const [table, b] of before) {
    if (b.rows === 0) continue;
    const resolved = ends.get(table);
    if (resolved === undefined) {
      losses.push({ target: { table }, what: `table ${table} held ${b.rows} row(s) and is gone` });
      continue;
    }
    const a = after.get(resolved.end)!;
    if (a.rows < b.rows) losses.push({ target: { table }, what: `table ${table} held ${b.rows} row(s), now ${a.rows}` });
    const renamed = renames.columns.get(table)!;
    for (const [column, held] of b.columns) {
      if (total(held) === 0) continue;
      // Followed through its renames; on a table rebuilt back into place, the rename the old table
      // took before it moved aside still names the column, and its original name is the fallback.
      const mapped = renamed.get(column)!;
      // A column a `DROP COLUMN` removed is gone, whatever later takes its name.
      const kept = mapped === DROPPED ? undefined : (a.columns.get(mapped) ?? (resolved.followed ? undefined : a.columns.get(column)));
      // A kernel-derived column (`_substrat_archived_at`, …) leaving is the kernel's own check's to
      // refuse, right after this one in the same transaction (#2090), with the remedy that fits:
      // no declaration can excuse it. Its VALUES are still held here.
      if (kept === undefined && namesSpineTable(column)) continue;
      const target = { table, column };
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

const declarationError = (key: string, message: string, reason = 'migration_declaration') =>
  substratError('validation_failed', `migration ${key}: ${message} (#115)`, { reason });

/**
 * A statement that makes a TEMP object: `CREATE TEMP|TEMPORARY …`, or one named into the `temp`
 * schema (`CREATE TABLE temp.x`, `"temp"."x"`), however the name is spelled.
 */
function createsTemp(statement: string): boolean {
  const w = words(statement);
  const kw = (i: number): string | undefined => (w[i] && !w[i]!.quoted ? w[i]!.text : undefined);
  if (kw(0) !== 'create') return false;
  if (kw(1) === 'temp' || kw(1) === 'temporary') return true;
  let at = 1;
  if (kw(at) === 'unique' || kw(at) === 'virtual') at += 1;
  if (!['table', 'view', 'index', 'trigger'].includes(kw(at) ?? '')) return false;
  at += 1;
  if (kw(at) === 'if' && kw(at + 1) === 'not' && kw(at + 2) === 'exists') at += 3;
  // `"temp.x"` is one identifier, a main table whose name holds a dot; `temp.x` is the schema.
  return w[at] !== undefined && schemaAndName(w[at]!).schema === 'temp';
}

/** A statement that attaches or detaches a database: `ATTACH [DATABASE] …`, `DETACH [DATABASE] …`. */
function attaches(statement: string): boolean {
  const w = words(statement);
  return w[0] !== undefined && !w[0].quoted && (w[0].text === 'attach' || w[0].text === 'detach');
}

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

const covers = (declared: Target, lost: Target) =>
  declared.table === lost.table && (declared.column === undefined || declared.column === lost.column);

/** Each class `got` falls short of `need`, as `<class> <need> → <got>`. */
const shortfall = (need: Classes, got: Classes): string[] =>
  CLASSES.filter((k) => got[k] < need[k]).map((k) => `${k} ${need[k]} → ${got[k]}`);
const plus = (a: Classes, b: Classes): Classes => Object.fromEntries(CLASSES.map((k) => [k, a[k] + b[k]])) as Classes;
const gain = (before: Classes | undefined, after: Classes | undefined): Classes =>
  Object.fromEntries(CLASSES.map((k) => [k, (after?.[k] ?? 0) - (before?.[k] ?? 0)])) as Classes;

/**
 * Verify the declared moves: each target gained, per class, what its sources held; and a table
 * moved whole brought every column that held values into a target column of the same name, unless
 * that column is declared by name itself.
 */
function moveFailures(
  before: Measure,
  after: Measure,
  moves: readonly { source: Target; target: Target }[],
  discards: readonly Target[],
): string[] {
  const failures: string[] = [];
  const byTarget = new Map<string, { target: Target; sources: Target[] }>();
  for (const m of moves) {
    const entry = byTarget.get(show(m.target)) ?? { target: m.target, sources: [] };
    entry.sources.push(m.source);
    byTarget.set(show(m.target), entry);
  }
  for (const { target, sources } of byTarget.values()) {
    if (!countOf(after, target)) {
      failures.push(`moves names ${show(target)} as a target, which does not exist after the migration`);
      continue;
    }
    const need = sources.reduce((n, s) => plus(n, countOf(before, s)!), NONE);
    const gained = gain(countOf(before, target), countOf(after, target));
    const short = shortfall(need, gained);
    if (short.length > 0) {
      const from = `moves into ${show(target)} from ${sources.map(show).join(', ')}`;
      failures.push(
        target.column
          ? `${from}: the sources' values did not all arrive (${short.join(', ')})`
          : `${from}: the sources held ${need.integer} row(s), the target gained ${gained.integer}`,
      );
    }
    if (target.column) continue;
    // A table moved whole: its columns arrive by name, unless declared by name.
    const byColumn = new Map<string, { need: Classes; from: string[] }>();
    for (const source of sources) {
      for (const [column, held] of before.get(source.table)!.columns) {
        const named = { table: source.table, column };
        if (total(held) === 0 || namesSpineTable(column)) continue;
        if (moves.some((m) => m.source.column === column && m.source.table === source.table)) continue;
        if (discards.some((d) => covers(d, named))) continue;
        const entry = byColumn.get(column) ?? { need: NONE, from: [] };
        byColumn.set(column, { need: plus(entry.need, held), from: [...entry.from, show(named)] });
      }
    }
    for (const [column, { need: held, from }] of byColumn) {
      const into = { table: target.table, column };
      const now = countOf(after, into);
      const missing = now === undefined ? [] : shortfall(held, gain(countOf(before, into), now));
      if (now === undefined || missing.length > 0) {
        failures.push(
          `moves ${from.join(', ')} into ${target.table}, but ${now === undefined ? `${show(into)} does not exist` : `${show(into)} did not gain them (${missing.join(', ')})`} — ` +
            `move the column by name (moves: { '${from[0]}': '<table.column>' }) or discard it`,
        );
      }
    }
  }
  return failures;
}

/**
 * Wrap one authored migration's execution in the fence. `run` executes every statement of it; it
 * runs inside the caller's transaction, so a throw from here rolls all of it back.
 */
export function fenceMigration(sql: ScopedSql, migration: SqlMigration, key: string, run: () => void): void {
  const statements = executableSqlStatements(migration.sql);
  const temp = statements.find(createsTemp);
  if (temp !== undefined) {
    throw declarationError(
      key,
      `it creates a TEMP object (\`${temp.slice(0, 80)}\`). A Durable Object refuses TEMP objects, so this migration ` +
        'cannot run on the hosted adapter, and a TEMP table shadows the scope\'s own tables for every unqualified statement ' +
        'after it. Use a regular table and DROP it before the migration ends',
      'migration_temp',
    );
  }
  const attach = statements.find(attaches);
  if (attach !== undefined) {
    throw declarationError(
      key,
      `it attaches or detaches a database (\`${attach.slice(0, 80)}\`). A Durable Object refuses ATTACH and DETACH, so this ` +
        'migration cannot run on the hosted adapter, and an attached database is a file outside the scope the fence protects. ' +
        "Keep the migration inside the scope's own database",
      'migration_attach',
    );
  }
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
  const failures = moveFailures(before, after, parsedMoves, parsedDiscards);
  const unexcused = lossesOf(before, after, followRenames(statements, before)).filter(
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
