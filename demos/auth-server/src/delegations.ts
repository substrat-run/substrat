import {
  DELEGATIONS_CONFIG_PREFIX,
  delegationGrants,
  scopeId as scopeIdSchema,
  type DelegationGrant,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * Which app may act for which other app's users at this issuer (#1824) — the gate on token
 * exchange (`token-exchange.ts`).
 *
 * A host app delegates to an actor app, for a named subset of the host's permissions. The
 * PLATFORM says so, and nobody else: the dashboard delivers each host's whole set through the
 * platform-gated `/internal/configure` (`substrat:delegations:<host scope id>`, vocabulary in
 * `@substrat-run/contracts`), and this file turns it into `delegation_grant` rows. No request
 * a client can make writes the table, so a client that authenticates at the token endpoint
 * can use a grant but never give itself one.
 *
 * The rows are the source of truth, and the ONLY one. A token minted by an exchange carries
 * `may_act` / `act` claims, but nothing here reads them to decide anything: both exchanges
 * re-read the grant, so a revocation (the host's next delivery leaving the actor out) refuses
 * the very next exchange, and an access token already minted outlives it by at most its own
 * lifetime.
 *
 * Grants are keyed by app SCOPE, not by client id. A client id is what the token endpoint
 * authenticates, and the platform's own `place_app` binding (`places.ts`) is what says which
 * scope that client is. So a client re-registered to another scope, or an app moved to another
 * issuer, loses the grant with the binding — nothing here has to follow it.
 */

export function isDelegationsEntry(key: string): boolean {
  return key.startsWith(DELEGATIONS_CONFIG_PREFIX);
}

/** One host's desired set, parsed and validated. */
export interface DelegationsDelivery {
  hostAppScopeId: string;
  grants: DelegationGrant[];
}

/**
 * A delivered entry, validated. Throws on anything malformed, and the caller parses every
 * entry of a delivery before writing any, so a bad one refuses the whole call (400). `""` and
 * `[]` both mean "this host delegates to nobody".
 */
export function parseDelegationsEntry(key: string, value: string): DelegationsDelivery {
  const hostAppScopeId = scopeIdSchema.parse(key.slice(DELEGATIONS_CONFIG_PREFIX.length));
  if (value.trim() === '') return { hostAppScopeId, grants: [] };
  return { hostAppScopeId, grants: delegationGrants.parse(JSON.parse(value)) };
}

/** What one sync did, for a caller that logs it and a test that pins it. */
export interface DelegationsSync {
  granted: string[];
  updated: string[];
  revoked: string[];
}

/** One live grant, as an exchange reads it. */
export interface ActiveGrant {
  permissions: string[];
}

/**
 * Make one host's grants exactly `grants`: an actor it no longer names is revoked, a changed
 * permission set replaces the old one, and an unchanged grant is not written at all.
 *
 * Synchronous from first read to last write; the caller owns the transaction (the DO runs
 * this inside `storage.transactionSync` with the rest of the delivery).
 */
export function syncDelegations(sql: SqlExec, delivery: DelegationsDelivery, nowMs: number): DelegationsSync {
  const { hostAppScopeId, grants } = delivery;
  const result: DelegationsSync = { granted: [], updated: [], revoked: [] };
  const existing = new Map(
    (
      sql
        .exec('SELECT actor_app_scope_id, permissions FROM delegation_grant WHERE host_app_scope_id = ?', hostAppScopeId)
        .toArray() as { actor_app_scope_id: string; permissions: string }[]
    ).map((r) => [r.actor_app_scope_id, r.permissions]),
  );
  const wanted = new Map(grants.map((g) => [g.actor as string, JSON.stringify([...new Set(g.permissions)])]));

  for (const actor of existing.keys()) {
    if (wanted.has(actor)) continue;
    sql.exec('DELETE FROM delegation_grant WHERE host_app_scope_id = ? AND actor_app_scope_id = ?', hostAppScopeId, actor);
    result.revoked.push(actor);
  }
  for (const [actor, permissions] of wanted) {
    const had = existing.get(actor);
    if (had === permissions) continue;
    if (had === undefined) {
      sql.exec(
        'INSERT INTO delegation_grant (host_app_scope_id, actor_app_scope_id, permissions, updated_at) VALUES (?, ?, ?, ?)',
        hostAppScopeId,
        actor,
        permissions,
        nowMs,
      );
      result.granted.push(actor);
      continue;
    }
    sql.exec(
      'UPDATE delegation_grant SET permissions = ?, updated_at = ? WHERE host_app_scope_id = ? AND actor_app_scope_id = ?',
      permissions,
      nowMs,
      hostAppScopeId,
      actor,
    );
    result.updated.push(actor);
  }
  return result;
}

/**
 * The grant from `host` to `actor`, or undefined when there is none. A row whose permissions
 * do not read back as a non-empty list of strings answers undefined too: only the delivery
 * writes the column, so that row is damage, and damage grants nothing.
 */
export function grantFor(sql: SqlExec, hostAppScopeId: string, actorAppScopeId: string): ActiveGrant | undefined {
  const row = (
    sql
      .exec(
        'SELECT permissions FROM delegation_grant WHERE host_app_scope_id = ? AND actor_app_scope_id = ?',
        hostAppScopeId,
        actorAppScopeId,
      )
      .toArray() as { permissions: string }[]
  )[0];
  if (!row) return undefined;
  let permissions: unknown;
  try {
    permissions = JSON.parse(row.permissions);
  } catch {
    return undefined;
  }
  if (!Array.isArray(permissions) || permissions.length === 0) return undefined;
  if (!permissions.every((p): p is string => typeof p === 'string' && p.length > 0)) return undefined;
  return { permissions };
}
