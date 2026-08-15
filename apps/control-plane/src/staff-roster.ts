import { platformActorId, type PlatformActorId } from '@substrat-run/contracts';
import type { StaffActorResolver } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';

/**
 * The staff roster, in D1 (#42).
 *
 * Replaces a comma-separated env var that mapped every rostered email to ONE
 * hardcoded actor. Two things were wrong with that, and this fixes both:
 *
 * 1. **Attribution.** Every admin-log row said the same actor, so suspend, archive
 *    and entitlement changes were indistinguishable between operators — the log
 *    could not do the job §4.4 exists for. Actors are now per person.
 * 2. **Answerability.** "Who has platform access?" was not a question the system
 *    could answer, and revoking it meant editing a secret under pressure — the one
 *    moment you least want the mechanism to be a retype-the-whole-list operation.
 *    It is now a row, and revocation is a timestamp.
 *
 * Revocation tombstones rather than deletes (K-21): a row that once granted access
 * is the evidence of why an action was permitted.
 */
export interface StaffRosterRow {
  email: string;
  /**
   * Null when the stored value is not a valid actor id. The row is still listed:
   * "who has platform access" is exactly the question where hiding a broken entry
   * is worse than showing it, and throwing would let one bad row blank the whole
   * roster. Such a person cannot act either way — `d1StaffRoster` fails closed on
   * the same condition.
   */
  actor: PlatformActorId | null;
  name: string | null;
  addedAt: string;
  /** Who granted it — null for rows that predate the console's Members surface. */
  addedBy: string | null;
  revokedAt: string | null;
}

/**
 * A `StaffActorResolver` backed by the roster table. Case-insensitive on email,
 * and a revoked row resolves to null — authenticated is not authorized.
 *
 * Fails CLOSED on a malformed stored actor rather than coercing it: an actor the
 * audit log cannot name is exactly the thing §4.4 refuses to write.
 */
export function d1StaffRoster(db: D1Database): StaffActorResolver {
  return async (identity) => {
    const row = await db
      .prepare('SELECT actor FROM staff_actor WHERE email = ? AND revoked_at IS NULL')
      .bind(identity.email.toLowerCase())
      .first<{ actor: string }>();
    if (!row) return null;
    const parsed = platformActorId.safeParse(row.actor);
    return parsed.success ? parsed.data : null;
  };
}

/** The roster, for the console and for answering "who has access" (revoked included). */
export async function listStaff(db: D1Database): Promise<StaffRosterRow[]> {
  const { results } = await db
    .prepare(
      'SELECT email, actor, name, added_at, added_by, revoked_at FROM staff_actor ORDER BY revoked_at IS NOT NULL, email',
    )
    .all<{
      email: string;
      actor: string;
      name: string | null;
      added_at: string;
      added_by: string | null;
      revoked_at: string | null;
    }>();
  return results.map((r) => ({
    email: r.email,
    actor: platformActorId.safeParse(r.actor).data ?? null,
    name: r.name,
    addedAt: r.added_at,
    addedBy: r.added_by,
    revokedAt: r.revoked_at,
  }));
}

/**
 * Grant platform access (console Members surface). A new human gets a freshly
 * minted actor; re-granting a revoked row clears the tombstone but KEEPS the
 * actor — it is that person's identity in the admin log forever (never reused,
 * never changed), so their pre-revocation history stays attributed to them.
 */
export async function grantStaff(
  db: D1Database,
  input: { email: string; name?: string; grantedBy: PlatformActorId },
): Promise<void> {
  const email = input.email.toLowerCase();
  await db
    .prepare(
      `INSERT INTO staff_actor (email, actor, name, added_at, added_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         revoked_at = NULL,
         name = COALESCE(excluded.name, staff_actor.name),
         added_at = excluded.added_at,
         added_by = excluded.added_by`,
    )
    .bind(email, ulid(), input.name ?? null, new Date().toISOString(), input.grantedBy)
    .run();
}

/**
 * Revoke platform access — a tombstone, never a DELETE (K-21). Refuses to empty
 * the roster: with zero active members nobody can act, including on this very
 * surface, and the only recovery is a raw `wrangler d1 execute` under pressure —
 * the exact failure mode the roster exists to remove.
 */
export async function revokeStaff(
  db: D1Database,
  email: string,
): Promise<'revoked' | 'not-found' | 'last-member'> {
  const e = email.toLowerCase();
  const target = await db
    .prepare('SELECT email FROM staff_actor WHERE email = ? AND revoked_at IS NULL')
    .bind(e)
    .first();
  if (target === null) return 'not-found';
  const active = await db
    .prepare('SELECT COUNT(*) AS n FROM staff_actor WHERE revoked_at IS NULL')
    .first<{ n: number }>();
  if ((active?.n ?? 0) <= 1) return 'last-member';
  await db
    .prepare('UPDATE staff_actor SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), e)
    .run();
  return 'revoked';
}
