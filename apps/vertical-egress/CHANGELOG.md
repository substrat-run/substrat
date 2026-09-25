# @substrat-run/vertical-egress

## 0.1.61

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0

## 0.1.60

### Patch Changes

- @substrat-run/contracts@0.120.0

## 0.1.59

### Patch Changes

- 8009cd1: A deployed vertical can now call another vertical of the same tenant. The platform says which app is calling, so the caller holds no credential (#1706, part 2: the hosted transport). Part 1 built the door; this is the path to it.

  **What a vertical author writes.** The caller declares who it calls, in package.json:

  ```json
  { "substrat": { "calls": ["acme/crm"] } }
  ```

  and calls it from its harness:

  ```ts
  const result = await peerClient("acme/crm").invoke("customer/list", {
    limit: 50,
  });
  ```

  There is no address, no token and no outbound-allowlist entry. What the caller may then DO is the target's own `peers` declaration, which its permission diff reviews.

  **How the platform knows who is calling.** The call goes to one reserved address, `peer.substrat.internal`, which is in no DNS zone:

  - the **egress worker** — which every dispatched `fetch` passes through — recognises that address before its outbound policy and hands the call to the router, with the caller taken from the dispatch parameters the router set when it dispatched the caller. Nothing in the request contributes to it, and the body is strict, so it cannot carry one;
  - the **router**'s `PeerCalls` entrypoint (reachable only through a service binding, never over its public `fetch`) resolves the target in the caller's own tenant and dispatches the target's `/internal/vertical-invoke`;
  - a call made where egress cannot see it — from inside a Durable Object, which outbound workers do not intercept — **fails to resolve** instead of leaving the isolate. That is why the address is unroutable rather than real.

  **Module code reaches a peer asynchronously.** An operation, a consumer or a schedule runs inside the scope's Durable Object, where module code has no network by rule. It enqueues a `peer-invoke` platform intent instead (`ctx.requestPlatform`), and the control plane's drain delivers it with the caller taken from the scope it found the row in. At-least-once, with the intent id as the idempotency key.

  **The gates, on both legs:**

  - the caller's declared `substrat.calls` (a version pushed before the declaration carries `null` and is unenforced, exactly as a pre-#303 `outbound` is);
  - the caller is a live, primary instance of the vertical it claims — never a preview, and the refusal names the local broker as the way to test the edge;
  - the target resolves to exactly one primary, active instance **in the caller's tenant**, never guessed when a tenant runs two;
  - a synchronous chain is bounded by `PEER_CALL_DEPTH_MAX`, its own constant, deliberately not shared with #1705's event hop cap.

  **Contract additions.** `@substrat-run/contracts` adds `peer-transport.ts` (`PEER_CALL_HOST`, `PEER_CALL_URL`, `isPeerCallHost`, `PEER_CALL_DEPTH_MAX`, `peerCallRequest`, `peerCaller`, `callsDeclares` and the refusal messages) and the `peer-invoke` intent kind with its payload. The deploy manifest, `RouteTarget` and the version record each gain `calls` beside `outbound`, lifted from the stored manifest by `callsOfManifestJson`. `@substrat-run/vertical-host` exports `peerClient`; `@substrat-run/control-plane-api` adds `VerticalClient.verticalInvoke` and `peerInvokeHandler`; the Cloudflare adapter adds `createPeerCallResolver` and the directory's `peerCallTarget` read.

  **Operators:** the egress worker needs its new `PEER_CALLS` binding to the router's `PeerCalls` entrypoint, and the router now deploys from `src/index.ts` (which exports both the fetch handler and that entrypoint). Without the binding, peer calls are refused — never passed through.

  The console scope page and dashboard app page now show incoming peer access and offer cut-off/restore controls with an audited reason. Hosted switch/status calls delegate to the deployment holding the grants. The dashboard also discloses outgoing targets after installation, keeping missing targets, refused access and unreadable status distinct. `peersDeclaredBy` derives peer permissions from the model's operations. The architecture guide includes an executable local call/cut-off/restore example and operator rollout steps.

  Instance binding when a tenant runs multiple active targets remains excluded, tracked in #1720; ambiguous calls are refused.

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0

## 0.1.58

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0

## 0.1.57

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0

## 0.1.56

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0

## 0.1.55

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0

## 0.1.54

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0

## 0.1.53

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0

## 0.1.52

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0

## 0.1.51

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0

## 0.1.50

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.1.49

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
  - @substrat-run/contracts@0.109.0

## 0.1.48

### Patch Changes

- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/contracts@0.108.0

## 0.1.47

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0

## 0.1.46

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.1.45

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.1.44

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.1.43

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

## 0.1.42

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.1.41

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.1.40

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.1.39

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0

## 0.1.38

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0

## 0.1.37

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/contracts@0.97.0

## 0.1.36

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0

## 0.1.35

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.1.34

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0

## 0.1.33

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0

## 0.1.32

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0

## 0.1.31

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0

## 0.1.30

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0

## 0.1.29

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0

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
