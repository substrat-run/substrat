import type { PlatformActorId } from '@substrat-run/contracts';

/**
 * Builder-studio access grants (migrations/0003_builder_access.sql).
 *
 * The studio's gate was `staff_actor` alone, which coupled "may use the builder"
 * to "may act on the control plane" — granting an external user the studio meant
 * granting them platform-staff powers. This table is the decoupling: a row here
 * admits an email to the builder studio and grants NOTHING else. Staff keep
 * implicit access (the builder worker checks both tables); the eventual
 * replacement is the plan-entitlement flag (builder-plane.md §7).
 *
 * Same semantics as the staff roster: email keyed (lowercased at the boundary),
 * revocation tombstones rather than deletes (K-21), re-grant clears the
 * tombstone. No actor column — builder users never act on the control plane, so
 * there is no identity for the admin log to name; `added_by` attributes the
 * grant to the staff member who made it.
 */
export interface BuilderAccessRow {
  email: string;
  name: string | null;
  /** The PlatformActorId of the staff member who granted it. */
  addedBy: string;
  addedAt: string;
  revokedAt: string | null;
}

/** Every grant, revoked included — "who has builder access" must answer both. */
export async function listBuilderAccess(db: D1Database): Promise<BuilderAccessRow[]> {
  const { results } = await db
    .prepare(
      'SELECT email, name, added_by, added_at, revoked_at FROM builder_access ORDER BY revoked_at IS NOT NULL, email',
    )
    .all<{
      email: string;
      name: string | null;
      added_by: string;
      added_at: string;
      revoked_at: string | null;
    }>();
  return results.map((r) => ({
    email: r.email,
    name: r.name,
    addedBy: r.added_by,
    addedAt: r.added_at,
    revokedAt: r.revoked_at,
  }));
}

/** Grant (or re-grant) builder access. Idempotent on an already-active email. */
export async function grantBuilderAccess(
  db: D1Database,
  input: { email: string; name?: string; grantedBy: PlatformActorId },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO builder_access (email, name, added_by, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         revoked_at = NULL,
         name = COALESCE(excluded.name, builder_access.name),
         added_by = excluded.added_by,
         added_at = excluded.added_at`,
    )
    .bind(input.email.toLowerCase(), input.name ?? null, input.grantedBy, new Date().toISOString())
    .run();
}

/** Revoke builder access — a tombstone, never a DELETE (K-21). */
export async function revokeBuilderAccess(
  db: D1Database,
  email: string,
): Promise<'revoked' | 'not-found'> {
  const res = await db
    .prepare('UPDATE builder_access SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL')
    .bind(new Date().toISOString(), email.toLowerCase())
    .run();
  return res.meta.changes > 0 ? 'revoked' : 'not-found';
}
