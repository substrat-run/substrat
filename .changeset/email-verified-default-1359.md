---
'@substrat-run/oidc-rp': minor
'@substrat-run/control-plane': minor
'@substrat-run/dashboard': minor
'@substrat-run/builder': minor
---

An email address counts as an identifier only when the issuer verified it, and this is now the default (#1359).

- New in `@substrat-run/oidc-rp`: `identifyEmail(env, user)`. It returns `{ email }` when `emailVerified` is `true`. Otherwise it returns `{ email: null, refused }`, where `refused` is `'unverified'` (the issuer said `false`), `'unasserted'` (no claim) or `'no-email'`. `emailRefusalMessage(refused)` gives the sentence to show the person.
- The Console's staff roster, the builder studio's staff check, and the Dashboard's invite accept, owner-row heal and support identity all use `identifyEmail`. They need no configuration.
- A sign-in whose address is refused still works. It just isn't anyone by address. The control plane's 401 now says why: "sign in again" for a session that carries no claim, and "verify your address" for one the issuer marked unverified.
- `OIDC_REQUIRE_EMAIL_VERIFIED` is removed, since the rule it switched on is now the default. The only way to turn it off is `OIDC_ALLOW_UNVERIFIED_EMAIL="true"`, a deployment-wide variable. While it is set, every isolate logs a warning and every admitted address is logged by `sub`.
- The CLI login broker now carries `email_verified` into the session it gives the CLI. Before this, a CLI session never had the claim.
- Sessions signed in before the claim existed carry none, so they are refused until the person signs in again. Sessions last at most seven days.
