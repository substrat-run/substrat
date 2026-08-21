import { z } from 'zod';
import { instant, platformRequestId, scopeId } from './ids.js';
import { actor, domainEvent } from './events.js';
import { errorCode } from './errors.js';

/**
 * Platform intents (docs/architecture/platform-intents.md) — how a sandbox-clean vertical asks the
 * platform to perform a privileged action (provision a sibling scope, request quota, …) without
 * an upward call. A vertical operation enqueues a typed intent into its own scope's
 * `_substrat_platform_requests` spine table via `ctx.requestPlatform`; the platform pulls and
 * executes it with `HostAdmin` authority, knowing the tenant inherently (it reads that scope's DO).
 */

export const platformRequestStatus = z.enum(['pending', 'done', 'failed']);
export type PlatformRequestStatus = z.infer<typeof platformRequestStatus>;

/**
 * What module code passes to `ctx.requestPlatform`. `kind` selects the platform-side handler;
 * `payload` is opaque to the kernel (validated by the handler for that kind at drain time),
 * exactly as `domainEventInput.payload` is opaque to the emit path. Origin fields (id, requestedAt,
 * requestedBy) are stamped kernel-side and are deliberately absent here.
 */
export const platformRequestInput = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});
export type PlatformRequestInput = z.infer<typeof platformRequestInput>;

/**
 * WHO refused a settled intent — the fact the drawer's caption was guessing at (#841).
 *
 * A `connector:<provider>` delivery passes through two authorities before it is over: our
 * own permission check on the way to the bytes, and the provider's answer once they are
 * sent. Both surfaced as a `lastError` string and nothing distinguished them, so the
 * dashboard captioned every failure as the provider's — and a `permission denied:
 * protocol:read` raised on OUR side of egress was rendered as *"what Scrive said, in
 * full"*. An operator reading that goes to look at their Scrive account, presses **Test
 * connection** (which passes, because the credential is fine), and concludes the platform
 * is broken. That is the failure this record exists to end.
 *
 * - `platform` — one of ours, raised before anything reached the provider. The refusal
 *   carries a taxonomy `code`, so it can be said precisely rather than quoted.
 * - `provider` — the provider ANSWERED and refused. Only this one may be captioned as
 *   their words.
 * - `unknown` — classified and could not be told apart: a bug, a socket that never
 *   opened, a give-up at the attempt ceiling. Distinct from a NULL `failure`, which means
 *   nobody classified at all (a row settled before this field existed, or one that never
 *   failed) — honestly unrecorded rather than honestly unknown.
 */
export const platformRequestFailureOrigin = z.enum(['platform', 'provider', 'unknown']);
export type PlatformRequestFailureOrigin = z.infer<typeof platformRequestFailureOrigin>;

/**
 * How a settled intent's last failure was attributed. Written by the drain from the throw
 * itself, never re-derived downstream from the message — a reader that has to regex prose
 * to know who refused is the bug, not the fix.
 *
 * `permission` is the one extension lifted out of the error and given a column of its own,
 * because it is what makes the join mechanical: a refused key that is absent from the
 * connection's grants is the whole diagnosis, and both halves are already rendered inches
 * apart in the integration drawer. Every other extension stays in the message.
 */
export const platformRequestFailure = z.object({
  origin: platformRequestFailureOrigin,
  /** The taxonomy code, when the refusal was one of ours. `null` for a provider's answer. */
  code: errorCode.nullable(),
  /** The permission key a `permission_denied` names, when it named one. */
  permission: z.string().min(1).nullable(),
});
export type PlatformRequestFailure = z.infer<typeof platformRequestFailure>;

/** The full kernel-stamped intent record as it lives in the spine and is read by the drain. */
export const platformRequest = z.object({
  id: platformRequestId,
  kind: z.string().min(1),
  payload: z.unknown(),
  requestedBy: actor, // stamped kernel-side from the operation's ambient actor, like an event's `actor`
  status: platformRequestStatus,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** How `lastError` was attributed (#841). `null` = unrecorded, never "nobody's fault". */
  failure: platformRequestFailure.nullable(),
  result: z.unknown().nullable(),
  requestedAt: instant, // stamped kernel-side
  settledAt: instant.nullable(),
});
export type PlatformRequest = z.infer<typeof platformRequest>;

/**
 * How a caller narrows a read of a scope's intent JOURNAL (#618) — every intent, not just the
 * drainable ones. `listPlatformRequests` answers the drain's question ("what is pending?"); this
 * answers a human's ("what happened to mine, and what did the provider actually say?"). `kind`
 * is an exact match so `connector:scrive` reads one provider's traffic; results come back
 * newest-first, so `limit` is a recency window rather than a page.
 */
export const platformRequestFilter = z.object({
  kind: z.string().min(1).optional(),
  status: platformRequestStatus.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type PlatformRequestFilter = z.infer<typeof platformRequestFilter>;

/** How many journal rows an unbounded history read returns — a screenful, newest-first. */
export const DEFAULT_PLATFORM_REQUEST_HISTORY_LIMIT = 50;

/**
 * Backpressure bound (platform-intents.md §Resolved decisions): `ctx.requestPlatform` refuses once
 * a scope already holds this many `pending` intents, so a stuck or runaway vertical cannot flood
 * the drain. Shared by every adapter so the limit can't drift between them.
 */
export const MAX_PENDING_PLATFORM_REQUESTS = 32;

/**
 * The `provision-sibling` intent kind (multi-scope-manyfold.md M3) — a vertical asking the platform
 * to provision a new sibling scope of the one that enqueued it (a new Manyfold "site"). Shared
 * vocabulary: the vertical builds this payload, the platform's drain handler validates it. `owner`
 * is the vertical-domain principal to seat as the new scope's owner. The parent scope and the
 * tenant are NOT in the payload — the platform derives them from the scope the intent lives in.
 */
export const provisionSiblingPayload = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: z.string().min(1),
});
export type ProvisionSiblingPayload = z.infer<typeof provisionSiblingPayload>;

/** The well-known intent kind string for `provisionSiblingPayload`. */
export const PROVISION_SIBLING_KIND = 'provision-sibling';

/**
 * The `archive-scope` intent kind (multi-scope-manyfold.md) — a vertical asking the platform to
 * archive a sibling scope (retiring a Manyfold "site"). The target must belong to the same tenant
 * and vertical as the scope that enqueued the intent; the platform verifies that against its
 * directory before archiving, so a vertical can only ever archive its own tenant's scopes.
 */
export const archiveScopePayload = z.object({ scopeId });
export type ArchiveScopePayload = z.infer<typeof archiveScopePayload>;

/** The well-known intent kind string for `archiveScopePayload`. */
export const ARCHIVE_SCOPE_KIND = 'archive-scope';

/**
 * One entitlement a manager vertical asks the platform to grant (#412) — the SKU key plus
 * its tier grouping. `plan: null` = an ungrouped on/off flag. Deliberately NOT the full
 * `entitlementGrantInput` (no quota/expiry): a manager names WHAT a customer bought; how
 * a key meters is platform/console policy.
 */
export const entitlementSelection = z.object({
  key: z.string().min(1),
  plan: z.string().min(1).nullable(),
});
export type EntitlementSelection = z.infer<typeof entitlementSelection>;

/**
 * The `provision-tenant` intent kind (#412) — a MANAGER vertical (a console whose job is to
 * add tenants, e.g. the AuthHero console) asking the platform to create a NEW customer
 * tenant, its first scope running a (possibly different) vertical, and its entitlements.
 * Unlike `provision-sibling`, the target tenant does not exist yet, so the drained scope
 * proves nothing about it — admissibility is bounded on the MANAGER instead (a
 * platform-granted provisioner capability + its declared SKU universe; platform-drain.ts).
 * All ids are proposed by the vertical as idempotent join keys: a retry after a partial
 * failure converges on the same tenant/scope instead of minting duplicates.
 */
export const provisionTenantPayload = z.object({
  tenant: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
  /** The tenant's FIRST scope. `vertical` comes from the payload, never inherited. */
  instance: z.object({
    vertical: z.string().min(1),
    scopeId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().min(1),
  }),
  /** SKUs to grant the new tenant + project into the scope (#310). */
  entitlements: z.array(entitlementSelection),
  /** Per-instance settings, delivered via the vertical's `/internal/configure` when present. */
  config: z.record(z.string(), z.string()).optional(),
});
export type ProvisionTenantPayload = z.infer<typeof provisionTenantPayload>;

/** The well-known intent kind string for `provisionTenantPayload`. */
export const PROVISION_TENANT_KIND = 'provision-tenant';

/**
 * The `set-entitlements` intent kind (#412) — reconcile a managed tenant's grants to a
 * plan's TARGET set. The payload names the target; the platform grants what is present and
 * revokes any key in the manager's declared SKU universe that is absent — so the declared
 * set bounds BOTH sides and a downgrade revokes cleanly. `authScopeId` is the scope the
 * new set is re-projected into (the vertical's #310 projection is a full replace).
 */
export const setEntitlementsPayload = z.object({
  tenantId: z.string().min(1),
  authScopeId: z.string().min(1),
  plan: z.string().min(1),
  entitlements: z.array(entitlementSelection),
});
export type SetEntitlementsPayload = z.infer<typeof setEntitlementsPayload>;

/** The well-known intent kind string for `setEntitlementsPayload`. */
export const SET_ENTITLEMENTS_KIND = 'set-entitlements';

/**
 * The `connector:<provider>` intent family (#574 phase 3) — a CP-less host routing one
 * connector delivery onto the platform-requests surface instead of running it in-process.
 * A hosted vertical cannot reach the connection directory, so its host journals the
 * delivery as routed and enqueues this intent; the platform's drain executes the same
 * connector handler a self-host runs, with the directory, sealed credentials and egress
 * it already holds, and writes back through the vertical's `/internal/connector-*` seam.
 *
 * The kind is a FAMILY, not one string: the suffix names the provider so the platform
 * registers one handler per connector it operates (`connector:scrive`), exactly as it
 * registers per-provider sweepers.
 */
export const CONNECTOR_DISPATCH_KIND_PREFIX = 'connector:';

/** The intent kind for one provider's routed dispatch: `connector:scrive`. */
export const connectorDispatchKind = (provider: string): string =>
  `${CONNECTOR_DISPATCH_KIND_PREFIX}${provider}`;

/**
 * The routed delivery itself. The event is embedded FAT (the whole spine envelope, not an
 * id): the platform's handler needs everything the in-process handler would have been
 * handed, and the vertical's outbox is not reachable from the drain without a second hop.
 * The drain re-parses it (`domainEvent`) and refuses an event whose kernel-stamped
 * tenant/scope disagree with the drained scope's — the intent rides that scope's own
 * spine table, so those are the proven values. `executorId` is the vertical-side
 * registration the delivery was journaled under, carried for attribution/debugging.
 */
export const connectorDispatchPayload = z.object({
  executorId: z.string().min(1),
  event: domainEvent,
});
export type ConnectorDispatchPayload = z.infer<typeof connectorDispatchPayload>;
