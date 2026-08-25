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
