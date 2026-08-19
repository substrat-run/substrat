# @substrat-run/demo-hr

## 0.5.11

### Patch Changes

- Updated dependencies [89c2113]
- Updated dependencies [20818ce]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/adapter-cloudflare@0.75.0
  - @substrat-run/vertical-host@0.75.0
  - @substrat-run/connector-scrive@0.11.2
  - @substrat-run/engine-absence@0.3.2
  - @substrat-run/engine-protocol@0.9.2
  - @substrat-run/control-plane-api@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.5.10

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/vertical-host@0.74.0
  - @substrat-run/connector-scrive@0.11.1
  - @substrat-run/engine-absence@0.3.1
  - @substrat-run/engine-protocol@0.9.1
  - @substrat-run/adapter-cloudflare@0.74.0
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/control-plane-api@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.5.9

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-protocol@0.9.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-absence@0.3.0
  - @substrat-run/connector-scrive@0.11.0
  - @substrat-run/adapter-cloudflare@0.73.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/control-plane-api@0.73.0
  - @substrat-run/kernel@0.73.0
  - @substrat-run/vertical-host@0.73.0

## 0.5.8

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-sqlite@0.72.0
  - @substrat-run/adapter-cloudflare@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/vertical-host@0.72.0
  - @substrat-run/engine-protocol@0.8.0
  - @substrat-run/control-plane-api@0.72.0
  - @substrat-run/connector-scrive@0.10.0
  - @substrat-run/engine-absence@0.2.3

## 0.5.7

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/connector-scrive@0.9.3
  - @substrat-run/engine-absence@0.2.2
  - @substrat-run/engine-protocol@0.7.3
  - @substrat-run/adapter-cloudflare@0.71.0
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/control-plane-api@0.71.0
  - @substrat-run/kernel@0.71.0
  - @substrat-run/vertical-host@0.71.0

## 0.5.6

### Patch Changes

- ef4a747: The four demos that predate the model phase declare their entities.

  Every demo now has a registry and a checked-in `model.json`; `lint:model` covers
  six models instead of two. Entity names in `attachmentTargets` and relation edges
  are checked, and local `entityRelations` are DERIVED from the entities' own
  `parents` rather than written twice — shop's `variant → product` and
  `order → customer` both fall out of the declaration.

  Cross-engine edges are checked too, now that every engine exports a registry:
  meridian's `protocol → employee` against engine-protocol, rally's
  `reservation → member` against engine-booking.

  This is the entity half only. Declaring each demo's operations is a much larger
  piece — meridian alone has ~20 — and its main payoff (declared returns for a
  lane fork) is not needed yet.

  Two things worth recording, both found by doing this rather than assuming:

  **Meridian emits about an entity with no table.** `payroll-run` is an entity type
  with an id minted at emit time and no row anywhere — an event about an
  occurrence, not a stored thing. `EntityDef` requires a table, so the registry
  cannot describe it. Harmless for the entity half; it will bite when operations
  are declared, because `emits.entity` is checked against the registry.

  **Manyfold creates tables at runtime.** A content type builds its own `ct_<key>`
  table when it is defined, so those names do not exist at build time and a
  registry keyed by static table names has nothing to say about them. They are also
  not entities: the ENTRY is the thing, and its typed fields live in its `ct_` row.

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/connector-scrive@0.9.2
  - @substrat-run/engine-absence@0.2.1
  - @substrat-run/engine-protocol@0.7.2
  - @substrat-run/adapter-cloudflare@0.70.0
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/control-plane-api@0.70.0
  - @substrat-run/kernel@0.70.0
  - @substrat-run/vertical-host@0.70.0

## 0.5.5

### Patch Changes

- Updated dependencies [17a82ec]
- Updated dependencies [eddd3c5]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-absence@0.2.0
  - @substrat-run/connector-scrive@0.9.1
  - @substrat-run/engine-protocol@0.7.1
  - @substrat-run/adapter-cloudflare@0.69.0
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/control-plane-api@0.69.0
  - @substrat-run/kernel@0.69.0
  - @substrat-run/vertical-host@0.69.0

## 0.5.4

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [701de69]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/engine-protocol@0.7.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/adapter-cloudflare@0.68.0
  - @substrat-run/vertical-host@0.68.0
  - @substrat-run/control-plane-api@0.68.0
  - @substrat-run/connector-scrive@0.9.0
  - @substrat-run/engine-absence@0.1.3

## 0.5.3

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [c8f665c]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/connector-scrive@0.8.2
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-absence@0.1.2
  - @substrat-run/engine-protocol@0.6.3
  - @substrat-run/adapter-cloudflare@0.67.0
  - @substrat-run/adapter-sqlite@0.67.0
  - @substrat-run/control-plane-api@0.67.0
  - @substrat-run/vertical-host@0.67.0

## 0.5.2

### Patch Changes

- Updated dependencies [954668b]
- Updated dependencies [2d0a2d0]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/connector-scrive@0.8.1
  - @substrat-run/engine-absence@0.1.1
  - @substrat-run/engine-protocol@0.6.2
  - @substrat-run/control-plane-api@0.66.0
  - @substrat-run/vertical-host@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.5.1

### Patch Changes

- Updated dependencies [edd764c]
  - @substrat-run/connector-scrive@0.8.0

## 0.5.0

### Minor Changes

- 49e8ede: `engine-absence` v0 (#634): the approved-absence ledger, extracted from
  Meridian per its spec's own plan (§5/§5.1) when consumer #2 — Egeryds route
  resource planning — arrived. The engine owns the append-only entry ledger over
  an opaque subject `EntityRef` + vertical-supplied `DataSubjectId`, balance as a
  pure fold, a per-leave-type balance floor (negative floor = förskottssemester),
  the request → approve|reject → cancelled state machine as the only mint for
  `booking`/`reversal` entries, a coverage-only `availability()` read, and the
  #383 stale-request expiry schedule. Leave-type vocabulary, accrual formulas,
  weekends/red days and holiday calendars stay vertical, by design
  (`docs/design/engine-absence.md`; the entry ledger is deliberately
  engine-private, not a kernel primitive — D-A).

  Meridian adopts it in the same change: `0003-absence-to-engine` R5 extraction
  handoff moves `hr_absence_ledger`/`hr_leave_requests` into the engine's tables
  (subject = the `('employee', id)` ref, `data_subject_id` = the employee id the
  hr.\* spine already shreds on), the absence operations become compositions of
  the engine's in-scope exports behind the unchanged HTTP surface, and the
  `absence:*` permission keys — same strings as ever — are now declared by the
  engine. The absence events move to the engine's `absence.*` vocabulary, and
  stale-leave expiry is attributed to `{ system: '@substrat-run/engine-absence' }`.

### Patch Changes

- Updated dependencies [49e8ede]
  - @substrat-run/engine-absence@0.1.0

## 0.4.20

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/connector-scrive@0.7.1
  - @substrat-run/engine-protocol@0.6.1
  - @substrat-run/adapter-cloudflare@0.65.0
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/control-plane-api@0.65.0
  - @substrat-run/kernel@0.65.0
  - @substrat-run/vertical-host@0.65.0

## 0.4.19

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [6ac51d1]
- Updated dependencies [6ac51d1]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0
  - @substrat-run/control-plane-api@0.64.0
  - @substrat-run/vertical-host@0.64.0
  - @substrat-run/connector-scrive@0.7.0
  - @substrat-run/vertical-auth@0.7.0
  - @substrat-run/engine-protocol@0.6.0

## 0.4.18

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/control-plane-api@0.63.0
  - @substrat-run/connector-scrive@0.6.1
  - @substrat-run/engine-protocol@0.5.21
  - @substrat-run/vertical-host@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.4.17

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/connector-scrive@0.6.0
  - @substrat-run/control-plane-api@0.62.0
  - @substrat-run/engine-protocol@0.5.20
  - @substrat-run/adapter-cloudflare@0.62.0
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0
  - @substrat-run/vertical-host@0.62.0

## 0.4.16

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/connector-scrive@0.5.0
  - @substrat-run/control-plane-api@0.61.0
  - @substrat-run/engine-protocol@0.5.19
  - @substrat-run/adapter-cloudflare@0.61.0
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0
  - @substrat-run/vertical-host@0.61.0

## 0.4.15

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/connector-scrive@0.4.0
  - @substrat-run/control-plane-api@0.60.0
  - @substrat-run/adapter-cloudflare@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-protocol@0.5.18
  - @substrat-run/kernel@0.60.0
  - @substrat-run/vertical-host@0.60.0

## 0.4.14

### Patch Changes

- eda5d01: feat: the dashboard Integrations page becomes real — tenant-scoped connection routes on the control plane, a Scrive connect flow in the app's Settings, and manifest `requires:` driving the "enabled but missing its settings" state

  The control plane grows a tenant-scoped connection surface (`GET/POST /tenants/:t/connections`,
  `DELETE /tenants/:t/connections/:id`) — the POST reuses the §3.5.2 relay's upsert semantics
  (create, or rotate the one live row in place so its grant tuples survive), behind platform-actor
  auth. This is the door the dashboard needed: its own directory holds its GitHub connections, but
  a provider credential a platform-run connector consumes (Scrive) must land in the shared plane's
  store — the one `connector:<provider>` dispatch actually opens.

  The dashboard's Settings → Integrations tab and the account-level Integrations page drop their
  demo fixtures: a vertical declares a provider in its manifest `requires:` (Meridian now declares
  `scrive`), the tab renders it connect-or-"required, not connected", and the connect dialog
  collects the provider's server-declared credential fields (Scrive's OAuth1 four-part), write-only.
  Authorization is the in-scope `dashboard/begin-connection` act (`dashboard:manage-integrations`);
  the credential rides one call to the store that seals it. A declared-but-unconnected provider
  never gates the app — a dispatch with no live connection settles pending and delivers once
  connected. Scrive connections are granted `protocol:record-signature` + `protocol:attach`, so
  both the signature write-back and the sealed-PDF landing work.

- Updated dependencies [1fab6f7]
- Updated dependencies [eda5d01]
  - @substrat-run/control-plane-api@0.59.0
  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0
  - @substrat-run/adapter-sqlite@0.59.0
  - @substrat-run/adapter-cloudflare@0.59.0
  - @substrat-run/vertical-host@0.59.0
  - @substrat-run/connector-scrive@0.3.3
  - @substrat-run/engine-protocol@0.5.17

## 0.4.13

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0
  - @substrat-run/control-plane-api@0.58.0
  - @substrat-run/vertical-host@0.58.0
  - @substrat-run/connector-scrive@0.3.2
  - @substrat-run/engine-protocol@0.5.16

## 0.4.12

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/connector-scrive@0.3.1
  - @substrat-run/engine-protocol@0.5.15
  - @substrat-run/adapter-cloudflare@0.57.0
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/control-plane-api@0.57.0
  - @substrat-run/kernel@0.57.0
  - @substrat-run/vertical-host@0.57.0

## 0.4.11

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [b8bdb9d]
- Updated dependencies [336352b]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/control-plane-api@0.56.0
  - @substrat-run/vertical-host@0.56.0
  - @substrat-run/connector-scrive@0.3.0
  - @substrat-run/engine-protocol@0.5.14

## 0.4.10

### Patch Changes

- Updated dependencies [8cd5039]
- Updated dependencies [512822b]
  - @substrat-run/control-plane-api@0.55.0
  - @substrat-run/contracts@0.55.0
  - @substrat-run/kernel@0.55.0
  - @substrat-run/adapter-sqlite@0.55.0
  - @substrat-run/adapter-cloudflare@0.55.0
  - @substrat-run/vertical-host@0.55.0
  - @substrat-run/connector-scrive@0.2.13
  - @substrat-run/engine-protocol@0.5.13

## 0.4.9

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [a16a3d4]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0
  - @substrat-run/control-plane-api@0.54.0
  - @substrat-run/vertical-host@0.54.0
  - @substrat-run/connector-scrive@0.2.12
  - @substrat-run/engine-protocol@0.5.12

## 0.4.8

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/control-plane-api@0.53.0
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/connector-scrive@0.2.11
  - @substrat-run/engine-protocol@0.5.11
  - @substrat-run/vertical-host@0.53.0

## 0.4.7

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/connector-scrive@0.2.10
  - @substrat-run/engine-protocol@0.5.10
  - @substrat-run/adapter-cloudflare@0.52.0
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/control-plane-api@0.52.0
  - @substrat-run/kernel@0.52.0
  - @substrat-run/vertical-host@0.52.0

## 0.4.6

### Patch Changes

- Updated dependencies [9f28da1]
  - @substrat-run/control-plane-api@0.51.0
  - @substrat-run/contracts@0.51.0
  - @substrat-run/kernel@0.51.0
  - @substrat-run/adapter-sqlite@0.51.0
  - @substrat-run/adapter-cloudflare@0.51.0
  - @substrat-run/vertical-host@0.51.0
  - @substrat-run/connector-scrive@0.2.9
  - @substrat-run/engine-protocol@0.5.9

## 0.4.5

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/control-plane-api@0.50.0
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/connector-scrive@0.2.8
  - @substrat-run/engine-protocol@0.5.8
  - @substrat-run/vertical-host@0.50.0

## 0.4.4

### Patch Changes

- Updated dependencies [5ad59c5]
- Updated dependencies [a13c8fb]
- Updated dependencies [00ff102]
- Updated dependencies [f11a961]
- Updated dependencies [9c7987b]
  - @substrat-run/control-plane-api@0.49.0
  - @substrat-run/contracts@0.49.0
  - @substrat-run/connector-scrive@0.2.7
  - @substrat-run/engine-protocol@0.5.7
  - @substrat-run/adapter-cloudflare@0.49.0
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0
  - @substrat-run/vertical-host@0.49.0

## 0.4.3

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0
  - @substrat-run/control-plane-api@0.48.0
  - @substrat-run/connector-scrive@0.2.6
  - @substrat-run/engine-protocol@0.5.6
  - @substrat-run/vertical-host@0.48.0

## 0.4.2

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/control-plane-api@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/connector-scrive@0.2.5
  - @substrat-run/engine-protocol@0.5.5
  - @substrat-run/vertical-host@0.47.0

## 0.4.1

### Patch Changes

- Updated dependencies [b94f735]
- Updated dependencies [54d3d0e]
  - @substrat-run/control-plane-api@0.46.0
  - @substrat-run/vertical-host@0.46.0
  - @substrat-run/contracts@0.46.0
  - @substrat-run/kernel@0.46.0
  - @substrat-run/adapter-sqlite@0.46.0
  - @substrat-run/adapter-cloudflare@0.46.0
  - @substrat-run/connector-scrive@0.2.4
  - @substrat-run/engine-protocol@0.5.4

## 0.4.0

### Minor Changes

- e3f86b0: Demos are OIDC-only: remove the built-in credential store from the verticals

  Meridian, Manyfold, and Callout no longer run their own Better Auth credential
  store. They are pure OIDC relying parties — login, sign-up, password, and reset
  all live at the OIDC issuer (`demos/auth-server`). The vertical only maps the
  authenticated `sub` → a scope principal, and that binding (first-run owner-claim

  - invites in the per-tenant `IdentityDO`) is kept: it is provider-agnostic authZ,
    not credentials.

  * **meridian** — `oidcRpAuthProvider` is the sole provider; the builtin branch,
    `/api/auth-mode` split, first-run sign-up gate, dev Better-Auth store, and the
    email/password SPA are removed. Dev authenticates with the `x-principal` persona
    picker.
  * **manyfold** — gains `oidcRpAuthProvider` (it had only the bearer verifier),
    async `authProviderFor` reading the delivered `substrat:auth`; builtin removed;
    the site registry is preserved; dev on a default persona.
  * **callout** — converged onto the sandbox-clean `IdentityDO` shape: dropped the
    shared `AUTH_DB` D1 binding and Better Auth, adopted the `IdentityDO` +
    `oidcRpAuthProvider`, and replaced the TOFU auto-mint with owner-claim + invites.

  `packages/vertical-auth` is unchanged, so the production verticals that depend on
  it are unaffected. Better Auth now lives only in `demos/auth-server` (the issuer)
  and the Node-only demos (shop/rally/handlebar). Design: `docs/design/oidc-only-demos.md`.

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0
  - @substrat-run/control-plane-api@0.45.0
  - @substrat-run/connector-scrive@0.2.3
  - @substrat-run/engine-protocol@0.5.3
  - @substrat-run/kernel@0.45.0

## 0.3.7

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/control-plane-api@0.44.0
  - @substrat-run/connector-scrive@0.2.2
  - @substrat-run/engine-protocol@0.5.2
  - @substrat-run/contracts@0.44.0

## 0.3.6

### Patch Changes

- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/contracts@0.43.0
  - @substrat-run/kernel@0.43.0
  - @substrat-run/adapter-sqlite@0.43.0
  - @substrat-run/control-plane-api@0.43.0
  - @substrat-run/connector-scrive@0.2.1
  - @substrat-run/engine-protocol@0.5.1

## 0.3.5

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/connector-scrive@0.2.0
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/engine-protocol@0.5.0
  - @substrat-run/control-plane-api@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.3.4

### Patch Changes

- Updated dependencies [653a592]
- Updated dependencies [e9c7bd0]
- Updated dependencies [e3cd3cd]
- Updated dependencies [1f51134]
- Updated dependencies [d222905]
  - @substrat-run/control-plane-api@0.41.0
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/connector-scrive@0.1.31
  - @substrat-run/engine-protocol@0.4.33

## 0.3.3

### Patch Changes

- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/control-plane-api@0.40.0
  - @substrat-run/connector-scrive@0.1.30
  - @substrat-run/engine-protocol@0.4.32

## 0.3.2

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0
  - @substrat-run/control-plane-api@0.39.0
  - @substrat-run/connector-scrive@0.1.29
  - @substrat-run/engine-protocol@0.4.31
  - @substrat-run/kernel@0.39.0

## 0.3.1

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0
  - @substrat-run/control-plane-api@0.38.0
  - @substrat-run/connector-scrive@0.1.28
  - @substrat-run/engine-protocol@0.4.30

## 0.3.0

### Minor Changes

- 1057d15: The demos' `package.json` `substrat` blocks now declare `entitlements` and
  `ownerGrants`, mirroring their builtin catalog entries exactly (#389). A push
  copies these onto the registry row only when present, and nothing derives them
  from `entitlementKey` — so the tenant-owned lineages' rows were landing with
  empty install-spec fields. Production installs were saved by each vertical's
  own `/internal/provision` (which grants the owner and the entitlement itself);
  embedded-mode installs would have left the owner with zero grants. With the
  declarations in place, an install of the pushed lineage carries the same SKU
  flags and day-one owner permissions as the builtin it is replacing.

### Patch Changes

- Updated dependencies [705b806]
- Updated dependencies [8869413]
  - @substrat-run/control-plane-api@0.37.0
  - @substrat-run/contracts@0.37.0
  - @substrat-run/kernel@0.37.0
  - @substrat-run/adapter-sqlite@0.37.0
  - @substrat-run/adapter-cloudflare@0.37.0
  - @substrat-run/connector-scrive@0.1.27
  - @substrat-run/engine-protocol@0.4.29

## 0.2.22

### Patch Changes

- Updated dependencies [3e939b9]
- Updated dependencies [b20cd82]
  - @substrat-run/control-plane-api@0.36.1
  - @substrat-run/vertical-auth@0.6.0
  - @substrat-run/contracts@0.36.1
  - @substrat-run/kernel@0.36.1
  - @substrat-run/adapter-sqlite@0.36.1
  - @substrat-run/adapter-cloudflare@0.36.1

## 0.2.21

### Patch Changes

- Updated dependencies [20343bb]
- Updated dependencies [c8c0624]
  - @substrat-run/control-plane-api@0.36.0
  - @substrat-run/contracts@0.36.0
  - @substrat-run/kernel@0.36.0
  - @substrat-run/adapter-sqlite@0.36.0
  - @substrat-run/adapter-cloudflare@0.36.0
  - @substrat-run/connector-scrive@0.1.26
  - @substrat-run/engine-protocol@0.4.28

## 0.2.20

### Patch Changes

- Updated dependencies [c200778]
- Updated dependencies [17eec41]
  - @substrat-run/control-plane-api@0.35.0
  - @substrat-run/contracts@0.35.0
  - @substrat-run/connector-scrive@0.1.25
  - @substrat-run/engine-protocol@0.4.27
  - @substrat-run/adapter-cloudflare@0.35.0
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.2.19

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0
  - @substrat-run/control-plane-api@0.34.0
  - @substrat-run/connector-scrive@0.1.24
  - @substrat-run/engine-protocol@0.4.26

## 0.2.18

### Patch Changes

- Updated dependencies [0b9220e]
- Updated dependencies [6d3429e]
  - @substrat-run/control-plane-api@0.33.0
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0
  - @substrat-run/connector-scrive@0.1.23
  - @substrat-run/engine-protocol@0.4.25

## 0.2.17

### Patch Changes

- Updated dependencies [c0b3464]
- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/control-plane-api@0.32.0
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0
  - @substrat-run/connector-scrive@0.1.22
  - @substrat-run/engine-protocol@0.4.24

## 0.2.16

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [0d79662]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/control-plane-api@0.31.0
  - @substrat-run/vertical-auth@0.5.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0
  - @substrat-run/connector-scrive@0.1.21
  - @substrat-run/engine-protocol@0.4.23

## 0.2.15

### Patch Changes

- Updated dependencies [ad4ccbf]
- Updated dependencies [49db0a1]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [866c46d]
- Updated dependencies [91a60e2]
  - @substrat-run/vertical-auth@0.4.0
  - @substrat-run/control-plane-api@0.30.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0
  - @substrat-run/connector-scrive@0.1.20
  - @substrat-run/engine-protocol@0.4.22

## 0.2.14

### Patch Changes

- Updated dependencies [a650d52]
- Updated dependencies [c64bdf8]
  - @substrat-run/control-plane-api@0.29.0
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/vertical-auth@0.3.3
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0
  - @substrat-run/adapter-sqlite@0.29.0
  - @substrat-run/connector-scrive@0.1.19
  - @substrat-run/engine-protocol@0.4.21

## 0.2.13

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/control-plane-api@0.28.0
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/vertical-auth@0.3.2
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0
  - @substrat-run/adapter-sqlite@0.28.0
  - @substrat-run/connector-scrive@0.1.18
  - @substrat-run/engine-protocol@0.4.20

## 0.2.12

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0
  - @substrat-run/control-plane-api@0.27.0
  - @substrat-run/connector-scrive@0.1.17
  - @substrat-run/engine-protocol@0.4.19

## 0.2.11

### Patch Changes

- Updated dependencies [2bdd22b]
- Updated dependencies [03839ec]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/control-plane-api@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/vertical-auth@0.3.1
  - @substrat-run/connector-scrive@0.1.16
  - @substrat-run/engine-protocol@0.4.18

## 0.2.10

### Patch Changes

- Updated dependencies [487db9a]
- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/control-plane-api@0.25.0
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0
  - @substrat-run/connector-scrive@0.1.15
  - @substrat-run/engine-protocol@0.4.17

## 0.2.9

### Patch Changes

- 92d1aa1: The platform delivers a tenant's entitlements WITH provisioning, so a dispatched vertical
  projects them (#310) — completing the seam #304 left open.

  #304 projected entitlements into a scope but left the platform→dispatched-vertical path un-wired:
  a freshly provisioned CP-less scope received no entitlements, so its `entitlements_enforced` marker
  stayed off and the gate trusted upstream (only expiry, carried on the row, enforced locally).

  - **`ProvisionInstanceInput` gains `entitlements`**, delivered on the provision payload.
  - **The control-plane gathers them itself** at the single provision choke point
    (`POST /verticals/:slug/instances`) via `admin.listEntitlements` — platform-authoritative, never
    trusting the caller's body. Console and dashboard both route through that endpoint, so one
    injection covers every production path.
  - **The demo verticals (callout, meridian, manyfold)** parse `entitlements` (reusing the
    `entitlementGrant` contract) and hand them to `provisionScopeLocal`, which projects them and flips
    enforcement on.

  Propagation of a later grant/revoke to an already-live dispatched worker **rides a re-provision**
  (the idempotent K-31 call, the same channel role-definition changes use) rather than a new
  push-on-grant fan-out; expiry keeps enforcing locally meanwhile. A dedicated push channel stays
  available if a future SLA needs sub-re-provision revocation latency. Decision D-42.

- d4bf108: Shared login across a scope's surfaces (K-26 multi-surface): a delivered
  `substrat:auth.cookieDomain` sets the session cookie with `Domain=<parent>` instead of
  host-only, so sibling surfaces (`crm.egeryds.se`, `eka.egeryds.se`, …) share one session.
  The signing secret was already per-tenant (DO-minted), so the attribute is the only thing
  that was missing. Both providers honor it — the OIDC relying party directly, Better Auth
  via `advanced.crossSubDomainCookies` (the worker relays the choice to the IdentityDO as a
  header, re-validated there). `resolveCookieDomain` validates the domain against the
  request host where the cookie is set (equal or proper-suffix at a label boundary, no bare
  TLDs); an invalid domain degrades to host-only rather than breaking sign-in. Setting the
  domain cookie also clears the host-only shadow, and logout clears both variants. Meridian
  threads `cookieDomain` through its `authChoice` as the reference wiring.
- f610140: Each demo vertical's declarative surface now lives in its own crisp files instead of being
  embedded at the top of `module.ts`. Open `src/manifest.ts` and you see the _entire_ shape of
  the vertical — permission keys, id/version, events, entity relations, entitlement — with
  nothing executable to wade through; `src/module.ts` is now just operations and the
  `ModuleRegistration` wiring.

  For each of Callout, Meridian, and Manyfold:

  - **`src/manifest.ts`** — the permission-key consts (`SC_PERM`/`HR_PERM`/`MF_PERM`) **and**
    `moduleManifest.parse({...})`. The consts sit beside the manifest's `permissions` list —
    they're the same keys twice — so "add a permission" stays a single-file edit and the pair
    can't drift.
  - **`src/migrations.ts`** — the append-only `SqlMigration[]` journal (Callout's
    `boundary-lint-allow R5` extraction block moved with the migration it guards).
  - **`src/module.ts`** — imports both; holds row types, operations, and the module wiring.

  Each package gains a `./manifest` export subpath so the dashboard catalog reads a vertical's
  permission consts without dragging `seed.ts`'s `node:fs`/SQLite into the Worker bundle
  (`manifest.ts` imports only from `@substrat-run/contracts`). The `new-vertical` skill now
  scaffolds this three-file shape. Pure reorganization — no behavior, schema, or permission
  change (permission snapshots unchanged; all demo + dashboard scenario tests green).

- Updated dependencies [72b1128]
- Updated dependencies [92d1aa1]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [d4bf108]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [d4bf108]
- Updated dependencies [b06730e]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/control-plane-api@0.24.0
  - @substrat-run/vertical-auth@0.3.0
  - @substrat-run/connector-scrive@0.1.14
  - @substrat-run/engine-protocol@0.4.16

## 0.2.8

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/connector-scrive@0.1.13
  - @substrat-run/engine-protocol@0.4.15
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/control-plane-api@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.2.7

### Patch Changes

- bc6d0fa: In-place deploys (#286, K-33): version updates carry scope data forward. Verticals now
  serve from ONE stable dispatch script per vertical — a prod promote re-uploads the
  promoted version's bundle onto that unchanged name (modules read back from the
  per-version archive script, metadata from the version's retained manifest), so scope
  DOs and their data stay put while the code moves, and kernel migrations finally run in
  place. In-place uploads keep existing secrets (`keep_bindings`) and send only the
  DO-class delta, diffed against directory-recorded serving state. Routing is per-scope
  truth (`scopes.servingRef`, COALESCEd over the bound version's ref); new scopes are
  born on the serving script, legacy scopes hop once via the new adopt-serving endpoint
  (export → restore → flip, data-first). Safety net: versions carry a code-only vs
  schema-change signal (migration-digest diff), the scope DO takes a PITR bookmark
  immediately before an upgrade's migration pass, and a new audited, time-boxed rewind
  (`rewindScope`, 24h window unless forced) restores schema and data to that instant.
  New `/internal/bookmarks`, `/internal/rewind` (and Meridian's previously missing
  `/internal/restore`) vertical routes; new `HostAdmin` methods (`verticalServing`,
  `setVerticalServing`, `versionManifest`, `setScopeServingRef`,
  `scopeMigrationBookmarks`, `rewindScope`).
- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/control-plane-api@0.22.0
  - @substrat-run/connector-scrive@0.1.12
  - @substrat-run/engine-protocol@0.4.14

## 0.2.6

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/control-plane-api@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/adapter-sqlite@0.21.0
  - @substrat-run/connector-scrive@0.1.11
  - @substrat-run/engine-protocol@0.4.13

## 0.2.5

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/control-plane-api@0.20.0
  - @substrat-run/connector-scrive@0.1.10
  - @substrat-run/engine-protocol@0.4.12

## 0.2.4

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/connector-scrive@0.1.9
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/control-plane-api@0.19.0
  - @substrat-run/engine-protocol@0.4.11

## 0.2.3

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/control-plane-api@0.18.0
  - @substrat-run/connector-scrive@0.1.8
  - @substrat-run/engine-protocol@0.4.10

## 0.2.2

### Patch Changes

- Updated dependencies [983c06d]
  - @substrat-run/control-plane-api@0.17.0
  - @substrat-run/contracts@0.17.0
  - @substrat-run/kernel@0.17.0
  - @substrat-run/adapter-sqlite@0.17.0
  - @substrat-run/adapter-cloudflare@0.17.0
  - @substrat-run/connector-scrive@0.1.7
  - @substrat-run/engine-protocol@0.4.9

## 0.2.1

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/control-plane-api@0.16.0
  - @substrat-run/connector-scrive@0.1.6
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/vertical-auth@0.2.1

## 0.2.0

### Minor Changes

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

- Updated dependencies [7ed3015]
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/control-plane-api@0.15.0
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/vertical-auth@0.2.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/connector-scrive@0.1.5
  - @substrat-run/engine-protocol@0.4.7

## 0.1.1

### Patch Changes

- a1c7649: **A read-only "Data" tab: browse an app's own database from the dashboard.**

  Cashes in the seam kernel-design §5.4 reserved as the _admin-query RPC_ — a grant "is a
  tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
  read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
  them as a **Data** tab on the app detail view (list tables, page through rows).

  Read-only and table-shaped **by construction**: the caller picks a table from the live
  schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
  forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
  `system` so the UI groups it apart from the vertical's own tables. Every read is audited
  (K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

  **Reaches the data where it actually lives.** One dashboard app = one scope = one
  Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
  it reads directly. In connected/prod the scope's data DO lives in the _vertical's own WfP
  deployment_ (K-31), not the control plane's own (empty-module) scope host — so the
  control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
  (`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
  K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
  reading its own scope DB. The dashboard never emits an empty `200` — a null from the
  platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

  Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
  a shared contract-tests suite), new `contracts` introspection schemas, and
  `/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
  an arbitrary read-only SQL console are deliberately out of scope (fast-follows).

- Updated dependencies [f4ad677]
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/control-plane-api@0.14.0
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/connector-scrive@0.1.3
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/kernel@0.14.0

## 0.1.0

### Minor Changes

- 12acc59: **First-run setup state + invite-only sign-up (Phase 1).** A freshly-provisioned instance
  now has an explicit setup state instead of a bare login: the IdentityDO exposes
  `needsSetup(scopeId)` (the owner seat is still unclaimed), and Meridian uses it to

  - serve a **"Set up your workspace — create the admin account"** screen on first visit
    (`/api/me` returns `{ status: 'needs-setup' }` while unclaimed), instead of a plain
    sign-in that gives no hint the first sign-up becomes the admin; and
  - **close open sign-up once the admin has claimed it** — after first-run, a stranger who
    finds the URL can no longer self-register (`/api/auth/sign-up/email` returns 403). The
    window is exactly "owner unclaimed", so it closes the instant the admin is created.

  The claim itself is unchanged (trust-on-first-use — first completed setup wins). The
  member-invite path (how teammates join after setup) is the Phase 2 follow-up.

- b1af840: **Meridian is installable from the dashboard marketplace, and usable from an empty install.**

  Meridian (the HR vertical) can now be provisioned as an app from the tenant dashboard,
  the same embedded-catalog seam Callout uses, and a freshly-installed (empty) instance
  is set up from zero through a new in-app Admin surface.

  - **Marketplace wiring.** `@substrat-run/demo-meridian` gains a worker-safe `./module`
    export (its domain module + perms only, never the node/better-auth seed), mirroring
    Callout. The dashboard worker bundles `meridianModule` into its `ScopeDO` and adds a
    `meridian` catalog entry — SKU `['meridian', 'protocol']`, owner granted the `hr-admin`
    permission set so the installer can run the app from day one. Meridian is added to the
    frontend marketplace list, vertical metadata, and dev-mock catalog. A new dashboard
    scenario test provisions a real Meridian app and drives `hr/define-leave-type` +
    `hr/create-employee` on the empty scope — the first-run path, proven end to end.

  - **First-run onboarding (the Admin section).** An installed instance starts empty (no
    leave types, people or projects). The app gains an hr-admin-only **Admin** section — a
    first-run setup checklist plus screens to define leave types (with SE/ES statutory
    presets, spec §6), add employees, create projects, and generate the per-period
    **payroll export** (the §7 boundary). Every screen carries proper empty/loading/error
    states and accessible form labels; permission is still checked in the kernel on every
    op, so a non-admin reaching these calls is refused (verified: a manager defining a
    leave type gets `403 permission denied: absence:configure`).

  GDPR employee erasure (spec §8) remains a deliberate follow-up: crypto-shredding is keyed
  off event `piiClass`/`subjectId` at the kernel/lake level, and there is no vertical-callable
  erase primitive yet — a table-only version would look structural without being so, so it is
  left unbuilt rather than faked.

- fa0707c: **Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
  invite-only; this adds the flow that lets teammates in:

  - **IdentityDO** gains an `invite` directory (token _hash_ only) + `createInvite` /
    `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
    invitee's subject to a pre-minted member principal.
  - **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
    of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
    permissions resolve from the scope's own storage (covered by two new workerd tests).
  - **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
    granted at creation, one-time accept link returned, plaintext token never stored);
    `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
    valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
    revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

  Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
  employees (HR records) remain separate.

- e774c01: **Meridian is reshaped into a sandbox-clean, control-plane-less worker — the shape a vertical must have to be pushed into the platform's dispatch namespace and provisioned by the shared control plane.**

  Meridian was built as a standalone worker that talked _back_ to the control plane (a
  `ControlPlaneDO`, a `CONTROL_PLANE_SVC` service binding, connected-mode gating, an `ASSETS`
  binding, a Scrive reconcile cron). The production platform provisions verticals through a
  Workers-for-Platforms **dispatch namespace**, and `assertSandboxContract` refuses a
  `CONTROL_PLANE` binding or a service binding to a platform worker — so that shape could never be
  pushed. This converts Meridian to the same sandbox-clean pattern Callout uses:

  - **`worker.ts`** — CP-less: `hostFor` builds `CloudflareScopeHost({ scope })` (no control plane);
    `/internal/provision` sets up only the scope's own state via `provisionScopeLocal` (roles + the
    owner's `hr-admin` at scope level), since the shared plane already wrote the directory row +
    entitlements; permissions evaluate from the scope's own storage; the router asserts the node.
    Dropped: the `ControlPlaneDO`, the connected-mode `assertScopeActive` gating, and the Scrive
    connector + `scheduled()` cron.
  - **CP-less identity** — the vertical's own Better Auth `user.principal_id` column is the
    id→principal directory (new `IdentityDirectory` seam + `0002_principal_binding.sql`); `/internal/link`
    binds a login to the provisioned owner. The node server keeps the central directory.
  - **SPA bundled into the worker** — `scripts/gen-assets.mjs` inlines `app/dist` into
    `src/assets.generated.ts` (gitignored), served by `src/assets.ts`; the `ASSETS` binding is gone.
    gen-assets now writes only on change, so `wrangler dev`'s build hook doesn't loop on its output.
  - **`wrangler.jsonc`** — sandbox-clean: only the `SCOPE` DO + `AUTH_DB`, a `build` step, no service
    binding / cron / `CONTROL_PLANE`.

  Verified on real `workerd` (`wrangler dev`): `GET /` serves the SPA; `/internal/provision` is
  fail-closed (403 without `PLATFORM_SECRET`, 201 with it) and provisions CP-lessly; an authenticated
  `hr/*` invoke by the `hr-admin` owner succeeds on DO SQLite. `wrangler deploy --dry-run` shows only
  `SCOPE` + `AUTH_DB`. All 21 node tests still pass.

  Deploy steps are in `demos/meridian/DEPLOY.md` (create the D1, `substrat push`, admit, promote to
  prod, flip the dashboard catalog's `connected` flag). Known follow-ups for full hosted UX: the SPA's
  `/api/me`/`/api/cast` data contract (still demo-shaped), owner login-linking on first sign-in, and
  Scrive reconcile (no cron on a dispatch worker).

- 6a0e253: **Pluggable, config-selected auth for verticals — a new `@substrat-run/vertical-auth` package, and Meridian on it.**

  Auth is now a config choice behind a small contract, isolated per tenant, with no shared `AUTH_DB`.

  - **`@substrat-run/vertical-auth`** (new): the `AuthProvider` contract (`handle` + `resolve`); an
    OIDC provider (`oidcAuthProvider` — verifies a bearer JWT against the issuer's JWKS, covering
    Supabase, Auth0, AuthHero, Keycloak); and a per-tenant **`IdentityDO`** — Better Auth over
    `drizzle-orm/durable-sqlite` (its own SQLite, one DO per tenant) plus the provider-agnostic
    `sub → principal` directory (`setPendingOwner` / `resolvePrincipal`). Source-exported (`.`,
    `./provider`, `./oidc`).

  - **Meridian** consumes it. The worker picks the provider by config (`AUTH_PROVIDER=better-auth-do`
    default, or `oidc` + `OIDC_ISSUER`/`OIDC_AUDIENCE`); the app never learns which. `/internal/provision`
    seeds the owner seat, and the first login **claims** it (the installer becomes `hr-admin`) —
    provider-agnostically. The shared D1 `AUTH_DB` and its identity directory are gone; `wrangler
--dry-run` shows only the `SCOPE` + `AUTH` (IdentityDO) Durable Objects, so the worker still passes
    the sandbox contract and is pushable to the dispatch namespace.

  Verified on real workerd (Better Auth path): provision → sign-up → invoke claims the owner seat →
  `hr-admin` op succeeds → `/api/me` returns the claimed principal. OIDC verified with jose
  (mint+verify): valid → subject; no token / wrong issuer / expired → null. 21 Meridian node tests pass.

  Follow-ups (see `demos/meridian/DEPLOY.md`): fold the `hr/whoami` shape back into `/api/me` so the
  owner lands on the Admin surface; adopt the package in Callout; remove the now-dead `src/auth.ts` /
  `src/auth-schema.ts`.

### Patch Changes

- 32abe73: **`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

  - **dir** → `.` (the current directory).
  - **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
    `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
    / `Meridian`).
  - **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
    the number (falls back to the package.json version for a slug's first-ever push).

  So `cd demos/meridian && substrat push` replaces
  `substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
  works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.

- 57b1cfe: **The Meridian SPA works for a real single logged-in user, not just the demo cast.**

  The pushed worker returned `/api/me` as `{ principal, via, display }` and had no `/api/cast`, but
  the SPA centres on `{ key, display, role, country, employeeId }` + a persona switcher — so a
  hosted install served an app that couldn't place the user. This closes that data-contract gap
  without committing to any auth model:

  - A new **`hr/whoami`** operation resolves the caller's role hint (`hr-admin` / `manager` /
    `employee` / `none`, by probing their own grants) and linked employee from the scope itself. No
    permission gate — it reveals only the caller's own role + own employee id — and the kernel still
    enforces the real permission on every operation.
  - The worker's **`/api/me`** returns the SPA shape via `hr/whoami`, so a real owner (holding
    `hr-admin`) lands on the admin/setup surface and an employee on their own work — the same shape
    the dev server already serves. **`/api/cast`** returns `[]` (the persona switcher is a dev-only
    affordance).
  - The app **hides the persona switcher** when the cast is empty, so a hosted single-user instance
    shows no demo-character dropdown.

  Verified on real `workerd`: after provision, `/api/me` as the owner returns
  `{ role: "hr-admin", employeeId: null }` and lands the admin surface; an employee (created with a
  `principalRef`) resolves to `{ role: "employee", employeeId: … }`; `/api/cast` is `[]`. 21 node
  tests pass. Note: this does not change how identity is resolved (still Better Auth CP-less / the dev
  header) — the auth-model decision (per-vertical vs. shared OIDC) is deliberately left open.

- cfbcc6c: **Sign-in / sign-up screen for hosted Meridian.** A deployed instance returned 401 from `/api/me`
  with no way to authenticate (production has no persona switcher), so users just saw "unauthorized".
  The app now shows a **SignIn screen** (email + password, sign-in/sign-up) that posts to Better Auth
  (`/api/auth/*` → the tenant's IdentityDO) and reloads on success. The **first sign-in claims the
  owner seat** — the installer becomes `hr-admin` and lands on the Admin/setup surface with their real
  name. `useAppData` now surfaces `unauthorized` (401) distinctly from errors; dev (persona/dev-header)
  is unaffected. Verified on workerd: 401 → sign-up → `/api/me` returns the `hr-admin` shape.
- Updated dependencies [12acc59]
- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
- Updated dependencies [6a0e253]
  - @substrat-run/vertical-auth@0.1.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/connector-scrive@0.1.2
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/control-plane-api@0.13.0

## 0.0.9

### Patch Changes

- 8898133: **Meridian runs on Cloudflare — the full worker port, provisionable from the portal.**

  The first two stages of porting Meridian from its node/SQLite server to a deployable Cloudflare
  Worker, so it can be provisioned dynamically from the control-plane portal like Callout:

  - **Stage 0 — workerd-safe `provision.ts`.** `provisionMeridian`/`MODULES`/`ROLES`/`connectScrive`
    are extracted from the node-only `seed.ts` (which imports `node:fs`/`SqliteScopeHost`) into a
    `ScopeHost`-typed `provision.ts` the worker can import. `seed.ts` re-imports them; all existing
    tests still pass.
  - **Stage 1 — the worker.** `src/worker.ts`: `defineScopeDO(MODULES)`, `hostFor` (modules +
    `registerScriveConnector` + a `SecretBox` when Scrive is configured), `POST /internal/provision`
    (`assertPlatformCall` → `provisionMeridian`, the K-31 handshake), a generic `/api/invoke`
    (dev-header auth for now), and a **`scheduled()` Cron handler running `runPlatformSweep`** — the
    poll-path timer the node runtime got from `setInterval` (#96), with no Callout precedent. Plus
    `tsconfig.worker.json`, `wrangler.jsonc` (DO bindings, migrations, cron), and the
    `adapter-cloudflare` + `@cloudflare/workers-types` deps.

  Verified on real `workerd` (`wrangler dev`): fail-closed provisioning (403 without the platform
  secret), provision (201), `hr/define-leave-type` + `hr/create-employee` + `protocol/list-templates`
  (200) on DO SQLite, and the scheduled sweep (200).

  The port also surfaced a real DO-portability bug: `hr_absence_ledger`'s `0001-init` had an inline
  comment containing a semicolon, which the CF adapter's naive migration `split(';')` truncated
  ("incomplete input") — better-sqlite3 exec'd the whole blob on node and never showed it. The
  comment is de-semicoloned here; the adapter splitter fragility (and the adapter divergence behind
  it) is filed for a separate fix + contract test.

  **Stage 2 — Better Auth on D1.** End-user identity/credentials/sessions in a Cloudflare D1
  (`AUTH_DB`) via `drizzle-orm/d1` (`auth.ts` — the workerd twin of the node `auth-node.ts`), with
  `auth-schema.ts` + `migrations/0001_better_auth.sql`. The worker mounts `/api/auth/*` and resolves
  each request through Meridian's existing runtime-agnostic `betterAuthAdapter` (session →
  `resolveIdentity` → `PrincipalId`), falling back to the gated dev-header. An authenticated user
  with no linked identity resolves to nobody; `POST /internal/link` (platform-gated) binds a login
  to a principal — how a provisioned instance's owner becomes usable. Verified end to end on real
  `workerd`: provision → sign-up → unlinked session 401 → link → the session resolves to the owner
  `via: better-auth` → an authenticated `hr/*` invoke succeeds on DO SQLite.

  **Stage 3 — connected mode (portal + router wiring).** The worker now reaches the SHARED control
  plane over HTTP (`ControlPlaneClient` via `CONTROL_PLANE_URL` + a `CONTROL_PLANE_SVC` service
  binding), and gates every request on `assertScopeActive(tenant, scope)` — so a suspend in the
  portal's console fails Meridian's next request closed across the deployment boundary. Guarded by
  `STANDALONE`, so `wrangler dev` and a single-tenant box stay self-contained (no gating on a plane
  that isn't running — verified: provision + invoke still 200 in standalone). The `/internal/provision`
  handshake (Stage 1) is what the portal's create-instance flow calls. Adds the
  `@substrat-run/control-plane-api` dep.

  The router/control-plane `VERTICAL_MERIDIAN` service bindings are deliberately **not** added here:
  per those configs' own comments, a vertical is bound only once its worker exists, "rather than
  dangling a binding to a service that does not exist." They are deploy steps, in order:

  1. Create the D1 + apply auth migration, `wrangler secret put` PLATFORM_SECRET / ROUTER_SECRET /
     SERVICE_TOKEN (matching the control plane's + router's), then `pnpm cf:deploy` this worker.
  2. Add `VERTICAL_MERIDIAN → substrat-meridian` to `apps/control-plane/wrangler.jsonc` (+ its
     matching `PLATFORM_SECRET`) and `apps/router/wrangler.jsonc` (+ `ROUTER_SECRET`), and redeploy
     both. The console's create-instance flow then provisions Meridian instances, and the router
     fronts them by bound hostname.

  **Stage 4 — the SPA.** The employee app (`app/dist`) is served from the same origin via an
  `assets` binding with `run_worker_first` + single-page-application fallback; the worker owns
  `/api/*` and `/internal/*`, everything else falls through to the SPA. `cf:dev`/`cf:deploy` build
  the app first. Verified on `workerd`: `GET /` serves the app, a client route falls back to
  `index.html` (200), and `/internal/provision` + `/api/invoke` stay worker-owned.

  The port is complete on the code side (Stages 0-4, each verified on real `workerd`): provisioning
  handshake, the Scrive connector + a `scheduled()` Cron sweep, Better Auth on D1, connected-mode
  lifecycle gating, and the SPA. What remains is purely deployment — create the D1, set the secrets,
  `cf:deploy`, and add the `VERTICAL_MERIDIAN` router/control-plane bindings (deploy order above).

- Updated dependencies [05291fa]
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [7070588]
- Updated dependencies [66e752b]
- Updated dependencies [cedaf1a]
- Updated dependencies [097a3aa]
- Updated dependencies [0de890b]
- Updated dependencies [d5a7d5e]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/control-plane-api@0.12.0
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/connector-scrive@0.1.1

## 0.0.8

### Patch Changes

- Updated dependencies [462e8c9]
  - @substrat-run/connector-scrive@0.1.0

## 0.0.7

### Patch Changes

- 0ffb6c8: **Meridian wires the Scrive connector — the reference call site for the poll path (#96 Gate 1).**

  The scheduler driver (`runPlatformSweep` / `startPlatformSweeper`) and the connector's reconcile
  sweep landed with no deployment calling them. Meridian — the vertical whose anställningsavtal is a
  Scrive-signed document — now is that call site:

  - Depends on `@substrat-run/connector-scrive` via `workspace:^` (no npm publish needed to consume
    it in-repo — the whole point: the bundler compiles it in).
  - `buildDemoHost(dir, scrive?)` registers the connector and seals connection credentials with a
    `SecretBox`, opt-in; the default host (every existing test) is unchanged.
  - `connectScrive(host, …)` opens a `(tenant, meridian, scrive)` connection holding ONLY
    `protocol:record-signature` — the #97 grant that lets the reconcile write a signature back as the
    connection itself, not a human role. Scopes now name `vertical: 'meridian'` so a connection can
    reach them.
  - `server.ts` resolves Scrive from the environment (real testbed creds → global fetch; or
    `MERIDIAN_SCRIVE_MOCK=1` → `ScriveMock` with a dev-only sign endpoint), then calls
    `startPlatformSweeper` — the one-line trigger a deployment adds. Off by default: no creds, no
    connection, the contract sits pending, which is honest without a provider.

  Proven end to end: a new test drives issue → dispatch → provider signs → `runPlatformSweep` →
  instance `signed`, and the running server does the same over HTTP (`pending_signature` →
  `/api/dev/scrive-sign` → sweeper → `signed`). All 14 existing scenario tests and 3 provision tests
  still pass — the wiring is additive and opt-in.

  This closes Gate 1: with a Scrive account that has BankID/test-signing enabled, the connector now
  completes a signature unattended.

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/connector-scrive@0.0.2
  - @substrat-run/engine-protocol@0.4.2

## 0.0.6

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-protocol@0.4.1

## 0.0.5

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-protocol@0.3.6

## 0.0.3

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-protocol@0.3.5

## 0.0.2

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-protocol@0.3.3
