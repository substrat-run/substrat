# @substrat-run/engine-metering

## 0.4.3

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.4.2

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

## 0.4.1

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.4.0

### Minor Changes

- ec1f8e8: The last three packages declare their operation surface, so no entity-check claim is a grep

  #865 asked for the entity-check conformance kit to reach fourteen packages, and #891 split
  out the half where the recipe did not apply: a package with no declared operation registry
  has nothing to convert. #891 closed five of them. These are the last three.

  `engines/invites`, `engines/metering` and `demos/manyfold` each gain a declared operation
  surface (`src/operations.ts`, plus an entity registry for metering and a `schemas.ts` for
  manyfold), and their node-only assessment moves from `nodeOnlySuite` to
  `declaredNodeOnlySuite`. The difference is what the claim is made OF:

  - **Before:** a tripwire over the module's own source — no two-argument `ctx.check(perm,
ref)` appears in it. Lexical. It proves an absence rather than a behaviour, and a check
    assembled through a helper or across lines is invisible to it.
  - **After:** `planEntityCheckCoverage` reads the declaration the same way the conformance
    kit does, and the claim is that the plan is empty. Exact. It goes red when an operation
    DECLARES a narrowed check, not when someone happens to spell one on one line.

  Each also gains the assertion that is easy to leave out — every operation still says what
  it checks, because an ungated operation produces an empty plan too. `invites/accept` is
  the one operation in the three that genuinely checks nothing (the invitation itself is the
  authority) and it now declares `narrows` with the reason, so the exception is written down
  rather than indistinguishable from an oversight.

  That exception needed one new word to state. `narrows.checks: []` already meant "no key of
  MINE is walked", which is also true of a walk over a composed engine's key — Callout's
  portal walk checks `workorder:read`, and a vertical restating another module's permissions
  is the defect the empty list exists to avoid. So a genuinely ungated operation adds
  `narrows.unchecked: true`, and the conformance receipt counts it on its own row instead of
  reporting "1 per-entity proof walk" under a header counting zero narrowed checks.

  Two consequences beyond the assessment: the host now parses these operations' inputs at
  the door (#893) from the same schemas the handlers already parsed, and a vertical
  composing invites or metering can declare an operation returning their shapes without
  transcribing them.

  `nodeOnlySuite` stays exported for a module that has not declared yet — a vertical
  mid-build, a module outside this workspace — with its header corrected: no package in this
  repo needs it any more.

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.3.9

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.3.8

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

## 0.3.7

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.3.6

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.3.5

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.3.4

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

## 0.3.3

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.3.2

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.3.1

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.3.0

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

## 0.2.6

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0

## 0.2.5

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.2.4

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.2.3

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.2.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.2.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.2.0

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

## 0.1.7

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

## 0.1.6

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.1.5

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.1.4

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

- f4529ed: `engine-metering` v0 (#646): the billable-usage ledger. D-31 deferred metering
  "until a vertical meters something" — the builder token economy is that trigger.
  The engine owns an append-only usage ledger over configured meters (kind/unit
  frozen after creation), idempotent ingest keyed by `(meter, dedupeKey)` (a
  replayed turn can never double-bill; a reused key with a different qty throws),
  the counter/gauge aggregation split (counters sum signed deltas; gauges take
  max-in-window and carry their level across silent windows), and an append-only
  period-close journal whose latest `to` is a hard horizon no new entry may land
  behind — closed periods stay reproducible from their entries forever.

  `closePeriod` emits one fat `metering.period-closed` event with **unpriced**
  lines (`{meterKey, kind, unit, qty, entryCount}`): pricing is vertical
  vocabulary, and the vertical feeds invoicing exactly like the
  `timesheet.period-closed` hand-off. This is the _billable_ metering plane;
  platform metering stays Analytics Engine (D-46 pattern) — two planes, kept
  separate on purpose (`docs/engines/metering.md`).
