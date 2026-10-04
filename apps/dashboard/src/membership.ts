import { platformActorId, type PrincipalId } from '@substrat-run/contracts';
import { MEMBER_ADD_REQUESTED, MEMBERSHIP_EXECUTOR_ID, registerMembershipExecutor, type ExecutorOutcome, type ScopeHost } from '@substrat-run/kernel';

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

/** What the accepting person is told, read off the accept's inline executor outcomes. */
export type AcceptVerdict =
  | { kind: 'joined' }
  /** Not effected yet — the retry backstop owns it now. */
  | { kind: 'pending' }
  /** Effected never: refused by the bound or a forgery check, or out of attempts. */
  | { kind: 'refused'; reason: string };

/**
 * The verdict for `principal`'s membership request among a call's outcomes. No outcome at all
 * reads as pending, never as joined: a host that did not report has not said it happened.
 */
export function acceptVerdict(outcomes: readonly ExecutorOutcome[], principal: PrincipalId): AcceptVerdict {
  const mine = outcomes.find(
    (o) => o.executorId === MEMBERSHIP_EXECUTOR_ID && o.eventType === MEMBER_ADD_REQUESTED && o.entity === `membership:${principal}`,
  );
  if (mine?.outcome === 'delivered') return { kind: 'joined' };
  if (mine?.outcome === 'refused' || mine?.outcome === 'dead-lettered') {
    return { kind: 'refused', reason: mine.error ?? mine.outcome };
  }
  return { kind: 'pending' };
}
