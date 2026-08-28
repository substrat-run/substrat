# @substrat-run/demo-bike-shop

## 0.1.8

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/vertical-host@0.91.0
  - @substrat-run/contracts@0.91.0
  - @substrat-run/engine-invoicing@0.9.7
  - @substrat-run/engine-protocol@0.11.7
  - @substrat-run/engine-workorder@0.9.2
  - @substrat-run/adapter-sqlite@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.1.7

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0
  - @substrat-run/adapter-sqlite@0.90.0
  - @substrat-run/engine-invoicing@0.9.6
  - @substrat-run/engine-protocol@0.11.6
  - @substrat-run/engine-workorder@0.9.1
  - @substrat-run/vertical-host@0.90.0

## 0.1.6

### Patch Changes

- c601b68: An entity's history is a read the kernel owns

  Reading `_substrat_outbox` for one entity is a sanctioned projection — rule 3 bans writes
  to the spine, not reads, because "show me the history of this thing" has no other source.
  What was missing was a supported SHAPE, and five demos wrote the query by hand in its
  absence. They did not agree, and the disagreements were not cosmetic.

  | Demo               | Order                | Cursor        |
  | ------------------ | -------------------- | ------------- |
  | callout, handlebar | `rowid`              | `rowid`       |
  | meridian, rally    | `occurred_at, rowid` | `occurred_at` |
  | manyfold           | `rowid`              | _(unpaged)_   |

  **Meridian's and rally's paging dropped events.** The step was `occurred_at > ?`, so every
  row sharing the last one's timestamp was skipped — and sharing it is the norm, not a rare
  tie: `ctx.now()` is stable for a whole invocation (#812), so every event one operation
  emits carries the identical instant. A page boundary inside them lost the rest, and no
  test would have caught it.

  ```ts
  import { readTimeline } from "@substrat-run/kernel";

  assertAllowed(await ctx.check(WO.read, entity)); // the caller checks. always
  return readTimeline(ctx, entity, input); // { entries, nextCursor }
  ```

  Each entry is `{ id, type, occurredAt, actor }`, and two of those four are not what the
  hand-written `SELECT` was getting:

  - **`actor` is the union, decoded.** The column stores `JSON.stringify(actor)` over
    `PrincipalId | { system } | { connection }`, so a principal is stored _with its quotes_.
    `SELECT actor` returns a string that looks usable and is not; the obvious repair — trim
    the quotes — then breaks on a system actor. An agent building a timeline hit this as a
    real bug and had to read the adapter source to find it.
  - **`id` is the entity's version at that point** (#901) — the token `ctx.versionOf`
    returns and `If-Match` compares (#129), so listing the history, naming a version and
    refusing a stale write stop being three vocabularies. It is therefore the cursor:
    `ORDER BY id` is creation order because `ulid()` is monotonic, and `OUTBOX_ENTITY_INDEX`
    makes the walk a seek with no new DDL. A `rowid` cursor could use neither, and does not
    survive a restore.

  `readHistory` is the same walk with what a history VIEW needs — `payload`, `authorization`
  (which permission, and which grant), `piiClass`/`subjectId`. Two nullables there are facts
  rather than gaps: **`payload` is null after an erasure**, because a shred keeps the
  envelope and destroys what was said, so a history correctly degrades to "someone changed
  this, then"; and `authorization` is null when the row predates it being recorded, which is
  not the same as having checked nothing.

  Neither read checks a permission, deliberately. A helper that gated itself would be a
  second, invisible policy surface; one that gated itself on nothing would be an unchecked
  path into every event in the scope. Both are worse than the one line at the call site.

  Also fixed on the way: Callout's and Handlebar's hand-mounted timeline routes never applied
  the page projection `mountOperations` does for declared routes, so since these operations
  became paged (#811) they answered `{ entries, nextCursor }` to an app that typed the body
  as an array and called `.map` on it. The scenarios invoke the operation and never the
  route, so nothing saw it. Both now emit the `Link` continuation and both apps WALK it —
  reading only the body is how a history strip silently stops at twenty events, which an
  order reaches in a working week — and a route-level test drives more events than one page
  fits over real HTTP, since that is the only layer where the truncation exists.

  Both adapters are held to all of it by a new contract suite.

- 2352a3b: Every surface answers problem+json — and the message-matching goes with it

  `/openapi.json` has said `application/problem+json` on every error response since the error
  model's first phase. Nothing served one. Seven verticals, the scaffold template and the
  control plane each hand-rolled a handler that read a status out of an error's **prose** —
  `/not found/` → 404, `/out of stock/` → 409, `/cannot edit|frozen|already/` → 409 — and
  answered `{ error: "<message>" }`. This is phase 4 of #113: the transports read the code.

  ```http
  409 Conflict
  content-type: application/problem+json
  ```

  ```json
  {
    "type": "https://substrat.net/errors/conflict",
    "title": "Conflict",
    "status": 409,
    "detail": "out of stock: SKU-14 — 2 available, 5 requested",
    "code": "conflict",
    "reason": "out_of_stock",
    "instance": "/api/op/shop/add-to-cart",
    "error": "out of stock: SKU-14 — 2 available, 5 requested"
  }
  ```

  **The patterns were not kept as a fallback; the throw sites were typed instead.** A regex
  table living beside typed throws is a table nobody maintains. So 73 raw `new Error(...)`
  across the six verticals became `substratError('conflict', …, { reason })` — the platform
  owns the code, the vertical owns the reason — and the two platform refusals every vertical
  had independently hand-matched (`unknown operation`, `operation not entitled`) are typed in
  the adapters and the kernel where they are raised. Seven `onError` handlers are one line
  each now. `problemResponse(c, err)` is exported from `@substrat-run/vertical-host` and is
  what the scaffold template ships with.

  **A body with no `code` is information.** Two failures reach a transport that the closed
  taxonomy cannot name: a throw nobody typed (answered with the caller's 400, deliberately —
  an unrecognised throw must not claim to be the platform's fault) and a status raised
  somewhere else (a downstream vertical's refusal, a Durable Object fault's 502). Those get
  RFC 9457's `about:blank` form — status, message, no code — because inventing one would put
  our vocabulary on a failure we cannot describe, and a client switching on `code` would
  match it. `problem.code` is optional in the schema for exactly that reason, and the absence
  doubles as a visible to-do list: every one marks a throw site still untyped.

  **Nothing breaks.** `error` still duplicates `detail` on every body, which is why roughly
  thirty contract-suite assertions on message text, and every SPA in the repo, went green
  untouched. It goes in phase 5, along with the last patterns; `detail` is what to read.

  Three deliberate exclusions, stated rather than hidden:

  - **`engine-booking`'s `SlotUnavailable`** publishes its own `code = 'SLOT_UNAVAILABLE'`,
    which both RallyPoint clients switch on. An engine surface evolves additively only, so
    retyping it is a dual-emit through a deprecation window — `demos/rally` answers it by
    hand and says so.
  - **`demos/auth-server`** is an OIDC issuer whose OAuth endpoints owe RFC 6749 error
    bodies, where `error` is an OAuth code rather than a message. Merging the two
    vocabularies on one surface is the OAuth work's call, not a transport sweep's.
  - **The control plane's 23 remaining patterns** cover untyped `HostAdmin` throws. The table
    names a **code** per row now instead of a status, so an entry says what the failure IS and
    the status follows from the catalog — the two can no longer disagree.

  **Statuses moved, and that is the point.** A vertical's default for anything its pattern
  list did not recognise was the caller's 400, so every domain refusal that did not happen to
  say "not found" arrived as one: `cart is empty`, `discount code expired`, `the club is
closed on 2026-08-25`, `no employment terms set`, `only a submitted expense can be decided`.
  Those are 409 now — the request was well-formed and the state refused it — and `no such
plan` / `no such credit pack` are 404, which their wording had hidden from the pattern that
  would have caught them. No client in the repo branches on those statuses (the demo SPAs
  read `{ error }`, and only Todo's reads a status at all, for 403), so this lands as a
  correction rather than a break.

  One outright fix falls out: Manyfold's public delivery read of an unpublished slug answered
  409, because `not published` sat in an app-level pattern list that meant "conflict". It is a
  404 — the entry does not exist yet.

- Updated dependencies [73710de]
- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/engine-workorder@0.9.0
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0
  - @substrat-run/adapter-sqlite@0.89.0
  - @substrat-run/vertical-host@0.89.0
  - @substrat-run/engine-invoicing@0.9.5
  - @substrat-run/engine-protocol@0.11.5

## 0.1.5

### Patch Changes

- e401927: A narrowed check may name several entity types, and the schema says which

  Three timeline operations took `entityType: z.string()` and narrowed to whatever the caller
  named, while `{ key, entity, idFrom }` holds one fixed type. #889 declared `entity: 'workorder'`
  on two of them — accurate to the app, narrower than the operation — and filed #890 asking whether
  the answer was a new `entityFrom` field or simply a bounded input.

  **It is both, and the reason is a caller the issue did not know about.** Every call site in the
  app, the routes and the portal beats passes one constant, so the cheap answer looked complete:
  pin `z.literal('workorder')` and the declaration becomes exact. It isn't complete — Callout's
  §12 and Handlebar's counter-signature beat read a **protocol's** spine rows through the same
  operation. Two admissible types, then, not one, and the literal turned both scenarios red on
  first run, which is how the second type was found at all.

  - `entityFrom: 'entityType'` names the input field carrying the type, beside `idFrom` naming the
    one carrying the id. It is an alternative to `entity`, not an addition — one type or a field
    that names several.
  - **The admissible types are not listed in the declaration.** They are read off that field's own
    schema (`z.enum(['workorder', 'protocol'])`), so the set exists once. #890's own worry about
    `entityFrom` was that the kit would need a caller-written list, and a list a caller writes goes
    stale; reading the schema is what avoids it.
  - An open `z.string()` behind `entityFrom` is reported **uncovered with a reason**, never guessed
    at. `protocol/list-for-entity` is that shape and stays as it is — an engine cannot know its
    callers' nouns, which is the separate half of #890 (see the follow-up issue).

  **What the kit does with it.** An `entityFrom` operation is driven **once per admissible type**,
  so Callout's timeline now runs its pair over a work order _and_ over a protocol — 2 new generated
  tests per vertical, all passing, so the handlers were honouring both all along. The kit also reads
  a single-valued literal off the schema rather than being handed it: the three fixtures each
  restated their constant in `inputs`, a second copy that could disagree with the declaration, and
  Handlebar's was quietly deciding that only repairs got tested.

  Meridian's `hr/timeline` is the one-type case and keeps `entity: 'employee'`, with
  `z.literal('employee')` where the open string was.

  **Surface note, stated because it is a narrowing:** the three timelines now refuse an entity type
  they used to accept and answer with a validation error rather than a permission denial. No caller
  in the repo passes anything else, and the portal is unaffected — a portal customer reads her
  order's timeline as `entityType: 'workorder'` and her grant on the CUSTOMER reaches it through the
  parent walk (`workorder → facility → customer`), which is what makes the portal work. Meridian's
  `openapi.json` records the narrowing as `"const": "employee"`.

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

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0
  - @substrat-run/adapter-sqlite@0.88.0
  - @substrat-run/vertical-host@0.88.0
  - @substrat-run/engine-protocol@0.11.4
  - @substrat-run/engine-invoicing@0.9.4
  - @substrat-run/engine-workorder@0.8.4

## 0.1.4

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/engine-invoicing@0.9.3
  - @substrat-run/engine-protocol@0.11.3
  - @substrat-run/engine-workorder@0.8.3
  - @substrat-run/adapter-sqlite@0.87.0
  - @substrat-run/kernel@0.87.0
  - @substrat-run/vertical-host@0.87.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0
- @substrat-run/adapter-sqlite@0.86.0
- @substrat-run/vertical-host@0.86.0
- @substrat-run/engine-invoicing@0.9.2
- @substrat-run/engine-protocol@0.11.2
- @substrat-run/engine-workorder@0.8.2

## 0.1.2

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0
- @substrat-run/adapter-sqlite@0.85.0
- @substrat-run/vertical-host@0.85.0
- @substrat-run/engine-invoicing@0.9.1
- @substrat-run/engine-protocol@0.11.1
- @substrat-run/engine-workorder@0.8.1

## 0.1.1

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [7548dde]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/engine-workorder@0.8.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-sqlite@0.84.0
  - @substrat-run/vertical-host@0.84.0
  - @substrat-run/engine-invoicing@0.9.0
  - @substrat-run/engine-protocol@0.11.0

## 0.1.0

### Minor Changes

- 4f65106: A vertical's browser client is emitted from its model, and a generated file carries a gate.

  `demos/todo/app/src/api.ts` was 91 hand-written lines, and every fact in it already
  existed in `spec/model.ts`: the `List`/`Item`/`Share` interfaces are the entities'
  `fields`, the paths and methods are the `http` blocks, the request bodies are the `input`
  schemas. It was a second description of a declared thing — the defect this repo already
  refuses for the route table (`mountOperations`), the OpenAPI document (`lint:api`), the
  permission surface (`lint:permissions`) and the migrations.

  It drifted the way a second description does. #811 declared `todo/list-items` paged and
  #827 added two search reads; the client learned about neither, so the app rendered the
  first twenty items of a list as though that were the list, and shipped no search at all.
  Nothing was red, and nothing could be — there was no gate over a file a person maintained
  by remembering to.

  ## `renderClient` in `@substrat-run/model-emit`, `tools/client-emit.mts` around it

  The printer lives in the package because that is already the package's job — build-time
  tooling over a Substrat model, where `emitTables` turns entities into DDL. The tool keeps
  the sweep and the IO.

  The split is what makes it testable, and it needed to be. `--check` re-emits and compares,
  so it catches a client that fell BEHIND its model; it cannot catch a printer that has been
  confidently mis-spelling `z.array(z.union([...]))` since the day it was written — the
  emitted file and the re-emitted file agree perfectly, and both are wrong. 118 tests now
  assert exact strings for optionality (`a?: T`, never `a?: T | undefined`), parenthesised
  unions inside arrays, brands, pipes, discriminated unions, identity naming, every refusal,
  and a rendered client end to end.

  ## Opting in (`pnpm lint:client`)

  A vertical opts in from its `package.json`, naming its model and where the client lands.
  The output is **standalone TypeScript with no imports at all**. That is not tidiness: the
  app is a separate Vite package that depends on neither `@substrat-run/contracts` nor zod
  and must keep depending on neither, and a checked-in artifact that re-exports its meaning
  from another package is not reviewable in a diff.

  Types are matched **by identity** — `output: todoEntities.item.fields` is the same object,
  so it prints as `Item`, while an inline shape that happens to match an entity stays inline.
  A schema the printer cannot spell is exit 2 naming the operation and the field, never a
  silent `unknown`: a generated client that degrades to `any` is worse than the hand-written
  one it replaced, because the green light is now mechanical.

  It owns the paged wire shape once, so no SPA re-derives it — a `Page` reassembled from the
  entries body plus `Link` / `X-Total-Count` (#829), and `follow(next)` which re-bases the
  link's path onto whatever the client was configured to talk to.

  **The source may be a `defineOperations` bag or an `ApiCatalog`.** They carry the same five
  fields the emitter reads (`summary`, `input`, `output`, `http`, `paged`), so a vertical that
  documents its API already has most of what this needs; what it lacks is `output` and `http`
  per operation, not a migration.

  ## Three verticals

  |           | hand-maintained | now | removed |
  | --------- | --------------- | --- | ------- |
  | todo      | 91              | 33  | −58     |
  | callout   | 305             | 203 | −102    |
  | handlebar | 234             | 131 | −103    |

  What survives is only what no model declares: which principal a request carries, the error
  envelope each vertical picked in its own `app.onError`, the dev harness's `/cast`, and the
  handful of operations left deliberately unbound because they take an entity-agnostic
  `entityType` — binding `callout/timeline` or `protocol/list-for-entity` to a URL would let
  a caller name any entity at all.

  Callout and Handlebar compose three engines each, which the emitter reads as further
  operation bags (`defineEngineRoutes` returns the same objects with `http` attached). A
  composed engine keeps its prefix — `workorderGet` / `protocolGet` / `invoicingGet`, because
  three engines each declare `get` and renaming an engine's operation to suit a vertical's
  client is not a thing a vertical may do.

  ## What generating them found

  - **A live drift.** `bike-shop/price-list` declared `GET /price-list`; the server has always
    served `/prices`. Handlebar mounts by hand, so nothing checked, and the declaration was
    decorative. A client generated from it would have 404'd on its first request.
  - **Two latent runtime bugs**, both caught by the compiler because the generated type is the
    engine's real one. `ProtocolDetail.content` is a union — checklist **or** document — and
    both apps' hand-written interfaces declared only the checklist arm, so a document protocol
    would have thrown on `.sections` of undefined. `underlagLine.source_id` is nullable, and
    Handlebar's invoicing view linked through it unconditionally.
  - **Ten operations declared without an `http` block** (four in Callout, six in Handlebar),
    so each SPA hand-wrote calls to routes the vertical already served. Binding them is also
    what let both route tables become derived below; each new path was verified against the
    one the hand-written table served before it was replaced.
  - **A name shadow.** Callout and `engine-protocol` both export `instantiateProtocolInput`
    with different shapes. Harmless, but it is why the emitter resolves each configured export
    individually and refuses only a name it was actually asked for.

  ## Generated files carry three marks, or they are not generated

  CLAUDE.md now states it: the `.generated.ts` suffix, a header naming the producer and the
  source, and a `--check` re-emit in CI. Only the third enforces anything — "do not edit" is a
  request.

  `demos/todo/src/migrations.ts` becomes `src/migrations.generated.ts`, and the rename was the
  smaller half. `emit:migrations --check` only ever asked whether the JOURNAL was behind the
  model; it never asked whether the module still matched the journal, and it re-rendered the
  module only on the run that appended an entry. A hand-edit to shipped SQL therefore passed
  every check in the repo. It now re-renders every run and diffs.

  New CI steps: `pnpm lint:client --check` and `pnpm lint:migrations --check`.

  One exception is stated rather than hidden: a file generated from a REMOTE source cannot be
  re-emitted hermetically, so `rate-card.generated.ts` (models.dev) and `packages/psl/src/data.ts`
  (the public suffix list) carry the suffix and header plus a `GENERATED_AT` stamp instead of a
  gate. An in-repo source with no gate is a defect, not a style.

  ## Both hand-written route tables go too

  Callout's `src/routes.ts` (180 → 102) and Handlebar's route block in `src/server.ts`
  (129 lines → a `mountOperations` call) were the other half of the same duplication: every
  line restated a method and a path the operations already declare. The comments they had
  accumulated are the argument against them — one explaining that `/customers/search` must be
  registered before any `/customers/:id` route or Hono answers it with `id: 'search'`, another
  explaining that `limit` arrives as a string and must be coerced because the operation
  declares a number. Both are real, and `mountOperations` derives both from the same
  declarations (#785). A hand-written table has to remember.

  What stays hand-written in each is the two routes that supply a CONSTANT — `timeline` and
  `protocol/list-for-entity` both take an entity-agnostic `entityType`, and binding either
  would let a caller read the timeline, or the protocols, of anything in the scope.

  Callout's route-parity test is rewritten rather than kept. It existed to prove the
  derivation matched the hand-written table so the table could be replaced; now that
  `routes.ts` IS the derivation, that assertion is one thing equalling itself, and a test that
  cannot fail is worse than no test because it still reads like coverage. What replaces it is
  the part that was never tautological: the declared surface pinned as an exact list, the two
  exceptions still being served, and the static-before-parameter ordering.

  **One deliberate behaviour change.** Handlebar's pickup refusal now answers **409**, not 400. The engine declares that error's taxonomy code (#113) and `mountOperations` honours it;
  Handlebar's hand-written `onError` could not see the code and flattened everything
  unrecognised to 400. Both apps' `onError` now converts the mount's `HTTPException` back into
  their own `{ error }` body — Callout's previously returned `err.getResponse()`, whose body is
  Hono's, not `{ error }`, which the SPA reads off every failure.

  ## Verified

  Each client was driven against its own running server, not just typechecked: todo walks a
  45-item list across three pages with a correct total; Callout runs an order from creation
  through protocol sign to invoicing and refuses a portal user's write with a typed 403;
  Handlebar's pickup rule holds — `closeRepair` is refused until the customer counter-signs the
  tillståndsrapport, and succeeds after. Both were driven again after their route tables became
  derived: same lifecycle, same 403/404/400 envelopes, the `z.literal('workorder')` pin still
  holding against a caller who sends `entityType: 'customer'`, and `/customers/search` still
  reached rather than swallowed by its parameter sibling.

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-sqlite@0.83.0
  - @substrat-run/vertical-host@0.83.0
  - @substrat-run/engine-invoicing@0.8.3
  - @substrat-run/engine-protocol@0.10.3
  - @substrat-run/engine-workorder@0.7.3

## 0.0.82

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/engine-invoicing@0.8.2
  - @substrat-run/engine-protocol@0.10.2
  - @substrat-run/engine-workorder@0.7.2
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.0.81

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/engine-invoicing@0.8.1
  - @substrat-run/engine-protocol@0.10.1
  - @substrat-run/engine-workorder@0.7.1

## 0.0.80

### Patch Changes

- Updated dependencies [f6174fb]
- Updated dependencies [83b0ca3]
  - @substrat-run/engine-invoicing@0.8.0
  - @substrat-run/engine-protocol@0.10.0
  - @substrat-run/engine-workorder@0.7.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.0.79

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/engine-invoicing@0.7.6
  - @substrat-run/engine-protocol@0.9.6
  - @substrat-run/engine-workorder@0.6.6
  - @substrat-run/adapter-sqlite@0.79.0

## 0.0.78

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/engine-invoicing@0.7.5
  - @substrat-run/engine-protocol@0.9.5
  - @substrat-run/engine-workorder@0.6.5
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.0.77

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/engine-invoicing@0.7.4
  - @substrat-run/engine-protocol@0.9.4
  - @substrat-run/engine-workorder@0.6.4
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.0.76

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-sqlite@0.76.0
- @substrat-run/engine-invoicing@0.7.3
- @substrat-run/engine-protocol@0.9.3
- @substrat-run/engine-workorder@0.6.3

## 0.0.75

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/engine-protocol@0.9.2
  - @substrat-run/engine-workorder@0.6.2
  - @substrat-run/contracts@0.75.0

## 0.0.74

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/engine-protocol@0.9.1
  - @substrat-run/engine-workorder@0.6.1
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.0.73

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-protocol@0.9.0
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-workorder@0.6.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.0.72

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
  - @substrat-run/engine-workorder@0.5.0
  - @substrat-run/engine-protocol@0.8.0
  - @substrat-run/engine-invoicing@0.6.3

## 0.0.71

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/engine-protocol@0.7.3
  - @substrat-run/engine-workorder@0.4.3
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.0.70

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/engine-protocol@0.7.2
  - @substrat-run/engine-workorder@0.4.2
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.0.69

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/engine-protocol@0.7.1
  - @substrat-run/engine-workorder@0.4.1
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.0.68

### Patch Changes

- 2421781: Handlebar declares all eleven operations and binds every handler.

  The second adopter of `defineOperations`, and the first that could declare its
  whole surface on the first pass: every engine type it returns — `workOrder`,
  `billableLine`, `protocolInstanceRow`, `money` — already has an exported schema,
  so nothing here transcribes an engine's shape.

  `CustomerRow` and `BikeRow` are now derived from the entity registry rather than
  hand-written beside it, and `startConditionReportInput` moved next to the
  declaration so the model and the handler share one object.

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [701de69]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
- Updated dependencies [09852a9]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/engine-protocol@0.7.0
  - @substrat-run/engine-workorder@0.4.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/engine-invoicing@0.5.24

## 0.0.67

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-invoicing@0.5.23
  - @substrat-run/engine-protocol@0.6.3
  - @substrat-run/engine-workorder@0.3.65
  - @substrat-run/adapter-sqlite@0.67.0

## 0.0.66

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/engine-protocol@0.6.2
  - @substrat-run/engine-workorder@0.3.64
  - @substrat-run/contracts@0.66.0

## 0.0.65

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/engine-protocol@0.6.1
  - @substrat-run/engine-workorder@0.3.63
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.0.64

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/engine-protocol@0.6.0
  - @substrat-run/engine-invoicing@0.5.20
  - @substrat-run/engine-workorder@0.3.62

## 0.0.63

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/engine-protocol@0.5.21
  - @substrat-run/engine-workorder@0.3.61
  - @substrat-run/contracts@0.63.0

## 0.0.62

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/engine-protocol@0.5.20
  - @substrat-run/engine-workorder@0.3.60
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.0.61

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/engine-protocol@0.5.19
  - @substrat-run/engine-workorder@0.3.59
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.0.60

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/engine-protocol@0.5.18
  - @substrat-run/engine-workorder@0.3.58
  - @substrat-run/kernel@0.60.0

## 0.0.59

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0
- @substrat-run/adapter-sqlite@0.59.0
- @substrat-run/engine-invoicing@0.5.15
- @substrat-run/engine-protocol@0.5.17
- @substrat-run/engine-workorder@0.3.57

## 0.0.58

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/engine-invoicing@0.5.14
  - @substrat-run/engine-protocol@0.5.16
  - @substrat-run/engine-workorder@0.3.56

## 0.0.57

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/engine-protocol@0.5.15
  - @substrat-run/engine-workorder@0.3.55
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.0.56

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/engine-invoicing@0.5.12
  - @substrat-run/engine-protocol@0.5.14
  - @substrat-run/engine-workorder@0.3.54

## 0.0.55

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0
- @substrat-run/adapter-sqlite@0.55.0
- @substrat-run/engine-invoicing@0.5.11
- @substrat-run/engine-protocol@0.5.13
- @substrat-run/engine-workorder@0.3.53

## 0.0.54

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/engine-invoicing@0.5.10
  - @substrat-run/engine-protocol@0.5.12
  - @substrat-run/engine-workorder@0.3.52

## 0.0.53

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/engine-protocol@0.5.11
  - @substrat-run/engine-invoicing@0.5.9
  - @substrat-run/engine-workorder@0.3.51

## 0.0.52

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/engine-protocol@0.5.10
  - @substrat-run/engine-workorder@0.3.50
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.0.51

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-sqlite@0.51.0
- @substrat-run/engine-invoicing@0.5.7
- @substrat-run/engine-protocol@0.5.9
- @substrat-run/engine-workorder@0.3.49

## 0.0.50

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/engine-protocol@0.5.8
  - @substrat-run/engine-invoicing@0.5.6
  - @substrat-run/engine-workorder@0.3.48

## 0.0.49

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/engine-protocol@0.5.7
  - @substrat-run/engine-workorder@0.3.47
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.0.48

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/engine-invoicing@0.5.4
  - @substrat-run/engine-protocol@0.5.6
  - @substrat-run/engine-workorder@0.3.46

## 0.0.47

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/engine-invoicing@0.5.3
  - @substrat-run/engine-protocol@0.5.5
  - @substrat-run/engine-workorder@0.3.45

## 0.0.46

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
- @substrat-run/adapter-sqlite@0.46.0
- @substrat-run/engine-invoicing@0.5.2
- @substrat-run/engine-protocol@0.5.4
- @substrat-run/engine-workorder@0.3.44

## 0.0.45

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/engine-protocol@0.5.3
  - @substrat-run/engine-workorder@0.3.43
  - @substrat-run/kernel@0.45.0

## 0.0.44

### Patch Changes

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/engine-protocol@0.5.2
  - @substrat-run/engine-workorder@0.3.42
  - @substrat-run/contracts@0.44.0

## 0.0.43

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0
- @substrat-run/adapter-sqlite@0.43.0
- @substrat-run/engine-invoicing@0.4.3
- @substrat-run/engine-protocol@0.5.1
- @substrat-run/engine-workorder@0.3.41

## 0.0.42

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/engine-protocol@0.5.0
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/engine-workorder@0.3.40
  - @substrat-run/contracts@0.42.0

## 0.0.41

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/engine-protocol@0.4.33
  - @substrat-run/engine-invoicing@0.4.1
  - @substrat-run/engine-workorder@0.3.39

## 0.0.40

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0
  - @substrat-run/engine-protocol@0.4.32
  - @substrat-run/engine-workorder@0.3.38

## 0.0.39

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/engine-protocol@0.4.31
  - @substrat-run/engine-workorder@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.0.38

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/engine-invoicing@0.3.36
  - @substrat-run/engine-protocol@0.4.30
  - @substrat-run/engine-workorder@0.3.36

## 0.0.37

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0
- @substrat-run/adapter-sqlite@0.37.0
- @substrat-run/engine-invoicing@0.3.35
- @substrat-run/engine-protocol@0.4.29
- @substrat-run/engine-workorder@0.3.35

## 0.0.36

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-sqlite@0.36.0
- @substrat-run/engine-invoicing@0.3.34
- @substrat-run/engine-protocol@0.4.28
- @substrat-run/engine-workorder@0.3.34

## 0.0.35

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/engine-protocol@0.4.27
  - @substrat-run/engine-workorder@0.3.33
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.0.34

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/engine-invoicing@0.3.32
  - @substrat-run/engine-protocol@0.4.26
  - @substrat-run/engine-workorder@0.3.32

## 0.0.33

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/engine-invoicing@0.3.31
  - @substrat-run/engine-protocol@0.4.25
  - @substrat-run/engine-workorder@0.3.31

## 0.0.32

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/engine-invoicing@0.3.30
  - @substrat-run/engine-protocol@0.4.24
  - @substrat-run/engine-workorder@0.3.30

## 0.0.31

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/engine-invoicing@0.3.29
  - @substrat-run/engine-protocol@0.4.23
  - @substrat-run/engine-workorder@0.3.29

## 0.0.30

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/engine-invoicing@0.3.28
  - @substrat-run/engine-protocol@0.4.22
  - @substrat-run/engine-workorder@0.3.28

## 0.0.29

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0
- @substrat-run/adapter-sqlite@0.29.0
- @substrat-run/engine-invoicing@0.3.27
- @substrat-run/engine-protocol@0.4.21
- @substrat-run/engine-workorder@0.3.27

## 0.0.28

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0
- @substrat-run/adapter-sqlite@0.28.0
- @substrat-run/engine-invoicing@0.3.26
- @substrat-run/engine-protocol@0.4.20
- @substrat-run/engine-workorder@0.3.26

## 0.0.27

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/engine-invoicing@0.3.25
  - @substrat-run/engine-protocol@0.4.19
  - @substrat-run/engine-workorder@0.3.25

## 0.0.26

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/engine-invoicing@0.3.24
  - @substrat-run/engine-protocol@0.4.18
  - @substrat-run/engine-workorder@0.3.24

## 0.0.25

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/engine-invoicing@0.3.23
  - @substrat-run/engine-protocol@0.4.17
  - @substrat-run/engine-workorder@0.3.23

## 0.0.24

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
  - @substrat-run/engine-invoicing@0.3.22
  - @substrat-run/engine-protocol@0.4.16
  - @substrat-run/engine-workorder@0.3.22

## 0.0.23

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/engine-protocol@0.4.15
  - @substrat-run/engine-workorder@0.3.21
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.0.22

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/engine-invoicing@0.3.20
  - @substrat-run/engine-protocol@0.4.14
  - @substrat-run/engine-workorder@0.3.20

## 0.0.21

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0
- @substrat-run/adapter-sqlite@0.21.0
- @substrat-run/engine-invoicing@0.3.19
- @substrat-run/engine-protocol@0.4.13
- @substrat-run/engine-workorder@0.3.19

## 0.0.20

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/engine-invoicing@0.3.18
  - @substrat-run/engine-protocol@0.4.12
  - @substrat-run/engine-workorder@0.3.18

## 0.0.19

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/engine-invoicing@0.3.17
  - @substrat-run/engine-protocol@0.4.11
  - @substrat-run/engine-workorder@0.3.17

## 0.0.18

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/engine-invoicing@0.3.16
  - @substrat-run/engine-protocol@0.4.10
  - @substrat-run/engine-workorder@0.3.16

## 0.0.17

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/engine-invoicing@0.3.15
- @substrat-run/engine-protocol@0.4.9
- @substrat-run/engine-workorder@0.3.15

## 0.0.16

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/engine-invoicing@0.3.14
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/engine-workorder@0.3.14

## 0.0.15

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/engine-protocol@0.4.7
  - @substrat-run/engine-invoicing@0.3.13
  - @substrat-run/engine-workorder@0.3.13

## 0.0.14

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/engine-workorder@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.0.13

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invoicing@0.3.10
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/engine-workorder@0.3.10

## 0.0.12

### Patch Changes

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9

## 0.0.11

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/engine-invoicing@0.3.8
  - @substrat-run/engine-protocol@0.4.2
  - @substrat-run/engine-workorder@0.3.8

## 0.0.10

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-invoicing@0.3.7
  - @substrat-run/engine-protocol@0.4.1
  - @substrat-run/engine-workorder@0.3.7

## 0.0.9

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/engine-invoicing@0.3.6
  - @substrat-run/engine-workorder@0.3.6
  - @substrat-run/contracts@0.9.0

## 0.0.8

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-invoicing@0.3.5
- @substrat-run/engine-protocol@0.3.6
- @substrat-run/engine-workorder@0.3.5

## 0.0.7

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-invoicing@0.3.4
  - @substrat-run/engine-protocol@0.3.5
  - @substrat-run/engine-workorder@0.3.4

## 0.0.6

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-invoicing@0.3.2
- @substrat-run/engine-protocol@0.3.3
- @substrat-run/engine-workorder@0.3.3

## 0.0.5

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0
- @substrat-run/adapter-sqlite@0.5.0
- @substrat-run/engine-invoicing@0.3.1
- @substrat-run/engine-protocol@0.3.2
- @substrat-run/engine-workorder@0.3.2

## 0.0.4

### Patch Changes

- Updated dependencies [6900431]
- Updated dependencies [7e9fad6]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
  - @substrat-run/adapter-sqlite@0.4.0
  - @substrat-run/engine-invoicing@0.3.0
  - @substrat-run/engine-protocol@0.3.1
  - @substrat-run/engine-workorder@0.3.1

## 0.0.3

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0
  - @substrat-run/adapter-sqlite@0.3.0
  - @substrat-run/engine-workorder@0.3.0
  - @substrat-run/engine-invoicing@0.2.0
  - @substrat-run/engine-protocol@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0
  - @substrat-run/kernel@0.2.0
  - @substrat-run/adapter-sqlite@0.2.0
  - @substrat-run/engine-workorder@0.2.0
  - @substrat-run/engine-protocol@0.2.0
  - @substrat-run/engine-invoicing@0.1.1
