# @substrat-run/router

## 0.2.28

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/adapter-cloudflare@0.88.0

## 0.2.27

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/adapter-cloudflare@0.87.0

## 0.2.26

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/adapter-cloudflare@0.86.0

## 0.2.25

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/adapter-cloudflare@0.85.0

## 0.2.24

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/adapter-cloudflare@0.84.0

## 0.2.23

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/adapter-cloudflare@0.83.0

## 0.2.22

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
- Updated dependencies [75925a2]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/adapter-cloudflare@0.82.0

## 0.2.21

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/adapter-cloudflare@0.81.0

## 0.2.20

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/adapter-cloudflare@0.80.0

## 0.2.19

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
- Updated dependencies [87ec6f2]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/adapter-cloudflare@0.79.0

## 0.2.18

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/adapter-cloudflare@0.78.0

## 0.2.17

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/adapter-cloudflare@0.77.0

## 0.2.16

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/adapter-cloudflare@0.76.0

## 0.2.15

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/adapter-cloudflare@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.2.14

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/adapter-cloudflare@0.74.0

## 0.2.13

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/adapter-cloudflare@0.73.0

## 0.2.12

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/adapter-cloudflare@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.2.11

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/adapter-cloudflare@0.71.0

## 0.2.10

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/adapter-cloudflare@0.70.0

## 0.2.9

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/adapter-cloudflare@0.69.0

## 0.2.8

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/adapter-cloudflare@0.68.0

## 0.2.7

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/adapter-cloudflare@0.67.0

## 0.2.6

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.2.5

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/adapter-cloudflare@0.65.0

## 0.2.4

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0

## 0.2.3

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.2.2

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/adapter-cloudflare@0.62.0

## 0.2.1

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/adapter-cloudflare@0.61.0

## 0.2.0

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
  - @substrat-run/adapter-cloudflare@0.60.0

## 0.1.45

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/adapter-cloudflare@0.59.0

## 0.1.44

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0

## 0.1.43

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/adapter-cloudflare@0.57.0

## 0.1.42

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0

## 0.1.41

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/adapter-cloudflare@0.55.0

## 0.1.40

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0

## 0.1.39

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/contracts@0.53.0

## 0.1.38

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/adapter-cloudflare@0.52.0

## 0.1.37

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/adapter-cloudflare@0.51.0

## 0.1.36

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/contracts@0.50.0

## 0.1.35

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/adapter-cloudflare@0.49.0

## 0.1.34

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0

## 0.1.33

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.1.32

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/adapter-cloudflare@0.46.0

## 0.1.31

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0

## 0.1.30

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.1.29

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

## 0.1.28

### Patch Changes

- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/contracts@0.43.0

## 0.1.27

### Patch Changes

- Updated dependencies [b0355b4]
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.1.26

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/contracts@0.41.0

## 0.1.25

### Patch Changes

- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.1.24

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0

## 0.1.23

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0

## 0.1.22

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/adapter-cloudflare@0.37.0

## 0.1.21

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/adapter-cloudflare@0.36.0

## 0.1.20

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/adapter-cloudflare@0.35.0

## 0.1.19

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0

## 0.1.18

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0

## 0.1.17

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0

## 0.1.16

### Patch Changes

- fa8feb9: Router kick: drain a scope's platform-intents in seconds, not at the next sweep.

  The last piece of the platform-intents latency story. A vertical enqueues an intent and
  flags it on the response with `x-substrat-platform-request`; the router — the one hop that
  already knows the resolved `(tenant, scope)` — pings the control plane to drain that scope
  immediately, collapsing the ~2-min periodic-sweep delay to seconds.

  - **control-plane:** the per-scope drain the sweep ran inline is extracted to a module-level
    `drainOneScope(env, tenant, scope)` (serving-ref → bound-version → prod ladder, the same
    `provision-sibling` + `archive-scope` handlers). A new platform-secret-gated
    `POST /internal/drain-scope` runs it on demand. Identity stays inherent: the body only
    _names_ which scope to drain; the tenant/vertical are re-derived from this directory's own
    record, so a caller with the global secret can at most accelerate a scope's own pending
    work. An unconfigured secret **refuses** (fails closed), never bypasses.
  - **router:** after dispatch, when the response carries `x-substrat-platform-request`, the
    router `ctx.waitUntil`s a best-effort kick to `/internal/drain-scope` over a new
    `CONTROL_PLANE_KICK` service binding (prod → `substrat-control-plane`, test → its `-test`
    peer), presenting the global `PLATFORM_SECRET`. Out of band and best-effort by design: the
    user's response is returned untouched, and a missing/failed/unconfigured kick simply falls
    back to the durable sweep — latency, never correctness.

  The sweep remains the reliability backstop; the kick is pure latency. Tested: the router
  kicks the _resolved_ node (not caller-supplied) with the secret when flagged, does not kick
  otherwise, and never throws when unconfigured; the control-plane endpoint fails closed when
  no secret is bound. Refs #358.

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0

## 0.1.15

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0

## 0.1.14

### Patch Changes

- Updated dependencies [c64bdf8]
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/contracts@0.29.0

## 0.1.13

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/contracts@0.28.0

## 0.1.12

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0

## 0.1.11

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0

## 0.1.10

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0

## 0.1.9

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0

## 0.1.8

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/adapter-cloudflare@0.23.0

## 0.1.7

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0

## 0.1.6

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/contracts@0.21.0

## 0.1.5

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0

## 0.1.4

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0

## 0.1.3

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0

## 0.1.2

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0

## 0.1.1

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0

## 0.1.0

### Minor Changes

- 297e057: Observability, views 1–3 of design/observability.md — piggyback Cloudflare, stamp
  what only we know:

  - **Seam + Cloudflare reader** (`control-plane-api`): a provider-neutral
    `ObservabilityReader` contract (service/namespace vocabulary, never
    script/dispatch-namespace) with `createCfObservabilityReader` as the injected
    Cloudflare implementation (GraphQL invocation analytics + the Workers
    Observability telemetry query API) — the `DeployVerticalFn`/`wfp.ts` pattern, so
    an APM/OTel backend can slot in behind identical routes later. Two staff-only
    proxy routes: `GET /observability/metrics` and `GET /observability/logs`
    (501 when no backend is configured; deliberately not in `BUILDER_ROUTES`).
  - **Router**: one Analytics Engine datapoint per resolved request — index
    `tenantId`, blobs `(vertical, scope, surface, statusClass, rayId)`, doubles
    `(durationMs, status)` — plus a structured JSON log line with the same fields.
    The router is the only place that knows which tenant a request belonged to;
    written now so tenant-keyed history accrues before any tenant-facing read path
    exists. Metering never fails a request, and error paths are counted.
  - **WfP uploads**: pushed verticals get `observability: { enabled: true }`, so
    builder logs exist to query.
  - **Console**: an Observability fleet view — per-service invocations, error
    rates, CPU quantiles, and a row-click recent-logs panel.
  - **Dashboard**: a Traffic panel on the Verticals view showing the team's own
    deployed versions (requests/errors/CPU + recent logs). Owner-narrowing lives in
    `TenantNarrowedControlPlane`: metrics rows are filtered to owned deployment
    refs and mapped back to (vertical, version); a logs query for an unowned ref
    answers `[]` without ever reaching the plane.

  Deploy notes: the control plane's `CF_API_TOKEN` additionally needs **Account
  Analytics: Read** and **Workers Observability: Read**; the router redeploy picks
  up the `substrat_router` AE dataset binding (auto-created on first write).

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/contracts@0.15.0

## 0.0.9

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0

## 0.0.8

### Patch Changes

- 6abbce9: **Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
  router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
  `ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
  the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.
- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.0.7

### Patch Changes

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/architecture/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0

## 0.0.6

### Patch Changes

- Updated dependencies [a277bb7]
- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
  - @substrat-run/adapter-cloudflare@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.0.5

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/adapter-cloudflare@0.10.0

## 0.0.4

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/adapter-cloudflare@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.3

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/adapter-cloudflare@0.8.0

## 0.0.2

### Patch Changes

- ad89a9d: Fix: the router built one Durable Object stub and reused it across requests.

  A DO stub is an I/O object owned by the request that created it, so reusing one
  throws `Cannot perform I/O on behalf of a different request`. The first request after
  each cold start succeeded and every request after it returned 1101 — which is why
  nothing caught it before production: every test sent a single request.

  `createRouteResolver` now creates the stub inside the returned closure, per call, and
  the router no longer memoises the resolver. Only the namespace binding may be held
  across requests; nothing derived from one may be.

  `CloudflareScopeHost` has the same shape and is safe only because every worker
  rebuilds it per request. That requirement is now stated on the constructor.

- 392ba98: The router retries a transient dispatch failure once, for bodyless requests only.

  Verifying K-28 turned up a second finding: a freshly-deployed user worker is not
  instantly reachable everywhere. One scope got `Worker not found.` for ~15s while
  sibling scopes on the same script succeeded — its Durable Object had placed in a colo
  the script had not propagated to — and it healed on its own.

  There is no propagation-complete signal to wait for, so this is not a delay. It is one
  bounded retry, which also survives being wrong about the cause: the colo explanation is
  an inference from the symptom, not something Cloudflare documents.

  Bodyless requests only. A retry is safe only when the first attempt provably had no
  effect, and replaying a POST that already reached the vertical would run the mutation
  twice.

- Updated dependencies [c54637b]
- Updated dependencies [33fb5dd]
- Updated dependencies [ad89a9d]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/adapter-cloudflare@0.7.0
