/**
 * The wire shapes of platform sign-in's self-heal (`social-relay-heal.ts`, #1544) — what the
 * admin API answers about the last attempt, nothing else.
 *
 * Dependency-free on purpose, like the other `*-wire.ts` files: the admin app imports these
 * types, and importing them from `social-relay-heal.ts` made its build compile that file, and
 * through it `providers.ts` and `@substrat-run/oidc-rp` — a package the app does not declare,
 * so a CI build scoped to the app had never built it.
 */

/** What one attempt came to, as the operator is shown it. */
export type HealResult =
  | { status: 'delivered'; providers: string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  /** The automatic check found nothing missing, so the platform was not asked. */
  | { status: 'current' };

export interface HealRecord {
  /** Which attempt this is: a result is recorded only against the claim it answers. */
  attempt: string;
  /** When the attempt was claimed, ISO 8601. */
  at: string;
  trigger: 'auto' | 'manual';
  /** Absent while the attempt is in flight, or when it never reported back. */
  result?: HealResult;
}
