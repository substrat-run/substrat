import type { Scope, ScopeStatus, Tenant, TenantId } from '@substrat-run/contracts';

/**
 * Effective vs stored scope status — the one place the console is allowed to
 * disagree with the directory, and the reason it must be a named function
 * instead of a condition inlined into a table cell.
 *
 * Suspending a TENANT does not touch its scopes' rows. The kernel fails
 * `getScope` closed by checking the tenant first (control-plane.md §4.1), so a
 * scope under a suspended tenant is stored `active` while being, in every way a
 * user can observe, suspended. The console must show what is true, not what is
 * stored — otherwise a tenant-wide outage renders as a healthy fleet.
 *
 * The consequence to remember: `effectiveStatus` counts will NOT match
 * `listScopes({ status: 'suspended' })`. That is correct. The filter reads rows;
 * this reads reality.
 */
export type EffectiveStatus = ScopeStatus | 'suspended-via-tenant';

/**
 * Only an `active` scope can be cascaded. A scope that is already suspended or
 * archived carries its own status: those are its own lifecycle, and reporting an
 * archived scope as "suspended via tenant" would hide the more specific truth.
 */
export function effectiveStatus(scope: Scope, tenant: Tenant | undefined): EffectiveStatus {
  if (scope.status === 'active' && tenant && tenant.status !== 'active') {
    return 'suspended-via-tenant';
  }
  return scope.status;
}

export function isSuspended(s: EffectiveStatus): boolean {
  return s === 'suspended' || s === 'suspended-via-tenant';
}

export type BadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/**
 * The handoff's mapping, over exactly the five states the contract defines —
 * there is no "failed" scope status. A cascade reads as a warning like any other
 * suspension; the "via tenant" note beside it carries the distinction.
 */
export function statusTone(s: EffectiveStatus): BadgeTone {
  switch (s) {
    case 'active':
      return 'success';
    case 'provisioning':
      return 'info';
    case 'suspended':
    case 'suspended-via-tenant':
      return 'warning';
    case 'archiving':
    case 'archived':
    case 'reaped':
      return 'neutral';
  }
}

export function statusLabel(s: EffectiveStatus): string {
  return s === 'suspended-via-tenant' ? 'Suspended' : s[0]!.toUpperCase() + s.slice(1);
}

export function tenantTone(status: Tenant['status']): BadgeTone {
  return status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'danger';
}

/** `{tenant.slug}/{scope.slug}` — the console's handle. Scope slugs are unique per tenant, not per fleet. */
export function scopeHandle(scope: Scope, tenants: Map<TenantId, Tenant>): string {
  return `${tenants.get(scope.tenantId)?.slug ?? '?'}/${scope.slug}`;
}

export interface FleetCounts {
  scopes: number;
  active: number;
  suspended: number;
  viaCascade: number;
  archived: number;
}

/** Only what the directory and entitlement store can actually answer (§5). */
export function fleetCounts(scopes: Scope[], tenants: Map<TenantId, Tenant>): FleetCounts {
  const counts: FleetCounts = { scopes: scopes.length, active: 0, suspended: 0, viaCascade: 0, archived: 0 };
  for (const s of scopes) {
    const e = effectiveStatus(s, tenants.get(s.tenantId));
    if (e === 'active') counts.active++;
    // `reaped` folds under Archived — it is a deleted app whose storage is now gone, the
    // terminal end of the same tombstone, so the Archived tab stays its home.
    if (e === 'archived' || e === 'archiving' || e === 'reaped') counts.archived++;
    if (isSuspended(e)) counts.suspended++;
    if (e === 'suspended-via-tenant') counts.viaCascade++;
  }
  return counts;
}

/**
 * Which lifecycle actions to render. Only legal transitions appear — the graph
 * is enforced below the seam and an illegal one is a 409, so offering it would
 * be drawing a button whose only purpose is to fail.
 *
 * A cascade-suspended scope gets NO per-scope unsuspend: its row is already
 * `active`, so `unsuspendScope` would be rejected as an illegal transition. The
 * lever is the tenant.
 */
export function availableActions(
  s: EffectiveStatus,
): ('suspend' | 'unsuspend' | 'archive' | 'unarchive' | 'reap')[] {
  switch (s) {
    case 'active':
      return ['suspend', 'archive'];
    case 'suspended':
      return ['unsuspend', 'archive'];
    // An archived scope can be restored (unarchive) OR reaped — the latter frees its DO
    // storage for good (§4.4), which is why it is the one destructive, unrestorable action.
    case 'archived':
      return ['unarchive', 'reap'];
    // Terminal: storage is gone, the row is a tombstone. Nothing to offer.
    case 'reaped':
      return [];
    // Transient states settle into one of the above; nothing to offer meanwhile.
    case 'provisioning':
    case 'archiving':
    case 'suspended-via-tenant':
      return [];
  }
}
