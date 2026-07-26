# @substrat-run/demo-hr

## 0.2.2

### Patch Changes

- Updated dependencies [983c06d]
  - @substrat-run/control-plane-api@0.17.0
  - @substrat-run/contracts@0.17.0
  - @substrat-run/kernel@0.17.0
  - @substrat-run/adapter-sqlite@0.17.0
  - @substrat-run/adapter-cloudflare@0.17.0
  - @substrat-run/connector-scrive@0.1.7
  - @substrat-run/engine-protocol@0.4.9

## 0.2.1

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/control-plane-api@0.16.0
  - @substrat-run/connector-scrive@0.1.6
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/vertical-auth@0.2.1

## 0.2.0

### Minor Changes

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

- Updated dependencies [7ed3015]
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/control-plane-api@0.15.0
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/vertical-auth@0.2.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/connector-scrive@0.1.5
  - @substrat-run/engine-protocol@0.4.7

## 0.1.1

### Patch Changes

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

- Updated dependencies [f4ad677]
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/control-plane-api@0.14.0
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/connector-scrive@0.1.3
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/kernel@0.14.0

## 0.1.0

### Minor Changes

- 12acc59: **First-run setup state + invite-only sign-up (Phase 1).** A freshly-provisioned instance
  now has an explicit setup state instead of a bare login: the IdentityDO exposes
  `needsSetup(scopeId)` (the owner seat is still unclaimed), and Meridian uses it to

  - serve a **"Set up your workspace — create the admin account"** screen on first visit
    (`/api/me` returns `{ status: 'needs-setup' }` while unclaimed), instead of a plain
    sign-in that gives no hint the first sign-up becomes the admin; and
  - **close open sign-up once the admin has claimed it** — after first-run, a stranger who
    finds the URL can no longer self-register (`/api/auth/sign-up/email` returns 403). The
    window is exactly "owner unclaimed", so it closes the instant the admin is created.

  The claim itself is unchanged (trust-on-first-use — first completed setup wins). The
  member-invite path (how teammates join after setup) is the Phase 2 follow-up.

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

- fa0707c: **Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
  invite-only; this adds the flow that lets teammates in:

  - **IdentityDO** gains an `invite` directory (token _hash_ only) + `createInvite` /
    `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
    invitee's subject to a pre-minted member principal.
  - **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
    of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
    permissions resolve from the scope's own storage (covered by two new workerd tests).
  - **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
    granted at creation, one-time accept link returned, plaintext token never stored);
    `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
    valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
    revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

  Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
  employees (HR records) remain separate.

- e774c01: **Meridian is reshaped into a sandbox-clean, control-plane-less worker — the shape a vertical must have to be pushed into the platform's dispatch namespace and provisioned by the shared control plane.**

  Meridian was built as a standalone worker that talked _back_ to the control plane (a
  `ControlPlaneDO`, a `CONTROL_PLANE_SVC` service binding, connected-mode gating, an `ASSETS`
  binding, a Scrive reconcile cron). The production platform provisions verticals through a
  Workers-for-Platforms **dispatch namespace**, and `assertSandboxContract` refuses a
  `CONTROL_PLANE` binding or a service binding to a platform worker — so that shape could never be
  pushed. This converts Meridian to the same sandbox-clean pattern Callout uses:

  - **`worker.ts`** — CP-less: `hostFor` builds `CloudflareScopeHost({ scope })` (no control plane);
    `/internal/provision` sets up only the scope's own state via `provisionScopeLocal` (roles + the
    owner's `hr-admin` at scope level), since the shared plane already wrote the directory row +
    entitlements; permissions evaluate from the scope's own storage; the router asserts the node.
    Dropped: the `ControlPlaneDO`, the connected-mode `assertScopeActive` gating, and the Scrive
    connector + `scheduled()` cron.
  - **CP-less identity** — the vertical's own Better Auth `user.principal_id` column is the
    id→principal directory (new `IdentityDirectory` seam + `0002_principal_binding.sql`); `/internal/link`
    binds a login to the provisioned owner. The node server keeps the central directory.
  - **SPA bundled into the worker** — `scripts/gen-assets.mjs` inlines `app/dist` into
    `src/assets.generated.ts` (gitignored), served by `src/assets.ts`; the `ASSETS` binding is gone.
    gen-assets now writes only on change, so `wrangler dev`'s build hook doesn't loop on its output.
  - **`wrangler.jsonc`** — sandbox-clean: only the `SCOPE` DO + `AUTH_DB`, a `build` step, no service
    binding / cron / `CONTROL_PLANE`.

  Verified on real `workerd` (`wrangler dev`): `GET /` serves the SPA; `/internal/provision` is
  fail-closed (403 without `PLATFORM_SECRET`, 201 with it) and provisions CP-lessly; an authenticated
  `hr/*` invoke by the `hr-admin` owner succeeds on DO SQLite. `wrangler deploy --dry-run` shows only
  `SCOPE` + `AUTH_DB`. All 21 node tests still pass.

  Deploy steps are in `demos/meridian/DEPLOY.md` (create the D1, `substrat push`, admit, promote to
  prod, flip the dashboard catalog's `connected` flag). Known follow-ups for full hosted UX: the SPA's
  `/api/me`/`/api/cast` data contract (still demo-shaped), owner login-linking on first sign-in, and
  Scrive reconcile (no cron on a dispatch worker).

- 6a0e253: **Pluggable, config-selected auth for verticals — a new `@substrat-run/vertical-auth` package, and Meridian on it.**

  Auth is now a config choice behind a small contract, isolated per tenant, with no shared `AUTH_DB`.

  - **`@substrat-run/vertical-auth`** (new): the `AuthProvider` contract (`handle` + `resolve`); an
    OIDC provider (`oidcAuthProvider` — verifies a bearer JWT against the issuer's JWKS, covering
    Supabase, Auth0, AuthHero, Keycloak); and a per-tenant **`IdentityDO`** — Better Auth over
    `drizzle-orm/durable-sqlite` (its own SQLite, one DO per tenant) plus the provider-agnostic
    `sub → principal` directory (`setPendingOwner` / `resolvePrincipal`). Source-exported (`.`,
    `./provider`, `./oidc`).

  - **Meridian** consumes it. The worker picks the provider by config (`AUTH_PROVIDER=better-auth-do`
    default, or `oidc` + `OIDC_ISSUER`/`OIDC_AUDIENCE`); the app never learns which. `/internal/provision`
    seeds the owner seat, and the first login **claims** it (the installer becomes `hr-admin`) —
    provider-agnostically. The shared D1 `AUTH_DB` and its identity directory are gone; `wrangler
--dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) Durable Objects, so the worker still passes
    the sandbox contract and is pushable to the dispatch namespace.

  Verified on real workerd (Better Auth path): provision → sign-up → invoke claims the owner seat →
  `hr-admin` op succeeds → `/api/me` returns the claimed principal. OIDC verified with jose
  (mint+verify): valid → subject; no token / wrong issuer / expired → null. 21 Meridian node tests pass.

  Follow-ups (see `demos/meridian/DEPLOY.md`): fold the `hr/whoami` shape back into `/api/me` so the
  owner lands on the Admin surface; adopt the package in Callout; remove the now-dead `src/auth.ts` /
  `src/auth-schema.ts`.

### Patch Changes

- 32abe73: **`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

  - **dir** → `.` (the current directory).
  - **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
    `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
    / `Meridian`).
  - **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
    the number (falls back to the package.json version for a slug's first-ever push).

  So `cd demos/meridian && substrat push` replaces
  `substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
  works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.

- 57b1cfe: **The Meridian SPA works for a real single logged-in user, not just the demo cast.**

  The pushed worker returned `/api/me` as `{ principal, via, display }` and had no `/api/cast`, but
  the SPA centres on `{ key, display, role, country, employeeId }` + a persona switcher — so a
  hosted install served an app that couldn't place the user. This closes that data-contract gap
  without committing to any auth model:

  - A new **`hr/whoami`** operation resolves the caller's role hint (`hr-admin` / `manager` /
    `employee` / `none`, by probing their own grants) and linked employee from the scope itself. No
    permission gate — it reveals only the caller's own role + own employee id — and the kernel still
    enforces the real permission on every operation.
  - The worker's **`/api/me`** returns the SPA shape via `hr/whoami`, so a real owner (holding
    `hr-admin`) lands on the admin/setup surface and an employee on their own work — the same shape
    the dev server already serves. **`/api/cast`** returns `[]` (the persona switcher is a dev-only
    affordance).
  - The app **hides the persona switcher** when the cast is empty, so a hosted single-user instance
    shows no demo-character dropdown.

  Verified on real `workerd`: after provision, `/api/me` as the owner returns
  `{ role: "hr-admin", employeeId: null }` and lands the admin surface; an employee (created with a
  `principalRef`) resolves to `{ role: "employee", employeeId: … }`; `/api/cast` is `[]`. 21 node
  tests pass. Note: this does not change how identity is resolved (still Better Auth CP-less / the dev
  header) — the auth-model decision (per-vertical vs. shared OIDC) is deliberately left open.

- cfbcc6c: **Sign-in / sign-up screen for hosted Meridian.** A deployed instance returned 401 from `/api/me`
  with no way to authenticate (production has no persona switcher), so users just saw "unauthorized".
  The app now shows a **SignIn screen** (email + password, sign-in/sign-up) that posts to Better Auth
  (`/api/auth/*` → the tenant's IdentityDO) and reloads on success. The **first sign-in claims the
  owner seat** — the installer becomes `hr-admin` and lands on the Admin/setup surface with their real
  name. `useAppData` now surfaces `unauthorized` (401) distinctly from errors; dev (persona/dev-header)
  is unaffected. Verified on workerd: 401 → sign-up → `/api/me` returns the `hr-admin` shape.
- Updated dependencies [12acc59]
- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
- Updated dependencies [6a0e253]
  - @substrat-run/vertical-auth@0.1.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/connector-scrive@0.1.2
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/control-plane-api@0.13.0

## 0.0.9

### Patch Changes

- 8898133: **Meridian runs on Cloudflare — the full worker port, provisionable from the portal.**

  The first two stages of porting Meridian from its node/SQLite server to a deployable Cloudflare
  Worker, so it can be provisioned dynamically from the control-plane portal like Callout:

  - **Stage 0 — workerd-safe `provision.ts`.** `provisionMeridian`/`MODULES`/`ROLES`/`connectScrive`
    are extracted from the node-only `seed.ts` (which imports `node:fs`/`SqliteScopeHost`) into a
    `ScopeHost`-typed `provision.ts` the worker can import. `seed.ts` re-imports them; all existing
    tests still pass.
  - **Stage 1 — the worker.** `src/worker.ts`: `defineScopeDO(MODULES)`, `hostFor` (modules +
    `registerScriveConnector` + a `SecretBox` when Scrive is configured), `POST /internal/provision`
    (`assertPlatformCall` → `provisionMeridian`, the K-31 handshake), a generic `/api/invoke`
    (dev-header auth for now), and a **`scheduled()` Cron handler running `runPlatformSweep`** — the
    poll-path timer the node runtime got from `setInterval` (#96), with no Callout precedent. Plus
    `tsconfig.worker.json`, `wrangler.jsonc` (DO bindings, migrations, cron), and the
    `adapter-cloudflare` + `@cloudflare/workers-types` deps.

  Verified on real `workerd` (`wrangler dev`): fail-closed provisioning (403 without the platform
  secret), provision (201), `hr/define-leave-type` + `hr/create-employee` + `protocol/list-templates`
  (200) on DO SQLite, and the scheduled sweep (200).

  The port also surfaced a real DO-portability bug: `hr_absence_ledger`'s `0001-init` had an inline
  comment containing a semicolon, which the CF adapter's naive migration `split(';')` truncated
  ("incomplete input") — better-sqlite3 exec'd the whole blob on node and never showed it. The
  comment is de-semicoloned here; the adapter splitter fragility (and the adapter divergence behind
  it) is filed for a separate fix + contract test.

  **Stage 2 — Better Auth on D1.** End-user identity/credentials/sessions in a Cloudflare D1
  (`AUTH_DB`) via `drizzle-orm/d1` (`auth.ts` — the workerd twin of the node `auth-node.ts`), with
  `auth-schema.ts` + `migrations/0001_better_auth.sql`. The worker mounts `/api/auth/*` and resolves
  each request through Meridian's existing runtime-agnostic `betterAuthAdapter` (session →
  `resolveIdentity` → `PrincipalId`), falling back to the gated dev-header. An authenticated user
  with no linked identity resolves to nobody; `POST /internal/link` (platform-gated) binds a login
  to a principal — how a provisioned instance's owner becomes usable. Verified end to end on real
  `workerd`: provision → sign-up → unlinked session 401 → link → the session resolves to the owner
  `via: better-auth` → an authenticated `hr/*` invoke succeeds on DO SQLite.

  **Stage 3 — connected mode (portal + router wiring).** The worker now reaches the SHARED control
  plane over HTTP (`ControlPlaneClient` via `CONTROL_PLANE_URL` + a `CONTROL_PLANE_SVC` service
  binding), and gates every request on `assertScopeActive(tenant, scope)` — so a suspend in the
  portal's console fails Meridian's next request closed across the deployment boundary. Guarded by
  `STANDALONE`, so `wrangler dev` and a single-tenant box stay self-contained (no gating on a plane
  that isn't running — verified: provision + invoke still 200 in standalone). The `/internal/provision`
  handshake (Stage 1) is what the portal's create-instance flow calls. Adds the
  `@substrat-run/control-plane-api` dep.

  The router/control-plane `VERTICAL_MERIDIAN` service bindings are deliberately **not** added here:
  per those configs' own comments, a vertical is bound only once its worker exists, "rather than
  dangling a binding to a service that does not exist." They are deploy steps, in order:

  1. Create the D1 + apply auth migration, `wrangler secret put` PLATFORM_SECRET / ROUTER_SECRET /
     SERVICE_TOKEN (matching the control plane's + router's), then `pnpm cf:deploy` this worker.
  2. Add `VERTICAL_MERIDIAN → substrat-meridian` to `apps/control-plane/wrangler.jsonc` (+ its
     matching `PLATFORM_SECRET`) and `apps/router/wrangler.jsonc` (+ `ROUTER_SECRET`), and redeploy
     both. The console's create-instance flow then provisions Meridian instances, and the router
     fronts them by bound hostname.

  **Stage 4 — the SPA.** The employee app (`app/dist`) is served from the same origin via an
  `assets` binding with `run_worker_first` + single-page-application fallback; the worker owns
  `/api/*` and `/internal/*`, everything else falls through to the SPA. `cf:dev`/`cf:deploy` build
  the app first. Verified on `workerd`: `GET /` serves the app, a client route falls back to
  `index.html` (200), and `/internal/provision` + `/api/invoke` stay worker-owned.

  The port is complete on the code side (Stages 0-4, each verified on real `workerd`): provisioning
  handshake, the Scrive connector + a `scheduled()` Cron sweep, Better Auth on D1, connected-mode
  lifecycle gating, and the SPA. What remains is purely deployment — create the D1, set the secrets,
  `cf:deploy`, and add the `VERTICAL_MERIDIAN` router/control-plane bindings (deploy order above).

- Updated dependencies [05291fa]
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
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
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/connector-scrive@0.1.1

## 0.0.8

### Patch Changes

- Updated dependencies [462e8c9]
  - @substrat-run/connector-scrive@0.1.0

## 0.0.7

### Patch Changes

- 0ffb6c8: **Meridian wires the Scrive connector — the reference call site for the poll path (#96 Gate 1).**

  The scheduler driver (`runPlatformSweep` / `startPlatformSweeper`) and the connector's reconcile
  sweep landed with no deployment calling them. Meridian — the vertical whose anställningsavtal is a
  Scrive-signed document — now is that call site:

  - Depends on `@substrat-run/connector-scrive` via `workspace:^` (no npm publish needed to consume
    it in-repo — the whole point: the bundler compiles it in).
  - `buildDemoHost(dir, scrive?)` registers the connector and seals connection credentials with a
    `SecretBox`, opt-in; the default host (every existing test) is unchanged.
  - `connectScrive(host, …)` opens a `(tenant, meridian, scrive)` connection holding ONLY
    `protocol:record-signature` — the #97 grant that lets the reconcile write a signature back as the
    connection itself, not a human role. Scopes now name `vertical: 'meridian'` so a connection can
    reach them.
  - `server.ts` resolves Scrive from the environment (real testbed creds → global fetch; or
    `MERIDIAN_SCRIVE_MOCK=1` → `ScriveMock` with a dev-only sign endpoint), then calls
    `startPlatformSweeper` — the one-line trigger a deployment adds. Off by default: no creds, no
    connection, the contract sits pending, which is honest without a provider.

  Proven end to end: a new test drives issue → dispatch → provider signs → `runPlatformSweep` →
  instance `signed`, and the running server does the same over HTTP (`pending_signature` →
  `/api/dev/scrive-sign` → sweeper → `signed`). All 14 existing scenario tests and 3 provision tests
  still pass — the wiring is additive and opt-in.

  This closes Gate 1: with a Scrive account that has BankID/test-signing enabled, the connector now
  completes a signature unattended.

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/connector-scrive@0.0.2
  - @substrat-run/engine-protocol@0.4.2

## 0.0.6

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-protocol@0.4.1

## 0.0.5

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-protocol@0.3.6

## 0.0.3

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-protocol@0.3.5

## 0.0.2

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-protocol@0.3.3
