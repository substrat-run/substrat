import { z } from 'zod';

/**
 * Read-only introspection of a scope's own database — the console/dashboard "Data"
 * view (kernel-design §5.4's admin-query RPC, cashed in as two narrow primitives).
 *
 * This is an OPERATOR read, not module code and not an operation: it reaches a
 * scope's SQLite directly through `HostAdmin`, so it takes a `PlatformActorId` and
 * records to the staff access log (K-24) like every other directory read. It is
 * deliberately *read-only and table-shaped* — there is no user-supplied SQL, only a
 * table name validated against the live schema plus a bounded page — so there is no
 * write path to forge the spine and no injection surface to guard.
 */

/**
 * One table in a scope's database. `system` marks the platform's own spine tables
 * (`_substrat_*`) and SQLite internals (`sqlite_*`) so the UI can group them apart
 * from the vertical's own data — reads of them are allowed (projections read the
 * spine); it is only writes the module rules forbid.
 */
export const scopeTable = z.object({
  name: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  system: z.boolean(),
});
export type ScopeTable = z.infer<typeof scopeTable>;

/**
 * A bounded page of rows from one table. `columns` is the column order; each row in
 * `rows` is a positional array aligned to it (JSON values — SQLite text/int/real/
 * null/blob-as-null). `rowCount` is the table's TOTAL row count, so the UI can page.
 */
export const scopeTablePage = z.object({
  table: z.string().min(1),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ScopeTablePage = z.infer<typeof scopeTablePage>;

// The default and hard ceiling on a page — a browser reads a screenful, never the
// whole table, and the ceiling is what keeps a scope's DB read from becoming a dump.
export const SCOPE_TABLE_PAGE_DEFAULT = 50;
export const SCOPE_TABLE_PAGE_MAX = 200;

/**
 * What `readScopeTable` accepts. `table` is validated against the live schema by the
 * adapter (an unknown name is rejected, never interpolated). `limit` is clamped to
 * [1, SCOPE_TABLE_PAGE_MAX]; `offset` is a non-negative row offset for paging.
 */
export const readScopeTableInput = z.object({
  table: z.string().min(1),
  limit: z.number().int().positive().max(SCOPE_TABLE_PAGE_MAX).default(SCOPE_TABLE_PAGE_DEFAULT),
  offset: z.number().int().nonnegative().default(0),
});
export type ReadScopeTableInput = z.infer<typeof readScopeTableInput>;

// The hard ceiling on a console query's result — same order as a table page. The cap
// (with the single-statement rule) is also the time bound: there is no per-query
// timeout on either adapter, so "bounded rows out" is what keeps the read cheap.
export const SCOPE_QUERY_ROW_MAX = 200;

/**
 * What `queryScope` accepts: one read-only SQL statement (#219). Unlike
 * `readScopeTable` this IS user-supplied SQL, so the safety moves from "no SQL at
 * all" to statement-level enforcement — the kernel's `assertReadOnlyQuery` textual
 * gate plus each adapter's authoritative check (better-sqlite3's
 * `prepare().readonly`; a rolled-back transaction on the DO). Editing rows stays
 * out of scope forever: a write here would forge the spine.
 */
export const queryScopeInput = z.object({
  sql: z.string().min(1).max(10_000),
});
export type QueryScopeInput = z.infer<typeof queryScopeInput>;

/**
 * A bounded result of one read-only query. Positional rows aligned to `columns`
 * (JSON values, blob-as-null, like a table page); `truncated` is set when the
 * statement had more rows than SCOPE_QUERY_ROW_MAX — the cap is a ceiling, never
 * an error, so an over-broad SELECT still shows its first screenful.
 */
export const scopeQueryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  truncated: z.boolean(),
});
export type ScopeQueryResult = z.infer<typeof scopeQueryResult>;

/**
 * A COMPLETE, byte-faithful dump of one scope's database — the deliberate opposite
 * of `readScopeTable` above (bounded, blob-as-null, "not a dump"). This is the whole
 * scope: every table, its DDL, and every row, so it can rebuild the scope elsewhere.
 *
 * It is the privileged primitive the preview/snapshot machinery is built on
 * (docs/architecture/preview-and-snapshots.md §3) — the source a fork or a local pull
 * reads. It KEEPS the `_substrat_*` spine (a fork must carry the event/migration
 * state) and drops only SQLite's own `sqlite_*` internals (auto-managed, and
 * `CREATE TABLE sqlite_*` is rejected on reload). Because it exfiltrates a whole
 * scope, it is staff/audited like every `HostAdmin` read, never a UI affordance.
 */
export const scopeDumpTable = z.object({
  /** Table name (a vertical table or a `_substrat_*` spine table). */
  name: z.string().min(1),
  /** The `CREATE TABLE` statement from `sqlite_master` — replayed to rebuild the schema. */
  ddl: z.string().min(1),
  /** Column order; each row in `rows` is a positional array aligned to it. */
  columns: z.array(z.string()),
  /**
   * Every row, as positional arrays. Cells are SQLite text/int/real/null; blobs are
   * preserved as bytes (never nulled as in a UI read) so the dump reloads faithfully.
   */
  rows: z.array(z.array(z.unknown())),
});
export type ScopeDumpTable = z.infer<typeof scopeDumpTable>;

export const scopeDump = z.object({
  tenantId: z.string().min(1),
  scopeId: z.string().min(1),
  /** ISO 8601 capture time — the fork's `forked_at`. */
  capturedAt: z.string().min(1),
  tables: z.array(scopeDumpTable),
});
export type ScopeDump = z.infer<typeof scopeDump>;

/**
 * One stored scope BACKUP, as the list/reap surfaces report it (#493) — metadata about a
 * `scopeDump` the platform holds, never the dump itself, so listing a scope's copies is
 * cheap and hands out no bytes.
 *
 * A backup is what makes the terminal reap survivable: reaping wipes a scope's Durable
 * Object storage irreversibly, so the control plane stores a full-fidelity dump first and
 * records this shape's address on the admin-log entry. Deliberately NOT a snapshot fork —
 * a fork lives inside the vertical's own deployment, so it neither survives that
 * vertical's retirement nor stops counting as a live scope against it.
 *
 * Addressed by (tenantId, scopeId, capturedAt): the store's own key scheme stays private
 * to the store, so no caller builds a path into another tenant's copies.
 */
export const scopeBackup = z.object({
  tenantId: z.string().min(1),
  scopeId: z.string().min(1),
  /** The vertical the scope was bound to when the copy was taken, when it had one. */
  vertical: z.string().nullable(),
  /** ISO 8601 — the dump's own `capturedAt`, and this backup's address. */
  capturedAt: z.string().min(1),
  /** Serialized size in bytes — what tells a real copy from an empty one at a glance. */
  size: z.number().int().nonnegative(),
  /** Tables carried; zero means the copy is not restorable. */
  tables: z.number().int().nonnegative(),
});
export type ScopeBackup = z.infer<typeof scopeBackup>;

/**
 * A COMPLETE dump of the DIRECTORY — the platform's own database (#40), not a tenant's.
 *
 * The same table shape as a `scopeDump`, and deliberately so: both are the logical
 * row-dump of one SQLite database, so one reader, one writer, one wire shape. What
 * differs is what is inside and what losing it costs. A scope database holds one
 * customer's data and is protected by ~30-day DO point-in-time recovery; the directory
 * holds tenants, scopes, hostnames, verticals, identities and the admin log — the
 * mapping that makes every OTHER database addressable — and is unreconstructable from
 * them. `control-plane.md` puts it plainly: losing it is losing the platform, not
 * losing a cache.
 *
 * There is no (tenantId, scopeId) here because there is exactly ONE directory per
 * deployment. `capturedAt` is therefore the whole address of a copy.
 *
 * PITR already covers corruption INSIDE the account, which is why this exists on a
 * different axis: an off-DO copy is what survives a control-plane bug that deletes the
 * Durable Object outright. It does NOT survive loss of the Cloudflare account itself
 * while the store lives in that same account — see the honest scoping in
 * control-plane.md §4.9.
 */
export const directoryDump = z.object({
  /** ISO 8601 capture time — and, since there is only one directory, the copy's address. */
  capturedAt: z.string().min(1),
  tables: z.array(scopeDumpTable),
});
export type DirectoryDump = z.infer<typeof directoryDump>;

/**
 * One stored DIRECTORY backup, as the list surface reports it (#40) — metadata about a
 * `directoryDump` the platform holds, never the dump itself. The scope-level analogue is
 * `scopeBackup`; this one carries no tenant or scope because the directory is the thing
 * that knows about tenants and scopes.
 */
export const directoryBackup = z.object({
  /** ISO 8601 — the dump's own `capturedAt`, and this backup's address. */
  capturedAt: z.string().min(1),
  /** Serialized size in bytes — what tells a real copy from an empty one at a glance. */
  size: z.number().int().nonnegative(),
  /** Tables carried; zero means the copy is not restorable. */
  tables: z.number().int().nonnegative(),
});
export type DirectoryBackup = z.infer<typeof directoryBackup>;

/**
 * ## Replaying a dump: a dump is untrusted input at every site that replays it
 *
 * A `ScopeDumpTable` names its own tables and columns and carries its own schema
 * text, and all three reach SQL as TEXT — a bind parameter can stand in for a value
 * but never for an identifier, and never for a `CREATE TABLE`. So the quoting used to
 * be the only thing in the way, and a crafted name walks straight out of it:
 *
 * ```
 * x") ; ATTACH DATABASE '/tmp/pwned.db' AS e; --
 * ```
 *
 * Three call sites replay a dump — the CLI's `scope pull`/`restore`, the SQLite
 * adapter's `loadDump`, and the two Durable Object paths (`scope-do`, `control-plane-do`).
 * The checks live HERE, beside the schema they judge, because the alternative is the
 * same security rule written three times and fixed in one of them. #1143.
 *
 * The rule is **refuse the backup**, not quote harder. Every table a substrat scope
 * holds is a plain word, so a name that is not one is corruption or an attack, and
 * neither is worth loading.
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throw naming the offending identifier, or return it.
 *
 * Exported because a caller that reads names one at a time — walking `sqlite_master`
 * in a file it was handed, say — has to check each one at the point it interpolates
 * it, not as a batch afterwards.
 */
export function assertSqlIdentifier(name: string, what: string): string {
  if (!SQL_IDENTIFIER.test(name)) {
    throw new Error(
      `refusing this dump: ${what} ${JSON.stringify(name)} is not a plain SQL identifier ` +
        '(letters, digits and underscore, not starting with a digit). A scope dump whose ' +
        'names do not read like table names is corrupt or crafted — it is not loaded.',
    );
  }
  return name;
}

/** Every table and column name in a dump, checked before any of them reaches SQL. */
export function assertDumpIdentifiers(tables: { name: string; columns?: string[] }[]): void {
  const seen = new Set<string>();
  for (const t of tables) {
    assertSqlIdentifier(t.name, 'table name');
    // A dump lists each table once. A REPEATED name is how a crafted one hides: the
    // honest entry creates the table, and a second entry under the same name carries
    // the payload while every per-entry check still sees a table that exists.
    // Compared case-insensitively, because SQLite resolves table names that way —
    // `Users` and `users` are one table, so two entries would otherwise merge into
    // it. `sqlIdentifier` has already limited the name to ASCII, so lowercasing is
    // the same fold SQLite applies rather than an approximation of it.
    const key = t.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `refusing this dump: table ${JSON.stringify(t.name)} is listed twice (SQLite resolves table ` +
          'names case-insensitively, so names differing only in case are one table). A scope dump names ' +
          'each of its tables once — a repeat is corrupt or crafted, and it is not loaded.',
      );
    }
    seen.add(key);
    for (const c of t.columns ?? []) {
      assertSqlIdentifier(c, `column name in table ${JSON.stringify(t.name)}`);
    }
  }
}

const CREATE_TABLE_HEAD =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i;

/**
 * Is there a SECOND statement in this text?
 *
 * A small SQL-aware scan rather than a `split(';')`: a `;` inside a string literal,
 * a quoted identifier or a comment is not a statement boundary, and treating one as
 * such would refuse honest schemas (a DEFAULT of `'a;b'` is legal). Only a top-level
 * `;` with something other than whitespace or comments after it counts.
 *
 * A table's DDL is a single `CREATE TABLE`, so there is deliberately no `BEGIN … END`
 * handling here — that belongs to triggers, which a dump's `ddl` field never carries.
 */
function hasTrailingStatement(sql: string): boolean {
  const n = sql.length;
  let i = 0;
  let ended = false;
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
    // A string literal, or a quoted identifier. The closing mark doubles to escape
    // itself in all three of SQLite's quoting styles.
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
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
    if (c === '[') {
      while (i < n && sql[i] !== ']') i += 1;
      i += 1;
      continue;
    }
    if (c === ';') {
      ended = true;
      i += 1;
      continue;
    }
    // Anything that is not whitespace, after a top-level `;`, is a second statement.
    if (ended && !/\s/.test(c as string)) return true;
    i += 1;
  }
  return false;
}

/**
 * A dumped table's schema is exactly one `CREATE TABLE` for the name the dump
 * declared — checked BEFORE it runs, because a check that runs afterwards has
 * already let the statement happen.
 *
 * Both halves are load-bearing, and the second is the one that is easy to miss.
 * Executing a table's `ddl` runs EVERY statement the text contains — `db.exec` on
 * better-sqlite3 and `SqlStorage.exec` on a Durable Object both do — so
 * `CREATE TABLE x (id TEXT); ATTACH DATABASE '/tmp/out' AS e;` executed both halves
 * with two entirely plain identifiers, and nothing an identifier check adds would
 * have caught it. Pinning the head alone is not enough either: a trailing statement
 * rides in behind a perfectly honest `CREATE TABLE`.
 *
 * Refusing beats relying on the driver to compile only the first statement. That is
 * true of better-sqlite3's `prepare` and NOT true of a Durable Object, which has no
 * prepare step at all — so a rule that leaned on it would hold in the CLI and quietly
 * fail on the hosted path, which is the one that matters most.
 */
export function assertSingleCreateTable(ddl: string, name: string): void {
  const head = CREATE_TABLE_HEAD.exec(ddl);
  const creates = head ? (head[1] ?? head[2] ?? head[3] ?? head[4]) : undefined;
  if (creates !== name) {
    throw new Error(
      `refusing this dump: the schema given for table ${JSON.stringify(name)} does not begin with ` +
        `\`CREATE TABLE ${name} (\` — it begins ${JSON.stringify(ddl.slice(0, 60))}. A scope dump's schema ` +
        'and its own table list have to agree; one that does not is corrupt or crafted, and it is not loaded.',
    );
  }
  if (hasTrailingStatement(ddl)) {
    throw new Error(
      `refusing this dump: the schema given for table ${JSON.stringify(name)} carries more than one ` +
        'statement. A dumped table is one `CREATE TABLE`; anything appended to it would execute with ' +
        'the same privileges as the restore, so the dump is not loaded.',
    );
  }
}

/**
 * Everything a dump must satisfy before any of it reaches SQL: its identifiers, and
 * one `CREATE TABLE` per table. The single entry point a replay site calls, so a new
 * one cannot pick up half the rules.
 */
export function assertReplayableDump(tables: { name: string; ddl: string; columns?: string[] }[]): void {
  assertDumpIdentifiers(tables);
  for (const t of tables) assertSingleCreateTable(t.ddl, t.name);
}
