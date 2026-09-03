# Auth Server — a standalone Better Auth OIDC provider

## What it is

A self-contained **identity provider** you can host on its own and point any OIDC-compatible
application at — inside Substrat or outside it. It is Better Auth, configured as an OAuth 2.1
/ OIDC issuer, with three plugins doing the work:

- **`jwt`** — asymmetric signing keys (EdDSA/RS256), served as JWKS. Relying parties verify
  id_tokens from the public key alone; there is no shared secret to distribute. It also pins
  the issuer identity to the clean origin (see below).
- **`oauthProvider`** (`@better-auth/oauth-provider`) — the OAuth/OIDC surface: discovery,
  `/oauth2/authorize`, `/oauth2/token`, `/oauth2/userinfo`, introspection, revocation,
  end-session, consent, and the client registry (with optional dynamic registration).
- **`admin`** — user management (list / create / ban / role / impersonate) and the `admin`
  role the dashboard gates on.

This was Better Auth's in-core `oidcProvider` until 1.7 removed it (deprecated since 1.6).
The replacement is a different plugin rather than a rename, and four of its differences are
load-bearing here:

1. **PKCE is mandatory** (OAuth 2.1), for confidential clients too. An authorize request
   without `code_challenge` is refused at the relying party's callback.
2. **The pending authorize request is not remembered server-side.** It travels as the whole
   signed query on the redirect to `/login`, `/signup` or `/consent`, and the page must hand
   it back as `oauth_query`. A sign-in that omits it succeeds and resumes nothing — the same
   stranding as #898, by a new route.
3. **Client secrets are hashed at rest**, so a secret is knowable only at the moment it is
   minted. The demo relying party consequently has no fixed credentials in source; it is
   seeded per boot and printed by the dev server.
4. **The issuer identity is pinned** to the clean origin through the jwt plugin. Left alone,
   `oauthProvider` derives it from Better Auth's `baseURL` — which includes `/api/auth` —
   while every relying party is configured with `OIDC_ISSUER = {origin}` and fetches
   discovery from the root. OIDC requires those to match, so the mismatch is not cosmetic.

## Why it is not a Substrat vertical

It composes **no kernel engines** and has no `ScopeDO`. Its entire domain — users, sessions,
OAuth clients, access tokens, consent, signing keys — is owned by Better Auth, not the
Substrat kernel. So there are no operations, permissions, events, or migrations in the
Substrat sense. It lives under `demos/` and follows the demo *conventions* (Hono worker +
inlined React SPA + `nodejs_compat` + a single Durable Object), but it is an app, not a
vertical. The relationship to Substrat runs the other way: Substrat's platform apps consume
OIDC as relying parties (`@substrat-run/oidc-rp`), and this server can be their issuer.

## The three requirements

1. **Standalone OIDC server for any app.** The issuer publishes a standard discovery document
   at `{issuer}/.well-known/openid-configuration` and a JWKS endpoint; `@substrat-run/oidc-rp`
   (or any conformant RP) consumes it with only `OIDC_ISSUER` configured. A demo relying party
   is pre-registered so the authorize→token round-trip works out of the box.
2. **Password reset via the email adapter.** Better Auth's `sendResetPassword` (and email
   verification) send through `@substrat-run/adapter-email` — `CloudflareEmailTransport` in
   production (a `send_email` binding), the in-memory mock in dev/tests. The Node dev server
   prints each reset link to the terminal so the flow is clickable without a sending domain.
3. **An admin dashboard that uses its own login.** A small React SPA signs in through this
   same issuer — the server is its own first relying party — and every admin action is gated
   server-side by the Better Auth `admin` role. A first-run bootstrap creates the first admin
   (the only account creation that needs no existing admin).

### What the dashboard manages, and which side owns each verb

Users are the library's own admin plugin. The **Applications** panel is split, and the split
is not arbitrary — `oauthProvider` models clients as things a USER owns, and an issuer's
operator console needs something else:

| Verb | Owner | Why |
|---|---|---|
| Register | plugin (`adminCreateOAuthClient`, proxied) | mints the id, mints and hashes the secret, validates redirect URIs. Marked `SERVER_ONLY` because it is the variant that can set `skip_consent`, so a browser cannot reach it directly. |
| Rotate secret | plugin | the only verb left that touches secret material. Scoped by the plugin to whoever registered the client. |
| List | ours | the plugin's `/oauth2/get-clients` answers "the clients YOU created". A registry also holds another admin's and self-registered ones. |
| Edit / disable / remove | ours | every client-mutating endpoint the plugin exposes requires `client.userId === session.user.id`, so a self-registered client could never be withdrawn by anybody; and `disabled` is not in its update body at all. These touch plain columns — no ids, no secrets — and re-validate the redirect URIs the plugin would have. |

The **Sign-in providers** panel is entirely ours — the library has no registry to proxy, since
it expects those to be config. See "Upstream identity providers" below.

A client secret is shown **once**, at the moment it is minted; it is stored hashed, so no
later read could return it even deliberately. `skip_consent` is a column now rather than a
`trustedClients` entry in source, which is why the dashboard can offer it at all.
- **Whether people may create their own account.** `ALLOW_SIGNUP` is an ordinary declared
  env-spec key, so a `wrangler` var, the platform's Env tab and the dashboard's Access toggle
  all write the same answer; the issuer rebuilds Better Auth per request, so a change lands on
  the next request rather than the next deploy. It defaults to **off** — an issuer that accepts
  strangers is a decision, not a default — and `emailAndPassword.disableSignUp` is what enforces
  it, so hiding the screen is only the courtesy. Bootstrapping the first administrator goes
  through the same sign-up route and is deliberately exempt, or a default install could never
  create anybody. Someone a relying party sent here can sign **up** and resume that authorize
  request, landing back at the application rather than on this dashboard.

That SPA is **two surfaces behind one origin**, and the second is easy to miss: besides the
dashboard it serves the issuer's own user-facing OIDC pages, `/login` and `/consent`. Those
paths are named in `src/auth.ts` (`loginPage`, `consentPage`) and Better Auth redirects people
to them mid-`/authorize`, so they are part of the OIDC contract rather than client routes the
app happens to own. Anyone reached through them may be an ordinary user of some other
application — **not an administrator**, and not someone who came here on purpose. `/consent`
names the relying party and the scopes it asked for, and answers back at the RP's own callback
whether the person allows or denies.

The distinction that matters for testing: a client in `trustedClients` with `skipConsent` takes
neither redirect, and the seeded demo RP is exactly that. So the paths every external relying
party depends on are the ones the built-in round-trip never exercises — which is how they came
to not exist at all (#898). `test/untrusted-client.test.ts` drives a client that registers
itself, and is the reason to keep one.

## Upstream identity providers

The issuer has a registry at each end of it, and they are easy to confuse. **Applications**
holds the relying parties DOWNSTREAM — apps that send people here to sign in. **Sign-in
providers** holds the directories UPSTREAM — providers this issuer is itself a relying party
of, so that a person can "continue with Microsoft" instead of typing a password. A vendor's
own app appears in the first; the vendor's Entra tenant appears in the second.

Better Auth takes its social providers as **config**, which for an issuer configured at deploy
time would mean a pair of declared env keys per provider and a redeploy to add one. They are
**rows** instead (`identity_provider`, `src/providers.ts`): an operator adds one from the
dashboard, and because both runtimes rebuild Better Auth per request — the same property the
sign-up toggle relies on — the button appears on the login screen on the next request.

The catalogue is deliberately **closed** (Microsoft, Google, GitHub). Each entry is a provider
the library ships endpoints and a profile mapping for, so enabling one is a credential plus two
decisions rather than a form of URLs to get subtly wrong. The redirect URI is **shown, not
asked for**: it is `{issuer}/api/auth/callback/{provider}`, derived, and every upstream refuses
a sign-in whose registered URI differs by a character.

The two decisions are per provider, and neither has a safe default that suits everyone:

- **Let this provider create accounts** (`disableSignUp` inverted). Separate from the
  issuer-wide `ALLOW_SIGNUP`, which is about passwords. A vendor federating a directory it owns
  usually wants this on and that one off: everyone in the directory gets in, nobody else can
  register.
- **Trust this provider's email addresses** (`accountLinking.trustedProviders`). Without it, an
  administrator creates a user, that user signs in with Microsoft, and Better Auth declines to
  join the two — "account not linked". Entra does not assert `email_verified`, so this is the
  normal case rather than an edge one. Trusting a directory that controls its addresses is
  right; trusting a consumer provider by default is not. Better Auth additionally requires the
  LOCAL account to be email-verified before it will link, which is its own gate against someone
  pre-registering at a victim's address, and is left alone.

A pending authorize request survives the round-trip: `oauthProvider`'s before-hook special-
cases `/sign-in/social` and puts the request into the OAuth state, so the callback that
establishes the session also resumes the authorize and returns the person to the relying party
that sent them. Dropping `oauth_query` on that path would sign someone in while silently
abandoning the application waiting on them — #898, wearing a different hat.

## BankID

Swedish e-ID sign-in, beside the OAuth upstreams but not among them: BankID is not a redirect
flow. The issuer **calls** BankID's RP API v6.0 over mutually authenticated TLS — start an
order, poll `collect` every two seconds — while the person approves in the BankID app, reached
by an animated QR code (other device) or an `autostarttoken` URL (same device). A completed
order carries the verified **personal number and name**; the personal number is the account
key (`account` row, provider `bankid`), so signing in twice lands in the same account. BankID
asserts identity, not an email address, so a first sign-in either creates an account (the
panel's "create accounts" toggle) or is refused with instructions — there is no address to
match an existing user by.

The pieces (`src/bankid.ts`, `src/bankid-plugin.ts`): the flow is a Better Auth **plugin**
(`/bankid/start`, `/qr`, `/collect`, `/cancel` under `/api/auth`), because completion must end
in a real Better Auth session — which also picks up the `admin` plugin's ban check (a hook on
session creation) and `oauthProvider`'s resume hooks (a completing `collect` carrying
`oauth_query` answers with the redirect to the relying party, the same #898 contract as every
other sign-in path). Pending orders live in the `verification` table; the QR secret never
reaches the browser — the issuer computes each one-second frame, per BankID's own guidance,
and the recipe is pinned to BankID's documented example in `test/bankid.test.ts`.

The **mTLS client certificate** is the runtime seam. Configuration is one JSON row in `config`
(dashboard panel: environment, PEM cert + key, two toggles — redacted by introspection, carried
by the dump). The Node dev server presents those PEMs directly (`src/bankid-transport-node.ts`,
pinning BankID's own root CAs — their API servers are not publicly trusted); a standalone
worker presents a `mtls_certificates` binding (`BANKID`, see wrangler.jsonc), workerd's fetch
having no per-request client cert. No binding ⇒ the button is not offered — a configured flow
the runtime cannot finish stays parked rather than half-working.

Trying it: the **test environment** takes the shared `FPTestcert5` certificate from
[bankid.com/en/utvecklare/test](https://www.bankid.com/en/utvecklare/test) (passphrase
`qwerty123`; the panel shows the two `openssl` lines that PEM it) and a BankID app switched to
test mode via the [test portal](https://developers.bankid.com/test-portal/testing), where you
mint test identities. Production requires the certificate your bank issues to your
organisation.

## Client ID Metadata Documents (CIMD)

A client can identify itself by an HTTPS URL that IS its metadata document
(`draft-ietf-oauth-client-id-metadata-document`), under the MCP `2026-07-28` profile. No
registration write, no client secret, nothing to rotate: the issuer fetches the document the
`client_id` names, validates it, and persists the client through the OAuth provider's own
registration path with `client_discovery_id = 'cimd'` — which is what stops a document later
claiming an id an administrator registered by hand.

This is what lets an MCP client reach a **vertical's** MCP endpoint. That endpoint is a
resource server: it answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`,
publishes `/.well-known/oauth-protected-resource` naming this issuer, and has no opinion
about who minted the client. Registration is entirely this side of the wire.

It **composes with** dynamic registration rather than replacing it. `allowUnauthenticated
ClientRegistration` already makes this issuer usable via RFC 7591, and a client picks:
CIMD is the better answer for a directory client, because nothing is written per client
until one actually arrives.

### The transport is injected, because its guarantee is runtime-specific

`@better-auth/cimd` states a security contract for the fetch that retrieves a document: it
must resolve the hostname exactly once, reject RFC 6890 special-use addresses, pin the
approved address, and refuse redirects — defences against DNS rebinding, where a name
answers publicly when checked and privately when fetched.

| Runtime | Transport | Honoured |
|---|---|---|
| Node dev server | `@better-auth/cimd/node` | all four |
| Durable Object (production) | `src/cimd-fetch.ts` | three — **not** resolve-once-and-pin |

workerd exposes no DNS API, so pinning is not expressible there: by the time `fetch` is
called the runtime owns resolution and nothing can sit between the two. What substitutes is
a property of *where the code runs*, not of the code — a Worker egresses from Cloudflare's
edge and has no route into RFC 1918, loopback or link-local space, so a rebind lands
somewhere the runtime will not connect. That is a mitigation, and `cimd-fetch.ts` says so
rather than claiming the guarantee. An issuer that ever needs the real thing moves the fetch
to a boundary that can resolve — the D-46 egress hop.

`fetchClientMetadataResource` is therefore a declared dependency of `buildAuth`, beside
`database` and `transport`. **Omit it and CIMD is not mounted at all**: an issuer with no
safe way to fetch a document must not advertise `client_id_metadata_document_supported`.

## Per-client theming

The hosted pages (`/login`, `/signup`, `/consent`) are styled **per relying party**: the
client that sent someone here decides how the screens look, through a `theme` object in its
own `metadata` — the free-form column the registry already has, written by the existing
admin PATCH, so there is no second write path and no migration. The vocabulary is
deliberately Clerk-shaped (`colorPrimary`, `colorBackground`, `borderRadius`, `logoUrl`,
`title`, …); `src/branding.ts` defines and sanitizes it, and each key maps onto one CSS
custom property in the SPA's `tokens.css`. The dashboard's client editor exposes the common
keys as an **Appearance** section; the rest ride in the metadata JSON.

The public read (`GET /api/branding?client_id=…`, `/__branding` in the DO) returns **only**
the sanitized theme — never the client's name, icon or existence. Unknown, disabled and
unthemed clients all answer `{ theme: {} }` byte-identically, so the endpoint cannot become
the registry-enumeration oracle that `public-client-prelogin`'s signed-query gate exists to
prevent; naming the application stays that endpoint's job. Values are validated key by key
on the way out (hex colors, a bounded px radius, https/data-image logo URLs), because they
land in CSS custom properties and an `<img src>` on the most security-sensitive origin this
demo owns — and a typo in one color drops that color, not the whole theme.

## Storage

One **Durable Object** (`AuthServerDO`) is the whole store — a single global issuer addressed
by a fixed name, running Better Auth over its own SQLite, generating and persisting its own
signing secret. The Node dev server mirrors it over a local better-sqlite3 file using the exact
same `buildAuth` config.

The schema is **generated** from Better Auth's own table declarations
(`scripts/gen-schema.mts` → `db/ddl.generated.ts` + `src/auth-schema.generated.ts`), because
the DDL, the Drizzle schema and what the library expects are three copies of one fact and a
hand-kept copy drifts silently — into a runtime error, inside a Durable Object.
`test/schema-generated.test.ts` re-emits and compares, and then executes the DDL against a
real database and asserts the adapter can write through it.

Neither store runs migrations; both are created from `CREATE TABLE IF NOT EXISTS` on boot,
which cannot fix a table whose SHAPE changed. `db/upgrade.ts` handles the two places where
1.7 does exactly that — `account` gained a required `issuer` column (backfilled: these are
user credentials), and `oauth_access_token` / `oauth_consent` are reused names with new
columns (renamed to `legacy_*`, not dropped). Relying parties must be re-registered after an
upgrade; the old rows stay readable under `legacy_*`.

## Running it

```
pnpm --filter @substrat-run/demo-auth-server dev      # Node: API :8877 + admin SPA :5277
pnpm --filter @substrat-run/demo-auth-server cf:dev    # real workerd (single DO)
pnpm --filter @substrat-run/demo-auth-server test      # scenario
```

Seeded dev admin: `admin@auth.test` / `admin-demo-pass`. Demo relying party:
`client_id=substrat-demo-rp`, redirect `http://localhost:5279/callback`.
