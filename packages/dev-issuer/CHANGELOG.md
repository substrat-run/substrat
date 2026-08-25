# @substrat-run/dev-issuer

## 0.1.2

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [6d71731]
- Updated dependencies [7cce6cd]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/vertical-auth@0.8.1

## 0.1.1

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.1.0

### Minor Changes

- ae4e894: New package: a local OpenID Connect provider you sign into by picking a name

  `@substrat-run/dev-issuer` is a real OP — discovery, JWKS, Authorization Code + PKCE, a
  signed ID token with `nonce`, RP-initiated logout — whose single shortcut is that
  `/authorize` renders a list of people instead of a password field. It exists so a vertical
  needs no dev-only auth branch: local login is the production round-trip, and pointing at a
  real issuer is a change of `OIDC_ISSUER`.

  It is stateless (the authorization code is a short-lived JWT, so there is no code store and
  no SSO cookie — the picker appears on every `/authorize`, which is what makes switching user
  one click). `POST /dev/token {sub}` mints tokens without a browser for tests and headless
  scripts: impersonation lives here, in a process that binds to localhost and is never
  deployed, rather than behind a flag in the deployable.

  Also exports `devLogin`, the relying-party half a dev server mounts — `/api/auth/*` plus
  `sub` → principal through the identity directory.

  **Never deploy it.** Its signing key is checked in and public, deliberately, so that tokens
  survive a restart. Nothing but a loopback relying party may trust it.

### Patch Changes

- Updated dependencies [ae4e894]
  - @substrat-run/vertical-auth@0.8.0
  - @substrat-run/contracts@0.86.0
