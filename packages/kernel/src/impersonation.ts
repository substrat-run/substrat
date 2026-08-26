/**
 * Acting as a principal with the real actor preserved (K-42, #868).
 *
 * Supporting a live vertical otherwise means asking a customer to screenshot
 * things. Every platform bolts this on later as a session swap that LOSES the
 * real actor, which is the version that fails an audit — the trail says the
 * customer did it, and nothing anywhere says who actually did.
 *
 * The mechanism was already built (K-20 per-person staff actors, K-34's
 * kernel-stamped `authorization`, the admin and access logs). What was missing is
 * a seam, and this is it: the two rules that make the seam honest, plus the
 * stamping both adapters share so they cannot drift on either.
 *
 * ## Rule 1 — the permission model sees the IMPERSONATED principal
 *
 * A stub minted here is an ordinary stub whose `CheckSubject` is the person being
 * acted as. `ctx.check` therefore answers exactly what it would answer for them,
 * which is the entire point: the question support is asking is *what does Anna
 * see*, and an answer computed against anyone else's authority is not that.
 *
 * The issue floated intersecting with the staff actor's own permissions as the
 * conservative alternative, and it cannot be built: a `PlatformActorId` is branded
 * distinctly from a `PrincipalId` (K-20) precisely because a staff member is not a
 * person in any tenant, so they hold no scope tuples at all and the intersection
 * is empty for every key. What gates WHO may impersonate is therefore the mint —
 * a platform verb, admin-logged before the session exists — not the checker.
 *
 * ## Rule 2 — every record keeps BOTH
 *
 * `actor` stays the impersonated principal (whose authority the write ran under)
 * and `impersonation` names the person behind it. Stamped kernel-side exactly like
 * `authorization`: it is absent from `DomainEventInput`, so module code can
 * neither supply it nor suppress it. The outbox, the denial log and the platform
 * intent journal all carry it, which is every record a scope writes about who did
 * what.
 *
 * ## Bounded, and reason-carrying
 *
 * `expiresAt` is stamped HERE from the host's clock rather than taken from the
 * caller, capped at `IMPERSONATION_MAX_MINUTES`. A session a caller can extend
 * indefinitely is a standing key with a nicer name. `reason` is required by the
 * schema for the same reason the conformance kit requires `because`: the one
 * moment the reason is knowable is when the session is opened.
 */
import {
  IMPERSONATION_MAX_MINUTES,
  IMPERSONATION_REASON_MAX,
  impersonation as impersonationSchema,
  impersonationRequest,
  platformActorId,
  substratError,
  type Impersonation,
  type ImpersonationRequest,
  type Instant,
  type PlatformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';

/** The ceiling, in milliseconds — the only place the minutes become a duration. */
const MAX_MS = IMPERSONATION_MAX_MINUTES * 60_000;

/**
 * Turn what a caller asked for into the session both adapters record.
 *
 * `now` is the host's clock (the same seam `ctx.now()` reads), so a frozen-clock
 * test can drive expiry rather than wait for it.
 *
 * A requested `expiresAt` is honoured only while it is SHORTER than the ceiling —
 * a caller may bound itself more tightly than the platform does, never less — and
 * one already in the past is refused rather than clamped: it means the caller
 * computed a window from a clock that disagrees with this host's, and silently
 * handing back a live session would be the wrong way to resolve that.
 */
export function stampImpersonation(request: ImpersonationRequest, now: Instant): Impersonation {
  const asked = impersonationRequest.parse(request);
  const ceiling = new Date(Date.parse(now) + MAX_MS).toISOString();
  if (asked.expiresAt !== undefined && Date.parse(asked.expiresAt) <= Date.parse(now)) {
    throw substratError(
      'validation_failed',
      `impersonation expiresAt ${asked.expiresAt} is not in the future (host clock reads ${now})`,
    );
  }
  const expiresAt =
    asked.expiresAt !== undefined && Date.parse(asked.expiresAt) < Date.parse(ceiling)
      ? asked.expiresAt
      : ceiling;
  return impersonationSchema.parse({ by: asked.by, reason: asked.reason, expiresAt });
}

/** What a refused staff mint leaves in the admin log — bounded, and never the raw ask. */
export interface ImpersonationRejection {
  /** Who asked. The admin log needs an actor, and this is the only one there is. */
  staff: PlatformActorId;
  /** The `after` payload, shaped like the accepted entry's so the two read side by side. */
  after: {
    principal: PrincipalId;
    reason: string | null;
    expiresAt: string | null;
    rejected: string;
  };
}

/**
 * Describe a staff mint that `stampImpersonation` REFUSED, so the attempt is
 * audited rather than silent (#915 review).
 *
 * A rejection is the interesting half of the log: an expired window or an empty
 * reason is what a probe looks like, and the accepted entries alone would show a
 * clean history of exactly the sessions that worked. Written as its own action
 * rather than as an `impersonate` entry with a flag — a reader filtering the log
 * for who acted as whom must not have to know that some of those rows are attempts.
 *
 * Everything here comes off an input that failed validation, so nothing is trusted:
 * `reason` and the error text are truncated to the same ceiling the schema enforces,
 * and a `by` that names no platform actor returns `null` — a request that never said
 * who was asking cannot be attributed to anyone, and inventing an actor to hold it is
 * the laundering this feature exists to prevent. That case is refused before any
 * scope work happens, and the caller still gets the throw.
 */
export function impersonationRejection(
  request: ImpersonationRequest,
  principal: PrincipalId,
  error: unknown,
): ImpersonationRejection | null {
  const by: unknown = (request as { by?: unknown })?.by;
  const staff = platformActorId.safeParse(
    typeof by === 'object' && by !== null ? (by as { staff?: unknown }).staff : undefined,
  );
  if (!staff.success) return null;
  const bounded = (value: unknown): string | null =>
    typeof value === 'string' ? value.slice(0, IMPERSONATION_REASON_MAX) : null;
  return {
    staff: staff.data,
    after: {
      principal,
      reason: bounded((request as { reason?: unknown })?.reason),
      expiresAt: bounded((request as { expiresAt?: unknown })?.expiresAt),
      rejected:
        bounded(error instanceof Error ? error.message : String(error)) ?? 'impersonation refused',
    },
  };
}

/**
 * Refuse an invoke made after the session's window closed.
 *
 * Checked per INVOKE rather than at mint, because a stub is minted once and used
 * for as long as its holder keeps it — checking only at mint would make the bound
 * decorative. `forbidden` rather than `unauthenticated`: whoever is calling is
 * perfectly well identified, and it is the acting-as that has lapsed.
 */
export function assertImpersonationLive(session: Impersonation, now: Instant): void {
  if (Date.parse(now) >= Date.parse(session.expiresAt)) {
    throw substratError(
      'forbidden',
      `impersonation session expired at ${session.expiresAt} — mint a new one to keep acting as this principal`,
    );
  }
}

/** How the impersonator reads in a log line: `staff:01J…` or a bare principal id. */
export function impersonatorLabel(session: Impersonation): string {
  return typeof session.by === 'string' ? session.by : `staff:${session.by.staff}`;
}
