# @substrat-run/demo-auth-server

## 0.2.45

### Patch Changes

- 9386282: feat(auth-server): implement the platform's data verbs — `/internal/export` dumps an instance in full and `/internal/delete-scope` wipes one (#590)

  The standalone auth-server answered 501 to both, so the console's retire-with-backup (#493) always refused, wipes stranded storage on the script, and a data-carrying `rebindScopeVertical` could not move an install between lineages. The dump is deliberately unredacted — it exists to rebuild the issuer elsewhere, and the control-plane route in front is the gate, the auditor, and the default masker.

  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0

## 0.2.44

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.2.43

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.2.42

### Patch Changes

- b838410: feat(auth-server): the issuer derives itself from the request hostname — `PUBLIC_ORIGIN` becomes an optional pin

  `PUBLIC_ORIGIN` was `required: true`, so installing the auth server forced the operator to
  type an origin — and a typo'd or not-yet-routable custom domain (no DNS record) made
  discovery advertise an issuer that doesn't route anywhere. Client registration against it
  then failed with Cloudflare 530 / error 1016, attributed to the wrong hostname.

  The runtime already derived the issuer per request (`cfg.PUBLIC_ORIGIN ?? origin`), so the
  declaration now matches it: blank is the default and the issuer answers as whatever
  hostname the router bound to it (platform mint or custom domain), which keeps OIDC
  discovery self-consistent on every door — the spec requires the advertised `issuer` to
  equal the URL discovery was fetched from. Set the pin only when the request origin can't
  be trusted (standalone behind a rewriting proxy).

## 0.2.41

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.2.40

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.2.39

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.2.38

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.2.37

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.2.36

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.2.35

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.2.34

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.2.33

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.2.32

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/adapter-email@0.2.0

## 0.2.31

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.2.30

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.2.29

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.2.28

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.2.27

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.2.26

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.2.25

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.2.24

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.2.23

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.2.22

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.2.21

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.2.20

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.2.19

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.2.18

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.2.17

### Patch Changes

- 99af6b6: Add `resolveScopedEnvSpec` — read a hosted instance's delivered per-scope config overlaid on its envSpec defaults

  A hosted vertical's per-install settings (saved in the dashboard Env tab, delivered via
  `/internal/configure`) land in the scope's own storage, not in worker bindings. Env-spec
  `default:` values ride as worker bindings shared by every install of one serving script, so
  `resolveEnvSpec(env)` can only ever return the deployment-wide default — a vertical that reads
  it silently ignores a saved per-install override.

  `resolveScopedEnvSpec(spec, raw, delivered)` is the pure merge that fixes that: precedence
  **delivered > env > default**, declared keys only (the manifest stays the allow-list), an empty
  delivered value is not an override, and `missingRequired` is recomputed over the overlaid values.
  It stays dependency-free; each vertical supplies `delivered` from its own per-scope store.
  `resolveEnvSpec` is documented as deployment/defaults-only, and auth-server's `effectiveCfg` now
  uses the shared helper instead of a hand-rolled overlay.

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.2.16

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.2.15

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.2.14

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.2.13

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.2.12

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.2.11

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.2.10

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.2.9

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.2.8

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.2.7

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.2.6

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.2.5

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.2.4

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.2.3

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.2.2

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.2.1

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.2.0

### Minor Changes

- 7ed3015: The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

  **auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
  `GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
  database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
  Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
  password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
  issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
  such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
  counts stay readable.

  **control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
  (status + message) instead of collapsing it into the generic 500 "internal error". A
  vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
  dashboard as itself; routes that already hand-caught it are unchanged.

- d93e690: Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.1.1

### Patch Changes

- 1cbc2be: Declare the auth-server's config surface in `package.json` `substrat.envSpec` (mirroring the
  runtime `AUTH_SERVER_ENV`), so `substrat push` carries it to the registry and the dashboard
  renders a settings form: `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (secret),
  `EMAIL_FROM`. A drift-guard test fails the build if the JSON and the TS spec ever diverge, so
  the form and what the issuer actually reads can't disagree.

  The Grafana-style first-admin bootstrap already existed (`ADMIN_EMAIL` + `ADMIN_PASSWORD`
  seed the admin deterministically on init — no "first to sign in wins" race); this just makes
  it configurable from the dashboard. No insecure `admin/admin` default — unset creds fall back
  to the setup screen.

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
