/**
 * Which module owns which table in a scope, as the migrations ACTUALLY made it (#2068).
 *
 * A subject erasure writes to a module's own tables with the kernel's handle, so "own" has to
 * be a fact the kernel recorded, not a claim a manifest makes or a parse of migration text can
 * infer: `CREATE TABLE IF NOT EXISTS other_modules_table` reads as creating a table and creates
 * nothing when it already exists.
 *
 * **Recorded statement by statement.** Both adapters run an authored migration one statement at
 * a time (`splitSqlStatements`) and diff the scope's tables around each one
 * (`runMigrationStatements`, then `recordOwnershipSteps`). One statement changes at most one table
 * (with its shadow tables, for a virtual one), so the diff names
 * it exactly: a table that appeared was created by the migrating module; one table gone and one
 * appeared is a rename, and the row moves with it; a table gone was dropped, and its row goes.
 * A table that existed before the statement is never attributed to it. Diffing a whole migration
 * instead could not tell `RENAME a TO b; CREATE TABLE a` from nothing having happened to `a`.
 *
 * **Guarded.** The ledger is a spine table, so module code cannot write it through `ctx.sql`, and
 * an authored migration that names it is refused before it runs (`assertMigrationLeavesLedgerAlone`).
 *
 * **Backfilled conservatively.** Scopes migrated before the ledger existed have tables with no
 * row. On the first erasure that needs them, the journal is replayed in applied order through the
 * SAME transition function (`applyTableChange`), statement by statement, from each entry's
 * migration text. The replay only ever attributes what it can prove: a plain `CREATE TABLE`
 * (which would have failed had the table existed) proves its creator; `IF NOT EXISTS` proves
 * nothing, since the table may already have been there; and an entry whose text is unavailable
 * (its module no longer registered) makes every table it could have touched unowned. Unowned
 * means the erasure refuses that table — the conservative answer, never a guess.
 */
import { namesSpineTable, substratError, tokenizeSql, type SqlToken } from '@substrat-run/contracts';
import type { ScopedSql } from './scope-host.js';

/** The ledger's name — also what an authored migration may never name. */
export const TABLE_OWNERS = '_substrat_table_owners';

/**
 * The spine table the ownership lives in — a scope table, so it travels with the scope's data.
 * The name is spelled out rather than interpolated: `lint:spine-ddl` reads this text as written.
 */
export const TABLE_OWNERS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_table_owners (
    table_name TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
`;

/**
 * Refuse an authored migration that names the ownership ledger — in any statement, read or
 * write, quoted or qualified. Each adapter runs it beside `assertNoSpineReference`, before the
 * migration executes, so a refused migration changes nothing and the scope fails closed.
 */
export function assertMigrationLeavesLedgerAlone(sql: string, what: string): void {
  for (const token of tokenizeSql(sql)) {
    if (token.text.split('.').some((part) => part.toLowerCase() === TABLE_OWNERS)) {
      throw substratError(
        'forbidden',
        `${what} names ${TABLE_OWNERS}, the kernel's record of which module created which table — ` +
          'a migration may not read or write it',
        { reason: 'spine_write' },
      );
    }
  }
}

/** The scope's own tables, lowercased: no spine, no SQLite or workerd internals, no views. */
export function moduleTableNames(sql: ScopedSql): Set<string> {
  return new Set(
    sql
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name.toLowerCase())
      .filter((n) => !namesSpineTable(n) && !n.startsWith('sqlite_') && !n.startsWith('_cf_')),
  );
}

/** A table name a statement names, lowercased; `main.` is the default schema, any other is not ours. */
function nameOf(token: SqlToken | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.text.toLowerCase().split('.');
  if (parts.length === 1) return parts[0];
  return parts.length === 2 && parts[0] === 'main' ? parts[1] : undefined;
}

/** One statement's effect on the table set, as its text states it. */
export type TableStatement =
  | { readonly kind: 'create'; readonly table: string; readonly ifNotExists: boolean }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'drop'; readonly table: string };

/** The table DDL in one migration's text, in statement order. TEMP tables are nobody's and are left out. */
export function tableStatements(sqlText: string): TableStatement[] {
  const out: TableStatement[] = [];
  const statements: SqlToken[][] = [[]];
  for (const token of tokenizeSql(sqlText, { punctuation: true })) {
    if (token.punct && token.text === ';') statements.push([]);
    else if (!token.punct) statements[statements.length - 1]!.push(token);
  }
  for (const st of statements) {
    const w = (i: number): string => (st[i] && !st[i]!.quoted ? st[i]!.text.toLowerCase() : '');
    if (w(0) === 'create') {
      let k = 1;
      const temp = w(k) === 'temp' || w(k) === 'temporary';
      if (temp) k += 1;
      if (w(k) === 'virtual') k += 1;
      if (w(k) !== 'table') continue;
      k += 1;
      const ifNotExists = w(k) === 'if' && w(k + 1) === 'not' && w(k + 2) === 'exists';
      if (ifNotExists) k += 3;
      const table = nameOf(st[k]);
      if (table && !temp) out.push({ kind: 'create', table, ifNotExists });
    } else if (w(0) === 'alter' && w(1) === 'table') {
      const from = nameOf(st[2]);
      const at = st.findIndex((t, i) => i > 2 && !t.quoted && t.text.toLowerCase() === 'rename');
      const to = at > 0 && w(at + 1) === 'to' ? nameOf(st[at + 2]) : undefined;
      if (from && to) out.push({ kind: 'rename', from, to });
    } else if (w(0) === 'drop' && w(1) === 'table') {
      const table = nameOf(st[w(2) === 'if' && w(3) === 'exists' ? 4 : 2]);
      if (table) out.push({ kind: 'drop', table });
    }
  }
  return out;
}

/**
 * Where ownership is kept while a transition is applied: the scope's ledger, or the replay's
 * in-memory model. `null` is a table that exists and whose owner is not known; `undefined`, one
 * that does not exist as far as the store knows.
 */
export interface OwnerStore {
  get(table: string): string | null | undefined;
  set(table: string, owner: string | null): void;
  delete(table: string): void;
}

/** One table change, in the terms both the live diff and the journal replay produce. */
export type TableChange =
  | { readonly kind: 'create'; readonly table: string; readonly owner: string | null }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'drop'; readonly table: string };

/**
 * THE transition, shared by the live record and the journal replay: a create sets its owner (or
 * an unknown one), a rename moves the row to the new name, a drop removes it.
 */
export function applyTableChange(store: OwnerStore, change: TableChange): void {
  switch (change.kind) {
    case 'create':
      store.set(change.table, change.owner);
      return;
    case 'rename': {
      const owner = store.get(change.from);
      store.delete(change.from);
      store.set(change.to, owner ?? null);
      return;
    }
    case 'drop':
      store.delete(change.table);
  }
}

/** The ledger as an `OwnerStore`: an unknown owner is no row, so an erasure refuses that table. */
function ledgerStore(sql: ScopedSql, source: 'migration' | 'journal', at: string): OwnerStore {
  return {
    get: (table) =>
      sql.query<{ module_id: string }>(`SELECT module_id FROM ${TABLE_OWNERS} WHERE table_name = ?`, [table])[0]
        ?.module_id ?? null,
    set: (table, owner) => {
      if (owner === null) {
        sql.exec(`DELETE FROM ${TABLE_OWNERS} WHERE table_name = ?`, [table]);
        return;
      }
      sql.exec(
        `INSERT INTO ${TABLE_OWNERS} (table_name, module_id, source, recorded_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(table_name) DO UPDATE SET module_id = excluded.module_id, source = excluded.source,
             recorded_at = excluded.recorded_at`,
        [table, owner, source, at],
      );
    },
    delete: (table) => {
      sql.exec(`DELETE FROM ${TABLE_OWNERS} WHERE table_name = ?`, [table]);
    },
  };
}

/** The table set either side of one statement that changed it. */
export interface TableStep {
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
}

/**
 * Run an authored migration ONE statement at a time, through the adapter's `exec`, and return
 * the table set either side of every statement that changed it. Both adapters run their
 * authored migrations through this, inside the migration's transaction; recording happens
 * afterwards (`recordOwnershipSteps`), so the journal's `rows_changed` counts the migration's
 * own writes and none of the kernel's bookkeeping.
 */
export function runMigrationStatements(sql: ScopedSql, migrationSql: string, exec: (statement: string) => void): TableStep[] {
  const steps: TableStep[] = [];
  let tables = moduleTableNames(sql);
  for (const statement of splitSqlStatements(migrationSql)) {
    exec(statement);
    const after = moduleTableNames(sql);
    if (after.size !== tables.size || [...after].some((t) => !tables.has(t))) steps.push({ before: tables, after });
    tables = after;
  }
  return steps;
}

/**
 * The table a group of names belongs to, when there is one: the shortest name, with every other
 * name its shadow (`root_…`) — what one `CREATE VIRTUAL TABLE … USING fts5` makes (`x`, `x_data`,
 * `x_idx`, …), drops or renames together. Undefined when the names are not one such group.
 */
function rootOf(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const root = [...names].sort((a, b) => a.length - b.length)[0]!;
  return names.every((n) => n === root || n.startsWith(`${root}_`)) ? root : undefined;
}

/**
 * The changes one statement made, from the table set either side of it. A single SQLite
 * statement changes ONE table — with its shadow tables, for a virtual table — so: tables only
 * appearing are a create by `moduleId`; only disappearing, a drop; one group gone and one
 * appeared, a rename, each shadow moving with its root. Anything else is not a shape a single
 * statement produces, and is refused rather than guessed at.
 */
export function tableChangesOf(moduleId: string, step: TableStep): TableChange[] {
  const gone = [...step.before].filter((t) => !step.after.has(t));
  const appeared = [...step.after].filter((t) => !step.before.has(t));
  const from = rootOf(gone);
  const to = rootOf(appeared);
  if (gone.length === 0 && to !== undefined) {
    return appeared.map((table) => ({ kind: 'create', table, owner: moduleId }));
  }
  if (appeared.length === 0 && from !== undefined) return gone.map((table) => ({ kind: 'drop', table }));
  if (from !== undefined && to !== undefined && gone.length === appeared.length) {
    const renamed = gone.map((g) => ({ from: g, to: `${to}${g.slice(from.length)}` }));
    if (renamed.every((r) => appeared.includes(r.to))) {
      return renamed.map((r) => ({ kind: 'rename', from: r.from, to: r.to }));
    }
  }
  throw substratError(
    'internal',
    `migration of ${moduleId}: one statement changed unrelated tables (gone: ${gone.join(', ') || '-'}; ` +
      `appeared: ${appeared.join(', ') || '-'}), which the ownership record cannot attribute`,
  );
}

/** Apply each recorded step to the ledger, in statement order, through `applyTableChange`. */
export function recordOwnershipSteps(sql: ScopedSql, moduleId: string, steps: readonly TableStep[], at: string): void {
  const store = ledgerStore(sql, 'migration', at);
  for (const step of steps) for (const change of tableChangesOf(moduleId, step)) applyTableChange(store, change);
}

/**
 * Attribute the given tables, where they have no row yet, by replaying the migration journal in
 * applied order, statement by statement, through `applyTableChange` — the one-time backfill for a
 * scope migrated before ownership was recorded. Only what the replay can prove is attributed:
 *
 * - a plain `CREATE TABLE` proves its creator — it would have failed had the table existed;
 * - `CREATE TABLE IF NOT EXISTS` proves nothing: an earlier migration, or runtime DDL, may already
 *   have made the table, so it leaves the table's owner unknown;
 * - an entry whose migration text is not available — its module no longer registered — could have
 *   created, renamed or dropped anything, so every table that exists at that point becomes
 *   unknown. A later plain `CREATE` still proves its own creation.
 *
 * An unknown owner is no row, and the erasure refuses that table.
 */
export function backfillOwnershipFromJournal(
  sql: ScopedSql,
  tables: Iterable<string>,
  migrationSqlOf: (moduleId: string, version: string) => string | undefined,
  at: string,
): void {
  const missing = [...tables]
    .map((t) => t.toLowerCase())
    .filter((t) => sql.query(`SELECT 1 FROM ${TABLE_OWNERS} WHERE table_name = ?`, [t]).length === 0);
  if (missing.length === 0) return;
  const journal = sql.query<{ module_id: string; version: string }>(
    'SELECT module_id, version FROM _substrat_migrations ORDER BY applied_at, rowid',
  );
  const model = new Map<string, string | null>();
  const store: OwnerStore = {
    get: (t) => model.get(t),
    set: (t, o) => void model.set(t, o),
    delete: (t) => void model.delete(t),
  };
  for (const entry of journal) {
    const text = migrationSqlOf(entry.module_id, entry.version);
    if (text === undefined) {
      for (const t of model.keys()) model.set(t, null);
      continue;
    }
    for (const st of tableStatements(text)) {
      if (st.kind === 'create') {
        if (st.ifNotExists && model.has(st.table)) continue;
        applyTableChange(store, { kind: 'create', table: st.table, owner: st.ifNotExists ? null : entry.module_id });
      } else {
        applyTableChange(store, st);
      }
    }
  }
  const live = moduleTableNames(sql);
  const ledger = ledgerStore(sql, 'journal', at);
  for (const t of missing) {
    const owner = model.get(t);
    if (owner && live.has(t)) ledger.set(t, owner);
  }
}

/**
 * Refuse, before anything is written, an erasure that would touch a table the scope does not
 * record as the erasing module's. Missing rows are backfilled from the journal first.
 */
export function assertTablesOwned(
  sql: ScopedSql,
  moduleId: string,
  tables: Iterable<string>,
  migrationSqlOf: (moduleId: string, version: string) => string | undefined,
  at: string,
): void {
  const list = [...tables].map((t) => t.toLowerCase());
  if (list.length === 0) return;
  backfillOwnershipFromJournal(sql, list, migrationSqlOf, at);
  const refused = list.filter(
    (t) =>
      sql.query<{ module_id: string }>(`SELECT module_id FROM ${TABLE_OWNERS} WHERE table_name = ?`, [t])[0]
        ?.module_id !== moduleId,
  );
  if (refused.length > 0) {
    throw substratError(
      'precondition_failed',
      `erasure: ${moduleId} names ${refused.map((t) => `'${t}'`).join(', ')}, which this scope does not record as ` +
        'created by its migrations — an erasure touches only the tables a module owns. Nothing was erased.',
    );
  }
}

/**
 * Split SQL into top-level statements on `;`, keeping a `CREATE TRIGGER … END;` body whole and
 * skipping comments and string literals. Both adapters run an authored migration through this
 * one statement at a time — the Durable Object because its `exec` takes one statement, and both
 * because the ownership record diffs the schema around each statement.
 */
const IS_CREATE_TRIGGER = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const ENDS_WITH_END = /\bEND\s*$/i;

export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
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
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === ';') {
      if (IS_CREATE_TRIGGER.test(cur) && !ENDS_WITH_END.test(cur)) {
        cur += c;
        i += 1;
        continue;
      }
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
