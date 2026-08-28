import { z } from 'zod';
import { instant, platformActorId, principalId, scopeId, tenantId } from './ids.js';

/**
 * Acting as a principal with the REAL actor preserved (K-42, #868).
 *
 * Supporting a customer's live vertical means seeing what a named person sees.
 * Every platform grows that surface eventually, and the version that grows by
 * itself is a session swap: the staff member becomes the user, and the trail
 * says the user did it. That is the version an audit fails.
 *
 * So an impersonated operation carries **two** actors. The permission model
 * answers as the impersonated principal — that is the whole point, and an
 * intersection with the staff actor's own authority would be empty, because a
 * platform actor is not a principal in any tenant and holds no scope permissions
 * at all (`PlatformActorId` is branded apart from `PrincipalId` for exactly that
 * reason). What bounds the session instead is its MODE, its clock and its
 * reason: `read-only` unless someone wrote down why not, expiring on its own,
 * and admin-logged before it can be used.
 *
 * Every record the scope writes about who did what keeps both: the outbox
 * envelope, the denial log, the platform-intent journal. Stamped kernel-side on
 * K-34's pattern — `impersonation` is absent from `DomainEventInput`, so module
 * code can neither claim a session it is not in nor drop the one it is.
 */

/**
 * The hard ceiling on a session's life, in minutes.
 *
 * A support session is bounded because the alternative is a credential: a
 * session with no end is a second way to be that person, held by whoever last
 * opened one. K-33's rewind is time-boxed and audited on the same argument, and
 * the number is deliberately short enough that renewing is the normal case —
 * each renewal being a fresh admin-log row is the feature, not the friction.
 */
export const IMPERSONATION_MAX_MINUTES = 60;

/** What a caller gets by not saying — a quarter hour, well inside the ceiling. */
export const IMPERSONATION_DEFAULT_MINUTES = 15;

/**
 * The floor on a reason, in characters.
 *
 * Not a validation nicety: the reason is the only field of this record a human
 * writes, and 'x' passing means the field is decoration. Short enough that a
 * ticket reference ('#4182 — invoice missing') clears it.
 */
export const IMPERSONATION_MIN_REASON = 8;

/** ULID, minted platform-side. Brands apart from every other id in the tree. */
export const impersonationSessionId = z.string().min(1).brand<'ImpersonationSessionId'>();
export type ImpersonationSessionId = z.infer<typeof impersonationSessionId>;

/**
 * What the session may do, and the answer to #868's last open question.
 *
 * `read-only` is most of the debugging value at a fraction of the argument, so
 * it is the default and it is MECHANICAL: a read-only invocation's transaction
 * is rolled back rather than committed, and the effecting verbs (`emit`,
 * `requestPlatform`, `grant`, `revoke`, `link`) refuse outright, so a support
 * engineer cannot approve an invoice by accident and a vertical cannot arrange
 * for them to. `write` exists because "reproduce the failing save" is a real
 * support task — it just has to be asked for, in a session that says so.
 */
export const impersonationMode = z.enum(['read-only', 'write']);
export type ImpersonationMode = z.infer<typeof impersonationMode>;

/**
 * What staff supply to open a session. The acting actor is NOT here: it is the
 * `PlatformActorId` every `HostAdmin` verb already takes, so it can no more be
 * chosen by the caller than the actor on an admin-log row can.
 */
export const beginImpersonationInput = z.object({
  tenantId,
  scopeId,
  /** WHO to act as. A principal of this tenant; nothing here mints one. */
  principal: principalId,
  /** Why. Recorded on the session and in the admin log, and never optional. */
  reason: z.string().min(IMPERSONATION_MIN_REASON),
  /** Capped at `IMPERSONATION_MAX_MINUTES`; a longer ask is refused, not clamped. */
  minutes: z.number().int().positive().max(IMPERSONATION_MAX_MINUTES).optional(),
  mode: impersonationMode.optional(),
});
export type BeginImpersonationInput = z.infer<typeof beginImpersonationInput>;

/**
 * A session as the directory holds it, and as `listImpersonations` reads it back.
 *
 * `endedAt` is the explicit close. It is distinct from expiry: a session that
 * ran out is over because time passed, one that was ended is over because
 * somebody stopped it, and an incident review wants to be able to tell those
 * apart. Neither is a delete — this record is evidence (K-21's tombstone rule).
 */
export const impersonationSession = z.object({
  id: impersonationSessionId,
  /** The REAL actor: the staff member who opened the session. */
  actor: platformActorId,
  /** The principal being acted as — who the permission model answers about. */
  principal: principalId,
  tenantId,
  scopeId,
  reason: z.string().min(IMPERSONATION_MIN_REASON),
  mode: impersonationMode,
  startedAt: instant,
  expiresAt: instant,
  endedAt: instant.nullable(),
});
export type ImpersonationSession = z.infer<typeof impersonationSession>;

/**
 * The two actors a record keeps — the stamp the kernel puts on an event
 * envelope, a denial row and a platform intent raised under a session.
 *
 * `by` rather than `actor`, because the envelope's `actor` field is already
 * taken and already correct: the impersonated principal is who the permission
 * model answered about and who the domain fact is about. This says who was
 * holding the keyboard, which is a different question with a different answer.
 */
export const impersonationStamp = z.object({
  session: impersonationSessionId,
  by: platformActorId,
});
export type ImpersonationStamp = z.infer<typeof impersonationStamp>;

/**
 * How a caller narrows a read of the session log. `active` is evaluated against
 * the reader's clock — a session neither ended nor expired — because "who is in
 * a customer's data right now" is the question an incident opens with.
 */
export const impersonationFilter = z.object({
  tenantId: z.string().min(1).optional(),
  scopeId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  principal: z.string().min(1).optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ImpersonationFilter = z.infer<typeof impersonationFilter>;

/** How many sessions an unbounded read returns — a screenful, newest first. */
export const DEFAULT_IMPERSONATION_LIMIT = 50;
