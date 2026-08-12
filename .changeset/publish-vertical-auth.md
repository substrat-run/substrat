---
"@substrat-run/vertical-auth": minor
"@substrat-run/oidc-rp": minor
---

feat: verticals built outside this repo can install the auth the starter tells them to use

`create-substrat` scaffolds a vertical whose `/api/*` routes are 401 until real auth is wired
into `authenticatedPrincipal`, and the template comment points the reader at
`@substrat-run/vertical-auth` "for the intended shape". That package was `private: true` and
absent from npm, so the pointer went nowhere: every out-of-repo vertical either hand-rolled the
owner-claim, `sub`→principal and invite-only logic the `IdentityDO` exists to get right, or
copied the source. Both packages are now published.

- **`@substrat-run/vertical-auth` is published**, and ships compiled output like every other
  package here rather than raw `src`. `exports` (root plus the `./provider`, `./oidc` and
  `./oidc-rp-provider` subpaths) resolve to `dist` with declarations; `files` is `["dist"]`.
  The build follows the repo convention — `tsc -p tsconfig.json` for `src`, with the tests
  kept under their own `tsconfig.test.json` so `typecheck` still covers them.
- **`@substrat-run/oidc-rp` is published** as its dependency. Inlining it into `vertical-auth`
  was the alternative and was rejected: the same Authorization-Code + PKCE round-trip and
  session mint/verify authenticate staff, builders and the CLI in the control plane, and
  security-critical code that has to be fixed twice is worse than one more public package.
  Its description no longer claims the platform apps are the only consumers.

No behaviour changes — this is packaging. In-repo consumers (Callout, Meridian, Manyfold)
import from the package root and are unaffected beyond resolving `dist` instead of `src`.
