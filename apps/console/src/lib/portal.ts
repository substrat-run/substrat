import type { HostnameBinding, Scope } from '@substrat-run/contracts';

/**
 * Where a scope's tenant-facing app lives.
 *
 * This used to read a single `VITE_PORTAL_BASE` env var — a dev stand-in for a
 * router that did not exist. It exists now (K-26), so the authoritative answer is
 * the scope's canonical hostname from the same map the router resolves against.
 * The console and the router cannot disagree about where a scope lives, because
 * only one thing knows.
 */

/**
 * Pick the hostname to link to, from this scope's bindings.
 *
 * Only `active` bindings are candidates — the same rule the router applies, and the
 * reason the status column exists. A hostname still validating DNS, or one whose
 * certificate failed, would render a link that leads nowhere; showing no link is
 * more honest than showing a broken one.
 *
 * Among active bindings the **canonical** one wins, which is what canonical means
 * and why exactly one per (scope, surface) may hold it. An alias serves equally
 * well, so falling back to one keeps the link working rather than insisting on a flag.
 */
export function portalUrl(
  scope: Scope,
  bindings: HostnameBinding[],
  surface = 'app',
): string | null {
  const active = bindings.filter(
    (b) => b.scopeId === scope.id && b.surface === surface && b.status === 'active',
  );
  const chosen = active.find((b) => b.canonical) ?? active[0];
  if (chosen) return `https://${chosen.hostname}`;

  // Local dev has no router and no bindings: the console and the vertical are two
  // Vite servers on localhost, which is not something the map can express (a port
  // is not a hostname). `pnpm dev` sets this; a deployment does not, and if it did
  // the branch above would have won anyway.
  const devBase = import.meta.env.VITE_PORTAL_BASE as string | undefined;
  if (!devBase) return null;
  const url = new URL(devBase);
  url.searchParams.set('tenant', scope.tenantId);
  url.searchParams.set('scope', scope.id);
  return url.toString();
}

/**
 * Every surface this scope answers on, for a console that wants to show more than
 * one door.
 *
 * "The portal link" is not always singular: a scope can front the shop's storefront
 * and back office, or RallyPoint's player app and manager console. §5.5 assumed one
 * hostname per scope, which is the assumption `surface` exists to correct.
 */
/**
 * Every hostname bound to this scope, in ANY status — canonical first, then by name.
 *
 * Unlike {@link portalUrl}, this does not filter to `active`: the reap guard
 * (control-plane.md §4.4) refuses while *any* binding exists, since a `pending` or
 * `failed` one still pins the scope and still routes once it settles. So this — not the
 * active-only set — is the list the console must show before a reap, and the set an
 * "unbind & reap" must release. A serving app always has ≥1 of these; that is the whole
 * reason a live scope can never be silently wiped (#500/#501).
 */
export function boundHostnames(scope: Scope, bindings: HostnameBinding[]): HostnameBinding[] {
  return bindings
    .filter((b) => b.scopeId === scope.id)
    .sort((a, b) => Number(b.canonical) - Number(a.canonical) || a.hostname.localeCompare(b.hostname));
}

export function portalUrls(
  scope: Scope,
  bindings: HostnameBinding[],
): { surface: string; url: string }[] {
  const surfaces = [
    ...new Set(
      bindings.filter((b) => b.scopeId === scope.id && b.status === 'active').map((b) => b.surface),
    ),
  ].sort();
  return surfaces.flatMap((surface) => {
    const url = portalUrl(scope, bindings, surface);
    return url ? [{ surface, url }] : [];
  });
}
