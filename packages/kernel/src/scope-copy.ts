import type { PlatformRequestFailure } from '@substrat-run/contracts';
import { CAPABILITY_TABLE_NAMES } from './capability.js';
import type { SwitchSql } from './system-switch.js';

/**
 * What a dump leaves behind when it lands in a scope other than the one it was captured from
 * (#1686). One definition for both adapters' loaders, so the DO and the pure host agree.
 *
 * A load is a **copy** when the destination is not the source: a fork, a snapshot, a preview, or
 * one scope's backup restored onto another. It is a **return** when the dump goes back into the
 * scope it came from: a backup restore, a carry onto a new version, adopt, rebind. A copy runs as
 * a scope of its own, so whatever in the dump is bound to being the source (a live link's secret,
 * a side effect the source asked for) must not work in the copy. A return keeps all of it, because
 * restoring a backup must not end live links or lose requests that were waiting.
 *
 * An unknown source (`sourceScopeId` or `destScopeId` absent) counts as a copy: a load that cannot
 * say where the dump came from cannot show it is a return. Only a control plane that predates the
 * field sends a restore with no source.
 */
const isCopy = (destScopeId: string | undefined, sourceScopeId: string | undefined): boolean =>
  destScopeId === undefined || sourceScopeId !== destScopeId;

/** The capability tables, as `capabilitiesForLoad` matches a dump's (lowercased) names. */
const CAPABILITY_TABLES: ReadonlySet<string> = new Set(CAPABILITY_TABLE_NAMES);

/**
 * A dump's tables as a load into `destScopeId` takes them: **capability rows never cross a scope
 * id.** A copy loads both capability tables empty, so a live link share opens the scope it was
 * minted in and never a copy of it; a return keeps them.
 *
 * Dropped, not loaded as revoked: the copy never minted those links, so a revocation recorded
 * there would be evidence of something that did not happen in it. Names are matched without
 * case, as SQLite resolves a table name.
 */
export function capabilitiesForLoad<T extends { name: string; rows: readonly unknown[] }>(
  tables: T[],
  destScopeId: string | undefined,
  sourceScopeId: string | undefined,
): T[] {
  if (!isCopy(destScopeId, sourceScopeId)) return tables;
  return tables.map((t) => (CAPABILITY_TABLES.has(t.name.toLowerCase()) ? { ...t, rows: [] } : t));
}

/** The reason copied work is settled with. Names the source, so the journal says where it runs. */
const notCarried = (sourceScopeId: string | undefined): string =>
  `not carried: copied from ${sourceScopeId ? `scope ${sourceScopeId}` : 'another scope'} before it ran; ` +
  'it runs in the scope that asked for it, never in a copy';

/** A copied intent's failure: the platform's own refusal, never the provider's answer. */
const NOT_CARRIED_FAILURE = JSON.stringify({
  origin: 'platform',
  code: 'precondition_failed',
  permission: null,
} satisfies PlatformRequestFailure);

/**
 * Where a scope's data came from, and whether it is a copy: at most one row, which holds two
 * facts that are set and corrected apart (#2009).
 *
 * - **`events_through`, the copied-events mark.** The highest event id a load brought in from
 *   another scope, or `''` when it brought none. Every event at or below it was emitted in another
 *   scope; every event the scope emits itself sorts above it, because a loader re-seeds the
 *   scope's event-id floor from `MAX(id)` (#1335) once the rows are in. Written by a load into a
 *   scope id other than the dump's (`settleCopiedWork`), and by nothing else.
 * - **`is_copy`, the classification.** Whether the scope is a copy (a fork, a snapshot, a
 *   preview), which a host with no control-plane directory reads for primacy and holds inert
 *   (#2005). Written on the directory's word only (`markCopyOrigin`), never inferred from a load:
 *   one install's backup restored onto another install is a cross-scope load, so it carries the
 *   source's events mark, yet the directory still says primary, and its own effects must run.
 *   Cleared by staff's correction (`clearCopyMarker`) without touching the events mark.
 *
 * A scope that was never loaded from another scope and never marked holds no row. A row written
 * before the column existed holds `is_copy` NULL, and NULL reads as a copy: such a row meant both
 * facts at once, so every legacy store keeps exactly the behaviour it had (`IS_COPY_SQL`). The
 * column is nullable with no DEFAULT for the reason every additive spine column is (#1883,
 * `lint:spine-ddl`), so its "default" lives in that read. Kernel-owned and shared by both
 * adapters' `KERNEL_DDL`, so the two cannot part company.
 */
export const COPY_ORIGIN_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_copy_origin (
    -- Always 1: one origin per scope. No CHECK, because lint:spine-ddl compares none.
    id INTEGER PRIMARY KEY,
    source_scope_id TEXT,
    events_through TEXT NOT NULL,
    copied_at TEXT NOT NULL,
    -- #2009: 1 a copy, 0 not one (a load's events mark only, or a cleared marker), NULL a row
    -- from before the column, which read as a copy and still does.
    is_copy INTEGER
  );
`;

/**
 * The predicate every read that turns an outbox row into WORK carries (consumer dispatch, executor
 * dispatch, the Tier-2 drain): the event was emitted in this scope, not copied into it. `alias` is
 * the outbox's alias in the caller's query (`'o.'`), or empty. A scope that was never a copy has no
 * key, and every id compares above the empty string.
 */
export const emittedHere = (alias = ''): string =>
  `${alias}id > COALESCE((SELECT events_through FROM _substrat_copy_origin WHERE id = 1), '')`;

/**
 * On a copy, nothing that originated in the source produces an effect in the destination. Run
 * inside the load's transaction, after the rows are in and BEFORE the loader queues any work of
 * its own (the attachment-text re-extraction is a job run), or that work is settled with the
 * source's. The history stays: every row is still
 * there and reads as what happened at the source; only its power to cause something here goes.
 *
 * The platform's drain walks every active scope, and a fork, a snapshot or a preview is one, so
 * each of these would otherwise run a second time from the copy (an email sent twice, a connector
 * delivery repeated, a usage line billed twice):
 *
 * - **Pending intents** settle `failed`, "not carried", attributed to the platform.
 * - **Executor retries** (`_substrat_deliveries` rows with a `next_attempt_at`) become terminal,
 *   with "not carried" as their error, as a dead letter reads.
 * - **Running job runs** settle `failed`, "not carried"; their step ledger stays as evidence.
 * - **Events no consumer or executor has reached yet** cannot be settled row by row: an executor is
 *   registered on the coordinator, not in the scope, so the loader cannot know who still owes one.
 *   Instead the copy records the highest id it brought in (`_substrat_copy_origin`), and every
 *   read that dispatches work carries `emittedHere()`. That also keeps the copy from shipping the
 *   source's events to Tier 2 a second time.
 *
 * A return leaves all of it as it was, because the scope that asked for the work is the one it is
 * back in. Settled rather than dropped: a journal row saying "not carried" explains why the event
 * that raised it caused nothing here, where a missing row would leave a gap.
 */
export function settleCopiedWork(
  sql: SwitchSql,
  destScopeId: string | undefined,
  sourceScopeId: string | undefined,
  now: string,
): void {
  if (!isCopy(destScopeId, sourceScopeId)) return;
  const reason = notCarried(sourceScopeId);
  sql.run(
    `UPDATE _substrat_platform_requests
        SET status = 'failed', last_error = ?, last_failure = ?, settled_at = ?
      WHERE status = 'pending'`,
    reason,
    NOT_CARRIED_FAILURE,
    now,
  );
  sql.run(
    `UPDATE _substrat_deliveries SET next_attempt_at = NULL, error = ?, delivered_at = ?
      WHERE next_attempt_at IS NOT NULL`,
    reason,
    now,
  );
  sql.run(
    `UPDATE _substrat_job_runs
        SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?, ended_at = ?
      WHERE status = 'running'`,
    reason,
    now,
    now,
  );
  const highest = sql.all('SELECT MAX(id) AS id FROM _substrat_outbox')[0]?.id;
  // Written for an empty copy too: `''` is below every id, so `emittedHere()` passes all of the
  // scope's own events exactly as no row would. An origin the dump already carried with the same
  // source and mark is kept as it was, its `copied_at` included, so re-loading the same export
  // changes nothing in it.
  //
  // `is_copy` is 0 (#2009): the load moves the events mark and does not classify. Whatever the
  // dump's row said described the scope it came FROM; whether THIS scope is a copy is the
  // directory's to say, through `markCopyOrigin`, which the loader runs after this when the
  // directory says so.
  sql.run(
    `INSERT INTO _substrat_copy_origin (id, source_scope_id, events_through, copied_at, is_copy) VALUES (1, ?, ?, ?, 0)
       ON CONFLICT (id) DO UPDATE SET
         source_scope_id = excluded.source_scope_id,
         events_through = excluded.events_through,
         copied_at = excluded.copied_at,
         is_copy = excluded.is_copy
       WHERE _substrat_copy_origin.source_scope_id IS NOT excluded.source_scope_id
          OR _substrat_copy_origin.events_through IS NOT excluded.events_through
          OR _substrat_copy_origin.is_copy IS NOT excluded.is_copy`,
    sourceScopeId ?? null,
    typeof highest === 'string' ? highest : '',
    now,
  );
}

/**
 * Mark this scope a copy (#2005), on the directory's word that it is not primary: a load the
 * platform flags, the `mark-copies` repair, a reactivation, a carry's wipe or release. Sets the
 * classification and nothing else (#2009): an origin row a load wrote keeps its events mark and
 * source, and a scope with no row gets one whose events mark is `''`, which passes every event
 * exactly as no row does, so dispatch is unchanged. Idempotent: answers whether this call changed
 * anything, and a store that already reads as a copy (a legacy row included) is left as it is.
 */
export function markCopyOrigin(sql: SwitchSql, now: string): boolean {
  if (sql.all(IS_COPY_SQL).length > 0) return false;
  sql.run(MARK_COPY_ORIGIN_SQL, now);
  return true;
}

/**
 * The one statement that marks a store a copy (#2005, #2009): the origin row with no events mark
 * where none exists, or the classification set on the row that does. It only ever makes a store
 * MORE restricted — a copy's executors are held inert — and changes no data and no events mark,
 * which is why the scope DO lets this statement, and no other, through without advancing the
 * write revision a carry fences on (#1722, `isCopyMarkInsert`). Clearing a marker is the opposite
 * and is a write like any other.
 */
export const MARK_COPY_ORIGIN_SQL =
  "INSERT INTO _substrat_copy_origin (id, source_scope_id, events_through, copied_at, is_copy) VALUES (1, NULL, '', ?, 1) " +
  'ON CONFLICT (id) DO UPDATE SET is_copy = 1';

/**
 * Correct a MISTAKEN copy classification (#2005, #2009): for a scope the directory says is
 * primary, marked by a misclassification, a race, an operator, or a row from before #2009 that
 * a cross-scope load wrote (one install's backup restored onto another). Clears the
 * classification only: the events mark stays, so the source's queued work is still never run
 * here (`emittedHere()`), and the scope's own effects run again. `absent` when the store does not
 * read as a copy.
 */
export function clearCopyMarker(sql: SwitchSql): 'cleared' | 'absent' {
  if (sql.all(IS_COPY_SQL).length === 0) return 'absent';
  sql.run('UPDATE _substrat_copy_origin SET is_copy = 0 WHERE id = 1');
  return 'cleared';
}

/**
 * Whether this scope is a copy (#2005, #2009): the classification on its copy-origin row, with
 * a row from before the column (NULL) read as one. The one primacy fact a host with no
 * control-plane directory can read from the scope's own storage — a CP-less hosted vertical's
 * coordinator asks it before it runs an executor.
 */
export const IS_COPY_SQL = 'SELECT 1 AS copy FROM _substrat_copy_origin WHERE id = 1 AND COALESCE(is_copy, 1) = 1';
