# @substrat-run/demo-auth-server-app

## 0.1.0

### Minor Changes

- 7cce6cd: auth-server: the applications a client id belongs to are manageable, and sign-up can be opened

  Better Auth's `oidcProvider` owns the OAuth client table but exposes exactly two verbs over it:
  dynamic registration (RFC 7591, which anyone may call while `allowDynamicClientRegistration` is
  on) and a session-gated read of one client's three display fields. There is no list, no edit,
  no disable, no rotate, no delete — so the only record of what this issuer would answer for was
  a row in the platform's read-only Data tab, and a self-registered client could never be
  reviewed or withdrawn. Sign-up had the mirror problem: `emailAndPassword.enabled` meant the
  endpoint was live, but no screen posted to it, so nobody could create an account.

  Both halves are `src/admin-api.ts`, a factory mounted by BOTH runtimes — the Durable Object
  over `ctx.storage.sql`, the node dev server over better-sqlite3 — behind the same `admin` role
  the dashboard itself is gated by (no session ⇒ 401, a signed-in non-admin ⇒ 403, on every verb,
  not just the list).

  **Applications.** Register a client, edit it, disable it, rotate its secret, remove it. Each
  carries its own client id, name, icon, redirect URIs and free-form JSON metadata — the metadata
  exists so the login and consent screens, which Better Auth hands `client_id` on every
  authorize, can differ per application. A secret is returned **once**, by the call that mints
  it; every later read says only `hasSecret`, the line `introspect.ts` already draws for the Data
  tab. Removing a client also deletes its access tokens and standing consents: `oauth_access_token`
  carries no foreign key to the application and `userinfo` authenticates the token row, so
  deleting the client alone would have left an "un-registered" app reading user data until its
  tokens aged out. Clients from `trustedClients` are listed and marked `in code` — they shadow any
  database row of the same id and are the only kind that can carry `skipConsent`, so they are
  shown rather than hidden, and refused rather than given a save button the running issuer would
  ignore.

  **Sign-up.** `ALLOW_SIGNUP` is an ordinary declared env-spec key, so a `wrangler` var, the
  platform's Env tab and the dashboard's new Access toggle all write the same answer through the
  same `cfg:` row the platform's `/internal/configure` writes; both runtimes now rebuild Better
  Auth per request, so a toggle lands on the next request rather than the next deploy. It
  defaults to **off** — an issuer that accepts strangers is a decision, not a default — and
  `emailAndPassword.disableSignUp` is the enforcement, so the hidden screen is only a courtesy.
  Two exemptions are deliberate and pinned: bootstrapping the FIRST administrator goes through
  the same `signUpEmail` route (without the exemption, the default install could never create
  anybody, including the admin who would open sign-up), and Better Auth's admin plugin writes
  through the internal adapter, so "+ New user" keeps working with sign-up closed.

  Someone a relying party sent here can now sign **up** and resume the pending authorize request:
  `autoSignIn` sets a session, and the oidcProvider's after-hook fires on any response carrying a
  new session cookie — not only sign-in. Without that, a new account would have landed on an
  admin dashboard it cannot use, which is #898's failure on the path #898 did not cover.

  `/api/setup-state` now answers `{ needsSetup, signupEnabled }` — the SPA picks between setup,
  sign-in and sign-up from one pre-auth read — and `AuthServerStub.needsSetup()` became
  `issuerState()` rather than growing a second overlapping RPC.

  **What keeps it honest.** `test/clients.test.ts` does not stop at CRUD assertions: a client
  registered THROUGH the dashboard API completes a real authorize → consent → token exchange and
  gets a signed id_token back. Two library couplings only that path can catch — redirect URIs
  stored comma-joined (so a URI containing a comma is rejected at the boundary rather than
  registering fine and never matching) and the secret stored in the shape the token endpoint
  compares against (`storeClientSecret` unset ⇒ plaintext) — would otherwise have failed in
  production with every string assertion green. Disabling is asserted at `/authorize`
  (`client_disabled`) and a rotation is asserted to invalidate the superseded secret at
  `/token`. `test/signup.test.ts` asserts the refusal at the ENDPOINT, both exemptions, the
  toggle taking effect on the very next attempt, and the mid-authorize resume.

  Driven in a browser against the running demo, not only in vitest: registering an application
  from the dashboard, the once-only secret, editing and removing one, redeeming a code with the
  shown secret, toggling sign-up off and watching the link disappear, and a visitor creating
  their own account and landing on "Not an administrator" — an account usable by relying parties,
  with no dashboard access.

- b905e23: auth-server: the OIDC login and consent pages exist

  `src/auth.ts` has always told Better Auth to send people to `loginPage: '/login'` and
  `consentPage: '/consent'`. Neither page existed. Both fell through `routes.ts`'s
  `app.all('*', serveAsset)` to the admin SPA, which chose its screen from session state alone and
  never looked at `location.pathname` — so a relying party that registered itself was dropped
  mid-round-trip and the person landed on an admin dashboard they had not asked for (#898). Found
  pointing a real vertical at a deployed instance: sign-in appears to work, and the app is simply
  never told about it.

  **The issue's account of the mechanism was half right, and the other half is the fix.** The
  abandoned login resumes on its own: Better Auth stashes the authorize request in the signed
  `oidc_login_prompt` cookie, and an after-hook notices the new session, re-runs `authorize`, and
  answers the _sign-in_ request with `{ redirect: true, url }`. The browser client's default
  `redirectPlugin` navigates on exactly that shape. So the redirect did happen — to `/consent`,
  which rendered the dashboard. Both reported symptoms were one missing page.

  - **`/consent`** is a real screen: it names the relying party (from `oauth2/client/:id`, so a
    dynamically registered client's self-chosen name is shown as a claim with its client id
    underneath), spells out each requested scope, and posts the answer to `oauth2/consent`.
    Allow returns the RP's callback carrying the code; **Deny returns it carrying
    `access_denied`** — a denial is an answer the relying party receives, not a dead end.
  - **`/login`** renders sign-in _even when a session already exists_. This is not redundant:
    `prompt=login` and an expired `max_age` are re-authentication requests, and answering one
    with the dashboard stranded the flow exactly as `/consent` did.
  - `signIn` now reports whether an authorize request took over, so the app does not re-render
    the dashboard over a page that is already leaving. It applies to first-run bootstrap too —
    creating the first admin can itself be the answer to an RP's authorize request.

  **Why the suite stayed green, and what now keeps it honest.** The only entry in `trustedClients`
  is the seeded demo RP, and it sets `skipConsent: true`. A trusted client with a session touches
  neither `loginPage` nor `consentPage` — so the two redirects that were broken were precisely the
  two the demo never took, while `allowDynamicClientRegistration: true` exists to invite the
  clients that take both. `test/untrusted-client.test.ts` drives a client that registers itself,
  through register → authorize → resume-on-sign-in → consent → token, and asserts an id_token
  comes back. It also pins the redirect targets and the `consent_code` / `client_id` / `scope`
  parameter names: those are Better Auth's choices, not ours, and the SPA is built on them.

  Verified in a browser against the running demo, not only in vitest: a self-registering RP
  completes sign-in → consent → callback and redeems a signed id_token; deny reaches the RP as
  `access_denied`; an already-consented client is not asked twice; `prompt=login` re-authenticates
  and completes; `prompt=none` is still answered at the RP with `login_required` without any UI;
  and the operator's dashboard is unchanged.

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
