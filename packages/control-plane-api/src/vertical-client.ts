import { z } from '@substrat-run/contracts';
import type {
  EntityGrantShape,
  AttachmentRecord,
  ScopeLineage,
  ConnectionId,
  DrainedEvent,
  EntityRef,
  EntitlementGrant,
  ModuleId,
  PermissionKey,
  PlatformActorId,
  PlatformRequestEntry,
  PlatformRequestFilter,
  PlatformRequestId,
  PlatformRequestStatus,
  PlatformRequestFailure,
  PlatformOutcomeEvent,
  MintedPreviewClient,
  PreviewClientCheck,
  PreviewClientClaim,
  PreviewClientMint,
  PreviewClientRetire,
  PrincipalId,
  RetiredPreviewClients,
  PeerGrantsEntry,
  PeerSwitchOutcome,
  SystemSwitchOutcome,
  SystemScheduleEntry,
  ConnectionGrantRecord,
  ProjectedConnectionGrant,
  ProjectedConnectionKey,
  ProjectedIdentityLink,
  OwnerSeat,
  OwnerClaimLink,
  OwnerTransferResult,
  QueryScopeInput,
  ReadScopeTableInput,
  EntityHistoryInput,
  EventFacetInput,
  EventCauseInput,
  EventEffectsInput,
  EffectsTree,
  InvocationEventsInput,
  InvocationEvents,
  DeadLettersInput,
  DeadLetter,
  LifecycleFlowInput,
  LifecycleFlowResult,
  OperationSeriesInput,
  OperationSeriesResult,
  CauseChain,
  EventFacetResult,
  HistoryEntry,
  Page,
  ScopeDumpTable,
  ScopeId,
  ScopeQueryResult,
  DenialFilter,
  DenialSummary,
  PermissionDenial,
  ScopeTable,
  ScopeTablePage,
  ScopeDumpPage,
  TenantId,
  TenantStoreHandle,
  Visibility,
} from '@substrat-run/contracts';
import {
  PREVIEW_CLIENT_PATH,
  attachmentRecord,
  projectedConnectionGrant,
  denialFilterParams,
  capabilityFilterParams,
  capabilityPage,
  capabilityRevokeAnswer,
  capabilityRevokeRequest,
  type CapabilityFilter,
  type CapabilityPage,
  type CapabilityRecord,
  type CapabilityRevokeRequest,
  mintedPreviewClient,
  ownerSeat,
  ownerClaimLink,
  memberInviteLink,
  memberRemoval,
  scopeMembers,
  type MemberInviteLink,
  type MemberRemoval,
  type ScopeMembers,
  ownerTransferResult,
  previewClientClaim,
  retiredPreviewClients,
  peerGrantsEntry,
  peerSwitchOutcome,
  systemSwitchOutcome,
  lifecycleDelivery,
  type LifecycleDelivery,
  type ScopeLifecycle,
  systemScheduleEntry,
  switchedOffInUnit,
  type SwitchedOffInUnit,
  exportedBatch,
  importResult,
  importCursorMoved,
  type ImportCursorMoveAt,
  type ImportCursorMoved,
  importState,
  type ExportReadInput,
  type ExportedBatch,
  type ImportBatch,
  type ImportResult,
  type ImportState,
  type VerticalCaller,
  substratError,
  CONNECTOR_ATTACHMENT_META_HEADER,
  CONNECTOR_ATTACHMENT_META_MAX_BYTES,
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
  LOAD_STAMP_HEADER,
  PLATFORM_SECRET_HEADER,
  WRITE_REVISION_HEADER,
  mergeDumpPages,
  scopeDumpPage,
} from '@substrat-run/contracts';
import type { CopyRestoreFence, KeptCopy, LoadMarker, OpenedAttachment, OrphanSweepReport, SubjectRedactionCounts, UndrainedEvents, UndrainedRead } from '@substrat-run/kernel';
import { isSizedByteStream, knownLengthInit, ulid, undrainedEventsOf, type ByteBody, type SizedByteStream } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';

/**
 * A 404 the vertical's router answered because it has no such route: a non-empty body that is
 * not JSON (Hono's miss is plain text). vertical-host's `classifyError` and a vertical's own
 * `mapError` also answer 404, for a scope or row it could not find, and those come as the JSON
 * envelope. A 404 whose body is empty or could not be read proves nothing, so it is not a miss.
 */
export function isRouteMiss(err: ControlPlaneError): boolean {
  if (err.status !== 404 || !err.body?.trim()) return false;
  try {
    JSON.parse(err.body);
    return false;
  } catch {
    return true;
  }
}

/** The orphan-attachment report as it crosses the wire (#2314): `OrphanSweepReport`, checked. */
const orphanSweepReportWire = z.object({
  listed: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  orphans: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  keys: z.array(z.string()),
  fencedUntil: z.string().optional(),
  dryRun: z.boolean(),
  bucket: z.literal('none').optional(),
  consumeFailed: z.literal(true).optional(),
});

/** `routeAnswer`'s word for a deployment that predates the route it was asked (#1722, #2010). */
const PREDATES = Symbol('predates');

/**
 * What `routeAnswer` needs from a verb: whether the far end's own 501 is its fallback for a
 * route it does not have, and the sentence a lost answer ends with — what it leaves unknown.
 */
type RouteRule = { legacy501: boolean; lost: string };

/** #1722's kept-copy and fenced-wipe verbs: a host without the method answers a 501. */
const FENCED: RouteRule = { legacy501: true, lost: 'it may or may not have acted' };

/**
 * What a 200 whose body is not JSON says, when it is an HTML page (#2010, Codex #2014 r1). An old
 * deployment's SPA fallback answers its own app's `index.html` for a path it does not route, and a
 * proxy or error page in between answers HTML too. Nothing the platform controls marks the first
 * (the page is the vertical's, served by the asset layer before any platform code runs, and the
 * deployments in question predate any marker that could be added now), so the two cannot be told
 * apart, and an HTML page is never read as "predates the route".
 */
function htmlNote(res: Response): string {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
    ? " (an HTML page: an old deployment's app shell cannot be told from an error page in between)"
    : '';
}

/**
 * The query string for both internal denial reads. The filter's own fields come from
 * the ONE encoder in contracts (#971) — this branch answers the same two routes as
 * `ControlPlaneClient`, for a HOSTED scope, so a filter field it dropped would be a
 * silently wider read on exactly the scopes that are not co-located. `scopeId` is the
 * one thing added here: the internal route is not scope-addressed in its path.
 */
function denialParams(scopeId: ScopeId, filter?: DenialFilter): URLSearchParams {
  const q = denialFilterParams(filter);
  q.set('scopeId', scopeId);
  return q;
}

/**
 * The platform's client for calling a VERTICAL (K-31).
 *
 * The mirror of `ControlPlaneClient`, pointing the other way, and the direction
 * matters: that one is a vertical talking up to the platform, this is the platform
 * telling a vertical to do something. K-31 makes this the authoritative direction,
 * because only the vertical can create a usable scope DO — the DO class bundles the
 * modules and lives in the vertical's own deployment.
 *
 * Deliberately tiny. The platform asks a vertical to do three kinds of thing: create an
 * instance (K-31); — read-only — introspect a scope's own database (§5.4), because the
 * scope's data DO lives in the vertical's deployment, not the platform's; and manage
 * scope-STORAGE lifecycle — snapshot a scope into a sibling, wipe a reaped fork
 * (preview-and-snapshots.md §9, the ratified trust line: infrastructure verbs over the
 * DO's storage, extending the authority provisionInstance already asserts). Every other
 * verb — anything that reads or writes DOMAIN data — would be authority the platform
 * holds over someone else's code. Note the lifecycle verbs move no data across the
 * boundary: a snapshot copies between two DOs inside the vertical's own deployment and
 * returns only a table count.
 */

/**
 * How long an AUDITED vertical call may run (#2064): the owner hand-over and the member changes,
 * and (#2089) the kill switches' delegated calls — a switch makes at most three (the fence
 * preflight, the move and one retry), well inside the settle's hour. An `intent` row is written
 * before the call and its outcome after. The scheduled settle calls an intent with no outcome
 * `unknown` once its grace window has passed.
 * This bound is what keeps a live call from being settled: `settleUnrecordedOutcomes` refuses a
 * grace window that does not exceed it. A call past it is answered 504 and audited `failed`,
 * which means what `failed` always means: it may have stopped part-way.
 */
export const AUDITED_CALL_DEADLINE_MS = 60_000;

/**
 * How long one call of a paged copy may run (#2450): a page read, a page staged, a stage dropped.
 * A page is at most `SCOPE_DUMP_PAGE_MAX_BYTES`, seconds of work, so a call past this has stalled.
 * Answered 504, it ends the job step it held up as a transient fault: a cancel or forget, which
 * waits for the step in flight, then waits this long at most past the step's own budget.
 */
export const PAGE_CALL_DEADLINE_MS = 60_000;

/**
 * Run the WHOLE exchange `run` under one deadline (#2064): the request, its status, and the
 * body, whether that body is the answer or a refusal. A vertical that answers its headers in
 * time and then stalls the body is held to the same bound as one that never answers. On expiry,
 * the signal handed to `run` is aborted. A `fetch` given that signal aborts the request AND its
 * response body stream, so the call stops rather than idling on. The caller is answered `504`
 * whether or not `run` ever settles.
 */
async function withDeadline<T>(verb: string, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ControlPlaneError(504, `the vertical did not answer ${verb} within ${ms / 1000} s; it may have stopped part-way`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export interface VerticalClientOptions {
  /**
   * How to reach the vertical. A Worker service binding's `fetch` when deployed —
   * the vertical has no public route (K-26/K-27), so this is the only ingress — or
   * plain `fetch` against a URL locally.
   */
  fetch: typeof fetch;
  /** Base URL. With a service binding the host is ignored, but `Request` needs one. */
  baseUrl?: string;
  /** Shared secret the vertical verifies with `assertPlatformCall`. */
  platformSecret: string;
}

export interface ProvisionInstanceInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first admin — whoever asked for the instance. */
  owner: PrincipalId;
  slug: string;
  name: string;
  /**
   * Per-instance config delivered WITH provisioning, so a new app arrives configured
   * atomically — no window where the instance is live but unconfigured (an issuer with
   * no admin, an app with no auth). Same entries `configureInstance` upserts later; a
   * vertical that predates the field ignores it (its body parse strips unknown keys).
   */
  config?: Record<string, string>;
  /**
   * The tenant's entitlements, delivered WITH provisioning (#310) so a CP-less vertical
   * PROJECTS them into the new scope and reads/enforces `plan`/`quota`/`expiry` at request
   * time (#304) — it may not read the shared control plane (the `CONTROL_PLANE` binding is
   * forbidden, #302). The platform is authoritative: it gathers these itself rather than
   * trusting a caller. A vertical that predates the field ignores it (its body parse strips
   * unknown keys); until it lands, the scope trusts upstream and only expiry (carried on the
   * row) enforces locally.
   */
  entitlements?: EntitlementGrant[];
  /**
   * The tenant's identity links, delivered WITH provisioning (#406) on the same trust line
   * as entitlements: the platform gathers them itself (`admin.listIdentityLinks`, never the
   * caller's body) and the CP-less vertical PROJECTS them, so its auth adapter resolves
   * `(provider, externalId) → principal` from local storage instead of a map compiled into
   * the bundle — which made offboarding a deploy and let a version rollback resurrect a
   * removed login. A vertical that predates the field ignores it (its body parse strips
   * unknown keys).
   */
  identityLinks?: ProjectedIdentityLink[];
  /**
   * The tenant's connection grants for THIS scope (#592), on the same trust line as
   * entitlements and identity links: the platform gathers them itself from the directory
   * (`admin.listConnectionGrants`, never the caller's body), materializes tenant-wide rows
   * per scope, and the CP-less vertical projects them as the `connection:<id>` tuples its
   * connector return path (`connectorInvokeLocal`) is permission-checked against. Without
   * this, a grant is a one-shot hand-write per scope: every install provisioned after
   * `grantToConnection` silently ships without the return path. A vertical that predates
   * the field ignores it (its body parse strips unknown keys).
   */
  connectionGrants?: ProjectedConnectionGrant[];
  /**
   * Live connections' PUBLIC sealing keys for this scope's vertical (#687), on the same
   * trust line as everything above it: the platform gathers them itself
   * (`admin.connectionSealingKeys`, never the caller's body) and the CP-less vertical
   * projects them, so module code can seal a value TO a connector — the only channel a
   * scope has for handing a connector something the spine must not hold in the clear.
   *
   * **Public halves only, structurally.** The private half stays sealed in the directory;
   * projecting a secret key into a scope is the failure kernel-design §13.1 names, and it
   * is what makes this carrier possible rather than what would break it — a public key
   * lets the scope WRITE to a connector, never read.
   *
   * Delivery ORDER is load-bearing (signature-contact-carrier.md §7 point 2): the key must
   * reach the scope before the engine tries to seal to it. A vertical that predates the
   * field ignores it (its body parse strips unknown keys), and until it lands
   * `sealToConnection` refuses loudly rather than emitting a request that reaches nobody.
   */
  connectionKeys?: ProjectedConnectionKey[];
  /**
   * Per-tenant relational stores the platform MINTED for this tenant (#301), handed over
   * WITH provisioning so the vertical opens each (`host.openTenantStore(handle)`) and runs
   * its OWN store migrations against it before the callback returns — the same fail-closed,
   * idempotent, retryable K-31 ready-gate that guards scope migrations now also guards the
   * store, so there is no ready-but-empty-DB race. `ref` is opaque; the vertical never
   * parses it. A vertical that predates the field ignores it (its body parse strips unknown
   * keys). One handle per declared `tenantStoreNeed.binding`.
   */
  tenantStores?: TenantStoreHandle[];
  /**
   * The modules the platform's record holds switched OFF on this scope (#1742), gathered by
   * `reconcileThenReassert` from the directory, never the caller's body. The deployment
   * switches them off again in the provision's own unit, after the seat, on THIS scope only.
   * A vertical that predates the field ignores it, and the re-assert after the call covers it.
   */
  switchedOff?: ModuleId[];
  /** Of `switchedOff`, the modules held on this scope only by a tenant-level grant (#1823). */
  tenantHeld?: ModuleId[];
  /** #2029: the peers the record holds OFF here, switched off in the same unit; a vertical that
   *  predates the field ignores it. And of those, the ones held only by a tenant grant (#2030). */
  switchedOffPeers?: string[];
  tenantHeldPeers?: string[];
  /** #2045: each recorded-off subject's fence, by tuple subject. A vertical that predates it ignores it. */
  switchFences?: Record<string, string>;
}

export interface ConfigureInstanceInput {
  /** The scope's tenant — CP-less verticals shard identity/config storage per tenant
   *  (e.g. Meridian's IdentityDO is addressed by tenant id), so the address rides along. */
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Upserts, key by key — never a full replace, so partial writes compose. */
  entries: Array<{ key: string; value: string }>;
}

export interface ProvisionedInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  owner: PrincipalId;
  /**
   * NON-SECRET first-run facts the vertical reported alongside the ack (#426): a minted
   * client id, migrations applied, endpoint paths — anything the installer needs to SEE
   * once the instance exists. Collected from the provision response's extra top-level
   * primitive fields (and an explicit `result` object, which wins on a shared key), so a
   * vertical opts in by simply returning more than the ack. Persisted by installers and
   * shown to the operator — which is why secrets don't belong here: credentials flow IN
   * via `config` (the installer chose them), never back OUT in a response that outlives
   * one HTTP exchange. Keys that look like secrets are dropped as a backstop.
   */
  result?: Record<string, string>;
  /** What the deployment switched off inside the provision's unit (#1742), when asked to. */
  switchedOff?: SwitchedOffInUnit[];
}

/** The ack fields every provision response carries — everything else is `result` material. */
const PROVISION_ACK_FIELDS = new Set(['tenantId', 'scopeId', 'owner', 'result', 'switchedOff']);

/**
 * A deployment's report of what it switched off in the unit (#1742). Read only to audit
 * what the platform's own re-assert will then find already done, so a report that does not
 * parse is dropped rather than failing a provision that succeeded. The re-assert still runs.
 */
function switchedOffFrom(raw: unknown): { switchedOff?: SwitchedOffInUnit[] } {
  if (raw === undefined) return {};
  const parsed = switchedOffInUnit.array().safeParse(raw);
  return parsed.success ? { switchedOff: parsed.data } : {};
}

/** #2185: the reconcile's count of retirements left open, kept only when it is one (a whole number, 0 or more). */
function retirementsLeftOpenFrom(raw: unknown): { retirementsLeftOpen?: number } {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? { retirementsLeftOpen: raw } : {};
}

/** #2184: the types the scope has ever bound, kept only when every entry is a non-empty string. */
function boundShapeTypesFrom(raw: unknown): { boundShapeTypes?: string[] } {
  return Array.isArray(raw) && raw.every((t) => typeof t === 'string' && t.length > 0) ? { boundShapeTypes: raw as string[] } : {};
}

/** The backstop: a vertical that still returns credential-shaped keys has them dropped, not persisted. */
const SECRETLIKE_KEY = /password|secret|token|private/i;

/**
 * The non-secret result map from a vertical's provision response: explicit `result`
 * entries plus extra top-level primitives, secret-looking keys excluded, values
 * stringified. Undefined when the vertical returned only the bare ack.
 */
function provisionResultFrom(body: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const collect = (entries: Record<string, unknown>, skipAck: boolean): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (skipAck && PROVISION_ACK_FIELDS.has(key)) continue;
      if (SECRETLIKE_KEY.test(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value);
      }
    }
  };
  collect(body, true);
  const explicit = body['result'];
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    collect(explicit as Record<string, unknown>, false);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ReconcileInstanceInput {
  /** The scope's tenant — a CP-less vertical shards its identity/owner store per tenant
   *  (Meridian's IdentityDO is addressed by tenant id), and re-sourcing the owner needs it. */
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The tenant's entitlements, gathered by the platform and re-projected on reconcile, exactly
   *  as at provision (#310). Deliberately NO owner: the platform never persisted one — the
   *  vertical re-sources it from its own durable owner-of-record. */
  entitlements?: EntitlementGrant[];
  /** The tenant's identity links, gathered by the platform and re-projected on reconcile,
   *  exactly as at provision (#406) — the repair channel for a dropped delivery, and the
   *  re-delivery a link/unlink AFTER provision rides. */
  identityLinks?: ProjectedIdentityLink[];
  /** The tenant's connection grants for this scope, gathered and re-delivered exactly as at
   *  provision (#592) — the back-fill for a scope provisioned before `grantToConnection`
   *  ran, and the channel a grant AFTER provision rides. A revoked connection's grants are
   *  absent from the gather, so they stop being delivered. */
  connectionGrants?: ProjectedConnectionGrant[];
  /** Live connections' public sealing keys, gathered and re-delivered exactly as at provision
   *  (#687) — the back-fill for a scope provisioned before the connection existed, and the
   *  channel a connection made AFTER provision rides. A revoked connection's key is absent
   *  from the gather, so the scope stops being able to seal to it. */
  connectionKeys?: ProjectedConnectionKey[];
  /** Per-tenant relational stores, minted (or re-resolved) on the reconcile itself (#825) and
   *  handed over exactly as at provision: a tenant that predates its vertical's `tenantStores`
   *  declaration is given its store HERE, and has therefore never migrated it — so the handle
   *  must ride the reconcile into the same fail-closed K-31 ready-gate. A vertical that
   *  predates the field ignores it (its body parse strips unknown keys). */
  tenantStores?: TenantStoreHandle[];
  /** The recorded-off modules, switched off in the reconcile's own unit (#1742) — as at provision. */
  switchedOff?: ModuleId[];
  /**
   * #2263: accept the OWNERLESS reconcile from a vertical that keeps no owner of record (no
   * `resolveOwner` at all; one that keeps a record and finds none still answers 409) — the
   * tuples its running version declares (schedule grants, peer keys, these connection grants)
   * seated and the recorded-off positions re-applied, and nothing else: no projection of the
   * entitlements, links or keys above, no entity-grant shapes, no owner. Answered `owner: null`
   * with no retirement or bound-shape report. Omit it when the projection is the point (an
   * entitlements delivery): such a vertical then refuses (501) as it always did. A vertical
   * built before the field ignores it and refuses too.
   */
  ownerless?: 'seat';
  /** Of `switchedOff`, the modules held only by a tenant-level grant (#1823) — as at provision. */
  tenantHeld?: ModuleId[];
  /** #2029: the recorded-off peers, and those held only by a tenant grant — as at provision. */
  switchedOffPeers?: string[];
  tenantHeldPeers?: string[];
  /** #2045: each recorded-off subject's fence, by tuple subject. A vertical that predates it ignores it. */
  switchFences?: Record<string, string>;
  /**
   * #2071: the declared entity-grant shapes of the version this reconcile reaches, read from
   * that version's REVIEWED registry — the object the permission digest covers — so what a
   * reconcile tops up is exactly what a promote acknowledged. Absent when the platform cannot
   * name the version, and then nothing is reconciled. A vertical that predates it ignores it.
   */
  entityGrants?: EntityGrantShape[];
}

/**
 * Materialize a tenant's directory-side connection grants for ONE scope (#592) — the
 * gather half every delivery site shares. Keeps only grants whose connection belongs to
 * the scope's vertical (a connection is keyed (tenant, vertical, provider) and must not
 * reach another vertical's scopes), then tenant-wide rows (`scopeId: null`) materialize
 * for any scope while scope-targeted rows survive only for their own — which is what
 * lets a re-provision re-deliver a hand-granted scope AND a fresh install receive the
 * tenant-wide grants it was provisioned after.
 */
export function connectionGrantsForScope(
  grants: ConnectionGrantRecord[],
  vertical: string | null | undefined,
  scopeId: ScopeId,
): ProjectedConnectionGrant[] {
  if (!vertical) return [];
  return grants
    .filter((g) => g.vertical === vertical && (g.scopeId === null || g.scopeId === scopeId))
    .map((g) => ({
      connectionId: g.connectionId,
      permission: g.permission,
      ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}),
    }));
}

export interface ReconciledInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The owner the vertical re-granted, echoed back so the caller can report who was restored.
   *  `null` (#2263) when the vertical keeps no owner of record and the caller sent `ownerless`:
   *  the ownerless reconcile ran, no owner was re-seated, and no lockout was repaired. */
  owner: PrincipalId | null;
  /** What the deployment switched off inside the reconcile's unit (#1742), when asked to. */
  switchedOff?: SwitchedOffInUnit[];
  /**
   * #2185: with `entityGrants`, how many shapes' retirements the reconcile left open; 0 when every
   * one finished. Absent from a deployment whose `adapter-cloudflare` (which counts) or `vertical-host`
   * (which answers) predates the report, and from an answer that
   * does not parse: both count as not finished (`reconcileOutcomeOf`).
   */
  retirementsLeftOpen?: number;
  /**
   * #2184: with `entityGrants`, every entity type the scope has ever bound through a link
   * (`shape-bound`). Absent from a deployment built on packages that predate it, and from an
   * answer that does not parse: both read as unknown (`reconcileOutcomeOf`).
   */
  boundShapeTypes?: string[];
}

export class VerticalClient {
  constructor(private readonly options: VerticalClientOptions) {}

  /**
   * Ask the vertical to create one instance.
   *
   * Idempotent at the far end, so a retry after a partial failure converges rather
   * than duplicating — which K-31 makes load-bearing, because this is the second
   * phase of a two-phase creation and the reconciliation sweep re-runs exactly it.
   */
  async provisionInstance(input: ProvisionInstanceInput): Promise<ProvisionedInstance> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach('provisioning', () =>
      this.options.fetch(`${base}/internal/provision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
        },
        body: JSON.stringify(input),
      }),
    );

    // Surfaced rather than swallowed: a 403 here means the secrets do not match,
    // which is a deployment error someone must see, not a transient failure to retry.
    if (!res.ok) throw await this.refusal('provisioning', res);
    // The SUCCESS body matters too (#426): a vertical may report first-run facts with
    // its ack. Carry them as `result` so callers can persist them — before this, the
    // body's only reader was `await res.json()` and everything beyond the ack died
    // with the response.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const ack = { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
    const result = provisionResultFrom(body);
    return { ...ack, ...(result ? { result } : {}), ...switchedOffFrom(body['switchedOff']) };
  }

  /**
   * Deliver per-instance CONFIG to the scope's own storage (vertical-auth-detach.md
   * §2.2) — the write half of the dashboard's Env tab, and the same trust line as
   * provisionInstance: the platform names a scope inside the vertical's deployment and
   * hands it settings; the vertical owns what they mean. Idempotent upserts, so the
   * reconciliation sweep can re-run it. A vertical that has no live-config support
   * answers 501, which the caller may treat as "authored but not delivered".
   */
  async configureInstance(input: ConfigureInstanceInput): Promise<void> {
    await this.postInternal<unknown>('/internal/configure', input, 'configure');
  }

  /**
   * Re-provision an EXISTING instance to repair the #332 lockout: a scope left with role
   * definitions projected but no principal holding a role — `permission_source = 'local'`, zero
   * tuples — enforces nothing but denials, and the builder cannot reach the platform-secret-gated
   * `/internal/provision` to fix it. This is the builder-triggerable repair the control plane makes
   * on their behalf (after checking ownership): it carries NO owner — the platform never persisted
   * one — so the vertical re-sources the owner from its own durable owner-of-record and re-runs the
   * idempotent provision. Entitlements are re-gathered and re-delivered exactly as at provision.
   */
  async reconcileInstance(input: ReconcileInstanceInput): Promise<ReconciledInstance> {
    const { switchedOff, retirementsLeftOpen, boundShapeTypes, ...ack } = await this.postInternal<
      Omit<ReconciledInstance, 'switchedOff' | 'retirementsLeftOpen' | 'boundShapeTypes'> & {
        switchedOff?: unknown;
        retirementsLeftOpen?: unknown;
        boundShapeTypes?: unknown;
      }
    >('/internal/reconcile', input, 'reconcile');
    return {
      ...ack,
      ...switchedOffFrom(switchedOff),
      ...retirementsLeftOpenFrom(retirementsLeftOpen),
      ...boundShapeTypesFrom(boundShapeTypes),
    };
  }

  /**
   * Read the scope's OWN database tables (kernel-design §5.4 admin-query RPC).
   *
   * The platform asks the vertical because the scope's data DO lives in the vertical's
   * deployment (K-31), not the control plane's own (empty-module) scope host. Read-only
   * and table-shaped — the platform never sends SQL, only a scope id (and, below, a
   * table name the vertical validates against its live schema).
   */
  async listScopeTables(scopeId: ScopeId): Promise<ScopeTable[]> {
    return this.getInternal<ScopeTable[]>(`/internal/tables?scopeId=${encodeURIComponent(scopeId)}`);
  }

  /** A bounded page of one of the scope's tables. */
  async readScopeTable(scopeId: ScopeId, input: ReadScopeTableInput): Promise<ScopeTablePage> {
    const q = new URLSearchParams({
      scopeId,
      limit: String(input.limit),
      offset: String(input.offset),
    });
    return this.getInternal<ScopeTablePage>(
      `/internal/tables/${encodeURIComponent(input.table)}?${q}`,
    );
  }

  /**
   * One read-only SQL statement against the scope's DB — the console (#219). The
   * vertical enforces read-only-ness in its own deployment (the kernel gate + the
   * DO's rolled-back transaction); a vertical that cannot answer safely (e.g. one
   * that redacts secret columns on table reads) refuses with its own status, which
   * the ControlPlaneError relays verbatim.
   */
  async queryScope(scopeId: ScopeId, input: QueryScopeInput): Promise<ScopeQueryResult> {
    return this.postInternal<ScopeQueryResult>('/internal/query', { scopeId, sql: input.sql }, 'query');
  }

  /**
   * The scope's K-35 denial log (#867) — pulled for the same reason the tables are: a
   * denial is written in the scope's own DO, which lives in the vertical's deployment
   * (K-31), not the control plane's. The K-3 cross-check and the K-24 access-log entry
   * are made on the platform side before this call; what crosses is a scope id and a
   * filter, never SQL.
   */
  async listDenials(scopeId: ScopeId, filter?: DenialFilter): Promise<PermissionDenial[]> {
    return this.getInternal<PermissionDenial[]>(`/internal/denials?${denialParams(scopeId, filter)}`);
  }

  /** The bucketed view of the same log (K-35's rate-buckets), with the window's facts. */
  async summarizeDenials(scopeId: ScopeId, filter?: DenialFilter): Promise<DenialSummary> {
    return this.getInternal<DenialSummary>(
      `/internal/denials/summary?${denialParams(scopeId, filter)}`,
    );
  }

  /** The scope's capability directory (#1686), pulled from the vertical that holds it and parsed on arrival, so a hash-bearing answer cannot pass through. */
  async listCapabilities(scopeId: ScopeId, filter?: CapabilityFilter): Promise<CapabilityPage> {
    const q = capabilityFilterParams(filter);
    q.set('scopeId', scopeId);
    return capabilityPage.parse(await this.getInternal<unknown>(`/internal/capabilities?${q}`));
  }

  /**
   * Revoke one capability in the deployment serving the scope (#1686) — the far end of
   * `HostAdmin.revokeCapability` for a hosted scope, whose capability directory lives there.
   * The record as it stood before, or `null` when the scope holds no such capability (the route
   * answers that as `{ before: null }`, never a 404).
   *
   * The skew rule is `systemSwitch`'s: a **404** is the deployment's own proof that it predates
   * the route, and only that becomes the 501 "redeploy" — nothing was revoked. Everything else
   * (unreachable, a refusal, an unreadable or wrong-shaped 200) is a failure that may have landed,
   * so it says to read the directory before retrying. A revoke is idempotent, so a retry is safe.
   */
  async revokeCapability(input: CapabilityRevokeRequest): Promise<CapabilityRecord | null> {
    const verb = 'capability-revoke';
    const lost = `the capability ${input.capabilityId} may or may not be revoked. Read the scope's capabilities before retrying.`;
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${input.scopeId} predates the capability revoke (#1686) — ` +
        `redeploy the vertical, then retry. Nothing was revoked.`,
      shape: `vertical answered ${verb} with an unexpected shape — ${lost}`,
    };
    // Parsed before anything is sent: a malformed request is the caller's error, never a far-end one.
    const body = JSON.stringify(capabilityRevokeRequest.parse(input));
    // Audited intent-then-outcome like a switch call (#2089), so held to the deadline the settle waits out.
    const answer = await withDeadline(verb, AUDITED_CALL_DEADLINE_MS, (signal) =>
      this.parsedAnswer(verb, rule, capabilityRevokeAnswer, () =>
        this.options.fetch(`${base}/internal/capabilities/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
          body,
          signal,
        }),
      ),
    );
    return answer.before;
  }

  /**
   * The scope's OWNER SEAT (#925) — claimed, unclaimed (with whether a plain first sign-in
   * still claims it), or unknown. Pulled for the same reason the denials are: the seat lives
   * in the vertical's own identity directory, in its deployment, not the platform's. Parsed
   * on arrival: a vertical answering a stale shape is a diagnosis here, not a screen upstream.
   */
  async ownerSeat(tenantId: TenantId, scopeId: ScopeId): Promise<OwnerSeat> {
    const q = new URLSearchParams({ tenantId, scopeId });
    return ownerSeat.parse(await this.getInternal<unknown>(`/internal/owner-seat?${q}`));
  }

  /**
   * Mint a short-lived claim link for an unclaimed owner seat (#925). `origin` is the
   * instance's public origin — the platform owns the hostname directory, so it names the host
   * the link must open on. The answer carries the token in its URL and is relayed once, never
   * stored: `provisionResultFrom` drops secret-shaped keys from an ack that installers
   * persist, and this is the deliberate opposite — a credential that lives one exchange.
   */
  async mintOwnerClaim(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    origin: string;
    /** Who asked (#1686) — the vertical records it as the claim link's minter. */
    actor?: PlatformActorId;
  }): Promise<OwnerClaimLink> {
    return ownerClaimLink.parse(await this.postInternal<unknown>('/internal/owner-claim', input, 'owner-claim'));
  }

  /**
   * The scope's MEMBERS (#1150) — vertical-host's `/internal/members`: who holds which scope role,
   * the logins bound to each, the open invites, and the roles the vertical lets a person hold.
   * Parsed on arrival, like the owner seat.
   */
  async listMembers(tenantId: TenantId, scopeId: ScopeId): Promise<ScopeMembers> {
    const q = new URLSearchParams({ tenantId, scopeId });
    return scopeMembers.parse(await this.getInternal<unknown>(`/internal/members?${q}`));
  }

  /**
   * Invite a member (#1150), bounded in the vertical by `caller`'s own authority. The answer
   * carries the accept link's token and is relayed once, never stored — `mintOwnerClaim`'s rule.
   */
  async inviteMember(input: {
    tenantId: TenantId; scopeId: ScopeId; caller: PrincipalId; origin: string; roleKey: string; email: string | null;
  }): Promise<MemberInviteLink> {
    return memberInviteLink.parse(await this.postInternal<unknown>('/internal/members/invite', input, 'members-invite', AUDITED_CALL_DEADLINE_MS));
  }

  /** Move a member from one role to another in one scope task, bounded by `caller` (#1150). */
  async changeMemberRole(input: {
    tenantId: TenantId; scopeId: ScopeId; caller: PrincipalId; principal: PrincipalId; from: string; to: string;
  }): Promise<void> {
    await this.postInternal<unknown>('/internal/members/role', input, 'members-role', AUDITED_CALL_DEADLINE_MS);
  }

  /** Remove a member — every scope role, every login, an open invite — bounded by `caller` (#1150). */
  async removeMember(input: {
    tenantId: TenantId; scopeId: ScopeId; caller: PrincipalId; principal: PrincipalId;
  }): Promise<MemberRemoval> {
    return memberRemoval.parse(await this.postInternal<unknown>('/internal/members/remove', input, 'members-remove', AUDITED_CALL_DEADLINE_MS));
  }

  /**
   * Hand the scope's owner seat from `from` to `to` (#1665) — vertical-host's
   * `/internal/owner-transfer`. A 409 wrote nothing; any other failure is completed by the same
   * call again. Parsed on arrival.
   */
  async transferOwner(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    from: PrincipalId;
    to: PrincipalId;
    abandon?: true;
  }): Promise<OwnerTransferResult> {
    return ownerTransferResult.parse(await this.postInternal<unknown>('/internal/owner-transfer', input, 'owner-transfer', AUDITED_CALL_DEADLINE_MS));
  }

  /**
   * The scope's PENDING platform intents (platform-intents.md) — the platform pulls these because
   * the intent rows live in the vertical's own scope DO, in the vertical's deployment (K-31), not
   * the control plane's. The platform executes each with its own authority, then `settlePlatformRequest`
   * journals the outcome back in the vertical.
   */
  async listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequestEntry[]> {
    const q = new URLSearchParams({ tenantId, scopeId });
    return this.getInternal<PlatformRequestEntry[]>(`/internal/platform-requests?${q}`);
  }

  /**
   * The scope's intent JOURNAL (#618) — every intent whatever became of it, newest first. Same
   * pull, different question: the read above feeds the drain and so returns only `pending`,
   * while a console asking "why did my connector fail?" needs the SETTLED rows, whose
   * `last_error` holds the provider's full answer.
   */
  async listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequestEntry[]> {
    const q = new URLSearchParams({ tenantId, scopeId });
    if (filter?.kind) q.set('kind', filter.kind);
    if (filter?.status) q.set('status', filter.status);
    if (filter?.limit) q.set('limit', String(filter.limit));
    return this.getInternal<PlatformRequestEntry[]>(`/internal/platform-requests/history?${q}`);
  }

  /**
   * Invoke ONE operation in the vertical's deployment as a CONNECTION (#574) — the
   * write-back leg of the platform-run connector pass. The platform already passed the
   * directory gates (live connection, tenant/vertical match); the permission check runs
   * at the far end, in the scope's own DO, against its delivered `connection:<id>`
   * grant. Carries no credential — an operation name and its input, nothing more.
   */
  async connectorInvoke(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    operation: string;
    input?: unknown;
  }): Promise<unknown> {
    const body = await this.postInternal<{ result: unknown }>(
      '/internal/connector-invoke',
      input,
      'connector-invoke',
    );
    return body.result;
  }

  /**
   * Land provider bytes in the vertical's deployment as a CONNECTION (#574) — the bytes
   * leg (a sealed signed PDF cannot ride the JSON invoke). Multipart: `meta` carries the
   * JSON envelope, `body` the blob; fetch stamps the boundary content-type itself.
   *
   * A streamed body (#2498) goes to `/internal/connector-attachment-stream` instead, so it is
   * never held here. A buffer keeps the multipart route, which every deployment has.
   */
  async connectorUploadAttachment(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    entity: EntityRef;
    filename: string;
    contentType: string;
    visibility: Visibility;
    body: ByteBody;
  }): Promise<AttachmentRecord> {
    const { body, ...meta } = input;
    if (isSizedByteStream(body)) return this.connectorStreamAttachment(meta, body);
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('body', new Blob([body as BlobPart], { type: input.contentType }), input.filename);
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach('connector-attachment', () =>
      this.options.fetch(`${base}/internal/connector-attachment`, {
        method: 'POST',
        // No content-type here: fetch sets multipart/form-data with its boundary.
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: form,
      }),
    );
    if (!res.ok) throw await this.refusal('connector-attachment', res);
    return this.parseInternal<AttachmentRecord>('connector-attachment', '/internal/connector-attachment', res);
  }

  /**
   * The bytes leg for a streamed body (#2498): the request body IS the file, sent at its
   * declared length as it is read, and the metadata rides `CONNECTOR_ATTACHMENT_META_HEADER`.
   * Its own route rather than a second shape on the multipart one, so a deployment that
   * predates it answers a route miss, and that becomes a 501 saying to re-push it, rather than
   * an error from a parser that was handed a file.
   */
  private async connectorStreamAttachment(
    meta: Omit<Parameters<VerticalClient['connectorUploadAttachment']>[0], 'body'>,
    body: SizedByteStream,
  ): Promise<AttachmentRecord> {
    const verb = 'connector-attachment-stream';
    const path = '/internal/connector-attachment-stream';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    // The metadata is the only header a caller's strings reach. Its characters are always safe:
    // JSON escapes a control character or a lone surrogate, and URI encoding everything else.
    // Its SIZE is not, since it grows with the filename, so it is held to a named bound here and
    // refused before a byte is sent rather than answered with a server's bare 431. (The
    // multipart route carries the same metadata in its body and has no such bound.) The file's
    // own type rides inside it (the route reads `contentType` from there), so the request's own
    // `content-type` is the plain octet-stream it is.
    const encodedMeta = encodeURIComponent(JSON.stringify({ ...meta, size: body.length }));
    if (encodedMeta.length > CONNECTOR_ATTACHMENT_META_MAX_BYTES) {
      throw new ControlPlaneError(
        400,
        `${verb}: the attachment's metadata is ${encodedMeta.length} bytes once encoded, over the ` +
          `${CONNECTOR_ATTACHMENT_META_MAX_BYTES}-byte bound a streamed upload carries it in a header — ` +
          `shorten the filename. Nothing was sent.`,
      );
    }
    const init = knownLengthInit({
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
        [CONNECTOR_ATTACHMENT_META_HEADER]: encodedMeta,
      },
      body,
    });
    const res = await this.reach(verb, () => this.options.fetch(`${base}${path}`, init as unknown as RequestInit));
    if (!res.ok) {
      const refused = await this.refusal(verb, res);
      if (isRouteMiss(refused)) {
        throw new ControlPlaneError(
          501,
          `the deployment serving scope ${meta.scopeId} predates streamed connector uploads (#2498) — ` +
            `re-push the deployment, then retry. Nothing was stored.`,
        );
      }
      throw refused;
    }
    return this.parseInternal<AttachmentRecord>(verb, path, res);
  }

  /**
   * Fetch ONE attachment's bytes back OUT of the vertical's deployment as a CONNECTION
   * (#711) — the outbound leg. The platform runs the vertical's signing connector and
   * must send the document the VERTICAL rendered; it holds the credential, the vertical
   * holds the bytes.
   *
   * Raw bytes in the body, the record in a header — a contract is megabytes and base64
   * in a JSON envelope would inflate and re-encode it for nothing. `404` is "this scope
   * does not know that id", answered as `null` so a caller falls back to rendering its
   * own document rather than failing a dispatch; a refusal is still a throw.
   */
  async connectorOpenAttachment(input: {
    connectionId: ConnectionId;
    tenantId: TenantId;
    scopeId: ScopeId;
    attachmentId: string;
    /**
     * The delivery this read is for (#726 remedy B). Sent as a NAME, not a claim: the
     * deployment resolves it against its own outbox and admits only the attachments of
     * the entity that row names, so the platform cannot widen its own reach by asking.
     */
    eventId?: string;
  }): Promise<OpenedAttachment | null> {
    const q = new URLSearchParams({
      connectionId: input.connectionId,
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      ...(input.eventId ? { eventId: input.eventId } : {}),
    });
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const path = `/internal/connector-attachment/${encodeURIComponent(input.attachmentId)}`;
    const res = await this.reach('connector-attachment-open', () =>
      this.options.fetch(`${base}${path}?${q}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await this.refusal('connector-attachment-open', res);
    const raw = res.headers.get(CONNECTOR_ATTACHMENT_RECORD_HEADER);
    if (!raw) {
      throw new Error(
        `connector-attachment-open: the vertical answered ${res.status} with no ` +
          `${CONNECTOR_ATTACHMENT_RECORD_HEADER} header — the bytes cannot be trusted without ` +
          `the record that witnesses them (#711)`,
      );
    }
    // Parsed, not cast: the record carries the sha256 the bytes are checked against at
    // the far end, and a shape this side invented would witness nothing.
    const record = attachmentRecord.parse(JSON.parse(raw));
    const body = new Uint8Array(await res.arrayBuffer());
    return {
      record,
      body,
      contentType: res.headers.get('content-type') ?? record.contentType,
    };
  }

  /**
   * Deliver a connection's scope-level grant tuple into the vertical's deployment
   * (#574) — the delivery half of `grantToConnection` for a scope served there.
   * Idempotent at the far end.
   */
  async connectorGrants(input: { tenantId: TenantId; scopeId: ScopeId }): Promise<ProjectedConnectionGrant[]> {
    const value = await this.postInternal<unknown>('/internal/connector-grants', input, 'connector-grants');
    // Parse at the boundary: an old deployment must fail, never look like an empty grant set.
    const parsed = z.array(projectedConnectionGrant).safeParse(value);
    if (!parsed.success) throw new ControlPlaneError(502, 'vertical answered connector-grants with an unexpected shape');
    return parsed.data;
  }

  async connectorGrant(input: {
    connectionId: ConnectionId;
    scopeId: ScopeId;
    permission: PermissionKey;
    expiresAt?: string;
  }): Promise<void> {
    await this.postInternal<unknown>('/internal/connector-grant', input, 'connector-grant');
  }

  /**
   * Deliver one scope's lifecycle to the deployment serving it (#1713). Throws on anything but
   * a parsed answer, a deployment built before the route (404/501) included, so the caller
   * records no receipt and the heal sweep asks again.
   */
  async setLifecycle(input: {
    scopeId: ScopeId;
    lifecycle: ScopeLifecycle;
    /** #2016: the tenant the directory holds the scope under; the deployment refuses a scope
     *  provisioned for another, and records it on a scope that predates its tenant receipt. */
    tenantId?: TenantId;
  }): Promise<LifecycleDelivery> {
    const verb = 'lifecycle';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach(verb, () =>
      this.options.fetch(`${base}/internal/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: JSON.stringify(input),
      }),
    );
    if (res.status === 404) {
      throw new ControlPlaneError(
        501,
        `the deployment serving scope ${input.scopeId} predates the lifecycle delivery (#1713) — redeploy the vertical`,
      );
    }
    if (!res.ok) throw await this.refusal(verb, res);
    const parsed = lifecycleDelivery.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new ControlPlaneError(502, `vertical answered ${verb} for scope ${input.scopeId} with an unexpected shape`);
    }
    return parsed.data;
  }

  /**
   * Move one module's schedule kill switch in the deployment serving the scope (#1666) —
   * the far end of `revokeFromSystem` / `restoreToSystem` for a hosted scope, whose
   * `system:<module>` grants live there and nowhere the platform can reach.
   *
   * ONE shape is normalized to "redeploy the vertical", and only because it is the
   * deployment's own proof that it cannot have acted: a script built before the route
   * answers a **404** (the path does not exist — the route itself answers a module it holds
   * nothing for with a 200 `held: false`, never a 404). "Nothing was switched" is true of exactly
   * that. An HTML 200 is NOT that proof (`routeAnswer`): an old deployment's app shell cannot be
   * told from an error page after a switch that moved.
   *
   * Everything else surfaces as the failure it is, and never claims that: a transport
   * failure (`reach` → 502 "unreachable"), a genuine 5xx from the far end, a 200 whose body
   * is truncated or fails to read (#2010), and a 200 JSON of the wrong shape. The request may
   * have landed and the switch may have moved before the answer was lost, so the only honest
   * instruction is to confirm the position first.
   */
  async systemSwitch(input: {
    scopeId: ScopeId;
    moduleId: ModuleId;
    to: 'on' | 'off';
    /** #1823: the platform holds a live tenant-level grant for the module — see the route's body. */
    tenantHeld?: boolean;
    /** #2045: the switch call's fence — see the route's body. */
    fence?: string;
  }): Promise<SystemSwitchOutcome> {
    const verb = 'system-switch';
    const lost =
      `the switch on scope ${input.scopeId} may or may not have moved. ` +
      `Confirm its position (read the scope's schedule status) before retrying.`;
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${input.scopeId} predates the schedule switch (#1666) — ` +
        `redeploy the vertical, then retry. Nothing was switched.`,
      shape: `vertical answered ${verb} with an unexpected shape — ${lost}`,
    };
    // #2089: a switch call is audited intent-then-outcome, and the settle waits out this deadline.
    return withDeadline(verb, AUDITED_CALL_DEADLINE_MS, (signal) =>
      this.parsedAnswer(verb, rule, systemSwitchOutcome, () =>
        this.options.fetch(`${base}/internal/system-switch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
          body: JSON.stringify(input),
          signal,
        }),
      ),
    );
  }

  /**
   * The switch fence's preflight (#2045, Codex r3): does the deployment serving this scope honour
   * a switch call's fence? Asked before any switch call records or moves anything there.
   *
   * `false` only on the deployment's own proof that it cannot: a **404** (built before the route)
   * or its **501** (a host that predates the fence). Everything else — a transport failure, a
   * refusal, an unreadable or wrong-shaped 200 — throws, so a probe that could not be answered
   * never reads as either verdict, and the switch call fails before it has written anything.
   */
  async switchFence(input: { scopeId: ScopeId }): Promise<boolean> {
    const verb = 'switch-fence';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: true,
      lost: `whether the deployment serving scope ${input.scopeId} honours the switch fence could not be read. Nothing was switched; retry.`,
    };
    // #2089: asked inside a switch call's audited span, so held to the same deadline.
    const answer = await withDeadline(verb, AUDITED_CALL_DEADLINE_MS, (signal) =>
      this.routeAnswer(verb, rule, () =>
        this.options.fetch(`${base}/internal/switch-fence?scopeId=${encodeURIComponent(input.scopeId)}`, {
          method: 'GET',
          headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
          signal,
        }),
      ),
    );
    if (answer === PREDATES) return false;
    if ((answer as { fenced?: unknown } | null)?.fenced === true) return true;
    throw new ControlPlaneError(502, `vertical answered ${verb} with an unexpected shape — ${rule.lost}`);
  }

  /**
   * The read half of the schedule kill switch's status (#1674): every module the
   * deployment serving this scope holds or has held system authority for, and where each
   * stands. Mirrors `systemSwitch`'s seam and its skew rule exactly (`routeAnswer`): a 404
   * is the deployment's own proof it predates this read, and becomes a 501 that says so. A
   * truncated, unreadable or HTML 200 (#2010) and a 200 of the wrong-shaped JSON are NOT that
   * proof — they are a failed read, a 502, rather than a guess at
   * "redeploy". The far end's own 501 (the route exists, the method doesn't) passes through
   * `refusal` verbatim, unchanged either way.
   */
  async systemGrantsStatus(input: { scopeId: ScopeId }): Promise<SystemScheduleEntry[]> {
    const verb = 'system-grants';
    const lost = `the status of scope ${input.scopeId} could not be read. Nothing was changed; retry the read.`;
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${input.scopeId} predates the schedule switch's status read (#1674) — ` +
        `redeploy the vertical, then retry.`,
      shape: `vertical answered ${verb} with an unexpected shape for scope ${input.scopeId}.`,
    };
    return this.parsedAnswer(verb, rule, systemScheduleEntry.array(), () =>
      this.options.fetch(`${base}/internal/system-grants?scopeId=${encodeURIComponent(input.scopeId)}`, {
        method: 'GET',
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
  }

  /**
   * The read half of the peer kill switch's status (#1706): every peer the deployment
   * serving this scope holds or has held grants for, and where each stands. Mirrors
   * `peerSwitch`'s seam and `systemGrantsStatus`'s skew rule exactly — a 404 is the
   * deployment's own proof it predates this read and becomes a 501 that says to redeploy; a
   * truncated, unreadable, HTML or wrong-shaped 200 is not that proof and surfaces as the 502
   * it is.
   */
  async peerGrantsStatus(input: { scopeId: ScopeId }): Promise<PeerGrantsEntry[]> {
    const verb = 'peer-grants';
    const lost = `the peer status of scope ${input.scopeId} could not be read. Nothing was changed; retry the read.`;
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${input.scopeId} predates the peer switch's status read (#1706) — ` +
        `redeploy the vertical, then retry.`,
      shape: `vertical answered ${verb} with an unexpected shape for scope ${input.scopeId}.`,
    };
    return this.parsedAnswer(verb, rule, peerGrantsEntry.array(), () =>
      this.options.fetch(`${base}/internal/peer-grants?scopeId=${encodeURIComponent(input.scopeId)}`, {
        method: 'GET',
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
  }

  /**
   * Move one PEER's kill switch in the deployment serving the scope (#1706) — the far end
   * of `revokeFromPeer` / `restoreToPeer` for a hosted scope, whose `vertical:<slug>` grants
   * live there and nowhere the shared control plane can reach.
   *
   * The seam, the skew rule and the honesty rule are `systemSwitch`'s, for the same reasons:
   * a **404** (no such route) is the deployment's own proof that it
   * predates this route and therefore cannot have switched anything — the route itself
   * answers a peer the scope holds nothing for with a 200 `held: false`, never a 404.
   * Everything else, a truncated or unreadable 200 included (#2010), surfaces as the failure
   * it is, because the request may have landed and the switch may have moved before the
   * answer was lost.
   */
  async peerSwitch(input: {
    scopeId: ScopeId;
    vertical: string;
    to: 'on' | 'off';
    /** #2030: the platform holds a live tenant-level grant for the peer — see the route's body. */
    tenantHeld?: boolean;
    /** #2045: the switch call's fence — see the route's body. */
    fence?: string;
  }): Promise<PeerSwitchOutcome> {
    const verb = 'peer-switch';
    const lost =
      `the switch for peer '${input.vertical}' on scope ${input.scopeId} may or may not have moved. ` +
      `Confirm its position (read the scope's peer status) before retrying.`;
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${input.scopeId} predates the peer kill switch (#1706) — ` +
        `redeploy the vertical, then retry. Nothing was switched.`,
      shape: `vertical answered ${verb} with an unexpected shape — ${lost}`,
    };
    // #2089: a switch call is audited intent-then-outcome, and the settle waits out this deadline.
    return withDeadline(verb, AUDITED_CALL_DEADLINE_MS, (signal) =>
      this.parsedAnswer(verb, rule, peerSwitchOutcome, () =>
        this.options.fetch(`${base}/internal/peer-switch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
          body: JSON.stringify(input),
          signal,
        }),
      ),
    );
  }

  /**
   * A preview's own client at a team auth-server (#1704, `@substrat-run/contracts`'
   * `preview-client.ts`): does the parent sign in at THIS issuer, mint the preview a client
   * here, delete the preview's clients. Addressed to the ISSUER's deployment (this client),
   * never the preview's.
   *
   * The skew rule is `routeAnswer`'s with `legacy501`: a deployment built before these
   * routes answers its `/internal/*` fallback — a JSON **501** on the auth-server — or a
   * **404**. Both are the deployment's own proof it cannot have acted,
   * and become a 501 that says to redeploy the auth server. The caller must never read that
   * as "the parent does not sign in here". A truncated or unreadable 200 (#2010) and a 200 of
   * the wrong shape are not that proof and surface as a 502: a mint or a retire may have run.
   * A refusal (403 another tenant's issuer, 409 a parent it does not claim) passes through
   * verbatim.
   *
   * The mint's answer carries a client SECRET. It is returned to the caller and nothing here
   * keeps, logs or quotes it: no error message on this path includes a response body that
   * could hold one.
   */
  async checkPreviewClient(input: PreviewClientCheck): Promise<PreviewClientClaim> {
    return this.previewClientCall('POST', `${PREVIEW_CLIENT_PATH}/check`, input, previewClientClaim, 'preview-client check', input.scopeId);
  }

  async mintPreviewClient(input: PreviewClientMint): Promise<MintedPreviewClient> {
    return this.previewClientCall('POST', PREVIEW_CLIENT_PATH, input, mintedPreviewClient, 'preview-client mint', input.scopeId);
  }

  async retirePreviewClients(input: PreviewClientRetire): Promise<RetiredPreviewClients> {
    return this.previewClientCall('DELETE', PREVIEW_CLIENT_PATH, input, retiredPreviewClients, 'preview-client retire', input.scopeId);
  }

  private async previewClientCall<T>(
    method: 'POST' | 'DELETE',
    path: string,
    body: unknown,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    verb: string,
    issuerScopeId: ScopeId,
  ): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const rule = {
      legacy501: true,
      lost: `the auth server serving scope ${issuerScopeId} may or may not have acted on it.`,
      predates:
        `the auth server serving scope ${issuerScopeId} predates preview clients (#1704) — redeploy it, ` +
        `then re-run. Nothing was minted or deleted there.`,
      shape: `auth server answered ${verb} with an unexpected shape for scope ${issuerScopeId}.`,
    };
    return this.parsedAnswer(verb, rule, schema, () =>
      this.options.fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Journal a platform-request outcome back in the vertical after the platform ran it. */
  async settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: {
      status: PlatformRequestStatus;
      result?: unknown;
      lastError?: string | null;
      failure?: PlatformRequestFailure | null;
      /**
       * #2102: written into the scope with the settle. A vertical-host too old to know the field
       * drops it and settles the row anyway — the outcome stays readable on the intent.
       */
      event?: PlatformOutcomeEvent | null;
    },
  ): Promise<void> {
    await this.postInternal<unknown>(
      '/internal/platform-requests/settle',
      { tenantId, scopeId, id, ...outcome },
      'settle-platform-request',
    );
  }

  /**
   * Copy one scope's data into a fresh sibling scope DO, inside the vertical's own
   * deployment (§9's data half). The platform names source and destination; the bytes
   * never cross the boundary — the response is a table count, not a dump. The
   * directory half (provenance row, activation, version bind) is the caller's job.
   */
  async snapshotScope(input: {
    sourceScopeId: ScopeId;
    newScopeId: ScopeId;
    /** #2016: the tenant snapshotted for — the source must be its, and the copy records it.
     *  Required (#2035): a load that names no tenant could leave a copy with no tenant record. */
    tenantId: TenantId;
  }): Promise<{ tables: number }> {
    return this.postInternal<{ tables: number }>('/internal/snapshot', input, 'snapshot');
  }

  /**
   * Wipe a reaped fork's storage (§9's reap half). The platform calls this before
   * deleting the directory row — same storage-before-row ordering as the in-process
   * deleteSnapshot, so a crash between the two converges on retry. The fork-only
   * refusal lives with the directory record, on the platform's side.
   */
  async deleteScope(input: { tenantId: TenantId; scopeId: ScopeId }): Promise<void> {
    await this.postInternal<unknown>('/internal/delete-scope', input, 'delete-scope');
  }

  /** Scope-side erasure in this exact script; no key is destroyed by this verb. */
  async redactSubject(scopeId: ScopeId, subjectId: string): Promise<SubjectRedactionCounts> {
    const answer = await this.postInternal<SubjectRedactionCounts>('/internal/redact-subject', { scopeId, subjectId }, 'redact-subject');
    if (!answer || typeof answer.events !== 'number' || typeof answer.intents !== 'number' ||
        typeof answer.jobRuns !== 'number' || !Array.isArray(answer.intentIds) ||
        typeof answer.idempotencyResults !== 'number' || !answer.vertical) {
      throw new ControlPlaneError(502, `script answered redact-subject incompletely for scope ${scopeId}`);
    }
    return answer;
  }

  /**
   * The scope's full dump — the ONE verb here that deliberately moves scope bytes
   * across the boundary, for the governed `scope pull` (§8). The control-plane route
   * in front of it is the gate: staff-only, audited, masked by default, jurisdiction-
   * checked. Everything else on this surface stays byte-free by design.
   */
  async exportScope(scopeId: ScopeId): Promise<ScopeDumpTable[]> {
    return this.getInternal<ScopeDumpTable[]>(
      `/internal/export?scopeId=${encodeURIComponent(scopeId)}`,
    );
  }

  /**
   * `exportScope` with the store's load stamp (#1722), read by the vertical in the same call as
   * the dump and handed over in a header: what a carry's fenced wipe of the copy it leaves
   * expects. Null from a deployment that predates the stamp, which cannot fence a wipe either.
   * A store nothing has stamped is stamped by this read.
   */
  async exportScopeStamped(
    scopeId: ScopeId,
  ): Promise<{ tables: ScopeDumpTable[]; loadStamp: string | null; revision: string | null }> {
    const path = `/internal/export?scopeId=${encodeURIComponent(scopeId)}&stamp=1`;
    const res = await this.getInternalResponse(path);
    const loadStamp = res.headers.get(LOAD_STAMP_HEADER) || null;
    const revision = res.headers.get(WRITE_REVISION_HEADER) || null;
    return { tables: await this.parseInternal<ScopeDumpTable[]>('introspection', path, res), loadStamp, revision };
  }

  /**
   * The write half of `exportScope` — load a dump into one existing scope in this
   * deployment (drop-then-replay), for the governed restore/backout. The control-plane
   * route in front is the gate and the auditor, exactly as with the export.
   *
   * `tenantId` rides along so the vertical can RE-PROJECT its own role definitions
   * after the import (projectRolesLocal): a dump from a CP-full world carries tuples
   * but no role definitions, and without the repair every check denies while /me
   * still names the role. A vertical that predates the field ignores it.
   */
  async restoreScope(
    tenantId: TenantId,
    scopeId: ScopeId,
    /** The dump, or (#2450) the stage it was loaded into here a page at a time (`transferScope`). */
    tables: ScopeDumpTable[] | StagedDump,
    /** #1742: the recorded-off modules, switched off on THIS scope in the restore's own event.
     *  #1869: `sourceScopeId`, the scope the tables were captured from, so the vertical re-points
     *  exactly that scope's grants, and `exact` when the platform exported them itself. A
     *  vertical that predates the fields ignores them. #1722: `loadStamp`, the stamp a carry
     *  leaves on the copy it lands, which a later fenced wipe of that copy expects, and `expect`,
     *  the marker the carry read here (`loadMarker`): the load is refused if the store moved since.
     *  #2005: `markCopy` — the directory's classification of this scope, sent when it is not
     *  primary, so the vertical marks it a copy in its own storage (and refuses a primary one).
     *  A vertical that predates the field ignores it. */
    opts?: {
      switchedOff?: ModuleId[];
      tenantHeld?: ModuleId[];
      /** #2029: the recorded-off peers, and those held only by a tenant grant (#2030). */
      switchedOffPeers?: string[];
      tenantHeldPeers?: string[];
      switchFences?: Record<string, string>;
      sourceScopeId?: ScopeId;
      exact?: boolean;
      loadStamp?: string;
      expect?: LoadMarker;
      markCopy?: ScopeLineage;
      /** #1722: the copy move's lease, carried to the store; a load after `notAfter` is refused. */
      fence?: CopyRestoreFence;
    },
  ): Promise<{ tables: number; switchedOff?: SwitchedOffInUnit[] }> {
    // `exact` vouches for a named source; the vertical refuses it without one, so say so here.
    if (opts?.exact && !opts.sourceScopeId) {
      throw substratError('validation_failed', 'restore: `exact` needs `sourceScopeId`, the scope the dump came from');
    }
    const staged = !Array.isArray(tables);
    const { tables: count, switchedOff } = await this.postInternal<{ tables: number; switchedOff?: unknown }>(
      staged ? '/internal/restore-staged' : '/internal/restore',
      {
        tenantId,
        scopeId,
        ...(staged ? { stageId: tables.stageId } : { tables }),
        ...(opts?.switchedOff ? { switchedOff: opts.switchedOff } : {}),
        ...(opts?.tenantHeld ? { tenantHeld: opts.tenantHeld } : {}),
        ...(opts?.switchedOffPeers ? { switchedOffPeers: opts.switchedOffPeers } : {}),
        ...(opts?.tenantHeldPeers ? { tenantHeldPeers: opts.tenantHeldPeers } : {}),
        ...(opts?.switchFences ? { switchFences: opts.switchFences } : {}),
        ...(opts?.sourceScopeId ? { sourceScopeId: opts.sourceScopeId } : {}),
        ...(opts?.exact ? { exact: true } : {}),
        ...(opts?.loadStamp ? { loadStamp: opts.loadStamp } : {}),
        ...(opts?.expect ? { expect: opts.expect } : {}),
        ...(opts?.markCopy ? { markCopy: opts.markCopy } : {}),
        ...(opts?.fence ? { fence: opts.fence } : {}),
      },
      'restore',
    );
    return { tables: count, ...switchedOffFrom(switchedOff) };
  }

  /**
   * One page of the export (#2450): `exportScopeStamped` a page at a time with `stamp`, and
   * `exportScope` without. `'predates'` from a deployment built before the paged verbs (a 404, or
   * its own 501), which exports whole.
   */
  async exportScopePage(scopeId: ScopeId, cursor: string | null, opts: { stamp?: boolean } = {}): Promise<ScopeDumpPage | 'predates'> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const query =
      `scopeId=${encodeURIComponent(scopeId)}${opts.stamp ? '&stamp=1' : ''}` +
      (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
    const answer = await withDeadline('export-page', PAGE_CALL_DEADLINE_MS, (signal) =>
      this.routeAnswer('export-page', FENCED, () =>
        this.options.fetch(`${base}/internal/export-page?${query}`, {
          headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
          signal,
        }),
      ));
    if (answer === PREDATES) return 'predates';
    const page = scopeDumpPage.safeParse(answer);
    if (!page.success) throw new ControlPlaneError(502, 'export-page: the vertical answered something that is not a dump page');
    return page.data;
  }

  /**
   * Stage one page of a dump into `scopeId` here (#2450), for a `restoreScope` of the stage.
   * `'predates'` from a deployment that restores only whole. A page already staged answers
   * `staged: false`, so a retry is harmless.
   */
  async stageScopePage(
    scopeId: ScopeId,
    stageId: string,
    seq: number,
    tables: ScopeDumpTable[],
  ): Promise<{ staged: boolean } | 'predates'> {
    const answer = await withDeadline('stage', PAGE_CALL_DEADLINE_MS, (signal) =>
      this.routeAnswer('stage', FENCED, () => this.postRaw('/internal/stage', { scopeId, stageId, seq, tables }, signal)));
    if (answer === PREDATES) return 'predates';
    return { staged: (answer as { staged?: unknown } | null)?.staged === true };
  }

  /** Drop a stage a carry gave up on (#2450). Best effort: the next stage replaces it anyway. */
  async discardStagedScope(scopeId: ScopeId, stageId: string): Promise<void> {
    await withDeadline('stage-discard', PAGE_CALL_DEADLINE_MS, (signal) =>
      this.routeAnswer('stage-discard', FENCED, () => this.postRaw('/internal/stage/discard', { scopeId, stageId }, signal)));
  }

  /** A platform-authenticated JSON POST, its response unread, for `routeAnswer`. */
  private postRaw(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    return this.options.fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Wipe the copy a carry left in this deployment (#1722), only if nothing was loaded into the
   * scope since `expectLoadStamp` (null: a store no load has stamped). `wiped: false` is the
   * vertical's refusal: something was restored there since, and it stays.
   *
   * `'unfenced'` is a deployment that cannot compare the stamp, and the only answer that lets
   * the caller fall back to an unconditional wipe: a 404 (built before the route), a 501 (a host
   * without the method) are the deployment's own proof that it wiped nothing (`routeAnswer`).
   * Everything else, a truncated or malformed JSON answer and any HTML page included, surfaces as
   * the failure it is: the wipe may or may not have run.
   */
  async wipeCarriedCopy(input: {
    scopeId: ScopeId;
    expectLoadStamp: string | null;
    /** The write revision read with the stamp; a write since refuses the wipe too. */
    expectRevision?: string | null;
    /** The caller read that the scope does not route here: a copy changed since is kept. */
    protectIfChanged?: boolean;
    carriedTo: string;
    at: string;
    /** #2005: the directory's classification, sent when the scope is not primary, so a copy
     *  made before the marker leaves the wipe marked, tombstoned or kept. */
    markCopy?: ScopeLineage;
  }): Promise<{ wiped: boolean } | 'unfenced'> {
    const verb = 'wipe-carried';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const answer = await this.routeAnswer(verb, FENCED, () =>
      this.options.fetch(`${base}/internal/wipe-carried`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: JSON.stringify(input),
      }),
    );
    if (answer === PREDATES) return 'unfenced';
    const wiped = (answer as { wiped?: unknown } | null)?.wiped;
    if (typeof wiped !== 'boolean') {
      throw new ControlPlaneError(
        502,
        `vertical answered ${verb} with an unexpected shape — the copy of scope ${input.scopeId} may or may not be wiped`,
      );
    }
    return { wiped };
  }

  /**
   * What a carry's restore into this scope expects to find unchanged (#1722): the load stamp and
   * the store's write revision. `'unfenced'` on `wipeCarriedCopy`'s terms: only the
   * deployment's own answer that it predates the route; everything else is a failure.
   */
  async loadMarker(scopeId: ScopeId): Promise<LoadMarker | 'unfenced'> {
    const verb = 'load-marker';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const answer = await this.routeAnswer(verb, FENCED, () =>
      this.options.fetch(`${base}/internal/load-marker?scopeId=${encodeURIComponent(scopeId)}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (answer === PREDATES) return 'unfenced';
    const { loadStamp, revision } = (answer ?? {}) as { loadStamp?: unknown; revision?: unknown };
    const field = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0);
    if (!field(loadStamp) || !field(revision)) {
      throw new ControlPlaneError(502, `vertical answered ${verb} for scope ${scopeId} with an unexpected shape`);
    }
    return { loadStamp: loadStamp as string | null, revision: revision as string | null };
  }

  /**
   * The kept copy of a scope in this deployment (#1722), or null. A deployment built before the
   * fenced wipe cannot have made one, so its "predates" answer reads as null too.
   */
  async keptCopy(scopeId: ScopeId): Promise<KeptCopy | null> {
    const verb = 'kept-copy';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const answer = await this.routeAnswer(verb, FENCED, () =>
      this.options.fetch(`${base}/internal/kept-copy?scopeId=${encodeURIComponent(scopeId)}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (answer === PREDATES) return null;
    const kept = (answer as { kept?: unknown } | null)?.kept;
    if (kept === null) return null;
    const k = kept as Partial<KeptCopy> | undefined;
    if (!k || typeof k.carriedTo !== 'string' || typeof k.keptAt !== 'string' || !(k.revision === null || typeof k.revision === 'string')) {
      throw new ControlPlaneError(502, `vertical answered ${verb} for scope ${scopeId} with an unexpected shape`);
    }
    return {
      carriedTo: k.carriedTo,
      keptAt: k.keptAt,
      revision: k.revision,
      ...(k.leftAgain && typeof k.leftAgain.to === 'string' && typeof k.leftAgain.at === 'string'
        ? { leftAgain: { to: k.leftAgain.to, at: k.leftAgain.at } }
        : {}),
      ...(k.clearedOnly && (k.clearedOnly.revision === null || typeof k.clearedOnly.revision === 'string')
        ? { clearedOnly: { revision: k.clearedOnly.revision } }
        : {}),
    };
  }

  /** Release the marker of a kept copy that is the live store after all (#1722), at the revision read. */
  async releaseKeptCopy(input: {
    scopeId: ScopeId;
    revision: string | null;
    /** #2005: the directory's classification, sent when the scope is not primary. */
    markCopy?: ScopeLineage;
    /** #1722 (Codex #2008 r13): the load stamp read with `revision`. */
    loadStamp?: string | null;
  }): Promise<{ released: true } | { refused: 'changed' | 'not-kept' }> {
    const verb = 'kept-copy-release';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const answer = await this.routeAnswer(verb, FENCED, () =>
      this.options.fetch(`${base}/internal/kept-copy/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: JSON.stringify(input),
      }),
    );
    if (answer === PREDATES) {
      throw new ControlPlaneError(501, `the deployment holding scope ${input.scopeId} keeps no copies (#1722)`);
    }
    const a = answer as { released?: unknown; refused?: unknown } | null;
    if (a?.released === true) return { released: true };
    if (a?.refused === 'changed' || a?.refused === 'not-kept') return { refused: a.refused };
    throw new ControlPlaneError(502, `vertical answered ${verb} with an unexpected shape — the marker may or may not be cleared`);
  }

  /** Discard the kept copy of a scope in this deployment (#1722), at the revision the operator read. */
  async discardKeptCopy(input: {
    scopeId: ScopeId;
    revision: string | null;
    carriedTo: string;
    at: string;
    /** #2005: the directory's classification, sent when the scope is not primary. */
    markCopy?: ScopeLineage;
    /** #1722 (Codex #2008 r13): the load stamp read with `revision`. */
    loadStamp?: string | null;
  }): Promise<{ discarded: true } | { refused: 'changed' | 'not-kept' }> {
    const verb = 'kept-copy-discard';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const answer = await this.routeAnswer(verb, FENCED, () =>
      this.options.fetch(`${base}/internal/kept-copy/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
        body: JSON.stringify(input),
      }),
    );
    if (answer === PREDATES) {
      throw new ControlPlaneError(501, `the deployment holding scope ${input.scopeId} keeps no copies (#1722)`);
    }
    const a = answer as { discarded?: unknown; refused?: unknown } | null;
    if (a?.discarded === true) return { discarded: true };
    if (a?.refused === 'changed' || a?.refused === 'not-kept') return { refused: a.refused };
    throw new ControlPlaneError(502, `vertical answered ${verb} with an unexpected shape — the copy may or may not be discarded`);
  }

  /**
   * The ONE skew rule for a route a deployment may predate (#1722, #2010): `PREDATES` only for a
   * status that says the route is not there — a 404, and a 501 where `rule.legacy501` says the far
   * end's own fallback answers one. No body is that proof. Everything else is a failure, never
   * `PREDATES`, because the request may have landed: a transport failure, a refusal, a body that
   * fails to read, and a body that is not valid JSON — a truncated `{"held":` from a deployment
   * that DID act, or an HTML page (`htmlNote`), which an old deployment's app shell and an error
   * page after a switch that moved both are. Those last ones are a 502 that ends with
   * `rule.lost`, the verb's own sentence for what a lost answer leaves unknown.
   */
  private async routeAnswer(verb: string, rule: RouteRule, request: () => Promise<Response>): Promise<unknown> {
    const res = await this.reach(verb, request);
    if (res.status === 404 || (rule.legacy501 && res.status === 501)) return PREDATES;
    if (!res.ok) throw await this.refusal(verb, res);
    return this.readAnswer(verb, res, rule.lost);
  }

  /**
   * `routeAnswer` for a verb whose "predates" is always a 501 and whose answer has a schema:
   * the parsed answer, or the 501 `rule.predates`, or the 502 `rule.shape` for a wrong shape.
   */
  private async parsedAnswer<T>(
    verb: string,
    rule: RouteRule & { predates: string; shape: string },
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    request: () => Promise<Response>,
  ): Promise<T> {
    const answer = await this.routeAnswer(verb, rule, request);
    if (answer === PREDATES) throw new ControlPlaneError(501, rule.predates);
    const parsed = schema.safeParse(answer);
    if (!parsed.success) throw new ControlPlaneError(502, rule.shape);
    return parsed.data;
  }

  /**
   * A 200's body, read under #2010's rule: the JSON it carries. A body that fails to read, or is
   * not JSON (an HTML page included, `htmlNote`), is a 502 that names `subject` and ends with
   * `lost`, because the deployment that answered may have acted.
   */
  private async readAnswer(subject: string, res: Response, lost: string): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new ControlPlaneError(
        502,
        `reading the vertical's answer to ${subject} failed (${e instanceof Error ? e.message : String(e)}) — ${lost}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ControlPlaneError(502, `vertical answered ${subject} with a body that is not JSON${htmlNote(res)} — ${lost}`);
    }
  }

  /** Mark one scope a copy in the vertical's own storage (#2005), given the directory's
   *  classification of it; whether this call stamped it. */
  async markCopy(scopeId: ScopeId, lineage: ScopeLineage): Promise<{ marked: boolean }> {
    return this.postInternal<{ marked: boolean }>('/internal/mark-copy', { scopeId, lineage }, 'mark-copy');
  }

  /** Remove a mistaken copy marker (#2005), given the directory's classification; whether it did. */
  async clearCopyMark(
    scopeId: ScopeId,
    lineage: ScopeLineage,
    /** #1722 (Codex #2008 r12–r13): clear only the store with this load stamp and revision; 412
     *  otherwise. */
    opts: { expect?: LoadMarker } = {},
  ): Promise<{ cleared: boolean }> {
    return this.postInternal<{ cleared: boolean }>(
      '/internal/clear-copy-mark',
      { scopeId, lineage, ...(opts.expect ? { expect: opts.expect } : {}) },
      'clear-copy-mark',
    );
  }

  /** Facets over one scope's outbox (#1239) — through the vertical that holds the data. */
  async facetEvents(scopeId: ScopeId, input: EventFacetInput): Promise<EventFacetResult> {
    const q = new URLSearchParams({ scopeId });
    if (input.groupBy.kind === 'payload') q.set('field', input.groupBy.field);
    else q.set('groupBy', input.groupBy.kind);
    if (input.type !== undefined) q.set('type', input.type);
    if (input.since !== undefined) q.set('since', input.since);
    if (input.until !== undefined) q.set('until', input.until);
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    return this.getInternal<EventFacetResult>(`/internal/facets?${q.toString()}`);
  }

  /** One event's causal chain (#1237) — the walk, through the vertical that holds the data. */
  async eventCause(scopeId: ScopeId, input: EventCauseInput): Promise<CauseChain> {
    const q = new URLSearchParams({ scopeId, eventId: input.eventId });
    if (input.maxDepth !== undefined) q.set('maxDepth', String(input.maxDepth));
    return this.getInternal<CauseChain>(`/internal/cause?${q.toString()}`);
  }

  /** What one event set off (#1237) — through the vertical that holds the data. */
  async eventEffects(scopeId: ScopeId, input: EventEffectsInput): Promise<EffectsTree> {
    const q = new URLSearchParams({ scopeId, eventId: input.eventId });
    if (input.maxNodes !== undefined) q.set('maxNodes', String(input.maxNodes));
    return this.getInternal<EffectsTree>(`/internal/effects?${q.toString()}`);
  }

  /** Everything one call emitted (#1237) — through the vertical that holds the data. */
  async invocationEvents(scopeId: ScopeId, input: InvocationEventsInput): Promise<InvocationEvents> {
    const q = new URLSearchParams({ scopeId, invocationId: input.invocationId });
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    return this.getInternal<InvocationEvents>(`/internal/invocation?${q.toString()}`);
  }

  /** Every delivery that gave up (#1525) — through the vertical that holds the data. */
  async deadLetters(scopeId: ScopeId, input: DeadLettersInput): Promise<Page<DeadLetter>> {
    const q = new URLSearchParams({ scopeId });
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    if (input.cursor !== undefined) q.set('cursor', input.cursor);
    return this.getInternal<Page<DeadLetter>>(`/internal/dead-letters?${q.toString()}`);
  }

  /** One entity's lifecycle replayed (#1744) — through the vertical that holds the outbox. */
  async lifecycleFlow(scopeId: ScopeId, input: LifecycleFlowInput): Promise<LifecycleFlowResult> {
    return this.postInternal<LifecycleFlowResult>('/internal/lifecycle-flow', { scopeId, ...input }, 'lifecycle-flow');
  }

  /** Business volumes per bucket (#1750) — through the vertical that holds the outbox. */
  async operationSeries(scopeId: ScopeId, input: OperationSeriesInput): Promise<OperationSeriesResult> {
    return this.postInternal<OperationSeriesResult>('/internal/operation-series', { scopeId, ...input }, 'operation-series');
  }

  /** One record's event history (#1235) — `readHistory`'s answer, through the vertical that holds the data. */
  async entityHistory(scopeId: ScopeId, input: EntityHistoryInput): Promise<Page<HistoryEntry>> {
    const q = new URLSearchParams({
      scopeId,
      entityType: input.entityType,
      entityId: input.entityId,
    });
    if (input.limit !== undefined) q.set('limit', String(input.limit));
    if (input.cursor !== undefined) q.set('cursor', input.cursor);
    return this.getInternal<Page<HistoryEntry>>(`/internal/history?${q.toString()}`);
  }

  /**
   * The Tier-2 drain's read (#1334): the oldest not-yet-drained events of a scope this
   * deployment serves. Scope bytes cross, on their way to the lake; the control plane's
   * `readUndrainedEvents` is the audited door this stands behind.
   *
   * Asks for what the read stepped over too (#1636, `withSkipped=1`), and takes either
   * answer: a vertical deployed before that parameter ignores it and sends the bare array,
   * which reads as a read that said nothing about skips — never as one that skipped none.
   */
  async undrainedEvents(scopeId: ScopeId, limit: number): Promise<UndrainedEvents> {
    const answer = await this.getInternal<DrainedEvent[] | UndrainedRead>(
      `/internal/undrained-events?scopeId=${encodeURIComponent(scopeId)}` +
        `&limit=${encodeURIComponent(String(limit))}&withSkipped=1`,
    );
    return Array.isArray(answer) ? answer : undrainedEventsOf(answer);
  }

  /**
   * The Tier-2 drain's stamp (#1334), after the sink confirmed the batch. Answers how
   * many rows changed, which is what lets a retried pass record no egress it did not
   * perform.
   */
  async markEventsDrained(scopeId: ScopeId, eventIds: readonly string[], drainedAt: string): Promise<number> {
    const answer = await this.postInternal<{ drained: number }>(
      '/internal/mark-drained',
      { scopeId, eventIds, drainedAt },
      'mark-drained',
    );
    return answer.drained;
  }

  /**
   * Reopen rows stamped before `drainedBefore` so the drain ships them again (#1334).
   * Answers how many changed, which is what the platform's receipt is written from.
   *
   * `countOnly` (#1545) asks the same window for a number and changes nothing — and it
   * takes a DIFFERENT path rather than riding as a field on this one. The deployment on
   * the far end is the tenant's, deployed on its own clock, so it is routinely older than
   * this client: an unknown field is stripped by the Zod boundary there, and the reopen
   * would run and answer with a number that looks exactly like the count. A path that
   * deployment does not serve answers 404, which throws here, before anything moves.
   */
  async redrainEvents(scopeId: ScopeId, drainedBefore: string, countOnly?: boolean): Promise<number> {
    if (countOnly) {
      const counted = await this.postInternal<{ redrainable?: unknown }>(
        '/internal/redrain-count',
        { scopeId, drainedBefore },
        'redrain-count',
      );
      // A 200 that does not carry the number is a wire-format disagreement, not a zero.
      // Reading it as one would report "nothing to reopen" for a scope nobody counted.
      if (typeof counted.redrainable !== 'number') {
        throw new ControlPlaneError(502, `vertical answered redrain-count without a count for scope ${scopeId}`);
      }
      return counted.redrainable;
    }
    const answer = await this.postInternal<{ redrained: number }>(
      '/internal/redrain-events',
      { scopeId, drainedBefore },
      'redrain-events',
    );
    return answer.redrained;
  }

  /**
   * When one scope's migrations actually ran (#1236) — the schema-change
   * annotation release health reads. Metadata only; no scope bytes cross.
   */
  async appliedMigrations(
    scopeId: ScopeId,
  ): Promise<{
    moduleId: string;
    version: string;
    appliedAt: string | null;
    durationMs: number | null;
    rowsChanged: number | null;
  }[]> {
    const rows = await this.getInternal<{
      moduleId: string;
      version: string;
      appliedAt: string | null;
      durationMs?: number | null;
      rowsChanged?: number | null;
    }[]>(
      `/internal/migrations?scopeId=${encodeURIComponent(scopeId)}`,
    );
    // A deployed vertical may predate the metrics fields. Its older endpoint is
    // still readable, and absence means unrecorded rather than zero.
    return rows.map((row) => ({ ...row, durationMs: row.durationMs ?? null, rowsChanged: row.rowsChanged ?? null }));
  }

  /**
   * One scope's database size in bytes (#1524), for the on-demand storage reading.
   * Metadata only. A 200 without a number is a wire disagreement and throws, because a
   * missing size read as 0 would sit inside a sum and look like a real, small scope.
   */
  async databaseSize(scopeId: ScopeId): Promise<number> {
    const answer = await this.getInternal<{ bytes?: unknown }>(
      `/internal/database-size?scopeId=${encodeURIComponent(scopeId)}`,
    );
    if (typeof answer.bytes !== 'number' || !Number.isInteger(answer.bytes) || answer.bytes < 0) {
      throw new ControlPlaneError(502, `vertical answered database-size without a size for scope ${scopeId}`);
    }
    return answer.bytes;
  }

  /**
   * What one scope's attachment rows sum to, in bytes (#2501), for the storage gauge. A deployment
   * built before the route answers 501, or 404 with no route at all; both throw here, and the
   * caller decides that is a deployment to redeploy, never a size of 0.
   */
  async attachmentSize(scopeId: ScopeId): Promise<number> {
    const answer = await this.getInternal<{ bytes?: unknown }>(
      `/internal/attachment-size?scopeId=${encodeURIComponent(scopeId)}`,
    );
    if (typeof answer.bytes !== 'number' || !Number.isInteger(answer.bytes) || answer.bytes < 0) {
      throw new ControlPlaneError(502, `vertical answered attachment-size without a size for scope ${scopeId}`);
    }
    return answer.bytes;
  }

  /**
   * One orphan-attachment pass over a scope this deployment serves (#2314). The caller is the
   * platform's sweep, and only after it read the directory and the whole copy ledger itself and
   * found nothing unsettled: `copiesSettled: true` is that word, never a person's. The deployment
   * judges age and the restore fence by its own clock. A 200 whose report does not parse is a wire
   * disagreement and throws, so a garbled answer is never counted as a clean pass.
   */
  async sweepOrphanAttachments(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    dryRun: boolean;
    copiesSettled: true;
    /** The version the scope runs, by the directory: the deployment refuses the pass if it is not it. */
    expectedVersionId: string;
    limit?: number;
  }): Promise<OrphanSweepReport> {
    const answer = await this.postInternal<unknown>('/internal/attachment-sweep', input, 'attachment-sweep');
    const parsed = orphanSweepReportWire.safeParse(answer);
    if (!parsed.success) {
      throw new ControlPlaneError(502, `vertical answered attachment-sweep without a report for scope ${input.scopeId}`);
    }
    const { fencedUntil, bucket, consumeFailed, ...rest } = parsed.data;
    return {
      ...rest,
      ...(fencedUntil !== undefined ? { fencedUntil } : {}),
      ...(bucket !== undefined ? { bucket } : {}),
      ...(consumeFailed ? { consumeFailed } : {}),
    };
  }

  /**
   * The PITR bookmarks one scope recorded before its migration passes (#286) —
   * the rewind points the deployments UI offers for a backout. Metadata only;
   * no scope bytes cross the boundary.
   */
  async migrationBookmarks(
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]> {
    return this.getInternal<{ bookmark: string; takenAt: string; pending: string[] }[]>(
      `/internal/bookmarks?scopeId=${encodeURIComponent(scopeId)}`,
    );
  }

  /**
   * Rewind one scope to a pre-migration bookmark (#286's backout): schema AND data,
   * discarding every write since the bookmark. The scope DO enforces the freshness
   * window (24h without `force`) and restarts itself to complete the restore; the
   * control-plane route in front is the gate and the auditor.
   */
  async rewindScope(
    scopeId: ScopeId,
    bookmark: string,
    /** `tenantId` (#2314): the vertical fences the orphan sweep in that tenant's bucket first. */
    opts?: { force?: boolean; tenantId?: TenantId },
  ): Promise<{ rewindingTo: string }> {
    return this.postInternal<{ rewindingTo: string }>(
      '/internal/rewind',
      { scopeId, bookmark, force: opts?.force ?? false, ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}) },
      'rewind',
    );
  }

  /**
   * A dispatch/transport REJECTION (the fetch itself threw — a cold-starting script, a
   * DO reset, a missing dispatch entry) is not a vertical's answer, but before #391 it
   * propagated raw and the API boundary collapsed it to the generic 500 "internal
   * error". Wrap it as a 502 carrying the runtime's own message, so the operator reads
   * "unreachable during configure: <why>" — and callers can treat 502 as the transient
   * it usually is (the dashboard's provision step 3 retries exactly this).
   */
  private async reach(verb: string, request: () => Promise<Response>): Promise<Response> {
    try {
      return await request();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new ControlPlaneError(502, `vertical unreachable during ${verb}: ${detail}`);
    }
  }

  /**
   * The vertical's refusal, VERBATIM. A non-2xx body is the diagnosis — the vertical
   * says exactly what is wrong ("no tenant store attached for <t> — provision first") —
   * so it must survive to the operator whatever its shape: our own verticals answer
   * `{error}`, but a foreign one (or a runtime error page) answers plain text, which the
   * old `res.json().catch(() => null)` silently dropped, leaving only "503 Service
   * Unavailable" (#424 case 1). Read the body once as text: a JSON `{error}` passes
   * through bare (the vertical authored a complete message — the existing contract);
   * any other non-empty body rides prefixed with the verb; only an EMPTY body falls
   * back to the status line.
   */
  private async refusal(verb: string, res: Response): Promise<ControlPlaneError> {
    // `undefined` when the body could not be read, which is not the same fact as an empty one.
    const text = await res.text().catch(() => undefined);
    // The raw body rides along (#1524), so a caller can tell the vertical's own JSON error
    // envelope from a router's plain-text miss even where the two share a status.
    const raw = { body: text, statusText: res.statusText };
    try {
      const parsed = JSON.parse(text ?? '') as { error?: unknown };
      if (typeof parsed?.error === 'string' && parsed.error !== '') {
        return new ControlPlaneError(res.status, parsed.error, undefined, raw);
      }
    } catch {
      // not JSON — fall through to the raw text
    }
    const detail = (text ?? '').trim().slice(0, 500);
    return new ControlPlaneError(
      res.status,
      detail !== ''
        ? `vertical refused ${verb} (${res.status}): ${detail}`
        : `vertical refused ${verb}: ${res.status} ${res.statusText}`,
      undefined,
      raw,
    );
  }

  /**
   * A 200 that is not JSON is a 502 that names the verb, instead of an unhandled SyntaxError →
   * 500 (#389: a pre-#236 script has no `/internal/export`, and its SPA fallback answered the app
   * shell). That shell cannot be told from an error page in between (`htmlNote`), and a truncated
   * answer from a deployment that has the route may follow a write that ran (#2010), so the
   * message says the call may or may not have acted, and names redeploying only as the remedy
   * for the case it cannot prove.
   */
  private async parseInternal<T>(verb: string, path: string, res: Response): Promise<T> {
    return (await this.readAnswer(
      `${verb} (${path})`,
      res,
      'it may or may not have acted. If this deployment answers its app for /internal/*, it predates ' +
        'this surface: redeploy the vertical (or, for a rebind, use abandonData).',
    )) as T;
  }

  /** A platform-authenticated POST to the vertical's `/internal/*` surface. */
  /**
   * Invoke ONE operation on this deployment as a PEER vertical (#1706) — the far end of an
   * asynchronous peer call, whose caller the platform took from the scope it drained the
   * intent from. The door at the other end admits it (declared peer, switch on, operation
   * allowlisted) and every check inside runs as `{ vertical, scope }`.
   */
  async verticalInvoke(input: {
    caller: VerticalCaller;
    tenantId: TenantId;
    scopeId: ScopeId;
    operation: string;
    input?: unknown;
    idempotencyKey?: string;
  }): Promise<unknown> {
    const { result } = await this.postInternal<{ result: unknown }>(
      '/internal/vertical-invoke',
      {
        caller: input.caller,
        tenantId: input.tenantId,
        scopeId: input.scopeId,
        operation: input.operation,
        ...(input.input === undefined ? {} : { input: input.input }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      },
      'peer call',
    );
    return result;
  }

  /**
   * The producer half of a cross-vertical edge (#1705 PR 2): what the deployment serving
   * `scopeId` releases to `input.consumer` after its watermark, decided by its own exports.
   *
   * The skew rule is `systemSwitch`'s, and here it is the whole point: an EMPTY batch is a
   * real answer (nothing new), so a deployment that cannot answer must never produce one. A
   * 404 (the route does not exist) is that deployment's own proof (`routeAnswer`), and becomes a
   * 501 saying to redeploy.
   * The far end's own 501 (the route exists, the host method does not) passes through
   * verbatim. A truncated or unreadable 200 (#2010) and a JSON 200 of the wrong shape are a
   * 502, never a guess.
   */
  async exportedEvents(input: { tenantId: TenantId; scopeId: ScopeId; input: ExportReadInput }): Promise<ExportedBatch> {
    return this.crossVerticalCall('exported-events', '/internal/exported-events', input.scopeId, exportedBatch, input);
  }

  /**
   * The consumer half's first read (#1705 PR 2): the imports the deployment serving `scopeId`
   * runs, and its watermark per producer. Same skew rule: a deployment that predates the route
   * is told to redeploy, and never reads as "imports nothing" or "has read nothing", either of
   * which a pass would act on.
   */
  async importState(input: { tenantId: TenantId; scopeId: ScopeId }): Promise<ImportState> {
    const q = new URLSearchParams({ tenantId: input.tenantId, scopeId: input.scopeId });
    return this.crossVerticalCall('import-state', `/internal/import-state?${q}`, input.scopeId, importState);
  }

  /**
   * Hand a batch to the deployment serving the consumer scope (#1705 PR 2), which applies it
   * under its watermark's compare-and-set. A lost answer is safe to repeat: a batch applied
   * twice meets its own journal rows and runs nothing twice, and a stale one is refused.
   */
  async importEvents(input: { tenantId: TenantId; scopeId: ScopeId; batch: ImportBatch }): Promise<ImportResult> {
    return this.crossVerticalCall('import-events', '/internal/import-events', input.scopeId, importResult, input);
  }

  /**
   * The replay lever's far end (#1705 PR 3): move the watermark of the consumer scope this
   * deployment serves. The same skew rule, plus the write's one difference: a JSON 200 of the
   * wrong shape, or one truncated or unreadable (#2010), may follow a move that happened, so the
   * 502 says to read the edge before pulling the lever again. A 404 proves the route is absent, so nothing moved.
   */
  async importCursorMove(input: { tenantId: TenantId; scopeId: ScopeId; at: ImportCursorMoveAt }): Promise<ImportCursorMoved> {
    return this.crossVerticalCall('import-cursor', '/internal/import-cursor', input.scopeId, importCursorMoved, input, {
      write: true,
    });
  }

  /**
   * The three cross-vertical verbs' one transport and skew rule (see `exportedEvents`): a POST
   * of `body` when there is one, a GET otherwise.
   */
  private async crossVerticalCall<T>(
    verb: string,
    path: string,
    scopeId: ScopeId,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    body?: unknown,
    opts: { write?: boolean } = {},
  ): Promise<T> {
    const lost = opts.write
      ? 'the write may have taken effect: read the edge before retrying.'
      : 'it may or may not have acted; repeating it is safe.';
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const secret = { [PLATFORM_SECRET_HEADER]: this.options.platformSecret };
    const rule = {
      legacy501: false,
      lost,
      predates:
        `the deployment serving scope ${scopeId} predates cross-vertical events (#1705) — redeploy the vertical. ` +
        `Nothing was read or delivered; the edge's watermark holds.`,
      shape: `vertical answered ${verb} with an unexpected shape for scope ${scopeId}` + (opts.write ? ` — ${lost}` : '.'),
    };
    return this.parsedAnswer(verb, rule, schema, () =>
      this.options.fetch(
        `${base}${path}`,
        body === undefined
          ? { method: 'GET', headers: secret }
          : { method: 'POST', headers: { ...secret, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      ),
    );
  }

  /** `deadlineMs` bounds the call (#2064): past it the request is aborted and answered 504. */
  private async postInternal<T>(path: string, body: unknown, verb: string, deadlineMs?: number): Promise<T> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    // The request and the reading of its answer are ONE exchange, so a deadline bounds both.
    const exchange = async (signal?: AbortSignal): Promise<T> => {
      const res = await this.reach(verb, () =>
        this.options.fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        }),
      );
      if (!res.ok) throw await this.refusal(verb, res);
      return this.parseInternal<T>(verb, path, res);
    };
    return deadlineMs === undefined ? exchange() : withDeadline(verb, deadlineMs, exchange);
  }

  /** A platform-authenticated GET to the vertical's `/internal/*` surface. */
  private async getInternal<T>(path: string): Promise<T> {
    return this.parseInternal<T>('introspection', path, await this.getInternalResponse(path));
  }

  /** `getInternal`'s request, answering the response itself, for a caller that reads a header too. */
  private async getInternalResponse(path: string): Promise<Response> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.reach('introspection', () =>
      this.options.fetch(`${base}${path}`, {
        headers: { [PLATFORM_SECRET_HEADER]: this.options.platformSecret },
      }),
    );
    if (!res.ok) throw await this.refusal('introspection', res);
    return res;
  }
}

/** #2450: a dump loaded into a destination's stage a page at a time, named instead of carried. */
export type StagedDump = { readonly stageId: string };

/** What `transferScope` moved, and what the export read: as `exportScopeStamped` answers it. */
export interface TransferredScope {
  /** The whole dump, or the stage it is waiting in at the destination (`restoreScope` takes both). */
  dump: ScopeDumpTable[] | StagedDump;
  loadStamp: string | null;
  revision: string | null;
  /** The dump's `_substrat_meta` rows, for `dumpMetaValue`: the one table read beside the move. */
  meta: ScopeDumpTable[];
}

/** How many times a copy is restarted because the source took a write while it was read (#2450). */
export const TRANSFER_ATTEMPTS = 3;

/**
 * A paged copy in flight (#2450): everything needed to resume it from another request or from a
 * background job, and nothing that is the scope's data. JSON, so a job can store it.
 *
 * `cursor` is the source's next page, `null` once every page is staged. `seq` is the last page the
 * destination staged under `stageId`. `revision` is the source's write revision as the first page
 * read it: the copy is one copy only while every later page reads the same.
 */
export interface TransferState {
  from: ScopeId;
  into: ScopeId;
  stamp: boolean;
  stageId: string;
  seq: number;
  cursor: string | null;
  revision: string | null;
  loadStamp: string | null;
  attempt: number;
  pages: number;
  rows: number;
  /** The `_substrat_meta` rows read so far, for `dumpMetaValue` once the copy is done. */
  meta: ScopeDumpTable[];
}

/** A copy finished (`done`), or one still to move (`state`). */
export type TransferProgress = { done: TransferredScope } | { state: TransferState };

/** The two ends a copy reads and writes, as `transferScope` and the job use them. */
export type TransferEnds = {
  source: Pick<VerticalClient, 'exportScope' | 'exportScopeStamped' | 'exportScopePage'>;
  dest: Pick<VerticalClient, 'stageScopePage' | 'discardStagedScope'>;
};

export interface TransferOptions {
  retry?: <T>(run: () => Promise<T>) => Promise<T>;
  attempts?: number;
  /** A carry's export: the source mints its load stamp (`exportScopeStamped`). A fork's is not. */
  stamp?: boolean;
  /**
   * Stage even a scope that fits one page (#2450). A copy that a job finishes in another isolate
   * must leave its data at the destination, never in this one's memory.
   */
  alwaysStage?: boolean;
}

/**
 * Move a scope's data out of `source` and into `dest`'s stage, a page at a time (#2450), so no
 * single call carries the whole scope: a Durable Object RPC message holds 32 MiB, and an isolate
 * 128 MB. Nothing here holds more than one page, and the destination commits from its stage in
 * `restoreScope`, in the one transaction a whole restore runs.
 *
 * A scope that fits in one page, or a source that predates the paged verbs, moves whole, exactly as
 * before. A destination that predates them gets the pages merged into one dump, which is the old
 * ceiling, and only there.
 *
 * Each page is read in one turn of the source, so it is consistent on its own; the pages are one
 * consistent read only while the source's write revision stays where the first page read it. When
 * it moves the copy starts again, up to `TRANSFER_ATTEMPTS` times, and is then refused (409) with
 * nothing moved: a carry's later fences assume a copy that was true at one moment.
 *
 * `beginTransfer` and `transferStep` are the same copy in resumable steps, for one that outlasts a
 * request; this runs them to the end.
 */
export async function transferScope(
  source: TransferEnds['source'],
  dest: TransferEnds['dest'],
  /** The scope read at `source`, and (a fork, #2450) the scope `dest` stages into, when another. */
  scope: { from: ScopeId; to?: ScopeId },
  opts: TransferOptions = {},
): Promise<TransferredScope> {
  let progress = await beginTransfer({ source, dest }, scope, opts);
  while ('state' in progress) progress = await transferStep({ source, dest }, progress.state, opts);
  return progress.done;
}

/**
 * Start a copy (#2450): read the source's first page and stage it. Finished at once when the scope
 * fits that page (unless `alwaysStage`), when the source predates the paged verbs, or when the
 * destination does (its pages are then merged here, as the whole dump it takes).
 */
export async function beginTransfer(
  { source, dest }: TransferEnds,
  scope: { from: ScopeId; to?: ScopeId },
  opts: TransferOptions & { attempt?: number } = {},
): Promise<TransferProgress> {
  const retry = opts.retry ?? (<T>(run: () => Promise<T>) => run());
  const stamp = opts.stamp ?? true;
  const from = scope.from;
  const into = scope.to ?? scope.from;
  // A client without the paged verbs (one a caller assembled from part of this one) is read as a
  // deployment that predates them.
  const first = typeof source.exportScopePage === 'function'
    ? await retry(() => source.exportScopePage(from, null, { stamp }))
    : ('predates' as const);
  if (first === 'predates') {
    if (!stamp) {
      const tables = await retry(() => source.exportScope(from));
      return { done: { dump: tables, loadStamp: null, revision: null, meta: metaOf([tables]) } };
    }
    const whole = await retry(() => source.exportScopeStamped(from));
    return { done: { dump: whole.tables, loadStamp: whole.loadStamp, revision: whole.revision, meta: metaOf([whole.tables]) } };
  }
  if (first.next === null && !opts.alwaysStage) {
    return { done: { dump: first.tables, loadStamp: first.loadStamp, revision: first.revision, meta: metaOf([first.tables]) } };
  }
  const stageId = ulid();
  const opened = typeof dest.stageScopePage === 'function'
    ? await retry(() => dest.stageScopePage(into, stageId, 0, first.tables))
    : ('predates' as const);
  const state: TransferState = {
    from, into, stamp, stageId, seq: 0, cursor: first.next,
    revision: first.revision, loadStamp: first.loadStamp,
    attempt: opts.attempt ?? 1, pages: 1, rows: rowsIn(first.tables), meta: metaOf([first.tables]),
  };
  if (opened !== 'predates') return state.cursor === null ? { done: doneOf(state) } : { state };
  // A destination that cannot stage takes the dump whole, so the pages are held here instead.
  const held: ScopeDumpTable[][] = [first.tables];
  for (let cursor = first.next; cursor !== null;) {
    const at: string = cursor;
    const page = await retry(() => source.exportScopePage(from, at, { stamp }));
    if (page === 'predates') throw stoppedPaging(from);
    if (page.revision !== first.revision) return restart({ source, dest }, state, opts, false);
    held.push(page.tables);
    cursor = page.next;
  }
  return { done: { dump: mergeDumpPages(held), loadStamp: first.loadStamp, revision: first.revision, meta: metaOf(held) } };
}

/**
 * Move the next pages of a copy (#2450), until it is staged whole or `until` says to stop (a job's
 * time budget); always at least one page. A source written since the first page starts the copy
 * again under a new stage, the old one discarded.
 *
 * `stopped` (a job being cancelled or forgotten): the copy starts nothing new. A torn copy then
 * discards its stage and answers where it was, opening no other: whoever stopped it settles it.
 */
export async function transferStep(
  { source, dest }: TransferEnds,
  state: TransferState,
  opts: TransferOptions & { until?: () => boolean; stopped?: () => boolean } = {},
): Promise<TransferProgress> {
  const retry = opts.retry ?? (<T>(run: () => Promise<T>) => run());
  let next: TransferState = state;
  while (next.cursor !== null) {
    const at: string = next.cursor;
    const page = await retry(() => source.exportScopePage(next.from, at, { stamp: next.stamp }));
    if (page === 'predates') throw stoppedPaging(next.from);
    if (page.revision !== next.revision) return restart({ source, dest }, next, opts, true);
    const seq = next.seq + 1;
    const staged = await retry(() => dest.stageScopePage(next.into, next.stageId, seq, page.tables));
    if (staged === 'predates') {
      throw new ControlPlaneError(502, `the destination of scope ${next.into} stopped staging part way; nothing was moved`);
    }
    next = {
      ...next,
      seq,
      cursor: page.next,
      pages: next.pages + 1,
      rows: next.rows + rowsIn(page.tables),
      meta: mergeDumpPages([next.meta, metaOf([page.tables])]),
    };
    if (next.cursor !== null && opts.until?.()) return { state: next };
  }
  return { done: doneOf(next) };
}

/** A torn copy: discard its stage and begin again, or refuse once the attempts are spent. */
async function restart(
  ends: TransferEnds, state: TransferState, opts: TransferOptions & { stopped?: () => boolean }, staged: boolean,
): Promise<TransferProgress> {
  // Best effort: a stage nothing commits is replaced by the next one, and goes with a wipe.
  if (staged) await ends.dest.discardStagedScope(state.into, state.stageId).catch(() => undefined);
  // Stopped: a new stage would outlast whoever stopped this copy, so none is opened.
  if (opts.stopped?.()) return { state };
  const attempts = opts.attempts ?? TRANSFER_ATTEMPTS;
  if (state.attempt >= attempts) {
    throw new ControlPlaneError(
      409,
      `scope ${state.from} took writes while each of ${attempts} attempts was copying it, so no copy was true at ` +
        'one moment and nothing was moved (#2450). Retry when it is quieter.',
    );
  }
  return beginTransfer(ends, { from: state.from, to: state.into }, { ...opts, stamp: state.stamp, attempt: state.attempt + 1 });
}

const doneOf = (state: TransferState): TransferredScope =>
  ({ dump: { stageId: state.stageId }, loadStamp: state.loadStamp, revision: state.revision, meta: state.meta });

const rowsIn = (tables: readonly ScopeDumpTable[]): number => tables.reduce((n, t) => n + t.rows.length, 0);

const stoppedPaging = (scopeId: ScopeId) =>
  new ControlPlaneError(502, `the source of scope ${scopeId} stopped answering dump pages part way; nothing was moved`);

/** The `_substrat_meta` fragments of some dump pages, merged. */
const metaOf = (pages: readonly (readonly ScopeDumpTable[])[]): ScopeDumpTable[] =>
  mergeDumpPages(pages.map((page) => page.filter((t) => t.name === '_substrat_meta')));
