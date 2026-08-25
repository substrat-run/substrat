# @substrat-run/demo-rally

## 0.1.0

### Minor Changes

- 537ad93: RallyPoint declares its operation surface, and its ten list reads page

  Rally's isolation IS its narrowed grants: a player's `booking:read` is granted per member
  record and per reservation, never at the scope, precisely so a player cannot read the club's
  book — who holds which court, and who they play with. Eight of rally's checks narrow that way,
  and undeclared they were not merely untested but **undeclarable**: thirty-eight handlers
  registered as `'rally/wallet': walletOp as never` described nothing, and to a compiler
  `ctx.check(BK.read, memberRef(id))` and `ctx.check(BK.read)` are the same (#865/#891).

  `src/operations.ts` declares all thirty-eight, `src/inputs.ts` and `src/schemas.ts` carry the
  shapes they accept and answer, and `test/entity-checks.test.ts` drives the kit over the six
  checks it can reach. All six were already honoured; they are now guarded rather than merely
  correct today.

  `reservation` belongs to **engine-booking**, so three of those checks narrow to an entity the
  engine owns — `defineOperations`' composed-engine parameter is what allows it.

  **Two checks the format cannot state**, declared as what they are:

  - `rally/cancel-subscription` narrows to the member the SUBSCRIPTION row names, and the input
    carries only a subscription id. It declares `resolved`, and the kit reports it as uncovered
    rather than skipping it quietly.
  - `rally/portal-bookings` declares `narrows` — a per-row proof walk, not one entity check.

  `rally/timeline` declares the constant every call site passes for its caller-named
  `entityType`. That is #890, and rally is its fourth instance.

  **Breaking at the operation seam:** declaring an operation means declaring its `output`, and a
  bare-array output with no `paged` beside it is refused (#811). Ten reads now return `Page<T>`.
  `rally/list-members` is the one plain table walk and is kernel-composed; the rest are folds —
  a slot grid derived from opening hours and the engine's free intervals, a partner tally over
  every reservation, a price matrix computed per hour — so the fold runs and the page is taken
  off it. `rally/portal-bookings` filters per ROW, which cannot use `ctx.page` at all: a page of
  20 filtered to 3 is not a page, so it keeps its over-fetch and pages after the walk.

  `rally/played-with` now publishes **`partyRef`**. It was always the tally's own key; it simply
  was not in the answer, and a page needs a unique field to walk. Additive.

  Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
  header (#829), so both front-ends are untouched. The `?all=1` match search is the one place
  that reads entries directly — it merges several clubs into one body, so there is no single
  walk to hand a cursor for.

  Known gap, flagged rather than smuggled in: **most of rally's handlers still do not parse their
  input.** Only the booking pair called `.parse()`; the other thirty-six trusted inline TypeScript
  types. `src/inputs.ts` now writes those shapes down and the compiler holds `idFrom` to them,
  which is what #891 needs — but turning thirty-six trusting handlers into validating ones is a
  behaviour change to a live demo, not a declaration, and belongs in its own change. The same is
  true of the operations `engines/booking` declared in this series.

### Patch Changes

- 537ad93: engine-booking declares its operation surface, and its three list reads page

  Seven of booking's checks narrow to a reservation — `ctx.check(PERM.cancel,
reservationRef(input.reservationId))`. Undeclared, they were not merely untested but
  **undeclarable**: `entityCheckConformanceSuite` derives its behavioural pair from an
  operation's `permission`, and booking had no declared operations to read. To a compiler
  `ctx.check(PERM.cancel, ref)` and `ctx.check(PERM.cancel)` are the same, and the second
  lets anyone holding `booking:cancel` anywhere in the scope cancel anyone's booking. On the
  engine behind a club's court schedule, where a member's whole access to a reservation IS a
  grant on that one row, that is the check worth having a machine verify (#865/#891).

  `src/operations.ts` declares all seventeen, `src/schemas.ts` carries the shapes they accept
  and answer, and `test/entity-checks.test.ts` drives the kit. All seven narrowed checks were
  already honoured; they are now guarded rather than merely correct today.

  **Breaking at the operation seam:** declaring an operation means declaring its `output`, and
  a bare-array output with no `paged` beside it is refused (#811) — so `booking/list`,
  `booking/list-resources` and `booking/availability` now return `Page<T>` rather than `T[]`.

  - `booking/list-resources` is kernel-composed (`paged.over`), sorted by `name` as it shipped.
  - `booking/list` is handler-composed with a cursor on **`id`**. Its window is an overlap test
    (`starts_at < to AND ends_at > from`), which the kernel's equality-only filter vocabulary
    cannot express; and a keyset cursor on `starts_at` would skip and repeat rows wherever two
    reservations share a start, which on a court schedule is every hour. A caller rendering a
    calendar sorts the page it got.
  - `booking/availability` is a computed fold, paged on `startsAt` — its segments are disjoint,
    so that field is unique among them where it is not among reservation rows.

  The **in-scope** `listResources` / `listReservations` / `availability` are unchanged. Those
  are folds a vertical calls inside its own transaction, where the bound is the vertical's;
  #811 is about the invocable endpoint. `listResourcesPage` / `listReservationsPage` /
  `availabilityPage` are the paged siblings the operations use.

  Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
  header (#829), which is what let rally adopt this without changing its API's responses.

  Also: `bookingLifecycles` moved to `src/lifecycle.ts` and now checks itself against the
  declared registry instead of the handler map — the cycle that kept it at the bottom of
  `index.ts` is gone.

- 6d71731: The host parses a declared operation input, so no handler has to

  `OperationShape.input` described itself as _"the SAME Zod object the handler parses"_. Across the
  fleet it mostly was not. Of ~85 declared inputs, 40 were parsed; `demos/rally` declared 32 and
  parsed 2; `demos/shop` declared 14 and parsed none. The declaration was true about the _shape_ —
  the compiler holds `idFrom` and `entityIdFrom` to it — and false about the parsing, which is the
  half that refuses a malformed call (#893).

  **A lint rule was the other candidate and is strictly weaker.** It can ask only whether _some_
  `.parse` appears in a handler body, never whether it is the declared schema, at the boundary,
  before the first read of a field. And it cannot be satisfied at all where the schema is declared
  inline — `demos/callout`, `demos/handlebar` and `demos/todo` declare 25 inputs as
  `input: z.object({…})` with no identifier a handler could name, and the reference implementation
  is one of them.

  So the host parses instead, from the declaration that already produces the manifest, the routes
  and the OpenAPI document:

  ```ts
  export const bookingModule: ModuleRegistration = {
    manifest: bookingManifest,
    operations: OPERATIONS,
    operationInputs: operationInputsOf(bookingOperations),
  };
  ```

  `operationInputsOf` derives name → schema; `ModuleRegistration.operationInputs` carries it; both
  adapters parse before the guards and the handler, outside the transaction. Every path in is
  covered — HTTP, a scenario test, a seed, a schedule — which is why this is not at the HTTP mount:
  parsing there alone would have left the demos' own suites exercising the one route the fix did not
  cover. `mountOperations` already made this argument for the page trio, in those words, and it is
  the argument here.

  A schema declared for an operation the module does not bind is refused at registration: a schema
  on nothing enforces nothing while reading as coverage.

  **Adopted by the four packages #893 named** — `engines/booking`, `demos/rally`, `demos/shop`,
  `demos/meridian`. The rest of the fleet is unchanged and still hand-parses or does not;
  `inputParseContractSuite` is what makes the guarantee portable once they adopt.

  ## Three things the change turned up, none of them predicted

  **1. A paged read invoked in process was handed `undefined`.** `ImplInput` types a paged
  handler's input as `… & PagedInput` with no undefined arm, because the platform supplies the page
  _"whether it declared one or not"_ — and over HTTP that was already true. In process it was not:
  `invoke('booking/list')` with no argument is the ordinary way a test or another operation reads a
  list. The empty page is now materialised in the derived schema rather than each paged handler
  learning to survive `undefined`. A required filter still fails, against `{}` and with a message
  naming the field.

  **2. `entityCheckConformanceSuite` read its fixture at collect time.** The extras a case is driven
  with were spread in the `describe` body, before `beforeAll`. A fixture entry holding a value that
  does not exist yet — rally's spare member, created in `beforeAll` and written into the object the
  kit was handed, which is the documented way to supply an id the harness must make first —
  captured the empty placeholder instead. Nothing said so: case 1 only asserts "was not denied",
  and case 2's permission answer arrived before anything looked at the field. Read per case now.

  **3. Two fixtures had never been valid.** `booking/join`'s conformance `partyRef` was 27
  characters where the declared `dataSubjectId` wants a 26-character ULID, and `demos/shop`'s
  scenario §8 reached an elapsed hold by asking for `holdSeconds: 0` — which the declared input has
  always forbidden (`.positive()`), and which is the exact thing the house rule names instead of
  `manualClock`. §8 now runs on a clock it advances, the way its own sibling `hold-expiry.test.ts`
  already did while criticising it.

  All three are the same finding in different clothes: a value nobody parsed was free to be wrong.

- 7cce6cd: auth-server: migrate to `@better-auth/oauth-provider`, and bump the fleet to Better Auth 1.7

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
    as `oauth_query`. A sign-in that omits it succeeds and resumes _nothing_ — #898's symptom
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

- Updated dependencies [537ad93]
- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/engine-booking@0.6.0
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0
  - @substrat-run/adapter-sqlite@0.88.0
  - @substrat-run/engine-invites@0.4.8
  - @substrat-run/engine-invoicing@0.9.4

## 0.0.84

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/engine-booking@0.5.3
  - @substrat-run/engine-invites@0.4.7
  - @substrat-run/engine-invoicing@0.9.3
  - @substrat-run/adapter-sqlite@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.0.83

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0
- @substrat-run/adapter-sqlite@0.86.0
- @substrat-run/engine-booking@0.5.2
- @substrat-run/engine-invites@0.4.6
- @substrat-run/engine-invoicing@0.9.2

## 0.0.82

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0
- @substrat-run/adapter-sqlite@0.85.0
- @substrat-run/engine-booking@0.5.1
- @substrat-run/engine-invites@0.4.5
- @substrat-run/engine-invoicing@0.9.1

## 0.0.81

### Patch Changes

- Updated dependencies [01547b0]
- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [7548dde]
  - @substrat-run/engine-booking@0.5.0
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-sqlite@0.84.0
  - @substrat-run/engine-invoicing@0.9.0
  - @substrat-run/engine-invites@0.4.4

## 0.0.80

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-sqlite@0.83.0
  - @substrat-run/engine-booking@0.4.3
  - @substrat-run/engine-invites@0.4.3
  - @substrat-run/engine-invoicing@0.8.3

## 0.0.79

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/engine-booking@0.4.2
  - @substrat-run/engine-invites@0.4.2
  - @substrat-run/engine-invoicing@0.8.2
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.0.78

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/engine-booking@0.4.1
  - @substrat-run/engine-invites@0.4.1
  - @substrat-run/engine-invoicing@0.8.1

## 0.0.77

### Patch Changes

- Updated dependencies [f6174fb]
- Updated dependencies [83b0ca3]
  - @substrat-run/engine-booking@0.4.0
  - @substrat-run/engine-invites@0.4.0
  - @substrat-run/engine-invoicing@0.8.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.0.76

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/engine-booking@0.3.6
  - @substrat-run/engine-invites@0.3.6
  - @substrat-run/engine-invoicing@0.7.6
  - @substrat-run/adapter-sqlite@0.79.0

## 0.0.75

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/engine-booking@0.3.5
  - @substrat-run/engine-invites@0.3.5
  - @substrat-run/engine-invoicing@0.7.5
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.0.74

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/engine-booking@0.3.4
  - @substrat-run/engine-invites@0.3.4
  - @substrat-run/engine-invoicing@0.7.4
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.0.73

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-sqlite@0.76.0
- @substrat-run/engine-booking@0.3.3
- @substrat-run/engine-invites@0.3.3
- @substrat-run/engine-invoicing@0.7.3

## 0.0.72

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/engine-booking@0.3.2
  - @substrat-run/engine-invites@0.3.2
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/contracts@0.75.0

## 0.0.71

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/engine-booking@0.3.1
  - @substrat-run/engine-invites@0.3.1
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.0.70

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-booking@0.3.0
  - @substrat-run/engine-invites@0.3.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.0.69

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
  - @substrat-run/contracts@0.72.0
  - @substrat-run/engine-booking@0.2.3
  - @substrat-run/engine-invites@0.2.3
  - @substrat-run/engine-invoicing@0.6.3

## 0.0.68

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/engine-booking@0.2.2
  - @substrat-run/engine-invites@0.2.2
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.0.67

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
  - @substrat-run/engine-booking@0.2.1
  - @substrat-run/engine-invites@0.2.1
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.0.66

### Patch Changes

- Updated dependencies [17a82ec]
- Updated dependencies [eddd3c5]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/engine-booking@0.2.0
  - @substrat-run/engine-invites@0.2.0
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.0.65

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/engine-booking@0.1.63
  - @substrat-run/engine-invites@0.1.13
  - @substrat-run/engine-invoicing@0.5.24

## 0.0.64

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-booking@0.1.62
  - @substrat-run/engine-invites@0.1.12
  - @substrat-run/engine-invoicing@0.5.23
  - @substrat-run/adapter-sqlite@0.67.0

## 0.0.63

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/engine-booking@0.1.61
  - @substrat-run/engine-invites@0.1.11
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/contracts@0.66.0

## 0.0.62

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/engine-booking@0.1.60
  - @substrat-run/engine-invites@0.1.10
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.0.61

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [6ac51d1]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/engine-invites@0.1.9
  - @substrat-run/engine-booking@0.1.59
  - @substrat-run/engine-invoicing@0.5.20

## 0.0.60

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/engine-booking@0.1.58
  - @substrat-run/engine-invites@0.1.8
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/contracts@0.63.0

## 0.0.59

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/engine-booking@0.1.57
  - @substrat-run/engine-invites@0.1.7
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.0.58

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/engine-booking@0.1.56
  - @substrat-run/engine-invites@0.1.6
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.0.57

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-booking@0.1.55
  - @substrat-run/engine-invites@0.1.5
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/kernel@0.60.0

## 0.0.56

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0
- @substrat-run/adapter-sqlite@0.59.0
- @substrat-run/engine-booking@0.1.54
- @substrat-run/engine-invites@0.1.4
- @substrat-run/engine-invoicing@0.5.15

## 0.0.55

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/engine-booking@0.1.53
  - @substrat-run/engine-invites@0.1.3
  - @substrat-run/engine-invoicing@0.5.14

## 0.0.54

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/engine-booking@0.1.52
  - @substrat-run/engine-invites@0.1.2
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.0.53

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/engine-booking@0.1.51
  - @substrat-run/engine-invites@0.1.1
  - @substrat-run/engine-invoicing@0.5.12

## 0.0.52

### Patch Changes

- Updated dependencies [ed7a940]
  - @substrat-run/engine-invites@0.1.0
  - @substrat-run/contracts@0.55.0
  - @substrat-run/kernel@0.55.0
  - @substrat-run/adapter-sqlite@0.55.0
  - @substrat-run/engine-booking@0.1.50
  - @substrat-run/engine-invoicing@0.5.11

## 0.0.51

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/engine-booking@0.1.49
  - @substrat-run/engine-invites@0.0.51
  - @substrat-run/engine-invoicing@0.5.10

## 0.0.50

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/engine-booking@0.1.48
  - @substrat-run/engine-invites@0.0.50
  - @substrat-run/engine-invoicing@0.5.9

## 0.0.49

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/engine-booking@0.1.47
  - @substrat-run/engine-invites@0.0.49
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.0.48

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-sqlite@0.51.0
- @substrat-run/engine-booking@0.1.46
- @substrat-run/engine-invites@0.0.48
- @substrat-run/engine-invoicing@0.5.7

## 0.0.47

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/engine-booking@0.1.45
  - @substrat-run/engine-invites@0.0.47
  - @substrat-run/engine-invoicing@0.5.6

## 0.0.46

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/engine-booking@0.1.44
  - @substrat-run/engine-invites@0.0.46
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.0.45

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/engine-booking@0.1.43
  - @substrat-run/engine-invites@0.0.45
  - @substrat-run/engine-invoicing@0.5.4

## 0.0.44

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/engine-booking@0.1.42
  - @substrat-run/engine-invites@0.0.44
  - @substrat-run/engine-invoicing@0.5.3

## 0.0.43

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
- @substrat-run/adapter-sqlite@0.46.0
- @substrat-run/engine-booking@0.1.41
- @substrat-run/engine-invites@0.0.43
- @substrat-run/engine-invoicing@0.5.2

## 0.0.42

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/engine-booking@0.1.40
  - @substrat-run/engine-invites@0.0.42
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/kernel@0.45.0

## 0.0.41

### Patch Changes

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/engine-booking@0.1.39
  - @substrat-run/engine-invites@0.0.41
  - @substrat-run/contracts@0.44.0

## 0.0.40

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0
- @substrat-run/adapter-sqlite@0.43.0
- @substrat-run/engine-booking@0.1.38
- @substrat-run/engine-invites@0.0.40
- @substrat-run/engine-invoicing@0.4.3

## 0.0.39

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/engine-booking@0.1.37
  - @substrat-run/engine-invites@0.0.39
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/contracts@0.42.0

## 0.0.38

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/engine-booking@0.1.36
  - @substrat-run/engine-invites@0.0.38
  - @substrat-run/engine-invoicing@0.4.1

## 0.0.37

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0
  - @substrat-run/engine-booking@0.1.35
  - @substrat-run/engine-invites@0.0.37

## 0.0.36

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/engine-booking@0.1.34
  - @substrat-run/engine-invites@0.0.36
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.0.35

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/engine-booking@0.1.33
  - @substrat-run/engine-invites@0.0.35
  - @substrat-run/engine-invoicing@0.3.36

## 0.0.34

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0
- @substrat-run/adapter-sqlite@0.37.0
- @substrat-run/engine-booking@0.1.32
- @substrat-run/engine-invites@0.0.34
- @substrat-run/engine-invoicing@0.3.35

## 0.0.33

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-sqlite@0.36.0
- @substrat-run/engine-booking@0.1.31
- @substrat-run/engine-invites@0.0.33
- @substrat-run/engine-invoicing@0.3.34

## 0.0.32

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/engine-booking@0.1.30
  - @substrat-run/engine-invites@0.0.32
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.0.31

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/engine-booking@0.1.29
  - @substrat-run/engine-invites@0.0.31
  - @substrat-run/engine-invoicing@0.3.32

## 0.0.30

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/engine-booking@0.1.28
  - @substrat-run/engine-invites@0.0.30
  - @substrat-run/engine-invoicing@0.3.31

## 0.0.29

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/engine-booking@0.1.27
  - @substrat-run/engine-invites@0.0.29
  - @substrat-run/engine-invoicing@0.3.30

## 0.0.28

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/engine-booking@0.1.26
  - @substrat-run/engine-invites@0.0.28
  - @substrat-run/engine-invoicing@0.3.29

## 0.0.27

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/engine-booking@0.1.25
  - @substrat-run/engine-invites@0.0.27
  - @substrat-run/engine-invoicing@0.3.28

## 0.0.26

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0
- @substrat-run/adapter-sqlite@0.29.0
- @substrat-run/engine-booking@0.1.24
- @substrat-run/engine-invites@0.0.26
- @substrat-run/engine-invoicing@0.3.27

## 0.0.25

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0
- @substrat-run/adapter-sqlite@0.28.0
- @substrat-run/engine-booking@0.1.23
- @substrat-run/engine-invites@0.0.25
- @substrat-run/engine-invoicing@0.3.26

## 0.0.24

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/engine-booking@0.1.22
  - @substrat-run/engine-invites@0.0.24
  - @substrat-run/engine-invoicing@0.3.25

## 0.0.23

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/engine-booking@0.1.21
  - @substrat-run/engine-invites@0.0.23
  - @substrat-run/engine-invoicing@0.3.24

## 0.0.22

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/engine-booking@0.1.20
  - @substrat-run/engine-invites@0.0.22
  - @substrat-run/engine-invoicing@0.3.23

## 0.0.21

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/engine-booking@0.1.19
  - @substrat-run/engine-invites@0.0.21
  - @substrat-run/engine-invoicing@0.3.22

## 0.0.20

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/engine-booking@0.1.18
  - @substrat-run/engine-invites@0.0.20
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.0.19

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/engine-booking@0.1.17
  - @substrat-run/engine-invites@0.0.19
  - @substrat-run/engine-invoicing@0.3.20

## 0.0.18

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0
- @substrat-run/adapter-sqlite@0.21.0
- @substrat-run/engine-booking@0.1.16
- @substrat-run/engine-invites@0.0.18
- @substrat-run/engine-invoicing@0.3.19

## 0.0.17

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/engine-booking@0.1.15
  - @substrat-run/engine-invites@0.0.17
  - @substrat-run/engine-invoicing@0.3.18

## 0.0.16

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/engine-booking@0.1.14
  - @substrat-run/engine-invites@0.0.16
  - @substrat-run/engine-invoicing@0.3.17

## 0.0.15

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/engine-booking@0.1.13
  - @substrat-run/engine-invites@0.0.15
  - @substrat-run/engine-invoicing@0.3.16

## 0.0.14

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/engine-booking@0.1.12
- @substrat-run/engine-invites@0.0.14
- @substrat-run/engine-invoicing@0.3.15

## 0.0.13

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/engine-booking@0.1.11
  - @substrat-run/engine-invites@0.0.13
  - @substrat-run/engine-invoicing@0.3.14

## 0.0.12

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/engine-booking@0.1.10
  - @substrat-run/engine-invites@0.0.12
  - @substrat-run/engine-invoicing@0.3.13

## 0.0.11

### Patch Changes

- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1
  - @substrat-run/adapter-sqlite@0.14.1
  - @substrat-run/engine-booking@0.1.9
  - @substrat-run/engine-invites@0.0.11
  - @substrat-run/engine-invoicing@0.3.12

## 0.0.10

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/engine-booking@0.1.8
  - @substrat-run/engine-invites@0.0.10
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.0.9

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-booking@0.1.7
  - @substrat-run/engine-invites@0.0.9
  - @substrat-run/engine-invoicing@0.3.10

## 0.0.8

### Patch Changes

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-booking@0.1.6
  - @substrat-run/engine-invites@0.0.8
  - @substrat-run/engine-invoicing@0.3.9

## 0.0.7

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/engine-booking@0.1.5
  - @substrat-run/engine-invites@0.0.7
  - @substrat-run/engine-invoicing@0.3.8

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
  - @substrat-run/engine-booking@0.1.4
  - @substrat-run/engine-invites@0.0.6
  - @substrat-run/engine-invoicing@0.3.7

## 0.0.5

### Patch Changes

- Updated dependencies [e930aef]
- Updated dependencies [27872cc]
  - @substrat-run/engine-booking@0.1.3
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/engine-invites@0.0.5
  - @substrat-run/engine-invoicing@0.3.6
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-booking@0.1.2
- @substrat-run/engine-invites@0.0.4
- @substrat-run/engine-invoicing@0.3.5

## 0.0.3

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-booking@0.1.1
  - @substrat-run/engine-invites@0.0.3
  - @substrat-run/engine-invoicing@0.3.4

## 0.0.2

### Patch Changes

- Updated dependencies [d75814c]
  - @substrat-run/engine-booking@0.1.0
  - @substrat-run/contracts@0.6.0
  - @substrat-run/kernel@0.6.0
  - @substrat-run/adapter-sqlite@0.6.0
  - @substrat-run/engine-invites@0.0.2
  - @substrat-run/engine-invoicing@0.3.2
