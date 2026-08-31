# @substrat-run/vertical-auth

## 0.10.1

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.10.0

### Minor Changes

- 225bb69: New `instanceAuthFor` — the composition four verticals were each writing for themselves:
  read an instance's delivered config in one DO hop, parse the `substrat:auth` choice,
  resolve the declared settings (delivered > binding > manifest default), and select the
  `AuthProvider`. Exported alongside `parseAuthChoice`, `selectAuthProvider`,
  `AUTH_CONFIG_KEY` and `AuthConfigError` (which carries the status an unconfigured instance
  should answer with). Purely additive — the primitives it composes are unchanged.

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [733469b]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0
  - @substrat-run/psl@0.2.4

## 0.9.0

### Minor Changes

- 75bd27c: The owner seat is claimed by whoever signs in first — for fifteen minutes, and then by a claim link (#925)

  A hosted vertical's owner seat is minted empty at provision and bound to a human by the first
  verified subject to arrive. That is the right trade in the install flow, where the installer
  opens the app seconds later. It was the wrong trade everywhere else: the window was unbounded
  in time and in audience, so a CI-deployed instance whose issuer had open sign-up sat as a seat
  anyone could take, indefinitely — and nothing anywhere said it was open. A re-provision made
  it worse: `INSERT OR REPLACE` re-minted the pending seat on every reconcile, so a sweep could
  hand a claimed desk's ownership to the next stranger to sign in.

  **`@substrat-run/vertical-auth`** — the rules now live in `owner-seat.ts`, unit-tested over a
  real SQLite. The first-sign-in claim closes `FIRST_SIGN_IN_WINDOW_MS` (15 min) after provision;
  a seat from before the column existed reads as closed. The seat then stays pending — `needsSetup`
  keeps saying so, and the new `ownerSeat` says _why_ — until a claim binds it. `mintOwnerClaim` /
  `claimOwner` are the claim link (only the token's hash is stored; minting again retires the
  earlier link), and `mintOwnerClaimLink` does token + hash + URL in one call. A re-provision
  keeps the window it has and never re-opens a claimed seat.

  **`@substrat-run/vertical-host`** — two flavored routes, `GET /internal/owner-seat` and
  `POST /internal/owner-claim`, over the `ownerSeat` / `mintOwnerClaim` hooks (501 without them),
  parsed on the way out as well as in. **`@substrat-run/contracts`** — the `ownerSeat` and
  `ownerClaimLink` shapes. **`@substrat-run/control-plane-api`** — `GET …/owner-seat` and
  `POST …/owner-claim` per scope, with the link's origin taken from the platform's own hostname
  directory (canonical `app` first), never from a body.

  **Dashboard** — an _Owner seat_ card on the app's Overview: claimed, unclaimed with the window
  still open (pulsing — open it now), or unclaimed and closed, with a _Get claim link_ button.
  The link is shown once and stored nowhere.

  **The four verticals on vertical-auth** (callout, meridian, manyfold, ticket0) — `/api/me`'s
  `needs-setup` answer now carries `firstSignInOpen`, the SPAs say which way in applies instead
  of offering a sign-in that binds nobody, and `?claim=<token>` → `POST /api/claim-owner` is the
  counterpart of the invite flow.

  Not built: binding from the projected identity links (#406). The dashboard links identities
  under the platform's own pool, and a hosted app's issuer is always an external one or a team
  Auth Server — so no link would ever match, and matching on `sub` alone would be the cross-pool
  bind the issue warns against.

## 0.8.1

### Patch Changes

- 7cce6cd: auth-server: migrate to `@better-auth/oauth-provider`, and bump the fleet to Better Auth 1.7

  Better Auth 1.7 **removes** the in-core `oidcProvider` plugin (deprecated since 1.6). Our range
  was already `^1.6.23`, which permits 1.7 — so this was not a migration we could schedule, only
  one we could be surprised by: any dependency refresh would have taken the plugin away and left
  `demos/auth-server` unable to compile.

  The fleet bump is free. Only `admin`, `jwt` and `oidcProvider` are used anywhere in the
  workspace, and only auth-server uses the last two; vertical-auth, control-plane-api, rally,
  handlebar and shop are on email/password + `admin`, and pass unchanged on 1.7.1 (147 tests).

  **The schema is now generated, because hand-keeping it stopped being plausible.** Three tables
  became seven, with forty-odd columns. `db/ddl.generated.ts` and `src/auth-schema.generated.ts`
  are emitted by `scripts/gen-schema.mts` from `getAuthTables(auth.options)` — read off the real
  `buildAuth` config, not a parallel one — and `test/schema-generated.test.ts` re-emits, compares,
  and then **executes the DDL against a real database** and drives the adapter through it. That
  last part is not ceremony: 1.7 adds a required `issuer` column to `account`, a table that
  already existed, and a diff of hand-written DDL would not have flagged it while every password
  sign-in on an upgraded install would have failed.

  **Upgrading an existing store is not `IF NOT EXISTS`.** `db/upgrade.ts` runs before the DDL on
  every boot and handles the two places that construct is silently wrong: `account.issuer` is
  added and backfilled with `local:<provider_id>` (user credentials — carried, never dropped),
  and `oauth_access_token` / `oauth_consent`, whose NAMES 1.7 reuses with different columns, are
  renamed to `legacy_*` so the new DDL creates the new shape instead of leaving the old one in
  place for the plugin to query columns off. Renamed rather than dropped: a clean break is about
  not carrying the old registry forward, not about an unattended `DROP` on a live issuer. Per the
  decision on this change, **relying parties must be re-registered** after an upgrade; what was
  there stays readable under `legacy_oauth_application`.

  **What changed on the wire** — each of these would strand a relying party silently, so each is
  pinned in `test/oidc-flow.test.ts`:

  - **PKCE is mandatory**, confidential clients included. No `code_challenge` ⇒ `invalid_request`
    at the callback. Every RP pointed at this issuer needs it.
  - **The pending authorize request is no longer server-side state.** It travels as the entire
    signed query on the redirect to `/login` / `/signup` / `/consent`, and the page hands it back
    as `oauth_query`. A sign-in that omits it succeeds and resumes _nothing_ — #898's symptom
    through a new mechanism, so the suite asserts the omission fails as well as the inclusion
    working.
  - **Consent** takes `{ accept, oauth_query }` and answers Better Auth's redirect envelope
    (`{ redirect, url }`), not `consent_code` / `redirectURI`. The signed query is also what
    makes tampering detectable, since the request now travels through the browser.
  - **`client_secret_basic` is the default** auth method; the plugin refuses a body-posted secret
    from such a client. Carried-over integrations must register
    `token_endpoint_auth_method: 'client_secret_post'` or move the secret to the header.
  - **Discovery moved to the root** — the plugin serves `/.well-known/openid-configuration`
    itself, so `routes.ts`'s alias onto `/api/auth/…` is deleted rather than kept.
  - **The issuer identity is pinned to the clean origin** via `jwt({ jwt: { issuer } })`. Left
    alone, `oauthProvider` derives it from `baseURL`, which includes `/api/auth`, while every RP
    is configured with `OIDC_ISSUER = {origin}` and fetches discovery from the root. OIDC requires
    those to match; strict clients reject the id_token otherwise. Callbacks now also carry `iss`
    (RFC 9207).

  **The client registry yesterday's work hand-wrote is deleted, and what replaced it is split.**
  `src/clients.ts` (id minting, secret rotation, comma-joined redirect URIs) is gone: the plugin
  ships create/rotate, and `clientPrivileges` in `src/auth.ts` admits only the `admin` role —
  while leaving unauthenticated RFC 7591 registration open, because it consults the hook only
  when a session is present. What stayed ours is what the plugin models differently: it treats a
  client as something a USER owns (`client.userId === session.user.id` on every mutating
  endpoint, and no `disabled` field at all), so listing, editing, disabling and removing are
  ours, or an operator could never withdraw an application someone else registered. Registering
  proxies the plugin's `SERVER_ONLY` admin endpoint — that variant can set `skip_consent`, which
  is a column now instead of a `trustedClients` entry in source, which is why the dashboard can
  offer it.

  **The demo relying party no longer ships a password.** `trustedClients` is gone as an option,
  and secrets are hashed at rest, so `substrat-demo-rp` / `demo-rp-secret-not-for-production` —
  resolved by every deployment, production included — is replaced by a per-boot registration
  whose minted credentials the dev server prints.

  Driven in a browser end to end, not only in vitest: registering a client through the dashboard,
  its secret shown once, then an authorize request landing a signed-out visitor on `/login`,
  signing in there, resuming to `/consent`, approving, and arriving at the relying party's
  callback with `code`, `state` and `iss`.

## 0.8.0

### Minor Changes

- ae4e894: `oidcRpAuthProvider` forwards `prompt` to the issuer

  `/api/auth/login?prompt=select_account` (and `prompt=login`) now reaches the authorize
  endpoint, as it already did through `mountOidcRoutes`. Without it a vertical had no way to
  offer "sign in as someone else": an issuer holding a live SSO session silently
  re-authenticates the same user, so the button appears to do nothing. Allowlisted to the two
  IdP-recognised values; absent `prompt` behaves exactly as before.

## 0.7.1

### Patch Changes

- 87ec6f2: Every published package now actually ships its license text.

  `LICENSING.md` has always opened by claiming each package "ships the full text in its
  tarball." Eight of them did not: `adapter-cloudflare`, `control-plane-api`,
  `vertical-auth`, `oidc-rp`, `psl`, `boundary-lint`, `model-emit` and `create-substrat`
  declared a license in `package.json` and shipped no `LICENSE` file. npm auto-includes
  `LICENSE*` when present — none was present, so nothing was included.

  That is worth a version bump rather than a docs fix, because a tarball is where the
  claim is either true or false, and `adapter-cloudflare` is the load-bearing case: §5.7
  makes the Cloudflare adapter half of the two-adapter rule that keeps the escrow story
  literally true, and AGPL is what stops a hosted derivative of it from staying closed.
  An AGPL package distributed without its license text is the weakest possible version of
  that. The texts are the stock unmodified AGPL-3.0 and Apache-2.0, byte-identical to the
  copies already in `kernel` and `contracts`.

  No code changes.

- Updated dependencies [87ec6f2]
  - @substrat-run/oidc-rp@0.5.1
  - @substrat-run/psl@0.2.2

## 0.7.0

### Minor Changes

- 6ac51d1: feat: verticals built outside this repo can install the auth the starter tells them to use

  `create-substrat` scaffolds a vertical whose `/api/*` routes are 401 until real auth is wired
  into `authenticatedPrincipal`, and the template comment points the reader at
  `@substrat-run/vertical-auth` "for the intended shape". That package was `private: true` and
  absent from npm, so the pointer went nowhere: every out-of-repo vertical either hand-rolled the
  owner-claim, `sub`→principal and invite-only logic the `IdentityDO` exists to get right, or
  copied the source. Both packages are now published.

  - **`@substrat-run/vertical-auth` is published**, and ships compiled output like every other
    package here rather than raw `src`. `exports` (root plus the `./provider`, `./oidc` and
    `./oidc-rp-provider` subpaths) resolve to `dist` with declarations; `files` is `["dist"]`.
    The build follows the repo convention — `tsc -p tsconfig.json` for `src`, with the tests
    kept under their own `tsconfig.test.json` so `typecheck` still covers them.
  - **`@substrat-run/oidc-rp` is published** as its dependency. Inlining it into `vertical-auth`
    was the alternative and was rejected: the same Authorization-Code + PKCE round-trip and
    session mint/verify authenticate staff, builders and the CLI in the control plane, and
    security-critical code that has to be fixed twice is worse than one more public package.
    Its description no longer claims the platform apps are the only consumers.

  No behaviour changes — this is packaging. In-repo consumers (Callout, Meridian, Manyfold)
  import from the package root and are unaffected beyond resolving `dist` instead of `src`.

### Patch Changes

- Updated dependencies [6ac51d1]
- Updated dependencies [6ac51d1]
  - @substrat-run/psl@0.2.1
  - @substrat-run/oidc-rp@0.5.0

## 0.6.0

### Minor Changes

- b20cd82: `IdentityDO.getScopeConfig(scopeId)` — the blessed read for a hosted vertical's ordinary
  env-spec keys (#398): the per-scope config map the platform delivered via
  `/internal/configure`, ready to hand to `resolveScopedEnvSpec` (contracts) so an Env-tab
  override actually takes effect instead of the shared deployment default (the #374
  silent-defaults trap). `authWiring()` now reads through it; its shape is unchanged.

## 0.5.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

  Rounds out scope management (create + switch were already there) with **archive**, reusing the
  platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
  do itself, so it's another intent kind:

  - **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
  - **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
    must be under that same tenant and run the same vertical (verified against the directory), then
    `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
  - **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
  - **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
  - **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
    the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
    site from the registry so the switcher updates immediately.
  - **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
    tenant has more than one site); it archives the current site and switches away.

  Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
  `forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
  denied. Refs #358.

## 0.4.0

### Minor Changes

- ad4ccbf: Manyfold multi-scope, M2: a per-tenant site registry so the app lists and switches its sites.

  The per-tenant `IdentityDO` gains a site registry (`recordSite` / `listSites` /
  `resolveSiteScope`, logic factored into `site-registry.ts` so it is unit-testable without a
  Durable Object). Manyfold's worker records each site at `/internal/provision`, serves the
  tenant's sites at `GET /api/sites` (previously 404 in production, which left the switcher
  empty), and resolves the app's `x-site` slug selection to the corresponding scope in `nodeFor`
  — so the existing in-app site switcher now actually switches sites on a deployed install.
  `nodeFor` is split from a sync `baseNode` (the routed tenant + home scope, which the auth
  provider keys on) so the async site resolution never touches the auth path. Tenant isolation is
  unchanged: the registry is per-tenant and `getScope` re-checks the (tenant, scope) pair.

## 0.3.3

### Patch Changes

- c64bdf8: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

## 0.3.2

### Patch Changes

- d696b78: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

## 0.3.1

### Patch Changes

- 2bdd22b: Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

  Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
  to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
  lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
  isolation D-35 has always specified but never checked in code.

  - **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
    wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
    `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
    Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
    calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
    **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
    to `active` with no per-hostname call.

  - **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
    worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
    any stuck `pending` custom bind — issuance self-heals without a human. A new
    `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
    dashboard's _Check again_) re-polls on demand.

  - **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
    algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
    cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
    label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
    domain that is a bare public suffix.

  - **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
    (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
    adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
    `status` filter on `listHostnames` (index-backed) for the reconcile pass.

  - **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
    add a custom domain (shows the DNS records to publish), _Check again_, and remove — no more
    mock rows. Removing a custom domain releases the Cloudflare custom hostname.

  Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
  does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.

- Updated dependencies [2bdd22b]
  - @substrat-run/psl@0.2.0

## 0.3.0

### Minor Changes

- d4bf108: Shared login across a scope's surfaces (K-26 multi-surface): a delivered
  `substrat:auth.cookieDomain` sets the session cookie with `Domain=<parent>` instead of
  host-only, so sibling surfaces (`crm.egeryds.se`, `eka.egeryds.se`, …) share one session.
  The signing secret was already per-tenant (DO-minted), so the attribute is the only thing
  that was missing. Both providers honor it — the OIDC relying party directly, Better Auth
  via `advanced.crossSubDomainCookies` (the worker relays the choice to the IdentityDO as a
  header, re-validated there). `resolveCookieDomain` validates the domain against the
  request host where the cookie is set (equal or proper-suffix at a label boundary, no bare
  TLDs); an invalid domain degrades to host-only rather than breaking sign-in. Setting the
  domain cookie also clears the host-only shadow, and logout clears both variants. Meridian
  threads `cookieDomain` through its `authChoice` as the reference wiring.

## 0.2.1

### Patch Changes

- Updated dependencies [0caa0a9]
  - @substrat-run/oidc-rp@0.4.0

## 0.2.0

### Minor Changes

- d93e690: Detachable vertical auth (docs/architecture/vertical-auth-detach.md): auth moves out of the
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

- Updated dependencies [d93e690]
  - @substrat-run/oidc-rp@0.3.0

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
