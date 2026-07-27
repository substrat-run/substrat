# @substrat-run/dashboard

## 0.5.5

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/demo-callout@0.1.9
  - @substrat-run/demo-manyfold@0.1.7
  - @substrat-run/demo-meridian@0.2.6
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/engine-invites@0.0.18
  - @substrat-run/engine-invoicing@0.3.19
  - @substrat-run/engine-protocol@0.4.13
  - @substrat-run/engine-workorder@0.3.19

## 0.5.4

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/demo-callout@0.1.8
  - @substrat-run/demo-manyfold@0.1.6
  - @substrat-run/demo-meridian@0.2.5
  - @substrat-run/engine-invites@0.0.17
  - @substrat-run/engine-invoicing@0.3.18
  - @substrat-run/engine-protocol@0.4.12
  - @substrat-run/engine-workorder@0.3.18

## 0.5.3

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/demo-callout@0.1.7
  - @substrat-run/demo-manyfold@0.1.5
  - @substrat-run/demo-meridian@0.2.4
  - @substrat-run/kernel@0.19.0
  - @substrat-run/engine-invites@0.0.16
  - @substrat-run/engine-invoicing@0.3.17
  - @substrat-run/engine-protocol@0.4.11
  - @substrat-run/engine-workorder@0.3.17

## 0.5.2

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/demo-callout@0.1.6
  - @substrat-run/demo-manyfold@0.1.4
  - @substrat-run/demo-meridian@0.2.3
  - @substrat-run/engine-invites@0.0.15
  - @substrat-run/engine-invoicing@0.3.16
  - @substrat-run/engine-protocol@0.4.10
  - @substrat-run/engine-workorder@0.3.16

## 0.5.1

### Patch Changes

- @substrat-run/demo-callout@0.1.5
- @substrat-run/demo-meridian@0.2.2
- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0
- @substrat-run/demo-manyfold@0.1.3
- @substrat-run/engine-invites@0.0.14
- @substrat-run/engine-invoicing@0.3.15
- @substrat-run/engine-protocol@0.4.9
- @substrat-run/engine-workorder@0.3.15

## 0.5.0

### Minor Changes

- 0caa0a9: No more local sign-in screens: a signed-out visit hands straight off to the IdP.

  Both platform apps rendered their own branded sign-in card before redirecting to
  AuthHero — an extra screen that authenticated nothing. Now the SPA redirects to
  `/api/auth/login` as soon as the session check comes back empty, preserving the
  intended destination via `returnTo`. The local card survives only as the
  `?error=auth` retry screen (auto-redirecting after a failed round-trip would loop).

  Sign-out is now always federated (`/api/auth/logout?federated`): with signed-out
  visits auto-redirecting to the IdP, a logout that left the IdP's SSO cookie alive
  would silently sign the user right back in. This also fixes the invite-mismatch
  "sign out & continue as the invited email" path, which could previously re-login
  as the wrong account.

  Deploy note: each app's origin (`https://app.substrat.net/…`,
  `https://console.substrat.net/…`) must be registered as an allowed logout URL on
  its AuthHero client — the invite flow uses dynamic `/invite/<token>` return paths,
  so a path wildcard is needed.

### Patch Changes

- 0a7e1a7: The generated GitHub deploy workflow installs dependencies before pushing.

  One-click deploy setup committed a workflow that ran `substrat push` on a bare
  checkout — wrangler's custom build (the repo's own `tsc`) then failed on missing
  devDependencies, the first push never landed, and the vertical silently never
  appeared (registration happens on first successful push). The workflow now
  installs from the repo's lockfile (pnpm/yarn via corepack, `npm ci`, `npm install`
  fallback) and runs on Node 22 — corepack floats to latest pnpm for repos without a
  `packageManager` pin, and pnpm 11 needs Node ≥ 22.13. The generator moved to
  `github.ts` so the committed file, the manual copy-paste path, and the tests all
  share one source.

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [0caa0a9]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/oidc-rp@0.4.0
  - @substrat-run/demo-callout@0.1.4
  - @substrat-run/demo-manyfold@0.1.2
  - @substrat-run/demo-meridian@0.2.1
  - @substrat-run/engine-invites@0.0.13
  - @substrat-run/engine-invoicing@0.3.14
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/engine-workorder@0.3.14

## 0.4.0

### Minor Changes

- cd32011: Marketplace apps/verticals split + the empty-marketplace fix.

  **Adapters:** `registerVertical` now refreshes `listed` on an identical re-registration
  of a **builtin** vertical (it is seed metadata, derived from the catalog's `connected`
  flag). Rows registered before the `listed` column existed (migration default 0) were
  stuck unlisted forever, so the hosted marketplace rendered empty. A pushed (`cli`/`git`)
  vertical's `listed` stays untouched — re-pushing a published vertical still cannot
  silently unpublish it.

  **Dashboard:** the create-app page is now pure instantiation, grouped **Marketplace**
  (published) and **Your verticals** (your team's own, badged Private/Published, disabled
  until a version is promoted to prod). The Deployments page is renamed **Verticals**
  (`#/deployments` stays as an alias) and takes over the supply side: the GitHub
  import + one-click CI scaffold move there from create-app. `GET /api/catalog` returns
  `{owned, listed, source, installable}` and, in connected mode, merges the shared
  control plane's registry — so a pushed vertical shows up and (via the same fallback in
  `installSpecFor`) installs in production, not just embedded mode.

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

- d93e690: Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

### Patch Changes

- e83ba3c: The Apps overview no longer flashes the wrong screen while the first `listApps()` is in
  flight: the list shows a skeleton (same geometry as the loaded page — title row, toolbar,
  3-column card grid — so nothing jumps when data lands) instead of "Create your first
  app", and a deep link to an app shows the skeleton instead of a flashed "app could not
  be found". In the dev preview, `?loading=1` pins the skeleton (like `?onboarding=1`).
- 15853bf: Create-app URL preview now shows the tenant-suffixed hostname. The page promised
  `<app>.global.substrat.run` while provisioning actually binds
  `<app>-<team>.global.substrat.run` (the tenant-suffix scheme in `bindDefaultHostname`).
  The preview now mirrors the worker — same `slugify` on the current team's name,
  falling back to the unsuffixed form for teamless sessions.
- ea8fed4: Self-heal pre-roster teams: teams provisioned before #191 have an empty
  `dashboard_members` table (no owner row), so every roster-gated move — delete
  the organization, the Members tab, invites — refused its own owner with a 403.
  `resolveAccount` now seeds the resolving caller as the owner row (plus the
  invites entitlement and org) for pre-epoch tenants, gated by ULID timestamp and
  memoized per isolate so post-fix teams never pay a read.
- ec89a88: Vertical lifecycle: delete a vertical, and block new installs of one.

  **`deleteVertical`** (HostAdmin + `DELETE /verticals/:slug`, staff-only): removes the
  registry row, its versions, and its channels — **refused while any scope is still
  bound** to the vertical, naming the count, so a delete can never strand a live scope's
  version pin or routing. Deployed dispatch scripts are left as orphans for the cleanup
  script (#248), never reaped inline. Audited. The console's vertical detail card gets a
  type-the-slug-to-confirm Delete.

  **`installsBlocked`** (new registry flag + `setVerticalInstallsBlocked` /
  `POST /verticals/:slug/install-block`, staff-only): the install kill-switch, orthogonal
  to `listed`. A blocked vertical is hidden from the dashboard's install catalog and the
  control plane refuses to provision an instance of it (403) — for everyone, owner
  included. Existing scopes keep serving: it gates provisioning, not serving. Additive
  `installs_blocked` column in both adapters (attempt-and-tolerate migration, default 0).
  Console gets a Block/Allow installs toggle and a "blocked" badge.

  The console also now shows **timestamps**: when each version was pushed (table +
  promote picker), when each channel pointer last moved, and when a vertical was
  registered.

- Updated dependencies [cd32011]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/oidc-rp@0.3.0
  - @substrat-run/demo-meridian@0.2.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/demo-callout@0.1.3
  - @substrat-run/demo-manyfold@0.1.1
  - @substrat-run/engine-protocol@0.4.7
  - @substrat-run/engine-invites@0.0.12
  - @substrat-run/engine-invoicing@0.3.13
  - @substrat-run/engine-workorder@0.3.13

## 0.3.1

### Patch Changes

- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1
  - @substrat-run/adapter-cloudflare@0.14.1
  - @substrat-run/engine-invites@0.0.11
  - @substrat-run/engine-invoicing@0.3.12
  - @substrat-run/engine-protocol@0.4.6
  - @substrat-run/engine-workorder@0.3.12

## 0.3.0

### Minor Changes

- 1022c15: **Registry-driven marketplace, phase 2** (marketplace-publish.md §3) — the dashboard's hardcoded
  `CATALOG` map is no longer a gate, so a pushed → promoted → published vertical shows and installs
  with **no dashboard change**.

  - Registry `vertical` gains a `listed` flag (published to the public marketplace) — its own
    column adapter-side (sqlite + cloudflare), set on insert and **never clobbered by a re-push**
    (publish is a distinct action from push).
  - `availableCatalog` is registry-driven: a vertical shows if it's `listed` **or** owned by the
    caller's tenant (private to your team). Takes the caller's `tenantId`.
  - `createApp`/retry read `entitlements`/`ownerGrants` from the registry row (via `installSpecFor`),
    falling back to `CATALOG` for a first-party not yet re-seeded.
  - `ensureCatalog` seeds first-party verticals with their specifics and `listed: connected !== false`,
    so the `CATALOG` map is now just a first-party **seed**, not a visibility/install gate.

  Removes the recurring "add a catalog entry + redeploy the dashboard" step. Phase 3 (the
  staff-reviewed publish action) flips `listed` for builder verticals.

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.
- a1c7649: **Real running version on the app Overview.** The Overview tab hardcoded `v0.0.1` (and "Last
  deploy just now"); it now reads the app's actual running version — the version its scope is
  bound to (what the router serves) — from the same source as the Deployments tab. Shows an
  "update available" hint (linking to Deployments) when prod has moved past what the app runs.
- 21ebd1e: **Manyfold — a multi-scope headless CMS demo vertical.** A sandbox-clean, deployable vertical
  where **site = scope**: one install, many sites. The vertical owns the editorial lifecycle
  (draft→in_review→approved→published state machine that can't skip, append-only revisions,
  freeze-on-publish with a content hash, a delivery surface that resolves references — a
  draft/archived target comes back explicitly unresolved). **Content types are data**, authored
  in a model builder (`save-type`/`list-types`), each compiling to a reviewable migration
  (never a live ALTER); bodies persist as JSON so adding a field is free.

  Ships the full app: content editor + workflow, the model builder (models, field editor,
  relationship map, migration preview), and Members & roles — all URL-routed so a refresh
  restores the view. Auth is the tenant's own `IdentityDO` (Better Auth): first sign-in claims
  the owner seat (→ admin), then **member invites** (mint a principal, grant a role at scope
  level, share an accept link) open the post-setup join path. The deployable worker is
  sandbox-clean (own `ScopeDO` + `IdentityDO`, SPA inlined, no privileged bindings).

  Also fixes permission-denial status on the Cloudflare DO adapter: an op's error crosses the
  `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof PermissionDenied`
  was false and denials degraded to 400 — now matched by message too, so denials are 403 on
  the worker as in node.

  Registers Manyfold in the dashboard catalog (`connected`) and bundles its module in the
  dashboard worker.

- a1c7649: **A read-only "Data" tab: browse an app's own database from the dashboard.**

  Cashes in the seam kernel-design §5.4 reserved as the _admin-query RPC_ — a grant "is a
  tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
  read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
  them as a **Data** tab on the app detail view (list tables, page through rows).

  Read-only and table-shaped **by construction**: the caller picks a table from the live
  schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
  forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
  `system` so the UI groups it apart from the vertical's own tables. Every read is audited
  (K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

  **Reaches the data where it actually lives.** One dashboard app = one scope = one
  Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
  it reads directly. In connected/prod the scope's data DO lives in the _vertical's own WfP
  deployment_ (K-31), not the control plane's own (empty-module) scope host — so the
  control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
  (`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
  K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
  reading its own scope DB. The dashboard never emits an empty `200` — a null from the
  platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

  Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
  a shared contract-tests suite), new `contracts` introspection schemas, and
  `/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
  an arbitrary read-only SQL console are deliberately out of scope (fast-follows).

- Updated dependencies [6a7768a]
- Updated dependencies [21ebd1e]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/demo-manyfold@0.1.0
  - @substrat-run/demo-meridian@0.1.1
  - @substrat-run/demo-callout@0.1.2
  - @substrat-run/engine-invites@0.0.10
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/engine-workorder@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.2.0

### Minor Changes

- f9561dd: **Real per-app audit trail on the app overview.** The Activity panel showed demo data; it now
  renders real lifecycle events — `created` / `active` / `failed` / `deleted` — recorded per app.
  Crucially, a failed provision now records its **reason** (e.g. "no deployment is bound for vertical
  'meridian'") to the trail instead of only flashing a toast, so you can see _why_ an install failed
  on the app's own page.

  - New `dashboard_app_events` table (migration `0004`) + a `dashboard/app-events` read op (gated by
    the existing `dashboard:read`). The lifecycle ops append events; `mark-app-failed` takes the
    reason, threaded through from `createApp`'s failure path.
  - Worker `GET /api/apps/:scopeId/events`; web `api.appEvents`; `AppDetail`'s Activity panel wired to
    it (with a `danger` timeline dot for failures, loading + empty states).

  Contains a **migration** (`dashboard` `0004-app-events`) for the checkpoint review.

- 7941c4c: **Real per-app Deployments tab.** The app overview's Deployments tab showed demo data; it now reads
  the app's vertical version registry live — every pushed version, its admission state, which channels
  point at it, and (prominently) **which version the app runs** (the `prod` channel). So "am I on
  0.0.9?" is answerable: if you pushed 0.0.10 but only 0.0.9 is promoted to prod, the tab shows prod =
  0.0.9 and 0.0.10 sitting admitted-but-unpromoted.

  - `verticalDeploymentFromCp` / `verticalDeploymentFromHost` (by slug, so it works for a PLATFORM
    vertical the tenant doesn't "own" — unlike the tenant-level Deployments list).
  - Worker `GET /api/apps/:scopeId/deployments`; web `api.appDeployments`; `AppDetail`'s Deployments
    tab wired to it (running-version banner + a real version/admission/channels table).
  - Read-only: promotion for a platform vertical stays a staff action; this just surfaces the truth.

  No new permission (reuses `dashboard:read`) and no migration.

- e8325e6: **Update an installed app to a newer version — and show the version it _actually_ runs.**

  Promoting a vertical's `prod` channel moves the channel pointer; it does **not** rebind
  scopes already installed — the router dispatches on each scope's _pinned_ version, set at
  install time. So an app installed when prod was 0.0.9 keeps serving 0.0.9 after prod moves
  to 0.0.12, with no way to move it. This closes that gap:

  - **Truthful "Running"** — the Deployments tab now reads the scope's actual bound version
    (`Scope.verticalVersionId`) and marks it, instead of assuming the prod channel is what
    runs. "Am I on 0.0.9?" is now answered by what the router serves, not what prod points at.
  - **"Update to latest"** — a per-app action (`POST /api/apps/:scopeId/update` → `updateApp`)
    that rebinds the scope to the vertical's current prod version and records an `updated`
    event on the Activity trail. Idempotent (a no-op when already current); authorized
    in-scope on the caller's `dashboard:provision-app` grant.

  Adds migration `0005-app-updated-event` (widens the app-events `kind` CHECK to include
  `updated`; table rebuild, 0004 untouched). No new permission key (reuses `provision-app`).

- 2add91f: Fix the invite → sign-in → accept flow so an invited person lands in the team, not on "create a team".

  - **Carry the invite through auth.** An unauthenticated invite click now round-trips through OIDC using the RP's existing `returnTo` (the callback returns to `/invite/<token>`), instead of stashing the token in `localStorage`. The accept always runs with a session in hand, so a first-time invitee joins the team rather than falling through to onboarding.
  - **Prefill + sign-up hint.** `@substrat-run/oidc-rp` `beginLogin` / `/api/auth/login` now forward `login_hint` (prefill the invited email) and an allowlisted `screen_hint` (default `signup` for invite links). Both are IdP-standard and backward-compatible for the console.
  - **Preview endpoint.** New unauthenticated `GET /api/invites/preview?token=` (backed by a no-permission `dashboard/preview-invite` op — the signed token is the authority, like accept) returns the team name + invited email for the prefill and the accept screen. It reveals only that invite's own address; access still requires the verified-email hash at accept.
  - **Graceful mismatch.** Following an invite while signed in as a different verified email now shows a clear "this invite is for X" screen with sign-out, instead of the confusing onboarding dead-end.

- b346b6c: Send team-invitation emails from the Dashboard via a new notification-transport adapter.

  - **`@substrat-run/adapter-email`** — a new host-plane adapter (D-18: a notification transport is infra the host consumes, not a tenant connector). One `EmailTransport` port with swappable implementations: `CloudflareEmailTransport` (the `send_email` Workers binding — default) and `MockEmailTransport` (dev/CI). The port owns the deliverability invariants (both html + text, a subject, a valid recipient) so no implementation can drop them.
  - **Dashboard** — `POST /api/members/invite` now emails the invitee their accept link. The send happens in the request path, where the raw address is in hand: the invites engine hashes the identifier and `invites.sent` carries only the hash, so no outbox executor could recover an address to send to. Delivery is best-effort — a committed invite is never rolled back on a send failure (`emailDelivered: false` is reported and the `acceptUrl` is still returned for a manual resend). Adds the `send_email` binding + `EMAIL_FROM` config.

- 421348f: Add a **Resend** action for pending team invites.

  - **Module** — new `dashboard/resend-invite` in-scope operation. It re-mails an outstanding invitation using the address kept in the readable roster (the invites engine stores only a hash), re-checks `manage-members` **and** the §5.1 role bound, and re-composes the engine's `sendInvite` — idempotent for a still-open invitation (same id) and a fresh one if it lapsed — re-pointing the projection at the live invitation. Returns `null` when there is no such pending invite.
  - **Worker** — new `POST /api/members/resend-invite`. The initial invite and the resend now share one `mailInvite` helper that mints a fresh accept link and sends the message best-effort. That helper counts a recipient as delivered when Cloudflare Email Service returns it in either `delivered` **or** `queued` (the service is asynchronous, so a successful send is `queued`, not `delivered`).
  - **Dashboard UI** — a Resend button beside Revoke on invited rows, with success/failure toasts (a failed send points the admin to the shareable link).

### Patch Changes

- 90e94c3: **The marketplace only offers verticals the running mode can actually provision — so it stops advertising an install that always fails.**

  Adding Meridian to the catalog made it appear installable everywhere, but the hosted
  dashboard runs in **connected mode**, where the shared control plane provisions via a
  static `VERTICAL_<slug>` binding or a promoted dispatch-namespace version — and Meridian
  has neither yet, so every install 501s ("no deployment is bound for vertical 'meridian'").
  The user was offered something that couldn't be installed.

  - Catalog entries now carry a `connected` flag; `GET /api/catalog` hides `connected: false`
    entries when a shared control plane is bound, and lists everything in embedded/standalone
    (which bundles each module in-process). Meridian is flagged `connected: false` until it is
    deployed + promoted to prod.
  - The create-app marketplace tiles are filtered to slugs the live catalog actually offers, so
    a hidden vertical can't be picked — previously `resolveSlug` would have silently substituted
    a different vertical for a tile whose slug wasn't advertised.
  - The catalog map + availability rule move to a Cloudflare-free `catalog.ts` so the gating is
    unit-tested (embedded lists Meridian; connected hides it; unknown slugs never appear).

- b1af840: Verify an invite is for the signed-in email before accepting it. An existing member — typically the team owner — who opened an invite meant for someone else was silently switched into the team by the server's "already a member" shortcut, never learning the invite wasn't theirs. The accept flow now fetches the invite preview and compares the invited email to the signed-in email first; on a mismatch it shows the "this invite is for X" screen instead of accepting or switching. That screen's "sign out" carries a `returnTo` back to the invite link (`@substrat-run/oidc-rp` `/api/auth/logout` gains same-origin `returnTo`), so after signing out the user re-enters the invite unauthenticated and gets the sign-up screen prefilled with the invited email.
- 2ccfc74: **Offer Meridian in the hosted marketplace.** Meridian is deployed to the `substrat-verticals`
  dispatch namespace and promoted to prod, so its catalog `connected` flag flips to `true` — the
  `/apps/new` marketplace now lists it and installs provision a real instance. (It was `connected:
false` while it wasn't yet deployable, which is why the tile was hidden even though the CLI showed
  the version admitted.) Requires redeploying the dashboard.
- 90e94c3: **Wire the "Retry" action on a failed app — it re-provisions for real instead of a placeholder toast.**

  The Retry link on a `failed` app card was a stub (`setToast({ title: 'Retry not wired yet' })`).
  It now calls a new `POST /api/apps/:scopeId/retry`, which best-effort tears down the failed
  attempt and re-provisions fresh under a new scope with the same vertical + name, via the proven
  `createApp` path. A retry that still can't come up re-marks the row `failed` and surfaces the
  **real** provisioning error, so the button re-tries for real and stops hiding why an install
  failed. The re-provision logic is a testable `retryApp` in `provision.ts` (composing
  `deprovisionApp` + `createApp`); a regression test drives failed-install → retry → a fresh live
  scope. Only a `failed` app is retryable, and only the caller's own (list-apps is tenant-scoped).

  Note: this fixes the _recovery_ path, not the reason a Meridian install fails in connected mode —
  the shared control plane provisions via the `substrat-verticals` Workers-for-Platforms dispatch
  namespace, and Meridian has not been deployed there / promoted to a prod version yet. Until it is,
  Retry will surface that provisioning error rather than succeed.

- 9087052: Move the Dashboard toast from top-right to bottom-right so it no longer overlays the "new app" button.
- e78c86e: **Fix "scope slug 'x' already taken" when installing an app in connected mode.** The shared-plane
  provisioning used `slugify(name)` as the scope slug, which must be unique within a tenant — so a
  second app with the same name, or a fresh attempt after a failed one left an orphaned scope (a
  failed provision marks the row failed but doesn't release its shared-plane scope), collided. The
  scope slug now includes the scope-id tail (`meridian-abc123`); the bound hostname still prefers the
  clean name (`meridian.global.substrat.run`), falling back to the unique slug only on a global collision.
- b1af840: **Meridian is installable from the dashboard marketplace, and usable from an empty install.**

  Meridian (the HR vertical) can now be provisioned as an app from the tenant dashboard,
  the same embedded-catalog seam Callout uses, and a freshly-installed (empty) instance
  is set up from zero through a new in-app Admin surface.

  - **Marketplace wiring.** `@substrat-run/demo-meridian` gains a worker-safe `./module`
    export (its domain module + perms only, never the node/better-auth seed), mirroring
    Callout. The dashboard worker bundles `meridianModule` into its `ScopeDO` and adds a
    `meridian` catalog entry — SKU `['meridian', 'protocol']`, owner granted the `hr-admin`
    permission set so the installer can run the app from day one. Meridian is added to the
    frontend marketplace list, vertical metadata, and dev-mock catalog. A new dashboard
    scenario test provisions a real Meridian app and drives `hr/define-leave-type` +
    `hr/create-employee` on the empty scope — the first-run path, proven end to end.

  - **First-run onboarding (the Admin section).** An installed instance starts empty (no
    leave types, people or projects). The app gains an hr-admin-only **Admin** section — a
    first-run setup checklist plus screens to define leave types (with SE/ES statutory
    presets, spec §6), add employees, create projects, and generate the per-period
    **payroll export** (the §7 boundary). Every screen carries proper empty/loading/error
    states and accessible form labels; permission is still checked in the kernel on every
    op, so a non-admin reaching these calls is refused (verified: a manager defining a
    leave type gets `403 permission denied: absence:configure`).

  GDPR employee erasure (spec §8) remains a deliberate follow-up: crypto-shredding is keyed
  off event `piiClass`/`subjectId` at the kernel/lake level, and there is no vertical-callable
  erase primitive yet — a table-only version would look structural without being so, so it is
  left unbuilt rather than faked.

- Updated dependencies [6721e1b]
- Updated dependencies [32abe73]
- Updated dependencies [2add91f]
- Updated dependencies [b1af840]
- Updated dependencies [b346b6c]
- Updated dependencies [12acc59]
- Updated dependencies [57b1cfe]
- Updated dependencies [b1af840]
- Updated dependencies [fa0707c]
- Updated dependencies [e774c01]
- Updated dependencies [cfbcc6c]
- Updated dependencies [74c9d7b]
- Updated dependencies [6a0e253]
  - @substrat-run/adapter-email@0.1.0
  - @substrat-run/demo-meridian@0.1.0
  - @substrat-run/demo-callout@0.1.1
  - @substrat-run/oidc-rp@0.2.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invites@0.0.9
  - @substrat-run/engine-invoicing@0.3.10
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/engine-workorder@0.3.10

## 0.1.0

### Minor Changes

- 949cbb3: **Deployments view — the builder-facing mirror of the console (builder-plane.md Phase 4).**
  A customer now sees the verticals they pushed, right in their dashboard: each version's
  admission state and which channel points where, and can self-serve `dev`/`staging`
  promotion. Production stays a staff decision (model B) — shown, not actionable.

  - **`GET /api/deployments`** — the tenant's own verticals (`ownerTenant === tenant`), each
    with its versions + channels. Connected mode reads the shared control plane
    (tenant-filtered); embedded reads the local host. The tenant is the caller's own, from
    their session — never a request argument.
  - **`POST /api/deployments/:slug/promote`** — points a NON-prod channel at a version.
    `prod` is refused (403 — "promoted by the Substrat team"), and the slug is verified to be
    one of the caller's **own** deployments first (a slug you don't own reads as 404), so the
    dashboard's staff-level service token can't be used to touch another tenant's vertical.
  - **The view** (`Deployments.tsx`, a new sidebar entry) — per vertical, a version table with
    admission pills, the channels each version holds, and `→ dev` / `→ staging` buttons
    (enabled only for an admitted version). The `<tenantSlug>/` prefix is stripped for
    display; a builder sees the bare name they pushed.

  The CP client (`TenantNarrowedControlPlane`) gains `listVerticals` (tenant-filtered),
  `listVersions`, and `promote`; the assembly + ownership check live in a testable
  `deployments.ts`.

  Verified: dashboard suite (14) incl. new assertions — a tenant sees only its own verticals
  (not platform, not another tenant's), shaped with channels and newest-first versions, and a
  slug it doesn't own is not promotable; `pnpm -r typecheck` and the web build both pass.

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/design/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- 6678b4d: **Delete app — real deprovisioning, replacing the front-end stub.**

  "Delete app" navigated away and toasted success while doing nothing — no API call, no route, no deprovision. Now it deprovisions for real, tenant-narrowed, the mirror of create.

  - **`dashboard/delete-app` operation** (migration `0002` adds a nullable `deleted_at` — soft delete, so the account's record/audit history is retained; `list-apps` hides deleted rows). Same authority as creating an app (`dashboard:provision-app`) — no new permission key.
  - **`deprovisionApp`** (provision.ts): authorize + soft-delete in the caller's dashboard scope, then take the app scope **offline** — `suspendScope` (reversible, fails `getScope` closed) + the hostname → `failed` so the router stops resolving it. Connected mode goes through the tenant-narrowed control-plane seam (new `suspendScope`); embedded through the local host.
  - **`DELETE /api/apps/:id`** resolves the app from the caller's _own_ apps only, then deprovisions. Client `api.deleteApp(id)`; the UI awaits it and toasts success only on success (failure shows the error).

  **Migration checkpoint:** `dashboard_apps` gains `deleted_at` (append-only ALTER; no enum/table rebuild).

  Verified: dashboard suites pass (11), including a new scenario test — deleting an app drops it from the list and suspends its scope (`getScope` then fails closed).

- 7a64c3b: **The Dashboard — M0 of the tenant-facing self-service surface (docs/design/dashboard.md).**

  "Vercel, but for Substrat," built AS a Substrat vertical. M0 is the core self-service loop, proven
  end to end:

  - **The vertical** (`module.ts`): `dashboard:provision-app` / `dashboard:read`, a `dashboard_apps`
    table, and the ops. It owns the account's own record + permissions; it does not provision.
  - **The authority seam** (`provision.ts`): `provisionDashboard` (sign-up bootstrap) and `createApp`
    — authorizes in-scope (`dashboard/provision-app` asserts the key), then effects `provisionScope`
    into the caller's OWN tenant, read from their dashboard node, never a request argument.
    Cross-tenant is impossible by construction (the #97 move). A finding baked in: `provisionScope`
    is a `ScopeHost` action, not `HostAdmin`, so the effect lives in app-level code holding a
    `ScopeHost` — no kernel change.
  - **The worker** (`worker.ts`): Better Auth on D1; **first login bootstraps the customer's own
    tenant + dashboard scope + owner** (self-service sign-up); `GET /api/me`, `GET /api/apps`, and
    `POST /api/apps` (create an app in your tenant, from the session). A stub catalog.

  Verified: the authority unit test (owner provisions a live app in their tenant; unauthorized
  refused; cross-tenant refused even by forging the node), and the full HTTP flow on real `workerd`
  (sign up → account bootstrapped → create a running app → list), including isolation — a second
  customer gets their own tenant and sees none of the first's apps. In the permission checkpoint.

  **M0.3 — a registry-backed catalog** (`GET /api/catalog` from `listVerticals`; `ensureCatalog` seeds `registerVertical` — the same registry the operator console will use) **and a clickable SPA** (a dependency-free page: sign in → pick a vertical → create → see your apps), verified on workerd.

  **Remaining (beyond M0):** members, custom domains, connections; and the production topology — each app a separate vertical deployment provisioned via the control plane (M0 runs them in one deployment).

- 4430841: **A failed create is loud, not a silent `provisioning`.** When provisioning didn't
  complete (the vertical refused, a hostname wouldn't bind, the shared plane was
  unreachable), the app row was left at `provisioning` forever — indistinguishable from
  "still coming up".

  - **`dashboard/mark-app-failed`** op — `createApp` marks the row `failed` when the effect
    throws (guarded to only move a `provisioning` row), then re-throws the original error.
  - **The dashboard surfaces it** — `createApp` in the UI now catches, reloads (so the
    `failed` row shows), and shows an error toast with the reason instead of an unhandled
    rejection.

  Verified: dashboard suites pass (12), including a new test that a create whose effect
  throws leaves the row `failed`, not `provisioning`.

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/design/dashboard-ui.md).**

  "Vercel, for Substrat" as a real React app, on the same design system as the operator console.

  - **Shared `@substrat-run/ui`** — the design-system primitives (Button, Input, Table, SideNav,
    Dialog, tokens, `styles.css`, icons) EXTRACTED from `apps/console` into a source-only workspace
    package (no build step; the Vite apps transpile it). The console now re-exports it through a thin
    `components` barrel + `@import "@substrat-run/ui/styles.css"` — its `../components` import paths
    are unchanged, so this is an internal refactor with no behaviour change.
  - **`@substrat-run/dashboard-web`** — a new Vite + React SPA (`apps/dashboard/web`), hash-routed,
    every screen from the handoff: sign-in, onboarding, Apps grid/list, Create App (Git import /
    marketplace / CLI), App Detail (Overview + Deployments / Env Vars / Domains / Integrations /
    Settings tabs), Team + roles matrix, Domains, Integrations, Billing, Analytics, Settings, plus
    the ⌘K palette, notifications, an account menu, dark mode, and the shell. **M0 is wired** to the
    real worker API (`/api/me`, `/api/catalog`, `/api/apps`); M1–M3 + future screens run on demo data
    behind the design's honesty banners. A `VITE_DEV_MOCK` preview mode (mirroring the console's
    `VITE_DEV_ACTOR` seam) renders the demo tenant without OIDC; `?theme=`/`?menu=` aid screenshots.
  - **`@substrat-run/dashboard` worker** now **serves the SPA** as Workers static assets
    (`run_worker_first: ["/api/*"]` + `single-page-application` fallback) instead of the old inline
    page (deleted); `/api/me` also surfaces the signed-in email/name for the shell.
  - **The catalog offers a real Callout**, not just Documents. The worker bundles the Callout
    vertical's modules via a new worker-safe `@substrat-run/demo-callout/module` subpath (just
    `calloutModule` + `SC_PERM`, never the seed/auth) plus `workorder` + `invoicing`. `createApp`
    grants the three-engine SKU + the office-admin owner grants and **binds a default hostname**
    `<slug>.<jurisdiction>.substrat.run` (K-30 → `callout.global.substrat.run`), best-effort, recorded
    on the app row. M0 stand-in: production deploys Callout separately (dashboard.md §6 — router + DNS
    - ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
      template, not imported.

  Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
  `callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
  builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
  catalog.

  **Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
  and provisioning each app as a separate deployment via the control plane — until then a bound
  hostname is recorded but does not yet resolve.

- 518ea07: **Deleting an app reclaims its slug + hostname.** A failed or deleted app used to strand
  its scope slug and hostname forever — no way to reuse the name.

  - **A deleted app is now ARCHIVED, not suspended** (`deprovisionApp`): archive is the
    terminal delete state — offline (`getScope` fails closed), record retained (audit), and
    it _releases_ the name (suspend is reversible, so it keeps it).
  - **`archiveScope` is allowed from `provisioning`** (both adapters), so a scope whose
    provisioning never completed (a failed create) can be abandoned instead of stranding
    its name.
  - **Slug + hostname uniqueness ignore `archived` scopes** — the scope-slug check excludes
    archived scopes, and `bindHostname` reclaims a hostname whose holder is archived. So
    delete → recreate with the same name works, at the same `<name>.<jur>.substrat.run`.

  Verified: adapter suites (146) + dashboard suites (11) pass, including a new assertion
  that after deleting an app, a new one takes the same slug _and_ the same clean hostname.

### Patch Changes

- b4420fb: **Fix the AuthHero OIDC login path end to end.**

  Three faults surfaced bringing the Dashboard's OIDC sign-in live on `app.substrat.net`:

  - **The callback swallowed every failure** (`@substrat-run/oidc-rp`): a bare `catch`
    redirected to `/?error=auth` with no trace, so a failing login was undiagnosable in
    prod. It now logs a structured `oidc.callback.failed` with the reason — and, on a
    non-2xx token exchange, the authority's own error body (the error path only, never
    the token response, so nothing secret leaks) — and `observability` is enabled on the
    dashboard worker so the log actually lands. Console/control-plane inherit the
    non-swallowing behaviour through the shared package.
  - **The slug rejected OIDC subjects** (`worker.ts`): `slugFor` fed the raw subject
    (`auth0|46906645…`) into a tenant slug that forbids `|`, so every first login 400'd at
    `createTenant` during JIT bootstrap. The subject is now stripped to its slug-safe tail
    (never hit under Better Auth, whose ids were plain alphanumeric).
  - **A dead identity-pool registration** (`provision.ts`): `provisionDashboard` still
    registered a `better-auth` pool — removed, now that the provider is `authhero`.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f5933ec]
- Updated dependencies [9a34950]
- Updated dependencies [cc5f2ca]
- Updated dependencies [847b506]
- Updated dependencies [f2428a9]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/demo-callout@0.1.0
  - @substrat-run/oidc-rp@0.1.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9
