import {
  callDepthMessage,
  callsDeclares,
  PEER_CALL_DEPTH_MAX,
  previewCallerMessage,
  routeTarget,
  undeclaredCallMessage,
  type PeerCaller,
  type RouteTarget,
} from '@substrat-run/contracts';

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

/** A route row as the control-plane DO's `readRoute` hands it back. */
export interface RouteRowLike {
  tenant_id: string;
  scope_id: string;
  vertical_slug: string | null;
  surface: string;
  region: string | null;
  /** The scope's bound version's dispatch script, joined in the read. */
  deployment_ref?: string | null;
  /** The dispatched code's declared outbound surface (#303) as JSON text — the
   *  `outbound` array lifted from the resolved version's manifest in the same read.
   *  Null = a pre-#303 manifest (or no version), which dispatches unenforced. */
  outbound_json?: string | null;
  /** The dispatched code's declared outgoing peer calls (#1706) as JSON text, on the
   *  same terms as `outbound_json`: null for a version pushed before the declaration. */
  calls_json?: string | null;
}

/** The one method this needs from the control-plane DO. */
interface HostnameReader {
  readRoute(hostname: string): Promise<RouteRowLike | undefined>;
}

export type RouteResolver = (hostname: string) => Promise<RouteTarget | undefined>;

/** A hostname row → what the router dispatches on. Shared with `CloudflareScopeHost`
 * so the two cannot drift on what "resolvable" means. */
export function toRouteTarget(row: RouteRowLike | undefined): RouteTarget | undefined {
  // No status check here: `readRoute` filters `h.status = 'active'` in SQL, the same
  // way adapter-sqlite's `resolveHostname` does. One place decides what resolves.
  if (!row) return undefined;
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
  // #1706: the declared outgoing peer calls, lifted from the same manifest on the same
  // terms — null for a version that predates the declaration, which is unenforced.
  let calls: string[] | null = null;
  if (row.calls_json) {
    try {
      const parsed = JSON.parse(row.calls_json) as unknown;
      if (Array.isArray(parsed)) calls = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // Malformed JSON never breaks routing, exactly as above.
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
    calls,
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
    return toRouteTarget(await cp.readRoute(normalizeHostname(hostname)));
  };
}

// ---------------------------------------------------------------------------
// Peer calls (#1706) — the router's half of one vertical calling another
// ---------------------------------------------------------------------------

/** The one method the peer resolver needs from the control-plane DO. */
interface PeerCallReader {
  peerCallTarget(
    tenantId: string,
    callerScopeId: string,
    callerVertical: string,
    vertical: string,
  ): Promise<PeerCallTargetRowLike>;
}

/** `peerCallTarget`'s answer, as the router reads it. */
export interface PeerCallTargetRowLike {
  caller: { state: 'ok' | 'unknown' | 'not-primary' | 'inactive'; status: string | null };
  outcome: 'resolved' | 'not-installed' | 'ambiguous';
  count: number;
  target: {
    scope_id: string;
    tenant_id: string;
    vertical: string | null;
    deployment_ref: string | null;
    outbound_json: string | null;
    calls_json: string | null;
  } | null;
}

/**
 * What the router does with a peer call: dispatch it to one instance, or refuse it with a
 * reason a builder can act on. A discriminated union, so a caller cannot read a refusal as a
 * destination — the shape `Decision` and `Coverage` use elsewhere, for that reason.
 */
export type PeerCallDecision =
  | {
      outcome: 'dispatch';
      /** The target instance and the script it runs — what `DISPATCH.get` takes. */
      tenantId: string;
      scopeId: string;
      vertical: string;
      deploymentRef: string;
      /** The TARGET's own dispatch parameters, one hop deeper than the caller's. */
      outboundHosts: string[] | null;
      calls: string[] | null;
      depth: number;
    }
  | { outcome: 'refused'; code: 'not_found' | 'conflict' | 'forbidden' | 'unavailable'; message: string };

const jsonList = (raw: string | null | undefined): string[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
};

/**
 * Decide ONE peer call, over the directory (#1706). Pure but for the single read, so the
 * order of the gates is readable in one place — and each is a refusal a test can name:
 *
 * 1. **The depth**, first: a chain already at the bound is refused before any read, so a loop
 *    costs one dispatch rather than a directory round trip per hop.
 * 2. **The caller declared this target** (`substrat.calls`). A version pushed before the
 *    declaration existed carries `null` and is unenforced, exactly as a pre-#303 `outbound` is.
 * 3. **The caller is who the platform says it is**: its scope record still names the vertical
 *    the dispatch ran as, in this tenant. Read here rather than taken from routing, so this
 *    path does not inherit #1713.
 * 4. **The caller is a live primary instance** — not suspended, archived, a fork or a preview.
 * 5. **The target resolves** to exactly one live primary instance in the SAME tenant, by the
 *    kernel's one rule. Never guessed when a tenant runs two.
 * 6. **The target has a script to dispatch.**
 */
export function createPeerCallResolver(
  controlPlane: DurableObjectNamespace,
): (caller: PeerCaller, target: string) => Promise<PeerCallDecision> {
  return async (caller, target) => {
    if (caller.depth >= PEER_CALL_DEPTH_MAX) {
      return { outcome: 'refused', code: 'forbidden', message: callDepthMessage(caller.depth) };
    }
    if (!callsDeclares(caller.calls, target)) {
      return {
        outcome: 'refused',
        code: 'forbidden',
        message: undeclaredCallMessage(caller.vertical, target),
      };
    }
    // Per request, never held: a stub belongs to the request that created it (see above).
    const cp = controlPlane.get(controlPlane.idFromName('control-plane')) as unknown as PeerCallReader;
    const row = await cp.peerCallTarget(caller.tenantId, caller.scopeId, caller.vertical, target);
    if (row.caller.state === 'unknown') {
      return {
        outcome: 'refused',
        code: 'forbidden',
        message: `scope ${caller.scopeId} is not an instance of '${caller.vertical}' in this tenant`,
      };
    }
    if (row.caller.state === 'not-primary') {
      return { outcome: 'refused', code: 'forbidden', message: previewCallerMessage(caller.vertical) };
    }
    if (row.caller.state === 'inactive') {
      return {
        outcome: 'refused',
        code: 'forbidden',
        message:
          `'${caller.vertical}' may not call other verticals from a ${row.caller.status ?? 'non-active'} ` +
          'scope — only a live primary instance acts as its vertical',
      };
    }
    // Ambiguity first: an ambiguous answer carries no target either, so testing for a missing
    // target before the count would report "not installed" for a tenant that runs two.
    if (row.outcome === 'ambiguous') {
      return {
        outcome: 'refused',
        code: 'conflict',
        message:
          `this tenant runs ${row.count} instances of '${target}' — a call cannot pick one; ` +
          'bind the instance first',
      };
    }
    if (row.outcome === 'not-installed' || !row.target) {
      return {
        outcome: 'refused',
        code: 'not_found',
        message: `vertical '${target}' is not installed in this tenant`,
      };
    }
    if (!row.target.deployment_ref) {
      return {
        outcome: 'refused',
        code: 'unavailable',
        message: `vertical '${target}' has no deployed version in this tenant`,
      };
    }
    return {
      outcome: 'dispatch',
      tenantId: row.target.tenant_id,
      scopeId: row.target.scope_id,
      vertical: target,
      deploymentRef: row.target.deployment_ref,
      outboundHosts: jsonList(row.target.outbound_json),
      calls: jsonList(row.target.calls_json),
      depth: caller.depth + 1,
    };
  };
}
