# @substrat-run/vertical-egress

The dispatch-namespace **outbound worker** (#442, #303, K-27, D-46). It is the seam every
hosted vertical's outbound `fetch()` passes through before it leaves.

## Why it exists

A vertical calling another vertical's public `*.substrat.run` API is a **same-zone**
subrequest, and a same-zone worker subrequest never re-enters the router — it falls through
to an origin that isn't there and times out at the edge (**522**). That broke OIDC: the
AuthHero console fetching its issuer's JWKS (another vertical on our own zone) 522'd, so every
valid login 401'd.

And once every subrequest passes through one seam, that seam is where outbound *policy*
lives (#303): egress from a hosted worker runs under the platform's Cloudflare account, so
it is a security surface (SSRF, exfiltration) and a cost/abuse surface. The policy is the
vertical's own **declared outbound surface** — reviewed at the admit checkpoint, enforced
here.

## What it does

Two decisions per subrequest, by **destination hostname**:

- **Platform host** (equals or is a subdomain of a `PLATFORM_BASE_DOMAINS` entry, e.g.
  `substrat.run`) → hand it to `env.ROUTER` (a service binding = direct in-process call) so it
  re-enters the router's `hostname → (tenant, scope, vertical)` resolution + dispatch. The
  router strips inbound `x-substrat-*` and re-asserts the destination's node, so a caller can't
  forge the tenant it lands as. Policy never applies here — the destination vertical's own
  auth is the gate.
- **Everything else** → checked against the dispatched version's declared outbound surface
  (`OUTBOUND_POLICY`, a dispatch parameter the router passes from the resolve): a declared
  host goes to the public internet untouched; an undeclared one is refused with a **403**
  whose body names the host and says what to declare (`package.json substrat.outbound`).
  A version pushed by a pre-#303 CLI carries no list (`hosts: null`) and passes through
  unenforced until its next push.

Every verdict — `platform`, `allowed`, `unenforced`, `refused` — writes one Analytics
Engine datapoint (`substrat_egress`: index = vertical slug, blobs = [hostname, verdict,
tenant]). D-30: meter, don't bill — the unenforced tail and any refusal spike are visible
without reading logs.

Transparent on the allowed path: verticals need no SDK and no code change — a plain
`fetch('https://api.example.com/…')` just works once declared.

## Wiring

Bound as the outbound worker on the router's dispatch namespace binding
(`apps/router/wrangler.jsonc` → `dispatch_namespaces[].outbound.service`), with
`parameters: ["OUTBOUND_POLICY"]` declaring the per-dispatch value the router passes at
`DISPATCH.get(ref, {}, { outbound: { OUTBOUND_POLICY } })`. CI deploys this worker
between control-plane and router (it holds a service binding back to the already-live
router).

## Honest limits

- **Durable Object subrequests are not intercepted** — a Cloudflare limitation of outbound
  workers, and Substrat verticals are DO-centric, so a fetch made from inside a vertical's
  own DO bypasses this policy today. Worker-context egress is what is actually policed; the
  declared surface remains the reviewed contract for all of it. (Attaching an outbound
  worker does close one channel entirely: raw TCP `connect()` is disabled for every
  dispatched script.)
- **The control plane's own dispatch binding** is deliberately not behind this worker
  (internal provisioning, not cross-vertical HTTP; wiring it would create a deploy-order
  cycle). Connector egress is platform-side (`ConnectorContext.fetch`) and governed by its
  own policy.
