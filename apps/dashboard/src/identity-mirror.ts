import type { IdentityLink } from '@substrat-run/contracts';

/**
 * The mirror's divergence, as a fact rather than an assumption (#1343).
 *
 * The dashboard keeps its own identity directory and best-effort mirrors links
 * into the shared one on every `/api/me` (#265). Two sources of truth, healed by
 * polling — and until now the healing was unobservable: the mirror's `catch`
 * swallowed every failure, so "the mirror is complete" was a belief nobody could
 * check from outside. Retiring the local directory (#1343) is a live-data move
 * that cannot be planned against a belief.
 *
 * The comparison is deliberately keyed on `(provider, externalId)` — the pair a
 * login actually resolves by. A link whose PRINCIPAL differs between the two
 * directories is the dangerous case, and it is invisible to a count: both sides
 * have "a link for this user", and the shared one sends them somewhere else.
 */
export interface IdentityDivergence {
  /** Links the dashboard holds that the shared directory does not — the mirror never landed. */
  missing: IdentityLink[];
  /** Links the shared directory holds that the dashboard does not — an unlink that only landed locally. */
  extra: IdentityLink[];
  /** Present in both, resolving to DIFFERENT principals — the case a count cannot see. */
  conflicting: Array<{ local: IdentityLink; shared: IdentityLink }>;
  /** True when all three are empty: the mirror is complete for this tenant, now. */
  inSync: boolean;
}

const keyOf = (l: { provider: string; externalId: string }): string => `${l.provider}${l.externalId}`;

/**
 * Compare one tenant's local links against the shared directory's. Pure, so the
 * migration's readiness check and its tests are the same code.
 */
export function deriveIdentityDivergence(
  local: IdentityLink[],
  shared: IdentityLink[],
): IdentityDivergence {
  const sharedBy = new Map(shared.map((l) => [keyOf(l), l]));
  const localBy = new Map(local.map((l) => [keyOf(l), l]));

  const missing: IdentityLink[] = [];
  const conflicting: Array<{ local: IdentityLink; shared: IdentityLink }> = [];
  for (const l of local) {
    const s = sharedBy.get(keyOf(l));
    if (s === undefined) {
      missing.push(l);
      continue;
    }
    // `scopeId` deliberately does NOT count as a conflict: the mirror omits it for
    // a tenant-level home, and a link that resolves to the same principal sends the
    // same person to the same place. Only the principal decides who you become.
    if (s.principal !== l.principal) conflicting.push({ local: l, shared: s });
  }
  const extra = shared.filter((s) => !localBy.has(keyOf(s)));

  return {
    missing,
    extra,
    conflicting,
    inSync: missing.length === 0 && extra.length === 0 && conflicting.length === 0,
  };
}
