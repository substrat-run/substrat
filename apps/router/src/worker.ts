/**
 * The environment-wide router (K-26; control-plane.md §4.7).
 *
 * One kernel-owned worker in front of every vertical. It resolves
 * `hostname → (tenant, scope, vertical, surface)` from the directory and forwards
 * over a service binding, asserting the resolved node in request headers.
 *
 * **Not one router per vertical**: cert and DNS lifecycle in one place means a new
 * vertical gets custom domains for free. **Not one per jurisdiction**: Cloudflare's
 * Regional Services is configured per hostname, so residency is a column on the
 * binding, not a second deployment topology.
 *
 * This does not erode D-30. That decision rejects bundling verticals into one DO
 * class, which would force lockstep engine upgrades across verticals owned by
 * different companies. A router forwards; deployments stay separate.
 */
// The `/routing` subpath, not the package root: the root re-exports the scope-DO
// class, and the router must not carry code for opening scopes it has no binding to.
import { createRouteResolver, type RouteResolver } from '@substrat-run/adapter-cloudflare/routing';
import type { RouteTarget } from '@substrat-run/contracts';

export interface Env {
  /**
   * The shared control plane's directory DO. The ONLY binding this worker has —
   * no `SCOPE` namespace, so the router cannot open a scope even by mistake. It
   * finds the door; it never opens it.
   */
  CONTROL_PLANE: DurableObjectNamespace;
  /**
   * Shared secret presented to every vertical as `x-substrat-router`.
   *
   * The real trust boundary is that vertical workers have no public route (K-26).
   * This is the belt to that suspenders, and it earns its keep: `workers.dev` is ON
   * by default, so "the vertical is only reachable through the router" is a config
   * fact that one forgotten toggle silently reverses — and the consequence is total,
   * since a forged tenant header reads another tenant's data. A secret makes the
   * boundary hold in code even when the config slips.
   */
  ROUTER_SECRET?: string;
  /**
   * The Workers-for-Platforms dispatch namespace holding every pushed vertical
   * (orchestration.md §5.4). The router dispatches on the scope's bound version's
   * `deploymentRef`: `env.DISPATCH.get(deploymentRef)`. Absent ⇒ the router falls
   * back to the static `VERTICAL_<SLUG>` service bindings below.
   */
  DISPATCH?: DispatchNamespace;
  /**
   * Tenant-keyed request metering (design/observability.md §4.2). The router is the
   * one place that knows which TENANT a request belonged to — Cloudflare's own
   * analytics only see scripts — so it stamps that dimension here, one datapoint
   * per resolved request. Optional: absent (tests, local dev) ⇒ no metering.
   */
  ANALYTICS?: AnalyticsEngineDataset;
  /**
   * Legacy static service bindings, keyed `VERTICAL_<SLUG>` (slug upper-cased, dashes
   * as underscores). The milestone-one shape, kept as a fallback while the dispatch
   * namespace takes over — used only when a route has no `deploymentRef`.
   */
  [binding: string]: unknown;
}

/** Minimal shape of a WfP dispatch namespace binding. */
interface DispatchNamespace {
  get(name: string): Fetcher;
}

/** Headers the router asserts. Any inbound copy is stripped before these are set. */
const ASSERTED_PREFIX = 'x-substrat-';

const bindingNameFor = (slug: string): string =>
  `VERTICAL_${slug.toUpperCase().replace(/-/g, '_')}`;

function verticalFor(env: Env, target: RouteTarget): Fetcher | undefined {
  // Dispatch on the scope's bound version, if the namespace is bound and the scope
  // has one (orchestration.md §5.4). `get` returns a stub unconditionally; a script
  // that is not there (or not yet propagated, K-29) surfaces as `Worker not found.`
  // at fetch time, which the bounded retry below handles.
  if (target.deploymentRef && env.DISPATCH) {
    return env.DISPATCH.get(target.deploymentRef);
  }
  // Fallback: the milestone-one static service binding, for a route with no version.
  if (!target.verticalSlug) return undefined;
  const binding = env[bindingNameFor(target.verticalSlug)];
  // A Fetcher is an object with .fetch; anything else in this slot is misconfiguration.
  return binding && typeof (binding as Fetcher).fetch === 'function'
    ? (binding as Fetcher)
    : undefined;
}

/**
 * Build the forwarded request.
 *
 * Every `x-substrat-*` header from the client is DROPPED before ours are set. The
 * vertical trusts these headers absolutely — they are the tenant it serves — so the
 * router must be the only thing that can write them. Stripping by prefix rather than
 * by name means a header added later is covered by default instead of by remembering.
 */
function assertNode(request: Request, target: RouteTarget, secret?: string): Request {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!k.toLowerCase().startsWith(ASSERTED_PREFIX)) headers.set(k, v);
  }
  headers.set('x-substrat-tenant', target.tenantId);
  headers.set('x-substrat-scope', target.scopeId);
  headers.set('x-substrat-surface', target.surface);
  if (target.verticalSlug) headers.set('x-substrat-vertical', target.verticalSlug);
  if (secret) headers.set('x-substrat-router', secret);
  return new Request(request, { headers });
}

/**
 * A dispatch failure that a retry might fix.
 *
 * Observed while verifying K-28: a freshly-deployed user worker is not instantly
 * reachable everywhere. One scope got `Worker not found.` for ~15s while sibling
 * scopes on the SAME script succeeded — its Durable Object had placed in a colo the
 * script had not propagated to. It healed on its own.
 *
 * Cloudflare's own guidance for this error is to return 404, which is right when the
 * script genuinely is not there and wrong during that window: it turns a transient
 * gap into a hard failure for whichever tenants happen to land in a cold colo.
 *
 * There is no propagation-complete signal to wait for, so this is not a delay. It is
 * one bounded retry, which is also the mitigation that survives being wrong about the
 * cause — the colo explanation is an inference from the symptom, not something
 * Cloudflare documents, and a retry does not depend on it being right.
 */
const isTransientDispatchFailure = (e: unknown): boolean =>
  e instanceof Error && e.message.startsWith('Worker not found');

/**
 * Retry only requests with no body — deliberately.
 *
 * A retry is safe when we know the first attempt had no effect. We do not always know
 * that: if the failure came after the request reached the vertical, re-sending a POST
 * could run the same mutation twice, and a double-charged customer is a worse outcome
 * than a 502. Bodyless requests carry no mutation to duplicate, and they are the ones
 * a person actually sees fail — a page load, not a form submit.
 */
const isReplayable = (request: Request): boolean => request.body === null;

/**
 * Built per request, deliberately — nothing here is cached.
 *
 * This used to memoise the resolver in a WeakMap. That was wrong, and it failed in
 * production with "Cannot perform I/O on behalf of a different request": the resolver
 * closed over a Durable Object STUB, and a stub belongs to the request that created
 * it. The comment defending the cache reasoned about the wrong hazard entirely — it
 * worried about the map outliving its env, and missed that the stub could not outlive
 * a single request.
 *
 * Constructing a closure over a namespace binding costs nothing. Caching anything
 * derived from one costs a production outage that only appears on the SECOND request.
 */
const resolverFor = (env: Env): RouteResolver => createRouteResolver(env.CONTROL_PLANE);

/**
 * Record one resolved request (design/observability.md §4.2/§4.3): an Analytics
 * Engine datapoint keyed by tenant, and one structured log line carrying the same
 * fields for the telemetry query path. Blob/double order is a published shape —
 * the read proxy indexes into it — so it only ever grows, never reorders:
 * index [tenantId]; blobs [vertical, scope, surface, statusClass, rayId];
 * doubles [durationMs, status].
 */
function record(
  env: Env,
  target: RouteTarget,
  m: { hostname: string; rayId: string | null; status: number; durationMs: number },
): void {
  const statusClass = `${Math.floor(m.status / 100)}xx`;
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: [target.tenantId],
      blobs: [target.verticalSlug ?? '', target.scopeId, target.surface, statusClass, m.rayId ?? ''],
      doubles: [m.durationMs, m.status],
    });
  } catch {
    // Metering must never fail a request.
  }
  console.log(
    JSON.stringify({
      router: 'request',
      tenantId: target.tenantId,
      scopeId: target.scopeId,
      vertical: target.verticalSlug,
      surface: target.surface,
      hostname: m.hostname,
      rayId: m.rayId,
      status: m.status,
      durationMs: m.durationMs,
    }),
  );
}

async function dispatch(
  env: Env,
  request: Request,
  target: RouteTarget,
  hostname: string,
): Promise<Response> {
  const vertical = verticalFor(env, target);
  if (!vertical) {
    // The map says which vertical answers and no binding provides it. That is our
    // misconfiguration, not the caller's — 502, and it is worth logging loudly.
    console.error(
      `router: no service binding ${bindingNameFor(target.verticalSlug ?? '?')} for ` +
        `hostname ${hostname} (scope ${target.scopeId})`,
    );
    return new Response('This application is not available.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // `target.region` is carried but not enforced here: Regional Services pins TLS
  // termination and processing at the edge, ahead of this worker, and the DO
  // jurisdiction pins storage and execution (K-7). Both halves are configuration.
  // Re-checking it in code would be a third enforcement point that can disagree.
  const forwarded = assertNode(request, target, env.ROUTER_SECRET);

  try {
    return await vertical.fetch(forwarded);
  } catch (e) {
    if (!isTransientDispatchFailure(e) || !isReplayable(request)) throw e;
    try {
      return await vertical.fetch(assertNode(request, target, env.ROUTER_SECRET));
    } catch (retryError) {
      if (!isTransientDispatchFailure(retryError)) throw retryError;
      // Twice is enough to distinguish a propagation gap from a script that is
      // simply not there. Bounded, so a real misconfiguration fails fast instead
      // of hanging — 502, the same answer as a vertical with no binding.
      console.error(
        `router: vertical '${target.verticalSlug}' not found on retry for ` +
          `hostname ${hostname} (scope ${target.scopeId})`,
      );
      return new Response('This application is not available.', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname;

    const target = await resolverFor(env)(hostname);
    if (!target) {
      // Unknown, still validating, or failed — all the same from outside. Which of
      // those it is belongs in the console, not in a response to an anonymous caller.
      // Not metered either: with no resolved tenant there is no index to write under.
      return new Response('No application is configured for this hostname.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const startedAt = Date.now();
    // If dispatch throws (non-transient vertical error), the runtime answers 500 —
    // record it as such; the finally is what makes error paths count in the metrics.
    let status = 500;
    try {
      const response = await dispatch(env, request, target, hostname);
      status = response.status;
      return response;
    } finally {
      record(env, target, {
        hostname,
        rayId: request.headers.get('cf-ray'),
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  },
};
