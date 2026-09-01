# @substrat-run/dev-issuer

## 0.1.11

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0
  - @substrat-run/vertical-auth@0.11.1

## 0.1.10

### Patch Changes

- Updated dependencies [2b53117]
  - @substrat-run/vertical-auth@0.11.0

## 0.1.9

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0
  - @substrat-run/vertical-auth@0.10.1

## 0.1.8

### Patch Changes

- 733469b: These packages' `test/` directories are now typechecked. Nothing they ship changes — the
  build tsconfig already emitted from `src` alone — but their `typecheck` script now compiles
  the tests too, which caught a `vertical-host` test fixture that had drifted from
  `VerticalScopeHost` and stayed green for months.
- Updated dependencies [225bb69]
- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [35147a9]
  - @substrat-run/vertical-auth@0.10.0
  - @substrat-run/contracts@0.94.0

## 0.1.7

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0

## 0.1.6

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0

## 0.1.5

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/vertical-auth@0.9.0
  - @substrat-run/contracts@0.91.0

## 0.1.4

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0

## 0.1.3

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0

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
