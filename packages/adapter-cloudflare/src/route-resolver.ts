import { routeTarget, type RouteTarget } from '@substrat-run/contracts';

/**
 * Hostname → route target, for the router worker (K-26).
 *
 * Deliberately NOT `CloudflareScopeHost`. That coordinator needs a `SCOPE`
 * namespace binding because it can open scope DOs, and the router has no business
 * doing that — it resolves a name and forwards. Handing it the full host would give
 * it authority over every tenant's data to save one file.
 *
 * So this is the whole surface: one directory read, and no way to reach a scope.
 * The router's wrangler config binds `CONTROL_PLANE` and nothing else, which makes
 * that boundary a deployment fact rather than a convention.
 */

/** The one method this needs from the control-plane DO. */
interface HostnameReader {
  readHostname(hostname: string): Promise<{
    tenant_id: string;
    scope_id: string;
    vertical_slug: string | null;
    surface: string;
    region: string | null;
    status: string;
    /** The scope's bound version's dispatch script, joined in the read. */
    deployment_ref: string | null;
    /** The dispatched code's declared outbound surface (#303) as JSON text — the
     *  `outbound` array lifted from the resolved version's manifest in the same read.
     *  Null = a pre-#303 manifest (or no version), which dispatches unenforced. */
    outbound_json?: string | null;
  } | undefined>;
}

export type RouteResolver = (hostname: string) => Promise<RouteTarget | undefined>;

/** A hostname row → what the router dispatches on. Shared with `CloudflareScopeHost`
 * so the two cannot drift on what "resolvable" means. */
export function toRouteTarget(
  row:
    | {
        tenant_id: string;
        scope_id: string;
        vertical_slug: string | null;
        surface: string;
        region: string | null;
        status: string;
        deployment_ref?: string | null;
        outbound_json?: string | null;
      }
    | undefined,
): RouteTarget | undefined {
  if (!row || row.status !== 'active') return undefined;
  // The declared outbound surface rides as JSON text from the directory read (#303).
  // A row that carries none — pre-#303 manifest, no bound version — resolves null,
  // which the egress worker treats as unenforced-but-metered, never as deny-all.
  let outboundHosts: string[] | null = null;
  if (row.outbound_json) {
    try {
      const parsed = JSON.parse(row.outbound_json) as unknown;
      if (Array.isArray(parsed)) {
        outboundHosts = parsed.filter((h): h is string => typeof h === 'string');
      }
    } catch {
      // Malformed JSON never breaks routing — the request still dispatches, unenforced.
    }
  }
  return routeTarget.parse({
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    verticalSlug: row.vertical_slug,
    deploymentRef: row.deployment_ref ?? null,
    surface: row.surface,
    region: row.region,
    outboundHosts,
  });
}

/** DNS is case-insensitive, so the map is normalized and lookups must match. */
export const normalizeHostname = (hostname: string): string => hostname.toLowerCase();

/**
 * A resolver over the control-plane directory.
 *
 * No actor and no audit entry: this runs once per request, the same machine-path
 * carve-out `resolveIdentity` has (K-24). Only `active` bindings resolve, so a
 * hostname still validating DNS or one whose certificate failed is simply unknown.
 *
 * It does **not** re-check tenant suspension. `getScope` owns that, inside the
 * vertical, and a second enforcement point is a second thing that can disagree with
 * the first. The router's job is to find the door, not to decide who may open it.
 *
 * Uncached, per request, on purpose: K-26 defers cache invalidation to open
 * question 5 rather than answering it twice, because a cached route that keeps
 * serving a suspended tenant blunts suspension — which §7 calls a live weapon.
 */
export function createRouteResolver(controlPlane: DurableObjectNamespace): RouteResolver {
  return async (hostname: string) => {
    // The stub is created HERE, per request, and never held across one.
    //
    // A Durable Object stub is an I/O object bound to the request that created it.
    // Reusing one from a previous request fails with "Cannot perform I/O on behalf of
    // a different request", and it fails in the cruellest possible way: the first
    // request after a cold start succeeds, so it looks fine locally and in any test
    // that sends one request, then throws for every request after it in production.
    //
    // Only the NAMESPACE may be held across requests. Nothing derived from it may be.
    const cp = controlPlane.get(
      controlPlane.idFromName('control-plane'),
    ) as unknown as HostnameReader;
    return toRouteTarget(await cp.readHostname(normalizeHostname(hostname)));
  };
}
