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
 * Where a scope's data came from when it is a copy: at most one row, written by the load that made
 * it one. `events_through` is the highest event id the copy brought in. Every event at or below it
 * was emitted in another scope; every event the copy emits itself sorts above it, because a loader
 * re-seeds the scope's event-id floor from `MAX(id)` (#1335) once the rows are in. A scope that was
 * never a copy holds no row. Kernel-owned and shared by both adapters' `KERNEL_DDL`, so the two
 * cannot part company.
 */
export const COPY_ORIGIN_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_copy_origin (
    -- Always 1: one origin per scope. No CHECK, because lint:spine-ddl compares none.
    id INTEGER PRIMARY KEY,
    source_scope_id TEXT,
    events_through TEXT NOT NULL,
    copied_at TEXT NOT NULL
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
 * inside the load's transaction, after the rows are in. The history stays: every row is still
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
  if (typeof highest === 'string') {
    sql.run(
      'INSERT OR REPLACE INTO _substrat_copy_origin (id, source_scope_id, events_through, copied_at) VALUES (1, ?, ?, ?)',
      sourceScopeId ?? null,
      highest,
      now,
    );
  }
}
