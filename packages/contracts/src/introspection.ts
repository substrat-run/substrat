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
 * (docs/design/preview-and-snapshots.md §3) — the source a fork or a local pull
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
