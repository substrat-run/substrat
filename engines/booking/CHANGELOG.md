# @substrat-run/engine-booking

## 0.7.0

### Minor Changes

- 79f9946: `now` is no longer an operation input (#961). Every declared booking input — hold,
  confirm, expire, join, leave, open, move, get, list, availability — used to accept an
  optional `now` that the engine preferred over `ctx.now()`, so a caller holding
  `booking:confirm` could confirm an expired hold by back-dating it, or sweep a live one
  by post-dating it. The wire schemas drop the field and the host's input parse strips
  it; the in-scope functions keep `now?` (`holdReservationCall`, `joinReservationCall`,
  `moveReservationCall` are the wire inputs plus `now`, and `HoldReservationInput` /
  `JoinReservationInput` / `MoveReservationInput` still name that shape), so a vertical
  composing by call and a test still choose the instant. `reservationAtInput` is now a
  deprecated alias of `reservationIdIn`.

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.6.5

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

## 0.6.4

### Patch Changes

- d8a4464: The booking seam is parsed, not asserted (#771)

  Every resource, reservation, participant and free interval this engine publishes is now `.parse`d by the schema it publishes on the way OUT — the same schema a composing vertical declares its operation `output` with — and every read names its columns instead of `SELECT *`. A stored row that no longer matches the published shape (a column retyped, dropped or made nullable by a later engine version under a vertical compiled against an earlier one) is an `internal` throw at the seam rather than wrong data on a screen; a column added upstream never crosses it. Behaviour-preserving for every row that matches, which is every row a released migration produces. Same mechanism as `engines/workorder` (`src/seam.ts`).

  - @substrat-run/contracts@0.91.1
  - @substrat-run/kernel@0.91.1

## 0.6.3

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.6.2

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.6.1

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.6.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0

## 0.5.3

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.5.2

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.5.1

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.5.0

### Minor Changes

- 01547b0: Booking's state machine is declared (#844).

  The seven reservation states were written out twice — as the `state` column's `z.enum` in
  `entities.ts` and again as `reservationState` in `index.ts` — and the edges between them a
  third time, as whatever states each of nine `requireState` call sites happened to pass.
  `reservationState` is now taken from the entity registry, and the machine is declared with
  `defineLifecycles`.

  **The format needed no changes**, which was the point of adopting the hardest case second.
  Three findings, all expressible as they stand:

  - **Three of the nine guards are not transitions.** `join`, `open` and `move` are legal in
    `held` or `confirmed` and move nothing — `allow`, not `on`. Declaring them as edges would
    have put three self-loops on the diagram that no code performs.
  - **A join that fills the last place still isn't an edge.** It ends confirmed, but the move
    belongs to `booking/confirm`, the in-scope function it composes, and goes through the same
    check on the way. `join → confirmed` would claim every join confirms.
  - **Lazy expiry is not an edge.** `held → expired` is one (`booking/expire` performs it);
    the _lapse_ is not. The guard runs on the stored state, so a lapsed hold is still refused
    by `confirm` with its own `hold_expired` reason rather than being flattened into
    `invalid_transition`.

  `BOOKING_CONFLICT_REASONS` now references the shared `INVALID_TRANSITION` constant, since
  that reason is raised by `assertTransition` rather than by this engine.

  Behaviour unchanged: 55 tests pass untouched, and no migration — the state set is the same.

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

## 0.4.3

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.4.2

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.4.1

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.4.0

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

## 0.3.6

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0

## 0.3.5

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.3.4

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.3.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.3.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.3.0

### Minor Changes

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

## 0.2.3

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

## 0.2.2

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.2.1

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.2.0

### Minor Changes

- eddd3c5: The last three engines declare their entities. All seven now have registries.

  A vertical composing any of them can name its entity types in a checked relation
  edge, and declare an operation's `output` against a real schema instead of
  retyping the engine's shape.

  Each surfaced a different shape, which is why they were worth doing rather than
  assuming:

  **booking has TWO entities and the first parent edge INSIDE an engine.** Everywhere
  else the parent is the vertical's noun, so engine registries declare none — but a
  reservation cannot exist without the resource it reserves, and that is true in
  every vertical. `booking_participants` stays out: a join row, not an entity.

  **invites has a row-versus-published split, for privacy.** `identifier_hash` is
  stored and deliberately never published — hashing the invitee's identifier is
  pointless if the row is returned. So the registry describes the row (what the
  journal comparison checks), `invitationRow` is that, and `invitation` is the
  projection an operation may return. It is also declared `erasable`: destroying
  the hash is what unlinks an invitation from the person.

  **absence has the same split for a duller reason** — SQLite has no boolean, so the
  row stores `active` as 0/1 while `LeaveType` publishes a boolean in camelCase.
  Its ledger and requests are rows the engine owns; only the leave TYPE is
  something the platform points at.

  That is three engines in a row where the stored row and the published type differ,
  after `engine-workorder` made the same distinction. A vertical wants the published
  one for an operation's `output`, and each engine now says which is which.

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.1.63

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.1.62

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.1.61

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.1.60

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.1.59

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.1.58

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.1.57

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.1.56

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.1.55

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.1.54

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.1.53

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.1.52

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.1.51

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.1.50

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.1.49

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.1.48

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.1.47

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.1.46

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.1.45

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.1.44

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.1.43

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.1.42

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.1.41

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.1.40

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.1.39

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.1.38

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.1.37

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.1.36

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.1.35

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.1.34

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.1.33

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.1.32

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.1.31

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.1.30

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.1.29

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.1.28

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.1.27

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.1.26

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.1.25

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.1.24

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.1.23

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.1.22

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.1.21

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.1.20

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.1.19

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.1.18

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.1.17

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.1.16

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.1.15

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.1.14

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.1.13

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.1.12

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.1.11

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.1.10

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.1.9

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.1.8

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.1.7

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.1.6

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

## 0.1.5

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.1.4

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.1.3

### Patch Changes

- e930aef: `effectiveState` is computed from the injected clock, never wall time.

  `toReservation` defaulted `now` to `new Date().toISOString()`, so every caller that
  forgot to pass the clock it had been handed silently used wall time instead. The engine
  takes an explicit `now` precisely so behaviour is deterministic; the default quietly
  opted out of it.

  This is invisible until real time crosses a boundary the test data assumed, and then it
  reads as flakiness rather than a bug — the suite went red hours after it was last green,
  with nothing changed.

  `now` is now required, so the compiler finds every caller. That turned up four
  operations with no clock at all (`cancelReservation`, `startReservation`,
  `completeReservation`, `markNoShow`); each takes an optional `now` like its siblings.

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.1.2

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.1.1

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.1.0

### Minor Changes

- d75814c: New engine: reservations as **allocation against capacity over an interval**.

  The platform's second invariant shape. Where `engine-workorder` is a state
  machine, a reservation is an allocation, and the thing that must never happen is
  two parties holding the same resource at the same time.

  **What it owns**

  - **No overallocation.** The sum of live allocations against a resource never
    exceeds its capacity over any instant. Exclusive booking is capacity `1`;
    above 1 is for fungible pools where nobody cares which unit.
  - **Half-open intervals** — a booking ending at 19:00 and one starting at 19:00
    do not collide.
  - **Holds with lazy expiry.** `held` requires an `expiresAt`; a lapsed hold stops
    counting without anyone sweeping it, so nothing breaks if a sweeper never runs.
  - **A state machine that cannot skip**, and append-only participants.

  **No locking code, and none needed.** The allocation check is a plain
  read-then-write, correct because a scope is a single Durable Object — one
  serialization domain, one writer. The consequence is a hard scoping rule: a
  resource's entire calendar must live in one scope. SQLite has no exclusion
  constraint, so the guarantee comes from the serialization domain rather than the
  database.

  **Deliberately absent:** timezones and calendar arithmetic (it takes absolute
  instants), pricing, and policy of any kind. It knows only _fill target_ and
  _deadline_.

  Notable surface decisions:

  - `move`, not a generic `update` — rescheduling keeps identity, roster and
    payments, and re-runs the allocation check excluding itself so nudging a
    booking that overlaps its own old slot is legal.
  - `open` sets a fill target on a reservation that already exists, so a private
    booking can be put on offer. `fillTarget` drives the auto-confirm, so it is
    engine state rather than something a vertical can keep beside it.
  - `availability()` returns free **intervals**, not slots: with mixed durations
    there is no canonical slot list.
  - Reservations carry `effectiveState` beside `state`, because lazy expiry is
    right for allocation and wrong for display.
  - Aggregate events carry `participantCount` and no identities; the roster travels
    on per-participant events keyed to their data subject, so a business record
    survives an erasure while the personal link is shreddable.

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
