# @substrat-run/contracts

## 0.88.0

### Minor Changes

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

- 04c61c1: kernel: the denial log gets a reader (`listDenials`, `summarizeDenials`)

  K-35 shipped the write side in both adapters four weeks ago. Every enforced `assertAllowed`
  denial in production has been recorded since — actor, permission, node, operation, `at` —
  written as a fresh autocommit _after_ the rollback that would otherwise erase the evidence
  of itself. **Nothing read it.** K-35 said so in its own last clause: the directory-side
  surfacing "rides §5.4's admin-query RPC, unbuilt". The only consumer in the repo was a
  contract test (#867).

  That left the platform's three logs two-thirds built and asymmetric: `_substrat_admin_log`
  holds staff mutations and is readable in the console, `_substrat_access_log` (K-24) holds
  staff reads, and `_substrat_denials` (K-35) held refusals for nobody. It is the log that
  matters most of the three, because it is the stronger kind of evidence. A generated
  conformance report says _"we attempted the attack in CI at commit X"_; these rows say _"on
  your data, in production, here is every refusal, by whom, against which key"_.

  **The §5.4 RPC turned out to be built.** This is its first caller in the sense the decision
  meant — two `HostAdmin` reads (`listDenials`, `summarizeDenials`), served as
  `GET /tenants/:t/scopes/:s/denials[/summary]`, reached through the same delegation ladder as
  the table reads: a hosted scope through its vertical's platform-gated `/internal/denials`,
  a co-located one locally. Same `PlatformActorId`, same K-24 access-log entry, same K-3
  `(tenantId, scopeId)` cross-check failing closed on a mismatch. Reading the denial log is
  itself logged. The §7 bound holds unchanged: directory metadata and denial rows, never
  tenant business data.

  **Both of K-35's hedges were built rather than deferred, because both are load-bearing.**

  _Rate-bucketing._ K-35 called it sanctionable up front, and the reason is not tidiness: a
  probing client mints unlimited rows, so a newest-first page of 200 shows 200 rows from one
  prober and hides everyone else — the read fails exactly when it matters. So the bucketed
  view is the default surface, not a refinement, and it is ordered **by count**, which is what
  keeps the quiet actor on the page beside the loud one. Buckets are (actor, permission) —
  K-35's own "first occurrence + count per actor/key/window" — and carry `COUNT(DISTINCT
operation)` beside the count, because one operation refused four hundred times is a broken
  screen or a misconfigured role while the same count across a dozen is someone walking the
  surface.

  _The window is not a retention policy._ Rows drain rather than expire (K-24's split), and
  until a Tier 2 sink exists the window simply **is** the retention. So the summary reports
  the log's oldest and newest held rows computed **ignoring the filter** — a fact about the
  log, not about the query. That is what stops an empty result being read as "this never
  happened" when the truth is "we no longer hold that far back", and an empty log reports a
  null window rather than a fabricated instant.

  Both adapters answer from one shared SQL builder (`kernel/denial-query.ts`), the same shape
  `platform-request-query.ts` uses, so the pure-SQLite host and the Durable Object cannot
  drift on what "newest" means or what a bucket groups by. The filter takes the **logical**
  actor — a bare principal ULID — and normalizes to the stored `JSON.stringify` encoding, so
  no call site has to know how the writer spells it.

  Ten contract-suite tests run against both hosts, including the DO path. Three of them pin
  properties rather than plumbing: that buckets are count-ordered so a flood cannot hide a
  quiet actor, that a window bound narrows `total` and never the window, and that a bare
  `ctx.check` a module branches on writes no denial — K-35's deliberate silence, asserted
  through the read surface an operator actually sees.

  The console renders it per scope, bucketed, with the window stated in the card's own caption.

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

- 1c1f23c: A read-modify-write says what it is writing over — `concurrency`, `If-Match`, and the 412

  Two people open the same record, both save, and the second write destroys the first. No
  error, no log line, and nobody notices until the data is gone. An operation that is
  read-modify-write now declares what it is writing over:

  ```ts
  'callout/update-facility': {
    input: z.object({ facilityId: z.string(), name: z.string().optional(), … }),
    concurrency: { over: 'facility', idFrom: 'facilityId' },
    emits: { entity: 'facility', entityIdFrom: 'id', type: 'callout.facility-updated', … },
    http: { method: 'PATCH', path: '/facilities/{facilityId}' },
  }
  ```

  One declaration, three consequences. Every response carries the entity's version as an
  `ETag`. An unsafe method compares the caller's `If-Match` against that version **inside the
  operation's transaction** and refuses a stale one with `precondition_failed` (412). The
  generated browser client remembers the tag a read handed back and sends it on the next
  write to that entity, so an app writes no header code.

  No new error vocabulary: `precondition_failed` → 412 has been declared in the taxonomy
  since #113, excluded from `DOCUMENTED_ERROR_CODES` precisely so it would appear when
  something could raise it. It now joins the emitted document **per operation** — on the ones
  that declared `concurrency` and nowhere else.

  **Opt-in, and not left to memory.** Most declared operations are command-shaped:
  `todo/rename-list` takes a name, not a whole entity it read and echoed back, and two
  concurrent renames do not lose an update. But the shape that _does_ lose them is visible in
  the model — one required field naming the row, every other field optional over that
  entity's own columns — and an operation of that shape with no `concurrency` is refused at
  module load, as a bare-array list output with no `paged` already is. It matches nothing in
  the fleet today, which makes now the cheapest moment it will ever be added.

  ### Three things the implementation had to get right

  **A guarded operation must emit.** An entity's version is the ULID of the last event about
  it (#901) — there is no version column. So a guarded write that announces nothing is worse
  than an unguarded one: both writers pass their `If-Match`, neither moves the version, both
  commit, and both receive a 200 with an `ETag` asserting the write was serialised.
  `concurrency.over` is compile-checked against the operation's declared `emits`, which is
  the check `entity-version.ts` asked for by name.

  **The permission answers before the precondition.** The version is snapshotted before the
  handler (its own `emit` moves it) and compared _after_ — because the permission check lives
  inside the handler, and refusing on the version first turns any guarded operation into an
  oracle: a principal with no permission on the entity sends `If-Match: *` and learns whether
  it exists, or sends a tag and learns whether it changed. Found by driving Callout's
  two-tab scenario over real HTTP as a technician, which answered 412 where it owed 403.

  **An unacknowledged precondition is refused, not assumed.** Every previous argument added
  to the coordinator↔ScopeDO RPC was safe for an old DO to ignore — dropping
  `failureEnvelope` makes it throw, which the caller handles. Dropping `ifMatch` would commit
  the write and return 200 with nothing compared. So the DO acknowledges that it evaluated
  the header, and a coordinator that sent one and sees no acknowledgement refuses the success
  rather than reporting a conditional write that was never conditional.

  ### What each package gained

  - **contracts** — `concurrency` on `OperationShape`; `assertConcurrencyMovesVersion` and
    `assertFieldBagsDeclareConcurrency` at module load; `operationConcurrencyOf`;
    `ETAG_HEADER` / `IF_MATCH_HEADER` / `CONCURRENCY_EXPOSED_HEADERS` / `etagOf` /
    `ifMatchAdmits`; `precondition_failed` carries the refused `entity` (and deliberately not
    the current version — handing it back turns the obvious client fix into a blind retry
    that overwrites whatever caused the refusal); the OpenAPI builder emits the header, the
    `ETag` and the 412 per guarded operation.
  - **kernel** — `InvokeOptions` as the third argument to `ScopeStub.invoke`: the
    request-preconditions seam #116 will add `Idempotency-Key` to, plus the reply channel the
    mount reads the tag from. `assertIfMatch`. `ModuleRegistration.operationConcurrency`.
  - **adapter-sqlite / adapter-cloudflare** — the comparison, inside the transaction, in the
    order above; the acknowledgement across the DO hop.
  - **contract-tests** — `concurrencyContractSuite`, 13 cases both adapters pass.
  - **vertical-host** — the mount reads `If-Match` on unsafe methods only (on a `GET` the
    header means a conditional read, and forwarding it would refuse a read for being stale)
    and sets `ETag`.
  - **model-emit** — a guarded method routes through a `guarded()` runtime that keys tags by
    `entityType:id`, evicts on a 412 rather than replacing (auto-retrying with the new tag
    would overwrite the change that caused the refusal), and exposes the map as
    `client.versions`. A client with no guarded operation is byte-identical to before.

  ### Callout adopts it, and adopting it found a bug

  `callout/update-facility` is the fleet's first guarded operation, with
  `callout/get-facility` beside it as the read that hands out the tag — without one, the
  guard is unreachable, since a client could only acquire a tag by writing.

  `callout/create-facility` had never emitted an event. Nothing caught it, because "every
  mutation emits a fat event" is enforced by review rather than by `boundary-lint`. The
  consequence only became visible here: a facility created by a silent write has no version
  at all, so every conditional update against it is refused forever, against a tag the caller
  was never given. It emits `callout.facility-created` now.

  Callout's conformance receipt goes from 1 narrowed check to 3, all driven.

- b3c362d: contracts: a parse failure carries its fields across the ScopeDO hop

  `PROBLEM_EXTENSIONS.validation_failed` has always declared an `errors` member, and
  `validationIssuesFrom` has always existed to build it. Nothing populated it on the way
  out, so field-level issues survived only as JSON **inside the message string** and every
  vertical that wanted them wrote the same `fromZod()` that re-parses that string (#831).

  **#893 is what made this load-bearing rather than cosmetic.** The host now parses a
  declared operation input at the scope door, so the two adapters lose the answer
  differently:

  - under `adapter-sqlite` the refusal throws in-process and the `ZodError` arrives with
    `issues` intact;
  - under `adapter-cloudflare` it is raised _inside_ the ScopeDO and crosses the hop, where
    a throw carries only its message. `toWireFailure` copied `SubstratError.extensions` —
    which a `ZodError` does not have — so the field list was dropped at the one seam it had
    to cross.

  Structured in a scenario test and bare in production is the worst of the two available
  failures, and it is the shape that hides: the code was right (`validation_failed`), the
  status was right (400), and only the half a client actually acts on was missing.

  - **`toWireFailure` maps `issues` onto the declared `errors` extension**, so
    `fromWireFailure` → `toProblem` round-trips a parse failure with its fields on both
    substrates. A throw that already carries `errors` is left alone.
  - **`toProblem` reads a parse failure by SHAPE, not `instanceof`** — the doctrine
    `errorCodeOf` and `vertical-host`'s `isParseFailure` already follow, for the reason
    this module states about two copies of a library in one build. `instanceof z.ZodError`
    silently produced a fieldless body for a duplicate zod copy.
  - **A parse failure gets the canonical `detail`** on both paths rather than the throw's
    own message. A raw `ZodError` stringifies its whole issue list into `message`; echoing
    that beside a parsed `errors` array publishes the same thing twice, in exactly the shape
    this change exists to stop clients re-parsing.

    **Scoped to parse failures, and the `errors` list is what identifies one.**
    `validation_failed` is also raised semantically — `endDate precedes startDate`
    (`engines/absence`), `invalid interval` (`engines/booking`), `at most one party may
sign as primary` (`engines/protocol`) — where the sentence _is_ the information and no
    field list exists to put in its place. Those keep their own message, unchanged, and a
    test pins it: a canonical detail applied to all of `validation_failed` would have
    deleted seventeen useful messages across four engines to standardise a body that had
    nothing else to say.

  **The test is in `inputParseContractSuite`, not only in `contracts`.** A round-trip unit
  test passes on either adapter; it is the suite that already runs on both which can say the
  two agree. Checked by neutralising the fix: the new case is red on `adapter-cloudflare`
  and green on `adapter-sqlite` — the asymmetry, reproduced before it was closed.

  `CODE_BY_ERROR_NAME`'s comment recorded the loss as accepted (_"a parse failure crossing
  the hop loses its `issues` array"_); it now records why the `ZodError` row still earns its
  place — a prototype-less arrival, a structured clone, the legacy pre-envelope RPC path —
  rather than a loss that no longer happens.

  Not in scope: transports emitting `problem+json`. `toProblem` still has no production
  caller, `mountOperations` still decides status and not shape by design, and every vertical
  still hand-rolls its own `onError`. That is phase 4 of the error-model rollout
  (`docs/rfc/error-model.md` §5) and its own reviewable diff. What changes here is that a
  caller reaching for `toProblem` now gets the fields on every substrate instead of one.

## 0.87.0

### Minor Changes

- b2dac1e: `manifestOperations` gains `checksDeclaredElsewhere` — a vertical can name the engine keys it enforces

  A vertical composing an engine is gated by the engine's permission keys as well as its own.
  Until now it had no way to say so: every key an operation checked was derived into that
  module's own manifest `permissions` list, so declaring `workorder:read` on a vertical
  operation meant two modules declaring one key, with two descriptions free to drift apart.

  The available alternative was to name a key the operation does not actually check, and
  Callout took it — `callout/timeline` declared `customer:manage` at the node while the
  handler enforced `workorder:read` on the entity. A `technician` holds `workorder:read` and
  not `customer:manage`, so the generated permission snapshot said a technician could not read
  a timeline that a technician could read every time.

  ```ts
  manifestOperations(calloutOperations, {
    permissions: { "customer:manage": "…", "facility:manage": "…" },
    checksDeclaredElsewhere: {
      "workorder:read": "@substrat-run/engine-workorder",
    },
  });
  ```

  Listed, never inferred, and true in both directions: an unlisted key is still an error, an
  entry naming a key no operation checks is an error (a stale exemption reads as a dependency
  that is still there), and a key both described here and declared elsewhere is an error
  (one module owns a key, and its description belongs with it).

## 0.86.0

## 0.85.0

## 0.84.0

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

- 946dd47: A delivery refused before egress stops being captioned as the provider's refusal.

  A `connector:<provider>` dispatch crosses two authorities. On the way to the bytes it calls back
  into the VERTICAL — opening the bound attachment, invoking the return-path operation — and that
  call is checked against the connection's grants. Only once those pass does anything reach the
  provider. Both ends refuse by throwing, both landed in the same `lastError` string, and nothing
  recorded which was which.

  So the drain asked `isTerminalProviderError`, which reads a bare numeric `status` — and every
  `SubstratError` carries one from the problem catalog. A `permission denied: protocol:read` raised
  inside the vertical answered `true`, and the delivery was journaled as _"a client error the
  provider will refuse identically on retry"_. Scrive never received that request. The integration
  drawer then captioned it _"what Scrive said, in full"_, and directly above it rendered the grant
  list that did not contain `protocol:read` — both halves of the diagnosis on one screen, inches
  apart, with nothing saying one was the other's answer. The operator went to audit their Scrive
  account, pressed **Test connection** (which passes, because the credential is fine), and concluded
  the platform was broken.

  ## Terminality and attribution are different questions

  `isTerminalDispatchFailure` decides whether to retry and is deliberately blind to who refused: our
  own `validation_failed` is as final as the provider's 409, and both statuses come from the same
  structural read. `isTerminalProviderError` now answers only "may this be quoted as the provider's
  words", and one of ours never may.

  **No delivery changed its retry behaviour.** That part was never wrong, and moving it would have
  been a silent semantics change smuggled into a bug fix — a permission denial still settles terminal
  on the first attempt rather than burning a hundred drain passes. What changed is what is _said_
  about it.

  ## The attribution is a value, not a sentence

  `PlatformRequestFailure` (`origin`, `code`, `permission`) is journaled beside `lastError` in the
  scope's own spine, so no reader parses prose to learn who refused. `origin: 'unknown'` is a real
  answer — a socket that never opened is not the provider's refusal either — and NULL is a different
  fact again: nobody classified this row, rather than somebody classifying it as unattributable. The
  column is additive and nullable, so an intent settled by an older control plane reads as
  unrecorded rather than acquiring an origin nobody decided.

  ## A `ControlPlaneError` is always ours

  It is constructed in exactly one place — a call _we_ made to the vertical's `/internal` surface came
  back non-2xx — so whatever status it carries is the vertical's answer to the platform, never the
  provider's to us. This is the rule that fixes the reported failure, and it is why the correction
  lands in the control plane alone: a 403 raised by a deployment that predates this change is still
  attributed correctly, with no vertical redeploy in the path.

  The permission key is read from the structured field when it survived the hop, and recovered from
  the kernel-authored `permission denied: <key>` message when it did not — applied ONLY to a failure
  already attributed to us, so a provider echoing the phrase can never be re-read as our own refusal.
  Nothing parses prose to decide the origin.

  ## The drawer joins what it was already rendering

  A failed delivery naming a permission absent from the connection's live grants now says so where
  the failure is. When the key IS held the sentence is deliberately not written — that is a different
  bug, and guessing at it would rebuild the wall this removes. The panel-level caption no longer
  claims the provider's voice for deliveries it cannot attribute; it says less instead of guessing.

  **Permission diff:** none. No permission key, role or grant changes.

  **Migration diff:** one nullable spine column (`_substrat_platform_requests.last_failure`), added by
  the same attempt-and-tolerate `ALTER` both adapters already use for `authorization` and
  `revoked_at`. No module migration. The pending-intent read in both adapters also adopts
  `PLATFORM_REQUEST_COLUMNS`, which it had duplicated — that duplication is what the constant exists
  to prevent, and it drifted the moment a column was added.

  Closes #841 steps 1 and 2. Step 3 was declined with #726 (the repair is a reconcile, not a button)
  and step 4 shipped there as `lint:connector-grants`.

## 0.83.0

### Minor Changes

- ca3377d: A connection's grants become readable, and a connector's per-dispatch read stops being a standing one.

  Every other authority in this model is inspectable from where a vertical sits: the permission
  surface is diffed at promote, role tuples are readable from the scope, entitlements and identity
  links are projected and read back locally. A connection's grants were the exception — write-only
  from the deployment, readable only with staff access to the control plane — and they are the
  authority behind the one actor that is not a person.

  That blind spot has a cost on the record. `protocol:attach` was missing from a live Scrive
  connection for months, failing the sealed-copy landing into a `skipped` reason nobody reads, on
  a path whose whole purpose is to bring a legal signature home. It was found by a human reading a
  diff on an unrelated PR (#716). There was no read that could have surfaced it and no alarm that
  would have.

  ## The read

  `ScopeHost.connectionGrantsInScope(tenantId, scopeId)` answers from the scope's **own delivered
  tuples** — the rows the permission checker itself walks — so what it returns is what would
  actually be enforced there, including a scope whose delivery is behind the directory. The
  directory's view is a different fact and stays on `HostAdmin`. `conn.grants()` narrows it to one
  connection inside a dispatch, so a connector can assert its preconditions at the top of a
  delivery instead of meeting a missing grant as a refusal several calls later.

  Both tuple stores are read, and getting that wrong was the near-miss. A scope check consults
  tenant-level tuples too (rule-2 inheritance), and the two adapters split them differently: the
  pure adapter keeps tenant-wide grants in the directory, while a Cloudflare scope holds _projected_
  tenant tuples in its DO and _live_ ones in the control plane. Reading only the scope's own table
  reports a tenant-wide grant absent while it is being enforced — a read-back that disagrees with
  the checker is worse than none, because it is the read an operator would believe. The contract
  suite pins the agreement against real evaluation via the probe operation, not against the rows
  the query happened to select.

  ## The per-dispatch capability (#726 remedy B)

  The check site is entity-aware and the grant site is not. `attachments.open` asks
  `ctx.check(gate.read, { entityType, entityId })`; `connectionGrant.node` is `{ tenantId, scopeId }`
  with no entity leg, so a connection could only ever hold a permission scope-wide. The narrow
  question was being answered by the one model that could not answer it narrowly.

  And the read a signing connector makes is per-dispatch by nature. The event names one
  `documentAttachmentId`; `bindDocument` already refuses to bind an attachment owned by anything
  but the instance being signed; `openAttachment` takes an id rather than a search. So the
  authority becomes the delivery:

  > A connector dispatch may open attachments owned by the entity the delivered event names.

  Nothing new had to be invented to carry it — both facts were already kernel-stamped, and both
  adapters already tracked the delivery as ambient dispatch state (`causedBy`). The entity is
  **derived, never asserted by the caller**: what crosses the hosted `/internal` seam is an event
  id the serving deployment resolves against its own outbox. The platform runs the connector and
  can name any delivery; it cannot name an entity.

  There is no fallback to the permission check, on either a mismatch or an unresolvable id.
  "We could not resolve the delivery, so check the grant instead" is how a narrowing becomes a
  no-op — and a grant would re-widen exactly what this narrows, since `protocol:read` is not a
  keyhole: it also gates `protocol/get`, `list-templates` and `list-for-entity`, none of which a
  connector sending one named document reaches.

  `protocol:read` accordingly leaves the dashboard's Scrive catalog. There is no grant to hold, so
  there is none to miss.

  ## The declaration, and the gate that makes it load-bearing

  Three lists described one fact and nothing checked that they agreed: the connector declared what
  it needed in prose, the dashboard's catalog hardcoded what it would grant, and a vertical passed
  a third list with its own upsert. They did disagree — the catalog still read
  `['protocol:record-signature', 'protocol:attach']` after connector-scrive 0.9.0 shipped needing
  more, so no tenant connecting through the dashboard could be granted what the connector
  required, and that surfaced as an avtal failing to reach Scrive (#841).

  `SCRIVE_CONNECTION_GRANTS` puts the requirement where the knowledge is. `pnpm
lint:connector-grants` (new CI step) fails when no dashboard door can carry one. Standing grants
  only, deliberately: per-dispatch reads are authorized by the delivery now, so they belong in
  neither list; what remains is the return path, which runs top-level with no delivered event
  behind it. It checks a floor rather than an equality, so tightening a connector's needs never
  reds the repo on a stale extra.

  ## What did NOT get built, and why

  No grant-only write route — a button adding a missing grant without re-submitting a working
  credential. It is declined and recorded in `connections.md` §3.5.2: it would hand-patch drift a
  declaration should prevent, put the repair in a console nobody diffs, and ask a tenant to decide
  something that is the vertical's requirement rather than their choice. §3.5.1's law then holds by
  construction — there is no act to launder if there is no act.

  What replaces it is **not in this change**, and the doc says so rather than implying otherwise.
  The right repair is reconcile-to-target — compute the grant set from the declaration, then grant
  and revoke directory rows to match, exactly as `setEntitlementsHandler` already does for a managed
  tenant's entitlements — after which a missing grant is fixed by a push. Today the reconcile only
  delivers grants that ALREADY exist as directory rows (`listConnectionGrants`); it creates none. So
  an existing connection missing a standing grant is now _visible_ and still repairable only through
  the credential upsert. Closed here: the per-dispatch read needs no grant at all, a NEW connection
  gets what the connector declares, and a declaration no door can carry is a red.

  ## Three tests changed behaviour rather than breaking

  That change is the substance, so each was rewritten to pin the new rule from both sides rather
  than deleted:

  - The connector sends the bound document **holding no read grant at all** — and refuses an
    attachment the delivery does not name **while holding the key**.
  - The invariant those tests were really protecting — send NOTHING rather than the wrong paper —
    moves onto the failure that can still happen: a binding whose bytes are gone still
    dead-letters rather than substituting the attestation sheet.
  - The `/internal` seam test now asserts the delivery is carried through, because a dropped
    `eventId` would silently fall back to the grant check — which looks like it works, right up
    until the grant is the one that was removed.

## 0.82.0

### Minor Changes

- 885ccf8: A read's query string is documented, and a GET no longer claims to take a body (#830).

  `buildOpenApiDocument` emitted `requestBody` for every operation declaring an input,
  whatever the verb. On a `GET` that describes a call nobody can make — `mountOperations`
  never reads a body there — and it left the fields that _do_ work undocumented. A paged
  list came out like this:

  ```
  /api/customers (GET)
    parameters:  limit, cursor, order
    requestBody: limit, cursor, q, status, customerType, costCentreId
  ```

  `limit`/`cursor` documented twice (the wart #823 acknowledged), and `q`, `status`,
  `customerType`, `costCentreId` documented **only** as JSON body properties — so a client
  generated from the document could not discover the filters at all, and `?q=…&limit=100`,
  the convention that actually works, appeared nowhere.

  The split is not new vocabulary: the router already decides it, and decides it by verb —
  `takesBody = POST | PUT | PATCH`, everything else reads `c.req.query()`. The builder now
  mirrors that rule, so the document and the router describe one surface, which is the point
  of deriving both from the same model.

  - `GET`/`DELETE` inputs are emitted as **query parameters**, with each field's schema and
    its required-ness, and no `requestBody`.
  - A field already named as a path parameter, or by the paged trio the platform writes, is
    not restated — which closes the double-documented `limit`/`cursor` as a side effect. The
    platform's own `limit` survives, so the documented bounds are the real ones rather than
    the operation's bare `z.number()`.
  - A single-valued literal is **omitted**: the route pins it and overrides whatever arrived,
    so documenting it would invite a client to send a value that cannot matter.
  - Writes are untouched — body as before, no query parameters.

  Sharpest on a search route (#827): with no path parameters and no `paged`, `parameters` was
  previously _empty_, so `GET /items/search` documented its `q` as a JSON body and nothing
  else. `demos/todo`'s two search routes are the visible fix in the re-emitted artifacts.

- 31ab573: A page's walk moves to response headers, so adopting paging breaks no client (#829).

  `paged` (#811 / #823) wrapped a list read's response body: `[…]` — or a vertical's own
  `{ customers: […] }` — became `{ entries: […], nextCursor }`. That renames a live
  endpoint's contract, and a vertical publishing a REST API has no way to soften it: no
  "serve both for one release", no version to hang a transition on, nothing in the emitted
  document marking the change as breaking. So the rational move for anyone with API
  consumers was **not to adopt**, which is the opposite of what an unbounded list read
  deserves — and for the list reads whose published shape was a bare array it could not be
  softened at all, because a body cannot be an array and an object at once.

  The body is now the entries, and the walk rides in headers:

  ```http
  GET /api/customers?limit=20&status=active

  200 OK
  Link: <https://api…/customers?limit=20&status=active&cursor=01J9A…>; rel="next"
  X-Total-Count: 340

  [ … ]
  ```

  `Link` is RFC 8288 — the header GitHub serves — and it hands the client a URL to **follow**
  rather than one to assemble, so the filters and page size travel with it. Its absence is
  how a walk ends. Deliberately not `Content-Range: items 0-19/340`: that describes an offset
  window, and keyset paging does not know its offset — that ignorance is what keeps it
  correct while rows are being written, so a start index would be a number we invented.

  **Inside the platform a page is still a value.** `stub.invoke` returns `Page<T>` exactly as
  before — an operation is transport-agnostic, and a test, a seed or another operation has no
  HTTP response to read a header off. This is a projection at the wire, applied by
  `mountOperations`; handlers, `pageOf`/`countedPageOf` and the `paged` declaration are all
  unchanged. A vertical supplying its own `respond` receives the whole `Page` and keeps
  deciding its own body.

  New in `@substrat-run/contracts`: `nextPageLink`, `isPage`, `PAGE_LINK_HEADER`,
  `PAGE_TOTAL_HEADER`, `PAGE_EXPOSED_HEADERS`. The emitted OpenAPI documents the response as
  an array of the declared entry plus both headers, so the walk is discoverable where a
  client generator looks.

  **One caveat this choice creates:** a browser client on a different origin cannot read
  `Link` or `X-Total-Count` unless the server lists them in `Access-Control-Expose-Headers` —
  and the symptom is not an error, it is a list that appears to have one page.
  `PAGE_EXPOSED_HEADERS` is the list to expose. Nothing in the platform sets CORS today.

  This changes a wire format shipped days ago in #823, whose adopters are `demos/todo` and
  one production vertical. The platform's own control-plane API keeps the body envelope: its
  consumers are the console and dashboard, versioned and deployed with it, so it has no
  unknown client to protect.

## 0.81.0

### Minor Changes

- 9cfb99d: Search: `searchables` becomes an index the kernel builds, and `ctx.search` reads (#827).

  `manifest.searchables` has been in the contract since the beginning and nothing read it —
  `kernel-design.md` deferred the backend decision "to first search consumer", so the
  declaration was checked, linted and inert. Every search in the repo was a client-side
  `includes` over a whole list, which is correct at forty rows and wrong at forty thousand —
  and paged reads (#811) take that fallback away, because filtering a page in the browser
  searches the first page only.

  A vertical declares what is searchable, through the same helper that already checks the
  fields against its entity registry:

  ```ts
  ...manifestEntities(calloutEntities, {
    searchables: [
      { entityType: 'customer', fields: ['name', 'number'] },
      { entityType: 'note', fields: ['body'], tokenizer: 'substring' },
    ],
  }),
  ```

  From that, the kernel derives a per-scope FTS5 index and the triggers that maintain it,
  journaled like any other migration — the version _is_ the declaration
  (`search/customer:prefix:name+number`), so a changed declaration re-runs and shows up in the
  migration diff a human reads. `ctx.search(entityType, term, { limit })` returns ids and
  ranks; the caller hydrates them through the read path it already has.

  Four decisions worth knowing:

  - **Triggers, not the event spine.** The index is correct no matter who writes the row, no
    module gains a write path, and the read is read-after-write correct — a customer created
    in one breath is findable in the next. Indexing off events would have inherited the
    "don't use search for read-after-write flows" caveat for nothing.
  - **Capped, not paged.** A relevance order has no stable sort key and therefore no honest
    cursor; the result set is capped and the caller narrows the term. Ordered paging stays
    what a declared sort on a list read is for.
  - **Two tokenizers, declared per entity.** `prefix` (unicode61 + prefix index) by default;
    `substring` (trigram) opt-in, matching inside a word for a larger index. Terms below the
    index's floor are refused rather than answered by a scan.
  - **The index never enters a dump.** Export skips it and its shadow tables — they cannot be
    replayed, and D1's own exporter refuses a database that merely contains an fts5 table —
    and import rebuilds it from the content tables it loaded. A fork searches immediately,
    with its triggers intact.

  `OperationContext` gains `search`, and both hosts implement it against the shared contract
  suite. `splitSqlStatements` learned that a trigger body's semicolons are not top level — the
  derived DDL is the first thing in the repo to emit a trigger, and it passed on better-sqlite3
  (one `exec`, whole blob) while failing every scope on the Durable Object host.

## 0.80.0

### Minor Changes

- 83b0ca3: Paged reads become a declaration the compiler and the document both understand (#811).

  The keyset pagination convention has existed in `contracts/pagination.ts` since the admin
  log — `?limit&cursor&order` in, `{ entries, nextCursor }` out, keyset never offset — and
  was adopted across the control plane, dashboard and console. Engines and verticals never
  adopted it, so their list reads still return whole tables. This is the seam that lets them.

  An operation declares `paged`, and `output` then carries the **entry** shape:

  ```ts
  'todo/list-items': {
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), limit: …, cursor: … }),
    output: todoEntities.item.fields,   // the ENTRY, not the envelope
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/lists/{listId}/items' },
  }
  ```

  - `sortKey` is a **compile-checked join** onto the output's own fields, the same idiom as
    `entityIdFrom` and for the same reason: a cursor over a field the entry does not have is
    a page that silently skips or repeats rows, and nothing downstream would flag it.
  - `HandlerOutput` derives `Page<Entry>` for the handler, so declaring `paged` and
    returning a bare array does not compile. That derivation lives in contracts rather than
    in each vertical's `satisfies` clause — one place to be right about the envelope.
  - The emitted OpenAPI grows `limit` / `cursor` / `order` query parameters and the
    `{ entries, nextCursor }` response schema, built with the same `pageSchema` the handler
    is typed against, so document and code cannot disagree.

  A **total count is opt-in**, because you cannot get one from a keyset page for free and
  business software asks for it constantly:

  ```ts
  paged: { sortKey: 'id', total: true },
  ```

  The handler then returns `countedPageOf` instead of `pageOf`, and the compiler holds it to
  that — swapping one for the other is a type error, not a missing field discovered in the
  UI. The number counts the **filtered** set, the same `WHERE` the page ran under: counting
  the table instead is the mistake that looks right until a second list exists, so there is a
  test for exactly that.

  `todo/list-items` adopts it end to end — declaration, keyset SQL, route, artifact — as the
  worked example the next vertical copies. Its `ORDER BY created_at, id` collapses to
  `ORDER BY id`: a ULID is creation-ordered, so that is the same sequence with one fewer
  column, and a cursor can name it.

  Tested where it can actually break. The scenario suite walks a five-row list two at a time
  and asserts every row exactly once with no trailing empty request, then adds a row
  _between_ two pages and proves the next page does not repeat one — the property an offset
  cannot promise on a table being written to. And because scenario suites invoke operations
  directly and never touch the HTTP layer, `vertical-host` drives `?limit=2&cursor=…` through
  a real Hono app to prove the query string arrives coerced to a number rather than as
  `'2'`.

  Nothing else changes: no other operation declares `paged`, so no other list read moves.
  The remaining adoptions, and the lint that fails an undeclared `z.array()` output, follow.

## 0.79.0

### Minor Changes

- 48ddee6: The error model, phase 1: a closed taxonomy, `problem+json`, and an API surface that
  finally documents how it can fail.

  `packages/contracts/src/errors.ts` lands the contracts half of the error-model RFC
  (`docs/rfc/error-model.md`, issue #113): ten codes, a status and title per code, declared
  per-code extensions, `SubstratError`, and `toProblem` — the one mapper meant to replace
  the seven hand-rolled `onError` handlers that currently choose a status by matching on
  error message TEXT.

  **Nothing throws these yet.** `toProblem` maps an unrecognised throw to `internal`
  exactly as today's transports do, so this ships, is reviewable, and changes no behaviour
  anywhere. The kernel throwing typed errors, and the ScopeDO RPC hop preserving them, are
  phase 2.

  Three decisions worth knowing:

  - **`internal` never carries `detail`.** The posture predates this module and survives it
    verbatim: an unrecognised throw is one nobody reviewed for what it discloses, and these
    surfaces have cross-tenant reach. A test asserts a secret in a thrown message does not
    reach the body.
  - **The body carries a deprecated `error` duplicating `detail`.** Every SPA in the repo
    reads `{ error }`; RFC 9457 permits extension members; so the transports can adopt
    `problem+json` without breaking a single client. It goes away once they are moved.
  - **`isSubstratError` duck-types.** `instanceof` is checked first and not trusted alone,
    because the adapter rebuilds an error crossing the ScopeDO boundary as a plain `Error`
    — which is why `instanceof PermissionDenied` is false in production today.

  `buildOpenApiDocument` now emits failure responses with bodies. The problem schema and
  each failure response live in `components` and are referenced, so a vertical's checked-in
  `openapi.json` gains three lines per failure rather than an inlined body per failure per
  operation — the artifact is a review document, and its signal-to-noise is a constraint.
  The three emitted documents are regenerated in this change.

  `precondition_failed` (412) and `rate_limited` (429) are in the taxonomy so that
  `If-Match` (#129) and rate limiting (#130) add no vocabulary when they land, but they are
  deliberately **not** documented yet: nothing raises them, and documenting a failure that
  cannot occur is worse than documenting none. This narrows the RFC's §6 Q1 leaning, on the
  reasoning that motivated the question.

- 43d67cb: The error model, phase 3: a failure crosses the ScopeDO boundary as a value, so the code
  finally survives the hop.

  Phase 2 measured what a throw actually carries across that boundary and the answer was
  "its message, and nothing else" — `name` folded into the message, every own property
  dropped. That is why `instanceof PermissionDenied` has been false in production while
  being true in every test, and why verticals match error messages with regexes.

  So a failure stops being thrown across the boundary and starts being returned across it.
  `ScopeDO.invoke` returns `{ result, platformRequests, failure? }`, where `failure` is a
  `WireFailure`: name, message, code, extensions, plain JSON. The coordinator rebuilds an
  error from it and throws THAT — the envelope is the wire's shape, never the API's, so
  every caller above `host.ts` still writes `try`/`catch` exactly as before.

  **Opt-in per call, which is what makes it deployable.** The coordinator passes
  `failureEnvelope: true`. A ScopeDO instance still running older code ignores an unknown
  trailing argument and throws exactly as it always did, which the coordinator still
  handles; and without the flag a new DO throws too, so the reverse skew cannot silently
  turn a failure into a success. There is no flag day and no window where an error reads as
  a result.

  What it deliberately does not do: the rebuilt error is a `SubstratError` wearing the
  original `name`, not an instance of the class that was thrown. Contracts cannot import
  the kernel, and reviving arbitrary classes over a wire is a capability nobody should
  want. `instanceof PermissionDenied` stays false on this path and always will — it is the
  wrong question, and every consumer in the repo asks `errorCodeOf` instead.

  Measured, not asserted: the adapter's contract suite now crosses the hop and checks that
  the message arrives verbatim, that the code and name arrive with it, and that the result
  classifies to the same status a same-isolate throw would.

  The compat path is exercised too, and that one nearly shipped untested. Every test goes
  through the coordinator, which always asks for the envelope — so the flag-absent branch
  was reached by nothing, and the argument this change rests on for deploy safety was an
  assertion about code no test ran. Three tests now call the DO directly the way an older
  coordinator would: the legacy path still rejects with its message intact, a denial is
  never handed back as a resolved result, and the envelope appears only when asked for.

  Still throwing across the hop, and so still losing their structure: `attachmentAdd`,
  `attachmentList`, `attachmentAuthorize`, `attachmentRemove`, `introspectQuery`. Same
  pattern, mechanical, much lower traffic.

- bb32545: The error model, phase 2: the kernel's errors join the taxonomy — and the RPC hop turns
  out not to carry them.

  `PermissionDenied` and `SecretBoxUnconfiguredError` are now `SubstratError` subclasses,
  so a transport can ask what a throw IS instead of knowing which classes exist. Both keep
  their exact names and messages: `vertical-host`'s classifier and several verticals match
  those strings today, and renaming them would be a behaviour change smuggled into a
  refactor. `errorCodeOf` reads a code by shape — the live property first, then the name,
  then the legacy class names — and `vertical-host`'s `classifyError` consults it before
  falling through to its message patterns.

  **The part worth reading.** Phase 2 was written expecting to make the taxonomy survive
  the ScopeDO boundary. It does not, and the RFC's §3 has been rewritten because the
  measurement contradicts it.

  Workers RPC carries a thrown error's **message and nothing else**. `name` is not a second
  channel: setting it does not deliver a `name` on the far side — workerd folds it into the
  message as `"<name>: <message>"` and resets `name` to `'Error'`. That was implemented,
  and the new test caught it: adopting it would have rewritten every error message on the
  Cloudflare path, turning `permission denied: perm:use` into `PermissionDenied: permission
denied: perm:use` for every log line, vertical `onError` and UI string. It was reverted.

  The measurement is now a test in `adapter-cloudflare`, pinning both halves: that messages
  cross verbatim, and that no class, name or code crosses with them. Every other error test
  in the repo runs in a single isolate, where the class survives and `instanceof` works —
  which is exactly why the production bug (`instanceof PermissionDenied` false on
  Cloudflare) stayed invisible for so long. Nothing crossed the hop in a test until now.

  So the RFC's contingency is promoted to the plan: structure crossing that boundary has to
  travel as a **value** — a discriminated `{ ok, error }` envelope on `ScopeDO.invoke` —
  not as a throw. That is its own change and its own review.

  What holds today: in-process, the real class arrives and the full taxonomy works — the
  SQLite adapter, and any handler in the same isolate as its scope. On Cloudflare a
  transport still classifies by message, exactly as before: no better, and no worse.

## 0.78.0

### Minor Changes

- d3c6d31: Only a **pointable** entity can be pointed at: the compiler now refuses a
  composite-keyed entity where the platform needs one id.

  #804 made a table's identity declarable, so `primaryKey: ['customer_id', 'year',
'month']` is now a legal entity. But an `EntityRef` is one type and one **id** —
  attachments hang off one, grants narrow to one, `ctx.link` joins two, and an
  event is about one and names the single output field carrying its id. None of
  that has a meaning for a table identified by three columns.

  Nothing refused it. Both of these compiled clean:

  ```ts
  manifestEntities(entities, {
    attachmentTargets: [{ entityType: 'budget', readPermission: 'x:read' }],
  });                              // an attachment hanging off no id at all

  emits: { entity: 'budget', entityIdFrom: 'customer_id', … }
                                   // the event is about a THIRD of a row
  ```

  That is the same silence #804 was about, one layer up — and worse, because the
  consequences are a misrouted grant and an ambiguous audit subject rather than a
  schema that merely accepts duplicates. Six positions now refuse it at compile
  time: `parents`, `attachmentTargets.entityType`, both ends of `relations`,
  `emits.entity`, and a narrowed `permission.entity`.

  ```
  Type '"budget"' is not assignable to type '"customer" | "ext"'.
  ```

  **Derived, not declared.** Un-pointable _is_ "the primary key has more than one
  column". A `pointable: true` flag would describe a second time what `primaryKey`
  already says, and two descriptions of one fact are how they come to disagree.

  **A single-column key that is not `id` stays fully pointable** — `primaryKey:
['workorder_id']` is one id, just not spelled `id`, so the side table keyed by an
  engine's id keeps attachments, grants, links and events. Only composite keys are
  excluded, and such a table is still a complete model member: migrations, a row
  type, a place in `model.json`. It is simply not a grant target.

  ## The inference change

  `defineEntities` is now `const`-generic. It has to be: without it a tuple widens
  to an array, the length is lost, and the check cannot be written at all. This
  affects **inference only** — the function still returns its argument unchanged,
  and nothing about runtime behaviour moves. Every field of a declaration becomes
  literal and readonly as a result, not just `primaryKey`, so code that assigned a
  declared `parents` or `key` to a mutable array type may need a `readonly`. All 54
  workspace packages typecheck unchanged; consumers outside this repo are the
  reason this is a minor rather than a patch.

  ## Why the types are written the ugly way

  The mapped type is **inlined at each of the six positions** rather than used
  through the exported `PointableName` alias. TypeScript prints an alias
  unresolved, so an aliased parameter reports the entire entity map instead of the
  names — the #705 lesson, re-verified here. Inlined, the diagnostic lists the
  entities you may actually use.

  Each copy has a `@ts-expect-error` case in `test/model.test.ts`. That is the
  guard against a copy drifting: delete any one narrowing and its directive turns
  unused, which fails `typecheck` — verified by doing exactly that.

## 0.77.0

### Minor Changes

- cbc4538: `EntityDef` can express a primary key that is not `id`, and a table with no
  primary key is now refused rather than emitted.

  `EntityDef` assumed the identity of a row was an `id` field. Where it was not,
  `emitTables` emitted the table **with no primary key at all** — silently. A
  production vertical transcribing 63 entities from a 38-version journal that has
  run against real data hit this on 15 of them, seven of those composite (#804):

  | table                      | journal                        | emitted |
  | -------------------------- | ------------------------------ | ------- |
  | `vertical_workorder_ext`   | `PK(workorder_id)`             | none    |
  | `vertical_time_budget`     | `PK(customer_id, year, month)` | none    |
  | `vertical_number_sequence` | `PK(kind, year)`               | none    |

  It is not a niche shape. The first is the `vertical_` side table keyed by an
  engine's id — the composition pattern the design rules prescribe. Its identity
  _is_ the work order's; an `id` of its own would permit two side rows for one
  work order, which is the thing a primary key exists to prevent. So any vertical
  composing an engine the way the rules describe hits this on its first side
  table. The rest are ordinary value-keyed tables: a counter per `(kind, year)`, a
  budget per `(customer, year, month)`.

  **The silence was the part worth fixing first.** That vertical's own parity check
  compared column names, types and nullability across all 63 tables and reported
  63/63 matching — because it never compared primary keys. The emitted schema would
  have accepted duplicate rows in 15 tables, and nothing said so.

  So the refusal comes before the notation. `primaryKeyOf` resolves an entity's key
  or throws, and both `emitTables` and `emitModel` go through it: an entity with
  neither an `id` field nor a `primaryKey` now names itself in an error instead of
  producing a keyless table, and `lint:model --check` goes red on it too.

  Then the notation:

  ```ts
  ext: {
    table: 'vertical_workorder_ext',
    fields: z.object({ workorder_id: z.string(), route_note: z.string().nullable() }),
    primaryKey: ['workorder_id'],           // → workorder_id TEXT PRIMARY KEY NOT NULL
  },
  budget: {
    table: 'vertical_time_budget',
    fields: z.object({ customer_id: z.string(), year: z.number(), month: z.number(), hours: z.string() }),
    primaryKey: ['customer_id', 'year', 'month'],   // → PRIMARY KEY (customer_id, year, month)
  },
  ```

  `primaryKey` defaults to `['id']`, so nothing already declared changes and no
  checked-in `model.json` moves — an id-keyed entity emits the byte-identical DDL
  it did before. It is kept distinct from `key` because SQL's own distinction is
  the useful one: `primaryKey` is identity, `key` is an additional uniqueness rule,
  and a table legitimately has both. Reading `key` as the primary key when an
  entity has no `id` would have saved a field by conflating two facts. Column order
  is preserved rather than sorted, unlike `key` — a composite primary key is also
  the index its columns are searched by, left to right.

  The columns are checked the way the rest of the emitter checks: a `primaryKey`
  naming a field the entity does not have is a compile error, and a nullable key
  column is refused, because SQLite lets a NULL into a non-INTEGER primary key and
  would not catch it either.

  **And the planner can see it now.** `journalPrimaryKeys` joins `journalColumns`
  and `journalUniques` as the third reader, handling both spellings journals use
  (inline for one column, table-level for several) and replaying renames, rebuilds
  and drops like its siblings. `planMigration` emits the key on a new table and
  refuses a moved one — SQLite cannot change a primary key in place, so that is a
  rebuild and a decision about the duplicate rows already in there, not a diff. It
  distinguishes "the journal built this table without a key" from "the journal
  never built it", because only one of those is a bug.

  The demo parity tests now compare primary keys per table, and fail on the case
  that started this: both sides agreeing that neither has one.

## 0.76.0

## 0.75.0

## 0.74.0

### Minor Changes

- f8bf35e: `http.method` accepts `PUT` (#777).

  The union was `GET | POST | PATCH | DELETE`, with no comment defending the exclusion and no
  semantic argument recorded for it — the demos that shaped it happened not to use `PUT`. A
  vertical with live `PUT` routes therefore could not declare them, and its choice was to break
  25 production URLs by redeclaring them `PATCH`, or to keep the hand-written route table that
  `mountOperations` exists to delete. Neither is a trade an enum omission should force.

  Widened at all four sites — the operation shape, the engine route bindings, the OpenAPI
  catalog, and the host's route derivation — plus the two branches that read the method:
  `PUT` carries a body like `POST`/`PATCH`, and `mountOperations` now dispatches it to
  `app.put`. Purely additive: widening an accepted union breaks no existing declaration, and a
  vertical that does not use `PUT` sees no change.

## 0.73.0

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

## 0.72.0

### Minor Changes

- f869541: Engine route binding, and an API document derived from the model.

  **`defineEngineRoutes`** — a vertical declares where a composed engine's
  operations live in its own API. An engine declares no `http` and should not: it
  is entity-agnostic and does not own a URL shape, since a bike shop calls the same
  work order a repair. That left a composing vertical hand-writing most of its
  route table — 17 of Callout's 27 routes. Every `{var}` is checked against the
  engine's input schema, so a path naming a field the engine does not accept is a
  compile error rather than a silent 400.

  The operation NAME cannot be checked at compile time: `ModuleRegistration` types
  its operations as `Record<string, OperationHandler>`, erasing the keys before a
  vertical can see them. `mountOperations` gains `knownOperations`, so a typo fails
  at mount with a message naming it instead of as a 404 the first time somebody
  calls that endpoint.

  **`apiCatalogFrom`** — the OpenAPI catalog, read off the declared operations
  rather than restated. Meridian's hand-written catalog is 226 lines and
  Manyfold's 184, all of it repeating what the model already says. `tag` and
  `description` stay supplied, the same prose/derived split as
  `manifestOperations`.

  **`ApiOperationDoc.http`** — the document now describes the route the server
  actually serves. Before operations declared `http`, the only shape available was
  the platform's `/api/op/{name}` invoke convention, so a vertical serving REST
  routes published a document describing a surface it did not have. Path
  parameters are emitted as OpenAPI `parameters`, and several operations sharing a
  URL merge into one path item. Verticals whose catalogs declare no `http` are
  byte-identical to before.

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

- f869541: `narrows` names the permission keys its walk checks.

  An operation that proves access per entity declared only a `reason`, so a key
  reached **solely** by a proof walk contributed nothing to the derived permission
  surface — and would have been absent from the review artifact that exists to make
  a widened permission impossible to miss.

  `narrows` now carries `checks: readonly PermKey[]` alongside `reason`, and
  `permissionsUsedBy` gathers those keys as well as the leading `permission` ones.
  Empty is a legitimate, explicit answer: Callout's portal walk evaluates only
  `workorder:read`, which the workorder engine declares — a vertical restating
  another module's permissions is the same two-descriptions defect this prevents.

  Also adds `manifestOperations(operations, { permissions })`, the operation-side
  counterpart to `manifestEntities`: the manifest's `permissions` list and
  `events.emits` are derived from what the operations declare, with descriptions
  supplied beside the manifest and checked for exhaustiveness. A key an operation
  checks that nobody described is an error rather than an undocumented permission.

  **Migrating:** add `checks` to every `narrows` declaration — the vertical's own
  keys the walk evaluates, or `[]`.

  `@substrat-run/vertical-host` gains `mountOperations(app, operations, resolveStub)`,
  which derives the Hono route table from the operations' own `http` declarations —
  method, path, and which input fields the path carries are already declared and
  compile-checked, so writing them again by hand is a second description that
  drifts. A runtime derivation rather than a generator: the model is TypeScript, so
  `operations` is a live object and there is nothing to emit or regenerate.

  It found real drift on first contact. Callout declared `callout/price-list` at
  `/price-list` while serving — and its web client calling — `/prices`. Three
  descriptions, one wrong, and nothing could contradict it until the route table
  was derived from the declaration. The declaration is corrected here.

  Scope: a vertical's OWN operations. A composed engine's operations carry no
  `http`, because the engine does not own a URL shape — the vertical mounts those
  itself.

- 717600e: A declared `permission` says what it checks against.

  A bare key was ambiguous in the direction that fails **open**. These read
  identically in the model and behave completely differently:

  ```ts
  'todo/create-list': { permission: 'list:create', … }   // checked at the scope
  'todo/rename-list': { permission: 'list:manage', … }   // checked on ONE list
  ```

  Only the handler decided which, via `ctx.check(perm)` versus
  `ctx.check(perm, entityRef)`. A reader of the model could not tell, a reviewer of
  the permission diff could not tell, and an emitter could not generate the check.
  Get the second case wrong and the operation passes for anyone holding the key
  anywhere in the scope — in a sharing app, any member editing any record — with
  every test still green, because only a seed that grants nothing scope-wide would
  have caught it.

  An entity-narrowed check now says so, and says what it narrows to:

  ```ts
  permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' }
  ```

  `entity` is checked against the declared entities and composed engines; `idFrom`
  against the operation's own input, so the check is derivable. Where the id is not
  in the input — an operation taking an item but checking the list it sits on —
  `resolved: '<reason>'` records that this is not a node check while admitting the
  handler must find the entity itself. The two are mutually exclusive and one is
  required, so a check cannot silently say nothing.

  Six `@ts-expect-error` controls prove each join bites: a bad `idFrom`, a bad
  `entity`, both together, and neither. `permissionsUsedBy` reads the key out of
  either form, so the permission review is unchanged.

  Existing bare-key declarations keep their meaning — the node — and now mean it
  explicitly. `demos/todo` adopts the narrowed form on all nine of its
  entity-scoped operations.

  Progresses #736.

- 46b1cac: `renamedFrom` — the one declaration a migration diff cannot derive.

  `planMigration` refused a dropped column, because a diff sees a field gone and a
  field arrived and cannot tell a rename from a drop-plus-add. Guessing wrong drops
  the column and everything in it, so refusing was right — and it also left a
  rename unrepresentable, which is the next thing any app with data hits.

  An entity may now declare `renamedFrom: { current: previous }`, and the planner
  emits `ALTER TABLE … RENAME COLUMN` instead of refusing. Verified against real
  SQLite: the rows survive and a `UNIQUE` constraint follows the column.

  It is the ONLY declaration in the journal that is not derived — including the
  version number — and it is **deletable after use**: once the rename has shipped,
  the old name is gone from the journal and the entry is a gravestone the model may
  remove. Both halves are tested, along with the control proving the same change
  is still refused without it.

  The declaration's KEY is checked by the planner rather than by the compiler:
  TypeScript does not apply excess-property checking when satisfying a generic
  constraint, so an unknown key widens instead of erroring. Written the obvious way
  the constraint reads like a working check and enforces nothing, so it is not
  claimed — `planMigration` refuses it instead, with a message naming the rule.

  **Fixes a live defect in `journalColumns`**, which handled `ADD COLUMN`,
  `DROP TABLE` and `RENAME TO` but not `RENAME COLUMN` — so a renamed column read
  as its old name forever, and a planner deriving from that journal would have
  re-emitted the same rename on every run.

  Closes #734.

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

## 0.71.0

### Minor Changes

- ce44df8: `emitTables` — DDL derived from the entity registry, the first deterministic emitter.

  Every adopter currently hand-writes its `CREATE TABLE` and keeps a test holding it
  to the registry. That test exists _because_ the duplication does; deriving the DDL
  is what deletes both.

  It reproduces the hand-written journals exactly. `emit-parity.test.ts` in Callout
  and Handlebar compares the emitted schema against the checked-in migrations by
  COLUMN SET — not by string, since whitespace, column order and `REFERENCES`
  placement are incidental — and every entity matches.

  - an `id` becomes `TEXT PRIMARY KEY **NOT NULL**`
  - `key` becomes `UNIQUE`
  - `parents` becomes a real `REFERENCES` clause when the entity declares the
    matching `<parent>_id` column, and is skipped when it does not
  - an enum becomes `CHECK (col IN (…))`; a boolean becomes `INTEGER`, since SQLite
    has none

  **It is stricter than the hand-written schemas, and the parity test asserts it.**
  In SQLite a non-INTEGER primary key does NOT imply `NOT NULL`, so `id TEXT PRIMARY
KEY` accepts a NULL id — a hole every `vertical_*` table in this repo has. The
  emitter cannot produce it.

  **It reads the TypeScript, never `model.json`.** `z.toJSONSchema` drops `.refine()`
  and `.brand()`, so an emitter reading the JSON would emit a schema weaker than the
  model declares.

  **It refuses rather than guesses.** A Zod shape it cannot map throws, naming the
  field. #695's 18 broken events came from an emitter defaulting instead — applied
  uniformly, silently, eighteen times.

  Not included: the derived journal (versioning, released-entry freezing,
  expand/contract). This emits a schema, not a migration history — that is the
  bottom-right cell of the plan's lifecycle table and it is unbuilt everywhere.

- ce44df8: Build-time tooling moves out of `contracts` into `@substrat-run/model-emit`.

  `emitTables` and `journalColumns` are things you **run to build**, not vocabulary a
  vertical imports at runtime. Leaving them in `contracts` put an emitter in the
  runtime dependency graph of every vertical that declares a model — tree-shaking
  usually saves you, and "usually" is the wrong guarantee for a package described as
  _the shared vocabulary_.

  **Apache-2.0**, like the rest of the build surface. LICENSING.md's line is whether
  a package is the substrate you run to serve (AGPL — kernel, adapters,
  control-plane-api, engines) or something you build with (Apache — contracts,
  templates, the CLI). A generator is the second, and it never touches a network.

  **`jsonColumn` stays in `contracts`.** It looks like tooling because only the
  emitter reads it, but you _write_ it in your model — it is vocabulary, and the
  boundary is what you author, not who consumes it.

  The two exports belong together: the emitter's claim is "what this emits is what
  the database ends up with", and the reader is how that gets checked. They are held
  to each other rather than each to a hand-written string.

  Thirteen test files across six engines and five demos pick up a devDependency.

## 0.70.0

### Minor Changes

- 9bb7975: `defineOperations` learns the composed engines, so an event can be about an engine's entity.

  `emits.entity` was checked against the vertical's own entities only. But a vertical
  that drives an engine emits about the thing the ENGINE owns — that is the normal
  shape of composition, not an edge case. A production vertical's
  `contract/checklist-toggle` emits `fsk.contract-checklist-toggled` about
  `protocol`, which belongs to engine-protocol, and it could not be declared at all.

  ```ts
  defineOperations(entities, PERMISSIONS, [protocolEntities, workorderEntities])({ … })
  ```

  `emits.entity` now resolves against local ∪ engine names, and a name that is
  neither still fails with both sets listed. The engine's `erasable` declaration
  governs a payload about the engine's entity, which is the only correct reading —
  it is the engine's field, so it is the engine's classification.

  Additive: the third parameter defaults to `[]`, and both existing adopters
  compile unchanged.

  **Why it took a production app to find.** `manifestEntities` got its `engines`
  parameter when Handlebar needed a foreign relation edge; `defineOperations` never
  did, because **neither reference demo emits any event at all** — `emits: []` in
  both manifests, zero `emits:` across both operations files. So `emits.entity` had
  only ever been exercised in test fixtures, where the entity was always local.
  Emitting a fat event on every mutation is a platform rule, which makes the two
  demos the unusual ones.

## 0.69.0

### Minor Changes

- 17a82ec: engine-invoicing declares its entity, and `journalColumns` becomes shared.

  **Why this engine mattered most.** Every demo vertical composes invoicing —
  callout, handlebar, rally, shop — and none could declare an operation returning
  an invoice basis without transcribing this engine's shape into the vertical. That
  is the cost the notation decision (#680) exists to avoid, and it was the first
  wall hit when a vertical was finally built _forward_ from a concept rather than
  retrofitted.

  `invoicingEntities`, `underlagRow` and `underlagLine` are exported;
  `UnderlagRow` and `UnderlagLine` are derived from them rather than written
  beside them.

  Worth recording: this engine exports **no in-scope functions at all**. Its whole
  surface is `consumers` — a vertical composes it by _emitting_, not calling. So
  what a vertical needs from it is not a callable API but exactly this: the entity
  name and the row shape to declare a return against.

  **`journalColumns` moves into contracts.** Three engines had hand-rolled the same
  migration-journal parser and the copies had already drifted — none followed
  `RENAME TO`, so a journal that rebuilds a table under a temporary name (which
  invoicing's 0002 does: create `_new`, copy, drop, rename) would report the
  pre-rebuild columns forever. One implementation now, handling `CHECK (...)`
  continuations, `ADD COLUMN`, `DROP TABLE` and `RENAME TO`.

## 0.68.0

### Minor Changes

- 60789c8: `input` becomes omittable, and the model gains `EntityRow` / `OperationImpl` — all three found by the first adopter.

  **`input` is optional now.** Three of Callout's six declarable operations take no
  body, and a required `z.object({})` cannot say so: a handler accepting only
  `undefined` is not assignable to one accepting `{}`. Omitting `input` means no
  body, and the handler takes `undefined` — mirroring `ApiOperationDoc.input`
  ("Omit = no body") rather than inventing a second vocabulary. `inputOptional`
  remains for the different case of a body that may also be absent.

  **`OperationImpl<Ops, Ctx>`** is the handler map a declared operation set
  requires — CRM-EFF's `satisfies Impl` seam, which is what makes a declaration
  binding rather than decorative. A handler whose input or return disagrees with
  the declaration is an error at the exact method, as is an operation declared and
  not implemented, or implemented and not declared. `Ctx` is a parameter because
  contracts sits below the kernel and must not import it.

  **`EntityRow<T, K>`** is a declared entity's row type — what `ctx.sql.query`
  returns for it. `ctx.sql.query` leaves `T` to the vertical, so every vertical
  hand-writes row interfaces and the schema ends up described three times: the DDL,
  the registry, and `interface CustomerRow`. This collapses the third into the
  second.

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

- a05cd4d: The operation surface of the model — `defineOperations` (#707).

  #697 declared the entities. This declares what can be _done_ to them, and checks
  the joins that are unchecked strings today. Thirteen compile-time checks, each
  with a failing case in `test/operations.test.ts`:

  **Authority** — `permission` names a _declared_ key (a typo becomes a
  suggestion); an operation carries `permission` **XOR** `narrows`, never both and
  never neither; `narrows` must state a reason.

  **Surface** — `input` is the Zod object the handler already parses, so there is
  no transcription step; every `{var}` in an `http` path names a real input field;
  `gates` name a field of the output and a declared permission.

  **`output` is #695 Ask 2**, and it arrives here rather than as separate work.
  Inference documents accidents — one inferred return carried `contacts?:
undefined`, an artefact of an early return, which generation would have cemented
  into the published API. It is also the prerequisite for the API/UI lane split
  (#682/#683): Wasp gets away without declared returns _because it has no lanes_.

  **Events** — the marquee defects:

  - `entityIdFrom` names a field of the **output**. The #695 defect: 18 operations
    emitted `entityId: String(result.id)` on objects answering with `contractId` /
    `runId` / `instanceId`, because for a mutation writing a child the event is
    about the parent.
  - `piiClass` is mandatory, and `subjectId` is required whenever it is not
    `'none'` — the same invariant `events.ts` enforces with a `superRefine` at
    runtime, moved to compile time.
  - a `payload` field marked `erasable` on **the entity the event is about** is
    refused (§12). Resolving through `emits.entity` makes this exact: a `name`
    erasable on `customer` does not stop an event about an `office` carrying its
    own. A check that refuses correct code trains people to route around it.

  `permissionsUsedBy` and `eventsEmittedBy` derive the manifest's `permissions` and
  `events.emits` from the operations rather than having them written twice.

  **A composer, not a second `defineModel`.** `defineOperations` sits beside
  `defineEntities`, so each half stays independently adoptable — which is what let
  the entity half ship and be taken up by two verticals before this existed.

  Additive: nothing declares operations yet, no manifest changes shape, the whole
  monorepo builds and typechecks unaltered.

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

## 0.67.0

### Minor Changes

- 5601fa9: `manifestEntities` gains `foreignRelations`, found by the first adopter.

  Callout declares `{ entityType: 'protocol', parentType: 'workorder' }` — **both
  engine entities, neither owned by Callout**. The protocol engine is
  entity-agnostic, so only the vertical knows that protocols hang off work orders,
  and it is the vertical that must declare the permission-walk edge.

  `manifestEntities` assumed every referenced entity was locally declared, which no
  real vertical satisfies. Rather than widen `parent` to accept any string —
  making the checked case indistinguishable from the unchecked one — foreign edges
  get their own field, so they read as a short list of what is _not_ yet verified.
  They become checkable when engines export their entity-type constants (#696 item
  3), at which point the field takes those constants instead of `string`.

  This is what adoption is for: the spike could not have found it, because the
  spike had no engines.

- 81a8c62: An entity registry, so the manifest's entity names have something to be checked against.

  The manifest describes permissions, events, guards, schedules, attachment
  targets, entity relations, searchables and UI contributions. It does not
  describe **entities**. `migrations` is a pointer (`journalDir` +
  `compatibleFrom`), the tables live in raw SQL the manifest never sees, and
  entity _type names_ appear only as bare `z.string().min(1)` fragments across
  four unrelated, individually optional features — `attachmentTargets`,
  `entityRelations`, `searchables` and `ui.entityViews`.

  Nothing checked those four against each other or against the tables. A typo'd
  `parentType` parsed cleanly and produced an edge permission never flows along:
  the tuple evaluator walks a relation that does not exist, and a grant that should
  reach a child silently does not. Now:

  ```
  Type '"custmer"' is not assignable to type '"contract" | "customer"'.
    Did you mean '"customer"'?
  ```

  `defineEntities` declares them; `manifestEntities` composes the
  entity-referencing manifest fragments against that declaration. Checked: every
  `entityType` in `attachmentTargets`, `searchables` and `ui.entityViews`; `key`
  and `erasable` against the entity's own fields; and `searchables.fields` against
  the _named_ entity's fields — the only place a field name appears in the manifest
  today, and nothing checked it.

  `entityRelations` is **derived** from the entities' `parent` declarations rather
  than written a second time. Two descriptions of one fact is how they come to
  disagree, and this disagreement is invisible.

  `emitModel` renders the registry to plain JSON, deterministically (sorted
  entities, sorted `key`/`erasable`, field schemas via `z.toJSONSchema` — the same
  conversion the OpenAPI builder already uses, so no second schema language enters
  the pipeline). **This is the artifact of record**: everything downstream should
  read it rather than the TypeScript, which is what keeps the authoring notation
  swappable — a later change of authoring layer becomes a new emitter writing the
  same JSON, and nothing downstream notices.

  Additive and opt-in: nothing existing declares entities, no manifest changes
  shape, and the whole monorepo builds and typechecks unaltered.

  **Not included, deliberately.** No `lint:model --check` tool yet. No vertical
  declares entities, so a checkpoint would scan nothing — and per
  `tools/permission-diff.mts`'s own rule, _"a checkpoint that checked nothing must
  never print a green light."_ The tool lands with the first adopter.

  `packages/contracts` also gains a `tsconfig.test.json` and a `test` script: its
  `tsconfig.json` includes only `src`, so nothing in `test/` was typechecked, and
  the package had no test wiring at all. `test/model.test.ts` is the feature rather
  than a test of it — a type-level constraint fails _permissively_, so written the
  obvious way every check compiles clean and enforces nothing. Both directions were
  verified: removing a `@ts-expect-error` surfaces the real error, adding a bogus
  one is reported unused.

- 746a885: The mixed edge gets its checkable half checked, and diagnostics name the entities.

  Handlebar's permission walk is `customer → bike → workorder → protocol`, and it
  crosses the ownership boundary in the middle: `workorder` is engine-workorder's,
  `bike` is the vertical's. `foreignRelations` (added by the first adopter) treated
  both sides of every foreign edge as unchecked strings — which threw away a check
  we hold, because the parent of that edge IS a declared entity.

  Split by which half can be checked:

  - `foreignChildOf` — foreign child, **local parent**. `parentType` is strictly a
    declared entity; a typo is a compile error.
  - `foreignChildren` — neither side ours. Unchecked, and visible as such.

  Both collapse back into `parent` when engines export entity-type constants
  (#696 item 3).

  **Diagnostics.** Entity-name positions are now written `keyof T & string` inline
  rather than through the `EntityName<T>` alias. TypeScript prints an alias
  _unresolved_ — the error named the alias and inlined the entire entity map,
  hundreds of characters before anything useful. Inline, it lists the names:

  ```
  Type '"bkie"' is not assignable to type '"bike" | "customer"'.
  ```

  That is one of the costs recorded against the TypeScript decision on #680, and
  this is the cheap half of it fixed.

## 0.66.0

## 0.65.0

### Minor Changes

- daae585: RUNTIME_BASELINE advanced to 2026-06-01 and treated as maintained (#636): a
  staleness test goes red once the baseline falls ~6 months behind, and
  `substrat push` now refuses a `runtimeNeeds` push whose (otherwise ignored)
  wrangler.jsonc pins a compatibility date newer than the baseline — the D-38
  migration can no longer silently downgrade a live worker's compatibility date.
  A hand-authored config that states no date now also gets the baseline instead
  of a second hard-coded default. Verticals on `runtimeNeeds` pick the new
  baseline up on their next push; self-serve-deploy.md documents how an
  already-provisioned tenant adopts a newly declared `blobStores` (one
  idempotent re-provision after promote).

## 0.64.0

### Minor Changes

- c19e371: fix: a connector failure is readable, and a refused request is no longer retried for two days

  The console's card for a broken Scrive connection said, in full: `Error · scrive · Last error 7m
ago: HTTP 409 from scrive`. The real message was nine words longer and contained the whole
  answer — `Authentication to sign for participant #1 requires valid personal number field`. It
  was journaled correctly by `settlePlatformRequest` and retained; it was simply not reachable
  from anywhere a builder would look. Getting at it meant the read-only SQL console with system
  tables toggled on, or a break-glass `scope pull --full`.

  It cost a production tenant a fortnight. Three signature requests, none of which ever reached a
  counterparty: two `failed` after **100 attempts over two days**, one still `pending` at 78 and
  counting — all on the same permanent client error. The contracts sat in `pending_signature`
  throughout, and the app had nothing to tell the user.

  - **The intent journal is readable.** `_substrat_platform_requests` had one reader,
    `listPlatformRequests`, which returns only `pending` rows — so a _settled_ intent, the only
    kind that holds an answer, was invisible by construction. Its complement,
    `ScopeHost.listPlatformRequestHistory` (`kind` / `status` / `limit`, newest first), is served
    through the vertical's `/internal` surface and the control plane's new
    `GET /tenants/:t/scopes/:s/intents`, and rendered in the dashboard's integration detail as
    "Delivery attempts": id, status, attempts, timings, what was sent, and `lastError`
    **verbatim** — truncating it would rebuild the exact wall the section exists to remove.
  - **A 4xx settles terminal on the first attempt.** `pending` means _try again_, and every throw
    got it by default: right for a provider outage, wrong for a provider's refusal. A 4xx is the
    provider telling the caller its request is wrong; attempt 101 sends the identical bytes.
    `isTerminalProviderError` classifies structurally on the error's `status`, so no host imports
    a connector's error class — and 5xx, 408, 423, 425, 429 and anything with no status stay
    retryable, because a failure you cannot classify must never be settled terminally. Two days of
    silent retries becomes one settled row with the provider's own sentence on it.
  - **A terminal settle is visible to an operator.** It now lands an ops-failure row
    (`stage: 'terminal'`), the same treatment the attempt ceiling already had. A give-up and a
    refusal end the same way — nobody is coming back to the intent — so they deserve the same
    headline.
  - **A vertical can read the outcome of its own intents.** `ctx.platformRequests(filter)` is the
    read half of `ctx.requestPlatform`, which had none: an app could ask the platform to do
    something and then had no supported way to learn whether it happened. This is what lets a
    contract screen say the signing request never left, instead of showing a document that appears
    to be out for signature and is not. Read-only by construction — the kernel owns every write to
    that table.

  `ScopeHost` gained `listPlatformRequestHistory` and `OperationContext` gained
  `platformRequests`; both in-tree adapters implement them and the contract-test suite holds them.
  The 409 itself is a connector/engine gap, filed separately.

## 0.63.0

## 0.62.0

### Minor Changes

- 39807d7: feat: connecting an integration means verified, not stored — and every probe names the provider environment it asked

  **The write path was still claiming more than it knew.** Upserting a credential wrote the row and
  reported success; the console said "Connected", which was a statement about our own database. The
  first evidence the provider disagreed arrived on the next dispatch or sweep — after a signature
  request had already failed.

  The relay now checks the candidate credential with the provider _before_ any write:

  - **Refused** (the provider answers 401/403) → `422`, and nothing is stored. The order is the
    whole point on a rotation: writing first would replace a working credential with a broken one.
    The provider's own message rides the response, so the connect dialog keeps what was typed and
    says what is wrong instead of "couldn't save".
  - **Unreachable** (timeout, 5xx, DNS) → stored, reported unverified. Deliberately _not_ a refusal:
    rejecting during a provider outage would make it look like every tenant's keys had gone bad, and
    would block the rotation someone is attempting because things are broken. `ConnectionProbe.refused`
    is what separates a provider speaking about the credential from a provider that did not answer.
  - **Accepted** → stored, and the successful pre-flight is recorded as health, so a just-verified
    connection reads "last used just now" rather than "connected, not used yet" — the same empty
    claim in different words.

  Both write paths get the gate: the dashboard's connect and a vertical's own admin screen through
  `/internal/connections/upsert`. A provider with no candidate probe registered behaves exactly as
  before — the check is available, never assumed.

  `probeScriveSecret` tests a secret that is not stored yet (no connection opened, no health written
  against the live one), and `ScriveApiError` carries the HTTP status so a 401 is _classified_ rather
  than inferred from a message string.

  **Every probe also names the environment it asked.** A production credential sent to Scrive's
  testbed returns 401 — byte-for-byte what a mistyped key returns — so a verify result that does not
  say which Scrive it called sends an operator to check the wrong thing. It is now the first fact on
  both the success and the failure answer: `production (scrive.com)`, `testbed (api-testbed.scrive.com)`,
  or the bare host.

## 0.61.0

### Minor Changes

- ee491fc: feat: the Integrations detail actually tells you something — which credential is loaded, and the provider's own archive (not just what we sent)

  Three gaps left by #605's first pass, all found by using the screen:

  **"Manage" opened an empty form.** On the account-level Integrations page, a connected provider's
  primary button still went to the connect dialog with four blank fields — which reads as "your
  credentials are gone". It now opens the detail; rotating is one click further in, where replacing
  a credential belongs.

  **Nothing showed which credential was loaded.** The store's write-only rule is right, but with no
  view at all "connected" and "connected with a mistyped token" looked identical, and the only
  repair on offer was to paste all four fields again blind. `GET /tenants/:t/connections/:id/credential`
  now answers a reduced view, produced by the connector — the only party that knows which of its
  fields are identifiers (Scrive's own UI calls two of the four "credentials identifier") and which
  are secrets. Identifiers come back whole; secrets come back as a bullet run plus their last four
  characters, and anything shorter than eight characters is masked entirely rather than mostly
  revealed. Enough to tell two credentials apart by eye, never enough to sign a request. There is
  still no reveal and no edit-in-place: replacing a credential is rotation.

  **Activity only showed our own dispatches.** The ledger is complete for what this platform sent
  and blind to everything else in the provider account — including documents someone created in
  Scrive's own UI, and anything sent before the connection existed. `GET …/activity?source=provider`
  lists the provider's archive instead, marking which rows came from this app (via the
  `substrat_instance` tag the connector already sets). Neither view is a superset of the other, so
  `source` travels in the answer, and the detail view offers both. Unlike the ledger read, the
  provider read refuses rather than degrading on a provider failure: an empty list would read as
  "the account is empty", which is a lie an operator would act on.

  The honesty banner and page subtitle now say what is actually true about what a console can see.

## 0.60.0

### Minor Changes

- 92e9e03: feat: an integration becomes something you can interrogate — verify a credential against the provider, and read what the connection has actually done

  Connecting Scrive was a leap of faith. The stored credential was never checked (a typo surfaced
  days later as a failed signing dispatch), and afterwards the only trace of an outbound call was
  health — one line, last-write-wins — because `openConnection` is deliberately unaudited: a row
  per outbound HTTP call would drown the log that matters. Everything else lived in the platform
  worker's logs, which a tenant cannot see.

  Two provider-agnostic reads close that. `POST /tenants/:t/connections/:id/verify` asks the
  provider to accept the credential right now and answers whose account it is; a refused key is a
  `200 { ok: false, error }` carrying the provider's own words, because "this feature is disabled"
  and "invalid credentials" send an operator to different places. `GET …/activity` serves the
  connector's dispatch ledger — the only durable record that a call ever happened — with `?live=1`
  joining the provider's current state, and a `live` flag so a console never presents the platform's
  record as the provider's truth.

  Both dispatch through host-injected `connectionInspectors`, keyed by provider (the `sweepers`
  idiom), so `control-plane-api` still imports no connector and an unwired provider 501s honestly.
  The activity view is the connector's own **projection**, never a raw ledger row: Scrive's rows
  carry the callback capability token, so redaction is structural rather than remembered.

  The Scrive connector gains `getProfile` and `listDocuments` (both verified against the live
  testbed — `/api/v2/getprofile`, not `/api/v2/user/getprofile`), `probeScriveConnection`, and
  `scriveConnectionActivity`. The dashboard's Integrations surfaces get a Details view: health,
  the live grants the connection holds (the readable blast radius), the activity list, and a
  Test connection action. Verifying is itself a use, so it refreshes health too.

- 3ee5903: feat: outbound network policy for hosted verticals — a declared per-version allowlist, enforced at the egress worker and metered on every verdict (D-46, closes #303)

  Egress from a hosted worker runs under the platform's Cloudflare account — an
  SSRF/exfiltration and cost/abuse surface — yet every dispatched `fetch()` passed
  through the egress worker (#442) untouched, and self-serve-deploy.md §6.3 left
  the policy an explicit open question. Answered: **allowlist and metered**, with
  the allowlist being the vertical's own declaration, reviewed at the admit
  checkpoint like the permission surface.

  - **Declaration** (`contracts`): `substrat.outbound` in the vertical's
    package.json — exact lowercase hostnames plus `*.`-wildcards (any subdomain
    depth, never the apex); `outboundHost` schema, `matchesOutboundHost` matcher
    (one implementation for every seam that asks), `outbound` on the deploy
    manifest, and the list lifted onto the version record so a list view never
    parses whole manifests.
  - **CLI**: carries the declaration on push and preview, and **always** sends it
    — `[]` when undeclared, because no direct third-party egress is the correct
    default (connectors run platform-side, mail rides the `emailSender` relay,
    cross-vertical calls ride the router).
  - **Resolution** (both adapters): `readHostname`/`resolveHostname` join the
    declared list of _the version whose code the dispatch runs_ — the serving
    version when the stable serving script wins, the bound version on the
    per-version fallback — as `RouteTarget.outboundHosts`, via `json_extract` so
    the hot path stays one directory read.
  - **Router**: passes `{ slug, tenant, hosts }` as the `OUTBOUND_POLICY` outbound
    dispatch parameter (`dispatch_namespaces[].outbound.parameters`).
  - **Egress worker**: platform hosts keep looping through the router (K-27),
    declared hosts pass untouched, anything else is a 403 whose body names the
    host and says what to declare. A pre-#303 version resolves `hosts: null` and
    passes through unenforced until its next push — least privilege arrives
    version by version, never as a fleet outage. Every verdict
    (`platform`/`allowed`/`unenforced`/`refused`) writes one Analytics Engine
    datapoint (`substrat_egress`, index = slug; D-30 meter-don't-bill), so the
    unenforced tail and any refusal spike are charts, not guesses.
  - **Console**: the version table renders the declared surface beside the Admit
    button — `none`, the host list, or `undeclared (unenforced)`.

  Honest limit, published with the mechanism (self-serve-deploy.md §4.2):
  Cloudflare outbound workers do not intercept Durable-Object-originated
  subrequests, so DO-context fetches bypass enforcement today — worker-context
  egress is what is policed, and the declared list remains the reviewed contract
  for all of it. Attaching an outbound worker does disable raw TCP `connect()`
  for every dispatched script.

## 0.59.0

## 0.58.0

### Minor Changes

- daab0d5: feat(control-plane): the connection relay — a tenant admin connects a provider from the vertical's own UI

  `POST /internal/connections/upsert` (connections.md §3.5.2), mirroring the email relay
  (#303): a hosted CP-less vertical permission-checks the act with its own `ctx.check`,
  returns the pasted credential as a harness-side effect, and the harness POSTs it to the
  control plane, which re-derives the vertical from its own scope record (the shared
  `PLATFORM_SECRET` never says which vertical), seals the secret with the platform's
  `SecretBox`, and applies any requested `grantToConnection` grants on the calling scope.
  Upserts are keyed (tenant, vertical, provider, externalAccountRef): a live connection is
  rotated **in place**, so the connection id — and every grant tuple keyed on it — survives
  rotation, making credential rotation self-serve. Attribution follows §3.5.1 on both paths:
  `createdBy` on create, and a new additive `opts.rotatedBy` on
  `HostAdmin.updateConnectionSecret` that lands in the audit metadata on rotate — the tenant
  principal, never laundered into the platform actor. New contracts:
  `connectionRelayRequest` / `connectionRelayResult`; new export
  `relayConnectionUpsert` from `@substrat-run/control-plane-api`.

- 778f48a: Connection grants now reach scopes provisioned after the grant (#592). `grantToConnection` records each grant directory-side alongside the enforcement tuple (`_substrat_connection_grants`, tombstoned by `revokeConnection`'s cascade, readable via `HostAdmin.listConnectionGrants` and `GET /tenants/:tenantId/connection-grants`), and provision/reconcile gather those rows and deliver them per scope — the same authoritative channel as entitlements (#310) and identity links (#406) — so the connector return path works on every install without a human replaying grants, and a revoked connection's grants stop being delivered.

## 0.57.1

## 0.57.0

### Minor Changes

- c9911ea: feat(contracts,cli,dashboard): the deploy workflow learns a package directory — monorepos connect nested verticals

  The generated GitHub workflow assumed the vertical is the repo root: install at
  root, `push .`, version gates on the root package.json. `DeployWorkflowOptions`
  gains `path` — pushes and previews build that directory, both version gates read
  ITS package.json, and the triggers gain an editable `paths:` filter so an
  unrelated merge does not deploy the package. Threaded through all three writers:
  `substrat init --ci github --path <dir>`, the dashboard's setup-ci and
  workflow-preview endpoints (the slug now derives from the directory basename,
  not the repo name), and a directory field in the connect form. Root spellings
  collapse to the pathless file; traversal is refused in the generator. The CLI's
  top-level errors now carry an `error:` prefix so a failure is not read as more
  wrangler chatter.

## 0.56.0

### Minor Changes

- 4eb90ca: feat: outbound connector dispatch rides platform-requests — a CP-less vertical's connector runs end to end (#574 phase 3, closes #574)

  Phases 1 and 2 gave a hosted vertical the platform-run sweep and the
  platform-terminated webhook ingress; outbound dispatch still ran nowhere — a
  connector registered on a CP-less host would throw into dead-letters, because
  the connection directory, the sealed credential, and sanctioned egress are all
  platform-side. This closes the loop:

  - **The vertical half** (`adapter-cloudflare`): on a CP-less host, `drainDue`
    routes each connector delivery onto the platform-requests surface instead of
    running the handler. A new ScopeDO verb enqueues the `connector:<provider>`
    intent (the kernel-stamped event embedded fat, `executorId` for attribution)
    and journals the delivery as routed in one atomic step, so a crash can never
    re-route or lose one; backpressure refuses before any write and the delivery
    retries on its own backoff. The inline drain reports routed deliveries
    through `onPlatformRequests`, so the response carries the router-kick header
    and dispatch latency collapses from sweep-cadence to seconds.
  - **The platform half**: `ScopeHost` gains `dispatchConnector` (both adapters)
    — execute ONE routed delivery with this host's directory, credential, and
    egress, no journal (the intent row is the journal). `control-plane-api` adds
    `connectorDispatchHandler`, which parses the routed payload, refuses an event
    whose kernel stamps disagree with the drained scope (terminal), and runs the
    connector; a throw settles `pending` and retries under the attempt ceiling.
  - **Contracts**: `connectorDispatchKind(provider)` / `connectorDispatchPayload`
    — the shared vocabulary between the routing host and the drain.
  - **Kernel**: `ConnectorOptions.provider` (defaults to the registration id) and
    `ExecutorDrainReport.routedToPlatform`.
  - **The control plane** registers `connector:scrive` in its drain-handler map,
    running the SAME `scriveConnector` closure a self-host registers — with the
    callback URL now minted as `PLATFORM_CP_URL` + `scriveCallbackPath(ref)`, so
    the capability URL terminates on the phase-2 ingress.
  - **Meridian's CF worker** registers the connector (routing needs the
    registration; the handler never runs there) and flags
    `x-substrat-platform-request` on invokes that enqueued intents.

  Self-host (node/SQLite) keeps its in-process wiring untouched; the connector
  itself does not fork.

- c1faa15: feat: every pushed version records where its code came from — git CI or a terminal

  A git-connected deploy and a `substrat push` from a terminal were
  indistinguishable on the platform: the generated deploy workflow runs the same
  CLI against the same endpoint, so the dashboard could not answer "where did the
  code this app is serving come from". Now the CLI self-reports its context with
  each push and the dashboard shows it:

  - **Contracts**: `versionOrigin` on the version record — `source: 'git' | 'cli'`
    plus `gitRepo`/`gitCommit`/`gitRef` when pushed from CI. A label, never
    authority: nothing gates on it, and a version pushed before tracking (or by an
    old CLI) reads back `null`.
  - **CLI**: `substrat push` detects the GitHub Actions runner and attaches the
    repo, commit, and branch it built from; a terminal push sends `{ source: 'cli' }`.
  - **Control plane**: the deploy route parses the field leniently — a missing or
    malformed origin must never fail a push — and both adapters store it as a
    nullable `origin_json` column on the version row.
  - **Dashboard**: an origin tag (git-branch icon + `repo@sha` linking to the
    GitHub commit, or a terminal icon + `cli`) on every version row on the
    Verticals page, in the per-app Deployments tab, and beside the app's Running
    version.

  The vertical-level `source` field is deliberately untouched: it is
  claim-at-first-push metadata, and one app legitimately receives both kinds of
  push — provenance is per version.

## 0.55.0

## 0.54.0

### Minor Changes

- b387919: feat(platform): operational failures get a durable, queryable record (#559 step 3)

  A failed deploy, install, or preview restore left no durable trace — the admin log
  audits successful mutations only (by design: it answers "who changed what", and a
  failure changed nothing), so the 2026-08-08 preview-restore incident was diagnosable
  solely from a vertical script's short-retention observability logs.

  `HostAdmin` gains `recordOpsFailure` / `listOpsFailures` over a new
  `_substrat_ops_failures` directory table (both adapters, contract-tested): actor,
  operation, stage, tenant/scope/vertical, answered status, bounded message, and the
  upstream provider's trace reference (Cloudflare's `internal error; reference = <id>`)
  extracted into its own searchable column. Retention-bounded telemetry, not evidence:
  rows self-prune on write after `OPS_FAILURE_RETENTION_DAYS` (90), so the table needs
  no cron and can never grow without bound.

  The control-plane transport records from three places — the error boundary (any
  answered 5xx except 501, including a downstream vertical's 502 passthrough), the
  deploy-upload catch (both the 502 platform-failure and the 422 bad-bundle, for the
  coming builder-facing view), and the install-provision catch after its retry is
  exhausted — and serves `GET /ops-failures` (staff-only, paged, filterable by
  vertical/tenant/operation/reference, newest first).

- fa81319: feat(platform): a data subject can finally be erased, and the backups cannot un-erase them (#37)

  `piiClass: none|pseudonymous|direct` has been enforced at the type level since the contracts
  package existed: an event that could carry PII cannot be declared without a `subjectId`, and
  the Zod message says why — _"crypto-shredding must be able to key the erasure"_. The
  classification was total by construction. The erasure it keys did not exist anywhere in
  `packages/`. `demos/hr` seeds real-shaped national IDs against a comment promising a
  mechanism nobody had built.

  **The mechanism divides the way the stores divide, not the way the data does.**

  _Tier 1 is mutable, so erasing there is redaction._ `shredSubject` nulls the payload of
  every classified spine row keyed to the subject and keeps the envelope — id, type, entity,
  `occurredAt`, and the pseudonymous `subjectId`. That is master-plan §5.3 held exactly:
  _"pseudonymous keys and transaction facts remain"_. A timeline still shows that something
  happened, to what, and when. It no longer shows who, or what was said. No cryptography is
  involved and none is wanted: sealing a live payload would break the raw-SQL timeline
  projections CLAUDE.md explicitly blesses.

  _A platform-retained copy is not mutable, so erasing there is cryptographic._ A reap backup
  is full-fidelity on purpose — _"a backup that cannot restore is a false promise"_ — which is
  precisely why `UPDATE … SET payload = NULL` can never reach one. Each subject's payloads are
  now sealed under their own key on the way into a stored copy (`sealDump`, the sibling of
  `maskDump` and the opposite discipline: lossless and keyed rather than lossy and heuristic).
  Destroying that one key reaches backwards into every copy already taken, and leaves every
  other subject in the same copy restorable.

  **Where the keys live is the guarantee, not an implementation detail.** Per-subject DEKs sit
  in the **directory**, wrapped by the host `SecretBox`, never in the scope database whose rows
  they protect — master-plan.md:316, _"GDPR erasure claims are only as credible as the key
  store's independence"_. A key restored by the same dump that restores its ciphertext would
  silently reverse every erasure the restore rolled past.

  **The tombstone is what makes it an erasure rather than a delay.** A shred keeps the key row
  with the key cleared, and the sealer refuses tombstoned subjects. Without that, the next
  backup mints a fresh key and quietly undoes the erasure — a key store that forgets who was
  erased can erase them exactly once.

  **Order inside the action is fixed: redact the live spine first, destroy the key last.** Both
  halves are idempotent and a crash between them converges on retry, so the tiebreak is which
  half-done state harms the person — a run that died after redacting leaves ciphertext nobody
  can open; destroying the key first would leave their PII in the live database while the audit
  log already claimed they were erased.

  New on `HostAdmin`, implemented by **both** adapters with the crypto factored into the kernel
  (`createSubjectKeys`) so an adapter supplies three row operations and no cipher:
  `shredSubject`, `sealSubjectPayloads`, `openSubjectPayloads`. New `shredSubject` admin action,
  carrying a receipt (`eventsRedacted`, `keyDestroyed`, `tombstoned`) as its `after`. Audited in
  **both** logs — the admin log because it is a mutation, the access log because it destroys
  evidence, and an erasure is the one action where _who asked for this to disappear_ is itself
  part of the record.

  `POST /tenants/:t/scopes/:s/subjects/:id/shred` is staff-only and absent from
  `BUILDER_ROUTES`: a builder forwards the DSAR and the platform executes it, which is where
  hosting-and-certification.md §3 already draws the line (_"we provide extraction, they define
  scope"_).

  **Five limits ship as documentation, not as backlog** (kernel-design §13.1, closing open
  question 17's spine half). One subject per event, so _"erase Jens Palmgren from everywhere"_
  is still out of reach. Vertical-owned tables are untouched — `hr_employees.national_id` needs
  the `onSubjectErased` hook that is deliberately a separate issue. Copies already handed to a
  customer, and backups taken before sealing existed, are beyond reach. A PITR rewind restores
  the pre-redaction state. A directory restore can resurrect a key, and the admin log — the
  compliance witness, never swept — is what records which erasures must then be re-applied.

  The acceptance criterion is a round trip rather than a claim: back up a scope, shred one of
  its two subjects, read the same stored copy back, and watch that subject's payloads open to
  nothing while the other's restore intact.

## 0.53.0

### Minor Changes

- 0148b77: feat(platform): the access log drains to Tier 2, and the retention window finally closes (#36)

  `_substrat_access_log` shipped with a `drained_at` column, a `pruneAccessLog` that deletes
  only drained rows, and an honest note that neither did anything: _"Until the Tier-2 sink
  exists, the window **is** the retention."_ Nothing ever set `drained_at`, so the prune was
  a working function over an empty set and the log grew forever. This builds the missing
  half.

  **The order is the design.** `sweepAccessLog` (kernel) runs one cycle per platform sweep:
  read the oldest undrained rows → **ship** them and let the sink confirm durability → only
  **then** stamp `drained_at` → prune. Stamping before a confirmed shipment would turn one
  failed upload into permanently deleted evidence, which is the failure K-21 rejected for
  tuples. A throw anywhere leaves every row where it was; the shipment is idempotent by key
  and the stamp by its `IS NULL` guard, so a tick that dies mid-cycle retries cleanly, and a
  tick that died _between_ stamp and prune self-heals — the prune is independent of what the
  current pass shipped.

  **Tier 2 is a seam, not a vendor.** `AccessLogSink` is a kernel interface; the control
  plane binds `createR2AccessLogSink`, which writes NDJSON — one row per line — to
  `access-log/<firstId>-<lastId>.ndjson`. The key is the batch's id range, which is also its
  time range (ULIDs sort chronologically), so _"which object covers March"_ needs no
  manifest. NDJSON because a truncated object still parses to its last newline, and because
  a line format is what a SIEM, a compliance-automation platform and a human with `jq` all
  already read — #36's argument against coupling the platform's retention policy to one
  vendor's connector roadmap.

  It rides the existing directory-backup bucket rather than a binding of its own: the record
  is the platform's, not a tenant's, `access-log/` cannot collide with `directory/`, and a
  fourth bucket would be one more thing to provision for no isolation gained.

  New on `HostAdmin`, implemented by **both** adapters: `markAccessLogDrained(actor, upToId,
drainedAt)` and an `AccessLogFilter.drained` narrowing, so the drain runs over the audited
  `accessLog` seam rather than a private read path into the table. The egress is itself
  evidence — a new `drainAccessLog` admin action records how many rows left and where they
  landed, so a question about a pruned range is answerable from the permanent log and not
  only from the object store.

  **Opt-in, like every other destructive sweep.** A deployment that binds no sink drains
  nothing, prunes nothing, and its window stays unbounded — still a stated limitation, but
  now one an operator chooses by not configuring a target, matching the posture of
  `SCOPE_RETENTION_DAYS` and `TENANT_RETENTION_DAYS`. The sweep reports `accessLog: null`
  in that case rather than zeros: "ships nothing by design" and "shipped, nothing waiting"
  are different facts.

  The **admin log is untouched and still never swept.** It is the compliance witness; the two
  logs have different retention because they are different things, which is why they were
  two tables to begin with.

## 0.52.0

### Minor Changes

- 0e45268: feat(control-plane): render meters 1–2, and say why 3–4 have no number (#38)

  §5 has said "meter, do not bill" since it was written, and then metered nothing. Two of
  §9's four meters were always free — a `COUNT` over the directory and a `GROUP BY` over the
  entitlement store — and neither was surfaced anywhere. `readMeters(actor, { tenantId? })`
  is both, as one stamped reading: fleet-wide, or narrowed to one tenant.

  What made this worth an aggregate rather than arithmetic over `listScopes` is that the
  billable rule is a **commercial** definition, and it now has exactly one home
  (`foldMeterReading` in the kernel; each adapter supplies three projections):

  - **Billable means effective, not stored.** Suspending a tenant leaves every scope row
    `active` while `getScope` fails closed for all of them — so those scopes count as
    suspended. A meter over stored status would invoice a tenant-wide outage. The same rule
    keeps meter 2 in step with meter 1: a SKU held by a suspended tenant is still held, and
    is still not revenue.
  - **Expiry is decided at the reading's instant.** A lapsed grant bills nothing but reports
    as `expired` rather than vanishing — a lapsed trial is a renewal, not an absence.

  Meter 2 groups by `(entitlementKey, plan)`, because the flags _are_ the SKUs and `plan` is
  what makes a tier data instead of operator convention.

  `GET /meters[?tenantId=]` is staff-only (absent from `BUILDER_ROUTES`) and audited like
  every directory read — the K-24 row's `resultCount` is the tenants covered, so "read one
  tenant's meter" and "metered the whole fleet" are distinguishable acts. Nothing is stored:
  a reading is recomputed per call, because a persisted running total is the first half of
  the billing ledger D-30 declined to build.

  Meters 3 and 4 get no field, no route and no placeholder. They are uncomputable **by
  construction** — the outbox is per-scope-database with no cross-tenant fan-in, reads emit
  nothing, and the cross-tenant order flow does not exist — and the console now says that
  where someone would go looking for a usage number, instead of leaving it to be re-proposed.

## 0.51.0

## 0.50.0

### Minor Changes

- fa85dd8: feat(lifecycle): a reap leaves a recoverable copy behind (#493)

  `reapScope` is the one lifecycle step with no undo — it frees a scope's Durable Object
  storage, which Cloudflare never garbage-collects on its own — and the copy that made it
  survivable was the operator's job to remember, from a different surface. It is now a
  property of the route: `POST …/scopes/:s/reap` writes a **full-fidelity dump** to a
  platform-held backup store _before any byte is wiped_, and records its address on the
  reap's admin-log entry. A store that throws aborts the reap with the scope intact,
  answered as a `502` that says the data is untouched rather than a bare 500.

  A **dump, not a snapshot fork**, deliberately: `orchestratedSnapshot` provisions the fork
  inside the vertical's own deployment and activates it, so a fork's bytes live in the very
  deployment a retirement is about to delete, and it counts as a live scope in
  `countScopesForVertical` — re-blocking the `deleteVertical` the reap was clearing. A dump
  leaves the deployment, and `POST …/restore` already loads one back.

  Full fidelity, never masked. `GET …/export` masks by default because it hands bytes to a
  _caller_; a backup goes platform→platform and is never handed out, and a masked dump
  restores a structurally-valid but factually wrong scope.

  New seam `ScopeBackupStore` (host-injected, provider-neutral like `ObservabilityReader`)
  with `createR2BackupStore` for Cloudflare R2, plus `GET/POST …/scopes/:s/backups` and
  `GET …/scopes/:s/backups/:capturedAt`. `reapScope`'s options gain `backupRef`, carried
  into the audit entry (`after.backupRef`, explicitly `null` when no copy was taken).
  `ScopeBackup` joins `scopeDump` in contracts.

  Defaults are per-act, not global: a **scope** reap backs up unless told otherwise, while a
  **tenant** reap (§4.8, partly an Art. 17 erasure path) takes no copy unless staff ask —
  silently writing an erased customer's data to a bucket would defeat the request. Asking
  for a backup where no store is configured is refused `501`, never silently skipped, so a
  control plane deployed with the bucket unbound fails loudly; a caller that does not ask
  still reaps unbacked where no store exists (self-host, embedded). Jurisdiction-pinned
  scopes are refused until a per-jurisdiction store exists (K-32) — the reap must not wipe
  what the platform may not legally copy.

- 5063d1c: feat(platform): the directory backs itself up, and the restore is rehearsed (#40)

  Every database the platform holds was protected except the one whose loss is
  unrecoverable. A scope has ~30-day Durable Object point-in-time recovery — continuous,
  per-scope, and strictly better than any daily copy, which is why scheduled per-scope
  backups are deliberately _not_ built here. The **directory** is the case PITR cannot
  answer: it is a single DO, so a bug that deletes it outright leaves nothing to rewind, and
  no scope knows its own tenancy, hostname or bound version well enough to rebuild the map
  from below. `control-plane.md` had already named the stake — _losing it is losing the
  platform, not losing a cache_ — without resolving it.

  New pair on `HostAdmin`, implemented by **both** adapters: `exportDirectory` (a
  full-fidelity row-dump of tenants, scopes, hostnames, verticals, entitlements, identities
  _and the audit spine_ — a directory restored without its history cannot say what the
  platform did before the restore) and `restoreDirectory`. The export is audited in the K-24
  access log with no tenant, because its subject is every tenant at once; the restore is a
  new `restoreDirectory` admin action, written _after_ the replace so the entry survives it
  — the first row after a restored history is the restore.

  `DirectoryBackupStore` is a sibling seam to `ScopeBackupStore` rather than a widening of
  it: a scope copy is taken at a moment and addressed by its scope, a directory copy is taken
  on a schedule and pruned to a window. `createR2DirectoryBackupStore` keys under
  `directory/`, so it can share the scope bucket or have its own. Bound as
  `DIRECTORY_BACKUPS` on the control-plane worker.

  `backupDirectoryIfDue` runs **last** in the platform sweep, after the phases that mutate
  the directory, so a copy is of a settled directory. The cadence is enforced by reading the
  newest stored copy rather than by a second trigger: the quarter-hourly cron takes **one
  copy a day**, a missed tick is caught up on the next pass (late, never never), and the
  schedule needs no durable state of its own. **Retention is 30**, matching the PITR horizon
  so the two defences expire together — and pruned only _after_ a successful capture, so a
  failed backup can never be the thing that deletes the last good copy.

  Routes (staff-only, none per-tenant): `GET/POST /directory/backups`,
  `GET /directory/backups/:capturedAt`, `POST /directory/restore`. All four answer `501`
  where no store is bound rather than an empty list — "nothing held" and "nobody is looking"
  must not read alike. A restore **replaces**, so it refuses a directory that still holds
  tenants unless the body says `overwrite: true`: the dangerous case is not a slip of the
  fingers but a replayed restore against a control plane that already recovered.

  `#40` asked for a _rehearsed_ restore, so the round trip runs in the contract suite against
  both adapters — capture, diverge, restore, then open a scope and invoke through the
  directory it just rewrote. `control-plane.md` §4.9 records RPO ≤ 24h / RTO ≤ 1h, the
  runbook, and the honest limit: the bucket lives in the platform's own Cloudflare account,
  so this survives losing the _directory_, not losing the _account_. The seam is
  provider-neutral so an off-account target is a drop-in when that is worth paying for.

- d7d8fa9: feat(control-plane): export a whole tenant — Art. 20 portability, and the escrow handover (#36)

  `GET /tenants/:t/export` returns one tenant, whole, in one file: the tenant record, its
  scopes, orgs and memberships, roles, entitlements, identity links, hostnames, the store
  ledger, connections — and each scope's database.

  **Composed only from the sanctioned reads** (`listScopes`, `listOrgs`, `listMembers`,
  `listRoles`, `listEntitlements`, `listIdentityLinks`, `listHostnames`, the store ledgers,
  `listConnections`, `exportScope`), which is a constraint rather than an implementation
  note: control-plane.md §7 says the control plane must not acquire a back door into scope
  databases, and an export that reached past the audited surface would _be_ that back door.
  Because every part is already K-24 access-logged, so is the whole. No adapter changes —
  both adapters get it because they already implement the seam.

  **A different shape from #40's directory dump, deliberately.** That one is raw tables for
  _recovery_: complete, replayable, unreadable to a customer. This one is one tenant's slice
  in the platform's own documented vocabulary, so the receiving party can read it without
  knowing our schema. Only the per-scope `data` is raw, because that half has to be loadable
  — and the round trip (export → `importScope` → same tables, same row counts) is a test
  rather than a claim, which is #36's own acceptance criterion.

  Four rules, each of them a way of not lying about what the file is:

  - **Masked by default; `?full=true` is the break-glass** — the same posture as `scope
pull`, with one heuristic sweeping _both_ halves. Driving this surfaced a real gap: an
    identity link's `externalId` is usually the person's email, and the shared PII heuristic
    did not match it. `external_id` is now in the column list, which also masks opaque
    third-party ids in a masked pull — the lossy direction of a trade that costs fidelity
    nothing and a leak everything.
  - **Tombstones are exported; their data is not.** An archived or reaped scope's record is
    part of the tenant's history; a reaped scope has no storage left, so nothing in `data`
    claims to be its data.
  - **Stores are inventoried, not contained** — per-tenant D1/R2 stores appear as a ledger.
    Their bytes are not in the file, and an export that omitted them would read as complete.
  - **The admin log is `full`-only** — it records what _staff_ did, so it is not Art. 20
    material, but it is what an escrow or a dispute needs.

  **Jurisdiction refuses as a unit**: one pinned scope taints the file (K-7/K-32), so the
  route refuses rather than exporting the global scopes and quietly omitting the rest.

  New `tenantExport` contract, composed from the existing schemas rather than restating
  them. `maskRecords` joins `maskDump` so object-shaped records get the same sweep as
  table-shaped ones.

  Not in this change: retention. The admin log is append-only with no sweeper and the backup
  buckets have no lifecycle rule — deleting from an audit log §4.4 says is kept whole is a
  policy decision, tracked rather than assumed.

## 0.49.0

### Minor Changes

- a13c8fb: feat(ci): generate the deploy workflow, and name an immutable per-build preview URL (#509)

  The CI recipe is now a generator rather than prose. `deployWorkflowYaml` moves into
  `@substrat-run/contracts`, and the new `substrat init --ci github` writes the same
  `.github/workflows/substrat-deploy.yml` the dashboard's one-click setup commits — for the
  builder who owns their own CI, or who wants the release-train shape (`--release changesets`:
  only a `package.json` version move releases; ordinary merges just move the test env).

  Why generate it: the workflow encodes a version-label discipline that is load-bearing and
  undiscoverable from `--help`, and the hand-written one got it wrong — it pushed
  `--version 0.1.<run number>` on every run, claiming a real registry patch coordinate each time
  and punching holes in the version sequence. Generated runs now use the registry bump for a
  trunk release, the repo's own version for a changesets release, and a semver **prerelease**
  label for everything else, which `nextVersion`'s anchored parse skips.

  The PR sticky comment now names **two** URLs: the sticky `--pr-<n>` preview, which is rebound
  on every push, and — when the repo opts in with the `SUBSTRAT_PER_BUILD_PREVIEW` variable — an
  immutable `--pr-<n>-<run>` URL frozen to exactly that build. A moving pointer is only safe when
  every build is also addressable, so "the bug on the PR preview" can always de-reference to a
  fixed artifact. The comment bodies are rendered from one module for both writers, so the
  CI-written and platform-written comments are byte-identical rather than merely similar.
  `SUBSTRAT_TEST_SCOPE_ID` likewise makes every merge rebind a long-lived test environment,
  keeping "tracks main" a CI step rather than a platform noun.

- f11a961: feat(deploy): native static assets for dispatched verticals (#340)

  A vertical can now declare `runtimeNeeds.assets` — a directory of built files plus how the
  runtime should route paths against it — and the platform uploads those files to Cloudflare's
  own asset store through the three-step `assets-upload-session`. They are served from the edge
  without invoking the worker, and versioned atomically with the code.

  This replaces inlining the whole SPA into the worker bundle as base64, a workaround justified
  by "WfP dispatch has no static-assets path" that has been stale since Workers for Platforms
  grew that endpoint. The cost it removes is concrete: ~+33 % encoding overhead counted against
  the script-size limit (Meridian's and Manyfold's inlined SPAs are ~3.9 MB of generated source
  each), the whole UI re-parsed on every cold start, and a worker invocation for every image.

  Assets are **not a binding** — they are a top-level upload path — so they can neither be
  allowed nor refused by the §4 binding allowlist. D-44 records the separate decision: the bytes
  are admitted because they carry no reach (inert, public, no code and no credential), while
  their **content-address is verified** — the asset store dedups by hash across the whole
  dispatch namespace, so the control plane re-derives every hash from the received bytes and
  refuses a mismatch rather than letting one push decide what another vertical's identical-hash
  asset serves. An `assets.binding` (programmatic `env.ASSETS`) is refused at push time rather
  than dropped silently, since a worker shipped with an undefined `env.ASSETS` looks deployed
  and 500s on first request.

  The file manifest is retained with the rest of the deploy manifest, which is what lets a
  **promote** re-attach a version's assets onto the stable serving script from content addresses
  alone — the archive script gives back the modules (#286), dedup gives back the assets. A
  re-serve that finds the runtime has dropped bytes it cannot supply refuses and says to push
  again, instead of serving a half-broken page.

  The dashboard gains a per-version Assets panel (path, type, size, content hash) over the
  manifest it already persisted.

## 0.48.1

## 0.48.0

### Minor Changes

- 791e4fd: Retire the `dev`/`staging` channels — a vertical has exactly ONE channel now (#509, #515,
  Tier 4). `channelName` narrows to `z.enum(['prod'])`: `prod` is the serving pointer, and the
  old `dev`/`staging` pointers were write-only (nothing ever served or read them, #509 §2). A
  non-prod environment is a _scope with data_ — a preview (`substrat preview create`) — not a
  second pointer at the same code.

  `prod` stays the wire name, so `--promote prod`, generated CI, and existing `channel_history`
  rows keep working unchanged — this is a narrowing, not a rename.

  - **Promote/history routes** refuse a non-prod channel with a `400` pointing at previews
    (`substrat preview create --tag <tag>`), instead of silently accepting a dead pointer.
  - **`listChannels`** filters to the serving channel in both adapters, so an inert `dev`/`staging`
    row a pre-retirement push may have left never reaches the now-`prod`-only parse. `channel_history`
    is untouched (audit + the PITR anchor `at`).
  - **CLI**: `substrat promote` no longer needs `--channel` (it defaults to `prod`); `--promote`
    documents `prod` only.
  - **Console (dashboard + control-plane)**: channel types, pills, and the promote picker narrow
    to `prod` — the dead dev/staging buttons were already removed in #512.

  The two human checkpoints are unchanged: the `--ack-permissions`/`--ack-migrations` gate still
  fires on the `prod` promote (the digest-change consent), and the fork-before-promote snapshot
  still runs at the bind. No migration is required — legacy dev/staging rows become inert data the
  readers now skip.

## 0.47.0

### Minor Changes

- a90dec0: Preview lifecycle fixes — the three self-contained repairs from #509 (issue #512, Tier 1),
  turning previews into something you can actually run a workflow on. No design change to the
  channel model; that stays for #515.

  - **(a) A reused preview no longer silently dies.** `orchestratedPreview`'s reuse branch
    rebound the new version but never touched `expiresAt`, so a `--tag dev` preview CI keeps
    re-pushing to was reaped 72h after its _first_ creation regardless of activity. The GC
    deadline is now recomputed on every create — reuse included — via a new narrow
    `HostAdmin.setScopeExpiresAt` (mirroring `setScopeServingRef`; audited on both adapters).
    And `ttlHours` accepts an explicit **`null` = pinned until deliberately deleted**, so a
    long-lived preview environment is expressible at last. `substrat preview create --ttl none`
    pins; re-running a tag renews its TTL.

  - **(e) `preview create` stops claiming registry coordinates.** It auto-bumped via
    `nextVersion`, so every PR preview burned a real patch number — the disease that left holes
    in the registry. Previews now push a semver **prerelease** label (`<base>-<tag>.<n>`) via the
    new `previewVersion`: legible (it names the release it rehearses) yet free — `parseSemver` is
    anchored `^\d+\.\d+\.\d+$`, so a prerelease can neither collide with nor advance the coordinate
    the repo owns. An explicit `--version` still wins.

  - **(f) The console stops offering promote buttons that do nothing.** `dev`/`staging` are
    write-only (no reader consults them — #509 §2), so the Verticals view now offers only `prod`
    (self-serve for a private vertical, staff-gated for a listed one) and renders no dead channel
    buttons. Read-only history/pills are untouched.

- 3fcf34b: Give hosted verticals a sanctioned way to send transactional mail — the resolution of the
  outbound-policy open question (#303). The sandbox deliberately keeps `send_email` off the §4
  allowlist (and a Workers-for-Platforms dispatch script cannot bind it anyway), so a vertical
  never sends directly: it POSTs to the control plane's new `POST /internal/email/send` **relay**,
  which sends on its behalf — but only if that vertical holds the staff-granted `emailSender`
  capability. The `from` address is always the platform's onboarded sender.

  The capability mirrors `tenantProvisioner` exactly, as three parts:

  - a manifest **request** — `package.json` `substrat.sendsEmail`, carried on push into the
    registry as `sendsEmail`, refreshed on every push and granting nothing by itself;
  - a registry **grant** — `emailSender`, a directory flag a push can never set or keep, flipped
    by the new staff op `setVerticalEmailSender` (and the console's "Grant email sender" toggle);
  - a platform-held **relay** — `PlatformRelayEmailTransport` (another `EmailTransport`
    implementation) on the vertical side, and the control-plane endpoint on the other, which
    re-derives _which_ vertical is calling from the named `(tenant, scope)` and checks the grant
    against that. Holding the shared `PLATFORM_SECRET` (injected into every dispatch script, and
    the relay's auth) is not enough. The control plane's own origin is injected into every vertical
    as `CONTROL_PLANE_URL` so it knows where to POST.

  `HostAdmin` gains `setVerticalEmailSender`; both adapters persist a nullable `email_sender`
  directory column (a directory schema change, not a module migration). The auth-server demo
  declares `sendsEmail` and uses the relay transport when hosted, so its Better-Auth
  `sendResetPassword` flow finally delivers on a dispatch install. Everything is additive — every
  existing manifest, registry row, and `HostAdmin` call site keeps compiling.

## 0.46.0

## 0.45.0

### Minor Changes

- 846af24: Record tenant **provenance** so the fleet can tell an app-provisioned customer tenant
  from a first-class one. `Tenant` gains `provisionedByTenant: TenantId | null` — a FK to
  the manager's tenant, set only when a manager vertical creates the tenant via the
  `provision-tenant` platform intent (#412), and null for a direct staff create.

  The value is host-derived, never caller-supplied: `provisionTenantHandler` stamps
  `ctx.tenantId` (the manager tenant the host resolved from the provisioning scope's
  directory row — the vertical can't forge it), and the direct `POST /tenants` route forces
  it null. `createTenantInput` gains the field as **optional** (drain supplies it; staff
  create omits it), so the `HostAdmin.createTenant` signature is unchanged and every
  existing call site keeps compiling. Both adapters persist a nullable
  `provisioned_by_tenant` column (a directory schema change, not a module migration).

  This unblocks the #412 invariant-2 entitlement-ownership bound (a listed manager may only
  `set-entitlements` on tenants it provisioned) — this change records the ownership fact;
  enabling that enforcement is a separate follow-up.

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

### Minor Changes

- d222905: Platform blob store + attachment surface (#473): `attachmentTargets`, declared by
  the contract and every engine but implemented by nothing, now has a runtime home.

  - **A fourth store shape.** `blobStoreNeed` in `runtimeNeeds.blobStores` — the
    `tenantStoreNeed` sibling for attachment bytes: the platform mints one bucket per
    tenant (R2 on `adapter-cloudflare`, a per-tenant directory on the pure adapter), the
    builder declares no id, so it is a _need_ the platform provisions, never an `r2_bucket`
    binding the bundle carries. Seams: `ScopeHost.provisionBlobStore` / `listBlobStores`,
    a `blob_stores` ledger in both adapters, and the `createR2BlobStores` REST client.
  - **`attachmentTargets` consumed.** `ScopeHost.attachments(principal, tenant, scope)`
    gates every read by the declared target's `readPermission` and every mutation by its
    new optional `writePermission` (default: the read key) — proof path included,
    per-entity, evaluated where `ctx.check` is. The read gate no longer leaves `ctx` for a
    hand-rolled route handler.
  - **Rows in the scope, bytes in the store.** The metadata fact lands in a new
    `_substrat_attachments` table inside the scope database (so `scope pull` / restore /
    PITR carry it), transactional with an `attachment.added` / `attachment.removed` spine
    event. Bytes go straight to the per-tenant store, never through the scope's
    structured-clone invoke pipe. Keys are platform-derived (`scope/<scopeId>/att/<id>`),
    so per-scope isolation inside a per-tenant store is construction, not convention.
  - **Integrity across the split.** Bytes are SHA-256'd at upload and written once under a
    fresh ULID key, so a row can never point at bytes other than the ones it was born with;
    a PITR rewind can at worst orphan an object (GC-able), never re-point a row.
  - **Deploy path.** The WfP bindings patcher and every in-place serving upload now
    re-derive `r2_bucket` bindings from the blob-store ledger alongside the D1 tenant-store
    bindings (`blobStoreBindingName(binding, tenantId)`), so a re-deploy is structurally
    unable to drop a tenant's attachment bucket. The CLI carries `blobStores` from
    `runtimeNeeds` into the deploy manifest, admitted as a need (never a binding).

## 0.40.0

### Minor Changes

- 3c77f64: Connections become multi-account per provider — the Vercel "Git namespace" shape. Live-uniqueness widens from (tenant, vertical, provider) to (tenant, vertical, provider, account), where the account leg is `COALESCE(external_account_ref, '')`, so providers that never set an account ref keep their singleton semantics while a tenant can now hold one GitHub connection per org/user. `openConnection` gains an optional `externalAccountRef` selector (omitted with several accounts live it throws rather than picking one arbitrarily), `connectionFilter` gains `externalAccountRef`, and both adapters migrate the old `_substrat_connections_live` index in place (`DROP INDEX IF EXISTS` + the new `_substrat_connections_live_account`). The dashboard's git-import flow connects additional GitHub accounts without severing the first, lists repos per selected namespace, and threads the account through branches + one-click CI setup.
- d59a515: Every list read pages the same way: the admin-log cursor convention, generalized.
  `@substrat-run/contracts` gains `pagination.ts` (`listPageQuery` — limit default 20,
  max 200 — `ListPage`, `Page<T>`, `pageOf`); every `HostAdmin.list*` takes an optional
  keyset page (unset stays unbounded for in-process callers); both adapters implement
  the keyset SQL and the contract suite proves it. **Wire change:** every control-plane
  GET list route (`/tenants`, `/scopes`, `/verticals`, `/verticals/:slug/versions`,
  `/channels`, `/channels/:channel/history`, `/hostnames`, `/roles`, `/admin-log`) now
  returns `{ entries, nextCursor }` and defaults a 20-row page — older CLI versions
  parse these as bare arrays and must upgrade; this CLI walks the cursor wherever it
  needs the complete list.

## 0.39.0

### Minor Changes

- 3cf4e3b: The provisioner capability gains its request half (#455): a manager vertical DECLARES the
  target verticals it provisions — package.json `substrat.provisions`, carried on push to
  the registry row (`vertical.provisions`, riding the refreshable install*spec bag) — and
  the console reviews the declaration like a publish request (declared-but-ungranted shows
  as \_provisioner requested*; the grant button reads _Approve provisioner_). Declaration is
  a request, never a grant: `tenantProvisioner` stays the staff-flipped flag a push cannot
  touch (contract-tested both ways). The drain's `admitManager` now distinguishes
  _undeclared_ (fix your manifest) from _declared-but-ungranted_ (awaiting staff) in its
  refusal, and — #412 invariant 4 — bounds a granted manager's `provision-tenant` to its
  declared targets, phased: a granted manager that declares nothing keeps its pre-#455
  unbounded behavior until its next push declares.

## 0.38.0

### Minor Changes

- 5afb162: The tenant-provisioner capability becomes a directory-backed staff grant (#444, #412).
  `vertical.tenantProvisioner` is a registry flag flipped by the new audited
  `setVerticalTenantProvisioner` admin action (console: Grant/Revoke provisioner, route
  `POST /verticals/:slug/tenant-provisioner`, staff-only) and read by the drain's
  `admitManager` at execution time — replacing the `TENANT_PROVISIONERS` env list, which
  was configured nowhere and would have put customer slugs in deployment config. Never set
  at registration and never touched by a re-push refresh (contract-tested): pushing code is
  never how a vertical acquires or keeps platform authority. BREAKING for
  `control-plane-api` consumers: `ManagedTenantDeps.provisioners` is gone — the grant
  lives on the registry row.

## 0.37.1

## 0.37.0

## 0.36.1

## 0.36.0

## 0.35.0

### Minor Changes

- 17eec41: Platform intent handlers for the manager-vertical capability (#412): `provision-tenant`
  and `set-entitlements`. A manager vertical (a console whose job is to add tenants — the
  AuthHero console is the first consumer) enqueues via `ctx.requestPlatform`; the drain now
  executes both kinds with `HostAdmin` authority. `provision-tenant` creates a NEW customer
  tenant, grants its entitlements, and materializes its first scope running the PAYLOAD's
  vertical exactly as a first install would (serving-deployment resolution, per-tenant store
  mint (#301), `provisionInstance` with the #310 projection, config delivery, activate) —
  all ids are payload-proposed join keys, so an at-least-once drain converges.
  `set-entitlements` reconciles a managed tenant to a plan's target set — grant what's
  named, revoke declared-but-absent — and re-projects into the tenant's auth scope via the
  vertical's idempotent reconcile.

  Because a new tenant has no proving parent scope, admissibility is bounded on the
  MANAGER: a tenant-provisioner capability (the control plane's `TENANT_PROVISIONERS`
  deployment config while every manager is first-party) and the manager's registry-declared
  SKU universe, which bounds both grant and revoke. Contracts gain the wire schemas
  (`provisionTenantPayload`, `setEntitlementsPayload`, `entitlementSelection`, kind
  constants) matching the console's `intents.ts` verbatim.

## 0.34.0

### Minor Changes

- ab637f0: Per-tenant relational stores go live on Cloudflare (#301 PR-2). `provisionTenantStore`
  now mints a real D1 per (tenant, vertical, binding) (`createD1TenantStores`, on the
  platform credential), records it in the directory's `tenant_stores` ledger, and the
  provision endpoint hands the K-31 callback the declared handles automatically — the
  worker reaches its tenant's store through a real `d1` binding named
  `tenantStoreBindingName(binding, tenantId)` (new in contracts), attached at provision
  via the WfP settings PATCH (`createWfpBindingsPatcher`) and re-derived from the ledger
  on every in-place serving upload so a re-deploy can never drop it. `openTenantStore`
  on the Cloudflare host is the out-of-band D1 HTTP-query reach;
  `d1TenantRelationalStore` wraps the worker-side binding in the substrate store shape.
  Contract change: `TenantRelationalStore.query/exec` are now async — D1 has no sync
  path, and PR-1's sync shape was satisfiable only by SQLite. New read:
  `HostAdmin.listTenantStores` (both adapters).

## 0.33.0

### Minor Changes

- 6d3429e: Identity links ride the scope-local projection (#406): the control plane stays the
  audited source of truth (`linkIdentity`/`unlinkIdentity`), and every identity write now
  fans out into the tenant's projected scopes (`_substrat_identity_links`), with CP-less
  delivery on the provision/reconcile channel entitlements already use. New surfaces:
  `HostAdmin.listIdentityLinks` (the audited per-tenant gather), the
  `projectedIdentityLink` contract shape, `identityLinks` on provision/reconcile payloads,
  and `CloudflareScopeHost.resolveIdentityLocal` — the CP-less auth adapter's
  `(provider, externalId) → principal` read against the scope's own storage, replacing
  login maps compiled into the bundle (offboarding by deploy; revocation undone by version
  rollback).

## 0.32.0

### Minor Changes

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

- 070f4dc: A vertical can schedule its own recurring work (#383)

  A vertical can now declare `schedules` in its module manifest — operations the platform
  invokes on every live scope of it, on a cadence, driven by the existing platform sweep. It
  is the seam a domain rule triggered by the passage of time (a contract that activates on its
  start date, a leave that can no longer be approved once it has already begun) had no way to
  reach: the operation was written, idempotent, and paged, but nothing woke it up on a date.

  The work is attributed honestly. Rather than the out-of-band workaround of signing in as a
  human and running under their permission — the attribution laundering #97 refused — a
  schedule runs under a **system principal**, the third caller #97 named, built the same way it
  built the connector seam:

  - a new `{ kind: 'system', id: ModuleId }` check-subject, mirror of the connection subject;
  - `ScopeHost.getSystemScope(moduleId, tenantId, scopeId)` — a door whose stub stamps
    `{ system: moduleId }` on events and resolves `system:<moduleId>` grants;
  - `HostAdmin.grantToSystem(...)` — the scheduler analogue of `grantToConnection`, projected
    from a schedule's declared `permissions` at provisioning, so `ctx.check` stays the single
    gate and the grant appears in the reviewed permission diff. Revoking it disables the
    schedule for one tenant, no special flag.

  `runPlatformSweep` gains a schedules phase (`registeredSchedules` / `runDueSchedules`) that
  enumerates each vertical's live scopes and fires due operations under bounded concurrency,
  skipping forks and any scope that does not hold the grant, recording per-scope outcomes in
  `PlatformSweepReport.schedules`. All additive: a manifest that declares no schedules, and a
  host predating the seam, behave exactly as before.

## 0.31.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

  Rounds out scope management (create + switch were already there) with **archive**, reusing the
  platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
  do itself, so it's another intent kind:

  - **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
  - **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
    must be under that same tenant and run the same vertical (verified against the directory), then
    `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
  - **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
  - **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
  - **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
    the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
    site from the registry so the switcher updates immediately.
  - **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
    tenant has more than one site); it archives the current site and switches away.

  Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
  `forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
  denied. Refs #358.

- 41d01f6: Platform intents, Phase B2: the drain engine + `provision-sibling` handler.

  The platform-side execution for `docs/architecture/platform-intents.md`. Because a scope's intent rows
  live in the vertical's own deployment (K-31), the platform PULLS them over the vertical's
  `/internal` surface: `VerticalClient` gains `listPlatformRequests` / `settlePlatformRequest`
  (the B1 read/settle surface, now reachable cross-deployment).

  - `drainScopePlatformRequests(client, ctx, handlers)` lists a scope's pending intents, dispatches
    each to the handler registered for its `kind`, and settles the outcome — an unknown kind settles
    `failed` (never a silent drop), a thrown handler settles `pending` (retried next drain).
  - `provisionSiblingScope(...)` extracts the exact sequence M1's `POST /tenants/:tenantId/scopes`
    route runs (inherit parent vertical/jurisdiction → provision → materialize → activate) into one
    reusable home; the route now calls it. `provisionSiblingHandler` wraps it as the
    `provision-sibling` intent handler, with two-phase idempotency (a scope id minted on an earlier
    pass is reused, so a retry targets the same sibling).
  - `contracts` gains the shared `provisionSiblingPayload` (`{ slug, name, owner }`) + the
    `provision-sibling` kind constant.

  Tested with a fake vertical transport (dispatch → settle: done / unknown-kind-failed /
  thrown-pending) and against a real SQLite host (the handler provisions + activates a sibling under
  the parent tenant, seating the owner). The triggers — the periodic sweep phase and the router kick,
  plus each vertical's `/internal/platform-requests` endpoints — are Phase C. Refs #358.

## 0.30.0

### Minor Changes

- a698959: Derive the permission registry from a typed source, and require it in the deploy manifest (D-41).

  D-39 shipped the declared permission surface in the deploy manifest but left three seams as
  convention and introduced a machine-only generated file in git. The surface was discovered by a
  by-name `MODULES`/`ROLES`/`ENTITY_GRANTS` re-export from each vertical's `seed.ts` (wrong name,
  wrong file, or a vertical outside `demos/`/`apps/` vanished from the checkpoint with no error);
  `push` read a checked-in `permissions.json` and treated its absence as a silent empty surface; and
  `deployManifest.registry` was optional, so a push could carry no declared surface at all.

  Now the surface is declared once via a typed `definePermissions({ modules, roles, entityGrants })`
  in `@substrat-run/contracts` — a compile-checked single source. The checkpoint tool discovers it
  from a declared `package.json` `substrat.permissions` pointer rather than a `seed.ts` re-export
  (a package with a `seed.ts` but no pointer is now a hard error, not a silent skip), and emits only
  the human-readable `PERMISSIONS.md`. The machine-readable `permissions.json` is gone from git:
  `substrat push` derives the registry from the typed entry with the same new
  `buildPermissionRegistry`, bundling the entry with esbuild (deps left external, so a node-ful entry
  still resolves its own `node_modules`) and hashing the result into `digests.permission` — proven to
  reproduce the previously-committed files byte-for-byte, so the digest is unchanged.

  `deployManifest.registry` is now **required**: a push that declares no surface is rejected at the
  trust boundary and by the CLI before upload (absence is never a silent empty registry; a vertical
  that genuinely exposes nothing ships an explicit empty registry). A lenient `storedDeployManifest`
  (registry optional) is used only for re-reading manifests persisted before this change, so old
  versions stay readable and re-deployable in place. `@substrat-run/cli` gains an `esbuild`
  dependency.

- 67be7c7: Platform intents, Phase A: the `ctx.requestPlatform` primitive.

  Adds the foundation from `docs/architecture/platform-intents.md` — the sandbox-clean way a vertical
  asks the platform for a privileged action (provision a sibling scope, quota, …) without an
  upward call. A vertical operation calls `ctx.requestPlatform({ kind, payload })` after its own
  permission check; the kernel durably records a typed intent in this scope's new
  `_substrat_platform_requests` spine table (atomic with the operation, stamped with the actor), and
  returns the request id. The platform will pull and execute these with `HostAdmin` authority in a
  later phase — knowing the tenant inherently because it reads that scope's own DO.

  - `OperationContext` gains `requestPlatform(input): PlatformRequestId` (kernel), implemented
    symmetrically in both adapters; `contracts` gains `platformRequestId`, `platformRequestInput` /
    `platformRequest` schemas, and the `MAX_PENDING_PLATFORM_REQUESTS` backpressure bound (the verb
    refuses once a scope holds that many pending intents).
  - **Migration checkpoint:** a new `_substrat_platform_requests` spine table is added to each
    adapter's `KERNEL_DDL` (`CREATE TABLE IF NOT EXISTS`, so it back-fills existing scopes on next
    open). No versioned module migration; it is kernel spine, flagged `system` automatically.
  - Contract-suite coverage (both adapters): the intent is enqueued as `pending` with its kind /
    payload / actor, and rolls back with its operation when the handler throws (K-4).

  No consumer yet — the drain-executor, router kick, and the Manyfold "New site" flow are later
  phases (#358).

## 0.29.0

## 0.28.0

## 0.27.0

### Minor Changes

- 6901c16: Per-tenant relational stores as a first-class store type (#301, PR-1).

  A hosted vertical whose data model is one SQL database **per tenant** (a latency-sensitive
  multi-tenant auth/OIDC provider is the motivating case) can now declare a per-tenant
  relational store the platform provisions and hands over — distinct from a single shared D1
  (one database for every tenant) and from an own DO (one per scope). Because the platform
  mints the database per tenant and injects the id, the builder supplies **no `database_id`**:
  that is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md §4).

  - **Vocabulary** — `tenantStoreNeed` in `runtimeNeeds.tenantStores` and a platform-minted
    `tenantStoreHandle` (`@substrat-run/contracts`). A per-tenant store is a _need_ the platform
    provisions, never a `declaredBinding`, so it never rides the §4 sandbox allowlist. The CLI
    carries `tenantStores` into the deploy manifest without emitting a static wrangler binding.
  - **The seam** — `provisionTenantStore` (platform mints, records in the directory, returns an
    opaque handle; idempotent) and `openTenantStore` (the vertical opens what it was handed and
    runs its own migrations) on `ScopeHost`, plus `ProvisionInstanceInput.tenantStores` so the
    K-31 pull-provision callback hands the handle over inside its fail-closed/idempotent/retry
    ready-gate. The handle's `ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
    `.sqlite` file on the pure adapter.
  - **Pure adapter (real)** — `@substrat-run/adapter-sqlite` mints one separate `tstore__….sqlite`
    file per (tenant, vertical, binding), physically isolated from the scope DBs, backed by a
    new `tenant_stores` directory table (the idempotency + reap ledger). The whole path is
    exercised in dev/CI without Cloudflare.
  - **Cloudflare (stubbed)** — `@substrat-run/adapter-cloudflare` throws a clear `#301` marker
    from `provisionTenantStore`/`openTenantStore`; live D1 create/bind/HTTP-query is the tracked
    follow-up (PR-2), so nothing appears provisioned while its store does not exist.

  Additive and backward-compatible: `runtimeNeeds.tenantStores` and the manifest field default
  to empty, a `provisionTenantStore` audit action is a new enum value, and a vertical that
  predates `ProvisionInstanceInput.tenantStores` strips the unknown key.

## 0.26.0

### Minor Changes

- 2bdd22b: Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

  Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
  to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
  lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
  isolation D-35 has always specified but never checked in code.

  - **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
    wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
    `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
    Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
    calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
    **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
    to `active` with no per-hostname call.

  - **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
    worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
    any stuck `pending` custom bind — issuance self-heals without a human. A new
    `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
    dashboard's _Check again_) re-polls on demand.

  - **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
    algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
    cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
    label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
    domain that is a bare public suffix.

  - **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
    (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
    adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
    `status` filter on `listHostnames` (index-backed) for the reconcile pass.

  - **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
    add a custom domain (shows the DNS records to publish), _Check again_, and remove — no more
    mock rows. Removing a custom domain releases the Cloudflare custom hostname.

  Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
  does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.

## 0.25.0

### Minor Changes

- e612b98: Reap archived scopes (§4.4): free the Durable Object storage that Cloudflare never
  garbage-collects. Deleting an app archives its scope — a tombstone-only transition that
  keeps the directory row but leaves the scope DO holding every byte forever. This adds a
  terminal `reaped` state past `archived`: `reapScope` wipes the DO's storage while keeping
  the directory row (audit history + burned slug), the one irreversible scope transition, so
  it only ever leaves `archived`, `getScope` fails closed on it, and its slug is released for
  reuse. Delivered two ways over one seam — the storage wipe reaches the vertical's own
  deployment (a hosted scope's DO is CP-less) via the same `deleteScope` dispatch the snapshot
  GC uses: a staff-only `POST /tenants/:t/scopes/:s/reap` (armed in the console behind a
  type-the-slug dialog, since there is no restore), and a `runPlatformSweep` phase that reaps
  scopes archived longer than `SCOPE_RETENTION_DAYS` — opt-in and unset by default, because
  the reap cannot be undone. Both adapters gain an additive `archived_at` column (stamped on
  archive, cleared on unarchive) to age the sweep, and their `(tenant_id, slug)` unique index
  becomes partial on the live statuses so a retained tombstone never blocks the slug reuse the
  pre-check already intends — closing a latent gap where archived slugs could not actually be
  reclaimed.
- caedb1c: A prod promote no longer strands a legacy scope's data, and the in-place serve is honest and
  complete end-to-end (#321). #287 shipped the serve-in-place, but existing (pre-#286) scopes were
  never migrated onto the stable serving script, so every promote re-stranded them: the private-
  vertical rebind cascade advanced a legacy scope's version to the incoming version's fresh,
  empty per-version dispatch script, `0001-init` re-ran against empty storage, and the app rendered
  a no-access page that read as an auth bug rather than data loss.

  - **Adopt-before-rebind on promote.** For a dispatch-backed vertical, the host rebind cascade is
    skipped (an embedded vertical, with no per-version script, keeps it) and the control-plane-api
    prod-promote handler owns adopt-then-rebind in the correct order: after a successful in-place
    serve, each still-legacy owned scope is adopted onto the stable serving script — its bytes moved
    off the per-version script _before_ any version pointer advances — then rebound. Retry-safe:
    nothing rebinds until the adopt succeeds, so a failed serve strands nothing and a re-promote
    resumes. A shared `adoptScopeOntoServing` primitive backs both this and the explicit endpoint.

  - **A builder-triggerable backfill for existing installs.** `substrat scope adopt-serving <scopeId>`
    migrates one legacy scope; `--vertical <slug>` (and `POST /verticals/:slug/adopt-serving`)
    backfills every still-legacy scope of a vertical. Idempotent.

  - **`scope restore` accepts an adapter-sqlite scope file and errors actionably.** `importDump`/
    `loadDump` re-assert the kernel spine after the drop-then-replay, so a dump that omits
    `_substrat_roles`/`_substrat_tenant_tuples` (an adapter-sqlite scope file keeps them in its
    directory db) no longer leaves the target missing spine tables and crashing a later check with a
    bare `no such table` → the detail-less `internal error` the field report hit. The restore route
    returns an actionable 422 instead of the generic 500.

  - **A failed in-place serve stops reading as "deployed."** `servingVersionId` is added to the
    channel surface (`VerticalChannel` + both adapters' `listChannels`): a prod promote moves the
    channel pointer before the serve, so when the serve fails `servingVersionId !== versionId` is the
    honest signal that the scopes still run the previous code. `substrat versions`, the dashboard
    deployments view, and the console surface the divergence and prompt a re-promote.

  - **An empty role projection is a platform condition, not only a per-app 403.** A new
    `GET /tenants/:t/scopes/:s/health` reports `roleProjectionEmpty` for an active scope whose served
    DO has zero projected roles (the silent state the field report chased through a migration-journal
    diff); the console Scopes detail raises it as a flagged condition.

  Prevents future stranding and gives a migration path for existing installs. Recovering data already
  stranded by an earlier bad promote (locating the specific prior per-version script) is a separate
  ops task, out of scope here.

- f0df69a: Tenant delete with a grace window (§4.8, #36): reclaim a deleted tenant's data instead of
  stranding it forever. `deleting` was a dead status — written once (a dashboard team-delete)
  and never consumed, so a tenant marked for deletion kept every byte. This finishes the
  lifecycle as the tenant analogue of §4.4's scope reap.

  `tenantStatus` gains a terminal `reaped` past `deleting`, and the `tenants` row gains a
  `deletingAt` timestamp (stamped on entering `deleting`, cleared on un-delete) so the grace
  window can be aged. `deleting` stays a reversible pause — every scope already fails `getScope`
  closed under a non-active tenant, so nothing is destroyed until a reap, and an un-delete (→
  `active`) restores the tenant whole. `reapTenant` (new on `HostAdmin`, directory-side only)
  clears the tenant's PII/config directory rows — identities and identity pools, membership
  tuples, roles, entitlements, orgs — and flips the row to a `reaped` tombstone, keeping the
  `tenants` row (burned slug + history) and `_substrat_admin_log` whole. It refuses any tenant
  not in `deleting`; `reaped` is unreachable via `setTenantStatus`.

  Delivered over one seam, two ways: a staff-only `POST /tenants/:t/reap` ("reap now", armed in
  the console behind a type-the-slug dialog, refused with 409 unless the tenant is `deleting`),
  and a `runPlatformSweep` phase that reaps tenants whose `deletingAt` is older than
  `TENANT_RETENTION_DAYS` — opt-in and unset by default, because the reap is irreversible. The
  per-scope byte-wipe runs above the kernel: the reaper archives-if-needed then reaps each scope
  through the existing `reapScopeFn` seam (so the control plane's orchestrated per-scope wipe
  applies for free), then clears the directory via `reapTenant`.

  Also settles #36's retention question: the admin log is the compliance witness (bokföringslagen
  §5.3) and is deliberately **never swept** — no TTL. The bound against dumping an ever-growing
  table lives on the read surface instead: `GET /admin-log` now defaults a page size (the
  in-process `auditLog` stays unbounded, so an internal caller that wants everything still gets it,
  and `nextCursor` walks the whole log).

  Full-tenant export (GDPR Art. 20 portability) is intentionally out of scope here — the per-scope
  `exportScope` seam it builds on already exists.

## 0.24.0

### Minor Changes

- 72b1128: Entitlements express a plan (#33): the two-column SKU flag grows `expiresAt`,
  `quota`, `plan` and `grantedAt`/`grantedBy`. Expiry is the one field the kernel
  itself enforces — an expired grant fails closed at the per-invoke gate exactly as
  if revoked, checked lazily at read like tuple expiry (never swept), and the row
  stays in `listEntitlements` so a lapsed trial reads as lapsed rather than
  never-granted. Quota and tier are expression only, per the D-33 reframe: they
  describe the builder's subscription, and counting usage against them is the
  builder portal's job — which is why plan _expression_ lands ahead of billing
  (#39 stays blocked on meters). Grant calls are PATCH-shaped: omitted fields
  preserve what the row carries (a bare re-grant on an idempotent provisioning
  path cannot silently turn a trial perpetual), explicit null clears, and any
  effective change is a renewal audited with before/after. `listEntitlements` now
  returns `EntitlementGrant[]` instead of `string[]`; the PUT route accepts the
  plan as an optional body (a bodyless PUT stays the bare-flag grant); both
  adapters widen `_substrat_entitlements` with nullable columns via the existing
  ensure-column path, so legacy rows read as perpetual boolean flags — exactly
  their old semantics. The console shows and edits the plan half; Callout's boot
  mirror forwards whole grants so the shared plane never sees a trial as
  perpetual.
- 1cfce31: A hosted vertical reads its entitlements at request time from a scope-local projection (#304),
  settling kernel open-question 5 with the same answer as the routing cache.

  Entitlements used to be a coordinator-only, trust-at-provision check: it gated _module loading_,
  but a dispatched worker could not read `plan`/`quota`/`tier` at request time — the `CONTROL_PLANE`
  binding is forbidden by the sandbox contract (#302) — and a CP-less scope short-circuited the gate
  to `true`, enforcing nothing in-request, not even expiry.

  Entitlements are now **projected into each scope** alongside roles and tenant tuples, extending the
  scope-local-permissions machinery rather than duplicating it:

  - **`OperationContext` gains `entitlement(key)` and `entitlements()`** — the sanctioned request-time
    read. Returns the live view (`key`, `plan`, `quota`, `expiresAt`) or `null`; expiry is applied at
    read, so a non-null result is always live. A hosted scope reads its local projection; a
    console-managed scope reads over the same RPC the permission checker uses. New `EntitlementView`
    contract type.
  - **The per-operation gate fails closed against the projection** on the scope-local path — expiry
    and revocation now enforce at request time in a hosted vertical, not only at provision.
  - **A grant/revoke fans out to invalidate** the projected scopes — the event-invalidation half of
    kernel open-question 5's answer (cached in scope DOs with event invalidation), deliberately the
    same project-on-write mechanism the routing/suspension cache defers to.

  Two posture calls, per #33's grain:

  - **Expose, don't enforce** `quota`/`plan`: the kernel gates presence + expiry; the vertical reads
    the number and enforces its own quota (no kernel usage-counting).
  - **Fail-closed enforcement flips per scope** via an `entitlements_enforced` marker set the first
    time entitlements are projected — a scope provisioned before #304 keeps trusting upstream until a
    fan-out / reconcile / re-provision back-fills it, so the switch to strict enforcement strands no
    live scope.

  `provisionScopeLocal` accepts an optional `entitlements` list (the platform passes the tenant's
  grants at provision). Scoped out as a follow-up: the platform→dispatched-vertical provision path
  (control-plane-api) does not yet _pass_ entitlements into `provisionScopeLocal`, so re-projection to
  a live dispatched worker rides re-provision/reconcile until that is wired; expiry still enforces
  locally meanwhile, because the projected row carries it.

- aa503c2: Record what authorized a mutation on its event, and what was refused (K-34, K-35).

  **K-34 — authorization on the event envelope.** `ctx.check` computes a `Decision` whose
  allow branch carries the proof chain, and the kernel discarded it — so a mutation-event
  recorded who acted but never under what authority. `DomainEvent` gains an optional,
  kernel-stamped `authorization: {permission, grant?}[]`: the checks the emitting operation
  passed, plus — when the allow came via a capability grant rather than a role — the granting
  tuple's `object` (the entity/node it was granted on). The shape correction from the design
  note: there is no grant _id_ — a grant is a relation tuple with no surrogate key, so the
  tuple's object is what names it; `contracts` exports `grantRefFromProof` for this. The full
  proof chain is not persisted (`explain` re-derives it); only the pointer re-derivation
  cannot recover — which check was consulted at write time — is kept. Module code can neither
  supply it (not on `DomainEventInput`) nor suppress it; system/override actors are
  unconditionally allowed, so their checks are not recorded. The operation context is now
  built fresh per invoke so the accumulator cannot leak across operations.

  **K-35 — a scope-local denial log.** `assertAllowed` threw `PermissionDenied` and nothing
  recorded it. A denial happens in the scope's serialization domain and rolls its own
  operation back, so it cannot reach the directory access log and would be erased if written
  in the operation's transaction. It now lands in a scope-local `_substrat_denials` (actor,
  permission, node, operation, at, drained_at), recorded at the operation boundary the moment
  a `PermissionDenied` unwinds it — a fresh autocommit write after the rollback, so it
  survives. Only enforced denials record; a bare `ctx.check` a module branches on is not a
  denial. `PermissionDenied` now carries the checked `permission` and `node`.

  Both surfaces are additive kernel-schema changes (a nullable `_substrat_outbox.authorization`
  column and the new `_substrat_denials` table), applied on both adapters (pure-SQLite and the
  DO port) via KERNEL_DDL + an additive column on existing scopes. Legacy outbox rows read as
  `authorization` NULL — honestly unrecorded, not empty. Held to the same contract on both
  adapters by new cases in the permission contract suite.

- 5a3ef82: Ship the vertical's declared permission surface in the deploy manifest (D-39).

  The permission registry — every key + description a registered manifest declares, the
  role templates provisioning defines, and the entity-grant shapes — existed only at build
  time as `demos/*/PERMISSIONS.md`. The deploy manifest carried `ownerGrants` and a
  `digests.permission` HASH of that surface, so the platform committed (at promotion) to
  content it did not hold, and the dashboard kept a hardcoded third copy. Worse, the digest
  was a placeholder: it hashed the worker's `bindings`, not any permission content, so the
  "permissions changed" promotion checkpoint fired on binding changes and missed real
  permission changes.

  Now `deployManifest` carries a first-class `registry` (`permissionRegistry`:
  `permissions[]` with `declaredBy`, `roles[]`, `entityGrants[]`), and `digests.permission`
  is its content hash. `tools/permission-diff.mts` emits a machine-readable
  `permissions.json` next to `PERMISSIONS.md` — from the SAME `MODULES` + `ROLES` +
  `ENTITY_GRANTS` the host registers — CI-checked with `--check`, so it cannot drift from
  what is enforced and it never requires the CLI to load (or execute) module code. `push`
  reads that checked-in artifact and injects it; the digest is a canonical, formatting-
  independent hash of the surface, so it moves iff a key, description, role, or grant shape
  moves. Additive and optional (D-28): a vertical shipping no registry hashes the empty
  surface (never bindings again), and the control-plane trust-boundary parse accepts the
  new field unchanged.

  This is what a tenant-facing permissions view (and a real version-to-version admission
  diff) consume without new backend plumbing.

- 4c275df: The hosted-vertical sandbox is a positive binding allowlist, not a denylist (#302).
  `assertSandboxContract` used to refuse a known-bad shortlist — `CONTROL_PLANE`, `service`
  bindings, cross-script DO — and allow **everything else by omission**: KV, Queues, R2, and
  analytics were never named or validated, and an unrecognized binding type sailed straight
  through. "What passes" was an emergent property of what the denylist forgot to ban, so a
  builder couldn't predict admission and the platform couldn't say what it permitted.

  Inverted: a vertical may now declare only its OWN resources, from one written set —
  `ADMISSIBLE_BINDING_TYPES` in `@substrat-run/contracts`, so the CLI can predict admission
  from the same list the control plane enforces. Permitted are its `durable_object_namespace`
  (own class only — no `script_name`, `class_name` ∈ declared `doClasses`) and own data stores:
  `d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`, plus inert `secret_text` /
  `plain_text` config. Anything else is refused **by omission**, with a message that names the
  offending binding and its type and points at self-serve-deploy.md §4.1.

  Two posture calls, now documented rather than incidental: own→own **`service` bindings stay
  rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform
  reach is the router, K-27); own **`d1` stays admitted**, but its `database_id` ownership is
  still unproven and trusted under model-B human admission until platform provisioning injects
  the id (#301). `CONTROL_PLANE` is refused by **name** whatever type it claims, so a
  masquerading binding can't slip through the type check.

  `type` stays a free string at the schema layer on purpose: a refused type produces a named,
  actionable rejection instead of a generic Zod parse error. Decision D-40; §4.1 enumerates the
  full permitted/rejected/why table.

- d4bf108: Surface hostname binding is operator-facing (K-26 multi-surface exposure — the Egeryds
  EKA ask). The vertical side always worked: one scope, one worker, one bundle, and
  `readRoutedNode(...).surface` decides which app the hostname serves. What was missing
  was any way to GIVE a second surface a URL; `bindHostname` existed but nothing
  operator-facing called it.

  The dashboard's Domains tab is now real: it lists an app's bindings (hostname, surface,
  status, canonical), mints a platform hostname for a surface (`crm.global…` + `eka` →
  `crm-eka.global…`, live immediately — it rides the wildcard cert), records a custom
  domain as `pending` into the §4.2 lifecycle, and unbinds with the canonical-demotion
  rule stated in the UI. The default hostname is refused for removal — deleting the app
  retires it. Both mutations gate on `dashboard:provision-app` in the caller's own scope
  and land on the activity trail as `hostname-bound` / `hostname-unbound` (migration 0009
  widens the event CHECK, rebuild-and-copy like 0005–0008). A custom-domain form never
  accepts platform names — that path is the mint, so labels can't be squatted cross-tenant.

  The control plane's hostname routes join `BUILDER_ROUTES`, tenant-narrowed: a builder
  lists only its own tenant's rows (a foreign `tenantId` in the query loses silently),
  binds only into its own tenant, never supplies `region` (an EU-residency claim, K-30),
  and a foreign hostname on status/unbind reads 404 — indistinguishable from absent. CLI
  parity rides that: `substrat hostnames <slug>` lists an install's bindings,
  `… bind <slug> --surface eka [--domain …] [--scope …]` mints or records, `… unbind
<hostname>` removes.

  Verticals may declare their surfaces — package.json `substrat.surfaces: [{ name,
label }]` rides the deploy manifest to the registry like `envSpec` (metadata, not
  behavior, not in any digest; the anchor #111's per-surface operation-sets extend
  later). The declaration buys the Domains tab a picker instead of free text, and a
  push-time warning naming any hostname still bound to a surface the new version stopped
  declaring — the same spirit as the permission-surface gate, advisory tier. Free-text
  surfaces stay valid everywhere; declaring nothing opts out of the check.

## 0.23.0

### Minor Changes

- 6a86837: Builders keep the substrate vocabulary (#190 part B, D-38): a vertical declares what it
  needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in package.json
  (`entry`, `needsNodeCompat`, an optional pre-bundle `build` command, and its own
  `stores`: binding → durable state class) — and never authors `wrangler.jsonc`. At push
  time the CLI derives the wrangler config (`wranglerConfigFor`), feeds it to the bundler
  via `--config` (written next to the vertical, removed after the build), and assembles
  the deploy manifest from the same derived object, so declaration and bundle cannot
  drift. The compatibility date is the platform's `RUNTIME_BASELINE` (new in contracts) —
  a builder states needs, never substrate config.

  The vocabulary is complete at four fields _because_ the §4 sandbox contract is strict:
  it refuses everything except a vertical's own stores, so own-stores + node-compat + a
  build command is the whole of what a builder may legitimately say. Datastores beyond
  own stores are deliberately absent — those are platform-provisioned, never
  bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is
  ignored (with a note) when `runtimeNeeds` is present.

  Honest limit, unchanged from the issue: this neutralizes the _declaration_, not the
  _toolchain_ — wrangler still bundles in the builder's CI.

## 0.22.0

### Minor Changes

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

## 0.21.0

## 0.20.0

### Minor Changes

- d18d788: `buildOpenApiDocument` + `ApiCatalog`: a vertical exports an operation catalog (operation name → summary + the same Zod schemas its handlers parse) and gets an OpenAPI 3.1 document — served live at `/openapi.json` and checked in via `pnpm lint:api` (design/api-surface.md). Uses Zod 4's native draft-2020-12 emit; no new dependencies.
- a39a024: Backup restore / backout (§8's write half): `ScopeHost.restoreScope` loads a
  `ScopeDump` into an EXISTING scope in place (drop-then-replay, migration frontier
  included) — audited as `restoreScope`, refusing unknown scopes. Threaded end to end:
  `restoreScopeLocal` on the Cloudflare host, `/internal/restore` on the vertical
  surface (VerticalClient + the Manyfold reference worker), a staff-only
  `POST /tenants/:tenantId/scopes/:scopeId/restore` control-plane route that delegates
  to the bound version's deployment, and `substrat scope restore <scopeId> --file
<backup>` — accepting a `scope pull` .sqlite, a local adapter-sqlite scope file, or
  a .dump.json.

## 0.19.0

### Patch Changes

- b4a6bee: Routing schemas accept prefixed vertical registry ids: `hostnameBinding.verticalSlug`
  and `routeTarget.verticalSlug` now use the `verticalSlug` schema
  (`<tenantSlug>/<name>` or bare) instead of the bare `slug` pattern. Before this, an
  installed builder vertical's hostname row failed the Zod boundary on read-back, so
  the bind was silently discarded and the app ended up with no URL.

## 0.18.0

### Minor Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.

## 0.17.0

## 0.16.0

### Minor Changes

- b23c0a7: The Data tab grows a SQL console (#219): `HostAdmin.queryScope` runs ONE read-only SQL
  statement against a scope's own database, next to the table-shaped reads that stay safe
  by construction. User SQL reaching the DB moves the safety to statement-level
  enforcement, in two layers shared across adapters:

  - the kernel's `assertReadOnlyQuery` — a comment/string/identifier-aware token scan
    that rejects multi-statement input, a first keyword outside SELECT/WITH/VALUES/
    EXPLAIN, and any bare write/DDL/session verb anywhere (`WITH … INSERT INTO` is valid
    SQLite, so the first keyword alone proves nothing); deliberately over-strict, since a
    false positive costs a quoted identifier and a false negative forges the spine;
  - an adapter-authoritative backstop: better-sqlite3's `prepare().readonly`
    (sqlite3_stmt_readonly) on the pure adapter, and a transaction that ALWAYS rolls
    back inside the ScopeDO, whose `exec` has no read-only flag.

  Results are positional rows capped at `SCOPE_QUERY_ROW_MAX` (200) with a `truncated`
  flag — a ceiling, never an error. Same K-3 (tenantId, scopeId) cross-check and K-24
  access log as the table reads; the logged argument is the SQL itself. The refusal
  message prefix (`read-only console:`) is contract — pinned by the shared suite against
  both adapters and mapped to 400 by the transport.

  Transport: `POST /tenants/:tenantId/scopes/:scopeId/query` with the same
  vertical-delegation as the table reads (`VerticalClient.queryScope` →
  `/internal/query`); a vertical that cannot answer safely refuses with its own status,
  relayed verbatim — auth-server keeps refusing via its `/internal/*` 501 catch-all,
  because its DO redacts secret-bearing columns on table reads and arbitrary SQL would
  walk around the redaction. Editing rows stays out of scope forever: a write here would
  bypass the event log and forge the spine.

- 81e9408: The deploy manifest becomes a shared contract (#190 part A): `deployManifest` and
  `DeclaredBinding` move from `control-plane-api` into `@substrat-run/contracts`, and
  BOTH ends of the push seam now speak the same schema — the CLI parses the manifest it
  builds with `deployManifest.parse(...)` before uploading, the control plane re-parses
  it at the trust boundary and runs the §4 sandbox contract against the result.

  Before this, `push.ts` hand-rolled a parallel manifest object against a local
  `DeclaredBinding` interface while the server parsed the real Zod schema — a drift
  hazard on the deploy trust boundary, where a shape mismatch surfaced only as a 4xx
  from the deploy endpoint. Now drift is a compile error (shared types) or a local parse
  failure before any bytes are uploaded; a CLI-side effect is that registry metadata
  (`envSpec`, `ownerGrants`, `provides`, `requires`) is validated at push time too.

  `control-plane-api` re-exports the schema and types unchanged, so hosts keep importing
  from the transport package. The CLI gains its first runtime dependency
  (`@substrat-run/contracts`) — deliberate: the alternative was the drift. Part B of
  #190 (a substrate-neutral `runtimeNeeds` manifest section) stays open, gated on the
  product decision the issue describes.

## 0.15.0

### Minor Changes

- ec89a88: Vertical lifecycle: delete a vertical, and block new installs of one.

  **`deleteVertical`** (HostAdmin + `DELETE /verticals/:slug`, staff-only): removes the
  registry row, its versions, and its channels — **refused while any scope is still
  bound** to the vertical, naming the count, so a delete can never strand a live scope's
  version pin or routing. Deployed dispatch scripts are left as orphans for the cleanup
  script (#248), never reaped inline. Audited. The console's vertical detail card gets a
  type-the-slug-to-confirm Delete.

  **`installsBlocked`** (new registry flag + `setVerticalInstallsBlocked` /
  `POST /verticals/:slug/install-block`, staff-only): the install kill-switch, orthogonal
  to `listed`. A blocked vertical is hidden from the dashboard's install catalog and the
  control plane refuses to provision an instance of it (403) — for everyone, owner
  included. Existing scopes keep serving: it gates provisioning, not serving. Additive
  `installs_blocked` column in both adapters (attempt-and-tolerate migration, default 0).
  Console gets a Block/Allow installs toggle and a "blocked" badge.

  The console also now shows **timestamps**: when each version was pushed (table +
  promote picker), when each channel pointer last moved, and when a vertical was
  registered.

### Patch Changes

- cd32011: Marketplace apps/verticals split + the empty-marketplace fix.

  **Adapters:** `registerVertical` now refreshes `listed` on an identical re-registration
  of a **builtin** vertical (it is seed metadata, derived from the catalog's `connected`
  flag). Rows registered before the `listed` column existed (migration default 0) were
  stuck unlisted forever, so the hosted marketplace rendered empty. A pushed (`cli`/`git`)
  vertical's `listed` stays untouched — re-pushing a published vertical still cannot
  silently unpublish it.

  **Dashboard:** the create-app page is now pure instantiation, grouped **Marketplace**
  (published) and **Your verticals** (your team's own, badged Private/Published, disabled
  until a version is promoted to prod). The Deployments page is renamed **Verticals**
  (`#/deployments` stays as an alias) and takes over the supply side: the GitHub
  import + one-click CI scaffold move there from create-app. `GET /api/catalog` returns
  `{owned, listed, source, installable}` and, in connected mode, merges the shared
  control plane's registry — so a pushed vertical shows up and (via the same fallback in
  `installSpecFor`) installs in production, not just embedded mode.

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.

## 0.14.0

### Minor Changes

- 6a7768a: Add a declarative environment surface to the module manifest, carried on the registry.

  - **`envVarSpec` / `EnvVarSpec`** and an optional **`envSpec`** block on `moduleManifest`: a
    vertical declares the environment it needs — key, label, description, placeholder,
    `required`, `secret`, `default`, `group` — self-describing so a host or console can render a
    config form and validate required keys before deploy. Additive-only (decision 28).
  - **`resolveEnvSpec(spec, raw)`** resolves a declared spec against a raw environment (a Worker
    `env`, `process.env`, …): it reads only the declared keys (so the manifest is the single
    source of what an app consumes), applies each `default`, and reports absent `required` keys
    without throwing.
  - **The registry carries a vertical's `envSpec`.** A new `env_spec` column is added
    additively to the vertical registry in both the SQLite and Cloudflare adapters;
    `registerVertical` stores the spec and an otherwise-identical re-registration refreshes it.
    This lets a host/console render a config form for any registered vertical — a bundled
    builtin or a pushed builder vertical — without loading its code.
  - **The push flow carries it.** The `deployManifest` accepts an optional `envSpec`, and the
    `/verticals/:slug/deploy` handler passes it through `registerVertical` — so a pushed
    vertical's declared config reaches the registry (and the dashboard form) like a builtin's.

- 1022c15: **Registry-driven marketplace, phase 3b** (marketplace-publish.md §5) — request-to-publish in
  place, so a builder can drive the whole loop.

  - `HostAdmin.requestPublish(actor, slug)` — an owner records a pending publish request; sets the
    registry `publish_requested_at` on the vertical (both adapters), audited (`requestPublish` admin
    action). `setVerticalListed` now **clears** the request when staff reviews and lists it, so the
    pending queue drains itself.
  - Control-plane endpoint `POST /verticals/:slug/publish-request` — **owner-checked** and on the
    builder allowlist, so an owner asks with a bare slug; staff listing stays the gate.
  - CLI `substrat publish <slug>` now _requests_ listing ("✓ publish requested … an operator will
    review it") instead of flipping it; `substrat unpublish` is the staff unlist.

  The full loop — builder requests → `publishRequestedAt` set → staff lists → `listed` true + request
  cleared — is covered end-to-end (contract-suite across both adapters + a control-plane API test).
  The dashboard "Request to publish" button + a console pending-requests list are the remaining UX.

- 1022c15: **Registry-driven marketplace, phase 1** (marketplace-publish.md) — carry a vertical's
  install metadata to the registry on push, so a later phase can drop the dashboard's hardcoded
  `CATALOG` map.

  - `moduleManifest` gains additive fields: `ownerGrants: permissionKey[]` (the day-one owner
    grant — the role _table_ stays vertical-owned + runtime-customizable), `entitlements`, and
    `provides` / `requires` **capability** lists (`oidc-issuer` etc., wired tenant-side through
    the connection store — no `kind` flag, no bundling). New `capability` contract type.
  - The registry `vertical` + `registerVerticalInput` carry all four; stored as one
    `install_spec` JSON column in both adapters (sqlite + cloudflare), via the existing
    `ensureColumn`/`addColumn` helper, alongside `env_spec`.
  - `substrat push` reads them from `package.json` `substrat.*` and the control-plane deploy
    endpoint validates + stores them on `registerVertical` — exactly the rail `envSpec` rides.

  No behaviour change yet: the dashboard still gates on `CATALOG`. Phase 2 makes
  `availableCatalog`/`createApp` registry-driven.

- 1022c15: **Registry-driven marketplace, phase 2** (marketplace-publish.md §3) — the dashboard's hardcoded
  `CATALOG` map is no longer a gate, so a pushed → promoted → published vertical shows and installs
  with **no dashboard change**.

  - Registry `vertical` gains a `listed` flag (published to the public marketplace) — its own
    column adapter-side (sqlite + cloudflare), set on insert and **never clobbered by a re-push**
    (publish is a distinct action from push).
  - `availableCatalog` is registry-driven: a vertical shows if it's `listed` **or** owned by the
    caller's tenant (private to your team). Takes the caller's `tenantId`.
  - `createApp`/retry read `entitlements`/`ownerGrants` from the registry row (via `installSpecFor`),
    falling back to `CATALOG` for a first-party not yet re-seeded.
  - `ensureCatalog` seeds first-party verticals with their specifics and `listed: connected !== false`,
    so the `CATALOG` map is now just a first-party **seed**, not a visibility/install gate.

  Removes the recurring "add a catalog entry + redeploy the dashboard" step. Phase 3 (the
  staff-reviewed publish action) flips `listed` for builder verticals.

- 1022c15: **Registry-driven marketplace, phase 3** (marketplace-publish.md §5) — the publish action.

  - `HostAdmin.setVerticalListed(actor, slug, listed)` — a staff admission that flips the registry
    `listed` flag (both adapters); idempotent, audited (`setVerticalListed` admin action). Once
    `listed`, `availableCatalog` offers the vertical to every tenant.
  - Control-plane endpoint `POST /verticals/:slug/listing` — **staff-only** (not on the builder
    allowlist), so a builder is refused (the review gate), staff flips it. Mirrors admission (model B).
  - CLI `substrat publish <slug>` / `substrat unpublish <slug>`.

  The `listed` column is set on insert and by this action only — **never clobbered by a re-push**
  (covered by a contract-suite test across both adapters). Any owner may _request_ publishing;
  staff review is the gate (§5). The builder self-serve request surface (a dashboard "Request to
  publish" button) is the remaining UX — the same open question as builder-plane's prod-promotion
  request.

## 0.13.0

### Minor Changes

- 74c9d7b: Add `unassignRole` and `unlinkIdentity` to the `HostAdmin` surface — the inverses of `assignRole` and `linkIdentity`, so authority granted through the kernel can also be taken back.

  - `unassignRole(actor, assignment)` revokes a role assignment by tombstoning the role tuple (K-21): the checker stops resolving it, the tuple stays as audit evidence, and a later `assignRole` of the same `(principal, role, node)` reactivates it. Idempotent.
  - `unlinkIdentity(actor, tenantId, principal)` severs a principal's login from a tenant — keyed by principal (so the caller needs no external subject) and a DELETE rather than a tombstone, so `listIdentityTenants`/`resolveIdentity` stop returning it and a re-invite can re-link a fresh principal.

  Both are implemented in the SQLite and Cloudflare adapters (with a generic tenant/scope tuple revoke on the Cloudflare DOs) and add matching `adminAction` log entries. Together they unblock self-serve member removal: cut a member's access and drop the team from their surface.

## 0.12.0

### Minor Changes

- 73c0cdb: **A vertical now records its owning tenant (builder-plane.md Phase 1b).** The registry
  gains an `owner_tenant` column: `NULL` = platform-owned (Callout, the dashboard), a value
  = the tenant that pushed it. Ownership is the gate a later phase checks for who may push
  new versions and manage a vertical's non-prod channels.

  - **`vertical.ownerTenant`** (contracts) — nullable branded `TenantId`; `registerVerticalInput`
    takes it optional (defaults to `null`, so a staff/platform push keeps passing
    `{slug, name, source}` unchanged).
  - **Migration in each adapter** — `owner_tenant TEXT` added idempotently to the `verticals`
    table (`ensureDirectoryColumns` in sqlite, `addColumn` in `control-plane-do`), so an
    existing directory backfills to platform-owned.
  - **Claim-on-first-push** — `registerVertical` fixes a slug's owner at first push: a later
    registration under a _different_ owner (or an attempt to claim a platform vertical) is
    refused, naming both owners. Identical re-registration stays idempotent.

  The `<tenant>/<name>` slug prefix that keeps builder slugs globally unique is constructed at
  push time in a later phase; this change is the ownership column + claim mechanism it rests on.

  Verified: sqlite (147) + cloudflare (146) suites pass, including a new shared assertion that
  a registered owner round-trips through `listVerticals` and that a conflicting owner is refused.

- 1dff2bd: **Builder writes — self-serve deploy, end to end (builder-plane.md Phase 3).** A tenant user
  can now `substrat login`, `push`, and `promote` their own verticals without staff, and the
  control plane forms the `<tenantSlug>/<name>` id they never type. This makes the Phase-2
  authz mechanism live.

  - **Prefixed vertical ids (`verticalSlug`)** — a new contracts brand allows an optional single
    `<tenantSlug>/` prefix; the registry schemas use it. A builder pushes a **bare** `--slug`;
    the control plane prepends their authenticated tenant's slug, so two tenants can each own a
    `helpdesk` with **no global claim race** (Vercel-style non-scarce namespace). Platform
    verticals stay bare. `deploymentRefFor` already flattens the `/`; hostnames never carry it.
  - **The live builder reader** (`oidcBuilderReader`, control-plane worker) — the same signed
    session the CLI/console carries resolves via the shared identity directory to the tenants a
    user belongs to, narrowed to the selected one → a `(actor, tenantId, tenantSlug)` builder
    principal. **No vetting roster**: self-serve is the point; a user with no workspace is
    declined (sign up in the dashboard first). The audited actor is a stable
    `PlatformActorId` derived from the OIDC subject.
  - **`effectiveSlug`** threads the prefix through every builder vertical route
    (`control-plane-api`), so ownership, filtering and dispatch all key on the real id.
  - **`GET /api/auth/whoami`** — the session's user + the tenants it can build for. The CLI
    calls it on `login` to store a default workspace (prompting when there are several).
  - **CLI** — `substrat whoami`; `substrat promote <slug> --channel dev|staging --version <id>`
    (a builder self-serves non-prod; prod + admission stay staff, model B); `--tenant` /
    `SUBSTRAT_TENANT` / a stored default, sent as `x-substrat-tenant` with a browser session.

  Scope: no auto-bootstrap of a workspace from the CLI (a builder signs up once in the
  dashboard, then the CLI just works) — flagged as a follow-up.

  Verified: control-plane-api (71) incl. the reworked builder matrix under prefixing (each
  tenant gets its own namespace, no collision), control-plane worker (17) incl. a live
  end-to-end builder path (bare push → `acme-co/helpdesk`, whoami, fail-closed no-workspace),
  adapter suites (147 + 153) and `pnpm -r typecheck` all pass.

- 66e752b: **The router dispatches on the scope's bound version (orchestration.md Phase 3, §5.4).**

  `routeTarget` gains `deploymentRef` (nullable): the dispatch script the scope's bound
  version deploys as. The directory read (`resolveHostname` / `readHostname`) now LEFT-joins
  `scope → vertical_version` to resolve it in the same one DO call, so the hot path stays a
  single read.

  The router's `verticalFor` becomes `env.DISPATCH.get(deploymentRef)` when the namespace is
  bound and the scope has a version — the one-line swap K-28 anticipated — falling back to the
  static `VERTICAL_<SLUG>` service binding for a route with no version. A pushed vertical is
  now reachable through the router without redeploying it. The bounded `Worker not found.`
  retry (K-29), armed since K-28, is now live: it fires on the dispatch path.

  Adapters (`adapter-sqlite`, `adapter-cloudflare`) version with contracts (fixed group).

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

## 0.11.0

### Minor Changes

- 858912e: **`jurisdiction` is now `eu | us | global` (non-nullable), defaults to `global`, and `eu`/`us` are gated at the provisioning boundary (K-32).**

  Jurisdiction is fixed at provisioning and a scope's DO can never relocate (K-7), so
  the storable vocabulary has to be final before the first production scope exists —
  widening what can be _stored_ later is a data migration, widening what is _accepted_
  is a one-line change. Two findings forced the shape:

  - **It was recorded but never enforced.** The only DO id minting is
    `idFromName(scopeId)`; `newUniqueId`/`ns.jurisdiction(...)` appears nowhere but a
    deferral comment. So `eu` on a scope today moves no storage and terminates no TLS.
  - **`z.enum(['eu']).nullable()` made `null` mean both "unconstrained" and "nobody
    decided"**, and the provisioning input defaulted to it — so absence silently
    became a residency posture.

  So: `jurisdiction = z.enum(['eu','us','global'])`, non-nullable, defaulting to
  `global` (the honest name for what every scope already is — no subnamespace, placed
  near first access). Legacy `null` rows coerce to `global` on read in both adapters.
  A separate `provisionableJurisdiction = z.enum(['global'])` gates the control-plane
  HTTP boundary: `eu`/`us` are storable but refused with 400 until their enforcement
  (DO jurisdiction subnamespace, Regional Services) is built — `us` is not even a
  Cloudflare DO jurisdiction, so it is a different mechanism behind the same word.
  Gated exactly as `STANDALONE`/`ALLOW_DEV_HEADER` are (K-31).

  No SQL migration: the columns were already nullable `TEXT`. The console's create
  dialog gains a jurisdiction picker with `eu`/`us` shown-but-disabled, so the roadmap
  is visible where the choice is made. Deriving `hostnameRegion` from the scope
  (rather than accepting it separately) is the natural follow-up and is deferred — it
  is not immutability-sensitive.

  The `@substrat-run/*` published packages version together (changesets `fixed`
  group), so kernel, adapter-sqlite, adapter-cloudflare, contract-tests, and
  control-plane-api move with contracts.

## 0.10.0

### Minor Changes

- 9c1f0bb: **The connection store, and the first encryption primitive in the codebase.**

  Per-tenant credentials for external providers had nowhere to live. `master-plan.md §6`
  committed to a connection store; `kernel-design.md §1` deferred "the integrations hub beyond
  its contract stub", and the stub was never written either — no `Connection` type, no
  credential storage, nothing.

  **Keyed on (tenant, vertical, provider)**, not tenant alone. A vertical is a blast-radius
  boundary (D-30) and verticals are built by different companies (D-33), so one vendor's host
  code must not reach a credential another vendor connected for the same tenant. It also
  matches how OAuth issues clients. Cross-vertical sharing, if a real case ever appears, is an
  explicit grant rather than the default.

  **`SecretBox` is a new adapter surface** — D-18 classifies the KMS as an adapter. Before this
  every `crypto.subtle` call in the repo was a one-way digest and every secret was a plaintext
  Worker binding: nothing per-tenant, nothing rotatable, nothing encrypted at rest.
  `webCryptoSecretBox` (AES-256-GCM, fresh IV per seal, key id for rotation) is the default;
  Cloudflare Secrets Store or an external KMS drop in behind the same interface. A host with no
  `SecretBox` **refuses to store a credential** rather than storing one in the clear.

  Two leaks designed out rather than remembered:

  - `_substrat_admin_log.before`/`after` take arbitrary JSON and the log is **append-only**, so
    a credential written there could never be removed. Connection mutations log metadata only.
  - `adminAction` is a closed enum that `auditLog` parses _every_ row through, so unrecognised
    actions fail the read of the whole log. Three members added.

  Revoking **destroys the sealed blob** and tombstones the row: a grant that once existed is
  evidence of why an access was allowed (K-21), but keeping the usable credential would make it
  a liability. Uniqueness is over live rows, so a revoked connection can be replaced.

  New on `HostAdmin`: `createConnection`, `listConnections`, `updateConnectionSecret`,
  `revokeConnection`, `openConnection`, `recordConnectionUse`. `openConnection` takes no actor
  and is not audited — the same exemption `resolveHostname` and `resolveIdentity` hold, for the
  same reason: an audit row per outbound HTTP call would drown the log that matters. Health
  (`lastOkAt`/`lastError`) is what an operator can act on instead.

  Ten new **contract** tests, so both adapters must agree — including that the credential
  appears in neither a metadata read nor the audit log, that another vertical cannot open it,
  and that revoking destroys it.

  **These methods take a `PlatformActorId`, which is a deliberate deferral, not an answer.**
  Connecting a provider is a tenant admin's act, and routing it through a platform actor is the
  defect D-31 named for `addMember`. Recorded in `docs/architecture/connections.md` §3.5; no console
  flow should be built on this signature until the question is settled with membership's.

- 113160a: **The inbound authority seam (#97): a connection is a subject.**

  A provider's callback has to write back into a scope, and it is not a person. `getScope`
  demands a `PrincipalId`, so a connector could dispatch a document and then be unable to record
  that it had — which under at-least-once delivery means a retry sends a **second** one.

  ```ts
  getConnectorScope(connectionId, scopeId): Promise<ScopeStub>;
  grantToConnection(actor, grant): Promise<void>;
  ```

  **The door inherits its narrowing.** A connection is keyed (tenant, vertical, provider), so
  `getConnectorScope` refuses another tenant's scope, another vertical's scope, and a revoked
  connection — none of it re-declared, just the key enforced where it could have been widened.

  **Authority is an ordinary permission grant**, not a second mechanism. Tuples already expire,
  tombstone on revoke (K-21), carry a proof, and appear in the permission diff. A parallel
  "allowed operations" list — the first design — would have been a second gate that only one of
  the two would show up in a review.

  **A connection is not a person, and the model now says so.** `PermissionChecker.check` takes a
  `CheckSubject` (`{ kind: 'principal' } | { kind: 'connection' }`) instead of a `PrincipalId`.
  Minting a principal per connection would have been cheaper and wrong: every audit view would
  show a `principal:` subject for something that is not one — the confusion `PlatformActorId`'s
  separate brand exists to prevent. So the tuple proof reads `connection:01J…`, the event actor
  is `{ connection }` beside the existing `{ system }`, and membership expansion is skipped for a
  connection rather than queried — it belongs to no org and holds no role, so a role carrying a
  permission cannot leak into it.

  **Breaking for custom checkers.** Any `PermissionChecker` implementation must take a
  `CheckSubject`; `asPrincipal(id)` is exported for the common case. Both built-in adapters and
  the contract suite are updated.

  Five new tests in the permission contract suite, against the real tuple checker on both
  adapters: opening the door confers nothing · a grant allows exactly what it names and proves it
  with a `connection:` tuple · no roles or memberships leak in · another tenant's or vertical's
  scope is unreachable · revoking the connection closes the door in the same act that destroys
  the credential.

## 0.9.0

## 0.8.0

## 0.7.0

### Minor Changes

- c54637b: The hostname map: `hostname → (tenant, scope, vertical, surface, region)`.

  A provisioned scope had no URL, so "validate it works in production" had nowhere to
  point. `contracts/routing.ts` adds `hostnameBinding` and `routeTarget`, and `HostAdmin`
  adds `bindHostname` / `setHostnameStatus` / `listHostnames` / `resolveHostname`.

  `surface` is the correction: one hostname per scope was already wrong, because a single
  scope fronts a storefront and a back office, or a player app and a manager console.

  `region` sits on the binding rather than in a router deployed per jurisdiction, because
  Cloudflare's Regional Services is configured per hostname — residency is one more
  column, not a second topology.

  Bindings have a lifecycle (`pending` → `verifying` → `active`, or `failed` with a note),
  since a custom domain is DNS validation and certificate issuance rather than a string
  somebody sets. Only `active` resolves. `resolveHostname` takes no actor and is not
  logged — the machine-path carve-out `resolveIdentity` already has — and does not
  re-check suspension, which `getScope` owns.

  Additive on every published surface: new schemas, new `HostAdmin` methods, new tables.
  Nothing existing changed shape.

### Patch Changes

- 33fb5dd: Verticals can serve more than one tenant: the router's side of K-26, plus K-27.

  `@substrat-run/kernel` exports **`readRoutedNode`**, which reads the `(tenant, scope,
surface)` a router asserted in `x-substrat-*` headers and decides whether to trust it.
  Three outcomes, kept distinct: `null` when no router fronted the request (a standalone
  deploy substitutes its own node), a throw when the assertion is present but unsigned,
  incomplete or malformed, and the node when it is good. Collapsing the middle case into
  `null` would let a forged assertion fall through to whatever the caller does for
  "unrouted".

  Trust comes from a shared secret, compared in constant time. K-26's real boundary is
  that vertical workers have no public route — but that is a deployment fact and
  `workers.dev` is on by default, so the secret is what makes the boundary hold in code
  when the configuration slips.

  `@substrat-run/adapter-cloudflare` adds a **`/routing` subpath export** with
  `createRouteResolver`: hostname → route target over the control-plane DO, and nothing
  else. The package root re-exports the scope-DO class, which a router must not carry —
  it resolves a name and forwards, and should not be able to open a scope at all.

  `@substrat-run/contracts` now **normalizes hostnames to lower case** in the schema.
  DNS is case-insensitive, so storing `ACME.example.com` and `acme.example.com` as two
  rows would let two scopes each hold "the same" hostname and let a request resolve to
  whichever casing it arrived in.

  Additive: new exports and a new subpath. Nothing existing changed shape.

## 0.6.0

## 0.5.0

## 0.4.0

### Minor Changes

- 6900431: The directory becomes readable, and gets an HTTP surface.

  **New package: `@substrat-run/control-plane-api`** (AGPL-3.0-only + commercial,
  like the kernel it sits on). One Hono router over `HostAdmin` — the audited
  control-plane transport. Web-standard only, so the same router mounts in a Worker
  holding the `controlPlane` binding or behind a Node server. It is not module code:
  it never receives a `ctx` and never runs in a scope's serialization domain.

  **`HostAdmin` gains a read side.** The write side was complete; nothing could
  enumerate what it had written.

  - `listScopes(filter?)` / `getScopeRecord(tenantId, scopeId)` — the scope
    inventory §3.2 always claimed the directory was. `getScopeRecord` cross-checks
    the pair and returns `undefined` for another tenant's scope, the same
    fail-closed rule `getScope` applies (K-3).
  - `listRoles(filter?)` — roles were writable and not enumerable since the
    permission model shipped. Returns `TenantRole` (a `RoleDefinition` plus its
    tenant).
  - `auditLog(filter?)` widens: filter by scope, actor, action or time; `limit`,
    `cursor` and `order`. The cursor is the entry's own ULID — order is
    chronological, so a page carries its own continuation. **The default order is
    unchanged** (oldest first), so existing callers do not shift.

  **The `scope` contract is now enforced rather than aspirational.** It described
  `slug`/`kind`/`name`/`parentScopeId` and was parsed by nothing while the table had
  none of those columns. Every read now parses through it, and `Scope` gains
  `vertical`.

  **`ProvisionScopeInput` extends additively** — `slug`, `kind`, `name`, `vertical`
  are optional with behaviour-preserving defaults, so existing callers are
  untouched. An unnamed scope's slug defaults to its lowercased id (a ULID
  lowercases into a valid slug, so it is valid and unique by construction).

  **`schemaVersion` and `vertical` stop being placeholders.** Both shipped as
  columns written by nothing — `schemaVersion` was always `'0'`, `vertical` always
  `null`. `schemaVersion` is now the applied-migration count; `vertical` is stamped
  onto audit targets for scope-lifecycle actions.

  **Directory schema change, applied in place by both adapters.** The `scopes` table
  gains `parent_scope_id`/`slug`/`kind`/`name`/`vertical`, plus a unique index on
  `(tenant_id, slug)` and one on `tenants(slug)`. The directory is not a module and
  has no `SqlMigration[]` journal, so each adapter upgrades on open: add the columns,
  backfill legacy rows to the same defaults `resolveScopeRecord` applies, then create
  the unique indexes **after** the backfill (a unique index over NULL slugs would
  permit the duplicates it exists to forbid). No action is required of callers; an
  existing directory opens and migrates itself.

  **Slug uniqueness is now enforced**, which it never was despite the contract saying
  "unique within tenant". `createTenant` and `provisionScope` fail closed on a
  collision rather than reporting a silent no-op — `INSERT OR IGNORE` would have
  swallowed a colliding-slug-different-id create and reported it as idempotent.

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

## 0.2.1

### Patch Changes

- d929987: Control plane §4.3: entitlement store — `manifest.entitlementKey` finally gates loading

  `manifest.entitlementKey` was declared on every module and read by nothing (D-20
  was a promise with no mechanism). Now a per-tenant `_substrat_entitlements` set
  gates module loading, default-deny: an operation whose owning module's SKU flag
  the tenant does not hold does not resolve — the same fail-closed shape as manifest
  `withdraws`. New `HostAdmin.grantEntitlement`/`revokeEntitlement` (idempotent,
  audited) and `listEntitlements`. The check runs per invoke (the simple, uncached
  path — a DO-cached variant is kernel-design open question 5). Entitlement flags
  are the SKUs meter 2 (§5) counts. Demo seeds grant the flags for the modules each
  vertical runs — the SKU model in use.

- f717014: Control plane §4.4: `PlatformActor` seam + append-only admin audit log (D-30, K-20)

  Every `HostAdmin` mutation (defineRole / assignRole / grant / grantToOrg / addMember)
  now takes a `PlatformActorId` — a staff subject branded distinctly from a tenant
  `PrincipalId` — and writes an append-only row to a new `_substrat_admin_log` in the
  directory, stamped host-side (actor, action, target, before/after, timestamp). A new
  `HostAdmin.auditLog(filter?)` reads it back — the read path for the console history and
  the permission-diff human checkpoint. `defineRole` captures the prior role in `before`.

  Pre-release breaking surface change kept at patch: `HostAdmin` method signatures gained
  a leading `actor` argument. Locally the actor is a dev stub; real staff auth gates
  exposing the surface, not building it.

- 6393a8e: Control plane §4.2: scope lifecycle + structural audit + mandatory tenant

  `provisionScope` becomes the first audited scope-lifecycle transition — it now
  takes a `PlatformActor`, requires an existing active tenant (a scope with no
  tenant record fails closed), and audits. New `HostAdmin.suspendScope`,
  `unsuspendScope`, `archiveScope`, and `unarchiveScope` implement the §3.3
  transitions, validate the legal transition graph (fail closed on an illegal
  one), and audit before/after; un-archive is an explicit restore, never a silent
  flag flip. `getScope` now gates on both tenant-active AND scope-active, so
  suspend/archive actually contain.

  Audit is now a single `recordAdmin` choke point every mutation routes through —
  "no mutation without a durable record" holds by construction, not per-method
  discipline. The step-2 "legacy scopes without a tenant" passthrough is removed:
  every scope has a tenant with a status.

- 2dd4175: Control plane §4.1: tenant registry + lifecycle status

  A real `tenants` table in the directory replaces "a tenant is a ULID nobody used
  before". New `HostAdmin.createTenant` (idempotent, audited), `setTenantStatus`,
  `listTenants`, and `getTenant`. A tenant whose status is not `active` fails
  `getScope` closed for every scope under it — the K-3 fail-closed path, the
  containment lever for non-payment or an incident, reversible without deletion.
  Scopes provisioned without a tenant record (legacy path) are not gated, keeping
  the change backward-compatible.

## 0.2.0

### Minor Changes

- 604883b: Manifest-declared operation guards and operation withdrawal — compliance gates a reviewer can enumerate.

  A vertical declares an unconditional gate in its manifest (`guards: [{ before, predicate, config }]`); a module contributes the named predicate (`predicates` on `ModuleRegistration`, typed `GuardPredicate`); the kernel evaluates it inside the guarded operation's own transaction, before the handler, failing closed. `withdraws` lets a vertical suppress an engine's default operation binding so the guarded wrapper is the only door — without it a gate is reviewable but bypassable. Both are optional and additive: existing manifests parse and behave unchanged.

  The protocol engine gains a `protocol/all-signed` predicate and the `requireCountersigned` in-scope function; the work-order engine exports `closeWorkOrder` as an in-scope function (its `workorder/close` operation is now the thin binding). The scope-host contract suite covers guards and withdrawal, so every adapter must implement both.

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
