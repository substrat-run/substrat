# @substrat-run/model-emit

## 0.8.5

### Patch Changes

- @substrat-run/contracts@0.91.1

## 0.8.4

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0

## 0.8.3

### Patch Changes

- Updated dependencies [7b50231]
  - @substrat-run/contracts@0.90.1

## 0.8.2

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0

## 0.8.1

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0

## 0.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0

## 0.7.3

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.7.2

### Patch Changes

- @substrat-run/contracts@0.86.0

## 0.7.1

### Patch Changes

- @substrat-run/contracts@0.85.0

## 0.7.0

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

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0

## 0.6.0

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

## 0.5.3

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0

## 0.5.2

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0

## 0.5.1

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0

## 0.5.0

### Minor Changes

- 331f91b: The journal readers replay the journal instead of parsing it.

  `journalColumns`, `journalUniques` and `journalPrimaryKeys` now run the journal into a
  throwaway in-memory SQLite and read the schema back through `PRAGMA table_info`,
  `index_list` and `index_info`. Same three signatures, same answers, no parser.

  **Why, rather than another patch.** The previous change fixed seven ways a regex over SQL
  text read a journal wrongly — several columns on a line, a one-line `CREATE TABLE`, a
  `) STRICT;` suffix, a wrapped `PRIMARY KEY (` list, a quoted identifier, a comma in a
  literal, the word UNIQUE in a comment. Finding those took ten minutes of probing, which is
  the argument: a parser over a language it does not implement has no bottom, and each fix
  is a patch against the next spelling. SQLite already implements SQLite.

  **What it removes.** `journal.ts` goes from 388 lines to 82. The `RENAME TO` /
  `RENAME COLUMN` / `DROP TABLE` replay loops — written out three times, once per reader, and
  each a re-implementation of what the database does for free — are gone, along with the
  constraint-rewriting-on-rename special case that had to be verified against a real database
  to be written at all. A table rebuild (`create _new`, copy, drop, rename) is followed
  because SQLite follows it.

  **What it adds.**

  - A journal whose schema statements do not apply now **throws**, naming the statement.
    The old readers answered anyway, which is how a broken migration passes a parity test.
    The first time it ran it caught an invalid fixture written for the previous change: a
    partial index over a column the table did not have, which the parser had accepted.
  - `readSchema` and `statements` are exported for a tool that wants the schema itself.
  - Only schema statements are replayed. A journal's `INSERT`s change no schema, and skipping
    them is what lets a vertical's journal be read alone when it hands data to an engine whose
    tables live in a different journal (decision 28's extraction handoff). Foreign keys stay
    off, so a `REFERENCES` across journals is created rather than refused.

  **Node 22.5+**, via the `node:sqlite` builtin — no new dependency. Not a new restriction in
  practice: this package is a devDependency in all 13 of its dependents, no `src/` file
  imports it, and the builder runs its gates as shell commands in a container. Declared as an
  `engines` floor.

  All 83 tests pass, 77 of them unchanged from before the rewrite — which is the equivalence
  proof, since they are the same assertions against an entirely different implementation.

### Patch Changes

- 3bf2f2f: The journal readers read SQL, not lines (#807).

  `journalColumns`, `journalPrimaryKeys` and `journalUniques` split a `CREATE TABLE` body on
  newlines and took the first word of each. So a journal that put two columns on one line
  reported one of them — the same table, reformatted, produced a different schema. A field
  report measured it: 63 entities, 38 shipped journal entries, **64 `planMigration` refusals,
  none of which was the model being wrong.** Reformatting the journal to one column per line
  fixed 60 of them, which is the tell: whitespace is not semantics, and history is the one
  thing an append-only journal may not rewrite to satisfy a parser.

  The body is now found by scanning to the paren that **matches** the opening one, and split
  on **top-level commas**, with string literals and `--` / `/* */` comments skipped. That one
  change carries the whole family:

  - several columns on one line, and a `CREATE TABLE` written entirely on one line;
  - a `) STRICT;` or `) WITHOUT ROWID;` suffix;
  - a `PRIMARY KEY (` whose column list wraps over lines;
  - a quoted `"order"` identifier;
  - a comma inside a string literal, and a paren inside a `CHECK`.

  **The two that were dangerous rather than annoying.** A `CREATE TABLE` on one line was not
  refused, it was _invisible_ — so `planMigration` read the table as new and emitted a second
  `CREATE TABLE` for a table that already existed. A wrong migration, generated silently. And
  the word UNIQUE inside a comment was read as a real constraint, which is the inverse: the
  planner reporting "up to date" over a guarantee nothing enforces.

  **`journalUniques` reads all three spellings.** It read only table-level `UNIQUE (b)`;
  column-level `b TEXT UNIQUE` and `CREATE UNIQUE INDEX … ON t (b)` are the same constraint
  by a different route, and both appear in real journals. A partial index
  (`… WHERE deleted_at IS NULL`) is deliberately still not read — it constrains a subset of
  the rows, so treating it as a whole-table key would claim what the database does not.

  That one was not only the field report's problem. Cross-checking every journal in this repo
  against a real SQLite found **13 uniqueness rules the planner could not see** — in
  `workorder`, `invoicing`, `shop`, `rally`, `callout`, `meridian` and `handlebar`, all of
  them spelled column-level. All 83 tables now agree with the database on columns, primary
  key and uniqueness, with zero mismatches.

  The reporter's four cases ship as fixtures, alongside the five the same cause turned out to
  have. A successor will replace the parser outright by replaying the journal into an
  in-memory SQLite and reading the schema back through `pragma_table_info` — ten minutes of
  probing found five new spellings, and a regex over SQL text has no bottom.

- 87ec6f2: Every published package now actually ships its license text.

  `LICENSING.md` has always opened by claiming each package "ships the full text in its
  tarball." Eight of them did not: `adapter-cloudflare`, `control-plane-api`,
  `vertical-auth`, `oidc-rp`, `psl`, `boundary-lint`, `model-emit` and `create-substrat`
  declared a license in `package.json` and shipped no `LICENSE` file. npm auto-includes
  `LICENSE*` when present — none was present, so nothing was included.

  That is worth a version bump rather than a docs fix, because a tarball is where the
  claim is either true or false, and `adapter-cloudflare` is the load-bearing case: §5.7
  makes the Cloudflare adapter half of the two-adapter rule that keeps the escrow story
  literally true, and AGPL is what stops a hosted derivative of it from staying closed.
  An AGPL package distributed without its license text is the weakest possible version of
  that. The texts are the stock unmodified AGPL-3.0 and Apache-2.0, byte-identical to the
  copies already in `kernel` and `contracts`.

  No code changes.

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0

## 0.4.1

### Patch Changes

- 7b8ccfc: A foreign key points at the parent's own key, not an assumed `id`.

  `columnsOf` emitted `REFERENCES <table>(id)`. That was correct only while every
  entity was keyed by `id` — which `primaryKey` (#804, shipped in 0.4.0) stopped
  being true. A parent edge to a side table now emits a reference to a column that
  does not exist:

  ```sql
  CREATE TABLE vertical_workorder_ext (
    workorder_id TEXT PRIMARY KEY NOT NULL,   -- no `id` anywhere
    note TEXT
  );
  CREATE TABLE vertical_ext_line (
    id TEXT PRIMARY KEY NOT NULL,
    workorder_ext_id TEXT NOT NULL REFERENCES vertical_workorder_ext(id),   -- wrong
    text TEXT NOT NULL
  );
  ```

  **And nothing catches it until data moves.** SQLite does not validate a foreign
  key target at `CREATE TABLE`, so the DDL parses, the model compiles, and a
  parity check comparing column sets passes. Then every valid child row is
  rejected at INSERT with `foreign key mismatch` — not the dangling ones, all of
  them.

  The reference now names the parent's actual key column. A single column pointed
  at a **composite**-keyed parent is refused at emit — SQL needs a table-level
  `FOREIGN KEY (a, b) REFERENCES t(x, y)` for that, and the model has no notation
  saying which local column maps to which, so inventing one would be guessing.

  Found by running the emitted DDL against a real database rather than asserting
  on the string, which is worth doing here generally: the same run confirmed that
  a composite primary key's `NOT NULL` is load-bearing, because SQLite does not
  imply it — a non-INTEGER `PRIMARY KEY` accepts NULLs, composite included.

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0

## 0.4.0

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

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.76.0

## 0.3.2

### Patch Changes

- @substrat-run/contracts@0.75.0

## 0.3.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0

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

## 0.2.0

### Minor Changes

- f869541: `planMigration` — the migration journal, derived. Nobody writes the version
  number.

  `emitTables` could only ever say "here is the current shape as one CREATE",
  which is right before an app has data and wrong the moment it does: re-emitting
  would rewrite a shipped entry. That made it a parity check rather than a source,
  and it is why a real app with production data could not adopt generation.

  The model states the current shape; the journal states what has been applied.
  `planMigration` reconstructs the second from the journal itself, diffs against
  the first, and appends **exactly one** entry with a derived, position-checked
  counter. Declaring a version declares a fact the diff already knows — and
  hand-numbering has failed in practice: a production journal ships two entries
  numbered 0010 because two people numbered by hand in two branches. Two branches
  generating `0003` now collide in `journal.json`, which is the correct signal on
  an append-only ordered list; resolution is mechanical.

  **It refuses rather than guesses.** A dropped table, a dropped column (a diff
  cannot tell a rename from a drop-plus-add, and guessing wrong loses the data),
  and a required column with no default added to a table that may already hold
  rows — SQLite cannot add one, and pretending otherwise breaks on real data. Each
  refusal names the decision it is deferring to a human.

  Also exports `columnsOf` and `uniqueConstraints`, shared with `emitTables` so a
  column added by `ALTER TABLE` renders exactly as a fresh `CREATE TABLE` would.
  That sharing caught a live defect: building a new table from a one-entity subset
  dropped every `REFERENCES` clause pointing outside it.

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

- 4e174cc: Two sharp edges in the entity vocabulary, both of which failed quietly.

  **`key` is a composite, not several uniques.** `key: ['list_id', 'principal']`
  means "one share per person per list" and now emits `UNIQUE (list_id, principal)`.
  It used to emit one UNIQUE per field — "a list may be shared once, ever" AND "a
  person may receive one share, ever" — two wrong constraints silently replacing
  the composite. Stricter than intended, so it failed closed rather than open, and
  nothing said so. Every declaration in the fleet was single-field, where the two
  readings agree, so nothing could reveal the difference until an app needed a
  composite. Closes #735.

  **`z.boolean()` is refused in a stored field.** It emitted INTEGER, correctly —
  and `EntityRow` then inferred `boolean`, a type SQLite can never return. Now it
  refuses and names the fix, including the asymmetry that makes it subtle:
  `z.boolean()` stays right for an operation's _input_, which crosses JSON. An app
  can take `done: z.boolean()` and store `done: z.number()`, and both are correct.
  Closes #737.

  **And a hole the first change exposed.** Adding a `key` to an entity whose table
  already exists is a schema change the planner could not see — it read columns,
  not constraints — so it reported "up to date" over a missing uniqueness
  guarantee, which is how a duplicate gets in. `journalUniques` reads constraints
  back out of a journal, and `planMigration` refuses a key it cannot apply, because
  SQLite cannot add one without rebuilding the table.

  That reader follows `RENAME COLUMN`, since SQLite rewrites the constraint along
  with the column — verified against a real database. And a key whose column is
  renamed by the _same plan_ is translated before comparison, or the planner would
  refuse the very change that fixes it.

### Patch Changes

- f869541: `emitTables` emits parent tables before child tables.

  Sorting by name alone put `todo_items` — which `REFERENCES todo_lists` — first.
  SQLite tolerates a forward reference; a stricter engine does not, and "it
  happened to work" is not a property to ship. Parents now precede children,
  alphabetical within a tier, so the output stays deterministic and diffable. A
  parent cycle is reported rather than silently truncated.

  Found by emitting a real journal for a vertical whose entities form a chain —
  the existing fixtures' tables happened to sort into a working order.

- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
