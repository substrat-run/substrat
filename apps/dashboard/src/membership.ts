import { platformActorId, type PrincipalId } from '@substrat-run/contracts';
import {
  MEMBER_ADD_REQUESTED,
  MEMBER_REMOVE_REQUESTED,
  MEMBERSHIP_EXECUTOR_ID,
  membershipRemoveExecutorId,
  registerMembershipExecutor,
  type ExecutorOutcome,
  type ScopeHost,
} from '@substrat-run/kernel';

/**
 * The dashboard's half of a team invite after the accept commits (#1184).
 *
 * The invites engine emits `member.add-requested` in the accept's transaction. The kernel's
 * membership executor effects it: the org membership and the invited role at the TENANT node,
 * which is where every dashboard role is held. It also re-checks that the person who sent the
 * invite still holds every permission that role carries. Before this, the worker assigned the
 * role by hand after the invoke returned: nothing retried it if the request died in between,
 * and nothing re-checked the sender.
 */

/** The platform identity the dashboard's admin rows record as having executed them. */
export const DASHBOARD_CP_ACTOR = platformActorId.parse('01JZ000000000000000000DASH');

/** Mount the membership executor on a dashboard host — once per host, beside its modules. */
export function registerDashboardMembership(host: ScopeHost): void {
  registerMembershipExecutor(host, { actor: DASHBOARD_CP_ACTOR, level: 'tenant' });
}

/** What the caller is told, read off the call's inline executor outcomes. */
export type EffectVerdict =
  | { kind: 'done' }
  /** Not effected yet — the retry backstop owns it now. */
  | { kind: 'pending' }
  /** Effected never: refused by the bound or a forgery check, or out of attempts. */
  | { kind: 'refused'; reason: string };

/**
 * The verdict for `principal`'s add or remove request among a call's outcomes. No outcome at
 * all reads as pending, never as done: a host that did not report has not said it happened.
 */
export function effectVerdict(
  outcomes: readonly ExecutorOutcome[],
  request: 'add' | 'remove',
  principal: PrincipalId,
): EffectVerdict {
  const [executorId, eventType] =
    request === 'add'
      ? [MEMBERSHIP_EXECUTOR_ID, MEMBER_ADD_REQUESTED]
      : [membershipRemoveExecutorId(), MEMBER_REMOVE_REQUESTED];
  const mine = outcomes.find(
    (o) => o.executorId === executorId && o.eventType === eventType && o.entity === `membership:${principal}`,
  );
  if (mine?.outcome === 'delivered') return { kind: 'done' };
  if (mine?.outcome === 'refused' || mine?.outcome === 'dead-lettered') {
    return { kind: 'refused', reason: mine.error ?? mine.outcome };
  }
  return { kind: 'pending' };
}
