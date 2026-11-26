/**
 * K-69 (no scheduled walk over tenants), step 5 of rfc/tenant-scale.md §7.5: the scope's half of
 * the on-wake provision reconcile.
 *
 * A promote re-uploads the serving script in place (K-33), so every scope runs the new code from
 * its next wake, and its migration pass runs on that wake (`ensureMigrations`). What the code
 * cannot do from inside the scope is the provision reconcile (#1172): it needs the platform's
 * directory (entitlements, identity links, connection grants, the receipt), which a sandboxed
 * vertical never reaches. So the scope ASKS, once per version, through the road a sandbox-clean
 * scope already has upward: an intent in its own platform-intent journal
 * (docs/architecture/platform-intents.md). The router's kick after the request that woke it drains
 * the intent in seconds; the drain's backstop, and from step 4 the scope's own alarm, reach a scope
 * woken by an alarm. The handler decides from the directory, with the batched pass's own rule
 * (`provisionReconcileTarget`), and does nothing when the receipt already matches.
 *
 * The scope remembers what it asked for in `_substrat_meta` (`RECONCILE_ASKED_KEY`), in the same
 * transaction as the intent row, so asking is once per version, not once per wake: a scope evicted
 * and revived a hundred times a day writes one row per promote. Nothing here may fail the
 * migration pass it runs after: a scope that cannot ask stays on the batched pass, which is still
 * running (step 5 keeps it until the count has been watched through several promotes).
 */
import { MAX_PENDING_PLATFORM_REQUESTS, PROVISION_RECONCILE_KIND, platformRequestId } from '@substrat-run/contracts';
import { CONNECTOR_DISPATCH_REQUESTED_BY, IS_COPY_SQL, ulid } from '@substrat-run/kernel';

/** The `_substrat_meta` key holding the version this scope last asked a reconcile for. */
export const RECONCILE_ASKED_KEY = 'reconcile_asked_for';

/** Who a `provision-reconcile` intent is requested by: the scope's host, never a person. */
export const RECONCILE_ON_WAKE_REQUESTED_BY = JSON.stringify({ system: 'reconcile-on-wake' });

/** What one wake did, for the caller's signal and a test's assertion. */
export type ReconcileOnWake =
  /** An intent was written: the response that woke the scope should flag a drain. */
  | 'requested'
  /** Already asked for this version (or for an earlier one still pending): nothing written. */
  | 'asked'
  /** A first provision: the platform's own provision marks the receipt; recorded, nothing asked. */
  | 'first-provision'
  /** A preview or a fork (#2005): nothing reconciles a copy, so it asks for nothing. */
  | 'copy'
  /** The journal is at its cap: nothing written, asked again on the next wake. */
  | 'full'
  /** No version identity (local dev, a test host): nothing to compare. */
  | 'no-version';

/** The slice of the object's SQL handle this reads and writes. */
export interface WakeSql {
  exec(sql: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/**
 * Ask for a reconcile if this wake is the first on `version`. `upgrade` is whether the scope held
 * applied migrations before the pass that just succeeded: a scope with none is being provisioned,
 * and its provision runs the hook and writes the receipt itself.
 *
 * Synchronous on purpose, and called with no `await` between the reads and the writes, so the
 * check, the intent and the key land in one of the object's implicit transactions and two
 * requests racing to wake the scope cannot both ask (the object runs one at a time).
 */
export function reconcileOnWake(
  sql: WakeSql,
  version: string | null | undefined,
  upgrade: boolean,
  now: string,
): ReconcileOnWake {
  if (!version) return 'no-version';
  const asked = (sql.exec(`SELECT value FROM _substrat_meta WHERE key = ?`, RECONCILE_ASKED_KEY).toArray()[0] as
    | { value: string }
    | undefined)?.value;
  if (asked === version) return 'asked';
  const remember = () =>
    sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES (?, ?)`, RECONCILE_ASKED_KEY, version);
  if (!upgrade) {
    remember();
    return 'first-provision';
  }
  if (hasTable(sql, '_substrat_copy_origin') && sql.exec(IS_COPY_SQL).toArray().length > 0) return 'copy';
  // One pending ask is enough whatever version it named: the handler reconciles against what the
  // scope runs when it is drained, not against the payload.
  const pending = sql
    .exec(`SELECT 1 FROM _substrat_platform_requests WHERE kind = ? AND status = 'pending' LIMIT 1`, PROVISION_RECONCILE_KIND)
    .toArray();
  if (pending.length > 0) {
    remember();
    return 'asked';
  }
  // The shared journal's room (platform-intents.md): a wake never takes the last slot a vertical's
  // own intent needs by more than one, and never writes past the cap.
  const held = (
    sql
      .exec(
        `SELECT COUNT(*) AS c FROM _substrat_platform_requests WHERE status = 'pending' AND requested_by != ?`,
        CONNECTOR_DISPATCH_REQUESTED_BY,
      )
      .toArray()[0] as { c: number }
  ).c;
  if (held >= MAX_PENDING_PLATFORM_REQUESTS) return 'full';
  sql.exec(
    `INSERT INTO _substrat_platform_requests
       (id, kind, payload, requested_by, impersonation, status, attempts, requested_at)
     VALUES (?, ?, ?, ?, NULL, 'pending', 0, ?)`,
    platformRequestId.parse(ulid()),
    PROVISION_RECONCILE_KIND,
    JSON.stringify({ wokeOn: version }),
    RECONCILE_ON_WAKE_REQUESTED_BY,
    now,
  );
  remember();
  return 'requested';
}

function hasTable(sql: WakeSql, name: string): boolean {
  return sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name).toArray().length > 0;
}
