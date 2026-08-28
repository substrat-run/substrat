# @substrat-run/demo-auth-server

## 0.3.3

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.3.2

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.3.1

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.3.0

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

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0

## 0.2.73

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.2.72

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.2.71

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.2.70

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0

## 0.2.69

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.2.68

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.2.67

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.2.66

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.2.65

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0

## 0.2.64

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.2.63

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.2.62

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.2.61

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.2.60

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.2.59

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.2.58

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.2.57

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.2.56

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.2.55

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.2.54

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.2.53

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.2.52

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.2.51

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.2.50

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.2.49

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.2.48

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.2.47

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.2.46

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.2.45

### Patch Changes

- 9386282: feat(auth-server): implement the platform's data verbs — `/internal/export` dumps an instance in full and `/internal/delete-scope` wipes one (#590)

  The standalone auth-server answered 501 to both, so the console's retire-with-backup (#493) always refused, wipes stranded storage on the script, and a data-carrying `rebindScopeVertical` could not move an install between lineages. The dump is deliberately unredacted — it exists to rebuild the issuer elsewhere, and the control-plane route in front is the gate, the auditor, and the default masker.

  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0

## 0.2.44

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.2.43

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.2.42

### Patch Changes

- b838410: feat(auth-server): the issuer derives itself from the request hostname — `PUBLIC_ORIGIN` becomes an optional pin

  `PUBLIC_ORIGIN` was `required: true`, so installing the auth server forced the operator to
  type an origin — and a typo'd or not-yet-routable custom domain (no DNS record) made
  discovery advertise an issuer that doesn't route anywhere. Client registration against it
  then failed with Cloudflare 530 / error 1016, attributed to the wrong hostname.

  The runtime already derived the issuer per request (`cfg.PUBLIC_ORIGIN ?? origin`), so the
  declaration now matches it: blank is the default and the issuer answers as whatever
  hostname the router bound to it (platform mint or custom domain), which keeps OIDC
  discovery self-consistent on every door — the spec requires the advertised `issuer` to
  equal the URL discovery was fetched from. Set the pin only when the request origin can't
  be trusted (standalone behind a rewriting proxy).

## 0.2.41

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.2.40

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.2.39

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.2.38

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.2.37

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.2.36

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.2.35

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.2.34

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.2.33

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.2.32

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/adapter-email@0.2.0

## 0.2.31

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.2.30

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.2.29

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.2.28

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.2.27

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.2.26

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.2.25

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.2.24

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.2.23

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.2.22

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.2.21

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.2.20

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.2.19

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.2.18

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.2.17

### Patch Changes

- 99af6b6: Add `resolveScopedEnvSpec` — read a hosted instance's delivered per-scope config overlaid on its envSpec defaults

  A hosted vertical's per-install settings (saved in the dashboard Env tab, delivered via
  `/internal/configure`) land in the scope's own storage, not in worker bindings. Env-spec
  `default:` values ride as worker bindings shared by every install of one serving script, so
  `resolveEnvSpec(env)` can only ever return the deployment-wide default — a vertical that reads
  it silently ignores a saved per-install override.

  `resolveScopedEnvSpec(spec, raw, delivered)` is the pure merge that fixes that: precedence
  **delivered > env > default**, declared keys only (the manifest stays the allow-list), an empty
  delivered value is not an override, and `missingRequired` is recomputed over the overlaid values.
  It stays dependency-free; each vertical supplies `delivered` from its own per-scope store.
  `resolveEnvSpec` is documented as deployment/defaults-only, and auth-server's `effectiveCfg` now
  uses the shared helper instead of a hand-rolled overlay.

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.2.16

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.2.15

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.2.14

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.2.13

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.2.12

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.2.11

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.2.10

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.2.9

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.2.8

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.2.7

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.2.6

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.2.5

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.2.4

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.2.3

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.2.2

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.2.1

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.2.0

### Minor Changes

- 7ed3015: The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

  **auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
  `GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
  database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
  Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
  password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
  issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
  such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
  counts stay readable.

  **control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
  (status + message) instead of collapsing it into the generic 500 "internal error". A
  vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
  dashboard as itself; routes that already hand-caught it are unchanged.

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

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.1.1

### Patch Changes

- 1cbc2be: Declare the auth-server's config surface in `package.json` `substrat.envSpec` (mirroring the
  runtime `AUTH_SERVER_ENV`), so `substrat push` carries it to the registry and the dashboard
  renders a settings form: `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (secret),
  `EMAIL_FROM`. A drift-guard test fails the build if the JSON and the TS spec ever diverge, so
  the form and what the issuer actually reads can't disagree.

  The Grafana-style first-admin bootstrap already existed (`ADMIN_EMAIL` + `ADMIN_PASSWORD`
  seed the admin deterministically on init — no "first to sign in wins" race); this just makes
  it configurable from the dashboard. No insecure `admin/admin` default — unset creds fall back
  to the setup screen.

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
