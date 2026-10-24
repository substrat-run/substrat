import type {
  EntitlementMeterRow,
  Instant,
  MeterReading,
  MeterScopeCounts,
  ScopeStatus,
  TenantId,
  TenantMeterRow,
  TenantStatus,
} from '@substrat-run/contracts';
import { foldStorageGauge, holdsStore } from './storage-gauge.js';

/**
 * §5's meters, folded once (#38).
 *
 * Every adapter has the same three directory tables and could each write the same
 * `GROUP BY`. They must not: the billable rule is a *commercial* definition, and two
 * copies of it in two dialects is how the Cloudflare fleet and the SQLite fleet end up
 * quoting different numbers for the same month. So the adapters fetch rows — a job SQL
 * is genuinely better at — and the arithmetic that decides what counts lives here, in
 * one pure function, testable without a database.
 *
 * The counterpart to `migration-progress.ts`: the same shape of directory-derived
 * answer, computed above the storage seam rather than inside each adapter.
 */

/** One tenant row the fold needs — the directory's `tenants`, narrowed. */
export interface MeterTenantInput {
  tenantId: TenantId;
  slug: string;
  status: TenantStatus;
}

/** One scope row the fold needs. Its tenant and status, and for storage what it was archived from. */
export interface MeterScopeInput {
  tenantId: TenantId;
  status: ScopeStatus;
  /** #1524: `provisioning` = archived before it held data, so it has no storage to count. */
  archivedFromStatus?: ScopeStatus | null;
}

/** One entitlement grant the fold needs; `quota` is expression only, so it is absent. */
export interface MeterEntitlementInput {
  tenantId: TenantId;
  entitlementKey: string;
  plan: string | null;
  expiresAt: string | null;
}

export interface MeterInput {
  /**
   * The instant the directory was read — supplied by the caller, never taken from a
   * clock in here, so the reading's stamp and every expiry comparison are the SAME
   * instant and a test can pin both.
   */
  readAt: Instant;
  tenants: MeterTenantInput[];
  scopes: MeterScopeInput[];
  entitlements: MeterEntitlementInput[];
  /**
   * The stored storage gauge (#1524): the latest sample of each non-reaped scope. Absent when
   * the host keeps no gauge, and then the reading carries no `storage` at all, rather than a
   * zero that would read as "this tenant stores nothing".
   */
  storage?: MeterStorageInput[];
  /** Each non-reaped scope's latest storage-read attempt, so a failing scope is named, not missing. */
  storageAttempts?: { tenantId: TenantId; attemptedAt: string; error: string | null }[];
  /** Latest scope-store samples (#2212). Absent when the host has not started recording them. */
  storeStorage?: { tenantId: TenantId; bytes: number }[];
  /** Latest attachment samples (#2501). Absent when the host has not started recording them. */
  attachmentStorage?: { tenantId: TenantId; bytes: number }[];
}

/** One scope's latest storage sample, as the fold needs it. */
export interface MeterStorageInput {
  tenantId: TenantId;
  bytes: number;
  readAt: string;
}

export const emptyScopeCounts = (): MeterScopeCounts => ({
  total: 0,
  active: 0,
  suspended: 0,
  provisioning: 0,
  archived: 0,
  reaped: 0,
});

/**
 * Where the scope actually is, from a meter's point of view — the same disagreement
 * with stored status the console's `effectiveStatus` makes, for the same reason.
 * Suspending a TENANT leaves its scopes' rows `active` while `getScope` fails closed
 * for every one of them (control-plane.md §4.1), so billing the stored row would
 * invoice a tenant-wide outage.
 *
 * A scope whose tenant row is missing fails closed too (counted suspended, never
 * billable): an unreachable scope is not revenue, and an orphan row is a directory bug
 * that a meter should not quietly turn into money.
 */
function bucket(scope: MeterScopeInput, tenantStatus: TenantStatus | undefined): keyof MeterScopeCounts {
  switch (scope.status) {
    case 'active':
      return tenantStatus === 'active' ? 'active' : 'suspended';
    case 'suspended':
      return 'suspended';
    case 'provisioning':
      return 'provisioning';
    case 'archiving':
    case 'archived':
      return 'archived';
    case 'reaped':
      return 'reaped';
  }
}

/** Count one scope into `counts`, in the bucket its own status and its tenant's put it. */
export function countScope(counts: MeterScopeCounts, scope: MeterScopeInput, tenantStatus: TenantStatus | undefined): void {
  counts.total++;
  counts[bucket(scope, tenantStatus)]++;
}

/** Live at `readAt`, or lapsed. Lexical compare — both sides are ISO instants (#33's gate rule). */
export function isLive(grant: MeterEntitlementInput, readAt: Instant): boolean {
  return grant.expiresAt === null || grant.expiresAt > readAt;
}

/** Meter 2's order: by key, then plan with the null plan first — the ungrouped flag is the base row a tier hangs off. */
export function skuOrder(a: { entitlementKey: string; plan: string | null }, b: { entitlementKey: string; plan: string | null }): number {
  return (a.entitlementKey < b.entitlementKey ? -1 : a.entitlementKey > b.entitlementKey ? 1 : 0) || (a.plan ?? '').localeCompare(b.plan ?? '');
}

/**
 * Fold directory rows into one reading. Pure: same rows in, same numbers out, no clock
 * of its own — `readAt` is supplied so the reading's instant and the expiry comparisons
 * are the same instant, and so a test can pin it.
 *
 * Rows belonging to a tenant that is not in `tenants` are IGNORED rather than counted
 * against nothing. That is what makes a `{ tenantId }`-narrowed reading come out of the
 * same code path as the fleet one: the caller narrows the tenant set, and everything
 * else follows from it.
 */
export function foldMeterReading(input: MeterInput): MeterReading {
  const tenants = [...input.tenants].sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
  const status = new Map<TenantId, TenantStatus>(tenants.map((t) => [t.tenantId, t.status]));

  const scopesByTenant = new Map<TenantId, MeterScopeCounts>(tenants.map((t) => [t.tenantId, emptyScopeCounts()]));
  for (const scope of input.scopes) {
    const counts = scopesByTenant.get(scope.tenantId);
    if (!counts) continue; // not in this reading's tenant set
    countScope(counts, scope, status.get(scope.tenantId));
  }

  const grantsByTenant = new Map<TenantId, { live: number; expired: number }>(
    tenants.map((t) => [t.tenantId, { live: 0, expired: 0 }]),
  );
  // Meter 2 is keyed by (SKU, tier), and only billable holders contribute — see
  // `entitlementMeterRow`. `expired` is scoped the same way on purpose: a lapsed grant
  // under an active tenant is a renewal to chase; one under a suspended tenant is not.
  const bySku = new Map<string, EntitlementMeterRow>();
  const skuKey = (key: string, plan: string | null) => `${key}\u0000${plan ?? ''}`;
  for (const grant of input.entitlements) {
    const held = grantsByTenant.get(grant.tenantId);
    if (!held) continue; // not in this reading's tenant set
    const live = isLive(grant, input.readAt);
    if (live) held.live++;
    else held.expired++;
    if (status.get(grant.tenantId) !== 'active') continue; // held, but not billable
    const id = skuKey(grant.entitlementKey, grant.plan);
    const row = bySku.get(id) ?? { entitlementKey: grant.entitlementKey, plan: grant.plan, tenants: 0, expired: 0 };
    if (live) row.tenants++;
    else row.expired++;
    bySku.set(id, row);
  }

  const samplesByTenant = new Map<TenantId, MeterStorageInput[]>(tenants.map((t) => [t.tenantId, []]));
  for (const sample of input.storage ?? []) samplesByTenant.get(sample.tenantId)?.push(sample);
  const storesByTenant = new Map<TenantId, { bytes: number }[]>(tenants.map((t) => [t.tenantId, []]));
  for (const sample of input.storeStorage ?? []) storesByTenant.get(sample.tenantId)?.push(sample);
  const attachmentsByTenant = new Map<TenantId, { bytes: number }[]>(tenants.map((t) => [t.tenantId, []]));
  for (const sample of input.attachmentStorage ?? []) attachmentsByTenant.get(sample.tenantId)?.push(sample);
  const attemptsByTenant = new Map<TenantId, NonNullable<MeterInput['storageAttempts']>>(tenants.map((t) => [t.tenantId, []]));
  for (const a of input.storageAttempts ?? []) attemptsByTenant.get(a.tenantId)?.push(a);
  // Only a scope that holds a store has a size (`holdsStore`): not a reaped one (gone), a
  // provisioning one, or one archived before it held data. Suspended and archived scopes are.
  const storedByTenant = new Map<TenantId, number>(tenants.map((t) => [t.tenantId, 0]));
  for (const scope of input.scopes) {
    if (holdsStore(scope) && storedByTenant.has(scope.tenantId)) {
      storedByTenant.set(scope.tenantId, storedByTenant.get(scope.tenantId)! + 1);
    }
  }

  const perTenant: TenantMeterRow[] = tenants.map((t) => ({
    tenantId: t.tenantId,
    slug: t.slug,
    status: t.status,
    billable: t.status === 'active',
    scopes: scopesByTenant.get(t.tenantId)!,
    entitlements: grantsByTenant.get(t.tenantId)!,
    ...(input.storage
      ? {
          storage: foldStorageGauge(
            samplesByTenant.get(t.tenantId)!,
            storedByTenant.get(t.tenantId)!,
            attemptsByTenant.get(t.tenantId)!,
            input.storeStorage ? storesByTenant.get(t.tenantId)! : undefined,
            input.attachmentStorage ? attachmentsByTenant.get(t.tenantId)! : undefined,
          ),
        }
      : {}),
  }));

  const scopes = emptyScopeCounts();
  for (const row of perTenant) {
    for (const k of Object.keys(scopes) as (keyof MeterScopeCounts)[]) scopes[k] += row.scopes[k];
  }

  return {
    readAt: input.readAt,
    tenants: {
      total: tenants.length,
      active: tenants.filter((t) => t.status === 'active').length,
      suspended: tenants.filter((t) => t.status === 'suspended').length,
      deleting: tenants.filter((t) => t.status === 'deleting').length,
      reaped: tenants.filter((t) => t.status === 'reaped').length,
    },
    scopes,
    entitlements: [...bySku.values()].sort(skuOrder),
    perTenant,
    ...(input.storage
      ? {
          storage: foldStorageGauge(
            [...samplesByTenant.values()].flat(),
            [...storedByTenant.values()].reduce((a, b) => a + b, 0),
            [...attemptsByTenant.values()].flat(),
            input.storeStorage ? [...storesByTenant.values()].flat() : undefined,
            input.attachmentStorage ? [...attachmentsByTenant.values()].flat() : undefined,
          ),
        }
      : {}),
  };
}
