import { z } from 'zod';
import {
  eventId,
  instant,
  orgId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from './ids.js';

// The control plane — the shared layer across N per-vertical deployments (D-30,
// control-plane.md). This file carries the audit contract that every effecting
// mutation writes; the tenant registry, lifecycle, and entitlement store land in
// later slices (control-plane.md §4.1–4.3).

// One row per control-plane mutation. Extended additively as §4.2/§4.3 add
// lifecycle and entitlement actions (new enum members are additive — D-28).
export const adminAction = z.enum([
  'defineRole',
  'assignRole',
  'unassignRole', // the inverse of assignRole — tombstones the role tuple (K-21)
  'grant',
  'grantToOrg',
  'addMember',
  'removeMember', // K-21 — tombstones the membership tuple, never deletes it
  'createOrg', // K-22 — orgs are a real record, not a free-form string
  'registerIdentityPool',
  'registerVertical', // #31 — the vertical + version registry
  'publishVersion',
  'admitVersion',
  'rejectVersion',
  'setVerticalListed', // marketplace-publish.md §5 — publish/unpublish to the public marketplace
  'requestPublish', // marketplace-publish.md §5 — a builder requests listing (awaiting staff review)
  'setVerticalInstallsBlocked', // the staff kill-switch — block/unblock NEW installs of a vertical
  'deleteVertical', // remove a vertical + its versions/channels; refused while any scope is bound
  'bindScopeVersion',
  'promoteVersion',
  // #286 — in-place deploys: the stable serving script's state moves, and a scope's
  // routing is pointed at the script its data now lives in (provision / adopt-serving).
  'setVerticalServing',
  'setScopeServingRef',
  'bindHostname', // K-26 — the hostname map
  'setHostnameStatus', // #31 step 2 — where the two human checkpoints fire
  'unbindHostname', // the inverse of bindHostname — a hard delete; the history is this log
  'pruneAccessLog', // K-24 — deleting drained access rows is itself a mutation // K-23 — a provider declares its topology before it may link
  'createTenant', // §4.1
  'setTenantStatus', // §4.1 — before/after carry the transitioned status
  'setTenantName', // §4.1 — display rename only; the slug (in registry ids) never moves
  'provisionScope', // §4.2 — the first scope-lifecycle transition (→ active)
  'importScope', // preview-and-snapshots.md §3 — provision a scope + load a dump (fork)
  'restoreScope', // §8's write half — load a dump into an EXISTING scope in place (backup restore / backout)
  'rewindScope', // #286's backout — PITR-rewind a scope to a pre-migration bookmark (schema AND data)
  'deleteSnapshot', // preview-and-snapshots.md §9 — reap an expired fork: storage + directory row
  'suspendScope', // §4.2
  'unsuspendScope', // §4.2
  'archiveScope', // §4.2
  'unarchiveScope',
  'activateScope', // §4.2 — an explicit restore, never a silent flag flip
  'grantEntitlement', // §4.3 — the SKU flag turned on for a tenant
  'revokeEntitlement', // §4.3
  'linkIdentity', // D-16 — bind an external identity to a principal
  'unlinkIdentity', // the inverse — sever a principal's login from a tenant
  // #101 — the integrations hub. The credential itself is NEVER in before/after:
  // this log is append-only, so a secret written here could never be removed.
  'createConnection',
  'updateConnectionSecret', // OAuth refresh — logged as an event, never with the token
  'revokeConnection',
  // #97 — a connection may hold a permission, so granting one is a mutation the
  // log has to be able to name.
  'grantToConnection',
]);
export type AdminAction = z.infer<typeof adminAction>;

/**
 * One entitlement grant, widened from a bare SKU flag to express a plan (#33):
 * quota, expiry, tier. The paying customer is the vertical builder (D-33), so
 * these fields describe the builder's subscription — the tenants underneath are
 * what the plan is measured in.
 *
 * `expiresAt` is the subscription boundary and the one field the kernel itself
 * enforces: an expired grant fails closed at the per-invoke gate, exactly as if
 * revoked — checked lazily at read like permission tuples, never swept. The row
 * stays visible in `listEntitlements` so a lapsed trial can be renewed.
 *
 * `quota` and `plan` are expression only: the store records "500 work orders/mo
 * on 'pro'" but counting usage against it is the consumer's job (the builder
 * portal, control-plane.md §5's meters). A null quota is today's boolean flag;
 * a null plan is an ungrouped key.
 */
export const entitlementGrant = z.object({
  // min(1), not the manifest's key regex: this shape READS the store back, and a
  // console-granted legacy key must round-trip rather than brick the list.
  entitlementKey: z.string().min(1),
  /** Null = perpetual. ISO instant, compared lexically against now at the gate. */
  expiresAt: instant.nullable(),
  /** Plan quantity for this key. Null = plain on/off SKU flag. Never enforced here. */
  quota: z.number().int().positive().nullable(),
  /** Tier grouping ('pro') — makes a plan data instead of operator convention. */
  plan: z.string().min(1).nullable(),
  /** Stamped platform-side at grant. Null only on rows born before #33. */
  grantedAt: instant.nullable(),
  grantedBy: platformActorId.nullable(),
});
export type EntitlementGrant = z.infer<typeof entitlementGrant>;

/**
 * What an operation handler reads through `ctx.entitlement(key)` / `ctx.entitlements()`
 * (#304) — the request-time, in-scope view of a grant. A deliberately narrower shape than
 * `entitlementGrant`: it drops the audit fields (`grantedAt`/`grantedBy`) a running vertical
 * has no business acting on, and it only ever names a **currently-held** entitlement —
 * expiry is applied at read (an expired grant is absent from the view, exactly as it is
 * absent from the gate), so a returned view is by construction live.
 *
 * `plan` and `quota` are carried but **not** enforced by the kernel (#33): the vertical
 * reads the number and enforces its own quota; the kernel enforces only presence + expiry.
 * On a hosted vertical this is read from the scope-local projection (scope-local-permissions.md),
 * never a control-plane binding.
 */
export const entitlementView = z.object({
  /** The entitlement/SKU key. */
  key: z.string().min(1),
  /** Tier grouping ('pro'), or null for an ungrouped key. Expression only — not enforced. */
  plan: z.string().min(1).nullable(),
  /** Plan quantity, or null for a plain on/off flag. Expression only — the vertical counts usage. */
  quota: z.number().int().positive().nullable(),
  /** Null = perpetual. A non-null value is always in the future (an expired grant is not viewable). */
  expiresAt: instant.nullable(),
});
export type EntitlementView = z.infer<typeof entitlementView>;

/**
 * The plan half of a grant call. PATCH semantics, deliberately: an omitted field
 * PRESERVES what the row already carries, an explicit null clears it. Re-granting
 * on an idempotent path (re-provisioning grants keys freely) must not silently
 * turn a trial perpetual by erasing its expiry.
 */
export const entitlementGrantInput = z.object({
  expiresAt: instant.nullable().optional(),
  quota: z.number().int().positive().nullable().optional(),
  plan: z.string().min(1).nullable().optional(),
});
// `z.input`, not `z.infer`: callers hand in plain ISO strings; the adapters
// parse (and brand) at the boundary.
export type EntitlementGrantInput = z.input<typeof entitlementGrantInput>;

/**
 * The neutral identity seam (D-16; control-plane.md §6 "principal derivation").
 * An auth adapter at the edge (Better Auth, an OIDC issuer, …) authenticates a
 * user and maps its external identity to a Substrat principal + home node. The
 * kernel never learns HOW a caller authenticated, only WHO they are — the
 * mechanism stays a swappable adapter. Authentication only: authorization is
 * roles/grants, and `provider` keeps N adapters (and OIDC upstreams) distinct.
 */
export const identityLink = z.object({
  provider: z.string().min(1), // 'better-auth' | 'oidc:<issuer>' | …
  externalId: z.string().min(1), // the provider's stable user id (e.g. the OIDC `sub`)
  principal: principalId,
  tenantId,
  scopeId: scopeId.optional(), // omitted = tenant-level home
});
export type IdentityLink = z.infer<typeof identityLink>;

/**
 * How an identity pool relates to tenants (K-23) — the fact that decides whether the
 * same `externalId` seen in two tenants is one human or two.
 *
 * `central`: one pool serving many tenants. The same external subject IS the same
 * person everywhere, which is what lets one login belong to several tenants (§4.3's
 * staff case, and a branded multi-tenant consumer product like RallyPoint).
 *
 * `tenant-bound`: one pool serving exactly one tenant. Subject ids are unique only
 * within it, so the same `externalId` in another tenant is a DIFFERENT person — the
 * white-label case, where a consumer of two shops is correctly two accounts.
 *
 * Topology, not audience. The audiences in §4.3 are descriptive; this is enforceable.
 */
export const poolTopology = z.enum(['central', 'tenant-bound']);
export type PoolTopology = z.infer<typeof poolTopology>;

/**
 * A registered identity provider. `provider` names exactly one pool, so separate
 * per-tenant deployments take distinct provider strings (`oidc:<issuer>`) — which the
 * `identityLink` comment above already assumed.
 *
 * `tenantId` is non-null exactly when `topology` is `tenant-bound`: it is the one
 * tenant that pool may serve, and linking into any other is refused.
 */
export const identityPool = z
  .object({
    provider: z.string().min(1),
    topology: poolTopology,
    tenantId: tenantId.nullable(),
  })
  .refine((p) => (p.topology === 'tenant-bound') === (p.tenantId !== null), {
    message: 'tenant-bound pools name their tenant; central pools must not',
  });
export type IdentityPool = z.infer<typeof identityPool>;

/**
 * What the directory knows about an authenticated external identity, once the caller
 * has said WHICH tenant's pool it came from.
 *
 * No `tenantId` here on purpose. The lookup takes the tenant as input (§4.3: with one
 * auth pool per white-label tenant, an external subject id is unique only *within* its
 * pool), so echoing it back would invite the very mental model this fixes — that the
 * directory derives the tenant from the identity. You tell it which tenant; it tells
 * you who.
 */
export const resolvedIdentity = z.object({
  principal: principalId,
  scopeId: scopeId.nullable(),
});
export type ResolvedIdentity = z.infer<typeof resolvedIdentity>;

/**
 * One staff READ of the directory (K-24). Separate from `adminLogEntry` because a
 * mutation is permanent evidence and a read is operational history — one table would
 * force one retention policy on both.
 *
 * `resultCount` is what separates navigation from an incident: "called listScopes"
 * against "enumerated 4,000 tenants".
 *
 * `drainedAt` marks a row shipped to Tier 2. Only drained rows may be pruned —
 * expiring on age alone would destroy evidence while calling itself retention.
 */
export const accessLogEntry = z.object({
  id: z.string().min(1),
  actor: platformActorId,
  method: z.string().min(1),
  tenantId: tenantId.nullable(),
  scopeId: scopeId.nullable(),
  params: z.string().nullable(),
  resultCount: z.number().int().nonnegative(),
  drainedAt: instant.nullable(),
  at: instant,
});
export type AccessLogEntry = z.infer<typeof accessLogEntry>;

/**
 * One principal's membership of one org, as the directory holds it (K-21).
 *
 * `revokedAt` non-null is a **tombstone**: the tuple is still here and still
 * readable, and the permission walk skips it. Deletion is not an option — an
 * operated compliance product has to show both that access was revoked and the
 * trail proving it was once granted (D-32), and a deleted row shows neither.
 *
 * Listing defaults to live members only; revoked rows are the evidence view.
 */
export const orgMembership = z.object({
  principal: principalId,
  orgId,
  revokedAt: instant.nullable(),
});
export type OrgMembership = z.infer<typeof orgMembership>;

/**
 * An append-only admin audit row (control-plane.md §4.4). Every field except
 * `before`/`after` is stamped platform-side — never supplied by the caller —
 * for the same reason the kernel is trusted at all (K-4): a surface that can act
 * without a durable record of who acted is worse than no surface.
 *
 * `target` is `(tenantId, scopeId?, vertical?)`. `scopeId`/`vertical` are null
 * for tenant-wide actions; `vertical` stays null until §4.2 lifecycle actions
 * (provision/suspend) that name one.
 */
export const adminLogEntry = z.object({
  id: z.string().min(1), // ULID, stamped host-side; sortable = chronological
  actor: platformActorId,
  action: adminAction,
  // Nullable for PLATFORM-level actions that target no tenant — registering a central
  // identity pool is the first (K-23). Every tenant-scoped action still carries one;
  // null means "the platform itself", not "unknown".
  tenantId: tenantId.nullable(),
  scopeId: scopeId.nullable(),
  vertical: z.string().nullable(),
  before: z.unknown().nullable(), // prior state where cheaply readable (e.g. a redefined role)
  after: z.unknown().nullable(), // the applied payload
  /**
   * The domain event that caused this action, when one did (K-22 §4.2).
   *
   * The connector seam splits a change across two halves: a module emits inside its
   * own transaction, and a privileged executor outside module code effects it. That
   * splits the trail too — control-plane.md §3 named it as the main thing the pattern
   * worsens. This is the join, and it is the EVENT ID rather than a new correlation
   * field: the envelope already carries a kernel-stamped unique id that is the
   * idempotency key downstream, so reusing it avoids widening a frozen contract
   * (D-5/D-28) to say something it already says.
   *
   * Null for the ordinary case — a staff member acting directly caused nothing but
   * themselves.
   */
  causedBy: eventId.nullable(),
  at: instant,
});
export type AdminLogEntry = z.infer<typeof adminLogEntry>;
