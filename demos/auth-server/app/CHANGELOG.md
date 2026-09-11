# @substrat-run/demo-auth-server-app

## 0.1.1

### Patch Changes

- 00c0f8d: The issuer remembers what happened when someone tried to sign in.

  "A user cannot sign in with Microsoft" was a question this issuer had no way to answer.
  Every fact that would have settled it was destroyed as it was produced: a refused
  federated sign-in reports itself by REDIRECTING, so the reason existed only as a query
  parameter on somebody else's screen; the authority the issuer addressed on that person's
  behalf existed only in an address bar, mid-navigation; and a hosted install is a script in
  the platform's dispatch namespace, whose `console.log` is not somewhere the operator who
  configured the provider can look. So the answer went where that operator already is — the
  issuer's own SQLite, which is what the admin console reads, what the dashboard's Data tab
  shows, and what `/internal/export` dumps.

  `sign_in_attempt` records both ENDS of a round trip, one row per hop, and the pair is the
  diagnosis. `started` says the person was handed an authorization URL and names the
  authority they were sent to. `succeeded` / `failed` says what came back, carrying the
  refusal code and — the field that is usually the whole answer — the upstream's own
  sentence about it, because an `AADSTS…` message names the exact misconfiguration. A
  `started` row with nothing after it is itself the most telling shape there is: the person
  never returned, so the refusal happened on the provider's own screen, and the authority is
  then the only evidence available. `common` against a single-tenant app registration fails
  exactly that way, and the log is now the one place that distinction is visible.

  It is written from an after-hook, which is the only place either end is observable:
  `/callback/:id` signals every outcome it has — success and refusal alike — by THROWING a
  redirect, so the outcome is read off that redirect's `location` and not from a return
  value that does not exist. A hook written against the return value would log nothing on
  the paths that matter and pass its own tests, which is why the suite drives a real round
  trip for each.

  No credential can reach a row. The writer takes a fixed, narrow set of fields — nothing
  arrives by spread — and of the authorization URL it keeps only the part before the `?`:
  the query is where the PKCE challenge, the state and the signed authorize request live. A
  log of sign-in attempts that leaked the material of one would be worse than the problem it
  was added for, so that rule is held at the write, and a test asserts the property over
  every stored cell rather than over the fields it happens to know about.

  The table is a RING, pruned on write to the most recent 500 hops: this is a debugging aid
  in a Durable Object's SQLite, not an audit trail, and the screen says so instead of
  implying the log is complete. The writer swallows its own errors for the same reason — a
  debugging aid must never be the thing that costs someone a login.

  `GET /api/admin/sign-in-log` reads it behind the same session + `admin` gate as its
  neighbours, paging by id rather than by offset because the ring moves underneath a reader.
  On screen it is a new **Sign-in log** section beside the providers it explains, with a
  "Refusals only" filter, since that is the read an operator actually makes.

  No migration to review and no new permission key. Passwords and BankID are not recorded:
  what went missing was the federated round trip, and a narrower table is a smaller amount
  of somebody's sign-in activity to hold.

  ## And the spinner that never resolved

  A stuck screen is not a refusal, so the log above would not have explained one. Two reads
  gate every screen this app has — `/api/setup-state` and `/api/session` — and both trusted
  whatever came back: `res.json()`, no status check, no shape check, called from a `refresh()`
  with no `catch` and five bare `void refresh()` callers. Both failure shapes a deployed
  issuer actually produces ended somewhere worse than an error message.

  A body that is not JSON — a worker exception page, a 5xx from an intermediary, anything
  HTML — made `res.json()` reject inside that un-caught `refresh()`. The phase stayed
  `loading`, so the page said “Loading…” and meant “this failed seconds ago and nobody is
  going to tell you”. That is the shape a person reports as being stuck on a spinner.

  An `{ error }` envelope — which is exactly what `routes.ts` answers a failure with — parsed
  perfectly well and was handed on as data. As a session it is a truthy object with no
  `role`, so the console told an administrator they were not one. As the issuer state it left
  `providers` undefined for a screen whose next line is `providers.length`.

  Both reads now go through `app/src/wire.ts`, which checks the status, reads the body as text
  so a non-JSON answer becomes “the issuer answered 502” rather than a parser error, lifts the
  issuer's own `error` message when there is one, and refuses a body that parses but is the
  wrong shape. It is React-free and `fetch`-free for the reason `paths.ts` is, so the issuer's
  own vitest pins all of it.

  The distinction the tests care about most: a failed session read must never be reported as
  “signed out”. Signing out someone who is signed in sends them to a login screen — and for a
  client restricted to one provider, that screen redirects straight back out to it, so the
  cheap answer turns one failed read into a loop through a working directory.

  `refresh()` now has one wrapper every caller goes through, and a rejection is a screen: the
  reason, the fact that it is the issuer's problem rather than the person's, and a Try again
  button. `clientOptions` is deliberately left alone — a theme and a sign-in narrowing have an
  honest fallback in the issuer's own defaults, so that read degrades rather than failing.
  These two have no fallback; there is no honest “probably signed in”.

  ## From review

  Three things the first cut got wrong, all worth the fix:

  **The two halves of one attempt were not joined.** "A hop out with nothing after it means they
  never came back" is an inference over two rows, and two people signing in at once is all it takes
  to break it: `started, started, succeeded` says nothing about which of them is still missing — so
  the inference the table exists to support would have been wrong exactly when the issuer was busy.
  The rows now carry a `correlation`, derived independently at both ends from the OAuth `state`,
  which is the only thing that survives the round trip. Hashed, truncated to 64 bits, never stored
  raw: the state is what the callback checks the returning request against, so a log holding it in
  plaintext would be a log of live single-use tokens — the exact class of thing this table refuses
  to carry. The screen uses it to mark an unanswered hop itself rather than asking a reader to pair
  rows up by eye.

  **The failed screen printed the issuer's own error text.** That screen is pre-auth and themed as
  whichever relying party sent the person there, so its reader is a stranger signing into somebody
  else's app — and `routes.ts` answers a failure with the raw `.message` of whatever threw inside
  the issuer. `IssuerUnreachable` now carries the two apart: a generic `message` with the status for
  the page, the issuer's own words in `detail`, which `App.tsx` logs to the console and never
  renders.

  **The screen claimed to page and did not.** The read was keyset-paged server-side and the view
  only ever asked for the newest page, so on a busy issuer the older four-fifths of the ring were
  unreachable from the one screen built to read it. There is now a Load older control, keyed on the
  oldest row's id — keyset rather than offset, for the reason the server is: the ring is pruned
  under a reader and an offset steps over whatever moved.

- Updated dependencies [56ec7c0]
  - @substrat-run/ui@0.3.1

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
