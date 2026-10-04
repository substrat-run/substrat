import {
  orgId,
  principalId,
  z,
  type AdminLogEntry,
  type DomainEvent,
  type EntityRef,
  type HistoryEntry,
  type PlatformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { isUnknownRoleError } from './permission-checker.js';
import { refuseDelivery, type DeliveryRefusal } from './delivery-refusal.js';
import {
  type ExecutorRetryPolicy,
  type ExecutorScope,
  type HostAdmin,
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
 * **Authority.** Every payload field is module-written, so none of them is authority.
 *
 * - An ADD is bounded by the inviter: the kernel-stamped `actor` of the invitation's own
 *   `invites.sent` event, asked through the K-21 set comparison NOW, at the node the role is
 *   assigned at. A sender demoted or removed since the send is refused. The joiner is the
 *   request's own actor, who must have made the invitation's first acceptance. The most a
 *   module can do is make the principal who actually invoked it look like the sender — the
 *   same delegation bound `ctx.grant` has.
 * - A REMOVE is bounded by the remover, the request's own actor (§5.1: removal takes the
 *   same bound, or a junior admin could strip a role they could not have granted).
 *
 * **Removal wins.** An add is refused when the joiner was removed AFTER it was requested, by
 * any recorded removal: a later `member.remove-requested` on the same membership, or an
 * `unassignRole` / `removeMember` admin row naming them since the request. The first is the
 * ordering this seam owns — an admin who removes someone whose add is still retrying is not
 * overtaken by the retry. The second covers every removal made outside it, including the
 * ones made by hand before this executor existed: an add requested back then and never
 * effected would otherwise re-admit someone who was removed in the meantime.
 *
 * A refusal is terminal (`refuseDelivery`): journaled with its reason, never retried, listed
 * by `executorDeadLetters`, and reported to the emitting call through `onExecutorOutcomes`.
 *
 * **The trail.** Admin rows are written by `actor`, the platform identity that executed them,
 * `onBehalfOf` (#977) the person whose authority bounded them, and with `causedBy` = the event
 * id: the correlation id that joins the scope's half of the trail to the directory's.
 *
 * **Idempotent.** A delivered event never reaches its handler again. A crash between the
 * effect and its journal row re-runs the handler, and every write it makes is idempotent.
 */

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
 * holds them at and the org they joined. Fat (D-19), like the add.
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
   * Where the role is assigned and removed, and therefore where the bound is asked: the scope
   * the request came from, or the tenant node. Never mixed, so authority held in one scope
   * cannot confer a tenant-wide role.
   */
  level: 'scope' | 'tenant';
  retry?: ExecutorRetryPolicy;
}

/** Mount the membership executor — both paths — on a host. One call, at host construction. */
export function registerMembershipExecutor(host: ScopeHost, options: MembershipExecutorOptions): void {
  const id = options.id ?? MEMBERSHIP_EXECUTOR_ID;
  const nodeOf = (event: DomainEvent) => ({
    tenantId: event.tenantId,
    scopeId: options.level === 'scope' ? event.scopeId : null,
  });
  // Attributed (#977): the person whose authority bounded the write, beside the platform
  // actor that executed it. `causedBy` is stamped by the host.
  const adminFor = (who: PrincipalId, event: DomainEvent): HostAdmin =>
    (host.attributed?.({ principal: who, tenantId: event.tenantId }) ?? host).admin;

  host.registerExecutor(
    id,
    MEMBER_ADD_REQUESTED,
    async (admin, event, scope) => {
      const decided = await authorizeAdd(admin, options.actor, event, scope, options.level);
      if ('refused' in decided) return decided.refused;
      const { request, inviter } = decided;
      const write = adminFor(inviter, event);
      await write.addMember(options.actor, event.tenantId, request.principal, request.orgId);
      await write.assignRole(options.actor, { principalId: request.principal, roleKey: request.roleKey, node: nodeOf(event) });
      return undefined;
    },
    options.retry,
  );

  host.registerExecutor(
    membershipRemoveExecutorId(id),
    MEMBER_REMOVE_REQUESTED,
    async (_admin, event, scope) => {
      const decided = await authorizeRemove(event, scope, options.level);
      if ('refused' in decided) return decided.refused;
      const { request, remover } = decided;
      const write = adminFor(remover, event);
      await write.unassignRole(options.actor, { principalId: request.principal, roleKey: request.roleKey, node: nodeOf(event) });
      await write.removeMember(options.actor, event.tenantId, request.principal, request.orgId);
      return undefined;
    },
    options.retry,
  );
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

/** §5.1's bound for `who` over `roleKey` at the node, or the refusal saying what is missing. */
async function bounded(
  scope: ExecutorScope,
  who: PrincipalId,
  roleKey: string,
  level: 'scope' | 'tenant',
  as: 'inviter' | 'remover',
): Promise<Refused | null> {
  try {
    const bound = await scope.covers(who, roleKey, level);
    return bound.covered
      ? null
      : refused(`the ${as} ${who} no longer holds ${bound.missing.join(', ')}, which '${roleKey}' carries`);
  } catch (err) {
    if (isUnknownRoleError(err, roleKey)) return refused(`no such role in this tenant: ${roleKey}`);
    throw err;
  }
}

/** Everything that decides whether an add may be effected. Reads only. */
async function authorizeAdd(
  admin: HostAdmin,
  actor: PlatformActorId,
  event: DomainEvent,
  scope: ExecutorScope,
  level: 'scope' | 'tenant',
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

  if (await removedSince(admin, actor, scope, event, request.principal)) {
    return refused(`${request.principal} was removed after this request was made`);
  }
  const bound = await bounded(scope, inviter.data, request.roleKey, level, 'inviter');
  return bound ?? { request, inviter: inviter.data };
}

/** Everything that decides whether a removal may be effected. Reads only. */
async function authorizeRemove(
  event: DomainEvent,
  scope: ExecutorScope,
  level: 'scope' | 'tenant',
): Promise<Refused | { request: MemberRemoveRequestedPayload; remover: PrincipalId }> {
  const parsed = requestOf(event, memberRemoveRequestedPayload);
  if ('refused' in parsed) return parsed;
  const remover = principalId.safeParse(event.actor);
  if (!remover.success) return refused('the removal was not requested by a principal');
  const bound = await bounded(scope, remover.data, parsed.request.roleKey, level, 'remover');
  return bound ?? { request: parsed.request, remover: remover.data };
}

/**
 * Whether `principal` was removed after `event` was emitted, by any recorded removal: a later
 * `member.remove-requested` on their membership, or a revoking admin row naming them since.
 */
async function removedSince(
  admin: HostAdmin,
  actor: PlatformActorId,
  scope: ExecutorScope,
  event: DomainEvent,
  principal: PrincipalId,
): Promise<boolean> {
  const membership = await everything(scope, membershipEntity(principal));
  if (membership.some((e) => e.type === MEMBER_REMOVE_REQUESTED && e.id > event.id)) return true;
  const revoked = await admin.auditLog(actor, {
    tenantId: event.tenantId,
    action: ['unassignRole', 'removeMember'],
    since: event.occurredAt,
  });
  return revoked.some((row) => namesPrincipal(row, principal));
}

/** A revoking admin row's subject: `unassignRole` records the assignment, `removeMember` the membership. */
function namesPrincipal(row: AdminLogEntry, principal: PrincipalId): boolean {
  const before = row.before as { principalId?: unknown; principal?: unknown } | null;
  return before?.principalId === principal || before?.principal === principal;
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
