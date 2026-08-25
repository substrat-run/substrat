# @substrat-run/vertical-egress

## 0.1.28

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0

## 0.1.27

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.1.26

### Patch Changes

- @substrat-run/contracts@0.86.0

## 0.1.25

### Patch Changes

- @substrat-run/contracts@0.85.0

## 0.1.24

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0

## 0.1.23

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0

## 0.1.22

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0

## 0.1.21

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0

## 0.1.20

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0

## 0.1.19

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0

## 0.1.18

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0

## 0.1.17

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0

## 0.1.16

### Patch Changes

- @substrat-run/contracts@0.76.0

## 0.1.15

### Patch Changes

- @substrat-run/contracts@0.75.0

## 0.1.14

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0

## 0.1.13

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0

## 0.1.12

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.1.11

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0

## 0.1.10

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0

## 0.1.9

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0

## 0.1.8

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
  - @substrat-run/contracts@0.68.0

## 0.1.7

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
  - @substrat-run/contracts@0.67.0

## 0.1.6

### Patch Changes

- @substrat-run/contracts@0.66.0

## 0.1.5

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0

## 0.1.4

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.63.0

## 0.1.2

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0

## 0.1.1

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0

## 0.1.0

### Minor Changes

- 3ee5903: feat: outbound network policy for hosted verticals — a declared per-version allowlist, enforced at the egress worker and metered on every verdict (D-46, closes #303)

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
    declared list of _the version whose code the dispatch runs_ — the serving
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

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0

## 0.0.1

### Patch Changes

- 714ccf4: Cross-vertical HTTP now works: a dispatched vertical calling another vertical's public
  `*.substrat.run` API used to 522 at the same-zone edge, because a same-zone worker
  subrequest never re-enters the router (#442). The concrete casualty was OIDC — the
  AuthHero console fetching its issuer's JWKS from another vertical on our own zone timed
  out, so every valid login 401'd.

  Adds `@substrat-run/vertical-egress`, a Workers-for-Platforms **outbound worker** bound
  to the `substrat-verticals` dispatch namespace. Every dispatched vertical's `fetch()` is
  routed through it: platform-bound egress (any host that is or ends in `PLATFORM_BASE_DOMAINS`)
  is handed back to the router over a service binding — a direct in-process call that dodges
  the same-zone loopback and re-enters normal resolution+dispatch — and everything else passes
  straight through to the public internet, untouched. This keeps K-27 intact (a vertical still
  reaches the platform only through the router) and needs no vertical code change.

  Scoped to the router's dispatch binding (the login path). The control plane's dispatch
  binding is deliberately left alone — its dispatched calls are internal provisioning, not
  cross-vertical public HTTP, and wiring it would create a deploy-order cycle (it deploys
  first). The caller-identity half — who may call whom — is #303's outbound network policy,
  which layers on this worker later via the binding's outbound `parameters`.
