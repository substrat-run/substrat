# `@substrat-run/router`

The environment-wide router (K-26/K-27; [control-plane.md §4.7](../../docs/architecture/control-plane.md)).

One worker in front of every vertical. It resolves `hostname → (tenant, scope,
vertical, surface)` against the shared control plane's directory and forwards over a
service binding, asserting the resolved node in `x-substrat-*` headers.

Before this, a provisioned scope had no URL — the console faked it with a
`VITE_PORTAL_BASE` env var.

## Why one router

**Not one per vertical.** Cert and DNS lifecycle in one place means a new vertical
gets custom domains for free instead of repeating the Cloudflare for SaaS dance.

**Not one per jurisdiction** — the router specifically. It is stateless and holds
nothing regional, so a per-region router would duplicate the cert and DNS lifecycle and
buy nothing.

**Verticals are different, and they DO deploy per jurisdiction** (K-30). Bindings are
per-deployment, so `substrat-fsm-eu` holds an EU D1 and opens EU-jurisdiction Durable
Objects: a worker that *cannot* reach US storage beats one that chooses not to — the
same reasoning as this worker having no `SCOPE` binding. `verticalFor` therefore keys on
`(slug, region)`.

TLS termination is pinned by a wildcard Regional Hostnames config per jurisdiction
(`*.eu.substrat.run`), not by anything the router does — termination happens before this
code runs. The `region` on a binding is there so the router can detect a contradiction
between the edge configuration and the directory and refuse the request.

**This does not erode D-30.** That decision rejects bundling verticals into one DO
class, which would force lockstep engine upgrades across verticals owned by different
companies. A router forwards; deployments stay separate.

## The trust boundary

The vertical trusts the `x-substrat-*` headers absolutely — they name the tenant whose
data it will serve. Two things keep that safe, and both are required:

1. **Vertical workers have no public route.** `workers_dev: false`, no route, reachable
   only by service binding from here.
2. **`ROUTER_SECRET`**, the same value here and on every vertical. Presented as
   `x-substrat-router` and verified by `readRoutedNode` in the kernel.

Both halves fail closed when the secret is missing: this router answers 500 to every
request until `ROUTER_SECRET` is set, and a vertical without its own refuses any asserted
node (400) rather than trusting unsigned headers — `ALLOW_DEV_NODE` is the only opt-out,
for the un-routed local instance it already names.

(2) exists because (1) is a deployment fact and `workers.dev` is on by default — one
forgotten toggle makes (1) false with nothing in the code noticing, and the consequence
is a cross-tenant read. The router also **strips every inbound `x-substrat-*` header**
before setting its own, by prefix rather than by name.

## Deploying

```sh
wrangler secret put ROUTER_SECRET          # same value on each vertical
pnpm --filter @substrat-run/router cf:deploy
```

Then bind a hostname and make it active — until then the router answers 404, because a
name it does not know is a name it will not serve:

```ts
await host.admin.bindHostname(actor, {
  hostname: 'acme.example.com',
  tenantId, scopeId, surface: 'app', region: null, canonical: true,
});
await host.admin.setHostnameStatus(actor, 'acme.example.com', 'active');
```

Hostname *provisioning* — the custom-hostnames API, DNS validation, cert issuance —
is not built yet, so `active` is set by hand. A wildcard under a domain we control is
enough until it is.

## Adding a vertical

One service binding in `wrangler.jsonc`, named `VERTICAL_<SLUG>` with dashes as
underscores (`bike-shop` → `VERTICAL_BIKE_SHOP`).

That static map is the milestone-one shape and does not pretend to be what replaces it:
customer-pushed verticals need a Workers-for-Platforms dispatch namespace (#31 blocker
1), which changes the lookup in `verticalFor` and nothing else.

## Not here

**Caching.** Resolution is one directory read per request, uncached. K-26 defers cache
invalidation to open question 5 rather than answering it twice — a cached route that
keeps serving a suspended tenant blunts suspension, which §7 calls a live weapon.

**Suspension.** `getScope` owns it, inside the vertical. A second enforcement point is
a second thing that can disagree with the first.

**Scope access.** The router has no `SCOPE` binding and cannot open a scope DO. It
finds the door; it never opens it.
