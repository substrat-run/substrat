# @substrat-run/engine-absence

## 0.5.10

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
- Updated dependencies [ee70af5]
  - @substrat-run/contracts@0.98.0
  - @substrat-run/kernel@0.98.0

## 0.5.9

### Patch Changes

- Updated dependencies [9fcfebc]
- Updated dependencies [59121f6]
  - @substrat-run/contracts@0.97.0
  - @substrat-run/kernel@0.97.0

## 0.5.8

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0
  - @substrat-run/kernel@0.96.0

## 0.5.7

### Patch Changes

- 301ac66: absence, invites, metering and protocol now emit a checked-in `model.json`, so
  `lint:model --check` covers all seven engines instead of three — a changed table or a
  renamed field on any of them has to appear in a PR diff. Three declarations gained a
  constraint the shipped DDL already had, so the artifact records it rather than freezing
  the omission: `absence-leave-type` and `metering-meter` declare the primary key they are
  keyed by, and `metering-entry` declares the `(meter_key, dedupe_key)` unique key its
  dedupe replay relies on. No migration, no DDL change, no runtime behaviour changes.
- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0
  - @substrat-run/kernel@0.95.0

## 0.5.6

### Patch Changes

- b91753e: Each engine now states in its own header whether it is composed by call or by event, and
  what follows from that — which functions a vertical imports, and why the registered
  operations are the default bindings rather than a second way in. Only invoicing said so
  before; the fact was scattered across `lifecycle.ts`, `operations.ts` and the docs, and two
  engines said it nowhere. Comments only, no behaviour change.
- 3e7445e: The workorder, absence, invoicing and protocol engines now hand the host their declared
  operation inputs, so every invocation is parsed against the engine's own schemas before
  the guards and the handler — on every path in, not only over HTTP. Unknown keys are
  dropped and a declared field arrives with its declared type, which is what the four
  engines' handlers had been assuming without checking.
- 568ba88: The engine seam helpers now have one home. `returns(schema, surface, value)` and
  `columnsOf(schema)` — the pair that parses a value on its way out of an engine and
  derives a SELECT list from the published schema — are exported from
  `@substrat-run/contracts` as `engineSeam(name)`, and an engine binds them to its own
  name in a line. Four engines carried byte-identical copies of the implementation,
  differing only in the name each put into a seam failure. Behaviour is unchanged,
  including the message a seam refusal carries.
- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [1fc01d3]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0
  - @substrat-run/kernel@0.94.0

## 0.5.5

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.5.4

### Patch Changes

- 9f1018e: engine-absence: the seam is parsed, not asserted (#771).

  Every row this engine publishes now goes through the schema it publishes — a leave
  type, a ledger entry, an absence request, and each `delta` the balance fold sums —
  and no read is `SELECT *`: the column list is derived from the row schema, so a
  column dropped upstream is a SQL error naming itself and a column added upstream is
  never read. Behaviour-preserving for a caller against a matching version; a caller
  running against a drifted table now gets an `internal` throw at the seam instead of
  wrong data on a screen.

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

## 0.5.3

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.5.2

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.5.1

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.5.0

### Minor Changes

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

## 0.4.7

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.4.6

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.4.5

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.4.4

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

## 0.1.3

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.1.2

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.1.1

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.1.0

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
  (`docs/engines/absence.md`; the entry ledger is deliberately
  engine-private, not a kernel primitive — D-A).

  Meridian adopts it in the same change: `0003-absence-to-engine` R5 extraction
  handoff moves `hr_absence_ledger`/`hr_leave_requests` into the engine's tables
  (subject = the `('employee', id)` ref, `data_subject_id` = the employee id the
  hr.\* spine already shreds on), the absence operations become compositions of
  the engine's in-scope exports behind the unchanged HTTP surface, and the
  `absence:*` permission keys — same strings as ever — are now declared by the
  engine. The absence events move to the engine's `absence.*` vocabulary, and
  stale-leave expiry is attributed to `{ system: '@substrat-run/engine-absence' }`.
