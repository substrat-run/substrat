/**
 * The vertical egress worker (#442; control-plane.md §4.7, K-27).
 *
 * A Workers-for-Platforms **outbound worker** bound to the `substrat-verticals`
 * dispatch namespace. Every `fetch()` a dispatched vertical makes is routed through
 * here before it leaves — Cloudflare invokes this worker in place of the user worker's
 * subrequest (workers-for-platforms/configuration/outbound-workers).
 *
 * It exists to close one structural gap: a vertical calling another vertical's public
 * `*.substrat.run` API. That is a **same-zone** subrequest, and a same-zone worker
 * subrequest never re-enters the router — it falls through to an origin that isn't
 * there and times out at the edge (522). The concrete casualty was OIDC: the AuthHero
 * console worker fetching its issuer's JWKS (`{issuer}/.well-known/jwks.json`, another
 * vertical on our own zone) 522'd, so every valid login 401'd (#442).
 *
 * The fix is to send platform-bound egress back **through the router** — the one worker
 * that resolves `hostname → (tenant, scope, vertical)` and dispatches. We reach it over
 * a service binding (`env.ROUTER`), which is a direct in-process call, not an edge
 * subrequest, so it dodges the same-zone loopback entirely. This keeps K-27 intact: the
 * vertical still reaches the platform *only through the router* — this worker is just the
 * plumbing that makes a plain `fetch('https://other.global.substrat.run/…')` take that
 * path instead of dying.
 *
 * Everything else — a connector hitting a third-party API, any call to a host that is
 * NOT ours — passes straight through to the public internet, untouched.
 *
 * Deliberately transparent: verticals need no SDK, no special client, no code change.
 * And deliberately minimal — it routes by *destination* only. A caller-identity story
 * (who may call whom, per #303's outbound network policy) layers on top here later; the
 * dispatch binding can pass the calling script as an outbound `parameter` when that lands.
 */

export interface Env {
  /**
   * The environment-wide router, as a service binding (→ `substrat-router`). Platform-bound
   * egress is handed here as a direct in-process call; the router resolves the destination
   * hostname and dispatches, exactly as it would a public request. Distinct from a *route*:
   * this worker has no public hostname of its own — it is only ever reached as the namespace's
   * outbound worker.
   */
  ROUTER: Fetcher;
  /**
   * Comma-separated base domains that ARE the platform (e.g. `"substrat.run"`). A destination
   * whose hostname equals or is a subdomain of one of these is another app on our own zone and
   * must be dispatched by the router; anything else is the outside world. Same var and parsing
   * the control plane uses to classify a hostname (`apps/control-plane/src/worker.ts`), so the
   * two agree on what "platform" means. Absent ⇒ nothing is platform, so everything passes
   * through — a safe default that never misroutes external traffic into the router.
   */
  PLATFORM_BASE_DOMAINS?: string;
}

/** Parse the platform base domains, mirroring the control plane's `platformBaseDomains`. */
const baseDomains = (env: Env): string[] =>
  (env.PLATFORM_BASE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

/**
 * A destination on our own platform zone — the case that must loop back through the router.
 * Matches the base domain itself or any subdomain of it (`substrat.run`,
 * `x.global.substrat.run`, `x.global.test.substrat.run` all match `substrat.run`). Exact-or-dot
 * boundary so `notsubstrat.run` never matches `substrat.run`.
 */
function isPlatformHost(hostname: string, bases: string[]): boolean {
  const h = hostname.toLowerCase();
  return bases.some((b) => h === b || h.endsWith(`.${b}`));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    if (isPlatformHost(hostname, baseDomains(env))) {
      // Same-zone: hand it to the router over the service binding so it re-enters
      // resolution+dispatch instead of dying at the edge (522). The router strips any
      // inbound `x-substrat-*` and re-asserts the destination's node itself, so the
      // caller cannot forge the tenant it lands as.
      return env.ROUTER.fetch(request);
    }
    // The outside world: pass through untouched. This is the only place a vertical's
    // subrequest actually leaves for the public internet.
    return fetch(request);
  },
};
