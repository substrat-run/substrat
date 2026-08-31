/**
 * The vertical egress worker (#442, #303; control-plane.md §4.7, K-27, D-46).
 *
 * A Workers-for-Platforms **outbound worker** bound to the `substrat-verticals`
 * dispatch namespace. Every `fetch()` a dispatched vertical makes is routed through
 * here before it leaves — Cloudflare invokes this worker in place of the user worker's
 * subrequest (workers-for-platforms/configuration/outbound-workers).
 *
 * It answers two questions per subrequest:
 *
 * 1. **Is the destination ours?** (#442) A vertical calling another vertical's public
 *    `*.substrat.run` API is a **same-zone** subrequest, which never re-enters the router —
 *    it falls through to an origin that isn't there and times out at the edge (522). The
 *    concrete casualty was OIDC: the AuthHero console worker fetching its issuer's JWKS
 *    522'd, so every valid login 401'd. Platform-bound egress is handed to `env.ROUTER`
 *    (a service binding — a direct in-process call), re-entering resolution + dispatch.
 *    This keeps K-27 intact: the vertical reaches the platform *only through the router*.
 *
 * 1b. **Is the destination the platform's own relay?** (#981) The control plane injects
 *    its own origin into every pushed vertical as `CONTROL_PLANE_URL`, and that origin is
 *    on a DIFFERENT zone from the tenant apps — `console.substrat.net`, not
 *    `*.substrat.run` — so `PLATFORM_BASE_DOMAINS` does not cover it. Without an explicit
 *    exemption, a vertical granted `emailSender` POSTing to `/internal/email/send` is
 *    refused by its own outbound policy the moment it declares one, and a push from the
 *    current CLI declares `outbound: []` by default. The relay is the platform's own
 *    surface reached over the platform's own address, not part of the vertical's outbound
 *    surface, so it can no more be a builder's declaration than the router loopback can.
 *
 *    It is allowed straight through rather than looped through `env.ROUTER`: the relay is
 *    a Custom Domain on the control-plane worker, which a Worker subrequest reaches
 *    directly (the same-zone 522 in (1) is a property of zone *routes*), and the router
 *    resolves tenant hostnames — it would answer 404 for the control plane's own. The
 *    verdict is metered as `relay`, distinct from `platform` and from `allowed`, so the
 *    egress report can still tell a call to us from a call to a third party.
 *
 * 2. **May this vertical call this third party?** (#303, D-46) The router passes the
 *    dispatched version's DECLARED outbound surface — package.json `substrat.outbound`,
 *    carried in the deploy manifest, reviewed at the admit checkpoint — as the
 *    `OUTBOUND_POLICY` dispatch parameter. A declared host passes untouched; an
 *    undeclared one is refused with a body that says exactly what to declare. A version
 *    pushed before the declaration existed carries no list (`hosts: null`) and passes
 *    through unenforced until its next push — but every verdict, including that one, is
 *    metered (D-30: meter, don't bill), so the unenforced tail is visible, not silent.
 *
 * Deliberately transparent on the allowed path: verticals need no SDK, no special
 * client, no code change — a plain `fetch('https://api.example.com/…')` just works once
 * declared.
 *
 * Honest limits (self-serve-deploy.md §4.2): Cloudflare outbound workers do not
 * intercept subrequests made from inside Durable Objects, so a DO-originated fetch
 * bypasses this policy today — worker-context egress is what is actually policed. The
 * flip side is free: attaching an outbound worker disables raw TCP `connect()` for
 * every dispatched script, so sockets are closed entirely.
 *
 * That limit is about ENFORCEMENT only, and the distinction is load-bearing (D-58): a
 * DO-originated fetch is not refused here, but it IS traced — Workers automatic tracing
 * emits a `fetch` span with `url.full`/`server.address` from inside the DO — so the
 * control plane's egress report (#859) surfaces it as undeclared drift after the fact.
 * Nothing in this worker changes because of that; it is recorded here so the comment is
 * not read as "DO egress cannot be seen", which is how a true limit acquired a false
 * corollary in D-46.
 */

import { matchesOutboundHost } from '@substrat-run/contracts';

/** What the router passes per dispatch (its `OutboundPolicy` — one shape, two ends). */
export interface OutboundPolicy {
  /** The dispatched vertical's slug — meter attribution and refusal messages. */
  slug: string | null;
  /** The tenant the request was dispatched for — meter attribution only. */
  tenant: string;
  /** The declared outbound surface of the version the script serves. `null` = a
   *  pre-#303 manifest: unenforced (metered only) until the vertical's next push. */
  hosts: string[] | null;
}

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
  /**
   * The control plane's own public origin (e.g. `https://console.substrat.net`) — the same
   * `PLATFORM_CP_URL` var the control plane injects into every pushed vertical as
   * `CONTROL_PLANE_URL` (#303). Set here so this worker knows the one non-`substrat.run`
   * host that is still ours, and does not refuse a vertical's call to the relay it was
   * handed the address of (#981). Only the HOSTNAME is compared; the scheme and path are
   * the relay's own concern. Absent ⇒ no relay exemption, and a vertical with a declared
   * surface is refused as before — the same fail-open-on-plumbing choice `OUTBOUND_POLICY`
   * makes, inverted, because a missing var must never silently widen a policy.
   */
  PLATFORM_CP_URL?: string;
  /**
   * The per-dispatch outbound policy (#303, D-46) — NOT a deploy-time var: the router sets
   * it on every `DISPATCH.get(…, { outbound: { OUTBOUND_POLICY } })`, and the dispatch
   * binding's `parameters` list is what lets it land here. Absent when the dispatcher
   * passed none (an older router): everything passes through unenforced, exactly like a
   * pre-#303 manifest, because a policy that can be dropped by config must fail open on
   * the platform's own plumbing and closed only on what a builder actually declared.
   */
  OUTBOUND_POLICY?: OutboundPolicy;
  /**
   * Per-subrequest egress metering (D-30: meter, don't bill): one datapoint per decision,
   * index = vertical slug. This is the observability that makes the unenforced tail
   * (pre-#303 versions) and any refusal spike visible without reading logs. Optional —
   * metering must never fail a request, and dev/test runs without the dataset.
   */
  ANALYTICS?: AnalyticsEngineDataset;
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

/**
 * The platform relay's hostname, from `PLATFORM_CP_URL` (#981). Unparseable or unset ⇒
 * `null`, i.e. no exemption: a misconfigured var must read as "we have no relay", never as
 * a host that matches everything.
 */
function relayHost(env: Env): string | null {
  const raw = env.PLATFORM_CP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Where a subrequest ended up: the five verdicts the meter distinguishes. */
type Verdict = 'platform' | 'relay' | 'allowed' | 'unenforced' | 'refused';

/** One datapoint per decision — append-only shape, like the router's request meter:
 *  index [slug]; blobs [hostname, verdict, tenant]. */
function meter(env: Env, hostname: string, verdict: Verdict): void {
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: [env.OUTBOUND_POLICY?.slug ?? ''],
      blobs: [hostname, verdict, env.OUTBOUND_POLICY?.tenant ?? ''],
    });
  } catch {
    // Metering must never fail a request.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    if (isPlatformHost(hostname, baseDomains(env))) {
      // Same-zone: hand it to the router over the service binding so it re-enters
      // resolution+dispatch instead of dying at the edge (522). The router strips any
      // inbound `x-substrat-*` and re-asserts the destination's node itself, so the
      // caller cannot forge the tenant it lands as. Policy never applies here — the
      // router's own resolution + the destination vertical's auth are the gate.
      meter(env, hostname, 'platform');
      return env.ROUTER.fetch(request);
    }
    if (hostname.toLowerCase() === relayHost(env)) {
      // The platform's own relay (#981), on a different zone from the tenant apps. The
      // vertical did not choose this address — the control plane injected it as
      // `CONTROL_PLANE_URL` — so it is not part of the outbound surface a builder
      // declares, and the policy below never gets to see it. The relay authenticates
      // its own callers; being allowed here is reachability, not authorization.
      meter(env, hostname, 'relay');
      return fetch(request);
    }
    const policy = env.OUTBOUND_POLICY;
    if (!policy || policy.hosts === null) {
      // No declared surface travelled with this dispatch: a pre-#303 version (or a
      // dispatcher that passed no policy). Unenforced by design — least privilege
      // arrives version by version, not as a fleet outage — but never invisible.
      meter(env, hostname, 'unenforced');
      return fetch(request);
    }
    if (matchesOutboundHost(hostname, policy.hosts)) {
      // The one place a vertical's subrequest actually leaves for the public internet.
      meter(env, hostname, 'allowed');
      return fetch(request);
    }
    meter(env, hostname, 'refused');
    return new Response(
      JSON.stringify({
        error: 'outbound refused',
        host: hostname,
        vertical: policy.slug,
        detail:
          `'${hostname}' is not in this vertical's declared outbound surface. ` +
          `Add it to package.json substrat.outbound (e.g. ["${hostname}"]) and push a new ` +
          'version — the declaration is reviewed at the admit checkpoint ' +
          '(self-serve-deploy.md §4.2, #303).',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  },
};
