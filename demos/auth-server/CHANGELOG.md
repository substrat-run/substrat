# @substrat-run/demo-auth-server

## 0.7.6

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0
  - @substrat-run/kernel@0.110.0

## 0.7.5

### Patch Changes

- 8108cf7: An administrator can take one sign-in method away (part of #1278).

  The user-detail screen could already answer "how does this person sign in" for somebody
  else — that read was the one server surface the screen needed — but it could only read.
  An operator holding "this Google account is not theirs any more" had no lever, because
  Better Auth's `unlink-account`, like its `list-accounts`, answers only for the session
  making the call.

  `DELETE /api/admin/users/:userId/sign-in-methods/:accountId` is that lever, behind the
  same session + `admin` gate as its neighbours, with two refusals that are the point of
  it rather than validation around it. The row must belong to the user the URL names —
  `account.id` is globally unique, so a delete keyed on the id alone would unlink a
  different person's method through a URL naming the one an operator was looking at. And
  it must not be their last way in: an account with no method is not a lesser account, it
  is one nobody can sign into, recoverable only by an administrator setting a password and
  not at all by the person themselves. A `credential` row counts only when it actually
  carries a hash, which is a distinction the browser cannot make and so belongs here.

  On screen each row gets a Remove button whose confirmation names the consequence rather
  than the verb, and says the thing most likely to be assumed the other way: removing a
  method decides how they sign in next time, and leaves the sessions they already have
  open. Ending those is Revoke, one panel below, and doing both from one button would take
  the choice away. The last remaining method's button is disabled with the reason written
  out beside it — the server refuses it either way, and meeting that refusal as an error
  banner is a worse way to learn it.

  The password hash and the upstream's tokens still never leave the server: the row that
  decides is read as a predicate (`password IS NOT NULL`), never as a value.

  No migration and no permission key. `impersonate-user` stays mounted and unused — that
  is a separate decision #1278 asks to be argued rather than taken in passing.

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

- 206282d: BankID's certificate form is a screen with a URL (part of #1278).

  The last configuration surface in the issuer console that was still edited inline: an
  mTLS certificate, a private key, an environment and two decisions, in a form that
  unfolded under the status table with no address of its own. So a reload lost whatever
  had been pasted, a stale session's sign-in landed the operator back on the status table,
  and the screen could not be sent to anyone.

  `/bankid` is now the status — environment, whether a certificate is stored, enabled or
  disabled, and what an operator can do next — and `/bankid/settings` is the certificate,
  the environment and an Actions panel holding the removal. `returnTarget` keeps the
  second one across the sign-in it triggers, so a pasted link survives the login it
  provokes, the same way the Users, Applications and Sign-in-provider detail screens do.

  It is the one detail screen with nothing to identify: there is a single BankID
  configuration per issuer, no client id and no redirect URI to register, so the segment
  is a literal rather than an id — and, unlike the other three, the path is a place
  whether or not anything is configured there yet. Enabling BankID and editing it are the
  same screen, which is why the status table's button is a link.

  No server surface, no migration and no permission key: `GET /api/admin/bankid` already
  returned every fact both screens show.

- 00c0f8d: A new person's first federated sign-in no longer waits on the verification email.

  This is the asymmetry behind "sign-in works, except for people who have never signed in
  before" — a report that sounds arbitrary and is not. Exactly one thing happens on a first
  sign-in and never again:

  ```
  handleOAuthUserInfo → isRegister && !user.emailVerified && sendOnSignUp
                      → dispatchVerificationEmail
                      → runInBackgroundOrAwait(send)     ← with no handler: `else await promise`
  ```

  Both conditions hold permanently on this issuer. `emailVerification.sendOnSignUp` is on, and
  Entra does not publish `email_verified` — which Better Auth maps to `false` — so every
  brand-new Microsoft user is created unverified and gets the mail. No handler was configured,
  so that send was **awaited inside `/callback/:id`**, which has not answered yet: the browser
  is mid-redirect, looking at a page that is still loading, while the platform mail relay — the
  control plane, and then its own mail provider — decides how long it takes. A returning user
  skips all of it, which is why it looked like a property of the person rather than of the path.

  `buildAuth` now takes `runInBackground`, wired to Better Auth's
  `advanced.backgroundTasks.handler`. The Durable Object hands it `ctx.waitUntil` — which Better
  Auth cannot find by itself, since it is given a `Request` and nothing else — and the dev server
  simply does not await it, so local behaviour is the deployed behaviour. Left undefined, Better
  Auth awaits exactly as before, which is what keeps the test suite deterministic: a test
  asserting a verification mail was sent must not race its assertion against a floating promise.

  The regression test hands the transport a promise that **never resolves**, because that is the
  shape of the production failure and the only way to assert the property rather than the timing:
  if the callback waits on the mail at all, the test cannot finish. Removing the fix makes it
  time out, which is what the browser was doing.

  And the relay itself is now bounded. `PlatformRelayEmailTransport` POSTs to the control plane
  with no timeout at all, which is how an unbounded send became an unbounded page load. It takes
  a `timeoutMs` (default 10s) and passes an `AbortSignal` — a bound rather than tuning, at the one
  place in the chain that knows it is talking to a network. Defence in depth: with the handler in
  place the send is no longer in anybody's way, but a transactional mail send should not be able
  to hang regardless of who is waiting.

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
- Updated dependencies [4fc7db2]
- Updated dependencies [00c0f8d]
- Updated dependencies [62f4e87]
  - @substrat-run/contracts@0.109.0
  - @substrat-run/kernel@0.109.0
  - @substrat-run/adapter-email@0.2.1

## 0.7.4

### Patch Changes

- 1863126: A client restricted to one sign-in provider can be signed into again (#1381).

  `metadata.signIn = { providers: ['<upstream>'], password: false }` was unusable:
  the person was sent to the upstream, came back, and was sent there again —
  forever, resting on `/api/auth/callback/<provider>` between hops. A directory
  that worked perfectly, looping.

  The two halves of the feature were disagreeing about one string. Enforcement
  compares the client's policy against `session.signInProvider`, stamped at session
  creation from the path the session was minted on — and Better Auth hands that hook
  the ROUTE, not the URL. Its social callback is registered as the literal
  `/callback/:id`, with the provider in `params.id` beside it, so reading the id out
  of the path stamped `null` on every provider sign-in. A `null` stamp is refused
  under every policy, deliberately, because that is the fail-closed answer for a
  session that predates the feature. So `/oauth2/authorize` refused the session with
  `max_age=0`, the plugin returned the person to `/login`, and the login screen —
  narrowed to one provider with no password beside it — started the same trip again.
  Password sign-in was unaffected: `/sign-in/email` is a literal route with no
  parameter to lose.

  `signInMethodOfPath` now resolves the parameter when the matched segment is a
  pattern, and parses what comes back with the same rule a provider id is
  constrained by, so only an id-shaped value can become a stamp. Nothing else
  changes: an unparameterized route still reads as itself, the reserved ids
  (`password`, `bankid`) are still refused from a callback, and an unstamped session
  is still refused under every policy.

  The suite gained the case that was missing rather than the case that failed. Every
  existing test established its session with a password and proved a REFUSAL, and a
  refusal only needs the stamp to be absent — so all of them passed over an
  implementation that stamped nothing. Three cases now drive the real callback: the
  stamp says the provider, a client naming that provider is handed on to consent,
  and the same session is still refused by a client naming a different one.

- Updated dependencies [5e80e5f]
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/kernel@0.108.0
  - @substrat-run/contracts@0.108.0

## 0.7.3

### Patch Changes

- Updated dependencies [bf9490a]
- Updated dependencies [4a6c4c3]
  - @substrat-run/kernel@0.107.0
  - @substrat-run/contracts@0.107.0

## 0.7.2

### Patch Changes

- Updated dependencies [2956182]
  - @substrat-run/kernel@0.106.0
  - @substrat-run/contracts@0.106.0

## 0.7.1

### Patch Changes

- Updated dependencies [5201683]
  - @substrat-run/kernel@0.105.0
  - @substrat-run/contracts@0.105.0

## 0.7.0

### Minor Changes

- 2108df6: Decide what an upstream sign-in may do with an address that already has an account here.
  A new issuer-wide setting, `ACCOUNT_LINKING`, beside the sign-up toggle and settable the
  same three ways: `link` lets the sign-in join that account — on Better Auth's own two
  conditions, the upstream vouching for the address (or the provider being trusted here) and
  the local account having a verified one — and `block` never joins implicitly, leaving the
  person to sign in the way they already can and connect the provider from inside that
  session. It defaults to `link`, which is what the issuer did before the key existed:
  unlike the sign-up toggle this one defaults permissive on purpose, because a setting that
  silently changes how people sign in on upgrade is worse than one you have to turn on.
  `block` is careful about two things it does not do, each held by a test: it leaves the
  deliberate connect alone, since a session proves the account in a way a matching address
  does not, and it leaves alone an upstream identity that matches no account here, since a
  newcomer is not a join. There is no third mode, and the missing one is the one most
  identity providers offer: keeping two separate accounts on one address. Better Auth
  resolves an email to exactly one user — in password sign-in, password reset, recovery and
  account creation alike — so a second account at that address would make each of those pick
  one arbitrarily. Both the setting's description and the dashboard say so, rather than
  leaving the absence to look like an oversight.
- 144fa0f: Sign in with a Supabase project that is still on the legacy shared JWT secret. Such a
  project cannot be added as an ordinary sign-in provider, and not by our choice: Supabase
  will not mint the OIDC id_token that the redirect flow needs while signing with HS256, so
  the catalogue entry simply cannot serve it. Instead the issuer can now accept an access
  token that project already issued to its own app, at one endpoint that exists only when an
  operator has configured both the secret and the project URL. The person lands in the same
  account they would have reached through the redirect flow — the account is keyed on the
  project and Supabase's own user id — so migrating the project to asymmetric signing keys
  later moves nobody and changes no relying party's view of who they are. What the issuer
  refuses is the part worth knowing about: on a legacy project the JWT secret signs more than
  people, and the project's public `anon` key — the one printed in its own browser bundle —
  is itself a valid signature. That key, the `service_role` admin key, any unfamiliar role,
  an anonymous session, another project's token and anything not signed with HS256 are all
  turned away, and every one of those says the same thing to the caller, so the endpoint cannot
  be used to probe which check a token failed. A token that verifies but is turned away by
  policy — sign-up closed, or an address that already has an account — says which, because the
  person reading it has proved the token and can act on the answer. Whether someone arriving at an address that already has an
  account here is joined to it or refused is the issuer's existing account-linking setting,
  applied to this door too.
- 62187da: Sign in with Supabase. A Supabase project now runs a standards-compliant OAuth 2.1 /
  OIDC server, so the issuer's Custom (OIDC) door already admitted one — but only for an
  operator who knew the one thing nobody can guess: a project's issuer is the project URL
  with `/auth/v1` on the end, and the project URL alone serves no discovery document.
  Paste the URL you have and discovery returns a 404 that names nothing. Supabase is
  therefore a named entry in the sign-in providers catalogue rather than one more thing to
  type into the open door: the catalogue supplies the name, the button, the redirect URI to
  register and a field hint that says where the suffix comes from, and the operator supplies
  a project and a credential. Underneath it is the same generic row as any custom provider —
  discovery resolved once at save time, endpoints stored, the same callback path — so
  nothing about a Supabase sign-in is special at runtime. The precondition on the Supabase
  side is stated rather than hidden: the project needs its OAuth 2.1 server turned on,
  authorization UI included, which no setting here can stand in for. Catalogue entries are
  now of two kinds — providers the library ships built-in, and named generic ones like this —
  and a test holds that distinction against the library's own list, so a provider Better
  Auth adds later cannot be silently shadowed by ours.

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0
  - @substrat-run/kernel@0.104.0

## 0.6.1

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [dcde11e]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0
  - @substrat-run/kernel@0.103.0

## 0.6.0

### Minor Changes

- f56acee: Connect a second way of signing in to the account you already have. Someone who
  signs up with a password and later clicks "Continue with <provider>" hits Better
  Auth's `account not linked` — a correct refusal, since an address at an upstream
  is not by itself permission to become whoever holds it here, but until now a dead
  end with nothing on the screen to do about it. The dashboard now lists the sign-in
  methods on your own account and connects or disconnects one from inside a session
  that already proves who you are, which is the path that works for an account no
  upstream has verified — one an administrator created, or one BankID minted. The
  "not an administrator" page carries the same panel: it is the only page an ordinary
  person of this issuer ever reaches, and it is exactly where the refusal sends them.
  The admin's `trust_email` toggle stays the other way past, and the new suite pins
  what separates them — trusting a provider joins at sign-in only when the local row
  is verified too — plus the property that makes either worth having: after a link,
  signing in through the upstream returns the same user id, the `sub` every relying
  party already stored.

### Patch Changes

- Updated dependencies [46051ee]
- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/kernel@0.102.0
  - @substrat-run/contracts@0.102.0

## 0.5.3

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0
  - @substrat-run/kernel@0.101.0

## 0.5.2

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0
  - @substrat-run/kernel@0.100.0

## 0.5.1

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0
  - @substrat-run/kernel@0.99.0

## 0.5.0

### Minor Changes

- a70b146: Per-client theming for the hosted OIDC pages. The application that sends someone to
  `/login`, `/signup` or `/consent` now decides how those screens look: its operator stores a
  Clerk-shaped `theme` object (`colorPrimary`, `colorBackground`, `borderRadius`, `logoUrl`,
  `title`, …) in the client's existing `metadata` — the dashboard's client editor grows an
  Appearance section for the common keys — and the SPA applies it as CSS custom properties,
  resolved per `client_id` from the signed authorize query. The public read
  (`GET /api/branding`) returns only the key-by-key sanitized theme and answers identically
  for unknown, disabled and unthemed clients, so it discloses nothing about the registry.

## 0.4.0

### Minor Changes

- deb80ca: Sign in with BankID, enabled from the dashboard. The issuer drives BankID's RP API v6.0
  itself — start an order, serve the animated QR (computed server-side, pinned to BankID's
  documented HMAC example) or the same-device autostart link, poll `collect` — and lands the
  verified personal number in an account under provider `bankid`, so signing in twice lands in
  the same account. Built as a Better Auth plugin, which is what makes the admin plugin's ban
  check and `oauthProvider`'s authorize-resume apply to it exactly as they do to the password
  path. Configuration is a dashboard panel (environment, PEM client certificate + key,
  create-accounts and disabled toggles); the Node dev server presents the PEMs directly while
  a standalone worker presents an `mtls_certificates` binding — and without one the login
  screen offers no BankID button rather than a flow the worker cannot finish.

### Patch Changes

- Updated dependencies [551d0cf]
  - @substrat-run/contracts@0.98.1
  - @substrat-run/kernel@0.98.1

## 0.3.10

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
- Updated dependencies [ee70af5]
  - @substrat-run/contracts@0.98.0
  - @substrat-run/kernel@0.98.0

## 0.3.9

### Patch Changes

- Updated dependencies [9fcfebc]
- Updated dependencies [59121f6]
  - @substrat-run/contracts@0.97.0
  - @substrat-run/kernel@0.97.0

## 0.3.8

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0
  - @substrat-run/kernel@0.96.0

## 0.3.7

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0
  - @substrat-run/kernel@0.95.0

## 0.3.6

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [1fc01d3]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0
  - @substrat-run/kernel@0.94.0

## 0.3.5

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.3.4

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

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
