# Auth Server — a standalone Better Auth OIDC provider

## What it is

A self-contained **identity provider** you can host on its own and point any OIDC-compatible
application at — inside Substrat or outside it. It is Better Auth, configured as an OIDC
issuer, with three plugins doing the work:

- **`jwt`** — asymmetric signing keys (EdDSA/RS256), served as JWKS. Relying parties verify
  id_tokens from the public key alone; there is no shared secret to distribute.
- **`oidcProvider`** — the OIDC surface: discovery, `/authorize`, `/token`, `/userinfo`,
  consent, and a client registry (with optional dynamic registration).
- **`admin`** — user management (list / create / ban / role / impersonate) and the `admin`
  role the dashboard gates on.

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

## Running it

```
pnpm --filter @substrat-run/demo-auth-server dev      # Node: API :8877 + admin SPA :5277
pnpm --filter @substrat-run/demo-auth-server cf:dev    # real workerd (single DO)
pnpm --filter @substrat-run/demo-auth-server test      # scenario
```

Seeded dev admin: `admin@auth.test` / `admin-demo-pass`. Demo relying party:
`client_id=substrat-demo-rp`, redirect `http://localhost:5279/callback`.
