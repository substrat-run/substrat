/**
 * The kernel half of impersonation (K-42, #868) — what STAMPS a session, what kills an
 * expired one, and what a read-only session may not do.
 *
 * Split out of the adapters for the reason `subject-keys.ts` is: the rules are one set
 * of rules, and two adapters re-deriving "is this session still live" is two chances to
 * get it wrong, with the one that does not obviously broken. Both adapters call
 * `stampImpersonation` at the door and `assertImpersonationLive` on every invoke; the
 * only thing either writes for itself is the SQL.
 *
 * Every function here is pure and clock-injected. Nothing here reads a wall clock — the
 * adapter passes its own (`this.clock()` on the pure adapter, the DO's own instant on the
 * hosted one, which workerd constructs and gives no seam to inject through). That split
 * is why `ttlSeconds` is expressed in seconds: on the pure adapter a frozen clock drives
 * a session past its expiry instantly, and on the hosted one the only thing that CAN is
 * asking for a session short enough to outlive in a test.
 */

import {
  impersonationRequest,
  IMPERSONATION_DEFAULT_TTL_SECONDS,
  SubstratError,
  type Impersonation,
  type ImpersonationRequest,
  type Instant,
} from '@substrat-run/contracts';

/**
 * A session that has run out of time. `unavailable` rather than `permission_denied`:
 * nothing about the caller's authority changed, the window closed — and a console that
 * gets this back should offer to open a NEW session (a new reason, a new admin-log
 * entry), never silently renew the old one.
 */
export class ImpersonationExpired extends SubstratError {
  constructor(session: Impersonation, now: Instant) {
    super(
      'unavailable',
      `impersonation of ${session.principal} by ${session.actor} expired at ` +
        `${session.expiresAt} (now ${now}) — open a new session with a fresh reason`,
    );
  }
}

/**
 * A read-only session tried to write. `permission_denied`, because that is exactly what
 * it is — the session was opened without the authority to mutate, and the refusal is
 * the mechanism doing its job rather than a fault.
 *
 * Deliberately loud. The alternative — let the operation "succeed" and discard its
 * writes — tells a support engineer their fix landed when nothing did, which is worse
 * than either refusing or allowing. The silent rollback still happens underneath
 * (`ctx.sql.exec` is not routed through here), but it is the BACKSTOP, not the contract.
 */
export class ImpersonationReadOnly extends SubstratError {
  constructor(session: Impersonation, verb: string) {
    super(
      'permission_denied',
      `${verb} is refused: ${session.actor} is impersonating ${session.principal} in a ` +
        'read-only session. Re-open it with `writes: true` if the change is intended',
    );
  }
}

/**
 * Mint the session record from what a caller asked for — the K-34 move, applied to a
 * second thing module code must not be able to say about itself.
 *
 * The caller chooses the actor, the principal, the reason and (within the ceiling) the
 * window's LENGTH. The kernel decides when the window opened, when it closes, and
 * whether writes are on — because a session that could name its own `startedAt` could
 * predate its own admin-log entry, and one that could set `readOnly: false` implicitly
 * would default to the dangerous side the first time somebody forgot the flag.
 *
 * `writes` is inverted here rather than carried through, and the inversion is the point:
 * the REQUEST opts in to danger (`writes: true`), the RECORD states safety
 * (`readOnly: true`). An absent field means the safe thing on both sides, which is the
 * only arrangement where forgetting it is harmless.
 */
export function stampImpersonation(request: ImpersonationRequest, now: Instant): Impersonation {
  const parsed = impersonationRequest.parse(request);
  const ttl = parsed.ttlSeconds ?? IMPERSONATION_DEFAULT_TTL_SECONDS;
  const startedAt = now;
  const expiresAt = new Date(Date.parse(startedAt) + ttl * 1000).toISOString() as Instant;
  return {
    actor: parsed.actor,
    principal: parsed.principal,
    reason: parsed.reason,
    startedAt,
    expiresAt,
    readOnly: parsed.writes !== true,
  };
}

/**
 * Throw unless the session is still inside its window — the check both adapters run at
 * the top of EVERY invoke, not once when the stub was minted.
 *
 * Per-invoke is the whole property. A stub is an ordinary JavaScript object a console
 * can hold for as long as it likes, so a check at mint time bounds nothing: the session
 * would be live until the process restarted. Checked here, a held stub simply stops
 * working the moment the window closes, and it stops working the same way in a test
 * with a manual clock as it does in production.
 *
 * The bound is EXCLUSIVE (`now >= expiresAt` is dead), which matters more than it looks:
 * `ctx.now()` is stable for a whole invocation (#812), so an inclusive bound would admit
 * an entire operation that began exactly at expiry.
 */
export function assertImpersonationLive(session: Impersonation, now: Instant): void {
  if (Date.parse(now) >= Date.parse(session.expiresAt)) {
    throw new ImpersonationExpired(session, now);
  }
}

/**
 * Throw when a read-only session reaches a mutating verb on `ctx`.
 *
 * `verb` names the surface being refused (`ctx.emit`, `ctx.grant`, …) rather than the
 * operation, because the operation is usually innocent: the same handler is correct for
 * a real principal and refused here, and the message has to make that obvious to
 * whoever reads it in a console.
 */
export function assertImpersonationWritable(
  session: Impersonation | null,
  verb: string,
): void {
  if (session?.readOnly) throw new ImpersonationReadOnly(session, verb);
}
