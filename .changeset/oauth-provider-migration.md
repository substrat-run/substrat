---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/vertical-auth': patch
'@substrat-run/demo-rally': patch
'@substrat-run/demo-handlebar': patch
'@substrat-run/demo-shop': patch
---

auth-server: migrate to `@better-auth/oauth-provider`, and bump the fleet to Better Auth 1.7

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
  as `oauth_query`. A sign-in that omits it succeeds and resumes *nothing* — #898's symptom
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
