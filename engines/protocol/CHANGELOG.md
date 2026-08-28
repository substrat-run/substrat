# @substrat-run/engine-protocol

## 0.11.6

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.11.5

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.11.4

### Patch Changes

- d4c66ac: An engine declares a check narrowed to a ref the caller owns, and absence's are driven

  `engines/absence` narrows six checks to `subject: EntityRef`, and until now they were
  **undeclarable rather than undeclared** — two separate problems that had to be fixed in order.
  The format could not hold them: a narrowed check named `entity: '<a type from a declared
registry>'`, and absence narrows to Meridian's `employee`, which appears in no registry absence
  can see. #890's `entityFrom` did not reach it either — it changes where the type name comes
  from, not that it has to be a name someone declared.

  `refFrom` names the input field carrying the whole `EntityRef`. One field, both halves: the type
  travels with the id, so there is nothing left for `entity` or `idFrom` to say, and declaring
  either alongside is a compile error. A dotted path reaches one level in, for absence's `request`,
  where the erasure key rides beside the ref in `subject: { ref, dataSubjectId }`.

  **The kit drives these, and the harness plays the vertical.** A suite declares `refEntityType` —
  absence's names `employee`, a noun the engine has never heard of — and `createEntity` mints a bare
  ULID without writing a row anywhere, because a subject ref is exactly that: an opaque pointer the
  vertical owns. A grant resolves against a ref whether or not any table on the engine's side knows
  it, which is what makes the engine's indifference to the noun testable rather than merely stated.
  Without a `refEntityType` the operations are reported uncovered, never skipped.

  Driven rather than argued — `absence/balance` mutated to check the node:

  ```
  × absence/balance — absence:read on employee, ref from 'subject'
    → denied a principal holding absence:read on the very employee it was invoked against
      — the handler is checking the node, not the entity
  ```

  ## engines/absence declares its operation surface

  All eleven, in `src/operations.ts`, with `src/schemas.ts` carrying the shapes — the last of #891's
  five packages. Four checks declare `refFrom` and are driven (`request`, `balance`, `availability`,
  `list-entries`); all four were already honoured.

  **The other two narrowed checks declare node keys, and that is the finding worth reading.**
  `cancel` has two authorities and the narrowed one reads its ref off the STORED request, so there
  is no field to name; `list-requests` narrows only when the caller supplies a subject, and a
  `refFrom` on an optional field would claim a narrowing that a caller omitting it never gets. Both
  are stated in `operations.ts` rather than left to be inferred, and both are the shapes #892 already
  met in Meridian and Shop.

  **Breaking at the operation seam:** three list reads now answer `Page<T>` (#811). Meridian composes
  this engine by CALL — `requestAbsence`, `balanceAsOf`, `listEntries` — and those in-scope functions
  are unchanged, so no consumer moves. **No migration:** `absenceEntities` declares one entity, the
  ledger and the request book are rows rather than registry entities, and the leave-type read answers
  a projection — so `paged.over` has nothing to name and no list index is provisioned. The ledger's
  cursor is the `(effectiveDate, id)` pair, because `effective_date` is caller-supplied and an accrual
  dated last year may be written today; the walk is driven in a test rather than asserted as a string.

  ## engine-protocol says what it actually does

  `protocol/list-for-entity` declared `narrows`, which describes a per-row proof walk. It checks ONE
  parent and then queries. It now declares `entityFrom`, which is true, and the kit reports it
  **uncovered with a reason** — the type comes from an open `z.string()`, since an engine cannot
  enumerate its callers' nouns. That is a louder outcome than being out of scope, and it is the
  honest one: a real narrowed check that nothing is driving.

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0

## 0.11.3

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.11.2

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.11.1

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.11.0

### Minor Changes

- 5b7fbc0: A list read declares its filter and sort vocabulary, and the kernel composes the walk
  behind it (#811, K-41).

  K-18 promised _"engine list APIs accept registry-declared filter/sort predicates with
  correct pagination and counts, the kernel composing the join inside the scope DB"_ and
  nothing implemented it. Twelve reads across four engines and four demos answered with whole
  tables, and `engines/*` carried ~36 hand-written `ORDER BY` clauses, none of them
  caller-selectable — so a vertical wanting a different sort had no path but to fork the
  engine, which is the signal CLAUDE.md names as the engine having drawn its line wrong.

  **`paged` is now a union of two halves, not one shape with optional fields.** Declare `over`
  and the kernel composes the `WHERE`, the `ORDER BY`, the keyset comparison, the `LIMIT` and
  the matching `COUNT` from your entity's declared columns — and provisions the indexes behind
  them, which is the reason this is kernel-layer rather than a query helper in contracts. A
  declared filter with no index is a table scan that passes every test and degrades when one
  tenant's table grows. The columns are compile-checked against the entity registry, and the
  manifest fragment the kernel indexes from is _derived_ from the operations
  (`listsDeclaredBy`), the way emitted events already are.

  ```ts
  paged: {
    over: { entity: 'workorder', sortable: ['number', 'status'], filterable: ['status'] },
    order: 'desc',
  }
  ```

  ```ts
  return mapPage(
    ctx.page<OrderRow>("workorder", { ...input, filters }),
    toWorkOrder
  );
  ```

  The kernel returns rows; the projection and any hydration stay yours. This is not a
  generated-CRUD layer — it invents no routes and no handlers. Adoption also _bounded_ three
  N+1 reads: a hydration that ran once per row in the scope now runs once per row on the page.

  **The other half is not a legacy path.** Five reads cannot be kernel-composed and say so:
  `callout/timeline` walks `_substrat_outbox` (a kernel table, not a registry entity),
  `protocol/list-templates` selects through a correlated `MAX(version)` subquery, and three
  portal reads decide visibility by a per-row proof walk. They declare `sortKey`, own their
  `WHERE`, and still page. `pageVisible` is the helper for the permission-filtered case: it
  over-fetches and advances the cursor by the last row **examined**, so rows the walk rejects
  still move it forward. Its pages may come back short, and a short page does not end the
  walk — only the absent `Link` does.

  **Every kernel-composed walk carries a tie-break.** A keyset over a non-unique column drops
  rows — `status > 'open'` excludes its own ties — so the walk runs over `(sortColumn, id)`
  and the cursor is the `|`-joined composite `pagination.ts` had already pinned with nothing
  producing one. That is also why `over.entity` is pointable-only.

  **The gate.** `defineOperations` refuses at module load an operation whose `output` is a bare
  `z.array(...)` with no `paged`. #811 asked for a `lint:model` gate; a tool has to _find_ the
  declarations, and the ones it would have missed are exactly the four engines this issue was
  filed about. At load it reaches every module, and it immediately found two unbounded reads a
  hand survey had missed.

  **The platform supplies the page.** `mountOperations` parses `limit`/`cursor`/`order`/`sort`
  with the one shared schema and merges them into the input, so the default page size and the
  `LIST_PAGE_MAX` ceiling are true of the surface rather than of the operations whose author
  remembered to restate them. An over-limit request is refused, not silently capped — a caller
  handed 200 of the 100 000 they asked for cannot tell a capped page from the end of a walk.

  **Breaking, in process only** — `minor` rather than `major` because these engines are 0.x,
  where semver puts a breaking change, and because `major` would mint 1.0.0 and claim a
  stability milestone the fleet has not declared. The break is stated here instead.

  `workorder/list`, `invoicing/list`, `protocol/list-templates` and
  `protocol/list-for-entity` now return `Page<T>` instead of `T[]`, and
  `listOrders(ctx, status?)` becomes `listOrders(ctx, page)`. Every call site is a compile
  error, which is how all twelve conversions were found. It is **not** a wire break: #829 moved
  the walk to `Link`/`X-Total-Count` headers, so a paged read's HTTP body is still the entries
  array. `getWorkOrder(ctx, orderId)` is new — added because paging exposed two verticals
  reading every row in the scope to `.find` one.

### Patch Changes

- 892d611: Module code gets a clock, and loses the wall clock (#812).

  `OperationContext` had no way to ask what time it was, so module code reached past the
  kernel for one: 95 hand-rolled `new Date()` / `Date.now()` calls across `engines/*` and
  `demos/*`, stamping rows the host could not see. Meanwhile `contracts/ids.ts` described
  the `instant` brand as "stamped kernel-side, never caller-side" — true of events, false
  of every domain row in the repo.

  `ctx.now(): Instant` is that clock, and `boundary-lint` **R6** is what keeps it the only
  one — the same class of ban as R2's `node:*`, and shipped in `@substrat-run/boundary-lint`
  so it enforces on generated and third-party verticals too.

  **It is stable for the whole invocation.** Every call within one operation returns the
  same instant, so two rows written in one transaction cannot disagree about when they were
  written, and an event carries the same instant as the row it describes. That is a promise
  about the value, not an optimisation: it is what a frozen clock rests on. Both hosts stamp
  it once when the context is built, and route `emit`'s `occurredAt` and `requestPlatform`'s
  `requested_at` through the same value.

  **The point is what becomes testable.** The host takes a `clock` (the same seam as
  `fetch`), and `manualClock` / `frozenClock` ship from the kernel. `demos/shop` has the
  worked example: its scenario suite already "covered" hold expiry by passing
  `holdSeconds: 0`, which proves an already-expired hold is swept and nothing about expiry.
  The new `test/hold-expiry.test.ts` holds a unit for its real fifteen minutes, asserts it is
  still reserved at fourteen, and gone at sixteen — with no real time elapsed.

  R6 has a reviewable `boundary-lint-allow R6` … `boundary-lint-end R6` block, because
  unlike R5's one-time handoff there is a recurring legitimate case: a timestamp a _remote_
  clock judges. The three uses in `apps/dashboard` are a GitHub App JWT's `iat`/`exp` and
  two `capturedAt` provenance stamps in host-driving code that has no operation to borrow an
  instant from.

  Timestamps are pinned to ISO 8601 text. The issue expected drift to migrate here; on
  inspection there was none in module code — every Substrat table already stores ISO text,
  and the epoch integers are Better Auth's own schema in `demos/auth-server`, which is that
  library's storage contract rather than ours. Recorded rather than migrated.

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0

## 0.10.3

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.10.2

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.10.1

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.10.0

### Minor Changes

- f6174fb: The error model, phase 2b: every engine refusal now says what kind of refusal it is.

  All 78 `throw new Error(…)` sites across the seven engines carry a taxonomy code —
  `not_found` for a missing entity, `conflict` for a refused state machine or a broken
  invariant, `validation_failed` for malformed input, and `internal` for the two that mean
  corrupt state rather than a caller mistake (`ledger integrity violated`, `signed protocol
has no primary signature`).

  **Not one message changed.** That is the point, and it is what let 78 sites convert
  without touching a single assertion anywhere else: the demo scenarios, the contract
  suite and every regex-matching transport still see the exact strings they saw before.
  The code rides alongside, for whoever asks.

  Why the engines went first: transports reading `code` only pays off if throws carry one,
  and before this exactly ten did. Every conflict, every not-found and every immutability
  violation in the repo was a bare `Error`, so pointing the transports at `code` would have
  found nothing and left their regex tables permanently un-deletable. Engines are also the
  highest value per edit — their throws ARE the invariants, they are the stable surface
  verticals compose against (D-28), and "the state machine refused" is exactly the class
  message-matching guesses at and frequently misses.

  Each engine also declares its own **conflict reasons** — `BOOKING_CONFLICT_REASONS`,
  `PROTOCOL_CONFLICT_REASONS`, and so on — as an `as const` union, exported alongside a
  matching type. All 45 conflict sites raise one, through a local
  `conflict(reason, message)` helper, so a mistyped slug is a compile error rather than a
  string nothing ever matches:

  ```
  conflict('resource_inactve', …)
  → error TS2345: Argument of type '"resource_inactve"' is not assignable to parameter of
    type '"already_joined" | "already_left" | … | "resource_inactive"'
  ```

  A vertical can now branch on WHY a refusal happened — `immutable_after_export` vs
  `currency_mismatch` — without importing the engine's types or matching on its prose. The
  vocabularies are deliberately coarse: thirteen reasons across protocol's twenty-three
  throw sites, one or two for the smaller engines. They are engine surface, so they evolve
  additively like everything else — new reasons may appear, existing spellings do not
  change.

  Reasons are only on `conflict`. `not_found` declares no extensions and `validation_failed`
  carries field issues instead, so neither has anywhere to put one.

  Still bare, deliberately: the ~30 kernel and adapter throws the control plane's
  `STATUS_PATTERNS` already matches (`already taken`, `illegal scope transition`, `not
active`, `unknown tenant/scope/table`). Those are next, and they are the ones that make
  those regex patterns deletable. The remaining ~237 kernel/adapter throws are genuinely
  `internal` and should stay as they are.

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.9.6

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0

## 0.9.5

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.9.4

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.9.3

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.9.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.9.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.9.0

### Minor Changes

- da69ef5: The protocol and invoicing engines declare their operation surfaces, completing
  the set — every engine a vertical composes now publishes what can be done to it,
  so a route binding is a name and a path.

  Callout goes from 12 of its 27 routes derived to 21.

  **engine-protocol** declares all fourteen. Its input schemas move to `inputs.ts`
  and four composite returns become schemas (`signResult`,
  `requestSignaturesResult`, `protocolDetail`, `protocolSummary`), each asserted
  exact against the interface the handler returns in both directions, like the row
  shapes before them. The package's export surface is unchanged: everything moved
  is re-exported from the root, so an import that worked yesterday still resolves.
  One addition, `contentUnion` — the content VALUE a caller receives, as distinct
  from `protocolTemplateContent`, the preprocessing parser that normalises
  discriminant-less legacy rows into it.

  **engine-invoicing** declares its three. The engine is composed by _event_, so
  those three are the whole callable surface and none of them creates anything — a
  basis is built by a consumer, and a test asserts that absence, because a creating
  operation appearing there would mean a second way in past the invariants
  immutable-after-export depends on. Its two read projections are published as
  `underlagListRow` and `underlagDetail`.

  **One finding worth carrying forward.** Typing a handler _from_ its declared
  schema (`z.infer`) looks like a drift check and is not one: a schema that DROPS a
  field the handler still returns goes on compiling, because an object with extra
  properties is assignable to a narrower type. It catches a retyped field and
  misses a missing one — and a schema narrower than the projection publishes a
  contract that omits real data, which is what a UI lane would fork on. Two
  independent descriptions held together by an exactness assertion catch both
  directions; that is the pattern used throughout, and every assertion here is
  mutation-tested.

  **`protocol/list-for-entity` declares `narrows` rather than a leading
  permission.** It checks `protocol:read` against the entity the protocols hang on,
  so the entity's TYPE arrives as data — and a declared entity check must name a
  type known up front. Extending the vocabulary was considered and rejected: a
  declaration that cannot express something is not an argument for a richer
  declaration. `narrows` records the fact that protects anything — this is not a
  node check — and names the walked key, so `protocol:read` still reaches the
  permission review.

  Closes #738 and #739.

- 3b8533d: **zod is now a peer dependency.** Install it alongside these packages:

  ```sh
  npm install zod@^4.4.0
  ```

  Every package here hands out zod schemas that a consumer parses with, composes
  into their own, and that `mountOperations` reads `_zod.def` off to find pinned
  literals. Two copies of zod in one tree means an object made by one is not
  recognised by the other, and the symptom — `expected a Zod schema` — points
  nowhere near the cause. A peer dependency says _use the consumer's copy_.

  The declared range is `^4.4.0` rather than the exact version this repo builds
  against: a peer range should state what the code supports, and pinning it to
  `^4.4.3` would refuse a consumer on 4.4.0 for no reason.

  **A defect this found.** `@substrat-run/contract-tests` shipped **130
  `import("zod")` references in its published `.d.ts` while declaring zod
  nowhere.** It resolved only because contracts had zod as a regular dependency,
  which hoisted a copy into view — not a dependency, a coincidence. It now declares
  it. Two more of the same class turned up when the tree shifted: packages using
  `setTimeout`/`atob`/`btoa` — globals absent from `lib: ES2023` — compiling on an
  ambient `@types/node` nobody had declared.

  That is the general rule now enforced by `pnpm lint:deps`
  (`tools/declared-deps.mjs`) in CI: **every module a package references, in its
  source or its emitted `.d.ts`, must be one it declared.** The `.d.ts` half is the
  sharp one — TypeScript writes the original specifier into declarations however
  the source imported it, so re-exporting `z` through contracts still emits
  `import("zod")` into a dependent's types.

  **Why a lint rather than pnpm's own enforcement**, measured rather than assumed:
  `autoInstallPeers` (pnpm's default) turns a peer conflict into a silent second
  copy — with contracts peer-requiring `^4.4.3` and a consumer declaring `^3.23.0`,
  pnpm reported nothing, and `zod` did not appear once in the peer report even
  under `--strict-peer-dependencies`. And pnpm's peer checking does not reach
  `workspace:` links at all. Full reasoning in `docs/architecture/dependency-policy.md`.

  Internally, shared versions now come from a pnpm `catalog:` so one version is a
  single edit. The `pnpm` settings block moved from `package.json` to
  `pnpm-workspace.yaml`, which is where pnpm 10 reads it — it had been ignored,
  with `overrides` surviving only because they were baked into the lockfile.

  Closes #742.

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.8.0

### Minor Changes

- 19fb697: The workorder engine declares its operation surface, and a route binding becomes
  a name and a path.

  `defineEngineRoutes` shipped taking the input and output schemas from the
  composing vertical, because the engine only expressed them as TypeScript types.
  That meant a vertical wrote a local `z.object({ orderId })` standing in for a
  shape the engine owns — a description held in agreement by nothing — and the
  operation NAME was an unchecked string, since `ModuleRegistration` erases its
  operation keys.

  The engine now declares all eight operations with `defineOperations`, and
  `defineEngineRoutes` is curried against them:

  ```ts
  export const calloutEngineRoutes = defineEngineRoutes(workorderOperations)({
    "workorder/get": { method: "GET", path: "/workorders/{orderId}" },
  });
  ```

  The result MERGES the engine's declaration with the path, so the engine's real
  schemas reach the router and the API document rather than a restatement. Callout
  loses 40 lines of binding.

  `http` is deliberately absent from the engine: it is entity-agnostic and owns no
  URL shape — a bike shop calls the same work order a repair. `createWorkOrder`
  stays an in-scope function rather than an operation, so a vertical can price,
  label and link in one transaction instead of being offered a second way in that
  skips all of it.

  `timeEntry` and `materialLine` are published as Zod schemas rather than
  interfaces, because an operation declaring what it RETURNS needs something to
  point at.

  **Two type-level checks that were decorative, made real.** The path check read
  `PathAgainst<Op, string>`, and `PathParams<string>` is `never`, which vacuously
  satisfies any input — it accepted every path. It now infers the literal. The
  unknown-operation-name check could not be made to bite at all (the constraint is
  self-referential and inference degrades), so it is **not claimed**: it throws
  when the module loads, naming what the engine does declare.

  **And a cycle the permission checkpoint caught.** With the published schemas in
  `index.ts` and `index.ts` re-exporting `operations.ts`, importing the engine ran
  `operations.ts` before `workOrder` was initialised. They now live in
  `schemas.ts`, which both import — the kind of cycle a warm `dist` hides and a
  tool that actually imports the module finds immediately.

  `@substrat-run/engine-protocol` publishes its four row shapes as Zod —
  `protocolTemplateRow`, `protocolResponseRow`, `protocolSignatureRow`,
  `protocolSignatureRequestRow` — each asserted **exact** against the interface the
  handler returns, in both directions. A declared return that drifts from what is
  actually returned is the defect #695 found eleven times, so the assertion is
  mutation-tested: widening either side stops the build.

  Protocol does not yet declare its operations. Doing so needs its input schemas
  moved to a leaf module first — they sit interleaved with the implementation
  across a 2000-line file, and `operations.ts` importing them from `index.ts` while
  `index.ts` re-exports `operations.ts` is a runtime cycle. See #738.

  Progresses #738; unblocks #739.

- 9208b4e: A signature request can carry **how a party is reached** — sealed to the
  connector, never readable in the spine (#687 item 1,
  `docs/architecture/signature-contact-carrier.md`).

  Every external signature this platform has ever sent has failed. The reason was
  not the auth level and never was: `connector-scrive` mapped each party to a role
  label — "Beställare" — and no address, so Scrive answered
  `invalid_invitation_delivery_info` and a document started with nobody to deliver
  it to. `ScriveParty.email` was declared, wired into the provider's `fields`
  array, and filled by nothing. This is its producer.

  **Why it took a design.** The obvious carrier — put the address on the event —
  is unavailable: `protocol.signatures-requested` lands in `_substrat_outbox` and
  `_substrat_platform_requests`, kernel rows a vertical may neither write nor
  erase, so anything a hosted vertical emits in plaintext stays plaintext in copies
  it cannot reach. The next obvious one — seal it under the per-subject keys — is
  impossible rather than merely awkward: those keys live in the directory, and a
  sandbox-clean vertical is architecturally on the far side of that boundary
  (§2 of the design derives it). And reading the contact back at egress deadlocks,
  because a connector runs _inside_ the scope's dispatch and re-entering the scope
  actor wedges it.

  What works is the gap in the middle: a scope may never hold a _secret_ key, and
  nothing says that about a _public_ one.

  - **`sealTo` / `openSealed` in the kernel** — the asymmetric sibling of
    `SecretBox`: ECDH P-256 → AES-256-GCM, a fresh ephemeral keypair per seal, and
    an envelope that is a `SealedSecret` so it carries `keyId`. A cell that cannot
    name its key can only ever have one, and every ciphertext already written
    becomes ambiguous the day a second exists. Rotation is deferred; the envelope
    that permits it is not.
  - **A keypair per connection.** The private half is sealed under the host
    `SecretBox` beside the credential and stored **keyId-indexed from day one**,
    even holding one member — widening a column into a set later is a migration
    against live connections. Minted on first ask, so a connection older than this
    feature acquires one by being asked rather than by being reconnected.
  - **The public half is projected into the scope**, on the channel that already
    carries entitlements, identity links and connection grants — not
    `configureInstance`, because a key in the config bag becomes a key in a
    settings form.
  - **`ctx.sealToConnection(provider, plaintext)`** — awaited _before_ `ctx.emit`,
    so `emit` stays synchronous and D-28 is untouched. **Fails closed and legibly**
    when no key has reached the scope: emitting a request with its addresses
    silently dropped is the invisible failure this exists to end.
  - **`conn.unseal(cell)`** at egress, on the connection for the same reason
    `fetch` and `openAttachment` are — key material never crosses into connector
    code.

  `engine-protocol` gains `partyContact { email?, mobile? }` on
  `signatureRequestParty` and migration `0005-party-contact`, which stores **only
  the ciphertext**. There is no plaintext column to clear later and no erasure
  story to write: the address is unreadable to the spine, to its backups and to
  `sealDump`'s output, because the key that opens it is in the directory.
  `piiClass` therefore stays `'none'` — see the migration's own note for why
  `'pseudonymous'` would be actively wrong rather than more honest.

  **No `personalNumber` field, and its absence is the decision.** #687 measured the
  premise and it is false: what a provider validates is that a BankID party _has_
  the field, not that it holds a value. An optional PII field on an engine surface
  is a carrier that exists.

  Two invariants ship with the carrier, both in `requestSignatures`, both refusing
  before anything freezes:

  - **A party that will be invited must be reachable.** Otherwise the provider
    refuses after the instance has already frozen, leaving an avtal that looks sent
    for signature and is not.
  - **A set with no counterparty is refused.** "The declared primary, else the
    FIRST" is a total function, so a one-party request never failed here — it
    failed at the provider, where that party had been made the _author_, and an
    author is never invited. In production that party was the customer.

  Verified against the Scrive **testbed**, not only the mock: a party carrying an
  address no longer draws `invalid_invitation_delivery_info` at either auth level,
  and a document with one starts and reaches `pending`. The connector tolerates an
  absent contact in both skew directions — an older engine sends none, an older
  connector strips the field — so neither combination is worse than today, which is
  that nothing works.

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.7.3

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.7.2

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.7.1

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.7.0

### Minor Changes

- aaf41b8: **BREAKING:** `foreignChildOf` / `foreignChildren` collapse into `relations`, with both sides checked.

  Those two existed for one reason: a relation edge naming an engine's entity could
  not be checked, so the pair at least made _which half_ was unchecked visible. Now
  that engines export their registries, both halves are checkable and the split has
  nothing left to say.

  ```ts
  ...manifestEntities(handlebarEntities, {
    engines: [protocolEntities, workorderEntities],
    relations: [
      { entityType: 'workorder', parentType: 'bike' },
      { entityType: 'protocol', parentType: 'workorder' },
    ],
  })
  ```

  A typo in either position, in either an engine's name or the vertical's, is now a
  compile error that lists the composed set:

  ```
  Type '"protocl"' is not assignable to type '"bike" | "customer" | "protocol" | "workorder"'.
    Did you mean '"protocol"'?
  ```

  Local-to-local edges stay **derived** from the entities' own `parents` and do not
  belong in `relations` — declaring one twice is how two descriptions of a fact come
  to disagree.

  **Fix:** the engines' entity registries were not exported.

  `protocolEntities` / `protocolInstanceRow` (#712) and `workorderEntities` /
  `workorderRow` (#713) were declared and used internally to derive each engine's
  row type, but never re-exported from the package entry point — so the composing
  vertical they exist for could not import them. They are public now, which is what
  made this change possible at all.

- 701de69: The engine declares its entity, and exports the row schema a vertical needs.

  Two things a composing vertical could not get before:

  **The entity-type constant.** Callout declares `{ entityType: 'protocol',
parentType: 'workorder' }` and Handlebar `{ entityType: 'workorder', parentType:
'bike' }` — permission-walk edges naming entities the vertical does not own. Both
  sides are unchecked strings today, and a typo is a silently dead edge that
  permission never flows along.

  **The row schema.** `output` in a declared operation (#707) is a Zod schema, so a
  vertical operation returning a `ProtocolInstanceRow` would have to transcribe
  this engine's shape into Zod — a description kept in agreement by nothing.
  `protocolInstanceRow` removes the transcription instead of asking every vertical
  to get it right. That is what blocked five of Callout's eleven operations from
  declaring a return.

  `ProtocolInstanceRow` is now **derived** from the registry rather than written
  beside it, so the engine's own row interface and the exported schema cannot
  disagree. Types only — no runtime change, no schema change.

  **One entity, eight tables.** `protocol` is the only thing here the platform can
  point at: attachments hang off it, grants narrow to it, verticals declare
  relation edges to it. Templates, responses, signatures and signature requests are
  rows this engine owns and operates on, never the subject of an `EntityRef`.

  It declares **no `parent`**, and that absence is the design: the engine is
  entity-agnostic, so an instance binds to whatever the vertical says and only the
  vertical knows where protocols hang.

  `test/entities.test.ts` holds the registry to the migration journal — the two are
  descriptions of one schema until migrations are derived from the registry. Its
  parser tracks paren depth so a multi-line `CHECK (...)` constraint is not read as
  a column, and it asserts it parsed something before comparing.

- 4eb532b: The signatory is sent the contract, not an attestation sheet (#711).

  `connector-scrive`'s `create` rendered its own document unconditionally: one page
  naming the template, the parties and the content hash. Honest paper for a
  hash-attestation model, and the wrong paper for a contract — what landed in a
  counterparty's inbox was a list of identifiers, and they were asked to sign it
  with BankID. There was no way for a caller to supply the real one.

  **The seam.** A vertical uploads its rendered document onto the protocol instance
  and names it when binding; the freeze event carries the id; the connector opens it
  and sends those bytes:

  ```ts
  const doc = await attachments.upload({ entity: { entityType: 'protocol', entityId }, … });
  await scope.invoke('protocol/bind-document', { instanceId, contentRef, contentHash,
                                                 documentAttachmentId: doc.id });
  ```

  Bind nothing and today's sheet goes out unchanged, byte for byte — a vertical that
  renders nothing keeps working with no change.

  **By id, never by search.** The return path lands the sealed _signed_ copy on the
  same instance, so a connector that picked "the document on this instance" could
  mail a counterparty their own signed contract to sign again. Naming an id makes
  that unrepresentable rather than merely unlikely, and removes the only real design
  question the issue raised.

  **What the platform was actually missing.** The attachment store has existed since
  #473 and this connector already wrote through it on the return path — but the
  outbound leg needed a read that did not exist, in two different ways:

  - on `adapter-sqlite` a connector runs INSIDE the scope's actor task
    (`dispatchExecutors` is called from within `enqueue`), and every verb of the
    ordinary attachment surface re-enqueues on that actor — so reading from a
    dispatch wedged the scope, silently, forever. `dispatchConnector` does _not_
    enqueue, so a naive implementation works on the routed path and hangs under
    `invoke`/`drainDue`. Pinned in `adapter-sqlite/test/connector-reads.test.ts`.

    The adapter is therefore _told_ which case it is in rather than assuming the
    worse one. Building the read reentrant everywhere would work, and would quietly
    drop the platform-dispatch path out of K-6 serialization: a read on the same
    SQLite connection while another task holds a transaction open sees that task's
    uncommitted rows. There is a test in which the actor is deliberately busy and
    the read must wait for it — that wait is the serialization, made visible.

  - on the hosted Cloudflare path only `upload` crossed the `/internal` connector
    seam, so the control plane held the credential while the vertical held the bytes.

  New in the kernel: **`ScopedConnectorConnection`** — what `ctx.connection(provider)`
  returns inside a dispatch — with **`openAttachment(id)`**: reads only, by id only,
  gated by the target's `readPermission` against that connection's own grants.

  It hangs off the connection rather than the context deliberately, and the first cut
  of this change got it wrong in a way worth recording. Authorizing the read against
  an ambient "the provider this connector is registered under" is a _second name_ for
  the credential the handler already holds, and two names for one fact is how they come
  to disagree: `registerScriveConnector({ id: 'scrive-eu' })` opens its credential as
  `'scrive'` and would have read as `'scrive-eu'` — the egress half kept working while
  every contract's document half failed with `no live 'scrive-eu' connection`. Handing
  the door to whoever holds the credential makes that unrepresentable, and removes the
  ambient-provider plumbing (and a `dispatchConnector` option) entirely. A connection
  reopened _outside_ a dispatch — a credential probe, a poll driver — has no scope to
  read from and stays a plain `ConnectorConnection`, so the type says which is which
  instead of handing out a method that would have to throw.

  `ConnectorDelegation` gains `openAttachment`, backed by
  `GET /internal/connector-attachment/:id` (raw bytes, record in a header — a contract
  is megabytes and base64 in JSON would inflate it for nothing).

  `engine-protocol` gains migration `0004-bound-document` and an optional
  `documentAttachmentId` on `bindDocument`, carried additively onto
  `protocol.content-bound` (with the kernel's own `sha256`), `protocol.signatures-requested`
  and `protocol.signed`. `bindDocument` refuses an attachment that is not on the
  instance being bound — the reconciliation belongs where the document and the hash
  are first named together.

  **Permission diff.** A connection now needs `protocol:read` to send the vertical's
  document. Meridian's `connectScrive` grants it, and also `protocol:attach`, which
  was missing — the sealed-copy landing has been failing there and reporting itself
  as a `skipped` reason rather than an error, so nobody was told.

  **Not a silent fallback.** A named-but-unreadable document is a hard failure. Once
  a vertical has said which bytes its signatory must see, substituting other paper is
  quieter than a refusal and worse, because a document still goes out and someone
  still signs it. The dispatch dead-letters; the ledger row is written only after
  `start`, so the retry after the fix sends the right document.

  `engine-test-kit` gains an opt-in `attachments` option — an engine's declared
  `attachmentTargets` could not be exercised there at all before, because the
  harness's scope had no vertical and so no blob store.

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.6.3

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.6.2

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.6.1

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.6.0

### Minor Changes

- 181e69b: fix: the signature request chooses how a party authenticates — `se_bankid` is no longer hardcoded

  Every document `connector-scrive` had ever sent was refused by Scrive:

  ```
  scrive start failed: HTTP 409
  Authentication to sign for participant #1 requires valid personal number field.
  ```

  The connector picked the authentication method from the party's `kind` — `se_bankid` for any
  external signatory — and Scrive's BankID auth-to-sign will not start without a `personal_number`
  on the party. Substrat deliberately supplies none: a party's `ref` is an opaque `DataSubjectId`
  because design rule B6 says a personnummer never reaches the kernel, the events or the audit
  trail. So the connector demanded something the caller could neither see nor satisfy, and a
  production tenant lost a fortnight of contracts to it.

  - **`signatureRequestParty.authLevel`** — `basic` (the provider establishes control of a contact
    address) or `strong` (a national eID), defaulting to `basic`. Deliberately _not_ the provider's
    vocabulary: `se_bankid` is Scrive's word and belongs in the connector that speaks to Scrive,
    or an engine serving several providers would be handing verticals one provider's enum. Stored
    nullable (migration `0003-party-auth-level`) so rows written earlier read as the default, and
    resolved onto `protocol.signatures-requested` so no consumer re-derives it.
  - **`ScriveConnectorOptions.defaultAuthMethod`** — what `basic` means for this connection,
    `'standard'` by default. That default is the fix. A deployment that supplies personal numbers
    by other means can set `'se_bankid'` and keep the old behaviour deliberately.
  - **`strong` is refused before any egress**, with a sentence naming why it cannot be satisfied,
    instead of being sent for Scrive to answer with a bare `409` that reached nobody. The
    resolution happens _before_ `documents/new`, so a refusal leaves no orphan draft at the
    provider — the earlier draft of this fix threw while building the `update` body, and a
    retrying delivery would have littered one document per attempt.

  Callers need no change: a party that says nothing gets `basic`, which is what `standard` already
  meant for principals. **What this does not do** is carry a party's contact detail (ask 1 of the
  issue) — that needs a lawful carrier for direct PII from module code to a connector, which does
  not exist and is tracked separately. Until it does, `strong` is reachable only by a deployment
  supplying personal numbers by other means.

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.5.21

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.5.20

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.5.19

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.5.18

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.5.17

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.5.16

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.5.15

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.5.14

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.5.13

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.5.12

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.5.11

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.5.10

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.5.9

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.5.8

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.5.7

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.5.6

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.5.5

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.5.4

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.5.3

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.5.2

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.5.1

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.5.0

### Minor Changes

- b0355b4: Connectors can land attachments; Scrive lands the sealed signed PDF (#476 step 2).

  #473 gave attachment bytes a home, but its `attachments()` surface is minted per
  `PrincipalId` — and a connector's return path acts as a _connection_, not a person,
  so it had no way to store a provider artifact (bytes cannot ride `getConnectorScope`'s
  `invoke` pipe). This adds the missing seam and the first consumer:

  - **`ScopeHost.getConnectorAttachments(connectionId, scopeId)`** — the mirror of
    `getConnectorScope` for bytes: the same `ScopeAttachments` surface, same
    (tenant, vertical, active) door, but every gate checked against the connection's
    `connection:<id>` grants, and `createdBy` attributed to the connection. Implemented
    in both adapters (the Cloudflare ScopeDO threads the connection subject through the
    attachment gate exactly as `invoke` does) and covered on each.
  - **`engine-protocol`** declares an explicit `protocol:attach` write permission on its
    `protocol` attachment target (read stays `protocol:read`). A signing connection is
    granted `protocol:attach` and nothing else — it can land the sealed PDF but not
    browse the scope's attachments. No human role holds it yet.
  - **`connector-scrive`** fetches `files/main` once the document is `closed` and every
    party is recorded, and lands it as a `customer`-visible attachment on the protocol
    instance. Marked in the dispatch ledger (`sealedAttachmentId`) so a re-poll never
    downloads or stores a second copy; a store that is not yet provisioned is reported
    and retried next poll, never allowed to undo a recorded signature.

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.4.33

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.4.32

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.4.31

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.4.30

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.4.29

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.4.28

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.4.27

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.4.26

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.4.25

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.4.24

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.4.23

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.4.22

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.4.21

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.4.20

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.4.19

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.4.18

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.4.17

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.4.16

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.4.15

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.4.14

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.4.13

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.4.12

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.4.11

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.4.10

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.4.9

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.4.8

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.4.7

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.4.6

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.4.5

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.4.4

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.4.3

### Patch Changes

- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.4.2

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.4.1

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.4.0

### Minor Changes

- 3336a17: **engine-protocol: signed documents and asynchronous, non-principal signatures.**

  The engine covered checklists signed in-app by the authenticated principal, now. It now
  covers documents the engine never sees, signed asynchronously by parties who may have no
  account at all — which is what a BankID/Scrive flow actually is.

  **Freezing is now a transition separate from signing.** This closes a real defect rather than
  adding a feature: freezing used to be a side effect of `signProtocol`, which was sound only
  because signing is synchronous. Anything asynchronous left the instance `open` — and
  therefore writable — for the entire time it sat at a provider, so the document a signatory
  saw could drift from the content that was hashed, with nothing detecting it. That affected
  checklists signed with BankID exactly as much as contracts.

  New state machine:

  ```
  open ──requestSignatures──> pending_signature ──all parties signed──> signed
    │                                │
    │                                └── cancelSignatureRequests ──> open (renegotiate)
    └──signProtocol (in-app)──────────────────────────────────────> signed
  ```

  - **`protocol_signature_requests`** — the missing noun. One row per party a document was sent
    to. Makes multi-party expressible: an instance reaches `signed` only when _every_ requested
    party has signed, and a declined request is not completion.
  - **Signatories are data, not context** — `{ kind: 'principal', ref: PrincipalId } | { kind:
'external', ref: DataSubjectId }`. The external form follows `engines/booking`'s `partyRef`:
    opaque and shreddable, so crypto-shredding can key erasure on someone with no principal.
    `method` and `evidence_ref` were reserved columns no code path could write; they now have one.
  - **Two content kinds** — `checklist` (unchanged) and `document`, whose content lives in the
    vertical and reaches the engine only as `(contentRef, contentHash)`. Modelling a contract as
    a degenerate one-item checklist was rejected: the engine would attest to the sentence "I
    accept this contract" and nothing else.

  Backward compatibility: the checklist hash recipe is byte-identical, and no stored
  `content_json` is rewritten (the hash covers that string verbatim), so **every signature made
  before this change still verifies**. Templates predating the `kind` discriminant parse as
  checklists. Migration `0002-signature-requests` rebuilds the three data tables and backfills
  `frozen_hash` from each instance's earliest signature; the upgrade path is covered by a test
  that starts a scope on `0001`, writes 0001-era rows, and brings the real migration list to it.

  New permission keys: `protocol:bind`, `protocol:request-signature`,
  `protocol:record-signature`. All three are held by **no role** in any demo — the third
  deliberately so, since it speaks for an external provider rather than for a person.

  Not built, and now tracked: webhook ingress (#96) and an inbound authority seam that would let
  a provider callback invoke a scope operation (#97). Both gaps are in the kernel, not the
  engine. `recordSignature` is shaped to be callable by that ingress when it lands.

  `@substrat-run/engine-test-kit`: `EmittedEvent` now exposes `piiClass` and `subjectId`, so a
  test can assert that an event names a data subject who is not the acting principal.

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.3.6

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.3.5

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.3.4

### Patch Changes

- 40bbbcb: English vocabulary on the published surface. The invoicing engine's permission
  descriptions now read `Read invoice bases` / `Export an invoice basis (makes it
immutable)` instead of naming the Swedish _fakturaunderlag_, and the protocol
  engine's README says "self-inspection" rather than _egenkontroll_.

  Permission **keys** are unchanged (`invoicing:read`, `invoicing:export`) — this is
  description text only, so nothing to migrate. The engines' README keeps the Swedish
  term as a parenthetical gloss where it documents the domain it was extracted from.

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.3.2

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0

## 0.3.0

### Minor Changes

- 5dd4085: Zod 4, and `contracts` re-exports `z` — closing a live from-scratch trap

  **The trap.** The published packages depend on `zod ^3.25.0` while `pnpm add zod`
  — which getting-started told users to run — installs Zod 4. pnpm resolves both:
  Zod 3 nested for our packages, Zod 4 for the user. Two copies, both "correct".
  Zod schemas do not compose across majors, so the moment a user wrote the pattern
  CLAUDE.md mandates ("operation inputs go through Zod schemas at the boundary")
  composing a contracts schema into their own —

                                                                                                                                                                                        z.object({ facility: entityRef, unitPrice: money })

  — it failed at RUNTIME with `Invalid element at key "facility": expected a Zod
schema`, an error pointing nowhere near the cause. Not an exotic pattern: it is
  what `engines/workorder` itself does (`unitPrice: money`, `facility: entityRef`),
  so anyone copying the reference hit it immediately. Found by building a vertical
  from scratch against the published packages — the flow the docs describe and
  nobody had walked.

  **Two fixes, because they solve different halves.**

  1. **Zod 4 everywhere.** Aligns with what the ecosystem installs by default, so a
     user who reaches for `zod` gets our major. No code changes were needed — the
     schema subset in use (`z.object`, `.regex`, `.brand`, `.min`, `.optional`,
     `z.infer`) is stable across the major, and the one `z.record` was already the
     2-arg form Zod 4 requires. Build, typecheck, and the full suite pass unchanged.
  2. **`contracts` re-exports `z`.** The durable half: importing `z` from
     `@substrat-run/contracts` means the consumer never installs zod at all, so the
     versions cannot diverge. Fix 1 makes the trap dormant; fix 2 keeps it dormant
     when Zod 5 ships.

  `zod` is dropped from the getting-started install line; docs and the `substrat`
  skill both import `z` from contracts.

  **Breaking for consumers on Zod 3** — deliberately taken now, while there are
  effectively none, rather than later when there are.

  **Still open:** making `zod` a `peerDependency`. Contracts' schemas are part of
  its public API — consumers are meant to compose them, so their copy must be ours
  — which is textbook peer. As a plain dependency it nests silently instead of
  failing at install. Left as a separate call.

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0

## 0.2.0

### Minor Changes

- 604883b: Manifest-declared operation guards and operation withdrawal — compliance gates a reviewer can enumerate.

  A vertical declares an unconditional gate in its manifest (`guards: [{ before, predicate, config }]`); a module contributes the named predicate (`predicates` on `ModuleRegistration`, typed `GuardPredicate`); the kernel evaluates it inside the guarded operation's own transaction, before the handler, failing closed. `withdraws` lets a vertical suppress an engine's default operation binding so the guarded wrapper is the only door — without it a gate is reviewable but bypassable. Both are optional and additive: existing manifests parse and behave unchanged.

  The protocol engine gains a `protocol/all-signed` predicate and the `requireCountersigned` in-scope function; the work-order engine exports `closeWorkOrder` as an in-scope function (its `workorder/close` operation is now the thin binding). The scope-host contract suite covers guards and withdrawal, so every adapter must implement both.

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0
  - @substrat-run/kernel@0.2.0
