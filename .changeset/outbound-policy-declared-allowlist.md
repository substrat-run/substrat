---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/router": minor
"@substrat-run/vertical-egress": minor
"@substrat-run/console": patch
---

feat: outbound network policy for hosted verticals — a declared per-version allowlist, enforced at the egress worker and metered on every verdict (D-46, closes #303)

Egress from a hosted worker runs under the platform's Cloudflare account — an
SSRF/exfiltration and cost/abuse surface — yet every dispatched `fetch()` passed
through the egress worker (#442) untouched, and self-serve-deploy.md §6.3 left
the policy an explicit open question. Answered: **allowlist and metered**, with
the allowlist being the vertical's own declaration, reviewed at the admit
checkpoint like the permission surface.

- **Declaration** (`contracts`): `substrat.outbound` in the vertical's
  package.json — exact lowercase hostnames plus `*.`-wildcards (any subdomain
  depth, never the apex); `outboundHost` schema, `matchesOutboundHost` matcher
  (one implementation for every seam that asks), `outbound` on the deploy
  manifest, and the list lifted onto the version record so a list view never
  parses whole manifests.
- **CLI**: carries the declaration on push and preview, and **always** sends it
  — `[]` when undeclared, because no direct third-party egress is the correct
  default (connectors run platform-side, mail rides the `emailSender` relay,
  cross-vertical calls ride the router).
- **Resolution** (both adapters): `readHostname`/`resolveHostname` join the
  declared list of *the version whose code the dispatch runs* — the serving
  version when the stable serving script wins, the bound version on the
  per-version fallback — as `RouteTarget.outboundHosts`, via `json_extract` so
  the hot path stays one directory read.
- **Router**: passes `{ slug, tenant, hosts }` as the `OUTBOUND_POLICY` outbound
  dispatch parameter (`dispatch_namespaces[].outbound.parameters`).
- **Egress worker**: platform hosts keep looping through the router (K-27),
  declared hosts pass untouched, anything else is a 403 whose body names the
  host and says what to declare. A pre-#303 version resolves `hosts: null` and
  passes through unenforced until its next push — least privilege arrives
  version by version, never as a fleet outage. Every verdict
  (`platform`/`allowed`/`unenforced`/`refused`) writes one Analytics Engine
  datapoint (`substrat_egress`, index = slug; D-30 meter-don't-bill), so the
  unenforced tail and any refusal spike are charts, not guesses.
- **Console**: the version table renders the declared surface beside the Admit
  button — `none`, the host list, or `undeclared (unenforced)`.

Honest limit, published with the mechanism (self-serve-deploy.md §4.2):
Cloudflare outbound workers do not intercept Durable-Object-originated
subrequests, so DO-context fetches bypass enforcement today — worker-context
egress is what is policed, and the declared list remains the reviewed contract
for all of it. Attaching an outbound worker does disable raw TCP `connect()`
for every dispatched script.
