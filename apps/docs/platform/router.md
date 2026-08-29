# Router

**One worker in front of every vertical.** It resolves an inbound
`hostname → (tenant, scope, vertical, surface)` against the [control plane](/platform/control-plane)'s
directory and forwards the request to the right vertical over a service binding, asserting the
resolved node in `x-substrat-*` headers. Before it existed, a provisioned scope had no URL — the
console faked one with an env var.

It is built on [`createRouteResolver`](/reference/adapter-cloudflare) (the adapter's `routing`
subpath). K-26/K-27.

## Why one router

- **Not one per vertical.** Cert and DNS lifecycle in one place means a new vertical gets custom
  domains for free instead of repeating the Cloudflare-for-SaaS dance each time.
- **Not one per jurisdiction.** The router is stateless and holds nothing regional, so a per-region
  router would duplicate the cert/DNS lifecycle and buy nothing. *Verticals*, by contrast, **do**
  deploy per jurisdiction (K-30): `substrat-fsm-eu` binds EU storage and cannot reach US data — a
  worker that *cannot* beats one that merely chooses not to. The router itself does **not** enforce
  region: `verticalFor(env, target)` keys on the resolved route's `deploymentRef` (the Workers-for-Platforms
  dispatch handle) and falls back to the static `VERTICAL_<SLUG>` binding — `target.region` is carried
  but never re-checked here. Residency is pinned by configuration, not by a code branch in the router:
  Regional Services pins TLS termination and processing at the edge, *ahead* of this worker, and the
  DO jurisdiction pins storage and execution (K-7). Re-checking region in the router would be a third
  enforcement point that can only ever disagree with those two.

This does not erode the decision against bundling verticals into one DO class (D-30): a router
*forwards*; deployments stay separate, and upgrade on their own schedules.

## The trust boundary

A vertical trusts the `x-substrat-*` headers **absolutely** — they name the tenant whose data it
will serve. Two things keep that safe, and both are required:

1. **Vertical workers have no public route** (`workers_dev: false`, no route) — reachable only by
   service binding from the router.
2. **`ROUTER_SECRET`**, the same value on the router and every vertical, presented as
   `x-substrat-router` and verified in the kernel (`readRoutedNode`).

Both halves **fail closed** when the secret is missing: the router answers 500 to every
request until its `ROUTER_SECRET` is set, and a vertical deployed without its own refuses
any asserted node (400) rather than trusting unsigned headers. The only opt-out is
`ALLOW_DEV_NODE`, which already names the un-routed local instance.

(2) exists because (1) is a deployment fact and `workers.dev` is on by default — one forgotten
toggle makes (1) false with nothing in the code noticing, and the consequence is a cross-tenant
read. The router also **strips every inbound `x-substrat-*` header** (by prefix) before setting its
own, so a client cannot forge a node.

## Status

The hostname → node resolution, the trust boundary, and dispatch are built. Hostname
*provisioning* is built too: [`packages/control-plane-api`](https://github.com/substrat-run/substrat/tree/main/packages/control-plane-api)'s
custom-hostname provisioner drives the Cloudflare-for-SaaS `custom_hostnames` API end to end —
`create` registers a hostname and returns the DNS records the tenant publishes, `check` polls
validation + certificate state, `remove` retires it — with public-suffix enforcement (a tenant can't
claim `co.uk`), wired through the control plane's `/hostnames` routes. A platform hostname is live
immediately under the wildcard cert; a custom domain lands `pending` and walks the DNS-validation
lifecycle, and only an `active` binding resolves. The provisioner is injected, so a self-host or dev
environment with no CF-for-SaaS zone simply records the binding `pending` and never issues.

Dispatch runs both shapes. When the resolved route carries a `deploymentRef`, the router dispatches
through the Workers-for-Platforms namespace (`env.DISPATCH.get(deploymentRef)`) — this is how
customer-pushed verticals are reached, and it is built. The static `VERTICAL_<SLUG>` service-binding
map — the milestone-one shape — remains as the fallback for a route with no bound version. All of it
lives inside `verticalFor`; nothing else in the router changes between the two.
