import { z } from 'zod';
import { instant, platformActorId, principalId } from './ids.js';

/**
 * Acting as a principal with the real actor preserved (K-42, #868).
 *
 * Supporting a customer's live vertical meant asking them for screenshots: there was
 * no supported way to see what a named principal sees. Every platform bolts this on
 * eventually, and the version it bolts on is a **session swap** — the staff session is
 * exchanged for the customer's, the real actor is lost, and the audit trail says a
 * customer did something a support engineer did. That is precisely the version that
 * fails an audit, and it is the version this shape refuses.
 *
 * An impersonated invocation carries **two** actors. The permission evaluation uses the
 * IMPERSONATED principal — otherwise the session shows what staff can see rather than
 * what the customer can, which is the whole point — and every record keeps BOTH: the
 * event's `actor` is the impersonated principal (it is who the operation acted as) and
 * its `impersonation` names the staff actor who was really at the keyboard, the reason
 * they gave, and the window it was valid in.
 *
 * Kernel-stamped, exactly like K-34's `authorization` and for the same argument:
 * `startedAt`/`expiresAt`/`readOnly` are computed by `stampImpersonation`, the record is
 * absent from `DomainEventInput`, and module code can neither supply it nor suppress it.
 * A vertical can only READ it (`ctx.impersonation`) — enough to render "you are viewing
 * as Anna" on a screen, never enough to launder it away.
 *
 * ## The four questions #868 asked, and the answers this shape encodes
 *
 * - **Whose permissions?** The impersonated principal's. "Intersect with the staff
 *   actor's" was the issue's conservative suggestion, and it does not typecheck against
 *   the model: a `PlatformActorId` is deliberately NOT a `PrincipalId` (K-20) and holds
 *   no tuples in a tenant's scope, so the intersection is always empty and the feature
 *   is always useless. The property that suggestion was reaching for — *our support
 *   engineer must not be able to approve an invoice* — is delivered by `readOnly`
 *   instead, and delivered absolutely rather than by set arithmetic.
 * - **Time-boxed and reason-carrying?** Both, required. K-33's rewind is time-boxed and
 *   audited and this is no less dangerous. `reason` is not optional and not empty: it
 *   rides into the admin log *and* onto every event the session writes.
 * - **Does the admin log entry precede the session?** Yes — `getImpersonatedScope`
 *   records `impersonate` before it returns a stub, so a crash mid-session still leaves
 *   the entry. K-33's failure ordering, for K-33's reason.
 * - **Writes at all?** Read-only by DEFAULT (`writes` unset ⇒ `readOnly: true`), which
 *   is most of the debugging value at a fraction of the argument. A write-enabled
 *   session is a separate, explicit ask by whoever opens it — and it is why the spine
 *   carries the column at all.
 */

/** How long an impersonated session lasts when the caller names no window. */
export const IMPERSONATION_DEFAULT_TTL_MINUTES = 30;
/**
 * The ceiling on one. Four hours is a long support call and a short standing
 * credential; anything past it should be a second session with a second reason, which
 * is a second admin-log entry a reviewer can see.
 */
export const IMPERSONATION_MAX_TTL_MINUTES = 240;

/**
 * What a caller ASKS for. The three fields it may not choose — when the window opened,
 * when it closes, and whether writes are on — are what `stampImpersonation` computes.
 */
export const impersonationRequest = z.object({
  /** The staff actor really acting (K-20's per-person platform actor, never a shared one). */
  actor: platformActorId,
  /** The principal to act AS. Permission evaluation resolves against this one. */
  principal: principalId,
  /**
   * Why. Required and bounded: eight characters is a ticket reference, which is the
   * shortest thing that is actually a reason. An optional reason is a reason nobody
   * fills in, and this string is the only part of the record a reviewer cannot
   * reconstruct from the rest.
   */
  reason: z.string().trim().min(8).max(500),
  /** Minutes the session stays live. Defaults to `IMPERSONATION_DEFAULT_TTL_MINUTES`. */
  ttlMinutes: z.number().int().positive().max(IMPERSONATION_MAX_TTL_MINUTES).optional(),
  /**
   * Opt IN to writes. Absent or false is a read-only session, which is the default
   * because the alternative default is "our support engineer approved an invoice".
   */
  writes: z.boolean().optional(),
});
export type ImpersonationRequest = z.infer<typeof impersonationRequest>;

/**
 * A live impersonated session, as the kernel stamped it — the value on
 * `ctx.impersonation`, in the `impersonate` admin-log entry, and on every event the
 * session emits.
 *
 * Frozen on the way out like any published shape: a consumer reading `impersonation`
 * off a historical event is reading a record written by a build it never saw, so the
 * fields here are additive-only (D-28) exactly as the envelope's are.
 */
export const impersonation = z.object({
  actor: platformActorId,
  principal: principalId,
  reason: z.string().min(1).max(500),
  startedAt: instant,
  /** Exclusive: at `expiresAt` the session is already dead (`assertImpersonationLive`). */
  expiresAt: instant,
  /**
   * False only when the opener explicitly asked for writes. On a read-only session the
   * kernel refuses `emit`, `requestPlatform`, `grant`, `revoke` and `link`, and rolls
   * the invocation back regardless — so a `readOnly: true` record can never appear on a
   * spine row, and its presence here is always the write-enabled case.
   */
  readOnly: z.boolean(),
});
export type Impersonation = z.infer<typeof impersonation>;
