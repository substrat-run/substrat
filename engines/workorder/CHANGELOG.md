# @substrat-run/engine-workorder

## 0.10.1

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.10.0

### Minor Changes

- d9793bc: `assignWorkOrder`, `startWorkOrder`, `reportTime` and `reportMaterial` are exported in-scope functions (#975). They used to live inline in the `workorder/assign`, `workorder/start`, `workorder/report-time` and `workorder/report-material` handlers, so a vertical could not assign, start or report inside its own transaction without forking the engine. The four operations are now thin bindings — the permission check plus one call — and their behaviour and event payloads are unchanged. Each function's input is the schema its operation declares (also exported: `assignWorkOrderInput`, `startWorkOrderInput`, `reportTimeInput`, `reportMaterialInput`), parsed on the way in.

### Patch Changes

- 7ad9ec8: `workorder/start` declares `workorder:report` — the key its handler has always checked — instead of `workorder:assign` (#960). The declaration is what the conformance receipt, `lint:permissions` and a vertical's `defineEngineRoutes` binding read, so a role widened to `workorder:assign` on its strength could not start work. No permission key or handler changed; `test/permissions.test.ts` now holds every declared permission to the one its handler checks.
- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

## 0.9.2

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.9.1

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.9.0

### Minor Changes

- 73710de: Engine return values are parsed at the seam, not just inputs

  "Parse, don't trust" was enforced in one direction. Operation inputs go through Zod at the
  boundary; **return values crossing the engine seam were trusted because TypeScript said
  so** — and TypeScript is not there at runtime. `createWorkOrder` parsed on the way in and
  returned a hand-written mapper's output; `getReportedLines` was sharper still, a
  `SELECT * FROM workorder_time_entries` typed `<TimeEntry>` by assertion, so its return
  shape was _whatever the table currently held_.

  The failure that lets through is precise, and it is the one D-28's additive-only rule
  exists to prevent: a vertical compiled against engine 0.3, running against engine 0.4,
  whose row shape moved. The vertical reads a field that is now `null`, or misses one that
  appeared, and the first symptom is **wrong data on a screen — not a thrown error**.

  `engines/workorder/src/seam.ts` is the runtime half of that rule, and this engine is the
  reference conversion:

  ```ts
  returns(workOrder, `work order ${r.id}`, { … })   // parsed on the way OUT
  `SELECT ${columnsOf(timeEntry)} FROM workorder_time_entries WHERE …`
  ```

  - **`returns(schema, surface, value)`** parses every published value with the same schema a
    composing vertical declares its operation `output` with. The refusal is `internal`, not
    `validation_failed`: the caller's input was already parsed, so a 400 would blame the
    caller for a fault on this side — and `toProblem` drops `internal`'s detail, so the
    drift is logged rather than handed to a client that can do nothing with it.
  - **`columnsOf(schema)`** derives each `SELECT` list from the schema being read, so a read
    asks for exactly the columns the seam promises. A column dropped from the table is then
    a SQL error naming it; a column added upstream is simply never read.

  Two open questions the issue left, decided the boring way. **Parse always**, bulk reads
  included — every read here is one row or one page (#811), and dev-only validation would be
  absent exactly where the version skew lives, in production against an engine nobody in
  this repo deployed. **A helper, not a convention** — one spelling, one call site per
  surface, and a shape `boundary-lint` could later be taught to require.

  `test/seam.test.ts` proves it by moving the tables under a running engine: dropping
  `technician`, making it nullable, retyping `number`. Each one throws at the seam instead of
  surfacing as wrong data, and the page walk parses every entry rather than the first read.
  The other six engines are not converted; their seams are still typed by assertion.

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.8.4

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

## 0.8.3

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.8.2

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.8.1

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.8.0

### Minor Changes

- 716a9df: An entity's state machine is declared in the model (#844).

  Six entities across four engines and two demos carry a `status` enum, and every one of
  them described its transitions a second time — as hand-written guards in operation bodies,
  held to the enum by nothing. `engine-workorder` restated the machine at six call sites;
  `engine-booking` does not even hold the state _set_ in one place, writing its seven values
  out twice as two independent `z.enum` literals.

  `defineLifecycles(entities, operations)` is that machine, declared once. The compiler
  checks it against both things it names: a state the column cannot hold, a value the column
  _can_ hold with no state declared for it, an edge to nowhere, or an operation the module
  does not declare are all refused. `assertTransition` replaces the hand-written guards and
  throws the platform's own `conflict` with `reason: 'invalid_transition'`.

  **What it deliberately cannot say.** No actions, no effects, no `context`, no parallel
  regions, no timers, no expression language. An edge names the operation that performs it
  and stops; the operation keeps its body. Durable execution stays where it is. Guards stay
  in the manifest where K-38 put them — every edge names its operation, so the emitters
  _join_ guards onto edges rather than making anyone declare them twice.

  Two things this unblocks. `extensible` is K-17's `extensibleStates`, which kernel-design
  §7.5 has specified since July while `substates` appeared in zero `.ts` files — there was no
  state-machine declaration for the mark to live on. And a widened state machine now lands in
  a reviewed artifact: `pnpm lint:model` emits the machine into `model.json` (now including
  `engines/*` that opt in via `src/model.ts`), and CI re-emits with `--check`, so a
  redirected edge has to appear in a PR diff the way a widened role already does.

  `model-emit` gains `emitXState`, a one-way render to an XState v5 config — for diagrams,
  and as a test oracle, with `xstate` never leaving devDependencies.

  `engines/workorder` is the adopter, behaviour unchanged. Booking, protocol, invoicing,
  manyfold and shop are the queue.

  This **reverses a published position** (K-40): `apps/docs/concepts/model.md` listed state
  machines under _Prose_ and said _"if you find yourself inventing a way to declare a state
  transition, the boundary has slipped."_ The boundary had not been holding — it was being
  redrawn at every call site.

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

## 0.7.3

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.7.2

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.7.1

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.7.0

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

## 0.6.6

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0

## 0.6.5

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.6.4

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.6.3

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.6.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.6.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.6.0

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

## 0.5.0

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

## 0.4.3

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.4.2

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.4.1

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.4.0

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

- b9dbda9: **BREAKING:** `EntityDef.parent` becomes `parents`, and takes an array.

  `entityRelations` is an **allowlist, not an assertion**. The kernel accumulates
  permitted parents into a _set_ per entity type
  (`adapter-sqlite/src/index.ts:1348-1352`) and `ctx.link` checks membership — so an
  entity legitimately has more than one, and two already do:

  | entity        | parents                 | declared by                 |
  | ------------- | ----------------------- | --------------------------- |
  | `reservation` | `resource`, `member`    | engine-booking, rally       |
  | `protocol`    | `workorder`, `employee` | callout/handlebar, meridian |

  Singular `parent` said _"the parent"_, which is not what the kernel means and
  cannot express those. It had not bitten only because each parent is declared by a
  different module, so no single registry needed both.

  Renamed rather than widened to `Names | readonly Names[]`: a union leaves
  consumers handling two shapes forever, and the plural name is the one that is
  true. Migration is mechanical — `parent: 'customer'` → `parents: ['customer']` —
  and the emitted `model.json` carries an array now, so the artifact of record has
  one shape for anything reading it.

  ***

  **engine-workorder declares its entity and exports its row schema.**

  A composing vertical could not get the entity-type constant its permission-walk
  edges name, nor a Zod schema for the row a declared operation returns — the same
  two gaps engine-protocol just closed. `OrderRow` is now derived from the registry
  rather than written beside it.

  One entity, three tables: `workorder` is what the platform points at; time
  entries and material lines are rows this engine owns and totals.

  It declares **no `parents`**, deliberately. The parent is the vertical's noun —
  Callout takes the manifest's `facility`, Handlebar hangs work orders off a bike —
  and the manifest's hand-written `facility` edge stays until foreign entity names
  become checkable.

- 09852a9: `WorkOrder` becomes schema-first, and the row schema's docs stop overclaiming.

  `workorderRow` was described as "the row shape, for a vertical declaring an
  operation that returns one". The first half is true and the second is not: the
  engine **stores** `facility_type` / `facility_id` as two snake_case columns and
  **publishes** one `EntityRef` in camelCase. A vertical declaring
  `output: workorderRow` would have been declaring the wrong shape, and confidently.

  `workOrder` is the published type, exported as a Zod schema with the interface
  derived from it — matching `billableLine` and `createWorkOrderInput`, which were
  already schema-first. `status` is taken from the entity registry, so storage and
  domain cannot disagree about the state set.

  The row schema keeps its place; its documentation now says what it is, and names
  `workOrder` as what operations return.

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.3.65

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.3.64

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.3.63

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.3.62

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.3.61

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.3.60

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.3.59

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.3.58

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.3.57

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.3.56

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.3.55

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.3.54

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.3.53

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.3.52

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.3.51

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.3.50

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.3.49

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.3.48

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.3.47

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.3.46

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.3.45

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.3.44

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.3.43

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.3.42

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.3.41

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.3.40

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.3.39

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.3.38

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.3.37

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.3.36

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.3.35

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.3.34

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.3.33

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.3.32

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.3.31

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.3.30

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.3.29

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.3.28

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.3.27

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.3.26

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.3.25

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.3.24

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.3.23

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.3.22

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.3.21

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.3.20

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.3.19

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.3.18

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.3.17

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.3.16

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.3.15

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.3.14

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.3.13

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.3.12

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.3.11

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.3.10

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.3.9

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

## 0.3.8

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.3.7

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.3.6

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.3.5

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.3.4

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

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

## 0.1.0

### Minor Changes

- 7583dab: First end-to-end feature set: the kernel deltas that carry a running vertical.

  - **Contracts**: relationship tuples with proof-path `Decision`s (an unexplained allow is
    unrepresentable), entity-narrowed capability grants, `entityRelations` and `ui`
    contributions on the module manifest, shared `money` schema with exact decimal
    arithmetic, attachment `visibility` classification.
  - **Kernel**: `registerModule` (manifest + migrations + operations + consumers),
    `OperationContext.link`, entity-aware `PermissionChecker`, `HostAdmin` surface for
    roles/assignments/grants/membership, `assertAllowed`/`PermissionDenied`.
  - **adapter-sqlite**: built-in constrained tuple permission engine (fixed four-rule
    algebra, proof paths, grant expiry, org membership), per-scope migration journal
    (lazy on wake, crash-safe), per-operation transactions (writes and emitted events
    commit or roll back together), local at-least-once event dispatch with a kernel
    delivery journal and system-actor consumer contexts.
  - **contract-tests**: atomicity, migration-journal, dispatch exactly-once, and tuple
    permission suites — every adapter must pass all of them unchanged.
  - **Engines**: first releases of `@substrat-run/engine-workorder` (state machine, append-only
    time/material, fat completion events) and `@substrat-run/engine-invoicing` (event-consuming
    snapshot fakturaunderlag with provenance, immutable once exported).

### Patch Changes

- Updated dependencies [7583dab]
  - @substrat-run/contracts@0.1.0
  - @substrat-run/kernel@0.1.0
