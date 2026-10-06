/**
 * Which module owns which table in a scope, as the migrations ACTUALLY made it (#2068).
 *
 * A subject erasure writes to a module's own tables with the kernel's handle, so "own" has to
 * be a fact the kernel recorded, not a claim a manifest makes or a parse of migration text can
 * infer: `CREATE TABLE IF NOT EXISTS other_modules_table` reads as creating a table and creates
 * nothing when it already exists. So when the kernel applies a module's migration, it diffs the
 * scope's tables before and after, inside the same transaction, and records every table that
 * newly APPEARED as that module's (`recordMigrationOwnership`). A table that existed before the
 * migration is never attributed to it. A rename keeps its original owner; a dropped table loses
 * its row.
 *
 * Scopes migrated before this existed have tables with no row. Those are backfilled once, on the
 * first erasure that needs them, from the migration JOURNAL in applied order
 * (`backfillOwnershipFromJournal`): the first module whose migration creates a table owns it, so
 * a later module's `IF NOT EXISTS` on the same name still cannot take it over. A table no
 * migration created (runtime DDL) stays unowned, and an erasure that would touch it is refused.
 */
import { namesSpineTable, substratError, tokenizeSql, type SqlToken } from '@substrat-run/contracts';
import type { ScopedSql } from './scope-host.js';

/** The spine table the ownership lives in — a scope table, so it travels with the scope's data. */
export const TABLE_OWNERS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_table_owners (
    table_name TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
`;

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

/** One migration's DDL, read statement by statement: what it creates, renames and drops. */
export interface MigrationDdl {
  readonly creates: string[];
  readonly renames: { from: string; to: string }[];
  readonly drops: string[];
}

/**
 * The table DDL in one migration's text, in order. Used for two things only: following a
 * rename the schema diff cannot see as one, and the journal backfill. Never as proof that a
 * table was created — that is the diff's job.
 */
export function migrationDdl(sqlText: string): MigrationDdl {
  const out: MigrationDdl = { creates: [], renames: [], drops: [] };
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
      if (w(k) === 'if' && w(k + 1) === 'not' && w(k + 2) === 'exists') k += 3;
      const name = nameOf(st[k]);
      if (name && !temp) out.creates.push(name);
    } else if (w(0) === 'alter' && w(1) === 'table') {
      const from = nameOf(st[2]);
      const at = st.findIndex((t, i) => i > 2 && !t.quoted && t.text.toLowerCase() === 'rename');
      const to = at > 0 && w(at + 1) === 'to' ? nameOf(st[at + 2]) : undefined;
      if (from && to) out.renames.push({ from, to });
    } else if (w(0) === 'drop' && w(1) === 'table') {
      const name = nameOf(st[w(2) === 'if' && w(3) === 'exists' ? 4 : 2]);
      if (name) out.drops.push(name);
    }
  }
  return out;
}

/**
 * Record what one migration did to table ownership, from the schema before and after it ran —
 * called by both adapters inside the migration's own transaction, so a migration that fails
 * records nothing.
 *
 * A table that appeared is the migrating module's, unless the migration renamed a table that
 * disappeared into it: then it keeps the owner the old name had. A table that disappeared loses
 * its row. A table present on both sides is left exactly as recorded.
 */
export function recordMigrationOwnership(
  sql: ScopedSql,
  moduleId: string,
  migrationSql: string,
  before: ReadonlySet<string>,
  at: string,
): void {
  const after = moduleTableNames(sql);
  const gone = [...before].filter((t) => !after.has(t));
  const appeared = [...after].filter((t) => !before.has(t));
  const renamedFrom = new Map<string, string>();
  for (const r of migrationDdl(migrationSql).renames) {
    if (gone.includes(r.from) && appeared.includes(r.to)) renamedFrom.set(r.to, r.from);
  }
  const ownerOf = (t: string): string | undefined =>
    sql.query<{ module_id: string }>('SELECT module_id FROM _substrat_table_owners WHERE table_name = ?', [t])[0]
      ?.module_id;
  for (const table of appeared) {
    const from = renamedFrom.get(table);
    const owner = (from && ownerOf(from)) || moduleId;
    sql.exec(
      `INSERT INTO _substrat_table_owners (table_name, module_id, source, recorded_at) VALUES (?, ?, 'migration', ?)
         ON CONFLICT(table_name) DO UPDATE SET module_id = excluded.module_id, source = excluded.source,
           recorded_at = excluded.recorded_at`,
      [table, owner, at],
    );
  }
  for (const table of gone) sql.exec('DELETE FROM _substrat_table_owners WHERE table_name = ?', [table]);
}

/**
 * Attribute the given tables, where they have no row yet, from the migration journal in the
 * order it was applied — the one-time backfill for a scope migrated before ownership was
 * recorded. The first module whose migration creates a name owns it (a later `IF NOT EXISTS` on
 * the same name created nothing, so it gains nothing); a rename carries the owner; a drop ends
 * it. A table no journalled migration created is left without a row.
 *
 * `migrationSqlOf` is the registered module's migration text; a journal entry whose module is no
 * longer registered contributes nothing, which can only leave a table unowned — never misowned
 * by a module that is registered.
 */
export function backfillOwnershipFromJournal(
  sql: ScopedSql,
  tables: Iterable<string>,
  migrationSqlOf: (moduleId: string, version: string) => string | undefined,
  at: string,
): void {
  const wanted = [...tables].map((t) => t.toLowerCase());
  const missing = wanted.filter(
    (t) => sql.query('SELECT 1 FROM _substrat_table_owners WHERE table_name = ?', [t]).length === 0,
  );
  if (missing.length === 0) return;
  const journal = sql.query<{ module_id: string; version: string }>(
    'SELECT module_id, version FROM _substrat_migrations ORDER BY applied_at, rowid',
  );
  const owner = new Map<string, string>();
  for (const entry of journal) {
    const text = migrationSqlOf(entry.module_id, entry.version);
    if (text === undefined) continue;
    const ddl = migrationDdl(text);
    for (const t of ddl.creates) if (!owner.has(t)) owner.set(t, entry.module_id);
    for (const r of ddl.renames) {
      const o = owner.get(r.from);
      owner.delete(r.from);
      if (o !== undefined) owner.set(r.to, o);
    }
    for (const t of ddl.drops) owner.delete(t);
  }
  const live = moduleTableNames(sql);
  for (const t of missing) {
    const o = owner.get(t);
    if (o === undefined || !live.has(t)) continue;
    sql.exec(
      "INSERT INTO _substrat_table_owners (table_name, module_id, source, recorded_at) VALUES (?, ?, 'journal', ?)",
      [t, o, at],
    );
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
      sql.query<{ module_id: string }>('SELECT module_id FROM _substrat_table_owners WHERE table_name = ?', [t])[0]
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
