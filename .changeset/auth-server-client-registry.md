---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
---

auth-server: the applications a client id belongs to are manageable, and sign-up can be opened

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
