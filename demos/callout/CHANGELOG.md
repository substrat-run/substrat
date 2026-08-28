# @substrat-run/demo-fsm

## 0.3.9

### Patch Changes

- Updated dependencies [7843c4f]
- Updated dependencies [d9793bc]
- Updated dependencies [7ad9ec8]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/adapter-cloudflare@0.92.0
  - @substrat-run/engine-workorder@0.10.0
  - @substrat-run/engine-invoicing@0.9.8
  - @substrat-run/engine-protocol@0.11.9
  - @substrat-run/adapter-sqlite@0.92.0
  - @substrat-run/control-plane-api@0.92.0
  - @substrat-run/dev-issuer@0.1.6
  - @substrat-run/kernel@0.92.0

## 0.3.8

### Patch Changes

- 75bd27c: The owner seat is claimed by whoever signs in first — for fifteen minutes, and then by a claim link (#925)

  A hosted vertical's owner seat is minted empty at provision and bound to a human by the first
  verified subject to arrive. That is the right trade in the install flow, where the installer
  opens the app seconds later. It was the wrong trade everywhere else: the window was unbounded
  in time and in audience, so a CI-deployed instance whose issuer had open sign-up sat as a seat
  anyone could take, indefinitely — and nothing anywhere said it was open. A re-provision made
  it worse: `INSERT OR REPLACE` re-minted the pending seat on every reconcile, so a sweep could
  hand a claimed desk's ownership to the next stranger to sign in.

  **`@substrat-run/vertical-auth`** — the rules now live in `owner-seat.ts`, unit-tested over a
  real SQLite. The first-sign-in claim closes `FIRST_SIGN_IN_WINDOW_MS` (15 min) after provision;
  a seat from before the column existed reads as closed. The seat then stays pending — `needsSetup`
  keeps saying so, and the new `ownerSeat` says _why_ — until a claim binds it. `mintOwnerClaim` /
  `claimOwner` are the claim link (only the token's hash is stored; minting again retires the
  earlier link), and `mintOwnerClaimLink` does token + hash + URL in one call. A re-provision
  keeps the window it has and never re-opens a claimed seat.

  **`@substrat-run/vertical-host`** — two flavored routes, `GET /internal/owner-seat` and
  `POST /internal/owner-claim`, over the `ownerSeat` / `mintOwnerClaim` hooks (501 without them),
  parsed on the way out as well as in. **`@substrat-run/contracts`** — the `ownerSeat` and
  `ownerClaimLink` shapes. **`@substrat-run/control-plane-api`** — `GET …/owner-seat` and
  `POST …/owner-claim` per scope, with the link's origin taken from the platform's own hostname
  directory (canonical `app` first), never from a body.

  **Dashboard** — an _Owner seat_ card on the app's Overview: claimed, unclaimed with the window
  still open (pulsing — open it now), or unclaimed and closed, with a _Get claim link_ button.
  The link is shown once and stored nowhere.

  **The four verticals on vertical-auth** (callout, meridian, manyfold, ticket0) — `/api/me`'s
  `needs-setup` answer now carries `firstSignInOpen`, the SPAs say which way in applies instead
  of offering a sign-in that binds nobody, and `?claim=<token>` → `POST /api/claim-owner` is the
  counterpart of the invite flow.

  Not built: binding from the projected identity links (#406). The dashboard links identities
  under the platform's own pool, and a hosted app's issuer is always an external one or a team
  Auth Server — so no link would ever match, and matching on `sub` alone would be the cross-pool
  bind the issue warns against.

- Updated dependencies [75bd27c]
  - @substrat-run/vertical-auth@0.9.0
  - @substrat-run/control-plane-api@0.91.0
  - @substrat-run/contracts@0.91.0
  - @substrat-run/dev-issuer@0.1.5
  - @substrat-run/engine-invoicing@0.9.7
  - @substrat-run/engine-protocol@0.11.7
  - @substrat-run/engine-workorder@0.9.2
  - @substrat-run/adapter-cloudflare@0.91.0
  - @substrat-run/adapter-sqlite@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.3.7

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0
  - @substrat-run/adapter-sqlite@0.90.0
  - @substrat-run/adapter-cloudflare@0.90.0
  - @substrat-run/engine-invoicing@0.9.6
  - @substrat-run/engine-protocol@0.11.6
  - @substrat-run/engine-workorder@0.9.1
  - @substrat-run/control-plane-api@0.90.0
  - @substrat-run/dev-issuer@0.1.4

## 0.3.6

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

- 4f612fc: A retried write is free — `Idempotency-Key`, the recorded response, and the 409

  A client whose request times out does not know whether the work happened. It retries, and
  there is a second work order. Agents make this acute rather than novel: they retry more
  aggressively than people, and faster. A client now sends a token it chose, and the same
  token on the retry returns the first response instead of doing the work again:

  ```http
  POST /api/workorders
  Idempotency-Key: dispatch-4471
  ```

  ```http
  200 OK
  Idempotency-Replayed: true
  ```

  **Nothing is declared, which is the difference from #129.** Every operation on an unsafe
  method honours the header, because a retried write creating a second entity is a hazard on
  all of them — where a lost update is a hazard on the field-bag shape alone, which is why
  `concurrency` is opt-in and this is not. The client opts in by sending a key; the server
  never requires one. Callout's end-to-end test proves exactly that: a vertical that changed
  nothing gets it.

  The seam is the one #129 asked for rather than a second interception point beside it.
  `InvokeOptions` already said so — _"`If-Match` and `Idempotency-Key` are ONE precondition
  pass at one point in the invoke"_ — so this declared into that bag, and the mount reads two
  headers where it read one.

  **The recording is written inside the operation's own transaction**, and three properties
  fall out of that placement rather than from mechanisms of their own:

  - **A failed request is retried, not replayed.** The operation threw, the transaction rolled
    back, and the recording went with it. Nothing to find, so the retry executes — correctly,
    because nothing happened the first time. Recording failures would have meant deciding
    which of them are permanent, and a retry after a 500 is the most ordinary thing a client
    does.
  - **A replayed response describes work that committed.** There is no window in which the
    recording exists and the rows it describes do not.
  - **A concurrent retry cannot slip past.** Invocations serialise per scope in both adapters,
    so the duplicate takes its turn after the first has committed. Every other implementation
    of this needs an in-flight state and a "still processing" 409; this one does not, and that
    is a property of the host rather than something to rely on quietly.

  Four things this had to get right:

  - **A key belongs to the subject that sent it.** Two clients will both choose `1`. The row
    is keyed `(subject, key)`, so a cross-principal replay is not a check someone could
    forget — it is a row that cannot be reached.

  - **A key names one request.** The fingerprint is SHA-256 over the operation and its
    **parsed** input — parsed, so a retry omitting an optional field the original sent at its
    default value is still the same request. Same key, different request is `conflict` (409),
    never the earlier response: a client handed an answer to a question it did not ask will
    act on it.

  - **Unrecordable fails closed.** A result over 128 KiB records the key with no body, and a
    replay of it is refused rather than executed again. The original did complete, so
    re-running is the one answer that is certainly wrong.

  - **An unacknowledged key is refused.** Same shape as #129's skew check and a sharper
    failure: an old ScopeDO that drops `ifMatch` skips a comparison, while one that drops the
    key **runs the operation** and returns 200. The DO acknowledges, and a coordinator that
    sent a key and sees no acknowledgement refuses the success.

  **Opting out is a line someone wrote.** An operation whose response must not be recorded —
  a freshly minted secret, a one-time token — declares `idempotency: false`, and the host then
  refuses the header rather than silently storing the response or silently executing twice.
  Opt-out rather than opt-in because the two read differently in a diff: a missing opt-in is
  invisible, while `idempotency: false` is something a reviewer can ask about.

  Retention is **24 hours**, pruned opportunistically inside the transaction that adds a row —
  no sweeper, no second schedule, and a fleet that never sends a key never pays for it. The
  window is not only a storage bound: a recorded response is a second copy of what the
  operation returned, sitting outside the erasure path that reaches the outbox. A copy that
  expires in a day is defensible; one that never expires is a second database of personal data
  with no owner.

  No new error vocabulary. `conflict` has been in the closed taxonomy since #113, and both
  refusals narrow it with a `reason` slug (`idempotency_key_reused`,
  `idempotency_replay_unavailable`) rather than inventing a code.

  Two things worth knowing about the emitted document. The header is documented on every
  unsafe operation rather than per declaration — that IS the surface, and a client made to
  work out which writes are retryable will assume none of them are. And it appears only where
  `mountOperations` serves the route: Meridian's and Manyfold's `openapi.json` are unchanged
  because they hand-write their `/api/op/*` route and pass no options to `invoke`, so
  documenting the header there would advertise a behaviour those servers do not implement.

  A replay is **not** a fresh authorization — the recorded response is returned without
  running the handler, and the permission check lives inside the handler. What bounds it is
  that a caller only ever reaches responses it received itself, and that the window is a day.
  Stated in `kernel/src/idempotency.ts` rather than discovered, because the alternative —
  re-running the operation so the permission can be re-checked — is the duplicate execution
  this exists to prevent.

  Verified: an 11-case contract suite on both adapters, including across the real ScopeDO hop,
  mutation-checked; 4 mount tests; 3 end-to-end HTTP tests against Callout's real route table
  proving a retried `POST` opens one work order. Full suite, typecheck, boundary-lint and all
  15 generated-file gates green. No migration diff; no permission surface change.

- Updated dependencies [73710de]
- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/engine-workorder@0.9.0
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0
  - @substrat-run/adapter-sqlite@0.89.0
  - @substrat-run/adapter-cloudflare@0.89.0
  - @substrat-run/control-plane-api@0.89.0
  - @substrat-run/engine-invoicing@0.9.5
  - @substrat-run/engine-protocol@0.11.5
  - @substrat-run/dev-issuer@0.1.3

## 0.3.5

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

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [7cce6cd]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0
  - @substrat-run/adapter-sqlite@0.88.0
  - @substrat-run/adapter-cloudflare@0.88.0
  - @substrat-run/control-plane-api@0.88.0
  - @substrat-run/engine-protocol@0.11.4
  - @substrat-run/vertical-auth@0.8.1
  - @substrat-run/engine-invoicing@0.9.4
  - @substrat-run/engine-workorder@0.8.4
  - @substrat-run/dev-issuer@0.1.2

## 0.3.4

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/engine-invoicing@0.9.3
  - @substrat-run/engine-protocol@0.11.3
  - @substrat-run/engine-workorder@0.8.3
  - @substrat-run/adapter-cloudflare@0.87.0
  - @substrat-run/adapter-sqlite@0.87.0
  - @substrat-run/control-plane-api@0.87.0
  - @substrat-run/dev-issuer@0.1.1
  - @substrat-run/kernel@0.87.0

## 0.3.3

### Patch Changes

- Updated dependencies [ae4e894]
- Updated dependencies [ae4e894]
- Updated dependencies [257e033]
  - @substrat-run/dev-issuer@0.1.0
  - @substrat-run/vertical-auth@0.8.0
  - @substrat-run/control-plane-api@0.86.0
  - @substrat-run/contracts@0.86.0
  - @substrat-run/kernel@0.86.0
  - @substrat-run/adapter-sqlite@0.86.0
  - @substrat-run/adapter-cloudflare@0.86.0
  - @substrat-run/engine-invoicing@0.9.2
  - @substrat-run/engine-protocol@0.11.2
  - @substrat-run/engine-workorder@0.8.2

## 0.3.2

### Patch Changes

- Updated dependencies [812c323]
  - @substrat-run/control-plane-api@0.85.0
  - @substrat-run/contracts@0.85.0
  - @substrat-run/kernel@0.85.0
  - @substrat-run/adapter-sqlite@0.85.0
  - @substrat-run/adapter-cloudflare@0.85.0
  - @substrat-run/engine-invoicing@0.9.1
  - @substrat-run/engine-protocol@0.11.1
  - @substrat-run/engine-workorder@0.8.1

## 0.3.1

### Patch Changes

- dc2c726: A dev server that cannot work refuses to boot, and says what it needs.

  `.dev.vars` is this repo's per-project local-env convention — gitignored, written by
  `scripts/secrets.mjs dev`, and named as such in `secrets/README.md`. **`wrangler dev` loads
  it and `tsx src/server.ts` did not.** The same file, in the same directory, read by one
  entry point and silently ignored by the other, with no signal either way: `cf:dev` picked up
  your values and `pnpm dev` started without them.

  Callout's `server` script now loads it (`node --env-file-if-exists=.dev.vars`), and a new
  `preserver` hook checks what that leaves unresolved before the process starts.

  **Why a boot failure rather than a prompt.** There is no terminal to prompt at. Claude
  Desktop starts these servers from `.claude/launch.json` (`pnpm run server`) with no TTY, so
  a `readline` question hangs forever and a warning scrolls past. What an agent _can_ read is
  a server that died and said why — which is already how this surface signals: `autoPort:
false` is set so a stale port "does not get quietly reassigned, it fails the boot. For an
  agent, mid-session" (`tools/launch-emit.mts`). Same mechanism, one more failure mode. The
  report names each missing key with its declared label, description and placeholder, and the
  exact file to write. Values are never read into the tool or printed — only key names.

  **Two declarations, because they answer different questions.** `envSpec[].required` means
  required to **deploy**, and is rarely true: a hosted install receives config through
  per-scope delivery, so the manifest can honestly call most keys optional. The new
  `devServers[].requires` means required to **run this process locally** — the gap the first
  cannot express. Locally there is no delivery channel, so `OIDC_ISSUER` absent means broken;
  and the harness secrets that actually bite (`PLATFORM_SECRET`, `ROUTER_SECRET`) are
  deliberately undeclared in `envSpec` at all. A key named in both gets the spec's prose in
  the failure message; a key named only in `requires` is reported bare.

  `requires` is deliberately **not** emitted into `launch.json`. A launch file starts a
  server; what a server needs in order to start is the `preserver` hook's business, and
  duplicating it into a client-specific adapter would make it substance an adapter may not
  hold (agent-surface §3).

  Callout's `dev` script now calls `pnpm run server` instead of inlining `tsx src/server.ts`,
  so the check fires on the human path too — and the command stops being a second copy of the
  server invocation. Root `pnpm dev` and `pnpm dev:connected` both funnel through it.

  Precedence mirrors the runtime exactly: Node's `--env-file` does not override an already-set
  variable, so a shell value wins over `.dev.vars`, which wins over the spec's `default`. The
  docs gotcha that used to send you to Desktop's local environment editor now points at
  `.dev.vars` instead — Desktop does not inherit your shell, which makes the file the only
  route that works in both places.

  Callout is wired as the reference; the other demos, the scaffolder template (which needs the
  preflight published as a bin), and a generated `.dev.vars.example` are follow-ups.

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [7548dde]
- Updated dependencies [7c58211]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/engine-workorder@0.8.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-sqlite@0.84.0
  - @substrat-run/adapter-cloudflare@0.84.0
  - @substrat-run/engine-invoicing@0.9.0
  - @substrat-run/engine-protocol@0.11.0
  - @substrat-run/control-plane-api@0.84.0

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

- Updated dependencies [15df906]
- Updated dependencies [ca3377d]
  - @substrat-run/control-plane-api@0.83.0
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-sqlite@0.83.0
  - @substrat-run/adapter-cloudflare@0.83.0
  - @substrat-run/engine-invoicing@0.8.3
  - @substrat-run/engine-protocol@0.10.3
  - @substrat-run/engine-workorder@0.7.3

## 0.2.37

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
- Updated dependencies [75925a2]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/control-plane-api@0.82.0
  - @substrat-run/adapter-cloudflare@0.82.0
  - @substrat-run/engine-invoicing@0.8.2
  - @substrat-run/engine-protocol@0.10.2
  - @substrat-run/engine-workorder@0.7.2
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.2.36

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/adapter-cloudflare@0.81.0
  - @substrat-run/engine-invoicing@0.8.1
  - @substrat-run/engine-protocol@0.10.1
  - @substrat-run/engine-workorder@0.7.1
  - @substrat-run/control-plane-api@0.81.0

## 0.2.35

### Patch Changes

- Updated dependencies [4dc28f4]
- Updated dependencies [f6174fb]
- Updated dependencies [83b0ca3]
  - @substrat-run/control-plane-api@0.80.0
  - @substrat-run/engine-invoicing@0.8.0
  - @substrat-run/engine-protocol@0.10.0
  - @substrat-run/engine-workorder@0.7.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/adapter-cloudflare@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.2.34

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
- Updated dependencies [87ec6f2]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/adapter-cloudflare@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/control-plane-api@0.79.0
  - @substrat-run/vertical-auth@0.7.1
  - @substrat-run/engine-invoicing@0.7.6
  - @substrat-run/engine-protocol@0.9.6
  - @substrat-run/engine-workorder@0.6.6
  - @substrat-run/adapter-sqlite@0.79.0

## 0.2.33

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/engine-invoicing@0.7.5
  - @substrat-run/engine-protocol@0.9.5
  - @substrat-run/engine-workorder@0.6.5
  - @substrat-run/adapter-cloudflare@0.78.0
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/control-plane-api@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.2.32

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/engine-invoicing@0.7.4
  - @substrat-run/engine-protocol@0.9.4
  - @substrat-run/engine-workorder@0.6.4
  - @substrat-run/adapter-cloudflare@0.77.0
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/control-plane-api@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.2.31

### Patch Changes

- @substrat-run/control-plane-api@0.76.0
- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-sqlite@0.76.0
- @substrat-run/adapter-cloudflare@0.76.0
- @substrat-run/engine-invoicing@0.7.3
- @substrat-run/engine-protocol@0.9.3
- @substrat-run/engine-workorder@0.6.3

## 0.2.30

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/adapter-cloudflare@0.75.0
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/engine-protocol@0.9.2
  - @substrat-run/engine-workorder@0.6.2
  - @substrat-run/control-plane-api@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.2.29

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/engine-protocol@0.9.1
  - @substrat-run/engine-workorder@0.6.1
  - @substrat-run/adapter-cloudflare@0.74.0
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/control-plane-api@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.2.28

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-protocol@0.9.0
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-workorder@0.6.0
  - @substrat-run/adapter-cloudflare@0.73.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/control-plane-api@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.2.27

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
  - @substrat-run/adapter-cloudflare@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/engine-workorder@0.5.0
  - @substrat-run/engine-protocol@0.8.0
  - @substrat-run/control-plane-api@0.72.0
  - @substrat-run/engine-invoicing@0.6.3

## 0.2.26

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/engine-protocol@0.7.3
  - @substrat-run/engine-workorder@0.4.3
  - @substrat-run/adapter-cloudflare@0.71.0
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/control-plane-api@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.2.25

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/engine-protocol@0.7.2
  - @substrat-run/engine-workorder@0.4.2
  - @substrat-run/adapter-cloudflare@0.70.0
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/control-plane-api@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.2.24

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/engine-protocol@0.7.1
  - @substrat-run/engine-workorder@0.4.1
  - @substrat-run/adapter-cloudflare@0.69.0
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/control-plane-api@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.2.23

### Patch Changes

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
  - @substrat-run/adapter-cloudflare@0.68.0
  - @substrat-run/control-plane-api@0.68.0
  - @substrat-run/engine-invoicing@0.5.24

## 0.2.22

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
  - @substrat-run/adapter-cloudflare@0.67.0
  - @substrat-run/adapter-sqlite@0.67.0
  - @substrat-run/control-plane-api@0.67.0

## 0.2.21

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/engine-protocol@0.6.2
  - @substrat-run/engine-workorder@0.3.64
  - @substrat-run/control-plane-api@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.2.20

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/engine-protocol@0.6.1
  - @substrat-run/engine-workorder@0.3.63
  - @substrat-run/adapter-cloudflare@0.65.0
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/control-plane-api@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.2.19

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [6ac51d1]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0
  - @substrat-run/control-plane-api@0.64.0
  - @substrat-run/vertical-auth@0.7.0
  - @substrat-run/engine-protocol@0.6.0
  - @substrat-run/engine-invoicing@0.5.20
  - @substrat-run/engine-workorder@0.3.62

## 0.2.18

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/control-plane-api@0.63.0
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/engine-protocol@0.5.21
  - @substrat-run/engine-workorder@0.3.61
  - @substrat-run/contracts@0.63.0

## 0.2.17

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/control-plane-api@0.62.0
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/engine-protocol@0.5.20
  - @substrat-run/engine-workorder@0.3.60
  - @substrat-run/adapter-cloudflare@0.62.0
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.2.16

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/control-plane-api@0.61.0
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/engine-protocol@0.5.19
  - @substrat-run/engine-workorder@0.3.59
  - @substrat-run/adapter-cloudflare@0.61.0
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.2.15

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/control-plane-api@0.60.0
  - @substrat-run/adapter-cloudflare@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/engine-protocol@0.5.18
  - @substrat-run/engine-workorder@0.3.58
  - @substrat-run/kernel@0.60.0

## 0.2.14

### Patch Changes

- Updated dependencies [1fab6f7]
- Updated dependencies [eda5d01]
  - @substrat-run/control-plane-api@0.59.0
  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0
  - @substrat-run/adapter-sqlite@0.59.0
  - @substrat-run/adapter-cloudflare@0.59.0
  - @substrat-run/engine-invoicing@0.5.15
  - @substrat-run/engine-protocol@0.5.17
  - @substrat-run/engine-workorder@0.3.57

## 0.2.13

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0
  - @substrat-run/control-plane-api@0.58.0
  - @substrat-run/engine-invoicing@0.5.14
  - @substrat-run/engine-protocol@0.5.16
  - @substrat-run/engine-workorder@0.3.56

## 0.2.12

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/engine-protocol@0.5.15
  - @substrat-run/engine-workorder@0.3.55
  - @substrat-run/adapter-cloudflare@0.57.0
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/control-plane-api@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.2.11

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [b8bdb9d]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/control-plane-api@0.56.0
  - @substrat-run/engine-invoicing@0.5.12
  - @substrat-run/engine-protocol@0.5.14
  - @substrat-run/engine-workorder@0.3.54

## 0.2.10

### Patch Changes

- Updated dependencies [8cd5039]
- Updated dependencies [512822b]
  - @substrat-run/control-plane-api@0.55.0
  - @substrat-run/contracts@0.55.0
  - @substrat-run/kernel@0.55.0
  - @substrat-run/adapter-sqlite@0.55.0
  - @substrat-run/adapter-cloudflare@0.55.0
  - @substrat-run/engine-invoicing@0.5.11
  - @substrat-run/engine-protocol@0.5.13
  - @substrat-run/engine-workorder@0.3.53

## 0.2.9

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0
  - @substrat-run/control-plane-api@0.54.0
  - @substrat-run/engine-invoicing@0.5.10
  - @substrat-run/engine-protocol@0.5.12
  - @substrat-run/engine-workorder@0.3.52

## 0.2.8

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/control-plane-api@0.53.0
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/engine-protocol@0.5.11
  - @substrat-run/engine-invoicing@0.5.9
  - @substrat-run/engine-workorder@0.3.51

## 0.2.7

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/engine-protocol@0.5.10
  - @substrat-run/engine-workorder@0.3.50
  - @substrat-run/adapter-cloudflare@0.52.0
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/control-plane-api@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.2.6

### Patch Changes

- Updated dependencies [9f28da1]
  - @substrat-run/control-plane-api@0.51.0
  - @substrat-run/contracts@0.51.0
  - @substrat-run/kernel@0.51.0
  - @substrat-run/adapter-sqlite@0.51.0
  - @substrat-run/adapter-cloudflare@0.51.0
  - @substrat-run/engine-invoicing@0.5.7
  - @substrat-run/engine-protocol@0.5.9
  - @substrat-run/engine-workorder@0.3.49

## 0.2.5

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/control-plane-api@0.50.0
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/engine-protocol@0.5.8
  - @substrat-run/engine-invoicing@0.5.6
  - @substrat-run/engine-workorder@0.3.48

## 0.2.4

### Patch Changes

- Updated dependencies [5ad59c5]
- Updated dependencies [a13c8fb]
- Updated dependencies [00ff102]
- Updated dependencies [f11a961]
- Updated dependencies [9c7987b]
  - @substrat-run/control-plane-api@0.49.0
  - @substrat-run/contracts@0.49.0
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/engine-protocol@0.5.7
  - @substrat-run/engine-workorder@0.3.47
  - @substrat-run/adapter-cloudflare@0.49.0
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.2.3

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0
  - @substrat-run/control-plane-api@0.48.0
  - @substrat-run/engine-invoicing@0.5.4
  - @substrat-run/engine-protocol@0.5.6
  - @substrat-run/engine-workorder@0.3.46

## 0.2.2

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/control-plane-api@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/engine-invoicing@0.5.3
  - @substrat-run/engine-protocol@0.5.5
  - @substrat-run/engine-workorder@0.3.45

## 0.2.1

### Patch Changes

- Updated dependencies [b94f735]
  - @substrat-run/control-plane-api@0.46.0
  - @substrat-run/contracts@0.46.0
  - @substrat-run/kernel@0.46.0
  - @substrat-run/adapter-sqlite@0.46.0
  - @substrat-run/adapter-cloudflare@0.46.0
  - @substrat-run/engine-invoicing@0.5.2
  - @substrat-run/engine-protocol@0.5.4
  - @substrat-run/engine-workorder@0.3.44

## 0.2.0

### Minor Changes

- e3f86b0: Demos are OIDC-only: remove the built-in credential store from the verticals

  Meridian, Manyfold, and Callout no longer run their own Better Auth credential
  store. They are pure OIDC relying parties — login, sign-up, password, and reset
  all live at the OIDC issuer (`demos/auth-server`). The vertical only maps the
  authenticated `sub` → a scope principal, and that binding (first-run owner-claim

  - invites in the per-tenant `IdentityDO`) is kept: it is provider-agnostic authZ,
    not credentials.

  * **meridian** — `oidcRpAuthProvider` is the sole provider; the builtin branch,
    `/api/auth-mode` split, first-run sign-up gate, dev Better-Auth store, and the
    email/password SPA are removed. Dev authenticates with the `x-principal` persona
    picker.
  * **manyfold** — gains `oidcRpAuthProvider` (it had only the bearer verifier),
    async `authProviderFor` reading the delivered `substrat:auth`; builtin removed;
    the site registry is preserved; dev on a default persona.
  * **callout** — converged onto the sandbox-clean `IdentityDO` shape: dropped the
    shared `AUTH_DB` D1 binding and Better Auth, adopted the `IdentityDO` +
    `oidcRpAuthProvider`, and replaced the TOFU auto-mint with owner-claim + invites.

  `packages/vertical-auth` is unchanged, so the production verticals that depend on
  it are unaffected. Better Auth now lives only in `demos/auth-server` (the issuer)
  and the Node-only demos (shop/rally/handlebar). Design: `docs/architecture/oidc-only-demos.md`.

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0
  - @substrat-run/control-plane-api@0.45.0
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/engine-protocol@0.5.3
  - @substrat-run/engine-workorder@0.3.43
  - @substrat-run/kernel@0.45.0

## 0.1.32

### Patch Changes

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/control-plane-api@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/engine-protocol@0.5.2
  - @substrat-run/engine-workorder@0.3.42
  - @substrat-run/contracts@0.44.0

## 0.1.31

### Patch Changes

- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/contracts@0.43.0
  - @substrat-run/kernel@0.43.0
  - @substrat-run/adapter-sqlite@0.43.0
  - @substrat-run/control-plane-api@0.43.0
  - @substrat-run/engine-invoicing@0.4.3
  - @substrat-run/engine-protocol@0.5.1
  - @substrat-run/engine-workorder@0.3.41

## 0.1.30

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/engine-protocol@0.5.0
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/engine-workorder@0.3.40
  - @substrat-run/control-plane-api@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.1.29

### Patch Changes

- Updated dependencies [653a592]
- Updated dependencies [e9c7bd0]
- Updated dependencies [e3cd3cd]
- Updated dependencies [1f51134]
- Updated dependencies [d222905]
  - @substrat-run/control-plane-api@0.41.0
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/engine-protocol@0.4.33
  - @substrat-run/engine-invoicing@0.4.1
  - @substrat-run/engine-workorder@0.3.39

## 0.1.28

### Patch Changes

- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0
  - @substrat-run/control-plane-api@0.40.0
  - @substrat-run/engine-protocol@0.4.32
  - @substrat-run/engine-workorder@0.3.38

## 0.1.27

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0
  - @substrat-run/control-plane-api@0.39.0
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/engine-protocol@0.4.31
  - @substrat-run/engine-workorder@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.1.26

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0
  - @substrat-run/control-plane-api@0.38.0
  - @substrat-run/engine-invoicing@0.3.36
  - @substrat-run/engine-protocol@0.4.30
  - @substrat-run/engine-workorder@0.3.36

## 0.1.25

### Patch Changes

- Updated dependencies [705b806]
- Updated dependencies [8869413]
  - @substrat-run/control-plane-api@0.37.0
  - @substrat-run/contracts@0.37.0
  - @substrat-run/kernel@0.37.0
  - @substrat-run/adapter-sqlite@0.37.0
  - @substrat-run/adapter-cloudflare@0.37.0
  - @substrat-run/engine-invoicing@0.3.35
  - @substrat-run/engine-protocol@0.4.29
  - @substrat-run/engine-workorder@0.3.35

## 0.1.24

### Patch Changes

- Updated dependencies [20343bb]
- Updated dependencies [c8c0624]
  - @substrat-run/control-plane-api@0.36.0
  - @substrat-run/contracts@0.36.0
  - @substrat-run/kernel@0.36.0
  - @substrat-run/adapter-sqlite@0.36.0
  - @substrat-run/adapter-cloudflare@0.36.0
  - @substrat-run/engine-invoicing@0.3.34
  - @substrat-run/engine-protocol@0.4.28
  - @substrat-run/engine-workorder@0.3.34

## 0.1.23

### Patch Changes

- Updated dependencies [c200778]
- Updated dependencies [17eec41]
  - @substrat-run/control-plane-api@0.35.0
  - @substrat-run/contracts@0.35.0
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/engine-protocol@0.4.27
  - @substrat-run/engine-workorder@0.3.33
  - @substrat-run/adapter-cloudflare@0.35.0
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.1.22

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0
  - @substrat-run/control-plane-api@0.34.0
  - @substrat-run/engine-invoicing@0.3.32
  - @substrat-run/engine-protocol@0.4.26
  - @substrat-run/engine-workorder@0.3.32

## 0.1.21

### Patch Changes

- Updated dependencies [0b9220e]
- Updated dependencies [6d3429e]
  - @substrat-run/control-plane-api@0.33.0
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0
  - @substrat-run/engine-invoicing@0.3.31
  - @substrat-run/engine-protocol@0.4.25
  - @substrat-run/engine-workorder@0.3.31

## 0.1.20

### Patch Changes

- Updated dependencies [c0b3464]
- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/control-plane-api@0.32.0
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0
  - @substrat-run/engine-invoicing@0.3.30
  - @substrat-run/engine-protocol@0.4.24
  - @substrat-run/engine-workorder@0.3.30

## 0.1.19

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [0d79662]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/control-plane-api@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0
  - @substrat-run/engine-invoicing@0.3.29
  - @substrat-run/engine-protocol@0.4.23
  - @substrat-run/engine-workorder@0.3.29

## 0.1.18

### Patch Changes

- Updated dependencies [49db0a1]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [866c46d]
- Updated dependencies [91a60e2]
  - @substrat-run/control-plane-api@0.30.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0
  - @substrat-run/engine-invoicing@0.3.28
  - @substrat-run/engine-protocol@0.4.22
  - @substrat-run/engine-workorder@0.3.28

## 0.1.17

### Patch Changes

- Updated dependencies [a650d52]
- Updated dependencies [c64bdf8]
  - @substrat-run/control-plane-api@0.29.0
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0
  - @substrat-run/adapter-sqlite@0.29.0
  - @substrat-run/engine-invoicing@0.3.27
  - @substrat-run/engine-protocol@0.4.21
  - @substrat-run/engine-workorder@0.3.27

## 0.1.16

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/control-plane-api@0.28.0
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0
  - @substrat-run/adapter-sqlite@0.28.0
  - @substrat-run/engine-invoicing@0.3.26
  - @substrat-run/engine-protocol@0.4.20
  - @substrat-run/engine-workorder@0.3.26

## 0.1.15

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0
  - @substrat-run/control-plane-api@0.27.0
  - @substrat-run/engine-invoicing@0.3.25
  - @substrat-run/engine-protocol@0.4.19
  - @substrat-run/engine-workorder@0.3.25

## 0.1.14

### Patch Changes

- Updated dependencies [2bdd22b]
- Updated dependencies [03839ec]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/control-plane-api@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/engine-invoicing@0.3.24
  - @substrat-run/engine-protocol@0.4.18
  - @substrat-run/engine-workorder@0.3.24

## 0.1.13

### Patch Changes

- Updated dependencies [487db9a]
- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/control-plane-api@0.25.0
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0
  - @substrat-run/engine-invoicing@0.3.23
  - @substrat-run/engine-protocol@0.4.17
  - @substrat-run/engine-workorder@0.3.23

## 0.1.12

### Patch Changes

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
- 92d1aa1: The platform delivers a tenant's entitlements WITH provisioning, so a dispatched vertical
  projects them (#310) — completing the seam #304 left open.

  #304 projected entitlements into a scope but left the platform→dispatched-vertical path un-wired:
  a freshly provisioned CP-less scope received no entitlements, so its `entitlements_enforced` marker
  stayed off and the gate trusted upstream (only expiry, carried on the row, enforced locally).

  - **`ProvisionInstanceInput` gains `entitlements`**, delivered on the provision payload.
  - **The control-plane gathers them itself** at the single provision choke point
    (`POST /verticals/:slug/instances`) via `admin.listEntitlements` — platform-authoritative, never
    trusting the caller's body. Console and dashboard both route through that endpoint, so one
    injection covers every production path.
  - **The demo verticals (callout, meridian, manyfold)** parse `entitlements` (reusing the
    `entitlementGrant` contract) and hand them to `provisionScopeLocal`, which projects them and flips
    enforcement on.

  Propagation of a later grant/revoke to an already-live dispatched worker **rides a re-provision**
  (the idempotent K-31 call, the same channel role-definition changes use) rather than a new
  push-on-grant fan-out; expiry keeps enforcing locally meanwhile. A dedicated push channel stays
  available if a future SLA needs sub-re-provision revocation latency. Decision D-42.

- f610140: Each demo vertical's declarative surface now lives in its own crisp files instead of being
  embedded at the top of `module.ts`. Open `src/manifest.ts` and you see the _entire_ shape of
  the vertical — permission keys, id/version, events, entity relations, entitlement — with
  nothing executable to wade through; `src/module.ts` is now just operations and the
  `ModuleRegistration` wiring.

  For each of Callout, Meridian, and Manyfold:

  - **`src/manifest.ts`** — the permission-key consts (`SC_PERM`/`HR_PERM`/`MF_PERM`) **and**
    `moduleManifest.parse({...})`. The consts sit beside the manifest's `permissions` list —
    they're the same keys twice — so "add a permission" stays a single-file edit and the pair
    can't drift.
  - **`src/migrations.ts`** — the append-only `SqlMigration[]` journal (Callout's
    `boundary-lint-allow R5` extraction block moved with the migration it guards).
  - **`src/module.ts`** — imports both; holds row types, operations, and the module wiring.

  Each package gains a `./manifest` export subpath so the dashboard catalog reads a vertical's
  permission consts without dragging `seed.ts`'s `node:fs`/SQLite into the Worker bundle
  (`manifest.ts` imports only from `@substrat-run/contracts`). The `new-vertical` skill now
  scaffolds this three-file shape. Pure reorganization — no behavior, schema, or permission
  change (permission snapshots unchanged; all demo + dashboard scenario tests green).

- Updated dependencies [72b1128]
- Updated dependencies [92d1aa1]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [d4bf108]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [b06730e]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/control-plane-api@0.24.0
  - @substrat-run/engine-invoicing@0.3.22
  - @substrat-run/engine-protocol@0.4.16
  - @substrat-run/engine-workorder@0.3.22

## 0.1.11

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/engine-protocol@0.4.15
  - @substrat-run/engine-workorder@0.3.21
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/control-plane-api@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.1.10

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/control-plane-api@0.22.0
  - @substrat-run/engine-invoicing@0.3.20
  - @substrat-run/engine-protocol@0.4.14
  - @substrat-run/engine-workorder@0.3.20

## 0.1.9

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/control-plane-api@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/adapter-sqlite@0.21.0
  - @substrat-run/engine-invoicing@0.3.19
  - @substrat-run/engine-protocol@0.4.13
  - @substrat-run/engine-workorder@0.3.19

## 0.1.8

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/control-plane-api@0.20.0
  - @substrat-run/engine-invoicing@0.3.18
  - @substrat-run/engine-protocol@0.4.12
  - @substrat-run/engine-workorder@0.3.18

## 0.1.7

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/control-plane-api@0.19.0
  - @substrat-run/engine-invoicing@0.3.17
  - @substrat-run/engine-protocol@0.4.11
  - @substrat-run/engine-workorder@0.3.17

## 0.1.6

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/control-plane-api@0.18.0
  - @substrat-run/engine-invoicing@0.3.16
  - @substrat-run/engine-protocol@0.4.10
  - @substrat-run/engine-workorder@0.3.16

## 0.1.5

### Patch Changes

- Updated dependencies [983c06d]
  - @substrat-run/control-plane-api@0.17.0
  - @substrat-run/contracts@0.17.0
  - @substrat-run/kernel@0.17.0
  - @substrat-run/adapter-sqlite@0.17.0
  - @substrat-run/adapter-cloudflare@0.17.0
  - @substrat-run/engine-invoicing@0.3.15
  - @substrat-run/engine-protocol@0.4.9
  - @substrat-run/engine-workorder@0.3.15

## 0.1.4

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/control-plane-api@0.16.0
  - @substrat-run/engine-invoicing@0.3.14
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/engine-workorder@0.3.14

## 0.1.3

### Patch Changes

- Updated dependencies [7ed3015]
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/control-plane-api@0.15.0
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/engine-protocol@0.4.7
  - @substrat-run/engine-invoicing@0.3.13
  - @substrat-run/engine-workorder@0.3.13

## 0.1.2

### Patch Changes

- a1c7649: **A read-only "Data" tab: browse an app's own database from the dashboard.**

  Cashes in the seam kernel-design §5.4 reserved as the _admin-query RPC_ — a grant "is a
  tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
  read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
  them as a **Data** tab on the app detail view (list tables, page through rows).

  Read-only and table-shaped **by construction**: the caller picks a table from the live
  schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
  forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
  `system` so the UI groups it apart from the vertical's own tables. Every read is audited
  (K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

  **Reaches the data where it actually lives.** One dashboard app = one scope = one
  Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
  it reads directly. In connected/prod the scope's data DO lives in the _vertical's own WfP
  deployment_ (K-31), not the control plane's own (empty-module) scope host — so the
  control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
  (`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
  K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
  reading its own scope DB. The dashboard never emits an empty `200` — a null from the
  platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

  Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
  a shared contract-tests suite), new `contracts` introspection schemas, and
  `/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
  an arbitrary read-only SQL console are deliberately out of scope (fast-follows).

- Updated dependencies [f4ad677]
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/control-plane-api@0.14.0
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/engine-workorder@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.1.1

### Patch Changes

- 32abe73: **`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

  - **dir** → `.` (the current directory).
  - **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
    `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
    / `Meridian`).
  - **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
    the number (falls back to the package.json version for a slug's first-ever push).

  So `cd demos/meridian && substrat push` replaces
  `substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
  works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.

- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invoicing@0.3.10
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/engine-workorder@0.3.10
  - @substrat-run/control-plane-api@0.13.0

## 0.1.0

### Minor Changes

- f5933ec: **Callout bundles its SPA into the worker — no `ASSETS` binding (the pushable-vertical UI).**

  A pushed, sandbox-clean vertical can't serve static assets through a binding — Workers-for-Platforms uploads assets via a separate blake3 upload-session. So Callout now inlines its built SPA into the worker and serves it itself, reusing the module-upload path `substrat push` already has.

  - **`scripts/gen-assets.mjs`** reads `app/dist` and generates `src/assets.generated.ts` (each file inlined as UTF-8 or base64). **`src/assets.ts`** serves it: exact-file hit, else SPA fallback to `index.html`, else 404 for a missing path that looks like a file. The worker's catch-all calls `serveAsset` instead of `env.ASSETS.fetch`.
  - **`wrangler.jsonc` `build.command`** = `pnpm --dir app build && node scripts/gen-assets.mjs`, so wrangler regenerates the UI before every bundle — including the `--dry-run` a `substrat push` runs — with no extra step. `pretypecheck` regenerates for tsc (an empty map when `app/dist` is absent, so CI stays green). The generated file is gitignored.
  - **Dropped the `assets` binding.** The worker's only bindings are now its own `SCOPE` DO and `AUTH_DB` — both a vertical's own stores, both allowed by the §4 sandbox contract.
  - **`wrangler.example.jsonc` brought in sync** with the CP-less design it had drifted from (it still showed `CONTROL_PLANE`, the `assets` binding, and `STANDALONE`); it now documents the push-based deploy.

  Verified: `demo-callout` typechecks (node + worker), the scenario + provision suites pass (16 tests), and `wrangler deploy --dry-run` bundles the worker — build command running the app build + asset inline — with exactly `SCOPE` + `AUTH_DB` and no `ASSETS`.

- 9a34950: **Scope-local permissions, Phase 3b — Callout runs CP-less (docs/architecture/scope-local-permissions.md).**

  The first vertical on the control-plane-optional host (Phase 3a): the deployed Callout worker drops its `CONTROL_PLANE` bindings entirely and evaluates permissions from each scope's own storage. It is now a **sandbox-clean, pushable vertical** — the shape an untrusted self-serve deploy takes.

  - **`hostFor` builds `new CloudflareScopeHost({ scope: env.SCOPE })`** — no control plane. `/internal/provision` calls **`provisionScopeLocal`** (migrate the scope's modules, project the role table locally, grant the owner `office-admin` at scope level); the shared plane already owns the tenant/scope directory row + entitlements (the dashboard wrote them before calling), so the vertical sets up only the scope's own state.
  - **The request path trusts the router-asserted node.** Lifecycle is the router's gate — it resolves the hostname against the shared directory and forwards only an active scope. The connected-mode per-request `assertScopeActive` gate is gone; there is no directory to reach.
  - **Identity goes CP-less via an injectable `IdentityDirectory`.** The node demo keeps the CP-backed directory (`resolveIdentity`/`linkIdentity`) unchanged; the worker uses a **D1-user-row directory** — `user.principal_id` (migration `0002_principal_binding.sql`) holds the id→principal binding the control plane used to. First login mints a principal, grants it `technician` at scope level (works with no control plane), and writes the binding back.
  - **`wrangler.jsonc` is sandbox-clean:** only `SCOPE` (its own DO) + `AUTH_DB` + `ASSETS`. No `CONTROL_PLANE` DO binding, no `CONTROL_PLANE_SVC` service binding, no `ControlPlaneDO` migration class, no control-plane vars/secrets — the bindings a pushed vertical is allowed to declare (`assertSandboxContract`).
  - **Removed `/api/seed`** (the connected-mode demo seeder — every call it made now throws under the null control plane). The demo world's canonical exercise stays the self-contained SQLite scenario test; the live path is dashboard create-instance → `/internal/provision`.

  Verified: `demo-callout` typechecks under both the node and worker tsconfigs, the scenario + provision suites pass (16 tests), boundary-lint + the permission snapshot hold, and `wrangler deploy --dry-run` bundles the worker for the edge with exactly `SCOPE` / `AUTH_DB` / `ASSETS`.

### Patch Changes

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/architecture/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/briefs/dashboard-ui.md).**

  "Vercel, for Substrat" as a real React app, on the same design system as the operator console.

  - **Shared `@substrat-run/ui`** — the design-system primitives (Button, Input, Table, SideNav,
    Dialog, tokens, `styles.css`, icons) EXTRACTED from `apps/console` into a source-only workspace
    package (no build step; the Vite apps transpile it). The console now re-exports it through a thin
    `components` barrel + `@import "@substrat-run/ui/styles.css"` — its `../components` import paths
    are unchanged, so this is an internal refactor with no behaviour change.
  - **`@substrat-run/dashboard-web`** — a new Vite + React SPA (`apps/dashboard/web`), hash-routed,
    every screen from the handoff: sign-in, onboarding, Apps grid/list, Create App (Git import /
    marketplace / CLI), App Detail (Overview + Deployments / Env Vars / Domains / Integrations /
    Settings tabs), Team + roles matrix, Domains, Integrations, Billing, Analytics, Settings, plus
    the ⌘K palette, notifications, an account menu, dark mode, and the shell. **M0 is wired** to the
    real worker API (`/api/me`, `/api/catalog`, `/api/apps`); M1–M3 + future screens run on demo data
    behind the design's honesty banners. A `VITE_DEV_MOCK` preview mode (mirroring the console's
    `VITE_DEV_ACTOR` seam) renders the demo tenant without OIDC; `?theme=`/`?menu=` aid screenshots.
  - **`@substrat-run/dashboard` worker** now **serves the SPA** as Workers static assets
    (`run_worker_first: ["/api/*"]` + `single-page-application` fallback) instead of the old inline
    page (deleted); `/api/me` also surfaces the signed-in email/name for the shell.
  - **The catalog offers a real Callout**, not just Documents. The worker bundles the Callout
    vertical's modules via a new worker-safe `@substrat-run/demo-callout/module` subpath (just
    `calloutModule` + `SC_PERM`, never the seed/auth) plus `workorder` + `invoicing`. `createApp`
    grants the three-engine SKU + the office-admin owner grants and **binds a default hostname**
    `<slug>.<jurisdiction>.substrat.run` (K-30 → `callout.global.substrat.run`), best-effort, recorded
    on the app row. M0 stand-in: production deploys Callout separately (dashboard.md §6 — router + DNS
    - ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
      template, not imported.

  Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
  `callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
  builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
  catalog.

  **Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
  and provisioning each app as a separate deployment via the control plane — until then a bound
  hostname is recorded but does not yet resolve.

- Updated dependencies [05291fa]
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [7070588]
- Updated dependencies [66e752b]
- Updated dependencies [cedaf1a]
- Updated dependencies [097a3aa]
- Updated dependencies [0de890b]
- Updated dependencies [d5a7d5e]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/control-plane-api@0.12.0
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9

## 0.0.12

### Patch Changes

- Updated dependencies [a277bb7]
- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/adapter-cloudflare@0.11.0
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/engine-invoicing@0.3.8
  - @substrat-run/engine-protocol@0.4.2
  - @substrat-run/engine-workorder@0.3.8
  - @substrat-run/control-plane-api@0.11.0

## 0.0.11

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/adapter-cloudflare@0.10.0
  - @substrat-run/engine-invoicing@0.3.7
  - @substrat-run/engine-protocol@0.4.1
  - @substrat-run/engine-workorder@0.3.7
  - @substrat-run/control-plane-api@0.10.0

## 0.0.10

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/adapter-cloudflare@0.9.0
  - @substrat-run/control-plane-api@0.9.0
  - @substrat-run/engine-invoicing@0.3.6
  - @substrat-run/engine-workorder@0.3.6
  - @substrat-run/contracts@0.9.0

## 0.0.9

### Patch Changes

- Updated dependencies [c9fe555]
  - @substrat-run/control-plane-api@0.8.0
  - @substrat-run/contracts@0.8.0
  - @substrat-run/kernel@0.8.0
  - @substrat-run/adapter-sqlite@0.8.0
  - @substrat-run/adapter-cloudflare@0.8.0
  - @substrat-run/engine-invoicing@0.3.5
  - @substrat-run/engine-protocol@0.3.6
  - @substrat-run/engine-workorder@0.3.5

## 0.0.8

### Patch Changes

- Updated dependencies [017bb83]
- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
- Updated dependencies [ad89a9d]
  - @substrat-run/control-plane-api@0.7.0
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/adapter-cloudflare@0.7.0
  - @substrat-run/engine-invoicing@0.3.4
  - @substrat-run/engine-protocol@0.3.5
  - @substrat-run/engine-workorder@0.3.4

## 0.0.7

### Patch Changes

- Updated dependencies [ea3c5de]
  - @substrat-run/control-plane-api@0.6.0
  - @substrat-run/contracts@0.6.0
  - @substrat-run/kernel@0.6.0
  - @substrat-run/adapter-sqlite@0.6.0
  - @substrat-run/adapter-cloudflare@0.6.0
  - @substrat-run/engine-invoicing@0.3.2
  - @substrat-run/engine-protocol@0.3.3
  - @substrat-run/engine-workorder@0.3.3

## 0.0.6

### Patch Changes

- Updated dependencies [54c6583]
  - @substrat-run/control-plane-api@0.5.0
  - @substrat-run/contracts@0.5.0
  - @substrat-run/kernel@0.5.0
  - @substrat-run/adapter-sqlite@0.5.0
  - @substrat-run/adapter-cloudflare@0.5.0
  - @substrat-run/engine-invoicing@0.3.1
  - @substrat-run/engine-protocol@0.3.2
  - @substrat-run/engine-workorder@0.3.2

## 0.0.5

### Patch Changes

- Updated dependencies [6900431]
- Updated dependencies [7e9fad6]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
  - @substrat-run/adapter-sqlite@0.4.0
  - @substrat-run/adapter-cloudflare@0.4.0
  - @substrat-run/engine-invoicing@0.3.0
  - @substrat-run/engine-protocol@0.3.1
  - @substrat-run/engine-workorder@0.3.1

## 0.0.4

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0
  - @substrat-run/adapter-sqlite@0.3.0
  - @substrat-run/adapter-cloudflare@0.3.0
  - @substrat-run/engine-workorder@0.3.0
  - @substrat-run/engine-invoicing@0.2.0
  - @substrat-run/engine-protocol@0.3.0

## 0.0.3

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0
  - @substrat-run/kernel@0.2.0
  - @substrat-run/adapter-sqlite@0.2.0
  - @substrat-run/engine-workorder@0.2.0
  - @substrat-run/engine-protocol@0.2.0
  - @substrat-run/engine-invoicing@0.1.1

## 0.0.2

### Patch Changes

- Updated dependencies [7583dab]
  - @substrat-run/contracts@0.1.0
  - @substrat-run/kernel@0.1.0
  - @substrat-run/adapter-sqlite@0.1.0
  - @substrat-run/engine-workorder@0.1.0
  - @substrat-run/engine-invoicing@0.1.0
