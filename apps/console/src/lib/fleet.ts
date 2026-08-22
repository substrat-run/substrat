import { AUTO_ADMISSION_NOTE } from '@substrat-run/contracts';
import type { Scope, ScopeStatus, Tenant, TenantId, VerticalVersion } from '@substrat-run/contracts';

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

/**
 * Effective vs stored ADMISSION — the second place the console must disagree with the
 * directory, and for the same reason `effectiveStatus` above exists.
 *
 * A private vertical's push lands `admitted` straight away (builder-plane.md §4-revised)
 * carrying {@link AUTO_ADMISSION_NOTE}: serving-eligible, but read by nobody except its
 * author. That distinction is invisible in the `admission` field alone, and it is exactly
 * what the ONE remaining staff seam turns on — `setVerticalListed` refuses while prod
 * points at such a version, because listing is the moment other tenants start trusting
 * the code.
 *
 * Rendering the bare `admitted` badge therefore told an operator the version was vouched
 * for while the platform disagreed: List failed, and nothing on the page said why. Show
 * what is true, not what is stored.
 */
export type EffectiveAdmission = VerticalVersion['admission'] | 'auto-admitted';

export function effectiveAdmission(
  v: Pick<VerticalVersion, 'admission' | 'admissionNote'>,
): EffectiveAdmission {
  return v.admission === 'admitted' && v.admissionNote === AUTO_ADMISSION_NOTE
    ? 'auto-admitted'
    : v.admission;
}

/**
 * Does this version still need the human vouch that publishing requires? True exactly
 * when a staff `admitVersion` would do something — it upgrades an auto-admission to a
 * manual one by clearing the note (audited), which is the only way to make the vertical
 * listable. The console offers the action on precisely this predicate, so the button is
 * present when it works and absent when it would be a no-op.
 */
export function awaitingStaffVouch(v: Pick<VerticalVersion, 'admission' | 'admissionNote'>): boolean {
  return effectiveAdmission(v) === 'auto-admitted';
}

/**
 * `auto-admitted` is INFO, not warning: unlike `pending` it is not blocking anything the
 * owner is waiting on — the version deploys and serves its own tenant perfectly well. The
 * only thing it withholds is publication, so it reads as a state, not a problem.
 */
export function admissionTone(a: EffectiveAdmission): BadgeTone {
  switch (a) {
    case 'admitted':
      return 'success';
    case 'auto-admitted':
      return 'info';
    case 'rejected':
      return 'danger';
    case 'pending':
      return 'warning';
  }
}

export function admissionLabel(a: EffectiveAdmission): string {
  return a === 'auto-admitted' ? 'Auto-admitted' : a[0]!.toUpperCase() + a.slice(1);
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
    // Provisioning is meant to be transient, but it stalls — a failed migration or a
    // dispatch gap can strand a scope here indefinitely (#49), and with nothing to offer
    // the console becomes a dead-end (#500). The server permits `provisioning → archived`
    // (host.ts archiveScope allows it) precisely so a stuck scope can be abandoned, then
    // reaped once archived; bulk Prune already relies on this edge. Offer it here too so a
    // single stranded scope has the same escape.
    case 'provisioning':
      return ['archive'];
    // `archiving` is genuinely mid-flight (it settles into `archived` on its own), and a
    // cascade-suspended scope's lever is the tenant, not the scope — its row is `active`,
    // so a per-scope action would either be an illegal transition or a wrong one. Both are
    // handled by an explanatory note in the detail view rather than a button.
    case 'archiving':
    case 'suspended-via-tenant':
      return [];
  }
}
