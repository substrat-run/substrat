import { z } from 'zod';
import {
  eventId,
  instant,
  orgId,
  platformActorId,
  principalId,
  scopeId,
  slug,
  tenantId,
} from './ids.js';
// #36's tenant export speaks the platform's own vocabulary rather than restating it, so
// it composes the schemas that already define these shapes. One-way imports only —
// none of these modules imports this one, so no cycle.
import { org, scope, tenant, tenantStatus } from './tenancy.js';
import { tenantRole } from './permission.js';
import { hostnameBinding } from './routing.js';
import { connection } from './connections.js';
import { scopeDump } from './introspection.js';

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
  'setVerticalTenantProvisioner', // #412 — grant/revoke the tenant-provisioner capability (manager verticals)
  'setVerticalEmailSender', // #303 — grant/revoke the email-sender capability (relay-sends transactional mail)
  'deleteVertical', // remove a vertical + its versions/channels; refused while any scope is bound
  'bindScopeVersion',
  'promoteVersion',
  // #286 — in-place deploys: the stable serving script's state moves, and a scope's
  // routing is pointed at the script its data now lives in (provision / adopt-serving).
  'setVerticalServing',
  'setScopeServingRef',
  'setScopeExpiresAt', // preview-and-snapshots.md §9 — push a fork's GC deadline forward on reuse, or pin it (null)
  'bindHostname', // K-26 — the hostname map
  'setHostnameStatus', // #31 step 2 — where the two human checkpoints fire
  'setHostnameIssuance', // #305 §4.7 — a Cloudflare-for-SaaS issuance step (create/poll) result
  'unbindHostname', // the inverse of bindHostname — a hard delete; the history is this log
  // K-24 — shipping access rows to Tier 2 is a data EGRESS, so it is evidence in its own
  // right: the admin log is where "these rows left the platform, at this time, to this
  // object" is recorded. It is also what licenses the prune below — nothing may be deleted
  // that this action did not first place somewhere durable.
  'drainAccessLog',
  'pruneAccessLog', // K-24 — deleting drained access rows is itself a mutation // K-23 — a provider declares its topology before it may link
  'createTenant', // §4.1
  // §4.1/§4.8 — before/after carry the transitioned status. Starting the delete grace
  // window (→ deleting) and un-deleting (→ active) are ordinary status transitions here,
  // exactly as suspend/unsuspend are — the reap that follows is its own action below.
  'setTenantStatus',
  'setTenantName', // §4.1 — display rename only; the slug (in registry ids) never moves
  // §4.8 — the terminal tenant reap: wipe every scope's storage (via reapScope) and clear
  // the tenant's PII/config directory rows, keeping the `tenants` row + admin log as a
  // tombstone. Irreversible, so it only leaves `deleting`, never `active`. The tenant-level
  // analogue of reapScope.
  'reapTenant',
  'provisionScope', // §4.2 — the first scope-lifecycle transition (→ active)
  'provisionTenantStore', // #301 — mint a per-tenant relational store for a hosted vertical
  'provisionBlobStore', // #473 — mint a per-tenant blob store for attachment bytes
  'importScope', // preview-and-snapshots.md §3 — provision a scope + load a dump (fork)
  'restoreScope', // §8's write half — load a dump into an EXISTING scope in place (backup restore / backout)
  'rewindScope', // #286's backout — PITR-rewind a scope to a pre-migration bookmark (schema AND data)
  'deleteSnapshot', // preview-and-snapshots.md §9 — reap an expired fork: storage + directory row
  'suspendScope', // §4.2
  'unsuspendScope', // §4.2
  'archiveScope', // §4.2
  'unarchiveScope',
  // §4.4 — the terminal reap: wipe an archived scope's DO storage (Cloudflare never GCs a
  // DO) while keeping its directory row as a tombstone. Irreversible, so it only leaves
  // `archived`, never `active`. Unlike `deleteSnapshot` this reaps a PRIMARY scope, not a fork.
  'reapScope',
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
  // #383 — a module's system principal may hold a permission (for scheduled work),
  // so granting one is a named, audited mutation like every other grant.
  'grantToSystem',
  // #40 — the directory's own disaster-recovery write: replace THE DIRECTORY (tenants,
  // scopes, hostnames, verticals, identities) with a stored dump. Carries no tenant,
  // because its blast radius is every tenant. The entry lands in the log it just
  // replaced, which is exactly right: the restored log is the pre-restore history, and
  // this row is the first thing after it — the seam is legible instead of silent.
  'restoreDirectory',
  // #37 — erase one data subject. Both a mutation AND a destruction of evidence, which is
  // exactly why it is named here: the spine payloads keyed to that subject are redacted and
  // the subject's encryption key is destroyed, so every platform-retained copy sealed under
  // it becomes unreadable. The `after` carries the receipt (how many events, whether a key
  // existed) — an erasure that records no proof it happened is not a fulfilled DSAR.
  'shredSubject',
]);
export type AdminAction = z.infer<typeof adminAction>;

/**
 * What a `shredSubject` did (#37) — the receipt a DSAR response is written from.
 *
 * Deliberately counts rather than ids: naming the events erased about a person would
 * rebuild, in the append-only admin log, a pointer to exactly what was supposed to
 * disappear. The counts are what proves the erasure ran; the `subjectId` (a ULID, already
 * pseudonymous) is what ties it to the request.
 */
export const subjectShredReceipt = z.object({
  subjectId: z.string().min(1),
  /** Spine rows whose payload this call redacted. Zero on a re-run — the first one did it. */
  eventsRedacted: z.number().int().nonnegative(),
  /**
   * Whether a subject key existed to destroy. False means nothing platform-retained was ever
   * sealed for this subject — either it was never exported, or a prior shred already ran.
   */
  keyDestroyed: z.boolean(),
  /** True once the subject is tombstoned: no future seal may mint a key under this id. */
  tombstoned: z.boolean(),
});
export type SubjectShredReceipt = z.infer<typeof subjectShredReceipt>;

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
 * One tenant's identity link as it travels INTO a deployment (#406) — the shape the
 * platform delivers with provisioning/reconcile and the vertical projects into its
 * scope, alongside entitlements (#310). No `tenantId`: the payload is already scoped
 * to one tenant, and carrying it per-row would invite a mismatch with the address the
 * platform provisioned. The control plane stays the audited source of truth; a
 * projected link is a read-time copy, replaced wholesale on the next projection.
 */
export const projectedIdentityLink = identityLink.omit({ tenantId: true });
export type ProjectedIdentityLink = z.infer<typeof projectedIdentityLink>;

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
 * One recorded operational failure (#559) — the durable answer to "what broke, when,
 * and whose fault was it" that the 2026-08-08 preview-restore incident had nowhere
 * to live. Deliberately NOT the admin log: the audit spine answers "who changed
 * what", and a failure changed nothing — so this is a separate, RETENTION-BOUNDED
 * record (the admin log is the never-swept compliance witness; this is operational
 * telemetry, pruned after `OPS_FAILURE_RETENTION_DAYS` in the adapters).
 *
 * `reference` is the upstream provider's own trace handle when the message carried
 * one (Cloudflare's `internal error; reference = <id>`) — extracted into its own
 * column because it is the one identifier a support ticket needs and the one a
 * CI log hands the operator to search by.
 */
export const opsFailureEntry = z.object({
  id: z.string().min(1), // ULID, stamped platform-side; sortable = chronological
  /** Who initiated the failed operation — recorded, never the authz gate. */
  actor: platformActorId,
  /** Semantic where routes know it (`deploy.upload`), `METHOD /route/:path` otherwise. */
  operation: z.string().min(1),
  /** The step inside the operation that failed, when the route can name one. */
  stage: z.string().nullable(),
  tenantId: tenantId.nullable(),
  scopeId: scopeId.nullable(),
  vertical: z.string().nullable(),
  /** The HTTP status the failure was answered with (or carried from upstream). */
  status: z.number().int().nullable(),
  message: z.string(),
  /** The upstream provider's trace reference, when the message carried one. */
  reference: z.string().nullable(),
  at: instant,
});
export type OpsFailureEntry = z.infer<typeof opsFailureEntry>;

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

/**
 * The body a hosted vertical POSTs to the control plane's `/internal/email/send` relay (#303).
 * A vertical that holds the `emailSender` grant cannot bind `send_email` itself (WfP dispatch
 * scripts have no such binding and the §4 sandbox refuses it), so it hands the message here and
 * the platform sends it. `(tenantId, scopeId)` name the caller so the relay can resolve the
 * scope's vertical and check the grant against THAT vertical — holding the shared PLATFORM_SECRET
 * is not enough. The FROM address is the platform's onboarded sender, NEVER the vertical's choice;
 * `fromName` is only the display name. Both `html` and `text` are required — the transport port
 * enforces a text part so no provider can drop it.
 */
export const emailRelayRequest = z.object({
  tenantId,
  scopeId,
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  /** Optional display name for the FROM (e.g. "Substrat Auth"); the address stays platform-owned. */
  fromName: z.string().min(1).optional(),
});
export type EmailRelayRequest = z.infer<typeof emailRelayRequest>;

/**
 * A whole tenant, exported (#36) — GDPR Art. 20 portability, and the escrow handover.
 *
 * Deliberately a DIFFERENT shape from `directoryDump` (#40), because they answer
 * different questions and one format cannot serve both honestly:
 *
 * - A **directory dump** is for RECOVERY. It is raw tables for one deployment's whole
 *   directory, complete and byte-faithful so it can be replayed back into a control
 *   plane. It is unreadable to a customer and useless as an answer to "give me my data".
 * - A **tenant export** is for PORTABILITY. It is one tenant's slice, in the platform's
 *   own documented vocabulary (`tenant`, `scope`, `org`, `role`, …) rather than in
 *   SQLite's, so the receiving party can read it without knowing the schema — plus each
 *   scope's data as a `scopeDump`, which is the one part that IS raw, because that is
 *   what makes it reloadable.
 *
 * It is assembled from the SANCTIONED reads (`listScopes`, `listOrgs`, `listRoles`,
 * `listEntitlements`, `listIdentityLinks`, `exportScope`, …), never from a back door
 * into the directory database — control-plane.md §7 forbids the control plane acquiring
 * one, and an export that quietly opened it would be exactly that.
 *
 * `masked` says which fidelity this file is. Masked is the default (the same posture as
 * `scope pull`), so a full-fidelity export is a deliberate, audited act — and an Art. 20
 * fulfilment is deliberate by definition.
 */
export const tenantExport = z.object({
  tenantId,
  /** ISO 8601 — when the export was assembled. */
  capturedAt: z.string().min(1),
  /** False only for a `?full=true` break-glass export; true means PII was redacted. */
  masked: z.boolean(),
  /** The tenant record itself. */
  tenant,
  /** Every scope, including archived and reaped ones — the tombstones are part of the history. */
  scopes: z.array(scope),
  orgs: z.array(org),
  /** Org membership across every org, revoked rows included (K-21 tombstones are the record). */
  members: z.array(orgMembership),
  roles: z.array(tenantRole),
  entitlements: z.array(entitlementGrant),
  /** External login links (D-16) — which identity provider subject maps to which principal. */
  identityLinks: z.array(identityLink),
  hostnames: z.array(hostnameBinding),
  /**
   * Inventory, NOT contents: the per-tenant relational and blob stores this tenant has.
   * Their bytes are not in this file, and saying so explicitly is the point — an export
   * that silently omitted them would misrepresent itself as complete.
   */
  stores: z.array(
    z.object({
      kind: z.enum(['relational', 'blob']),
      vertical: z.string(),
      binding: z.string(),
      ref: z.string(),
      createdAt: z.string(),
    }),
  ),
  /** Third-party connections as metadata only — a sealed credential is never exported. */
  connections: z.array(connection),
  /**
   * The tenant's admin-log entries — present only in a FULL export.
   *
   * Excluded from the masked default on purpose: this is the platform's record of what
   * STAFF did, not data the customer provided, so it is not Art. 20 material, and it
   * carries staff actor ids and internal action vocabulary. It is exactly what an escrow
   * or a dispute needs, so break-glass keeps it reachable — and audited.
   */
  adminLog: z.array(adminLogEntry).nullable(),
  /** Each scope's database, as the same `scopeDump` a fork or a pull produces. */
  data: z.array(scopeDump),
});
export type TenantExport = z.infer<typeof tenantExport>;

/**
 * The meters (#38; control-plane.md §5) — and the shape is as narrow as it is on
 * purpose, because only two of §9's four are computable at all.
 *
 * **Meter 1** (base fee: per tenant + per active scope) is a `COUNT` over the directory.
 * **Meter 2** (per-engine licensing) is a `GROUP BY` over the entitlement store, whose
 * flags *are* the SKUs. Both are free, both come from the directory database, and
 * neither needs a data pipeline. **Meters 3 and 4 are absent by construction**, not by
 * omission: the outbox is per-scope-database with no cross-tenant fan-in, reads emit
 * nothing, and the cross-tenant order flow does not exist. A field here would be a
 * number we cannot compute — "a meter you cannot compute is not a pricing decision, it
 * is a data-pipeline project" (§5).
 *
 * Two rules decide every number below, and they are the reason this is a server-side
 * aggregate rather than arithmetic over `listScopes`:
 *
 * 1. **Billable means EFFECTIVE, not stored.** Suspending a tenant does not touch its
 *    scopes' rows, but `getScope` fails closed for all of them (§4.1) — so a scope
 *    stored `active` under a non-active tenant is serving nobody and is counted
 *    suspended here, exactly as the console's `effectiveStatus` counts it. A meter that
 *    read stored status would bill a tenant-wide outage.
 * 2. **Expiry is evaluated at `readAt`.** An expired grant is gate-dead (#33), so it is
 *    not billable — but it stays visible as `expired` rather than vanishing, because a
 *    lapsed trial is a renewal, not an absence.
 */
export const meterScopeCounts = z.object({
  /** Every scope row, tombstones included — the denominator, not a billable number. */
  total: z.number().int().nonnegative(),
  /** Effective-active: the row is `active` AND its tenant is. The billable count. */
  active: z.number().int().nonnegative(),
  /** Own suspension plus tenant cascade — the two are one outage from where a meter sits. */
  suspended: z.number().int().nonnegative(),
  provisioning: z.number().int().nonnegative(),
  /** `archiving` + `archived`: reversible, not serving, not billable. */
  archived: z.number().int().nonnegative(),
  /** Terminal tombstones — storage is gone. Kept visible so `total` reconciles. */
  reaped: z.number().int().nonnegative(),
});
export type MeterScopeCounts = z.infer<typeof meterScopeCounts>;

/** Meter 1, per tenant: the scopes under it, and how many SKUs it holds. */
export const tenantMeterRow = z.object({
  tenantId,
  slug,
  status: tenantStatus,
  /** `status === 'active'` — a suspended or deleting tenant serves nobody, so it bills for nothing. */
  billable: z.boolean(),
  scopes: meterScopeCounts,
  /** Grants live at `readAt`, and grants that have lapsed — see the expiry rule above. */
  entitlements: z.object({
    live: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
});
export type TenantMeterRow = z.infer<typeof tenantMeterRow>;

/**
 * Meter 2, one row per (SKU, tier): entitlement flags are the SKUs (§9), and `plan` is
 * what makes a tier data instead of operator convention (#33). Grouped rather than
 * summed so "how many tenants are on `pro` of this engine" is a read, not a re-derivation.
 *
 * Counts BILLABLE holders only — an active tenant with a live grant. A grant held by a
 * suspended tenant is not revenue, and counting it here would make the meter disagree
 * with the base fee beside it.
 */
export const entitlementMeterRow = z.object({
  entitlementKey: z.string().min(1),
  /** Null = an ungrouped key (today's plain on/off flag). */
  plan: z.string().min(1).nullable(),
  /** Active tenants holding this key live at `readAt`. */
  tenants: z.number().int().nonnegative(),
  /** Active tenants whose grant for this key has lapsed — renewals, not revenue. */
  expired: z.number().int().nonnegative(),
});
export type EntitlementMeterRow = z.infer<typeof entitlementMeterRow>;

/**
 * One reading of meters 1 and 2 — fleet-wide, or narrowed to a single tenant.
 *
 * A reading is a fact about an INSTANT, not a running total: nothing is stored, nothing
 * accumulates, and re-reading recomputes. That is deliberate — a stored meter is a
 * billing system's ledger, and D-30 says meter, do not bill. `readAt` is what makes the
 * number quotable ("42 active scopes at 09:00") without pretending it is invoiced.
 */
export const meterReading = z.object({
  /** When the directory was read; every expiry comparison above is against this. */
  readAt: instant,
  /** Meter 1's tenant half, over the tenants in scope of this reading. */
  tenants: z.object({
    total: z.number().int().nonnegative(),
    /** The billable count — the per-tenant base fee's multiplier. */
    active: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    deleting: z.number().int().nonnegative(),
    reaped: z.number().int().nonnegative(),
  }),
  /** Meter 1's scope half, summed over those tenants. */
  scopes: meterScopeCounts,
  /** Meter 2, ordered by key then plan. Empty when nothing is entitled. */
  entitlements: z.array(entitlementMeterRow),
  /**
   * The per-tenant breakdown the totals are summed from — one row per tenant in scope
   * of the reading (exactly one when narrowed by `tenantId`). Ordered by tenant id.
   */
  perTenant: z.array(tenantMeterRow),
});
export type MeterReading = z.infer<typeof meterReading>;
