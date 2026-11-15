/**
 * A person's call made through another app (#3161): the delegated scope as a per-call CEILING.
 *
 * A delegated token names the person (`sub`), the app acting for them (`act`), and the keys that
 * app may use for them (`scope`). The scope is never a grant. The call may do what the person
 * holds AND what was delegated, nothing more, so every decision the call makes is the person's
 * own decision with the keys outside the scope refused.
 *
 * It is the allow-side twin of `withheldKeysFor` (#119), the per-call DENY set, and it reaches the
 * same places: each adapter's `decide` (so `ctx.check`, entity checks, `ctx.grant`/`ctx.revoke`'s
 * re-check, the kernel verbs, the guards and the host's own pre-handler checks, all of which ask
 * through it) and the grant-scoped read behind a filtered list. A refusal looks exactly like a
 * check the person fails, and counts as a check (#2387) the same way.
 */
import { substratError, type Coverage, type PermissionKey } from '@substrat-run/contracts';

/** `getScope`'s `delegation` (#3161): who is acting for the person, and the keys they may use. */
export interface ScopeDelegation {
  /** The app acting for the person, as its issuer names it (a client id). For the record. */
  readonly actor: string;
  /** The keys delegated to `actor`: a ceiling over what the person holds. Empty admits nothing. */
  readonly scope: readonly string[];
}

const refused = (path: string, message: string) =>
  substratError('validation_failed', `delegation: ${message}`, { errors: [{ path, message }] });

/**
 * The delegation a door handed `getScope`, checked at the boundary and copied, so a caller that
 * later mutates its own array cannot widen a stub it already holds. Undefined when none was
 * given. A malformed one is refused, never ignored: an ignored ceiling is an uncapped call.
 */
export function parseScopeDelegation(value: unknown): ScopeDelegation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refused('delegation', 'expected { actor, scope }');
  }
  const { actor, scope } = value as { actor?: unknown; scope?: unknown };
  if (typeof actor !== 'string' || actor.length === 0) throw refused('delegation.actor', 'expected a non-empty string');
  if (!Array.isArray(scope) || !scope.every((k): k is string => typeof k === 'string')) {
    throw refused('delegation.scope', 'expected an array of strings');
  }
  return Object.freeze({ actor, scope: Object.freeze([...scope]) });
}

/** The ceiling a delegation puts on a call, or undefined for a person acting directly. */
export function delegationCeilingOf(delegation: ScopeDelegation | undefined): ReadonlySet<string> | undefined {
  return delegation ? new Set(delegation.scope) : undefined;
}

/** Is `permission` above the call's ceiling? Never, for a call with none. */
export function outsideCeiling(ceiling: ReadonlySet<string> | undefined, permission: string): boolean {
  return ceiling !== undefined && !ceiling.has(permission);
}

/**
 * `ctx.canAssign`'s bound under a ceiling: a role carrying a key outside it is not the caller's to
 * hand on, whatever the person holds. The keys above the ceiling join what the coverage lacks.
 */
export function capCoverage(
  coverage: Coverage,
  permissions: readonly PermissionKey[],
  ceiling: ReadonlySet<string> | undefined,
): Coverage {
  if (ceiling === undefined) return coverage;
  const missing = new Set<PermissionKey>(coverage.covered ? [] : coverage.missing);
  for (const p of permissions) if (!ceiling.has(p)) missing.add(p);
  return missing.size === 0
    ? coverage
    : { covered: false, missing: [...missing] as [PermissionKey, ...PermissionKey[]] };
}
