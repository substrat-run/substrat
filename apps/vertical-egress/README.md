# @substrat-run/vertical-egress

The dispatch-namespace **outbound worker** (#442, K-27). It is the seam every hosted
vertical's outbound `fetch()` passes through before it leaves.

## Why it exists

A vertical calling another vertical's public `*.substrat.run` API is a **same-zone**
subrequest, and a same-zone worker subrequest never re-enters the router — it falls through
to an origin that isn't there and times out at the edge (**522**). That broke OIDC: the
AuthHero console fetching its issuer's JWKS (another vertical on our own zone) 522'd, so every
valid login 401'd.

## What it does

One decision per subrequest, by **destination hostname**:

- **Platform host** (equals or is a subdomain of a `PLATFORM_BASE_DOMAINS` entry, e.g.
  `substrat.run`) → hand it to `env.ROUTER` (a service binding = direct in-process call) so it
  re-enters the router's `hostname → (tenant, scope, vertical)` resolution + dispatch. The
  router strips inbound `x-substrat-*` and re-asserts the destination's node, so a caller can't
  forge the tenant it lands as.
- **Everything else** → `fetch(request)`, straight to the public internet, untouched. This is
  the only place a vertical's subrequest actually leaves for a third party.

Transparent: verticals need no SDK and no code change — a plain
`fetch('https://other.global.substrat.run/…')` just works.

## Wiring

Bound as the outbound worker on the router's dispatch namespace binding
(`apps/router/wrangler.jsonc` → `dispatch_namespaces[].outbound.service`). CI deploys it
between control-plane and router (it holds a service binding back to the already-live router).

## Not in scope

- **Caller identity / policy** (who may call whom) — that is #303's outbound network policy,
  which layers on here via the binding's outbound `parameters`.
- **The control plane's dispatch binding** — deliberately left alone (internal provisioning,
  not cross-vertical HTTP; wiring it would create a deploy-order cycle).
- **Egress from inside a scope Durable Object** — outbound workers do not intercept DO
  subrequests. Not a gap today: module code can't `fetch` at all (boundary-lint R3), and the
  OIDC path that motivated this runs in the vertical's top-level worker.
