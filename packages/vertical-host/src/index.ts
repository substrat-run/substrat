/**
 * The platform's `/internal/*` surface, authored ONCE.
 *
 * Every sandbox-clean vertical (Meridian, Manyfold, Callout, and every pushed install) has to
 * answer the same control-plane contract: provision a scope, reconcile a locked-out one,
 * introspect its tables, run the read-only SQL console, drain platform-requests, snapshot
 * / delete / export / restore / bookmark / rewind its storage, upsert its per-instance
 * config. Before this package each vertical HAND-COPIED those ~14 routes plus a Hono
 * `onError` into its own `worker.ts`, and the copies drifted: route sets disagreed
 * (12 / 13 / 14) and two of four workers shipped WITHOUT the error handler — so a thrown
 * `/internal/restore` surfaced as the Workers runtime's bare `Internal Server Error`
 * instead of a readable `{ error }` the control plane could relay (issue #510).
 *
 * `mountPlatformSurface` mounts the whole contract — and the error envelope — in one call.
 * The generic routes are pure host delegations owned entirely here; the three flavored
 * ones (provision / reconcile / configure) keep their gate, parse, and response envelope
 * here and take only a vertical-supplied hook. A vertical that forgets to mount it has no
 * `/internal/provision` and fails to provision loudly (first deploy, scenario test) — so
 * the surface is self-enforcing, not convention.
 *
 * The scope host is taken STRUCTURALLY (`VerticalScopeHost`), so this package depends on
 * neither `adapter-cloudflare` nor any concrete host — no dependency cycle, and a future
 * adapter satisfies the same interface.
 */
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { classifyError, messageOf, problemOf } from './errors.js';
import {
  type CarriedAway,
  type LoadMarker,
  type InvokeOptions,
  type AppliedMigration,
  type SwitchedOff,
  type UndrainedEvents,
} from '@substrat-run/kernel';
import { assertPlatformCall, PlatformCallError } from './platform-call.js';
import {
  z,
  PROBLEM_CONTENT_TYPE,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
  principalId as principalIdOf,
  connectionId as connectionIdOf,
  permissionKey as permissionKeyOf,
  moduleId as moduleIdOf,
  switchedOffInUnit,
  entityRef,
  visibility,
  instant,
  entitlementGrant,
  projectedConnectionGrant,
  projectedConnectionKey,
  projectedIdentityLink,
  ownerSeat,
  ownerClaimLink,
  ownerTransferPair,
  distinctOwnerTransfer,
  ownerTransferRecord,
  ownerTransferAbandon,
  platformRequestFilter,
  denialFilter,
  capabilityFilterQuery,
  type CapabilityFilter,
  type CapabilityPage,
  type DenialFilter,
  type DenialSummary,
  type PermissionDenial,
  platformRequestId,
  platformRequestStatus,
  platformRequestFailure,
  readScopeTableInput,
  entityHistoryInput,
  eventFacetInput,
  eventCauseInput,
  eventEffectsInput,
  invocationEventsInput,
  deadLettersInput,
  lifecycleFlowInput,
  type EntityHistoryInput,
  type EventFacetInput,
  type EventCauseInput,
  type EventEffectsInput,
  type EffectsTree,
  type InvocationEventsInput,
  type InvocationEvents,
  type DeadLettersInput,
  type DeadLetter,
  type LifecycleFlowInput,
  type LifecycleFlowResult,
  type CauseChain,
  type EventFacetResult,
  type HistoryEntry,
  type Page,
  queryScopeInput,
  type ScopeId,
  type TenantId,
  type PrincipalId,
  type ConnectionId,
  type PermissionKey,
  type EntityRef,
  type Visibility,
  type RoleDefinition,
  type ScopeDumpTable,
  type ScopeTable,
  type ScopeQueryResult,
  type EntitlementGrant,
  type ProjectedConnectionGrant,
  type ProjectedConnectionKey,
  type ProjectedIdentityLink,
  type OwnerClaimLink,
  type OwnerTransferRecord,
  type OwnerTransferResult,
  type PlatformRequest,
  type PlatformRequestFilter,
  type PlatformRequestId,
  type PlatformRequestStatus,
  type PlatformRequestFailure,
  type ModuleId,
  type SystemSwitchOutcome,
  type PeerGrantsEntry,
  type SystemScheduleEntry,
  verticalCaller,
  verticalSlug as verticalSlugOf,
  type PeerSwitchOutcome,
  type VerticalCaller,
  exportReadInput,
  importBatch,
  importCursorMoveAt,
  type ImportCursorMoveAt,
  type ImportCursorMoved,
  type ExportReadInput,
  type ExportedBatch,
  type ImportBatch,
  type ImportResult,
  type ImportState,
  CONNECTOR_ATTACHMENT_RECORD_HEADER,
  LOAD_STAMP_HEADER,
} from '@substrat-run/contracts';

/**
 * The slice of the scope host the platform surface delegates to. Structural on purpose:
 * this package names behaviour, never the concrete `CloudflareScopeHost`. Every method
 * here is one the sandbox-clean host already exports (the `…Local` CP-less halves plus
 * the introspection + platform-request reads).
 */
export interface VerticalScopeHost {
  provisionScopeLocal(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    owner: PrincipalId;
    roles: RoleDefinition[];
    ownerRoleKey: string;
    entitlements?: EntitlementGrant[];
    identityLinks?: ProjectedIdentityLink[];
    connectionGrants?: ProjectedConnectionGrant[];
    connectionKeys?: ProjectedConnectionKey[];
    /**
     * #1742: the modules the platform's record holds switched OFF on this scope, switched off
     * again inside the provision's own unit, after the seat. A host built before it ignores the
     * field and answers `void`, and the platform's re-assert after the call covers it.
     */
    switchedOff?: ModuleId[];
  }): Promise<void | { switchedOff?: SwitchedOff[] }>;
  /** `opts.switchedOff` (#1742): as on `provisionScopeLocal`, applied in the restore's own event.
   *  `opts.sourceScopeId` (#1869): the scope the dump was captured from, whose grants move, and
   *  `opts.exact`: the platform exported the dump itself, so the re-point never falls back. */
  restoreScopeLocal(
    scopeId: ScopeId,
    tables: ScopeDumpTable[],
    /** #1722: `opts.loadStamp`, the stamp a carry leaves on the copy it lands, and `opts.expect`,
     *  the marker the carry read: the load is refused if the store moved since. A host built
     *  before them has no `loadMarkerLocal` either, so the platform never sends `expect` there. */
    opts?: { switchedOff?: ModuleId[]; sourceScopeId?: ScopeId; exact?: boolean; loadStamp?: string; expect?: LoadMarker },
  ): Promise<{ tables: number; switchedOff?: SwitchedOff[] }>;
  /**
   * #1722: wipe the copy a carry left in this deployment, only if nothing was loaded into the
   * scope since the stamp the carry read. Optional, like `redrainCountLocal`: a host built
   * before it satisfies this interface without it, and the route answers 501, which the
   * platform reads as "this script cannot fence the wipe" and falls back to an unconditional one.
   */
  /** #1722: what a carry's restore into this store expects to find unchanged. Optional, like
   *  `wipeCarriedLocal`; the route answers 501 without it, and the platform then cannot fence. */
  loadMarkerLocal?(scopeId: ScopeId): Promise<LoadMarker>;
  wipeCarriedLocal?(scopeId: ScopeId, expectLoadStamp: string | null, carriedAway: CarriedAway): Promise<boolean>;
  projectRolesLocal(tenantId: TenantId, scopeId: ScopeId, roles: RoleDefinition[]): Promise<void>;
  exportScopeLocal(scopeId: ScopeId): Promise<ScopeDumpTable[]>;
  /** #1722: the export and the store's load stamp, read together. Optional: a host built before
   *  it answers the export alone, and the platform then has no stamp to fence a wipe on. */
  exportScopeStampedLocal?(scopeId: ScopeId): Promise<{ tables: ScopeDumpTable[]; loadStamp: string }>;
  snapshotScopeLocal(source: ScopeId, dest: ScopeId): Promise<{ tables: number }>;
  deleteScopeLocal(scopeId: ScopeId): Promise<void>;
  migrationBookmarksLocal(
    scopeId: ScopeId,
  ): Promise<{ bookmark: string; takenAt: string; pending: string[] }[]>;
  appliedMigrationsLocal(
    scopeId: ScopeId,
  ): Promise<AppliedMigration[]>;
  /**
   * The Tier-2 drain's far end (#1334): the oldest not-yet-drained events of a scope
   * this deployment holds, and the stamp once the platform's sink confirmed them.
   * Two verbs on purpose — the platform reads, ships, and only then stamps — and the
   * instant is the platform's, carried through, so its admin receipt and the rows agree.
   * The read's optional `skipped` says what it stepped over because it would not decode
   * (#1636).
   */
  undrainedEventsLocal(scopeId: ScopeId, limit: number): Promise<UndrainedEvents>;
  markEventsDrainedLocal(scopeId: ScopeId, eventIds: readonly string[], drainedAt: string): Promise<number>;
  /** Reopen rows stamped before an instant so they ship again (#1334) — the stamp's inverse. */
  redrainEventsLocal(scopeId: ScopeId, drainedBefore: string): Promise<number>;
  /**
   * How many rows that reopen would touch, reopening none (#1545) — the read-only half a
   * dry run asks for. OPTIONAL, because a host older than #1545 does not have it and this
   * interface is what such a host already satisfies; the route answers 501 rather than
   * calling something that is not there. That refusal is the point: the alternative is a
   * count that quietly performs the reopen it was meant to preview.
   */
  redrainCountLocal?(scopeId: ScopeId, drainedBefore: string): Promise<number>;
  /**
   * The scope database's size in bytes (#1524), for an on-demand storage reading. OPTIONAL
   * for the reason `redrainCountLocal` is: a host built before it satisfies this interface
   * without it, and the route answers 501 rather than 0, which a sum would add.
   */
  databaseSizeLocal?(scopeId: ScopeId): Promise<number>;
  entityHistoryLocal(scopeId: ScopeId, input: EntityHistoryInput): Promise<Page<HistoryEntry>>;
  facetEventsLocal(scopeId: ScopeId, input: EventFacetInput): Promise<EventFacetResult>;
  eventCauseLocal(scopeId: ScopeId, input: EventCauseInput): Promise<CauseChain>;
  eventEffectsLocal(scopeId: ScopeId, input: EventEffectsInput): Promise<EffectsTree>;
  invocationEventsLocal(scopeId: ScopeId, input: InvocationEventsInput): Promise<InvocationEvents>;
  deadLettersLocal(scopeId: ScopeId, input: DeadLettersInput): Promise<Page<DeadLetter>>;
  lifecycleFlowLocal(scopeId: ScopeId, input: LifecycleFlowInput): Promise<LifecycleFlowResult>;
  rewindScopeLocal(
    scopeId: ScopeId,
    bookmark: string,
    opts?: { force?: boolean },
  ): Promise<{ rewindingTo: string }>;
  introspectScopeTables(scopeId: ScopeId): Promise<ScopeTable[]>;
  introspectScopeTable(
    scopeId: ScopeId,
    input: z.infer<typeof readScopeTableInput>,
  ): Promise<unknown>;
  introspectScopeQuery(scopeId: ScopeId, input: { sql: string }): Promise<ScopeQueryResult>;
  listDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<PermissionDenial[]>;
  summarizeDenialsLocal(scopeId: ScopeId, filter?: DenialFilter): Promise<DenialSummary>;
  /** The operator's capability read (#1686): records, never a secret or a hash. */
  listCapabilitiesLocal(scopeId: ScopeId, filter?: CapabilityFilter): Promise<CapabilityPage>;
  listPlatformRequests(tenantId: TenantId, scopeId: ScopeId): Promise<PlatformRequest[]>;
  listPlatformRequestHistory(
    tenantId: TenantId,
    scopeId: ScopeId,
    filter?: PlatformRequestFilter,
  ): Promise<PlatformRequest[]>;
  settlePlatformRequest(
    tenantId: TenantId,
    scopeId: ScopeId,
    id: PlatformRequestId,
    outcome: {
      status: PlatformRequestStatus;
      result?: unknown;
      lastError?: string | null;
      failure?: PlatformRequestFailure | null;
    },
  ): Promise<void>;
  // The connector write-back's far end (#574): the shared control plane runs the
  // connector pass for this CP-less deployment and reaches back through these. The
  // permission check happens HERE, in the scope's own DO, against the delivered
  // `connection:<id>` tuple — the platform cannot skip it.
  connectorInvokeLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
  ): Promise<unknown>;
  connectorAttachmentUploadLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    upload: {
      entity: EntityRef;
      filename: string;
      contentType: string;
      visibility: Visibility;
      body: Uint8Array;
    },
  ): Promise<unknown>;
  /** The outbound read (#711) — the vertical's own document, handed back by id.
   *  `eventId` (#726) names the delivery asking; resolved HERE against this
   *  deployment's own outbox, it admits the attachments of that event's entity and
   *  nothing else, which is what lets the read need no standing grant. */
  connectorAttachmentOpenLocal(
    connectionId: ConnectionId,
    tenantId: TenantId,
    scopeId: ScopeId,
    attachmentId: string,
    eventId?: string,
  ): Promise<{ record: unknown; body: Uint8Array; contentType: string } | null>;
  connectorGrantLocal(
    connectionId: ConnectionId,
    scopeId: ScopeId,
    permission: PermissionKey,
    expiresAt?: string,
  ): Promise<void>;
  /**
   * The far end of the schedule kill switch (#1666): move one module's switch in the
   * scope's own storage. OPTIONAL for the reason `redrainCountLocal` is — a host built
   * before it satisfies this interface without it — and the route answers 501, which the
   * control plane reports as "redeploy", never as a switch that moved.
   */
  systemSwitchLocal?(scopeId: ScopeId, moduleId: ModuleId, to: 'on' | 'off'): Promise<SystemSwitchOutcome>;
  /**
   * The far end of the schedule kill switch's status read (#1674): every module this
   * scope holds or has held system authority for, and where each stands. Optional for the
   * same reason `systemSwitchLocal` is: a host built before it satisfies this interface
   * without it, and the route answers 501, which the control plane reports as "redeploy",
   * never a wrong `on`.
   */
  systemGrantsStatusLocal?(scopeId: ScopeId): Promise<SystemScheduleEntry[]>;
  /**
   * The far end of the PEER kill switch's status read (#1706): every peer this scope holds
   * or has held grants for, and where each stands. Optional for the same reason the two
   * above are — a host built before it satisfies this interface without it, and the route
   * answers 501, which the control plane reports as "redeploy", never a wrong `on`.
   */
  peerGrantsStatusLocal?(scopeId: ScopeId): Promise<PeerGrantsEntry[]>;
  /**
   * The far end of a PEER call (#1706): invoke one operation in this deployment as another
   * vertical of the same tenant, which the platform identified and resolved this scope for.
   * Admission (declared, switched on, allowlisted) and every check run in the scope's own
   * storage. OPTIONAL like the switch above — a host built before it answers 501.
   */
  verticalInvokeLocal?(
    caller: VerticalCaller,
    tenantId: TenantId,
    scopeId: ScopeId,
    operation: string,
    input?: unknown,
    options?: InvokeOptions,
  ): Promise<unknown>;
  /** The far end of the peer kill switch (#1706). Optional, 501 when absent, like the rest. */
  peerSwitchLocal?(scopeId: ScopeId, vertical: string, to: 'on' | 'off'): Promise<PeerSwitchOutcome>;
  /**
   * The cross-vertical far ends (#1705 PR 2): the producer's release after a watermark, the
   * consumer's imports and watermarks, and a batch applied to the consumer. Each proves the
   * scope is one this deployment serves before it answers. OPTIONAL like the switches: a host
   * built before them answers 501 here, which the platform reports as "redeploy the vertical",
   * never as an empty export list or a watermark of "never read".
   */
  exportedEventsLocal?(tenantId: TenantId, scopeId: ScopeId, input: ExportReadInput): Promise<ExportedBatch>;
  importStateLocal?(tenantId: TenantId, scopeId: ScopeId): Promise<ImportState>;
  importEventsLocal?(tenantId: TenantId, scopeId: ScopeId, batch: ImportBatch): Promise<ImportResult>;
  /**
   * The replay lever's far end (#1705 PR 3): move the consumer's watermark on one edge, under the
   * platform's `replayId`. Optional for the same reason: a host built before it answers 501,
   * and nothing moved.
   */
  importCursorLocal?(tenantId: TenantId, scopeId: ScopeId, at: ImportCursorMoveAt): Promise<ImportCursorMoved>;
  /**
   * The seat half of an owner hand-over (#1665): grant a role at scope level, and take one back
   * (a tombstone; `true` when a live grant was revoked). The sandbox-clean host has both for its
   * invite flow. OPTIONAL like the switches: a host without them answers 501 at
   * `/internal/owner-transfer` before the record moves, so no hand-over is ever half-started.
   */
  assignScopeRole?(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<void>;
  revokeScopeRole?(scopeId: ScopeId, principal: PrincipalId, roleKey: string): Promise<boolean>;
  /** Does `principal` hold a role the scope can expand? The hand-over's check on `to` (#1665). */
  hasScopeRoleLocal?(tenantId: TenantId, scopeId: ScopeId, principal: PrincipalId): Promise<boolean>;
}

/**
 * The denial-log filter, off the query string (#867). Both denial routes take the same
 * one, and it is PARSED here rather than forwarded: what arrives is text, and what it
 * narrows is a SQL read of the scope's own log.
 */
const denialQuery = (c: { req: { query: (k: string) => string | undefined } }): DenialFilter =>
  denialFilter.parse({
    actor: c.req.query('actor'),
    permission: c.req.query('permission'),
    operation: c.req.query('operation'),
    since: c.req.query('since'),
    until: c.req.query('until'),
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    groupBy: c.req.query('groupBy'),
  });

/** `/internal/provision` body. `slug`/`name` ride along so `onProvision` can register a site (M2). */
const provisionBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  owner: principalIdOf,
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
  connectionGrants: z.array(projectedConnectionGrant).optional(),
  connectionKeys: z.array(projectedConnectionKey).optional(),
  switchedOff: z.array(moduleIdOf).optional(),
});
/** The parsed provision body handed to `onProvision`. */
export type ProvisionBody = z.infer<typeof provisionBody>;

/** `/internal/reconcile` carries no owner — the vertical re-sources it via `resolveOwner` (#332). */
const reconcileBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entitlements: z.array(entitlementGrant).optional(),
  identityLinks: z.array(projectedIdentityLink).optional(),
  connectionGrants: z.array(projectedConnectionGrant).optional(),
  connectionKeys: z.array(projectedConnectionKey).optional(),
  /**
   * #1742: the modules the platform's record holds switched OFF on this scope. Module ids
   * only: the scope they apply to is `scopeId`, the one this request provisions, and no
   * field can name another. The host switches them off in the seat's own unit.
   */
  switchedOff: z.array(moduleIdOf).optional(),
});

/**
 * The in-unit outcomes, parsed on the way OUT. By the time this runs, the provision, reconcile
 * or restore has already committed, so a report that does not parse is left out instead of
 * failing an operation that succeeded. The platform reads it only to audit, and its own
 * re-assert after the call still switches the modules, exactly as for a host that sends none.
 */
const switchedOffAnswer = (switched: SwitchedOff[] | undefined) => {
  const parsed = switched ? z.array(switchedOffInUnit).safeParse(switched) : undefined;
  return parsed?.success ? { switchedOff: parsed.data } : {};
};

const wipeCarriedBody = z.object({
  scopeId: scopeIdOf,
  /** The stamp the carry read from its export; null for a store no load has stamped. */
  expectLoadStamp: z.string().min(1).nullable(),
  /** The script the data went to, and when, for the tombstone. */
  carriedTo: z.string().min(1),
  at: z.string().min(1),
});

const restoreBody = z.object({
  tenantId: tenantIdOf.optional(),
  scopeId: scopeIdOf,
  /** #1742: as on the reconcile — applied to `scopeId`, in the restore's own event. */
  switchedOff: z.array(moduleIdOf).optional(),
  /** #1869: the scope the dump was captured from. Only its node grants are re-pointed at
   *  `scopeId`; a platform that predates the field sends none, and the host falls back. */
  sourceScopeId: scopeIdOf.optional(),
  /** #1869: the platform exported these tables itself, so `sourceScopeId` is a fact and the
   *  re-point never falls back. Absent for a dump a caller supplied. */
  exact: z.boolean().optional(),
  /** #1722: the stamp a carry leaves on the copy it lands, so a later wipe of it can be fenced. */
  loadStamp: z.string().min(1).optional(),
  /** #1722: the marker the carry read from this store; the load is refused if the store moved since. */
  expect: z.object({ loadStamp: z.string().min(1).nullable(), outboxTop: z.string().min(1).nullable() }).optional(),
  tables: z.array(
    z.object({
      name: z.string(),
      ddl: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.unknown())),
    }),
  ),
})
  // #1869: `exact` vouches for a named source. Without one the host would silently fall back.
  .refine((b) => !b.exact || b.sourceScopeId !== undefined, {
    message: '`exact` needs `sourceScopeId`, the scope the dump came from',
    path: ['exact'],
  });

const configureBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
});
/** The parsed configure body handed to `onConfigure`. */
export type ConfigureBody = z.infer<typeof configureBody>;

/** `/internal/owner-claim` body (#925). `origin` is the instance's public origin, supplied by the
 *  platform (it owns the hostname directory; a dispatched `/internal` call carries no usable host). */
const ownerClaimBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  origin: z.string().url(),
});

/** `/internal/owner-transfer` body (#1665): the address plus `ownerTransferInput`'s two principals. */
const ownerTransferBody = ownerTransferPair
  .extend({ tenantId: tenantIdOf, scopeId: scopeIdOf })
  .strict()
  .refine(...distinctOwnerTransfer);

/** Why the directory refused a hand-over, as the platform reads it: every refusal wrote nothing. */
const ownerTransferRefusal: Record<Extract<OwnerTransferRecord, { outcome: 'refused' }>['reason'], string> = {
  unknown: 'has no owner of record here — nothing to hand over',
  'same-principal': 'cannot be handed to the principal that already owns it',
  unclaimed: 'has an unclaimed owner seat — claim it first, then hand it over',
  'not-owner': 'is not owned by `from` — the owner of record is someone else',
  'not-member': 'has no member `to` — no login in it is bound to `to`, and the new owner must be someone who can sign in',
  'no-role': 'has `to` as a login holding no role here — grant `to` a role first, then hand over',
  'in-flight': 'has another hand-over in flight — resend that one to finish it, or abandon it',
  wedged:
    'has this hand-over open, and it can no longer finish: `to` has since lost its login or its role here — abandon it, then hand over again',
};

const settleBody = z.object({
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  id: platformRequestId,
  status: platformRequestStatus,
  result: z.unknown().optional(),
  lastError: z.string().nullable().optional(),
  // #841. Optional so a control plane too old to attribute still settles — the column
  // then stays NULL, which reads as "nobody classified this" rather than a guess.
  failure: platformRequestFailure.nullable().optional(),
});

/** `/internal/mark-drained` body (#1334) — the stamp half of the Tier-2 drain. */
const markDrainedBody = z.object({
  scopeId: scopeIdOf,
  eventIds: z.array(z.string().min(1)).max(1000),
  drainedAt: instant,
});

/**
 * `/internal/redrain-events` body (#1334) — reopen stamped rows so the drain ships them
 * again. `drainedBefore` required, as on the platform verb: it is what keeps rows that
 * already reached a rebuilt table from being reopened and landing there twice.
 *
 * `/internal/redrain-count` (#1545) takes the same body: the count rehearses exactly the
 * window the reopen would touch, so anything it asked differently would be a rehearsal of
 * a different run. The two are separate PATHS for the reason written at the route.
 */
const redrainEventsBody = z.object({ scopeId: scopeIdOf, drainedBefore: instant });

/** `/internal/connector-invoke` body (#574) — one operation, invoked as the connection. */
const connectorInvokeBody = z.object({
  connectionId: connectionIdOf,
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  operation: z.string().min(1),
  input: z.unknown().optional(),
});

/** The `meta` field of a `/internal/connector-attachment` multipart body (#574). */
const connectorAttachmentMeta = z.object({
  connectionId: connectionIdOf,
  tenantId: tenantIdOf,
  scopeId: scopeIdOf,
  entity: entityRef,
  filename: z.string().min(1),
  contentType: z.string().min(1),
  visibility,
});

/** `/internal/system-switch` body (#1666) — the far end of `revokeFromSystem` / `restoreToSystem`. */
const systemSwitchBody = z.object({
  scopeId: scopeIdOf,
  moduleId: moduleIdOf,
  to: z.enum(['on', 'off']),
});

/**
 * `/internal/vertical-invoke` body (#1706) — one operation, invoked as a PEER vertical.
 *
 * STRICT, and that is part of the contract rather than tidiness: the caller is `caller` and
 * nothing else. A body that also names a principal, a session or a capability is refused,
 * so no field a future caller adds can make a peer call act as a person.
 */
const verticalInvokeBody = z
  .object({
    caller: verticalCaller,
    tenantId: tenantIdOf,
    scopeId: scopeIdOf,
    operation: z.string().min(1),
    input: z.unknown().optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

/** `/internal/peer-switch` body (#1706) — the far end of `revokeFromPeer` / `restoreToPeer`. */
const peerSwitchBody = z.object({
  scopeId: scopeIdOf,
  vertical: verticalSlugOf,
  to: z.enum(['on', 'off']),
});

/**
 * `/internal/exported-events` body (#1705 PR 2): the producer scope the platform resolved, and
 * the read it asks for. `input.consumer` is the platform's word for who receives, taken from its
 * directory. The producer then answers from its OWN exports and the consumer's grants here.
 */
const exportedEventsBody = z.object({ tenantId: tenantIdOf, scopeId: scopeIdOf, input: exportReadInput });

/** `/internal/import-events` body (#1705 PR 2): the consumer scope, and the batch to apply. */
const importEventsBody = z.object({ tenantId: tenantIdOf, scopeId: scopeIdOf, batch: importBatch });

/** `/internal/import-cursor` body (#1705 PR 3): the consumer scope, and the move the platform resolved. */
const importCursorBody = z.object({ tenantId: tenantIdOf, scopeId: scopeIdOf, at: importCursorMoveAt });

/** `/internal/connector-grant` body (#574) — the delivery half of `grantToConnection`. */
const connectorGrantBody = z.object({
  connectionId: connectionIdOf,
  scopeId: scopeIdOf,
  permission: permissionKeyOf,
  expiresAt: instant.optional(),
});

export interface PlatformSurfaceDeps<Env> {
  /**
   * The secret that gates every `/internal` call, read off the worker env. Unset ⇒ every
   * call 403s — `assertPlatformCall` fails closed (an open provisioning endpoint lets a
   * stranger mint tenants inside the vertical).
   */
  platformSecret: (env: Env) => string | undefined;
  /** The scope host for THIS deployment — the data DOs live here (K-31). */
  hostFor: (env: Env) => VerticalScopeHost;
  /** The vertical's own role definitions — re-projected after BOTH provision and restore. */
  roles: RoleDefinition[];
  /** The role the installing owner is granted, at scope level (`hr-admin`, `admin`, …). */
  ownerRoleKey: string;

  /**
   * Vertical-specific provision side effect — the pending-owner TOFU claim, and for a
   * multi-site vertical the site-registry write. Runs after the scope's own state is set
   * up. Optional: a vertical with no owner-of-record store omits it.
   */
  onProvision?: (env: Env, body: ProvisionBody) => Promise<void>;
  /**
   * Re-source a reconcile's owner from the vertical's durable owner-of-record (#332).
   * Return `null` when there is no record (⇒ 409, re-run the install). Omit entirely and
   * `/internal/reconcile` answers 501 — the vertical keeps no owner-of-record.
   */
  resolveOwner?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
  ) => Promise<PrincipalId | null>;
  /**
   * Persist per-instance config (the dashboard's Env tab). Omit ⇒ `/internal/configure`
   * answers 501 — the vertical stores no per-scope config.
   */
  onConfigure?: (env: Env, body: ConfigureBody) => Promise<void>;
  /**
   * The scope's owner seat as the platform may see it (#925) — claimed, unclaimed (and whether
   * a plain first sign-in still claims it), or unknown. Omit ⇒ `/internal/owner-seat` answers
   * 501: the vertical keeps no owner seat (it binds logins some other way).
   */
  ownerSeat?: (env: Env, ref: { tenantId: TenantId; scopeId: ScopeId }) => Promise<z.input<typeof ownerSeat>>;
  /**
   * Mint a short-lived claim link for an UNCLAIMED owner seat (#925) — what the dashboard
   * hands the installer once the first-sign-in window has closed (or instead of relying on
   * it). Return `null` when the seat is already claimed (⇒ 409). The link is answered to the
   * platform and never persisted by it; the vertical stores only the token's hash. Omit ⇒
   * `/internal/owner-claim` answers 501.
   */
  mintOwnerClaim?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
    input: { origin: string },
  ) => Promise<OwnerClaimLink | null>;
  /**
   * Move the scope's owner of record from `from` to `to` (#1665). vertical-auth's IdentityDO
   * `transferOwner` is the reference, and the route below says what runs around it. Omit ⇒
   * `/internal/owner-transfer` answers 501, like the other owner-seat verbs.
   */
  transferOwner?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
    /** `toHoldsRole`: the host's read of whether `to` holds a role the scope can expand. */
    input: { from: PrincipalId; to: PrincipalId; toHoldsRole: boolean },
  ) => Promise<z.input<typeof ownerTransferRecord>>;
  /**
   * Close the hand-over `from → to` once `/internal/owner-transfer` has seated and revoked around
   * it (#1665), so a repeat reads `done` and moves nothing. IdentityDO `completeOwnerTransfer`
   * is the reference. Required with `transferOwner`: the route answers 501 without both.
   */
  completeOwnerTransfer?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
    input: { from: PrincipalId; to: PrincipalId },
  ) => Promise<boolean>;
  /**
   * Abandon the OPEN, WEDGED hand-over `from → to` without finishing it (#1665): no seat, no
   * revoke, the record left on `to`. `not-open` and `healthy` (it can still finish) are 409s that
   * wrote nothing. IdentityDO `abandonOwnerTransfer` is the reference. Omit ⇒ an abandon 501s.
   */
  abandonOwnerTransfer?: (
    env: Env,
    ref: { tenantId: TenantId; scopeId: ScopeId },
    input: { from: PrincipalId; to: PrincipalId; toHoldsRole: boolean },
  ) => Promise<z.input<typeof ownerTransferAbandon>>;
  /**
   * Vertical-specific delete-scope side effect — e.g. drop the scope from a deployment
   * sweep roster (#461) so its alarm never wakes a reaped scope. Runs after the host has
   * wiped the scope's storage. The tenant is supplied by current control planes;
   * older callers omit it, so hooks that need it should handle that case. Optional.
   */
  onDeleteScope?: (env: Env, scopeId: ScopeId, tenantId?: TenantId) => Promise<void>;

  /**
   * Extra error mapping, tried BEFORE the default envelope. Return a `{status, message}`
   * to override, or `undefined` to fall through to the default. Use it for a vertical's
   * own domain errors; the platform routes here never need it.
   */
  mapError?: (err: unknown) => { status: number; message: string } | undefined;
}

/**
 * Mount the platform's `/internal/*` contract and the guaranteed error envelope onto a
 * vertical's Hono app. Call it once; it registers the platform-secret gate (one
 * middleware, not a per-route try/catch), every `/internal` route, and `app.onError`.
 *
 * Hono keeps the LAST-registered `onError`, so mounting the surface installs the envelope
 * — there is no "mounted the routes but forgot the handler" state. A vertical keeps its
 * own user-facing surface (`/api/auth`, `/me`, `/op`, …) on the same `app`.
 */
export function mountPlatformSurface<Env extends object>(
  app: Hono<{ Bindings: Env }>,
  deps: PlatformSurfaceDeps<Env>,
): void {
  // ── ONE gate for the entire surface (replaces the per-route copy-pasted try/catch) ──
  app.use('/internal/*', async (c, next) => {
    try {
      assertPlatformCall(c.req.raw.headers, { expectedSecret: deps.platformSecret(c.env) });
    } catch (e) {
      if (e instanceof PlatformCallError) throw new HTTPException(403, { message: e.message });
      throw e;
    }
    await next();
  });

  // ── Generic host-delegating routes: zero vertical-specific behaviour, cannot drift ──

  // The full dump behind a governed `scope pull` (preview-and-snapshots.md §8): the one
  // /internal verb that deliberately moves scope bytes out; the control plane is the gate.
  // #1722: `stamp=1` is a carry's export. The store's load stamp then rides a header, read with
  // the dump in one DO call (and minted when the store has none, which is a write: only a carry
  // asks for it), so the body stays the bare table list every platform reads.
  app.get('/internal/export', async (c) => {
    const scopeId = scopeIdOf.parse(c.req.query('scopeId'));
    const host = deps.hostFor(c.env);
    if (c.req.query('stamp') !== '1' || !host.exportScopeStampedLocal) {
      return c.json(await host.exportScopeLocal(scopeId));
    }
    const { tables, loadStamp } = await host.exportScopeStampedLocal(scopeId);
    if (loadStamp) c.header(LOAD_STAMP_HEADER, loadStamp);
    return c.json(tables);
  });

  // The write half (§8): load a dump into one scope, replacing its data — the governed
  // restore/backout, and the data hop of adopt-serving (#286). After the import the
  // vertical's OWN role definitions are re-projected: a dump from a CP-full world carries
  // tuples but no role definitions, so without the repair every check denies while /me
  // still names the role. Roles are code-defined, so re-projecting is always safe.
  app.post('/internal/restore', async (c) => {
    const body = restoreBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    const result = await host.restoreScopeLocal(body.scopeId, body.tables, {
      switchedOff: body.switchedOff,
      sourceScopeId: body.sourceScopeId,
      exact: body.exact,
      loadStamp: body.loadStamp,
      expect: body.expect,
    });
    if (body.tenantId) await host.projectRolesLocal(body.tenantId, body.scopeId, deps.roles);
    return c.json({ tables: result.tables, ...switchedOffAnswer(result.switchedOff) });
  });

  // #1722: wipe the copy a carry left here, after the scope's route moved to another script.
  // Conditional on the load stamp the carry read, compared inside the wipe's own transaction,
  // so a rollback that restored into this scope since is never destroyed. `wiped: false` is
  // that refusal. Non-terminal: the store keeps a `carried_away` tombstone and takes a later
  // restore like any scope, which `/internal/delete-scope` (a reap) would not.
  // #1722: what a carry's restore into this scope expects to find unchanged (the load stamp and
  // the outbox's highest event id). Read before the carry checks the binding again; the restore
  // then sends it back as `expect`, so a store the winning carry loaded, or that took a write
  // since it went live, is never overwritten. Metadata only: no scope bytes cross.
  app.get('/internal/load-marker', async (c) => {
    const host = deps.hostFor(c.env);
    if (!host.loadMarkerLocal) {
      return c.json({ error: 'this deployment cannot fence a carry\'s restore (#1722) — redeploy it' }, 501);
    }
    return c.json(await host.loadMarkerLocal(scopeIdOf.parse(c.req.query('scopeId'))));
  });

  app.post('/internal/wipe-carried', async (c) => {
    const body = wipeCarriedBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.wipeCarriedLocal) {
      return c.json({ error: 'this deployment cannot fence a carried copy\'s wipe (#1722) — redeploy it' }, 501);
    }
    return c.json({
      wiped: await host.wipeCarriedLocal(body.scopeId, body.expectLoadStamp, { to: body.carriedTo, at: body.at }),
    });
  });

  // #1239: facets over this scope's own outbox — narrow, group, count. Counts and
  // grouped VALUES cross here, which is less than the history route below sends,
  // but a payload field's values are still the tenant's own data on the tenant's
  // own dashboard, through the platform's tenant-scoped read.
  // #1237: the causal walk for a scope THIS vertical holds. Same shape as the two
  // reads below it — the control plane cannot reach a dispatch vertical's DO, so the
  // vertical answers for its own spine.
  // #1237 forward: what one event set off, for a scope THIS vertical holds.
  app.get('/internal/effects', async (c) =>
    c.json(
      await deps.hostFor(c.env).eventEffectsLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        eventEffectsInput.parse({
          eventId: c.req.query('eventId'),
          maxNodes: c.req.query('maxNodes') ? Number(c.req.query('maxNodes')) : undefined,
        }),
      ),
    ),
  );

  // #1237: everything one call emitted, for a scope THIS vertical holds — the siblings
  // neither walk reaches. Payloads cross, so the id and the cap are parsed at this door.
  app.get('/internal/invocation', async (c) =>
    c.json(
      await deps.hostFor(c.env).invocationEventsLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        invocationEventsInput.parse({
          invocationId: c.req.query('invocationId'),
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        }),
      ),
    ),
  );

  // #1525: every delivery in a scope THIS vertical holds that gave up — the list the
  // walks reach only one event at a time. Paged, so the cap and cursor are parsed here.
  app.get('/internal/dead-letters', async (c) =>
    c.json(
      await deps.hostFor(c.env).deadLettersLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        deadLettersInput.parse({
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
          cursor: c.req.query('cursor') ?? undefined,
        }),
      ),
    ),
  );

  app.get('/internal/cause', async (c) =>
    c.json(
      await deps.hostFor(c.env).eventCauseLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        eventCauseInput.parse({
          eventId: c.req.query('eventId'),
          maxDepth: c.req.query('maxDepth') ? Number(c.req.query('maxDepth')) : undefined,
        }),
      ),
    ),
  );

  app.get('/internal/facets', async (c) =>
    c.json(
      await deps.hostFor(c.env).facetEventsLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        eventFacetInput.parse({
          groupBy:
            c.req.query('field') !== undefined
              ? { kind: 'payload', field: c.req.query('field') }
              : { kind: c.req.query('groupBy') },
          type: c.req.query('type') ?? undefined,
          since: c.req.query('since') ?? undefined,
          until: c.req.query('until') ?? undefined,
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        }),
      ),
    ),
  );

  // #1235: one record's event history — payloads, the K-34 chain, impersonation, the
  // PII class. Scope bytes DO cross here, exactly as the table reads do, and for the
  // same reason: it is the tenant's own data, answered to the tenant's own dashboard
  // through the platform's tenant-scoped read.
  app.get('/internal/history', async (c) =>
    c.json(
      await deps.hostFor(c.env).entityHistoryLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        entityHistoryInput.parse({
          entityType: c.req.query('entityType'),
          entityId: c.req.query('entityId'),
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
          cursor: c.req.query('cursor') ?? undefined,
        }),
      ),
    ),
  );

  // #1334: the Tier-2 drain, delegated. The shared control plane's own scope namespace
  // is a module-less placeholder, so the outbox it drains has to be read where it
  // lives — here — and stamped here once the sink confirmed durability. Scope bytes DO
  // cross (event payloads), for the reason `/internal/history` gives: it is the tenant's
  // own data, on its way to the lake the platform keeps for that tenant, and the
  // platform's `readUndrainedEvents` / `markEventsDrained` are the audited door.
  //
  // `withSkipped=1` (#1636) asks for `{ events, skipped? }` instead of the bare array, so the
  // rows the read stepped over reach the sweep's report — a property on an array does not
  // survive `c.json`. Opt-in by the CALLER, so a platform that predates it still gets the
  // array it parses, and a platform that asks a vertical predating it gets the array too
  // and reads it as "nothing said".
  app.get('/internal/undrained-events', async (c) => {
    const events = await deps
      .hostFor(c.env)
      .undrainedEventsLocal(
        scopeIdOf.parse(c.req.query('scopeId')),
        z.coerce.number().int().min(1).max(1000).default(200).parse(c.req.query('limit') ?? undefined),
      );
    if (c.req.query('withSkipped') !== '1') return c.json(events);
    return c.json({ events: [...events], ...(events.skipped ? { skipped: events.skipped } : {}) });
  });
  app.post('/internal/mark-drained', async (c) => {
    const body = markDrainedBody.parse(await c.req.json());
    const drained = await deps.hostFor(c.env).markEventsDrainedLocal(body.scopeId, body.eventIds, body.drainedAt);
    return c.json({ drained });
  });
  // The stamp's inverse. No audit here, as with the stamp: the platform's `redrainEvents`
  // is the door and writes the receipt, whichever deployment held the rows.
  app.post('/internal/redrain-events', async (c) => {
    const raw: unknown = await c.req.json();
    // `countOnly` is REFUSED here, not stripped (#1545), mirroring the control-plane door.
    // Zod drops unknown keys by default, so a caller that asked this route for a count would
    // silently get the reopen — the one failure the separate count route exists to prevent,
    // and the fact that only the platform's own client calls this route is a reason to keep
    // the refusal cheap, not a reason to trust the caller. NOT `.strict()` on the body: that
    // would also refuse every future additive field, which is how this surface is meant to
    // grow.
    if (typeof raw === 'object' && raw !== null && 'countOnly' in raw) {
      return c.json({ error: 'countOnly is not honoured here — POST to /internal/redrain-count instead' }, 400);
    }
    const body = redrainEventsBody.parse(raw);
    const redrained = await deps.hostFor(c.env).redrainEventsLocal(body.scopeId, body.drainedBefore);
    return c.json({ redrained });
  });
  // The read-only half (#1545): how many rows the reopen above would touch. Its OWN path,
  // not a flag on that one, because the two answer with the same shape and the caller is a
  // control plane that may be newer than this deployment. A `countOnly` field would be
  // stripped by a deployment built before #1545 — which would then reopen the window and
  // answer with a number indistinguishable from the count that was asked for, during a dry
  // run. A path that deployment does not serve is refused instead, which is the honest
  // answer and leaves the rows alone.
  app.post('/internal/redrain-count', async (c) => {
    const body = redrainEventsBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    // Same reasoning one layer in: a vertical whose adapter predates #1545 satisfies this
    // interface without the method, and 501 is the answer that cannot be mistaken for 0.
    if (!host.redrainCountLocal) {
      return c.json({ error: 'this deployment cannot count a redrain window (#1545) — redeploy it' }, 501);
    }
    return c.json({ redrainable: await host.redrainCountLocal(body.scopeId, body.drainedBefore) });
  });

  // #1236: when one scope's migrations actually ran — the schema-change annotation
  // release health reads. Metadata only; no scope bytes cross the boundary.
  app.get('/internal/migrations', async (c) =>
    c.json(await deps.hostFor(c.env).appliedMigrationsLocal(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  // #1524: one scope's database size, for the console's on-demand storage reading.
  // Metadata only, and no scope bytes cross. The read wakes the scope's DO, which is why
  // the platform asks only when a person opens the card and pages what it asks for.
  app.get('/internal/database-size', async (c) => {
    const scope = scopeIdOf.parse(c.req.query('scopeId'));
    const host = deps.hostFor(c.env);
    if (!host.databaseSizeLocal) {
      return c.json({ error: 'this deployment cannot read a database size (#1524). Redeploy it' }, 501);
    }
    return c.json({ bytes: await host.databaseSizeLocal(scope) });
  });

  // #286: the PITR bookmarks one scope recorded before its migration passes — the rewind
  // points a backout offers. Metadata only; no scope bytes cross the boundary.
  app.get('/internal/bookmarks', async (c) =>
    c.json(await deps.hostFor(c.env).migrationBookmarksLocal(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  // #286's backout: rewind one scope's ENTIRE storage — schema and data — to a
  // pre-migration bookmark. The DO enforces the freshness window (24h without force) and
  // restarts itself to complete the restore; the control plane is the gate and the auditor.
  app.post('/internal/rewind', async (c) => {
    const body = z
      .object({ scopeId: scopeIdOf, bookmark: z.string().min(1), force: z.boolean().optional() })
      .parse(await c.req.json());
    return c.json(
      await deps.hostFor(c.env).rewindScopeLocal(body.scopeId, body.bookmark, { force: body.force }),
    );
  });

  // Scope-storage lifecycle (preview-and-snapshots.md §9): copy a scope into a sibling DO /
  // wipe a reaped fork — both inside this deployment; no bytes cross the boundary.
  app.post('/internal/snapshot', async (c) => {
    const body = z.object({ sourceScopeId: scopeIdOf, newScopeId: scopeIdOf }).parse(await c.req.json());
    return c.json(await deps.hostFor(c.env).snapshotScopeLocal(body.sourceScopeId, body.newScopeId), 201);
  });

  app.post('/internal/delete-scope', async (c) => {
    const body = z.object({ scopeId: scopeIdOf, tenantId: tenantIdOf.optional() }).parse(await c.req.json());
    await deps.hostFor(c.env).deleteScopeLocal(body.scopeId);
    await deps.onDeleteScope?.(c.env, body.scopeId, body.tenantId);
    return c.json({ deleted: body.scopeId });
  });

  // Read-only introspection of a scope's OWN database (kernel-design §5.4) — what the
  // console/dashboard "Data" view reads. The scope's data DO lives HERE (K-31), so the
  // control plane delegates; the scope id is trusted from the gated call.
  app.get('/internal/tables', async (c) =>
    c.json(await deps.hostFor(c.env).introspectScopeTables(scopeIdOf.parse(c.req.query('scopeId')))),
  );

  app.get('/internal/tables/:table', async (c) => {
    const scope = scopeIdOf.parse(c.req.query('scopeId'));
    const input = readScopeTableInput.parse({
      table: c.req.param('table'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    });
    return c.json(await deps.hostFor(c.env).introspectScopeTable(scope, input));
  });

  // The SQL console (#219): one read-only statement, enforced in the DO (textual gate + a
  // transaction that always rolls back). The gate's refusal is the CALLER's mistake — 400,
  // relayed verbatim by the platform — not this worker's fault.
  // #1744: one entity's declared lifecycle, replayed over a scope THIS vertical holds —
  // the process map's data. POST, because the declaration travels in the body.
  app.post('/internal/lifecycle-flow', async (c) => {
    const { scopeId, ...input } = lifecycleFlowInput.extend({ scopeId: scopeIdOf }).parse(await c.req.json());
    return c.json(await deps.hostFor(c.env).lifecycleFlowLocal(scopeId, input));
  });

  app.post('/internal/query', async (c) => {
    const body = queryScopeInput.extend({ scopeId: scopeIdOf }).parse(await c.req.json());
    try {
      return c.json(await deps.hostFor(c.env).introspectScopeQuery(body.scopeId, { sql: body.sql }));
    } catch (e) {
      if (e instanceof Error && e.message.includes('read-only console')) {
        throw new HTTPException(400, { message: e.message });
      }
      throw e;
    }
  });

  // The K-35 denial log (#867). The rows live in THIS deployment — a denial is written
  // in the scope's own DO, where the refused operation ran — so the control plane has
  // to ask for them, exactly as it does for the tables and the intent journal. The K-3
  // check and the K-24 access-log entry are made on the platform side before this is
  // reached; the gate here is the platform secret, like the rest of the surface.
  app.get('/internal/denials', async (c) => {
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).listDenialsLocal(s, denialQuery(c)));
  });

  // The bucketed view (K-35's rate-buckets). Its own route rather than a flag on the
  // one above: it returns a different shape, and it is the read a console opens first.
  app.get('/internal/denials/summary', async (c) => {
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).summarizeDenialsLocal(s, denialQuery(c)));
  });

  // The operator's capability read (#1686). The directory rows are in THIS deployment's scope
  // DO (a capability is minted inside the scope's operation), so the control plane asks, as it
  // does for the denial log. Records only: the query behind it selects no hash, and the record
  // schema has no field to carry one. Platform-secret gated like the rest of the surface; the
  // K-3 check and the K-24 entry are the platform's, made before this is reached.
  app.get('/internal/capabilities', async (c) => {
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    const { scopeId: _scope, ...rest } = c.req.query();
    return c.json(await deps.hostFor(c.env).listCapabilitiesLocal(s, capabilityFilterQuery.parse(rest)));
  });

  // Platform-intent drain surface (platform-intents.md): the control plane PULLS this
  // scope's pending intents — its DO lives HERE, not the platform's — executes each with
  // its own authority, and journals the outcome back. Platform-secret gated.
  app.get('/internal/platform-requests', async (c) => {
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    return c.json(await deps.hostFor(c.env).listPlatformRequests(t, s));
  });

  // The intent JOURNAL (#618), not the drain queue: every intent this scope enqueued in
  // whatever state it settled, newest first. The drain never needs it — the control plane's
  // console does, because a `failed` connector intent's `last_error` is the whole diagnosis
  // ("HTTP 409 … requires valid personal number field") and it lives here, in the scope's own
  // deployment, where nothing but the read-only SQL console could reach it. Same
  // platform-secret gate as the pending read it sits beside.
  app.get('/internal/platform-requests/history', async (c) => {
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    const filter = platformRequestFilter.parse({
      kind: c.req.query('kind'),
      status: c.req.query('status'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json(await deps.hostFor(c.env).listPlatformRequestHistory(t, s, filter));
  });

  // The connector write-back seam (#574): the shared control plane runs the connector
  // pass (poll sweep, and later webhook ingress + dispatch) for this CP-less deployment,
  // because the connection directory and its sealed secrets live platform-side and a
  // pushed script must never hold them. What comes BACK over these three verbs carries
  // no credential — an operation invocation, provider bytes, a grant tuple — and each is
  // authorized in the scope's own DO against its `connection:<id>` grants, exactly like
  // any other caller. Platform-secret gated with the rest of the surface.
  app.post('/internal/connector-invoke', async (c) => {
    const body = connectorInvokeBody.parse(await c.req.json());
    const result = await deps
      .hostFor(c.env)
      .connectorInvokeLocal(body.connectionId, body.tenantId, body.scopeId, body.operation, body.input);
    // Enveloped: an operation may legitimately return undefined, which bare JSON can't say.
    return c.json({ result: result ?? null });
  });

  // The bytes leg (#574): multipart, because provider artifacts (a sealed signed PDF)
  // cannot ride a JSON invoke. `meta` is a JSON string field, `body` the raw blob.
  app.post('/internal/connector-attachment', async (c) => {
    const form = await c.req.formData();
    const metaRaw = form.get('meta');
    if (typeof metaRaw !== 'string') {
      throw new HTTPException(400, { message: 'connector-attachment needs a `meta` JSON field' });
    }
    const meta = connectorAttachmentMeta.parse(JSON.parse(metaRaw));
    const blob = form.get('body');
    if (blob === null || typeof blob === 'string') {
      throw new HTTPException(400, { message: 'connector-attachment needs a `body` file field' });
    }
    const record = await deps.hostFor(c.env).connectorAttachmentUploadLocal(
      meta.connectionId,
      meta.tenantId,
      meta.scopeId,
      {
        entity: meta.entity,
        filename: meta.filename,
        contentType: meta.contentType,
        visibility: meta.visibility,
        body: new Uint8Array(await blob.arrayBuffer()),
      },
    );
    return c.json(record as Record<string, unknown>, 201);
  });

  // The bytes leg, OUTBOUND (#711): the platform runs this vertical's signing
  // connector and has to send the document the vertical rendered — but the metadata
  // row is in this deployment's ScopeDO and the object in this deployment's R2, so
  // the platform can only ask. Answered with the raw bytes and the record in a
  // header, rather than base64 in JSON, so a multi-megabyte contract costs no
  // re-encoding on either side.
  //
  // `404` means "this scope does not know that id" — a distinct answer from a
  // refusal, which comes back as the permission check's own error. Read-gated at the
  // far end like any other caller: the target's `readPermission`, checked against
  // this connection's delivered tuple.
  app.get('/internal/connector-attachment/:attachmentId', async (c) => {
    const connection = connectionIdOf.parse(c.req.query('connectionId'));
    const t = tenantIdOf.parse(c.req.query('tenantId'));
    const s = scopeIdOf.parse(c.req.query('scopeId'));
    const opened = await deps
      .hostFor(c.env)
      .connectorAttachmentOpenLocal(
        connection,
        t,
        s,
        c.req.param('attachmentId'),
        c.req.query('eventId'),
      );
    if (!opened) return c.body(null, 404);
    return c.body(opened.body as unknown as ArrayBuffer, 200, {
      'content-type': opened.contentType,
      [CONNECTOR_ATTACHMENT_RECORD_HEADER]: JSON.stringify(opened.record),
    });
  });

  // Grant delivery (#574): the scope-level `connection:<id>` tuple the two verbs above
  // are checked against. Idempotent (INSERT OR REPLACE). No revoke mirror: every
  // delegated call re-passes the platform's live-connection gate first, so revoking
  // the connection closes the door even while the tuple remains.
  app.post('/internal/connector-grant', async (c) => {
    const body = connectorGrantBody.parse(await c.req.json());
    await deps
      .hostFor(c.env)
      .connectorGrantLocal(body.connectionId, body.scopeId, body.permission, body.expiresAt);
    return c.json({ granted: body.permission, scopeId: body.scopeId });
  });

  // The schedule kill switch (#1666): the shared control plane's `revokeFromSystem` /
  // `restoreToSystem` for a scope served HERE, whose `system:<module>` grants live in this
  // deployment's scope DO and nowhere the platform can reach. The platform writes the audit
  // row once this answers; nothing is recorded here. `held: false` is a 200 with that
  // answer, never a 404 — a 404 from this path means the route does not exist, which is
  // what a deployment built before it answers, and the platform reads it as exactly that.
  app.post('/internal/system-switch', async (c) => {
    const body = systemSwitchBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.systemSwitchLocal) {
      return c.json({ error: 'this deployment cannot switch schedules (#1666) — redeploy it' }, 501);
    }
    return c.json(await host.systemSwitchLocal(body.scopeId, body.moduleId, body.to));
  });

  // The status read (#1674): the far end of `HostAdmin.systemGrantsStatus` for a scope
  // served HERE. Bare positions only — no admin-log join, since this deployment holds no
  // admin log; the platform joins its own onto this by moduleId once it returns. Same
  // "route exists, host method doesn't" 501 as the switch above, and the same reason for
  // it: a deployment built before this shipped satisfies `VerticalScopeHost` without it.
  app.get('/internal/system-grants', async (c) => {
    const scopeId = scopeIdOf.parse(c.req.query('scopeId'));
    const host = deps.hostFor(c.env);
    if (!host.systemGrantsStatusLocal) {
      return c.json({ error: 'this deployment cannot read schedule switches (#1674) — redeploy it' }, 501);
    }
    return c.json(await host.systemGrantsStatusLocal(scopeId));
  });

  // The peer kill switch's status read for a scope served HERE (#1706). The same shape as
  // the route above and for the same reasons: bare positions, no admin-log join (this
  // deployment holds no admin log), and a 501 naming the redeploy when the host predates it.
  app.get('/internal/peer-grants', async (c) => {
    const scopeId = scopeIdOf.parse(c.req.query('scopeId'));
    const host = deps.hostFor(c.env);
    if (!host.peerGrantsStatusLocal) {
      return c.json({ error: 'this deployment cannot read peer switches (#1706) — redeploy it' }, 501);
    }
    return c.json(await host.peerGrantsStatusLocal(scopeId));
  });

  // The peer door's far end (#1706). The platform — the router, at the hop a calling
  // deployment cannot forge — identified the caller and resolved THIS scope as the instance
  // of this vertical in the caller's tenant; it reaches here behind the platform secret like
  // every `/internal` verb, and a public request cannot (the router strips the header). The
  // body names the caller and nothing that could act as a person (strict). Admission and every
  // check then run in the scope's own storage, on every call. Enveloped for connector-invoke's
  // reason: an operation may legitimately return undefined.
  app.post('/internal/vertical-invoke', async (c) => {
    const body = verticalInvokeBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.verticalInvokeLocal) {
      return c.json({ error: 'this deployment cannot take peer calls (#1706) — redeploy it' }, 501);
    }
    const result = await host.verticalInvokeLocal(
      body.caller,
      body.tenantId,
      body.scopeId,
      body.operation,
      body.input,
      body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : undefined,
    );
    return c.json({ result: result ?? null });
  });

  // The peer kill switch's far end (#1706), for a scope served HERE — the mirror of
  // `/internal/system-switch`: the platform writes the audit rows around this call, and a 404
  // from this path means a deployment built before it, which the platform reads as exactly that.
  app.post('/internal/peer-switch', async (c) => {
    const body = peerSwitchBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.peerSwitchLocal) {
      return c.json({ error: 'this deployment cannot switch peers (#1706) — redeploy it' }, 501);
    }
    return c.json(await host.peerSwitchLocal(body.scopeId, body.vertical, body.to));
  });

  // The cross-vertical far ends (#1705 PR 2). The shared control plane runs the phase for every
  // hosted edge, and the two scopes of an edge live in two vertical deployments it can reach
  // only through here. Behind the platform secret like every `/internal` verb. The body only
  // NAMES the scope the platform resolved. The host proves it serves that scope for that tenant,
  // then this deployment's own code decides what leaves (its exports, the consumer's grants
  // here) and what runs (its imports, the producer's admission at its door). A host built before
  // these answers 501, never an empty list: "nothing to export" and "cannot answer" must not
  // look alike to the platform.
  app.post('/internal/exported-events', async (c) => {
    const body = exportedEventsBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.exportedEventsLocal) {
      return c.json({ error: 'this deployment cannot export events to other verticals (#1705) — redeploy it' }, 501);
    }
    return c.json(await host.exportedEventsLocal(body.tenantId, body.scopeId, body.input));
  });
  app.get('/internal/import-state', async (c) => {
    const tenantId = tenantIdOf.parse(c.req.query('tenantId'));
    const scopeId = scopeIdOf.parse(c.req.query('scopeId'));
    const host = deps.hostFor(c.env);
    if (!host.importStateLocal) {
      return c.json({ error: 'this deployment cannot import events from other verticals (#1705) — redeploy it' }, 501);
    }
    return c.json(await host.importStateLocal(tenantId, scopeId));
  });
  app.post('/internal/import-events', async (c) => {
    const body = importEventsBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.importEventsLocal) {
      return c.json({ error: 'this deployment cannot import events from other verticals (#1705) — redeploy it' }, 501);
    }
    return c.json(await host.importEventsLocal(body.tenantId, body.scopeId, body.batch));
  });
  app.post('/internal/import-cursor', async (c) => {
    const body = importCursorBody.parse(await c.req.json());
    const host = deps.hostFor(c.env);
    if (!host.importCursorLocal) {
      return c.json(
        { error: 'this deployment cannot move an import watermark (#1705) — redeploy it. Nothing was moved.' },
        501,
      );
    }
    return c.json(await host.importCursorLocal(body.tenantId, body.scopeId, body.at));
  });

  app.post('/internal/platform-requests/settle', async (c) => {
    const body = settleBody.parse(await c.req.json());
    await deps.hostFor(c.env).settlePlatformRequest(body.tenantId, body.scopeId, body.id, {
      status: body.status,
      result: body.result,
      lastError: body.lastError ?? null,
      failure: body.failure ?? null,
    });
    return c.json({ ok: true });
  });

  // ── Flavored routes: platform owns the gate + parse + envelope, vertical owns the hook ──

  // Provision ONE scope on the platform's instruction (K-31), CP-less: migrate the module
  // tables, project the role defs, grant the owner their role at scope level. The shared
  // control plane already owns the directory row + entitlements. Idempotent.
  app.post('/internal/provision', async (c) => {
    const body = provisionBody.parse(await c.req.json());
    // The owner the seat (and its lockout repair) is for: the vertical's owner of record once it
    // has one (#1665). The platform re-sends the principal it minted at install on every re-run,
    // and after a hand-over that is the PREVIOUS owner. `body.owner` stays the first install's
    // owner, and what `onProvision` records a seat for, which it keeps first-write-wins.
    const recorded = deps.resolveOwner
      ? await deps.resolveOwner(c.env, { tenantId: body.tenantId, scopeId: body.scopeId })
      : null;
    const owner = recorded ?? body.owner;
    const provisioned = await deps.hostFor(c.env).provisionScopeLocal({
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      roles: deps.roles,
      ownerRoleKey: deps.ownerRoleKey,
      entitlements: body.entitlements,
      identityLinks: body.identityLinks,
      connectionGrants: body.connectionGrants,
      connectionKeys: body.connectionKeys,
      switchedOff: body.switchedOff,
    });
    await deps.onProvision?.(c.env, body);
    return c.json(
      {
        tenantId: body.tenantId,
        scopeId: body.scopeId,
        owner,
        ...switchedOffAnswer(provisioned?.switchedOff),
      },
      201,
    );
  });

  // Repair a scope stuck at the #332 lockout (roles projected, no principal holding one —
  // e.g. a promote recreated the scope DO storage, #321). The builder can't reach the
  // secret-gated /internal/provision, so the control plane calls this on their behalf
  // after checking ownership. It re-sources the owner from the vertical's durable
  // owner-of-record and re-runs the idempotent provision. No owner in the body.
  // The kernel half SEATS its tuples (#1659): what is missing comes back, what an operator
  // revoked stays revoked — except the owner's seat on a scope no one else can act in.
  app.post('/internal/reconcile', async (c) => {
    if (!deps.resolveOwner) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner-of-record to reconcile from' });
    }
    const body = reconcileBody.parse(await c.req.json());
    const owner = await deps.resolveOwner(c.env, { tenantId: body.tenantId, scopeId: body.scopeId });
    if (!owner) {
      throw new HTTPException(409, {
        message: `no owner of record for scope ${body.scopeId} — cannot reconcile; re-run the full install`,
      });
    }
    const reconciled = await deps.hostFor(c.env).provisionScopeLocal({
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      roles: deps.roles,
      ownerRoleKey: deps.ownerRoleKey,
      entitlements: body.entitlements,
      identityLinks: body.identityLinks,
      connectionGrants: body.connectionGrants,
      connectionKeys: body.connectionKeys,
      // #1742: back off inside the seat's unit — see `provisionScopeLocal`.
      switchedOff: body.switchedOff,
    });
    /**
     * The VERTICAL's half of a provision runs here too — and it did not, which made this
     * route a repair that could not repair.
     *
     * "Re-runs the idempotent provision" was only ever true of the kernel half: roles
     * projected, owner seated. Everything a vertical does for itself at provision — the
     * service principals ticket0 mints, the site another registers — was skipped, so a
     * scope could be reconciled as often as you liked and still be missing whatever its
     * own hook creates. That is worst exactly where it matters most: an install that
     * predates a new service principal has no other way to receive one, since
     * `/internal/provision` is called at install and never again.
     *
     * `onProvision` is required to be idempotent (this route and the drain's retry both
     * re-run it), so calling it here asks nothing new of a vertical. `slug` and `name`
     * are absent — the platform does not carry them on a reconcile, and both are
     * optional for exactly this kind of caller.
     */
    await deps.onProvision?.(c.env, {
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      ...(body.entitlements ? { entitlements: body.entitlements } : {}),
      ...(body.identityLinks ? { identityLinks: body.identityLinks } : {}),
      ...(body.connectionGrants ? { connectionGrants: body.connectionGrants } : {}),
      ...(body.connectionKeys ? { connectionKeys: body.connectionKeys } : {}),
    });
    return c.json({
      tenantId: body.tenantId,
      scopeId: body.scopeId,
      owner,
      ...switchedOffAnswer(reconciled?.switchedOff),
    });
  });

  // Upsert per-instance config on the platform's instruction (vertical-auth-detach.md
  // §2.2) — the delivery half of the dashboard's Env tab, and how a scope's `substrat:auth`
  // issuer choice arrives. Idempotent upserts; keyed by scope.
  app.post('/internal/configure', async (c) => {
    if (!deps.onConfigure) {
      throw new HTTPException(501, { message: 'this vertical stores no per-instance config' });
    }
    const body = configureBody.parse(await c.req.json());
    await deps.onConfigure(c.env, body);
    return c.json({ scopeId: body.scopeId, entries: body.entries.length });
  });

  // The owner seat (#925), read and claimed on the platform's instruction. Both answer 501
  // without a hook, so a control plane can tell "this vertical binds logins some other way"
  // from a failure. The claim link is the ONE `/internal` answer that carries a credential,
  // and it is allowed to precisely because nothing persists it: the vertical holds a hash,
  // the platform relays it once, the dashboard shows it. Parsed on the way OUT as well as in
  // — a hook returning the wrong shape is a 400 here, never a half-rendered seat upstream.
  app.get('/internal/owner-seat', async (c) => {
    if (!deps.ownerSeat) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner seat' });
    }
    const ref = {
      tenantId: tenantIdOf.parse(c.req.query('tenantId')),
      scopeId: scopeIdOf.parse(c.req.query('scopeId')),
    };
    return c.json(ownerSeat.parse(await deps.ownerSeat(c.env, ref)));
  });

  app.post('/internal/owner-claim', async (c) => {
    if (!deps.mintOwnerClaim) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner seat' });
    }
    const body = ownerClaimBody.parse(await c.req.json());
    const link = await deps.mintOwnerClaim(
      c.env,
      { tenantId: body.tenantId, scopeId: body.scopeId },
      { origin: body.origin },
    );
    if (!link) {
      throw new HTTPException(409, {
        message: `the owner seat of scope ${body.scopeId} is already claimed — nothing to mint a claim link for`,
      });
    }
    return c.json(ownerClaimLink.parse(link), 201);
  });

  // The owner HAND-OVER (#1665), on the platform's instruction, which audits it. Four writes in
  // two Durable Objects, with no transaction spanning them, so the ORDER is the contract:
  //
  //   1. the record: the identity directory moves `owner_of_record` from→to and opens the
  //      hand-over. Every refusal is decided here or in the role read just before it, before
  //      anything is written;
  //   2. the seat: `to` is granted the owner role at scope level;
  //   3. the revoke: `from`'s owner role is tombstoned;
  //   4. the close: the directory marks this hand-over done.
  //
  // `to` is seated before `from` is revoked, so the scope never has zero live owner seats. The
  // record moves FIRST so that a failure part-way never leaves an extra seat that nothing
  // recorded. Stopped after 1: the record names `to` while `from` still holds the seat, and a
  // lockout repair in that window re-seats `to`, the owner the caller asked for. Stopped after
  // 2 or 3: both may be seated, the record names `to`. Re-sending the same hand-over reads
  // `already` at step 1 and runs 2–4 again, which are idempotent; after step 4 it reads `done`
  // and writes NOTHING, so a stale retry cannot re-seat or revoke over what the scope decided
  // since. There is always exactly one owner of record. A hand-over that can no longer finish
  // (`to` removed after step 1: its resend is `wedged`, every other one `in-flight`) is closed by
  // `abandon: true`, which seats and revokes nothing.
  //
  // `from` loses the owner ROLE at scope level only: its login stays bound and any other grant
  // it holds stays, so a former owner who should keep working is re-invited or re-granted.
  app.post('/internal/owner-transfer', async (c) => {
    const body = ownerTransferBody.parse(await c.req.json());
    const ref = { tenantId: body.tenantId, scopeId: body.scopeId };
    const pair = { from: body.from, to: body.to };
    // Staff's way out of a hand-over that can no longer finish: close the open pair as
    // abandoned. No seat, no revoke; the record stays on `to`, and a new hand-over starts there.
    if (body.abandon) {
      const roles = deps.hostFor(c.env);
      if (!deps.abandonOwnerTransfer || !roles.hasScopeRoleLocal) {
        throw new HTTPException(501, { message: 'this vertical cannot abandon a hand-over' });
      }
      const toHoldsRole = await roles.hasScopeRoleLocal(body.tenantId, body.scopeId, body.to);
      const closed = ownerTransferAbandon.parse(await deps.abandonOwnerTransfer(c.env, ref, { ...pair, toHoldsRole }));
      if (closed === 'not-open') {
        throw new HTTPException(409, {
          message: `scope ${body.scopeId} has no open hand-over ${body.from} → ${body.to} to abandon`,
        });
      }
      if (closed === 'healthy') {
        throw new HTTPException(409, {
          message: `scope ${body.scopeId}: the hand-over ${body.from} → ${body.to} can still finish — resend it instead`,
        });
      }
      const abandoned: OwnerTransferResult = {
        scopeId: body.scopeId,
        from: body.from,
        owner: body.to,
        outcome: 'abandoned',
        fromRevoked: false,
      };
      return c.json(abandoned);
    }
    if (!deps.transferOwner || !deps.completeOwnerTransfer) {
      throw new HTTPException(501, { message: 'this vertical keeps no owner seat' });
    }
    const host = deps.hostFor(c.env);
    if (!host.assignScopeRole || !host.revokeScopeRole || !host.hasScopeRoleLocal) {
      return c.json({ error: 'this deployment cannot seat a new owner (#1665) — redeploy it. Nothing was moved.' }, 501);
    }
    // A bound login is not enough: `to` must still hold a role here. A member removed by
    // revoking their role keeps the binding, and handing them the scope would seat someone
    // the scope already let go. Read before step 1 and decided by the directory, which judges
    // an open hand-over first so a refusal names the real state; a refusal writes nothing.
    const toHoldsRole = await host.hasScopeRoleLocal(body.tenantId, body.scopeId, body.to);
    const record = ownerTransferRecord.parse(await deps.transferOwner(c.env, ref, { ...pair, toHoldsRole }));
    if (record.outcome === 'refused') {
      const open = record.inFlight ? ` (${record.inFlight.from} → ${record.inFlight.to})` : '';
      throw new HTTPException(409, { message: `scope ${body.scopeId} ${ownerTransferRefusal[record.reason]}${open}` });
    }
    if (record.owner !== body.to) {
      // A hook answering success for a principal nobody asked for: stop before any seat moves.
      throw new HTTPException(500, { message: 'the owner-transfer hook answered a different owner than `to`' });
    }
    const answer = { scopeId: body.scopeId, from: body.from, owner: body.to, outcome: record.outcome };
    if (record.outcome === 'done') return c.json({ ...answer, fromRevoked: false } satisfies OwnerTransferResult);
    await host.assignScopeRole(body.scopeId, body.to, deps.ownerRoleKey);
    const fromRevoked = await host.revokeScopeRole(body.scopeId, body.from, deps.ownerRoleKey);
    if (!(await deps.completeOwnerTransfer(c.env, ref, pair))) {
      // Seated and revoked, but the hand-over was no longer the open one to close: it was
      // abandoned (or closed) while this ran. Not a success to report quietly, and not a 409
      // either — a 409 here means "nothing was written", and a seat and a revoke were. A 500,
      // which the platform audits as `failed`.
      const message =
        `scope ${body.scopeId}: seated ${body.to} and revoked ${body.from}'s owner seat, but the hand-over ` +
        `${body.from} → ${body.to} was no longer open to close — it was abandoned or closed meanwhile; check the owner seats`;
      console.error(`owner-transfer: ${message}`);
      throw new HTTPException(500, { message });
    }
    return c.json({ ...answer, fromRevoked } satisfies OwnerTransferResult);
  });

  // ── The guaranteed error envelope — the whole point (#510). Without this, Hono answers
  //    an uncaught throw with the runtime's bare "Internal Server Error" and the control
  //    plane relays that with no diagnosis. Here every failure becomes { error: <message> },
  //    which vertical-client.refusal() passes through intact. Registered LAST so it wins. ──
  app.onError((err, c) => {
    // The shared vocabulary (`./errors.ts`) decides the status. It also answers "no
    // opinion", which THIS surface turns into the caller's 400 — the control plane
    // relays the status verbatim and retries 5xx, so an unrecognised throw must not
    // claim to be the platform's fault. `mountOperations` answers no-opinion differently.
    // A vertical's own `mapError` outranks it and is rendered the same way, so its
    // answer is a problem document too rather than the last `{ error }` on the surface.
    const mapped = deps.mapError?.(err);
    const seen = mapped
      ? { status: mapped.status as ContentfulStatusCode, message: mapped.message }
      : (classifyError(err) ?? {
          status: 400 as ContentfulStatusCode,
          message: messageOf(err),
        });
    // An infrastructure fault is the PLATFORM failing, not the request (#559). Defaulting
    // it to 400 taught every layer above to treat a Cloudflare outage as the caller's
    // fault — the control plane relays the status verbatim, and its retry convention
    // (install path) deliberately retries 5xx while surfacing 4xx immediately, so the
    // misclassification also disarmed any retry. 502 is the honest answer. Log it
    // structured so the vertical's observability keeps stage + reference queryable.
    if (seen.platformFault) {
      console.error('vertical-host.platform-fault', {
        method: c.req.method,
        path: c.req.path,
        detail: seen.message,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    const { body } = problemOf(seen, err, c.req.path);
    return c.body(JSON.stringify(body), seen.status, {
      'content-type': PROBLEM_CONTENT_TYPE,
    });
  });
}

export * from './operations-routes.js';
export { requestConnectUrl, ConnectUrlRequestError } from './connect-url.js';
export type { ConnectUrlRequest } from './connect-url.js';
export * from './mcp.js';
export * from './public-surface.js';
// #1672: the link-share exchange — a capability's secret traded for an HttpOnly session.
export * from './capability-exchange.js';
// #1706: calling another vertical of the same tenant, from harness code.
export * from './peer-client.js';
// #1859: the live-read route — the Origin gate and the pure host's 501, once.
export * from './live.js';
// #1978: moving here from the kernel — the request log, the router assertion and the
// platform-call check every deployed vertical mounts.
export * from './invocation-log.js';
export * from './routed-node.js';
export * from './platform-call.js';
export {
  classifyError,
  isPlatformFault,
  messageOf,
  problemFor,
  problemOf,
  problemResponse,
} from './errors.js';
export type { ClassifiedProblem, ErrorClassification } from './errors.js';
