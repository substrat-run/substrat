import {
  orgId,
  principalId,
  z,
  type DomainEvent,
  type PlatformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { isUnknownRoleError } from './permission-checker.js';
import {
  refuseDelivery,
  type DeliveryRefusal,
  type ExecutorRetryPolicy,
  type ExecutorScope,
  type ScopeHost,
} from './scope-host.js';
import type { HistoryEntry } from '@substrat-run/contracts';

/**
 * The membership executor (K-22 §4.2, membership.md §4.2; #1184) — the out-of-band half of
 * an invite, written once so a host mounts it instead of hand-rolling the effect.
 *
 * An invite engine runs its state machine in module code and, on accept, emits
 * `member.add-requested` in the accept's own transaction. A rolled-back accept therefore
 * leaves no event and nothing to effect. This executor consumes that event after commit and
 * effects it through `HostAdmin`: the membership in the org, and the role. It is driven
 * inline by the emitting call, with the outbox and `_substrat_deliveries` as the retry
 * backstop, so the common case completes inside the accept request.
 *
 * **Authority.** Every payload field is module-written, so none of them can carry
 * authority. The executor takes the inviter from the kernel-stamped `actor` of the
 * invitation's own `invites.sent` event, then asks the K-21 set comparison whether that
 * inviter, NOW, holds every permission the role carries at the node the role is assigned
 * at. An inviter who was demoted or removed between send and accept is refused. The most a
 * module can do is make it look as though the principal who actually invoked it sent the
 * invite, which bounds it by that principal's authority, the same delegation `ctx.grant`
 * applies. The joiner is the event's own kernel-stamped actor, and the invitation must show
 * exactly one send, and its first acceptance by that actor.
 *
 * A refusal is terminal (`refuseDelivery`): it is journaled with its reason, never retried,
 * and listed by `executorDeadLetters`. The emitting call learns of it through
 * `InvokeOptions.onExecutorOutcomes`.
 *
 * **The trail.** The admin rows are written by `actor`, the platform identity that executed,
 * and through `host.attributed` on behalf of the inviter, whose authority bounded them. Each
 * carries `causedBy` = the event id, the correlation id that joins the scope's half of the
 * trail to the directory's.
 *
 * **Idempotent.** A delivered event never reaches the handler again. A crash between the
 * effect and its journal row re-runs the handler, and both writes are idempotent:
 * `addMember` on a live membership and `assignRole` on a held role change nothing.
 */

/** The event this executor consumes, and the version it reads. */
export const MEMBER_ADD_REQUESTED = 'member.add-requested';

/** The executor's own parse of the request (D-19: never the producer's types). */
const memberAddRequested = z.object({
  principal: principalId,
  orgId,
  tenantId: z.string(),
  roleKey: z.string().min(1),
  invitationId: z.string().min(1),
});

/** What `invites.sent` and `invites.accepted` must agree with the request on. */
const invitationFacts = z.object({ orgId: z.string(), roleKey: z.string() });
const acceptedFacts = z.object({ principal: z.string() });

export interface MembershipExecutorOptions {
  /** The delivery-journal id (`executor:<id>`). Default `membership`. */
  id?: string;
  /** The platform identity the admin rows record as having executed the write. */
  actor: PlatformActorId;
  /**
   * Where the role is assigned, and therefore where the bound is asked: the scope the
   * invite was accepted in, or the tenant node. Never mixed, so authority held in one scope
   * cannot confer a tenant-wide role.
   */
  level: 'scope' | 'tenant';
  retry?: ExecutorRetryPolicy;
}

/** Mount the membership executor on a host. One call, at host construction. */
export function registerMembershipExecutor(host: ScopeHost, options: MembershipExecutorOptions): void {
  host.registerExecutor(
    options.id ?? 'membership',
    MEMBER_ADD_REQUESTED,
    async (_admin, event, scope) => {
      const decided = await authorize(event, scope, options.level);
      if ('refused' in decided) return decided.refused;
      const { request, inviter } = decided;
      // Attributed to the inviter (#977): the person whose authority bounded this write,
      // beside the platform actor that executed it. `causedBy` is stamped by the host.
      const admin = (host.attributed?.({ principal: inviter, tenantId: event.tenantId }) ?? host).admin;
      await admin.addMember(options.actor, event.tenantId, request.principal, request.orgId);
      await admin.assignRole(options.actor, {
        principalId: request.principal,
        roleKey: request.roleKey,
        node: { tenantId: event.tenantId, scopeId: options.level === 'scope' ? event.scopeId : null },
      });
      return undefined;
    },
    options.retry,
  );
}

type Decision =
  | { refused: DeliveryRefusal }
  | { request: z.infer<typeof memberAddRequested>; inviter: PrincipalId };

const refused = (reason: string): Decision => ({ refused: refuseDelivery(reason) });

/** Everything that decides whether the request may be effected. Reads only. */
async function authorize(event: DomainEvent, scope: ExecutorScope, level: 'scope' | 'tenant'): Promise<Decision> {
  if (event.schemaVersion !== 1) return refused(`unsupported ${MEMBER_ADD_REQUESTED} schemaVersion ${event.schemaVersion}`);
  const parsed = memberAddRequested.safeParse(event.payload);
  if (!parsed.success) return refused(`malformed ${MEMBER_ADD_REQUESTED} payload`);
  const request = parsed.data;
  // The tenant on the envelope is kernel-stamped; the one in the payload is not.
  if (request.tenantId !== event.tenantId) return refused('the request names a tenant other than its own');
  // The joiner is whoever invoked the accept — the envelope's actor, not a payload claim.
  if (event.actor !== request.principal) return refused('the request names a principal other than the one who accepted');

  const history = await invitationHistory(scope, request.invitationId);
  const sent = history.filter((e) => e.type === 'invites.sent');
  const accepted = history.filter((e) => e.type === 'invites.accepted');
  if (sent.length !== 1) return refused(`invitation ${request.invitationId} has no single send to take authority from`);
  const send = sent[0]!;
  const sendFacts = invitationFacts.safeParse(send.payload);
  if (!sendFacts.success || sendFacts.data.orgId !== request.orgId || sendFacts.data.roleKey !== request.roleKey) {
    return refused(`the request does not match invitation ${request.invitationId} as it was sent`);
  }
  // Single use: the FIRST acceptance decides who joins. A later one — by anyone — joins
  // nobody, and cannot unseat the first, whose delivery may still be retrying.
  const first = accepted[0];
  const acceptance = first ? acceptedFacts.safeParse(first.payload) : null;
  if (!acceptance?.success || first!.actor !== event.actor || acceptance.data.principal !== request.principal) {
    return refused(`invitation ${request.invitationId} was not first accepted by ${request.principal}`);
  }
  const inviter = principalId.safeParse(send.actor);
  if (!inviter.success) return refused(`invitation ${request.invitationId} was not sent by a principal`);

  try {
    const bound = await scope.covers(inviter.data, request.roleKey, level);
    if (!bound.covered) {
      return refused(
        `the inviter ${inviter.data} no longer holds ${bound.missing.join(', ')}, which '${request.roleKey}' carries`,
      );
    }
  } catch (err) {
    if (isUnknownRoleError(err, request.roleKey)) return refused(`no such role in this tenant: ${request.roleKey}`);
    throw err;
  }
  return { request, inviter: inviter.data };
}

/** The invitation's whole history, oldest first. Short by construction: send, accept, revoke. */
async function invitationHistory(scope: ExecutorScope, invitationId: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await scope.history({ entityType: 'invitation', entityId: invitationId }, { cursor });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
