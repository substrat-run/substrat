import type { ScopeId, TenantId } from '@substrat-run/contracts';
import type { ScopeCopyMoveConfirmation, ScopeScriptCopy } from './scope-host.js';

/**
 * The directory's copy ledger (#1722), in the one SQL grammar both adapters run: the pure
 * adapter's directory and the control-plane Durable Object build the same `scope_script_copies`
 * table (`lint:spine-ddl` holds them to it), so the statements that lease, confirm and claim
 * its entries live here rather than being spelled twice.
 *
 * A pending entry belongs to the move that recorded it until its lease runs out. Two things
 * read that lease, and they are what make crash recovery safe against a move that is merely
 * slow rather than dead:
 *
 * - The bind that routes the scope onto the move's destination (`COPY_MOVE_LIVE_PREDICATE`)
 *   lands only while every entry of the move is pending, unclaimed and inside its lease, and
 *   settles them in the same write (`COPY_MOVE_CONFIRM_SQL`).
 * - A sweep claims only an entry whose lease has run out (`COPY_EXPIRED_SQL` then
 *   `COPY_CLAIM_SQL`), which no bind can confirm any more.
 *
 * So exactly one of them acts on a move: the bind before the lease ends, or the sweep after.
 */

/** Appended to a conditional bind's `UPDATE scopes … WHERE`. Params: `copyMoveLiveParams`. */
export const COPY_MOVE_LIVE_PREDICATE = `
  AND EXISTS (SELECT 1 FROM scope_script_copies AS move
    WHERE move.tenant_id = scopes.tenant_id AND move.scope_id = scopes.scope_id AND move.move_id = ?)
  AND NOT EXISTS (SELECT 1 FROM scope_script_copies AS move
    WHERE move.tenant_id = scopes.tenant_id AND move.scope_id = scopes.scope_id AND move.move_id = ?
      AND (move.state <> 'pending' OR move.lease_owner IS NOT NULL
        OR move.lease_until IS NULL OR move.lease_until <= ?))`;

export const copyMoveLiveParams = (confirm: ScopeCopyMoveConfirmation, now: string): string[] =>
  [confirm.moveId, confirm.moveId, now];

/**
 * Run in the bind's own transaction once its row update landed: the destination is now the
 * route, and the source becomes what the move says (a carry's source is eligible for its fenced
 * wipe; an adopt or rebind keeps its source as the backout). Params: `copyMoveConfirmParams`.
 */
export const COPY_MOVE_CONFIRM_SQL = `
  UPDATE scope_script_copies SET
    state = CASE role WHEN 'destination' THEN 'done' ELSE ? END,
    load_stamp = CASE role WHEN 'destination' THEN load_stamp ELSE ? END,
    revision = CASE role WHEN 'destination' THEN revision ELSE ? END,
    last_attempt_at = ?
  WHERE tenant_id = ? AND scope_id = ? AND move_id = ? AND state = 'pending'`;

export const copyMoveConfirmParams = (
  confirm: ScopeCopyMoveConfirmation, tenantId: string, scopeId: string, now: string,
): (string | null)[] => [
  confirm.source, confirm.sourceMarker?.loadStamp ?? null, confirm.sourceMarker?.revision ?? null,
  now, tenantId, scopeId, confirm.moveId,
];

/** Pending entries whose lease ran out before `?` (or that never had one), oldest first, `LIMIT ?`. */
export const COPY_EXPIRED_SQL = `
  SELECT tenant_id, scope_id, script_ref, move_id FROM scope_script_copies
  WHERE state = 'pending' AND (lease_until IS NULL OR lease_until <= ?)
  ORDER BY lease_until, tenant_id, scope_id, script_ref, move_id LIMIT ?`;

/** Claim one expired entry, re-checked in the write. Params: owner, leaseUntil, the key, now. */
export const COPY_CLAIM_SQL = `
  UPDATE scope_script_copies SET lease_owner = ?, lease_until = ?
  WHERE tenant_id = ? AND scope_id = ? AND script_ref = ? AND move_id = ?
    AND state = 'pending' AND (lease_until IS NULL OR lease_until <= ?)`;

/**
 * The fence a copy move's restore carries into the destination's own store (#1722). The vertical
 * that holds the destination has no reach to the directory, so the move's lease travels with
 * the restore instead: the store refuses the load, inside the load's own transaction, once
 * `notAfter` has passed, and writes nothing.
 *
 * `notAfter` sits a margin inside the move's lease (`copyRestoreFence`), and everything that could
 * make a late restore wrong waits for that lease to end first. A sweep claims an entry only once
 * its lease has run out. A reap claims the scope, and an erasure finalizes, only while no entry
 * of any move is pending, so for an unconfirmed move only after that sweep. A restore that is
 * not refused therefore committed before any of them, and one that would land after any of them
 * is refused. The margin absorbs clock skew between the directory and the destination, and
 * `moveId` and `erasureEpoch` name the move and the erasure state it was issued under.
 */
export interface CopyRestoreFence {
  moveId: string;
  notAfter: string;
  erasureEpoch: number;
}

/** How far inside the lease a restore must commit: five minutes, or a quarter of a short lease. */
export const copyRestoreFenceMarginMs = (leaseMs: number): number => Math.min(5 * 60_000, Math.floor(leaseMs / 4));

/** The fence for a move whose entries were recorded no earlier than `recordedAt` (epoch ms). */
export const copyRestoreFence = (
  moveId: string, recordedAt: number, leaseMs: number, erasureEpoch: number,
): CopyRestoreFence => ({
  moveId,
  notAfter: new Date(recordedAt + leaseMs - copyRestoreFenceMarginMs(leaseMs)).toISOString(),
  erasureEpoch,
});

/** Whether a restore carrying `fence` may no longer land at `now` (epoch ms). */
export const copyRestoreFenceLapsed = (fence: CopyRestoreFence, now: number): boolean => now > Date.parse(fence.notAfter);

/** The refusal a lapsed fence answers with, the same words on every host. */
export const COPY_RESTORE_FENCE_LAPSED = "the copy move's lease ran out before its restore; nothing was loaded (#1722)";

/** A ledger row as both adapters read it. */
export interface ScopeScriptCopyRow {
  tenant_id: string;
  scope_id: string;
  script_ref: string;
  move_id: string;
  state: string;
  load_stamp: string | null;
  revision: string | null;
  role: string | null;
  lease_until: string | null;
}

/** The columns `ScopeScriptCopyRow` names, for a read that does not take `SELECT *`. */
export const SCOPE_SCRIPT_COPY_COLUMNS =
  'tenant_id, scope_id, script_ref, move_id, state, load_stamp, revision, role, lease_until';

export const scopeScriptCopyOf = (r: ScopeScriptCopyRow): ScopeScriptCopy => ({
  tenantId: r.tenant_id as TenantId,
  scopeId: r.scope_id as ScopeId,
  scriptRef: r.script_ref,
  moveId: r.move_id,
  state: r.state as ScopeScriptCopy['state'],
  loadStamp: r.load_stamp,
  revision: r.revision,
  role: r.role === 'source' || r.role === 'destination' ? r.role : null,
  leaseUntil: r.lease_until,
});
