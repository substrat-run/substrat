# @substrat-run/dev-issuer

## 0.2.2

### Patch Changes

- @substrat-run/contracts@0.120.0
- @substrat-run/vertical-auth@0.15.2

## 0.2.1

### Patch Changes

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0
  - @substrat-run/vertical-auth@0.15.1

## 0.2.0

### Minor Changes

- 030fafd: A vertical bound to a team auth server accepts only bearer tokens minted for it.

  Before, when no `audience` was configured, the relying party's bearer fallback checked only the token's signature and issuer. Every app on a team auth server shares that issuer, and so does any client that registers itself there. So on every route, a vertical accepted another app's `id_token` and an access token requested for another vertical's MCP endpoint. Cookie sessions were never affected.

  Now, when the delivered config marks the issuer as shared (`substrat:auth:shared-issuer` = `"true"`, exported as `SHARED_ISSUER_CONFIG_KEY` from `@substrat-run/contracts`), a bearer is accepted only if it is the app's own:

  - its `aud` names the app's MCP resource on the origin the request reached (`mcpResourceOf`). That is an MCP client's access token, whatever client requested it.
  - its `azp` / `client_id` is the app's client id. Every one that is present must match.
  - it has neither claim, and its `aud` is exactly the app's client id. That is the app's own `id_token`. A multi-valued `aud` with no `azp` is refused.

  Anything else is a `401`. A configured `audience` still wins, as before. `oidcRpAuthProvider` takes the marker as `sharedIssuer`, and `instanceAuthFor` reads it from the delivered config. `AuthProvider.resolve` takes an optional second argument, the request URL. A caller that omits it (every existing one) gets the origin from the `Host` header.

  **Issuers you configured by hand are unchanged.** Supabase, Auth0, Keycloak and the like carry no marker, and their bearers are checked exactly as before. To hold them to one audience, set the connection's `audience` (`authenticated` for a Supabase access token, the API identifier at Auth0).

  The dashboard delivers the marker beside `substrat:auth` at install and on an Identity change. The issuer decides whether it is shared, not the part of the form it was picked from, so a hand-typed issuer URL that is one of the team's auth servers is marked too. The same classification runs at install, on an Identity change and in the heal. Apps installed before this get it the next time anyone on the team opens the Apps list, from the same pass that registers their MCP endpoint. That pass retries on later loads until the marker lands. It also retries while one of the team's auth servers cannot be located, so apps bound to it are never mistaken for apps on an outside issuer. Every delivery it could not make is logged, marker failures included. On a team with no auth server left, it clears the marker from every app that still carries it. An existing install is protected once both halves are live: this dashboard, and a deploy of the vertical built against this `vertical-auth`.

  The dev issuer's `/dev/token` now mints for `substrat-dev` by default, the client `devLogin` signs in as (it was `dev`), and `devLogin` applies the team rule, so a script that works locally works hosted. A script that passed `audience: 'dev'` explicitly, or that points `devLogin` at another client id with `OIDC_CLIENT_ID`, must now mint for that client id. `DEV_CLIENT_ID` is exported.

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/vertical-auth@0.15.0
  - @substrat-run/contracts@0.118.0

## 0.1.32

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0
  - @substrat-run/vertical-auth@0.14.6

## 0.1.31

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0
  - @substrat-run/vertical-auth@0.14.5

## 0.1.30

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0
  - @substrat-run/vertical-auth@0.14.4

## 0.1.29

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0
  - @substrat-run/vertical-auth@0.14.3

## 0.1.28

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0
  - @substrat-run/vertical-auth@0.14.2

## 0.1.27

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0
  - @substrat-run/vertical-auth@0.14.1

## 0.1.26

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
- Updated dependencies [d40a1f7]
  - @substrat-run/contracts@0.111.0
  - @substrat-run/vertical-auth@0.14.0

## 0.1.25

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0
  - @substrat-run/vertical-auth@0.13.2

## 0.1.24

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
- Updated dependencies [c22e0f3]
  - @substrat-run/contracts@0.109.0
  - @substrat-run/vertical-auth@0.13.1

## 0.1.23

### Patch Changes

- Updated dependencies [aab2e11]
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/vertical-auth@0.13.0
  - @substrat-run/contracts@0.108.0

## 0.1.22

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0
  - @substrat-run/vertical-auth@0.12.10

## 0.1.21

### Patch Changes

- @substrat-run/contracts@0.106.0
- @substrat-run/vertical-auth@0.12.9

## 0.1.20

### Patch Changes

- @substrat-run/contracts@0.105.0
- @substrat-run/vertical-auth@0.12.8

## 0.1.19

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0
  - @substrat-run/vertical-auth@0.12.7

## 0.1.18

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0
  - @substrat-run/vertical-auth@0.12.6

## 0.1.17

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0
  - @substrat-run/vertical-auth@0.12.5

## 0.1.16

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0
  - @substrat-run/vertical-auth@0.12.4

## 0.1.15

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0
  - @substrat-run/vertical-auth@0.12.3

## 0.1.14

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0
  - @substrat-run/vertical-auth@0.12.2

## 0.1.13

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0
  - @substrat-run/vertical-auth@0.12.1

## 0.1.12

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/vertical-auth@0.12.0
  - @substrat-run/contracts@0.97.0

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
