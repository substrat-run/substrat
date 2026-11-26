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
import {
  readModelPeerCallRead,
  readModelPeerCallReader,
  readModelRouteRead,
  readModelRouteReader,
  type PeerCallKey,
  type RouteKvReader,
  type RouteMemoryCache,
} from './route-read-model.js';

export {
  RouteMemoryCache,
  ROUTE_KV_CACHE_TTL_S,
  ROUTE_MEMORY_TTL_MS,
  ROUTE_NEGATIVE_TTL_MS,
  assembleRouteRow,
  assemblePeerCallRow,
  peerCallKvKey,
  routeKvKey,
  servingPolicyKvKey,
  type PeerCallEntry,
  type PeerCallKey,
  type RefusedRouteEntry,
  type RouteEntry,
  type RouteKvReader,
  type ServingPolicyEntry,
} from './route-read-model.js';

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
  /** `scopeStores` from the same manifest. Absent on a resolver that predates it. */
  scope_stores_json?: string | null;
  /** Whether the scope is the real install (#2005), decided by the control-plane DO. Absent
   *  from one that predates the field, which resolves `primary: true` — the skew window
   *  `routeTarget` documents. */
  primary?: boolean;
  /** Every active hostname of the same scope (#2005); absent from a pre-field DO, which
   *  resolves `[]` — only the requested hostname is the scope's own. */
  scope_hostnames?: string[];
}

/** The one method this needs from the control-plane DO. */
interface HostnameReader {
  /**
   * `publish` (#3395) asks the directory to publish the route to the read model when it holds
   * none yet. A directory that predates it ignores the argument and answers the same row.
   */
  readRoute(hostname: string, opts?: { publish?: boolean }): Promise<RouteRowLike | undefined>;
}

export type RouteResolver = (hostname: string) => Promise<RouteTarget | undefined>;

function scopeStoresOf(json: string | null | undefined): { binding: string; driver: string }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const binding = Reflect.get(entry, 'binding');
      const driver = Reflect.get(entry, 'driver');
      return typeof binding === 'string' && typeof driver === 'string' ? [{ binding, driver }] : [];
    });
  } catch {
    return [];
  }
}

/** A hostname row → what the router dispatches on. Shared with `CloudflareScopeHost`
 * so the two cannot drift on what "resolvable" means. */
export function toRouteTarget(row: RouteRowLike | undefined): RouteTarget | undefined {
  // No status check here: `readRoute` gates hostname, scope and tenant lifecycle in SQL, the same
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
    scopeStores: scopeStoresOf(row.scope_stores_json),
    // #2005: absent only from a control-plane DO that predates the field, which the schema
    // defaults to `true` — see RouteRowLike.
    primary: row.primary,
    hostnames: row.scope_hostnames,
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
 * The directory requires an active hostname, correctly paired active scope and
 * active owning tenant (#1713). CP-less verticals rely on this request-path gate;
 * CP-backed `getScope` retains its own check. No lifecycle state crosses the wire.
 * Direct/background calls and already-dispatched requests remain outside this gate.
 *
 * This resolver is uncached, per request: K-26 deferred cache invalidation to open
 * question 5, because a cached route that keeps serving a suspended tenant blunts
 * suspension — which §7 calls a live weapon. `createReadModelRouteResolver` below is the
 * cached answer (#3395, K-72 proposed): the scope refuses a suspension as soon as its
 * lifecycle delivery lands, and the router's cache is bounded.
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

/**
 * How the router reads routes (#3395):
 * - `off`: the directory on every request, as above.
 * - `compare`: the directory serves; the read model is read beside it and every disagreement or
 *   miss is logged. Nothing is served from KV, so this is safe to run before trusting it.
 * - `on`: memory → KV → the directory, which answers every miss and publishes what it answered.
 */
export type RouteReadModelMode = 'off' | 'compare' | 'on';

/** A deployment value → a mode. Anything unrecognised is `off`: the flag can only fail safe. */
export const routeReadModelModeOf = (raw: string | undefined): RouteReadModelMode =>
  raw === 'on' || raw === 'compare' ? raw : 'off';

/** One comparison's outcome, as `compare` logs it. A match is not logged, only counted by absence. */
export interface RouteReadModelComparison {
  hostname: string;
  outcome: 'mismatch' | 'miss' | 'error';
  directory: RouteTarget | undefined;
  readModel: RouteTarget | undefined;
}

export interface ReadModelResolverOptions {
  controlPlane: DurableObjectNamespace;
  kv: RouteKvReader;
  /** Module-scope, shared across requests: it holds plain data only. */
  cache: RouteMemoryCache;
  mode: Exclude<RouteReadModelMode, 'off'>;
  /** `compare` runs its read model half here, off the response's path. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** `compare`'s report of a disagreement. Defaults to one JSON log line. */
  report?: (comparison: RouteReadModelComparison) => void;
  now?: () => number;
}

const logComparison = (c: RouteReadModelComparison): void => {
  console.log(JSON.stringify({ router: 'route-read-model', ...c }));
};

/**
 * The read-model resolver (#3395). Like `createRouteResolver`, the directory stub is created per
 * call and never held: the cache keeps rows and KV entries, which are plain data.
 */
export function createReadModelRouteResolver(opts: ReadModelResolverOptions): RouteResolver {
  const directory = (publish: boolean) => async (hostname: string) => {
    const cp = opts.controlPlane.get(opts.controlPlane.idFromName('control-plane')) as unknown as HostnameReader;
    return publish ? cp.readRoute(hostname, { publish: true }) : cp.readRoute(hostname);
  };
  const base = { kv: opts.kv, cache: opts.cache, ...(opts.now ? { now: opts.now } : {}) };
  if (opts.mode === 'on') {
    const read = readModelRouteRead({ ...base, directory: directory(true) });
    return async (hostname) => toRouteTarget((await read(normalizeHostname(hostname))).row);
  }
  const fromModel = readModelRouteReader(base);
  const report = opts.report ?? logComparison;
  return async (hostname) => {
    const normalized = normalizeHostname(hostname);
    const served = toRouteTarget(await directory(false)(normalized));
    const compare = (async () => {
      let modelled: RouteRowLike | undefined | 'miss';
      try {
        modelled = await fromModel(normalized);
      } catch {
        report({ hostname: normalized, outcome: 'error', directory: served, readModel: undefined });
        return;
      }
      if (modelled === 'miss') {
        // A miss for a hostname the directory does not route either is the agreement: nothing.
        if (served) report({ hostname: normalized, outcome: 'miss', directory: served, readModel: undefined });
        return;
      }
      const readModel = toRouteTarget(modelled);
      if (JSON.stringify(readModel) !== JSON.stringify(served)) {
        report({ hostname: normalized, outcome: 'mismatch', directory: served, readModel });
      }
    })();
    if (opts.waitUntil) opts.waitUntil(compare);
    else await compare;
    return served;
  };
}

// ---------------------------------------------------------------------------
// Peer calls (#1706) — the router's half of one vertical calling another
// ---------------------------------------------------------------------------

/** The one method the peer resolver needs from the control-plane DO. */
interface PeerCallReader {
  /**
   * `publish` (#3395 follow-up) asks the directory to publish a dispatchable answer to the read
   * model. A directory that predates it ignores the argument and answers the same row.
   */
  peerCallTarget(
    tenantId: string,
    callerScopeId: string,
    callerVertical: string,
    vertical: string,
    opts?: { publish?: boolean },
  ): Promise<PeerCallTargetRowLike>;
}

/** `peerCallTarget`'s answer, as the router reads it. */
export interface PeerCallTargetRowLike {
  caller: { state: 'ok' | 'unknown' | 'not-primary' | 'inactive'; status: string | null; tenantSlug?: string | null };
  outcome: 'resolved' | 'not-installed' | 'ambiguous' | 'bound-unavailable';
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
      /** The target instance and the script it runs — what `DISPATCH.get` takes. `vertical` is
       *  the target's REGISTERED name (a pinned `<tenant>/<slug>` included), so the same scope
       *  runs under one name whether it was reached publicly or by a peer. */
      tenantId: string;
      scopeId: string;
      vertical: string;
      /** The caller's tenant's directory slug (#2252), handed to the target's door beside the
       *  caller so a pinned caller meets a bare `peers` entry. `null` from a control plane
       *  predating it: the door then matches exactly, as before. */
      callerTenantSlug: string | null;
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
 * How the router reads peer-call answers (#3395 follow-up, K-72): its own switch, `PEER_READ_MODEL`,
 * with the same three modes as routes. Off reads the directory on every call, as before.
 */
export interface PeerReadModelOptions {
  kv: RouteKvReader;
  /** Module-scope, shared across requests: it holds plain data only. */
  cache: RouteMemoryCache;
  mode: Exclude<RouteReadModelMode, 'off'>;
  /** `compare` runs its read model half here, off the call's path. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** `compare`'s report of a disagreement. Defaults to one JSON log line. */
  report?: (comparison: PeerReadModelComparison) => void;
  now?: () => number;
}

/** One peer comparison's outcome, as `compare` logs it: the two DECISIONS, not the rows. */
export interface PeerReadModelComparison {
  key: PeerCallKey;
  outcome: 'mismatch' | 'miss' | 'error';
  directory: PeerCallDecision;
  readModel: PeerCallDecision | undefined;
}

const logPeerComparison = (c: PeerReadModelComparison): void => {
  console.log(JSON.stringify({ router: 'peer-read-model', ...c }));
};

/**
 * Decide ONE peer call (#1706). Pure but for the single read, so the order of the gates is
 * readable in one place — and each is a refusal a test can name:
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
 *
 * Gates 1 and 2 read only the dispatch parameters. Gates 3 to 6 read the directory's answer, which
 * with `readModel` may come from the routing read model (#3395 follow-up): there it is the
 * directory's own answer as published, at most about four minutes old (K-72's split), and only an
 * answer that dispatches is ever published — every refusal is the directory's, read at the call.
 * Gates 1 and 2 never read the read model. What the peer may then DO is the target's door (#1714).
 */
export function createPeerCallResolver(
  controlPlane: DurableObjectNamespace,
  readModel?: PeerReadModelOptions,
): (caller: PeerCaller, target: string) => Promise<PeerCallDecision> {
  // Per call, never held: a stub belongs to the request that created it (see above).
  const directory = (publish: boolean) => (k: PeerCallKey): Promise<PeerCallTargetRowLike> => {
    const cp = controlPlane.get(controlPlane.idFromName('control-plane')) as unknown as PeerCallReader;
    return publish
      ? cp.peerCallTarget(k.tenantId, k.callerScopeId, k.callerVertical, k.vertical, { publish: true })
      : cp.peerCallTarget(k.tenantId, k.callerScopeId, k.callerVertical, k.vertical);
  };
  const read = peerCallRead(directory, readModel);
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
    const key: PeerCallKey = { tenantId: caller.tenantId, callerScopeId: caller.scopeId, callerVertical: caller.vertical, vertical: target };
    return read(key, (row) => peerCallDecisionOf(caller, target, row));
  };
}

/** The single read behind gates 3 to 6, by mode. `decide` is the gates, so `compare` compares decisions. */
function peerCallRead(
  directory: (publish: boolean) => (k: PeerCallKey) => Promise<PeerCallTargetRowLike>,
  opts: PeerReadModelOptions | undefined,
): (key: PeerCallKey, decide: (row: PeerCallTargetRowLike) => PeerCallDecision) => Promise<PeerCallDecision> {
  if (!opts) return async (key, decide) => decide(await directory(false)(key));
  const base = { kv: opts.kv, cache: opts.cache, ...(opts.now ? { now: opts.now } : {}) };
  if (opts.mode === 'on') {
    const read = readModelPeerCallRead({ ...base, directory: directory(true) });
    return async (key, decide) => decide((await read(key)).row);
  }
  // `compare`: the directory serves. Unlike a route, an answer is published only once a router asked
  // for it, so this mode asks too — otherwise it would compare against an empty namespace forever.
  const fromModel = readModelPeerCallReader(base);
  const report = opts.report ?? logPeerComparison;
  return async (key, decide) => {
    const served = decide(await directory(true)(key));
    const compare = (async () => {
      let modelled: PeerCallTargetRowLike | 'miss';
      try {
        modelled = await fromModel(key);
      } catch {
        report({ key, outcome: 'error', directory: served, readModel: undefined });
        return;
      }
      if (modelled === 'miss') {
        // Only a dispatch is published, so a miss beside a refusal is the agreement.
        if (served.outcome === 'dispatch') report({ key, outcome: 'miss', directory: served, readModel: undefined });
        return;
      }
      const readModel = decide(modelled);
      if (JSON.stringify(readModel) !== JSON.stringify(served)) report({ key, outcome: 'mismatch', directory: served, readModel });
    })();
    if (opts.waitUntil) opts.waitUntil(compare);
    else await compare;
    return served;
  };
}

/** Gates 3 to 6 over the directory's answer (or the read model's copy of it). */
function peerCallDecisionOf(caller: PeerCaller, target: string, row: PeerCallTargetRowLike): PeerCallDecision {
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
  if (row.outcome === 'bound-unavailable') {
    return {
      outcome: 'refused',
      code: 'conflict',
      message: `the bound instance of '${target}' is unavailable; rebind or clear this app's peer binding`,
    };
  }
  if (row.outcome === 'not-installed' || !row.target) {
    return {
      outcome: 'refused',
      code: 'not_found',
      message: `vertical '${target}' is not installed in this tenant`,
    };
  }
  // A pinned caller's bare slug resolves to itself (#2252); a peer call names ANOTHER vertical.
  if (row.target.scope_id === caller.scopeId) {
    return { outcome: 'refused', code: 'forbidden', message: `'${caller.vertical}' cannot peer-call itself` };
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
    vertical: row.target.vertical ?? target,
    callerTenantSlug: row.caller.tenantSlug ?? null,
    deploymentRef: row.target.deployment_ref,
    outboundHosts: jsonList(row.target.outbound_json),
    calls: jsonList(row.target.calls_json),
    depth: caller.depth + 1,
  };
}
