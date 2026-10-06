import {
  instant,
  orgId,
  principalId,
  z,
  type DomainEvent,
  type EntityRef,
  type HistoryEntry,
  type OrgId,
  type PlatformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { isUnknownRoleError } from './permission-checker.js';
import { refuseDelivery, type DeliveryRefusal } from './delivery-refusal.js';
import {
  type ExecutorRetryPolicy,
  type ExecutorScope,
  type HostAdmin,
  type MembershipChangeResult,
  type ScopeHost,
} from './scope-host.js';

/**
 * The membership executor (K-22 §4.2, membership.md §4.2; #1184) — the out-of-band half of
 * joining and leaving, written once so a host mounts it instead of hand-rolling the effect.
 *
 * Module code asks in its own transaction and this effects after commit, through `HostAdmin`:
 * an invite engine's accept emits `member.add-requested`; a vertical's removal emits
 * `member.remove-requested`. A rolled-back operation leaves no event and nothing to effect.
 * Both are driven inline by the emitting call, with the outbox and `_substrat_deliveries` as
 * the retry backstop, so the common case completes inside the request.
 *
 * **What it effects: a tenant-level role, and — opted into — the org.** An add assigns the
 * invited role at the tenant node; a removal unassigns it. By default neither joins nor leaves
 * the org both payloads name (the invites engine keys its invitations by org). A mount with
 * `orgs: 'join'` (#2047) also joins it on an add and takes the person out of it on a removal, in
 * the same directory unit as the role, bounded by MEMBERSHIP: the inviter or remover must be a
 * live member of that org. A member holds everything the org confers, at every node — its
 * grants in each scope's own store included — so that is the exact bound, and no scope store
 * is read. A tenant admin who is not a member of the org cannot invite anyone into it, by
 * design. A join's membership expires no later than the inviter's own: a temporary member
 * cannot confer a permanent one.
 *
 * **Authority.** Every payload field is module-written, so none of them is authority.
 *
 * - An ADD is bounded by the inviter: the kernel-stamped `actor` of the invitation's own
 *   `invites.sent` event, asked through the K-21 set comparison at the tenant node. Asked
 *   twice: early, to refuse cheaply, and again inside the directory unit that writes the role
 *   (`applyMembership`), so a demotion, a grant lost or a role widened in between is not
 *   written past. The joiner is the request's own actor, who must have made the invitation's
 *   first acceptance, and the request must be the first one naming that invitation: one
 *   invitation, one join. The most a module can do is make the principal who actually invoked
 *   it look like the sender — the same delegation bound `ctx.grant` has.
 * - A REMOVE is bounded by the remover, the request's own actor (§5.1: removal takes the
 *   same bound, or a junior admin could strip a role they could not have granted) — asked the
 *   same two ways, so a remover demoted in between removes nobody.
 *
 * **Removal wins.** An add is refused when the joiner was removed after it was requested: by a
 * later `member.remove-requested` on the same membership (ordered by outbox id), or by any
 * tenant-level removal at all — staff's included, and a no-op one — which raises the person's
 * removal fence in the directory unit that revokes. The add's own unit reads the fence, and a
 * fence at or after `occurredAt - MEMBERSHIP_REMOVAL_SKEW_MS` refuses it.
 *
 * A refusal is terminal (`refuseDelivery`): journaled with its reason, never retried, listed
 * by `executorDeadLetters`, and reported to the emitting call through `onExecutorOutcomes`.
 *
 * **The trail.** Admin rows are written by `actor`, the platform identity that executed them,
 * `onBehalfOf` (#977) the person whose authority bounded them, and with `causedBy` = the event
 * id: the correlation id that joins the scope's half of the trail to the directory's. A
 * removal that took nothing writes no row (K-21), but still raises the fence.
 *
 * **Idempotent.** A delivered event never reaches its handler again. A crash between the
 * effect and its journal row re-runs the handler, and every write it makes is idempotent.
 */

// Runtime global, declared rather than imported, as in `module-log.ts`: this package compiles
// against `lib: ["ES2023"]` with no DOM and no workers types.
declare const console: { warn(message: string): void };

/** What the add path consumes, and the version it reads. */
export const MEMBER_ADD_REQUESTED = 'member.add-requested';
/** What the remove path consumes, and the version it reads. */
export const MEMBER_REMOVE_REQUESTED = 'member.remove-requested';

/** The delivery-journal id of the add path unless a mount names another (`executor:membership`). */
export const MEMBERSHIP_EXECUTOR_ID = 'membership';
/** The remove path's id, derived from the add path's: `<id>-remove`. */
export const membershipRemoveExecutorId = (id: string = MEMBERSHIP_EXECUTOR_ID): string => `${id}-remove`;

/** The membership entity both requests are emitted on — what orders a removal after an add. */
export const membershipEntity = (principal: string): EntityRef => ({ entityType: 'membership', entityId: principal });

/** The executor's own parse of an add (D-19: never the producer's types). */
const memberAddRequested = z.object({
  principal: principalId,
  orgId,
  tenantId: z.string(),
  roleKey: z.string().min(1),
  invitationId: z.string().min(1),
});

/**
 * `member.remove-requested` v1 — what a vertical emits to take someone out: the role it
 * holds them at, and the org its invitation named. Fat (D-19), like the add. The executor
 * takes the role away; the org is the vertical's own vocabulary and is not touched.
 */
export const memberRemoveRequestedPayload = z.object({
  principal: principalId,
  orgId,
  tenantId: z.string(),
  roleKey: z.string().min(1),
});
export type MemberRemoveRequestedPayload = z.infer<typeof memberRemoveRequestedPayload>;

/** What `invites.sent` and `invites.accepted` must agree with the request on. */
const invitationFacts = z.object({ orgId: z.string(), roleKey: z.string() });
const acceptedFacts = z.object({ principal: z.string() });

export interface MembershipExecutorOptions {
  /** The add path's delivery-journal id (`executor:<id>`). Default `MEMBERSHIP_EXECUTOR_ID`. */
  id?: string;
  /** The platform identity the admin rows record as having executed the write. */
  actor: PlatformActorId;
  /**
   * Where the role is assigned and removed, and the bound asked: the tenant node, and only
   * there. Optional, and `'tenant'` is the only value it takes. A scope-level role lives in
   * the scope's store while membership lives in the directory, and no single operation spans
   * the two, so a scope-level add could always interleave with a removal between its writes.
   * A scope role has its own atomic check-and-grant: `assignScopeRoleBounded`.
   */
  level?: 'tenant';
  /**
   * What happens to the org a request names (#2047). `'ignore'`, the default: nothing — the org
   * is the vertical's own vocabulary, and only the role is effected. `'join'`: an add joins it
   * and a removal takes the person out of it, beside the role and in the same unit, bounded by
   * the inviter's or remover's own live membership of it (`MembershipChange.orgId`).
   */
  orgs?: 'ignore' | 'join';
  retry?: ExecutorRetryPolicy;
}

/**
 * How far before a request a removal still wins over it (#1184): 5 minutes. A removal's fence
 * is stamped by the directory's clock; the request is a scope event stamped by the scope's.
 * The two stores share no causal order, so a tie goes to the removal and so does anything
 * within this skew. The cost, stated: someone removed less than this before they accept a NEW
 * invite is refused — resend it. Removals through the seam are also ordered by outbox id.
 */
export const MEMBERSHIP_REMOVAL_SKEW_MS = 5 * 60_000;

/** Mount the membership executor — both paths — on a host. One call, at host construction. */
export function registerMembershipExecutor(host: ScopeHost, options: MembershipExecutorOptions): void {
  if (options.level !== undefined && options.level !== 'tenant') {
    throw new Error(
      `the membership executor is tenant-level only (got level '${String(options.level)}'): no single operation ` +
        'spans the directory and a scope store. A scope role has assignScopeRoleBounded.',
    );
  }
  const id = options.id ?? MEMBERSHIP_EXECUTOR_ID;
  // The org a request names rides along only on a mount that joins orgs (#2047).
  const orgOf = (request: { orgId: OrgId }): { orgId?: OrgId } => (options.orgs === 'join' ? { orgId: request.orgId } : {});
  // Attributed (#977): the person whose authority bounded the write, beside the platform
  // actor that executed it — added to the `admin` the dispatch handed the handler, which
  // already carries the event (#2069). A host built before `HostAdmin.attributed` (an adapter
  // at 0.139) hands an admin without it but has the deprecated `host.attributed(…, { causedBy })`,
  // so that form is the fallback, and is why it is kept. A host with neither predates #977 and
  // records no person on any row; that is said aloud rather than lost quietly.
  const adminFor = (admin: HostAdmin, who: PrincipalId, event: DomainEvent): HostAdmin => {
    const onBehalfOf = { principal: who, tenantId: event.tenantId };
    if (admin.attributed) return admin.attributed(onBehalfOf);
    if (host.attributed) return host.attributed(onBehalfOf, { causedBy: event.id }).admin;
    console.warn(`executor:${id}: this host cannot attribute an admin to a person; ${event.id}'s rows name no onBehalfOf`);
    return admin;
  };

  host.registerExecutor(
    id,
    MEMBER_ADD_REQUESTED,
    async (admin, event, scope) => {
      const decided = await authorizeAdd(event, scope);
      if ('refused' in decided) return decided.refused;
      const { request, inviter } = decided;
      // One directory unit: the fence, the bound asked again, the role and its audit row. A
      // removal or a change of authority lands wholly before it or wholly after it.
      const applied = await adminFor(admin, inviter, event).applyMembership(options.actor, {
        op: 'add',
        tenantId: event.tenantId,
        principal: request.principal,
        roleKey: request.roleKey,
        boundedBy: inviter,
        ...orgOf(request),
        unlessRemovedSince: instant.parse(new Date(Date.parse(event.occurredAt) - MEMBERSHIP_REMOVAL_SKEW_MS).toISOString()),
      });
      return applied.applied ? undefined : refusalOf(applied, request, 'inviter', inviter);
    },
    options.retry,
  );

  host.registerExecutor(
    membershipRemoveExecutorId(id),
    MEMBER_REMOVE_REQUESTED,
    async (admin, event, scope) => {
      const decided = await authorizeRemove(event, scope);
      if ('refused' in decided) return decided.refused;
      const { request, remover } = decided;
      // One directory unit: the remover's bound asked again, the revoke, its audit row if it
      // took anything, and the fence — raised even with nothing held, so a pending add sees it.
      const applied = await adminFor(admin, remover, event).applyMembership(options.actor, {
        op: 'remove',
        tenantId: event.tenantId,
        principal: request.principal,
        roleKey: request.roleKey,
        boundedBy: remover,
        ...orgOf(request),
      });
      return applied.applied ? undefined : refusalOf(applied, request, 'remover', remover);
    },
    options.retry,
  );
}

/** Why a directory unit applied nothing, as the refusal the journal keeps. */
function refusalOf(
  result: Exclude<MembershipChangeResult, { applied: true }>,
  request: { principal: PrincipalId; roleKey: string },
  as: 'inviter' | 'remover',
  who: PrincipalId,
): DeliveryRefusal {
  if ('removedAt' in result) return refuseDelivery(`${request.principal} was removed after this request was made`);
  if ('unknownRole' in result) return refuseDelivery(`no such role in this tenant: ${result.unknownRole}`);
  if ('unknownOrg' in result) return refuseDelivery(`no such org in this tenant: ${result.unknownOrg}`);
  if ('notMember' in result) return refuseDelivery(`the ${as} ${who} is not a member of org ${result.notMember}`);
  return refuseDelivery(`the ${as} ${who} no longer holds ${result.missing.join(', ')}, which '${request.roleKey}' confers`);
}

type Refused = { refused: DeliveryRefusal };
const refused = (reason: string): Refused => ({ refused: refuseDelivery(reason) });

/** Parse a request and hold it to its own envelope's tenant. Version 1 is the one read. */
function requestOf<T extends { tenantId: string }>(
  event: DomainEvent,
  schema: z.ZodType<T>,
): { request: T } | Refused {
  if (event.schemaVersion !== 1) return refused(`unsupported ${event.type} schemaVersion ${event.schemaVersion}`);
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) return refused(`malformed ${event.type} payload`);
  // The tenant on the envelope is kernel-stamped; the one in the payload is not.
  if (parsed.data.tenantId !== event.tenantId) return refused('the request names a tenant other than its own');
  return { request: parsed.data };
}

/** §5.1's bound for `who` over `roleKey` at the tenant node, or the refusal saying what is missing. */
async function bounded(
  scope: ExecutorScope,
  who: PrincipalId,
  roleKey: string,
  as: 'inviter' | 'remover',
): Promise<Refused | null> {
  // Read the way the unit's own answer is, so one `refusalOf` words both.
  let refusal: Exclude<MembershipChangeResult, { applied: true }> | null;
  try {
    const bound = await scope.covers(who, roleKey, 'tenant');
    refusal = bound.covered ? null : { applied: false, missing: bound.missing };
  } catch (err) {
    if (!isUnknownRoleError(err, roleKey)) throw err;
    refusal = { applied: false, unknownRole: roleKey };
  }
  return refusal && { refused: refusalOf(refusal, { principal: who, roleKey }, as, who) };
}

/** Everything that decides whether an add may be effected. Reads only. */
async function authorizeAdd(
  event: DomainEvent,
  scope: ExecutorScope,
): Promise<Refused | { request: z.infer<typeof memberAddRequested>; inviter: PrincipalId }> {
  const parsed = requestOf(event, memberAddRequested);
  if ('refused' in parsed) return parsed;
  const { request } = parsed;
  // The joiner is whoever invoked the accept — the envelope's actor, not a payload claim.
  if (event.actor !== request.principal) return refused('the request names a principal other than the one who accepted');

  const history = await everything(scope, { entityType: 'invitation', entityId: request.invitationId });
  const sent = history.filter((e) => e.type === 'invites.sent');
  if (sent.length !== 1) return refused(`invitation ${request.invitationId} has no single send to take authority from`);
  const send = sent[0]!;
  const sendFacts = invitationFacts.safeParse(send.payload);
  if (!sendFacts.success || sendFacts.data.orgId !== request.orgId || sendFacts.data.roleKey !== request.roleKey) {
    return refused(`the request does not match invitation ${request.invitationId} as it was sent`);
  }
  // Single use: the FIRST acceptance decides who joins. A later one — by anyone — joins
  // nobody, and cannot unseat the first, whose delivery may still be retrying.
  const first = history.find((e) => e.type === 'invites.accepted');
  const acceptance = first ? acceptedFacts.safeParse(first.payload) : null;
  if (!acceptance?.success || first!.actor !== event.actor || acceptance.data.principal !== request.principal) {
    return refused(`invitation ${request.invitationId} was not first accepted by ${request.principal}`);
  }
  const inviter = principalId.safeParse(send.actor);
  if (!inviter.success) return refused(`invitation ${request.invitationId} was not sent by a principal`);

  // One invitation, one join. The request must follow the acceptance and be the FIRST
  // request naming this invitation on the joiner's membership — outbox ids are kernel-minted
  // and append-only, so the first request consumes the invitation for good, and a fresh one
  // emitted later (after a removal, say) is refused however its payload reads.
  if (first!.id > event.id) return refused(`the request precedes invitation ${request.invitationId}'s acceptance`);
  const membership = await everything(scope, membershipEntity(request.principal));
  const earlier = membership.find(
    (e) => e.type === MEMBER_ADD_REQUESTED && e.id < event.id && invitationOf(e) === request.invitationId,
  );
  if (earlier) return refused(`invitation ${request.invitationId} was already used, by request ${earlier.id}`);

  // A removal through the seam, ordered after this request by outbox id. Every removal also
  // raises the fence `applyMembership` reads inside the unit that writes.
  if (membership.some((e) => e.type === MEMBER_REMOVE_REQUESTED && e.id > event.id)) {
    return refused(`${request.principal} was removed after this request was made`);
  }
  // The early refusal; `applyMembership` asks the same bound again inside its unit.
  const bound = await bounded(scope, inviter.data, request.roleKey, 'inviter');
  return bound ?? { request, inviter: inviter.data };
}

/** Everything that decides whether a removal may be effected. Reads only. */
async function authorizeRemove(
  event: DomainEvent,
  scope: ExecutorScope,
): Promise<Refused | { request: MemberRemoveRequestedPayload; remover: PrincipalId }> {
  const parsed = requestOf(event, memberRemoveRequestedPayload);
  if ('refused' in parsed) return parsed;
  const remover = principalId.safeParse(event.actor);
  if (!remover.success) return refused('the removal was not requested by a principal');
  const bound = await bounded(scope, remover.data, parsed.request.roleKey, 'remover');
  return bound ?? { request: parsed.request, remover: remover.data };
}

/** The invitation an add request names, read the way the executor reads a request. */
function invitationOf(entry: HistoryEntry): string | undefined {
  const parsed = memberAddRequested.safeParse(entry.payload);
  return parsed.success ? parsed.data.invitationId : undefined;
}

/** One entity's whole history, oldest first. Short by construction: a handful of events. */
async function everything(scope: ExecutorScope, entity: EntityRef): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await scope.history(entity, { cursor });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
