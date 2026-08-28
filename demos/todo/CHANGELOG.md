# @substrat-run/demo-todo

## 0.3.9

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/adapter-sqlite@0.92.0
  - @substrat-run/dev-issuer@0.1.6
  - @substrat-run/kernel@0.92.0
  - @substrat-run/vertical-host@0.92.0

## 0.3.8

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/vertical-host@0.91.0
  - @substrat-run/contracts@0.91.0
  - @substrat-run/dev-issuer@0.1.5
  - @substrat-run/adapter-sqlite@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.3.7

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0
  - @substrat-run/adapter-sqlite@0.90.0
  - @substrat-run/dev-issuer@0.1.4
  - @substrat-run/vertical-host@0.90.0

## 0.3.6

### Patch Changes

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

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0
  - @substrat-run/adapter-sqlite@0.89.0
  - @substrat-run/vertical-host@0.89.0
  - @substrat-run/dev-issuer@0.1.3

## 0.3.5

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
  - @substrat-run/adapter-sqlite@0.88.0
  - @substrat-run/vertical-host@0.88.0
  - @substrat-run/dev-issuer@0.1.2

## 0.3.4

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/adapter-sqlite@0.87.0
  - @substrat-run/dev-issuer@0.1.1
  - @substrat-run/kernel@0.87.0
  - @substrat-run/vertical-host@0.87.0

## 0.3.3

### Patch Changes

- Updated dependencies [ae4e894]
  - @substrat-run/dev-issuer@0.1.0
  - @substrat-run/contracts@0.86.0
  - @substrat-run/kernel@0.86.0
  - @substrat-run/adapter-sqlite@0.86.0
  - @substrat-run/vertical-host@0.86.0

## 0.3.2

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0
- @substrat-run/adapter-sqlite@0.85.0
- @substrat-run/vertical-host@0.85.0

## 0.3.1

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-sqlite@0.84.0
  - @substrat-run/vertical-host@0.84.0

## 0.3.0

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

## 0.2.0

### Minor Changes

- bb5f3ac: Todo adopts the two platform surfaces it was behind on: the error taxonomy (#113) and
  declared search (#827).

  **Errors.** Five bare `throw new Error` became `substratError` — four `not_found`, and
  "you were never invited" as `precondition_failed`. All seven engines had adopted the
  taxonomy; no demo had, so every vertical was still classified by `classifyError`'s
  message-pattern fallback, the tier its own comment calls a guess. The statuses were
  already drifting: `'no account here …'` matched no pattern and fell through to 400, while
  `'nobody here with that address'` matched todo's own regex and answered 404 — two
  near-identical preconditions separated by prose. `routes.ts` no longer matches on this
  vertical's error text at all; what is left is the two pieces of _platform_ vocabulary the
  mount still has no opinion on.

  **Search.** One declaration in the manifest:

  ```ts
  ...manifestEntities(todoEntities, {
    searchables: [{ entityType: 'item', fields: ['text'] }],
  }),
  ```

  `item` only, and only `text`. `list.name` would index a handful of rows already on screen,
  and `owner`/`share` carry the app's only `erasable` fields — an index over an address is a
  second copy of it.

  Two reads, because todo has two questions. `GET /lists/{listId}/items/search` is the read
  `paged` took away: filtering `list-items` in the browser searched whatever page had loaded.
  `GET /items/search` is "where did I put milk?", and declares `narrows` for the same reason
  `my-lists` does — nobody holds `list:contribute` scope-wide, so reachability is only ever a
  question about the list an item sits on, asked once per distinct list rather than once per
  hit.

  Both over-fetch on purpose. `ctx.search` checks nothing and the index is scope-wide, so
  every hit is filtered _after_ ranking, and a ranked top-N filtered afterwards returns fewer
  than N. `TODO_SEARCH_MAX` is derived as `MAX_SEARCH_LIMIT / SEARCH_OVERFETCH` so the
  widened ask always stays inside the kernel's ceiling — declaring the ceiling itself as the
  bound leaves the over-fetch no headroom at exactly the limit where it matters most.

  **Also:** todo now serves its own `/openapi.json`. `api.ts` claimed it did and nothing
  did — the document existed only as the checked-in review artifact, with `tools/api-diff.mts`
  as its sole consumer. No `/api/docs` page: rendering one means bundling Scalar, and the
  smallest vertical that is still a real one does not need a second dependency to prove its
  document is reachable.

  The search index is provisioned by the kernel, appended to this module's migrations rather
  than journaled here — so `emit:migrations --check` stays green and the DDL
  (`search/item:prefix:text`) does not appear in this diff. It is idempotent and back-fills.

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/vertical-host@0.82.0
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.1.10

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/vertical-host@0.81.0

## 0.1.9

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/vertical-host@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.1.8

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/vertical-host@0.79.0
  - @substrat-run/adapter-sqlite@0.79.0

## 0.1.7

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/kernel@0.78.0
  - @substrat-run/vertical-host@0.78.0

## 0.1.6

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/kernel@0.77.0
  - @substrat-run/vertical-host@0.77.0

## 0.1.5

### Patch Changes

- Updated dependencies [e3c3e2b]
  - @substrat-run/vertical-host@0.76.0
  - @substrat-run/contracts@0.76.0
  - @substrat-run/kernel@0.76.0
  - @substrat-run/adapter-sqlite@0.76.0

## 0.1.4

### Patch Changes

- Updated dependencies [89c2113]
- Updated dependencies [20818ce]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/vertical-host@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.1.3

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/vertical-host@0.74.0
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.1.2

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0
  - @substrat-run/vertical-host@0.73.0

## 0.1.1

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
  - @substrat-run/vertical-host@0.72.0
