import { z } from 'zod';
import { instant, orgId, scopeId, slug, tenantId } from './ids.js';

export const tenantStatus = z.enum(['active', 'suspended', 'deleting']);
export type TenantStatus = z.infer<typeof tenantStatus>;

export const tenant = z.object({
  id: tenantId,
  slug,
  name: z.string().min(1),
  status: tenantStatus,
  createdAt: instant,
});
export type Tenant = z.infer<typeof tenant>;

// What the caller supplies to createTenant (control-plane.md §4.1); `status`
// (active) and `createdAt` are stamped host-side, never caller-supplied.
export const createTenantInput = tenant.pick({ id: true, slug: true, name: true });
export type CreateTenantInput = z.infer<typeof createTenantInput>;

/**
 * An organization inside a tenant (K-22) — who membership tuples point at and what
 * `grantToOrg` targets. Portal customers, staff groups, partner companies.
 *
 * `slug` and `name` are **attributes, not identity**: the id is a ULID, so renaming an
 * org cannot silently orphan the tuples and grants that reference it. `tenantId` on the
 * row is also kernel-design §4.3's required `orgId ↔ tenantId` join — *"an explicit,
 * stable directory row, one per tenant, never reconstructed from names or slugs"* —
 * which is why the identity adapter's org sync hangs off this record rather than a
 * string convention.
 *
 * No lifecycle status yet, deliberately: nothing consumes one, and adding a nullable
 * column later is additive. The branded id is the part that is brutal to retrofit.
 */
export const org = z.object({
  id: orgId,
  tenantId,
  slug, // unique within the tenant
  name: z.string().min(1),
  createdAt: instant,
});
export type Org = z.infer<typeof org>;

// `status`/`createdAt` are stamped host-side, never caller-supplied (as createTenantInput).
export const createOrgInput = org.pick({ id: true, tenantId: true, slug: true, name: true });
export type CreateOrgInput = z.infer<typeof createOrgInput>;

export const scopeStatus = z.enum([
  'provisioning',
  'active',
  'suspended',
  'archiving',
  'archived',
]);
export type ScopeStatus = z.infer<typeof scopeStatus>;

// §5.2 of the design doc: A = DO-embedded SQLite is primary; B = DO control plane + D1
export const storageShape = z.enum(['A', 'B']);
export type StorageShape = z.infer<typeof storageShape>;

// Fixed at provisioning; a DO can never relocate (design K-7). `global` is the
// honest name for an unconstrained scope — no regional subnamespace, placed near
// first access — which is what EVERY scope is today, so naming it renames nothing
// at runtime. It also ends the old `null`, which meant both "unconstrained" and
// "nobody decided" at once (K-32). `eu`/`us` name residency guarantees whose
// enforcement (DO jurisdiction subnamespace, Regional Services) is not built yet,
// so the provisioning boundary gates them — see `provisionableJurisdiction`.
//
// The full vocabulary ships now, ahead of enforcement, precisely BECAUSE this is
// immutable: a scope that took a value we could not name later would be a data
// migration rather than a config change. Widening what is ACCEPTED is additive;
// widening what can be STORED is not, so the storable set is complete from the start.
export const jurisdiction = z.enum(['eu', 'us', 'global']);
export type Jurisdiction = z.infer<typeof jurisdiction>;

// Which jurisdictions the provisioning boundary currently ACCEPTS — a subset of
// what `jurisdiction` can store. `eu`/`us` are absent until their enforcement
// exists (a US isn't even a Cloudflare DO jurisdiction — it's Regional Services +
// a D1 location hint), because accepting them would record a residency guarantee
// with no mechanism behind it, which is worse than not offering it. Widen THIS
// list — never `jurisdiction` — when enforcement lands. Gated the same way
// `STANDALONE` and `ALLOW_DEV_HEADER` are: the capability is absent, not present
// and checked (K-31).
export const provisionableJurisdiction = z.enum(['global']);
export type ProvisionableJurisdiction = z.infer<typeof provisionableJurisdiction>;

/**
 * A scope's last *failed* migration attempt (kernel-design §5.3), or null when the
 * last attempt succeeded and when none has run.
 *
 * Migrations fail closed per scope: `applyPendingMigrations` rolls back and throws,
 * so the scope serves nothing. Before this record existed the directory learned
 * nothing from that — `schemaVersion` is projected only on the success path, so a
 * half-migrated scope kept a stale value and rendered as healthy.
 *
 * Deliberately **not** a `scopeStatus` member: the scope already fails closed at the
 * migration layer, so nothing about lifecycle gating changes, and the §3.3 machine
 * (`provisioning → active → suspended ⇄ active → archiving → archived`) has no
 * sensible transition for it. Structured rather than a flag because the
 * reconciliation sweep (§5.3) retries with backoff and reports
 * "487/500 migrated, 13 pending, 0 failed" — which needs the attempt count and the
 * failing version, not a boolean.
 *
 * `attempts` counts *consecutive* failures and resets to 0 on a successful apply.
 */
export const migrationFailure = z
  .object({
    version: z.string().min(1), // the `module@version` that threw
    error: z.string(),
    attempts: z.number().int().positive(), // ≥1: the record only exists after a failure
    lastAttemptAt: instant,
  })
  .nullable();
export type MigrationFailure = z.infer<typeof migrationFailure>;

export const scope = z.object({
  id: scopeId, // globally unique; APIs still take (tenantId, scopeId) and cross-check (K-3)
  tenantId,
  parentScopeId: scopeId.nullable(), // v1: always null; column ships so trees are additive (K-1)
  slug, // unique within tenant
  kind: z.string().min(1), // vertical vocabulary ('brf', 'filial'); kernel never branches on it
  name: z.string().min(1),
  status: scopeStatus,
  storageShape,
  jurisdiction,
  // Which vertical's deployment executes this scope (control-plane.md §1: the DO
  // class is the app binary). Nullable — a scope provisioned before the caller
  // names one, and the bare hosts in tests, carry null. It is what makes the
  // audit log's `vertical` target real for scope-lifecycle actions, and what
  // console item 1 means by "which vertical each scope runs".
  vertical: z.string().min(1).nullable(),
  /**
   * The registered version this scope runs (#31). Null for a scope provisioned
   * before the registry, or bound to a vertical we ship but have not versioned.
   *
   * Kept ALONGSIDE `vertical` rather than replacing it: the slug is what the audit
   * log's target and the console's filters read, and a denormalized label that
   * survives a version being superseded is worth more than one join.
   */
  verticalVersionId: z.string().min(1).nullable(),
  // The scope's migration state: the count of applied (module, version) pairs,
  // as a string. Written host-side after migrations apply — never caller-supplied.
  // '0' means "provisioned, nothing applied yet". Comparing it against the host's
  // registered migration total is what answers §5.4's "which scopes are behind".
  schemaVersion: z.string(),
  migrationFailure,
  /**
   * Fork provenance (preview-and-snapshots.md §3). A scope created by `importScope`
   * records the scope it was copied FROM and WHEN; both null for a normally-
   * provisioned scope. `forkedFrom` being set is what marks a scope a fork (a
   * preview/archive) for the Snapshots view and TTL/GC — `kind` carries the
   * retention vocabulary, this carries the lineage.
   */
  forkedFrom: scopeId.nullable(),
  forkedAt: instant.nullable(),
  /**
   * When this scope stops being retained (preview-and-snapshots.md §3): the GC sweep
   * reaps a FORK whose expiry has passed. Null = no expiry (every normal scope, and a
   * deliberately-pinned archive). Only ever set on forks — retention is a snapshot
   * concept, and the reaper refuses non-forks regardless.
   */
  expiresAt: instant.nullable(),
  createdAt: instant,
});
export type Scope = z.infer<typeof scope>;
