/**
 * The operator gate in front of the directory inventory (#1343).
 *
 * The inventory is a fleet read: counts across every team. The dashboard has no staff
 * concept of its own (every caller is a team member, narrowed to their team), so the
 * route is gated on a credential set for it alone, per environment, as a Worker secret.
 * Unset is the default, and then the route does not exist: it answers 404 like any
 * unknown path, the same answer a wrong credential gets, so neither tells a caller
 * whether the route is there.
 */

/** `Authorization: Bearer <token>` → the token, or undefined. */
function bearerOf(header: string | undefined): string | undefined {
  return header && /^bearer /i.test(header) ? header.slice(7).trim() || undefined : undefined;
}

/**
 * Whether a request's bearer is the configured inventory credential. Both sides are hashed
 * first, so the comparison is over fixed-length digests and takes the same time wherever
 * they first differ.
 */
export async function inventoryCallerAllowed(configured: string | undefined, authorization: string | undefined): Promise<boolean> {
  const presented = bearerOf(authorization);
  if (!configured || !presented) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(configured), digest(presented)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The page the identity half walks: `?limit` (1–50, default 20) and `?cursor` (the last team id seen). */
export function inventoryPage(query: { limit?: string | undefined; cursor?: string | undefined }): { limit: number; cursor?: string } {
  const n = Number(query.limit ?? 20);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 50) : 20;
  return query.cursor ? { limit, cursor: query.cursor } : { limit };
}
