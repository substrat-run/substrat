# @substrat-run/control-plane

## 0.4.0

### Minor Changes

- e612b98: Reap archived scopes (§4.4): free the Durable Object storage that Cloudflare never
  garbage-collects. Deleting an app archives its scope — a tombstone-only transition that
  keeps the directory row but leaves the scope DO holding every byte forever. This adds a
  terminal `reaped` state past `archived`: `reapScope` wipes the DO's storage while keeping
  the directory row (audit history + burned slug), the one irreversible scope transition, so
  it only ever leaves `archived`, `getScope` fails closed on it, and its slug is released for
  reuse. Delivered two ways over one seam — the storage wipe reaches the vertical's own
  deployment (a hosted scope's DO is CP-less) via the same `deleteScope` dispatch the snapshot
  GC uses: a staff-only `POST /tenants/:t/scopes/:s/reap` (armed in the console behind a
  type-the-slug dialog, since there is no restore), and a `runPlatformSweep` phase that reaps
  scopes archived longer than `SCOPE_RETENTION_DAYS` — opt-in and unset by default, because
  the reap cannot be undone. Both adapters gain an additive `archived_at` column (stamped on
  archive, cleared on unarchive) to age the sweep, and their `(tenant_id, slug)` unique index
  becomes partial on the live statuses so a retained tombstone never blocks the slug reuse the
  pre-check already intends — closing a latent gap where archived slugs could not actually be
  reclaimed.
- f0df69a: Tenant delete with a grace window (§4.8, #36): reclaim a deleted tenant's data instead of
  stranding it forever. `deleting` was a dead status — written once (a dashboard team-delete)
  and never consumed, so a tenant marked for deletion kept every byte. This finishes the
  lifecycle as the tenant analogue of §4.4's scope reap.

  `tenantStatus` gains a terminal `reaped` past `deleting`, and the `tenants` row gains a
  `deletingAt` timestamp (stamped on entering `deleting`, cleared on un-delete) so the grace
  window can be aged. `deleting` stays a reversible pause — every scope already fails `getScope`
  closed under a non-active tenant, so nothing is destroyed until a reap, and an un-delete (→
  `active`) restores the tenant whole. `reapTenant` (new on `HostAdmin`, directory-side only)
  clears the tenant's PII/config directory rows — identities and identity pools, membership
  tuples, roles, entitlements, orgs — and flips the row to a `reaped` tombstone, keeping the
  `tenants` row (burned slug + history) and `_substrat_admin_log` whole. It refuses any tenant
  not in `deleting`; `reaped` is unreachable via `setTenantStatus`.

  Delivered over one seam, two ways: a staff-only `POST /tenants/:t/reap` ("reap now", armed in
  the console behind a type-the-slug dialog, refused with 409 unless the tenant is `deleting`),
  and a `runPlatformSweep` phase that reaps tenants whose `deletingAt` is older than
  `TENANT_RETENTION_DAYS` — opt-in and unset by default, because the reap is irreversible. The
  per-scope byte-wipe runs above the kernel: the reaper archives-if-needed then reaps each scope
  through the existing `reapScopeFn` seam (so the control plane's orchestrated per-scope wipe
  applies for free), then clears the directory via `reapTenant`.

  Also settles #36's retention question: the admin log is the compliance witness (bokföringslagen
  §5.3) and is deliberately **never swept** — no TTL. The bound against dumping an ever-growing
  table lives on the read surface instead: `GET /admin-log` now defaults a page size (the
  in-process `auditLog` stays unbounded, so an internal caller that wants everything still gets it,
  and `nextCursor` walks the whole log).

  Full-tenant export (GDPR Art. 20 portability) is intentionally out of scope here — the per-scope
  `exportScope` seam it builds on already exists.

### Patch Changes

- Updated dependencies [487db9a]
- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/control-plane-api@0.25.0
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0

## 0.3.8

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [92d1aa1]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [d4bf108]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [b06730e]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/control-plane-api@0.24.0

## 0.3.7

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/control-plane-api@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.3.6

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/control-plane-api@0.22.0

## 0.3.5

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/control-plane-api@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0

## 0.3.4

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/control-plane-api@0.20.0

## 0.3.3

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/control-plane-api@0.19.0

## 0.3.2

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/control-plane-api@0.18.0

## 0.3.1

### Patch Changes

- Updated dependencies [983c06d]
  - @substrat-run/control-plane-api@0.17.0
  - @substrat-run/contracts@0.17.0
  - @substrat-run/kernel@0.17.0
  - @substrat-run/adapter-cloudflare@0.17.0

## 0.3.0

### Minor Changes

- 0caa0a9: Account switching actually works: force past the IdP SSO cookie and the browser session.

  Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
  cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
  authorize round-trip silently re-authenticated the old user — no typed email could win.
  The CLI broker added a second layer: `substrat login` reused any live browser session
  without ever showing a login screen.

  **oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
  (`login` | `select_account`) so the IdP re-prompts past its SSO session, and
  `/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
  (RP-initiated logout, discovery-driven; local-only remains the default so other apps
  on the shared IdP session keep theirs).

  **control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
  session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
  returnTo so the post-login bounce uses the new session instead of looping.

  **cli**: `substrat login --fresh` requests exactly that flow, and
  `substrat workspaces` lists your workspaces (an alias of `whoami`).

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [0caa0a9]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/control-plane-api@0.16.0
  - @substrat-run/oidc-rp@0.4.0

## 0.2.0

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

- Updated dependencies [7ed3015]
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/control-plane-api@0.15.0
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/oidc-rp@0.3.0
  - @substrat-run/kernel@0.15.0

## 0.1.2

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.
- Updated dependencies [f4ad677]
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/control-plane-api@0.14.0
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.1.1

### Patch Changes

- 6abbce9: **Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
  router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
  `ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
  the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.
- Updated dependencies [2add91f]
- Updated dependencies [b1af840]
- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
  - @substrat-run/oidc-rp@0.2.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/control-plane-api@0.13.0

## 0.1.0

### Minor Changes

- 1dff2bd: **Builder writes — self-serve deploy, end to end (builder-plane.md Phase 3).** A tenant user
  can now `substrat login`, `push`, and `promote` their own verticals without staff, and the
  control plane forms the `<tenantSlug>/<name>` id they never type. This makes the Phase-2
  authz mechanism live.

  - **Prefixed vertical ids (`verticalSlug`)** — a new contracts brand allows an optional single
    `<tenantSlug>/` prefix; the registry schemas use it. A builder pushes a **bare** `--slug`;
    the control plane prepends their authenticated tenant's slug, so two tenants can each own a
    `helpdesk` with **no global claim race** (Vercel-style non-scarce namespace). Platform
    verticals stay bare. `deploymentRefFor` already flattens the `/`; hostnames never carry it.
  - **The live builder reader** (`oidcBuilderReader`, control-plane worker) — the same signed
    session the CLI/console carries resolves via the shared identity directory to the tenants a
    user belongs to, narrowed to the selected one → a `(actor, tenantId, tenantSlug)` builder
    principal. **No vetting roster**: self-serve is the point; a user with no workspace is
    declined (sign up in the dashboard first). The audited actor is a stable
    `PlatformActorId` derived from the OIDC subject.
  - **`effectiveSlug`** threads the prefix through every builder vertical route
    (`control-plane-api`), so ownership, filtering and dispatch all key on the real id.
  - **`GET /api/auth/whoami`** — the session's user + the tenants it can build for. The CLI
    calls it on `login` to store a default workspace (prompting when there are several).
  - **CLI** — `substrat whoami`; `substrat promote <slug> --channel dev|staging --version <id>`
    (a builder self-serves non-prod; prod + admission stay staff, model B); `--tenant` /
    `SUBSTRAT_TENANT` / a stored default, sent as `x-substrat-tenant` with a browser session.

  Scope: no auto-bootstrap of a workspace from the CLI (a builder signs up once in the
  dashboard, then the CLI just works) — flagged as a follow-up.

  Verified: control-plane-api (71) incl. the reworked builder matrix under prefixing (each
  tenant gets its own namespace, no collision), control-plane worker (17) incl. a live
  end-to-end builder path (bare push → `acme-co/helpdesk`, whoami, fail-closed no-workspace),
  adapter suites (147 + 153) and `pnpm -r typecheck` all pass.

- cc5f2ca: **`substrat login` — a real browser login for the CLI (loopback OAuth, no AuthHero change).**

  `substrat login` now pops the browser and authenticates you as yourself — the `wrangler login` / `gh auth login` experience — instead of pasting a shared token. The CLI never touches AuthHero: it logs in **through the control plane**, which already brokers AuthHero for the console, and gets back the same signed session it issues to a browser.

  - **The flow (PKCE, CLI ↔ control plane):** the CLI starts a localhost server, opens `…/api/auth/cli?port&state&challenge`; the broker signs the user in (bouncing through the existing `/api/auth/login` if there's no session yet, via a new same-origin `returnTo`) and redirects to `127.0.0.1:PORT/callback?code`; the CLI exchanges `code + verifier` for the session token. The token never transits a URL — only the PKCE-bound `code` does — and the exchange fails without the matching verifier.
  - **`@substrat-run/oidc-rp`**: exports `mintSession` (refactored out of `completeLogin`), `signEphemeral`/`verifyEphemeral`, `pkceS256`, and `safePath`; `mountOidcRoutes` honours a validated same-origin `returnTo`.
  - **`apps/control-plane`**: `oidcStaffBearerReader` accepts the session as `Authorization: Bearer` (the same `verifySession`, the **same staff roster** gate as the cookie); `cli-auth.ts` mounts the broker routes. Pushes are attributed to the **human**, not a shared actor. **No AuthHero client or redirect URI is added** — AuthHero still only ever redirects to the console.
  - **`@substrat-run/cli`**: the loopback `login` flow (default); `login --token` / `SUBSTRAT_SERVICE_TOKEN` still stores a service credential for CI. `push` sends whichever the config resolves — a bearer session (per-human) or `x-service-token` (service actor).

  Verified: oidc-rp, control-plane, dashboard and cli typecheck; a new workerd test drives the whole broker end-to-end — the PKCE round-trip issues a bearer the deploy surface accepts, a wrong verifier is refused (400), and a valid session for a non-rostered user is refused (401, fail closed).

- b4420fb: **Console/control-plane staff sign-in moves from per-app Better Auth to OIDC (AuthHero).**

  Second app in the platform's auth consolidation (the Dashboard was the pilot). The
  OIDC relying party is now a shared package — `@substrat-run/oidc-rp` — so the
  security-critical verifier (Authorization-Code + PKCE, ID-token/JWKS verification,
  signed session cookie; jose + Web Crypto, no `node:*`) is written once and mounted
  identically by both apps via `mountOidcRoutes`.

  - **control-plane worker**: `/api/auth/login → /callback → /logout` (+ `/session`
    for the console) replace the Better Auth handler. Staff authentication is now an
    OIDC session reduced to the provider-agnostic `StaffSessionReader` — exactly the
    seam the old code predicted. The **staff roster stays** the authorization gate
    (`staff_actor` in D1); OIDC only proves the email, so an AuthHero user who isn't
    rostered still gets nothing (fails closed). Dropped `nodejs_compat` and the
    Better Auth D1 _schema_ (the roster D1 remains). All OIDC config is secrets —
    nothing environment-specific is checked in.
  - **console SPA**: sign-in is a redirect into the OIDC flow (no password field);
    `getSession` polls `/api/auth/session`; sign-out redirects to `/api/auth/logout`.
  - The `#47` public-signup-gated-by-roster test is removed — under OIDC the control
    plane has no signup surface at all, so the hole cannot exist; a guard test asserts
    no sign-up endpoint is exposed.

  The dev harness (`control-plane-api/dev/server.mts`) keeps Better Auth for the
  optional real-auth-in-dev toggle; the primary local path is the dev actor, which is
  unaffected.

- 0de890b: **The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

  A pushed vertical needs the platform's shared secrets to _verify_ inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

  - **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, _after_ the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
  - **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

  Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.

### Patch Changes

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/design/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- Updated dependencies [05291fa]
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [cc5f2ca]
- Updated dependencies [7070588]
- Updated dependencies [66e752b]
- Updated dependencies [cedaf1a]
- Updated dependencies [097a3aa]
- Updated dependencies [0de890b]
- Updated dependencies [d5a7d5e]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/control-plane-api@0.12.0
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/oidc-rp@0.1.0
  - @substrat-run/kernel@0.12.0

## 0.0.7

### Patch Changes

- Updated dependencies [a277bb7]
- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/adapter-cloudflare@0.11.0
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/control-plane-api@0.11.0

## 0.0.6

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-cloudflare@0.10.0
  - @substrat-run/control-plane-api@0.10.0

## 0.0.5

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-cloudflare@0.9.0
  - @substrat-run/control-plane-api@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- Updated dependencies [c9fe555]
  - @substrat-run/control-plane-api@0.8.0
  - @substrat-run/contracts@0.8.0
  - @substrat-run/kernel@0.8.0
  - @substrat-run/adapter-cloudflare@0.8.0

## 0.0.3

### Patch Changes

- Updated dependencies [017bb83]
- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
- Updated dependencies [ad89a9d]
  - @substrat-run/control-plane-api@0.7.0
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-cloudflare@0.7.0

## 0.0.2

### Patch Changes

- Updated dependencies [ea3c5de]
  - @substrat-run/control-plane-api@0.6.0
  - @substrat-run/contracts@0.6.0
  - @substrat-run/kernel@0.6.0
  - @substrat-run/adapter-cloudflare@0.6.0

## 0.0.1

### Patch Changes

- Updated dependencies [54c6583]
  - @substrat-run/control-plane-api@0.5.0
  - @substrat-run/contracts@0.5.0
  - @substrat-run/kernel@0.5.0
  - @substrat-run/adapter-cloudflare@0.5.0
