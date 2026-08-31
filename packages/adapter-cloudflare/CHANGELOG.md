# @substrat-run/adapter-cloudflare

## 0.94.0

### Minor Changes

- 1fc01d3: `ctx.sql` now refuses to write the platform spine. "Never write `_substrat_*`" was a
  source rule only, and the source scan does not run on the hosted push path — so a
  module could forge a grant, rewrite an announced event or drop the migration journal
  through the same connection the kernel writes them with. Both adapters wrap their
  module-facing connection in the kernel's new `guardSpine`; reads of the spine,
  including the ones that feed a timeline projection, are unchanged.

### Patch Changes

- 692cb92: An expiry written with a UTC offset no longer outlives itself. `Instant` accepts an
  offset on the wire and now normalises it to the equivalent `Z` text at the parse, so
  the lexicographic comparison every expiry check uses agrees with chronological order —
  a grant that expired an hour ago is refused whichever zone it was written in.
- 24b6855: Hostname resolution now filters `status = 'active'` in SQL on the Cloudflare adapter too,
  the way the SQLite adapter already did. The router's read (`readRoute`) is separate from
  the admin read and carries no scope status, so a suspension re-check cannot creep into the
  router; a new contract test covers refusing a name a live scope holds and reclaiming one an
  archived scope released.
- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [1fc01d3]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0
  - @substrat-run/kernel@0.94.0

## 0.93.0

### Minor Changes

- df4ffd1: Meter 3, for model usage (#1054, step 3). A vertical's model host raises each `ModelUsageLine` as a `model-usage` platform intent; the control plane's drain records it in the directory's `_substrat_model_usage` ledger, idempotent on the intent id (a replayed drain writes nothing twice) and refusing a line attributed to any tenant, scope or vertical other than the one being drained. `HostAdmin` gains `recordModelUsage`, `listModelUsage` and `summarizeModelUsage`; the fold (`foldModelUsage`) is the kernel's, so both adapters quote one number — list price summed exactly, the platform's margin (`MODEL_MARGIN_PERCENT`, default 20, applied at read time) beside it, unpriced calls counted rather than folded in as $0. `GET /model-usage` and `GET /model-usage/summary` serve it; the console's Meters view shows it beside meters 1 and 2.

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0

## 0.92.1

### Patch Changes

- @substrat-run/contracts@0.92.1
- @substrat-run/kernel@0.92.1

## 0.92.0

### Minor Changes

- 7843c4f: The client half of a request, normalised once. `@substrat-run/contracts` gains `ClientContext` — the browser, OS and device kind parsed out of the `User-Agent` (`parseUserAgent`), the preferred language, and a geo (country, region, city, timezone, continent) — plus `clientContextOf(headers, geo?)` to build one from the headers every host has. `@substrat-run/adapter-cloudflare` gains `cloudflareClientContext(request)` / `cloudflareGeo(cf)`, the one place `request.cf` is read: Cloudflare's `T1`/`XX` country sentinels become null, the region is the name rather than the code, and latitude, longitude and postal code are not carried. No IP address in either.

  ticket0 stores it: `ticket0/widget-start` takes an optional `client`, the widget surface supplies it from the request (the worker via the Cloudflare adapter, the dev server from headers alone), `ticket0_widget_openings` and `ticket0_widget_sessions` each grow the same eleven nullable columns for it (the opening records them, the first message carries them onto the session), and a new staff read `ticket0/widget-session` (`GET /conversations/{id}/widget-session`, `conversation:read`) returns the latest session minus its token hash. The inbox rail shows it as "Safari 17 on iOS · Stockholm, Sweden · 03:12 their time".

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/kernel@0.92.0

## 0.91.1

### Patch Changes

- @substrat-run/contracts@0.91.1
- @substrat-run/kernel@0.91.1

## 0.91.0

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.90.1

### Patch Changes

- Updated dependencies [7b50231]
  - @substrat-run/contracts@0.90.1
  - @substrat-run/kernel@0.90.1

## 0.90.0

### Minor Changes

- 3561f7f: Act as a principal with the real actor preserved (K-42)

  Supporting a customer's live vertical meant asking them to screenshot things: there was
  no supported way to see what a named principal sees, and the only impersonation in the
  tree was the `ALLOW_DEV_HEADER` dev bypass. Every platform grows this surface eventually,
  and the version that grows by itself is a session swap that loses the real actor — which
  is exactly the version that fails an audit.

  An impersonated operation now carries **two** actors:

  ```ts
  const session = await host.admin.beginImpersonation(staff, {
    tenantId,
    scopeId,
    principal: anna,
    reason: "ticket #4182 — the invoice screen is empty",
    // minutes: 15 by default, capped at IMPERSONATION_MAX_MINUTES
    // mode: 'read-only' by default
  });
  const stub = await host.getImpersonatedScope(session.id, tenantId, scopeId);
  await stub.invoke("callout/list-orders"); // answers as Anna
  ```

  The permission model answers about the **impersonated** principal, through the ordinary
  checker with no override branch — so a session against a principal who holds nothing is
  refused precisely where that principal would be. The staff actor rides beside it as a
  kernel-stamped `impersonation` on the outbox envelope, the denial row and the
  platform-intent journal, on K-34's pattern: absent from `DomainEventInput`, so module
  code can neither claim a session nor drop one. It is absent from `ctx` too — a vertical
  that could read the session could hide rows from it.

  **`read-only` is the default, and it is a mechanism rather than a promise.** The
  effecting verbs (`emit`, `requestPlatform`, `grant`, `revoke`, `link`) refuse by name,
  and the transaction is rolled back instead of committed — which is what holds when a
  handler writes a row with plain `ctx.sql.exec` and calls none of them. The operation
  still runs and still answers; only the writes do not survive.

  Sessions are bounded and reason-carrying, admin-logged **before** they can be used
  (K-33's failure ordering), and re-read on every invoke rather than once at the door — a
  stub is a capability, so a session checked only when it was minted would expire for
  everybody except the one caller holding it. `endImpersonation` closes one early;
  `listImpersonations` reads the log and is access-logged like every other staff read.

  Both adapters, held to one shared `impersonationContractSuite`. Additive throughout: the
  new envelope, denial and intent fields are optional, and a null means "nobody was
  impersonating" rather than "unrecorded".

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0

## 0.89.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0

## 0.88.0

### Minor Changes

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

- cabd449: kernel: an entity's version is the last event's ULID (`ctx.versionOf`)

  Two users edit the same customer and the last write silently destroys the first. Nothing in
  the platform could refuse that, because nothing could say which revision of a row a caller
  had read — no entity table carries a version, and `precondition_failed` (412) has sat
  declared-but-unraisable in the error taxonomy waiting for one (#901, unblocking #129).

  **The version already existed.** `_substrat_outbox` has recorded `entity_type` and
  `entity_id` against a monotonic ULID `id` since it was written, on every event, for every
  module. Every mutation that followed the fat-event rule already versioned the thing it
  touched; nothing had ever read it back. So this adds `ctx.versionOf(ref)` — the ULID of the
  last event about an entity, or `null` if there has never been one — and an index that makes
  it a seek.

  **The rejected design is the interesting half.** This began as a `_version INTEGER` column
  on every entity table, added at the moment DDL derivation makes it cheap. That was filed as
  time-boxed and urgent, and it was the wrong shape for two reasons that are not about cost.

  The only way to make a column unforgettable is a trigger emitted per table — and a trigger
  is SQLite, replicated into ~73 tables, re-derived for every vertical authored afterwards.
  The scope-host contract is not a SQL contract; `query`/`exec` are how _these two adapters_
  happen to serve it, and a guarantee expressed as DDL cannot be honoured by an adapter that
  is not SQLite. The spine version is one method with an adapter-private implementation: same
  guarantee, no vertical carries it, no adapter is bound to SQLite to provide it. It also
  means there is no window — a spine fact is not time-boxed by DDL derivation at all, so this
  no longer gates that work.

  The ULID earns the job on four properties, each verified rather than assumed. It is
  **monotonic** (`ulid()` uses the spec's monotonic factory, which the outbox's `ORDER BY id`
  already depended on, so two events in one millisecond still compare in creation order). The
  outbox is **never pruned** — it drains, it does not expire. It **survives erasure**: a shred
  nulls `payload` and keeps the row, so an erased entity can still refuse a stale write rather
  than failing open at the worst possible moment. And it is **unforgeable**, because module
  code cannot write `_substrat_*` — a column would have needed a trigger clever enough to
  reset a forged value.

  **Two properties that are not the happy path, both pinned by the contract suite on both
  hosts.** A shred does not take the version with it. And a mutation that emits nothing does
  _not_ move it — that is the honest hole, since "every mutation emits a fat event" is
  enforced by review and not by `boundary-lint`. The answer is not a change here: it is that a
  declared `concurrency` must be compile-checked against the operation's declared `emits`
  (#129), which is strictly more than the column would have given — a trigger guarantees the
  column moved, never that the operation announced what it did.

  One behavioural difference from a per-row counter, documented at the seam rather than left
  to be discovered: **any** event about the entity moves the version, including one that
  changed nothing the caller read. A precondition built on this is conservative — it can
  refuse a write that would have been safe, and cannot admit one that would not.

  The index (`_substrat_outbox (entity_type, entity_id, id)`, `id` last so SQLite walks to the
  end of the matched range instead of aggregating over it) lands in both adapters' spine DDL,
  which is all `IF NOT EXISTS` and re-applied on every cold start — so existing scopes pick it
  up with no migration and no backfill. The outbox had no index at all before this; it was
  only ever read in drain order, which is its primary key.

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

## 0.87.0

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.86.0

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0

## 0.85.0

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0

## 0.84.0

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

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0

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

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0

## 0.82.0

### Patch Changes

- 75925a2: A store that cannot be minted answers with a diagnosis, and no longer costs the caller the
  reconcile (#828).

  `substrat scope provision` — the lever #825's own deploy note prescribes — began answering
  `500 {"error":"internal error"}` for every scope with a declared blob store. Three faults,
  each of which was enough on its own.

  **The R2 client was never constructed.** `createR2BlobStores` shipped with #473, was
  exported, and was covered by tests against an injected fake; nothing in the deployed
  control-plane worker ever called it. `hostFor` wired the D1 twin and stopped, so
  `provisionBlobStore` refused on every real control plane while the suite stayed green — the
  untested seam was the worker's own construction, not the client. It stayed latent until a
  vertical first declared a blob store, which is exactly what #825 was filed for. Both clients
  are now built together in one exported `platformStoreClients`, and the pairing is asserted:
  a future store substrate has to appear there or the test fails.

  **Minting is best-effort on the repair path, as it already is on promote.** #826 made
  provision mint before reconciling, unwrapped — so a mint failing for reasons unrelated to
  this scope (a credential without the permission, a client the deployment never configured,
  the store API refusing) took the whole call down, and the caller lost the owner re-grant and
  role re-projection they actually came for (#332). Each substrate is now attempted
  independently, records an ops-failure row with its stage, and rides back as `storeError` in
  the response, which `substrat scope provision` prints. The two paths finally agree about the
  same operation's failure semantics. A _new_ install keeps the fail-loud posture deliberately:
  its store is handed into the K-31 ready-gate, so proceeding without one hands back a
  half-built scope that reports success.

  **"Not configured on this host" reaches the caller.** Both store refusals are now typed
  `unavailable`, and `mapError` maps that code to 503 with the message intact — the same
  treatment `SecretBoxUnconfiguredError` gets (#603), for the same reason: a deployment fact is
  not a fault in the request, and the same request succeeds unchanged once the host is wired.
  The message names what to configure, and the platform spent four hours answering
  `internal error` to a provision while holding it.

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/kernel@0.82.0

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

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0

## 0.80.0

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.79.0

### Minor Changes

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

### Patch Changes

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
  - @substrat-run/kernel@0.79.0

## 0.78.0

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.77.0

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.76.0

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.75.0

### Minor Changes

- 89c2113: `ctx.atomic` — engine calls can now be sub-transactions, so catching one is safe (#770).

  A vertical composes engine in-scope functions inside ONE scope transaction, and the adapter
  rolled back only when the whole handler threw. So a vertical that did the reasonable thing —
  catch a `completeWorkOrder` failure, fall back to a manual path — was sitting on the engine's
  partial writes and committed them. Those are precisely the rows the engine's invariants exist
  to protect, which makes it the one place partial state is least acceptable. The only correct
  advice was "never catch an engine error": a convention, in the one category this platform
  normally answers with a mechanism.

  ```ts
  try {
    await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
  } catch {
    // the engine's rows, events, links, grants and platform intents are all gone;
    // your own writes survive, and it still commits once
  }
  ```

  **Every semantic lives in the kernel.** A scope host supplies one method — `runSub(depth, fn)`
  — and `createAtomic` owns the depth stack, the interleaving guard, the unwrapped rethrow, and
  the restore of two tallies the storage rollback cannot reach. That split is for the third
  adapter: a Postgres or Kubernetes host writes three SQL statements and inherits the rest.
  `runSub` is closure-shaped because the Durable Object primitive _is_ a closure and forbids
  `SAVEPOINT` outright — the two hosts share a contract, never an implementation.

  The subtle half is what does not roll back on its own. The K-34 `passed` accumulator lives in
  JavaScript, so a check that passed inside a discarded region would have ridden out on the next
  event — the audit spine attributing a permission check to an event whose operation threw that
  work away, with nothing raised and the event well-formed. The #458 platform-request tally
  leaked the same way and kicked a drain for intents that never survived. Both are restored now.

  Also a portability fix. "Catch an engine error and keep going" meant three different things
  across the substrates this project claims: SQLite committed the partial writes, the DO host did
  the same, and Postgres poisons the transaction outright (`25P02`) so the operation dies at the
  next statement. `ctx.atomic` gives it one meaning, and `@substrat-run/contract-tests` now ships
  `atomicContractSuite` — twelve cases both adapters pass unchanged, including the Postgres-shaped
  one (a caught _storage_ error leaves the transaction usable) that no existing suite could express.

  Design note: `docs/rfc/sub-transactions.md`.

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.73.0

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.72.0

### Minor Changes

- f869541: `ctx.grant` / `ctx.revoke` — an operation may narrow a permission it holds onto
  one entity.

  Every entity-narrowed grant in the fleet is made at seed time by
  `HostAdmin.grant`, a platform actor's verb. So an app where a _person_ shares
  their own record with someone had no supported mechanism: `OperationContext`
  offered `check`, `link` and `emit`, and nothing that could widen access at
  runtime. The only way to ship such a feature was a membership table consulted by
  hand in every handler — the forgotten-WHERE-clause failure this platform exists
  to remove, reintroduced one vertical at a time.

  Found by building a vertical forward from its model rather than converting one
  that already existed: the todo demo's sharing feature is unbuildable without it,
  and no existing demo could reveal the gap because all of their entity-narrowed
  access is seeded.

  Non-escalating by construction:

  - **Entity-narrowed only.** `entity` is required, so module code can never write
    a scope-wide or tenant-wide grant.
  - **Delegation, never elevation.** The caller's own decision on that entity is
    re-checked inside the verb, so an operation can only hand out what it was
    itself given.

  Transactional with the operation, like rows and events: a grant made by an
  operation that then throws never happened.

  Pinned by five contract-suite cases both adapters run — the happy path, that the
  grant reaches that entity and nothing else, the refused elevation, a control
  proving a permission the caller _does_ hold still grants, and revoke. The
  refusal case is mutation-checked: removing the guard fails it.

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

## 0.71.0

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.70.0

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.69.0

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.68.0

### Minor Changes

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

## 0.67.0

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.66.0

### Patch Changes

- 954668b: Install grants an entitlement key the manifest can actually match, and a denied operation names both sides of the gap.

  **The fallback emitted an illegal key.** `installEntitlements` derives from the
  vertical's slug when nothing is declared — but a builder-pushed vertical's
  registry slug is workspace-prefixed (`t-0wv2mwk4j5/crm-eff`), while
  `manifest.entitlementKey` is `/^[a-z0-9-]+$/`. A slash is not a legal key, so
  the fallback produced a value the thing it claims to derive from can never
  equal: for a pushed vertical the granted and required keys could not agree, by
  construction. The gate reads `manifest.entitlementKey` directly, so every gated
  operation denied. The fallback now takes the slug's bare last segment, which
  repairs already-pushed verticals on their next install without a re-push.

  The mismatch was invisible until it wasn't. An un-projected scope trusts
  upstream; the flip to strict enforcement is one-way and fires on the _first_
  projection carrying entitlements — a fan-out, a reconcile, a re-provision. So a
  bad key planted at install detonates arbitrarily later, triggered by something
  unrelated to installing. That is what made the 2026-08-15 Egeryds prod lockout
  read as a sudden platform failure rather than a four-month-old typo.

  **The denial now names required AND held keys**, expired ones marked, via a
  shared `entitlementDenial()` in the kernel so the three gates (coordinator,
  scope DO, SQLite adapter) cannot word it differently. Required-alone reads as
  "buy the SKU" and sends an operator shopping; the Egeryds tenant _held_ four
  keys, just under names the manifest could never match, and required-vs-held
  shows that near-miss at a glance. Marking expiry separates "you had it, it
  lapsed" from "you never had it" — different fixes. The extra read happens only
  on the failure path; the hot path is unchanged.

  Not changed: a required key going ungranted still does not fail the install. A
  composed engine's key being absent is a legitimate SKU gate — a tenant on
  workorder but not absence is a valid state — and the platform cannot tell that
  apart from the vertical's own key being missing.

  A vertical whose `entitlementKey` diverges from its slug must still declare
  `substrat.entitlements` in package.json; the manifest never reaches the control
  plane, so no derivation can guess it. That escape hatch is now documented in
  marketplace-publish.md, along with the fact that every engine a vertical
  composes adds a key.

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.65.0

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

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

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.63.0

### Minor Changes

- 5e71e1c: fix: a plane with no seal key says so (503), instead of a bare 500 on every connect

  Saving a Scrive credential against the deployed control plane returned `500` with no usable
  detail. The cause was one line of deployment configuration: `SECRET_BOX_KEY` was unset, so the
  host fell back to the unconfigured `SecretBox` and the connection store refused to write. The
  refusal was **correct** — storing a credential unsealed is not an option — but it threw a plain
  `Error`, which no seam recognised, so it collapsed into the generic 500 handler. The operator
  saw what looked like a bug in the credential or the relay; only a worker tail (or `wrangler
secret list`) revealed a fact the process knew at boot.

  - **The relay asks first.** `HostAdmin.canStoreSecrets` reports whether the host was built with
    a box, and `relayConnectionUpsert` refuses up front with a `503` naming the missing key.
    Ahead of the pre-flight probe deliberately: a host that can never keep the answer has no
    business spending an outbound call to learn it, or handing the plaintext to the provider on
    the way.
  - **`503`, not `4xx`.** The request was well-formed and nothing about it needs correcting — it
    is the deployment that is incapable. It is also not a silent one: the refusal lands an
    ops-failure row like every other platform 5xx, so it is visible in the console rather than
    only on the screen of whoever tried to connect.
  - **Typed, so the other consumers are covered too.** The box now throws
    `SecretBoxUnconfiguredError`, and the control-plane's error boundary maps it to the same 503.
    That reaches every path a misconfigured deployment can hit — rotation, subject keys, a dump
    seal — not just the one the incident happened to come through. It is the first case of the
    typed-error fix that `mapError`'s own header has called the durable answer to matching on
    message text.
  - **The connect dialog says which thing is wrong.** A 503 now reads "this deployment can't store
    credentials right now — nothing was saved, and nothing was sent to Scrive", kept distinct from
    the provider refusing a key. A correct credential is never presented as the thing to fix.

  `HostAdmin` gained a required `canStoreSecrets`; both in-tree adapters answer it from the box
  they were constructed with.

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.62.0

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.60.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.59.0

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

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

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.57.1

### Patch Changes

- @substrat-run/contracts@0.57.1
- @substrat-run/kernel@0.57.1

## 0.57.0

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

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

- 1fa4bd0: feat: the connector write-back seam — the platform runs the connector pass for CP-less verticals (#574 phase 1)

  A CP-less dispatch vertical cannot run a connector: the connection directory and
  its sealed secrets live platform-side, and a pushed script must never hold them.
  This lands the approved shape's first phase — the shared control plane runs the
  connector pass FOR dispatch verticals, and the vertical opens one narrow
  write-back door:

  - `vertical-host` mounts three platform-secret-gated verbs:
    `/internal/connector-invoke` (one operation, invoked as the connection),
    `/internal/connector-attachment` (the multipart bytes leg), and
    `/internal/connector-grant` (delivery of the scope-local `connection:<id>`
    grant tuple). Authorization happens in the scope's own DO against that
    delivered tuple — the platform cannot skip the permission check.
  - `CloudflareScopeHost` gains the far-end local methods
    (`connectorInvokeLocal` / `connectorAttachmentUploadLocal` /
    `connectorGrantLocal`) and a `connectorDelegation` option for the platform
    end: with it set, `getConnectorScope().invoke`, `getConnectorAttachments()`
    upload, and scope-level `grantToConnection` ride the delegation to the
    deployment actually serving the scope instead of touching the control plane's
    own module-less scope namespace. Directory gates (live connection,
    tenant/vertical match) still run platform-side before every delegated call.
  - `VerticalClient` speaks the three verbs (`connectorInvoke`,
    `connectorUploadAttachment`, `connectorGrant`).
  - The control plane wires the delegation into its host, seals/opens connection
    credentials with a new `SECRET_BOX_KEY` secret (base64 of 32 bytes, the
    dashboard's exact convention; canonical name `CP_SECRET_BOX_KEY` in
    secrets.mjs), and registers the Scrive sweeper on its scheduled
    `runPlatformSweep` pass — the poll floor now covers hosted verticals'
    connections. `SCRIVE_BASE_URL` selects the provider environment (default:
    testbed).

  Phase 2 (webhook ingress terminating on the platform) and phase 3 (outbound
  dispatch riding platform-requests) follow.

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

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.55.0

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

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

### Patch Changes

- 6ecb3c9: feat(platform): the stored copies get a lifecycle, and only an operator can start the clock (#557)

  The backup buckets kept every copy forever: `scopes/` reap copies (#493) and `access-log/`
  NDJSON batches (#553) had no lifecycle rule — the one retention decision #36's closure left
  unmade. (`directory/` copies were never the gap; their 30-copy window has lived in
  `backupDirectoryIfDue` since #40.)

  **`pruneScopeBackups` / `pruneAccessLogBatches`** (control-plane-api) enforce an age window
  over their own prefix, in code rather than as an R2 bucket rule so the policy is visible in
  the repo and portable to any store. Both are conservative by construction: an object that
  cannot be dated is kept, and an access-log batch is dated by its **newest** row — never
  dropped while it still holds in-window rows. The CP worker's sweep runs them behind two new
  opt-in vars, `SCOPE_BACKUP_RETENTION_DAYS` and `ACCESS_LOG_RETENTION_DAYS`; unset — the
  default — deletes nothing, the same posture as the reap windows: the platform never deletes
  evidence on a schedule a human did not choose.

  **The drive-by #553 flagged:** `pruneAccessLog`'s admin-log row carried its payload in
  `before`, inverted from `adminLogEntry`'s contract (before = prior state, after = the
  applied payload). Both adapters now record `after: { pruned }`, matching `drainAccessLog`,
  and the contract suite pins the shape.

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

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

- 88e2efa: fix(control-plane): a push stops reading the whole fleet to warn about its own surfaces

  A `substrat push` answered `500: internal error` **after** its version had already been
  published — the bundle uploaded, the version landed admitted, and only then did the
  request die. Each CI retry burned another version label and left another admitted version
  behind for a deploy that reported failure, so a PR's three attempts produced `…-pr-30.1`,
  `.2` and `.3` and no working preview.

  The throw was in the advisory surface-drift check, which is the last thing a deploy does.
  It asked for **every hostname binding on the platform** and filtered to the pushed slug in
  JS. Two things were wrong with that, and only together do they make an outage:

  `mapHostname` read the stored cert-validation records with a bare `JSON.parse`. That column
  is the one part of a hostname row this platform does not write — it is whatever the
  Cloudflare custom-hostname API returned, stored verbatim — so an unreadable blob there is a
  `SyntaxError`, which is not a `ZodError`, which `mapError` does not recognise, which is a
  blank 500. Because the read was fleet-wide, a cert detail belonging to one tenant's custom
  domain could stop an unrelated vertical from shipping, with nothing in the response saying
  so.

  So: **narrow the query, and never throw on that column.** `listHostnames` takes a
  `verticalSlug` filter, implemented in SQL by both adapters, and the deploy path asks for the
  bindings it actually wants — the rows that answer the question are now the only rows that
  can break it. `parseValidationRecords` (kernel, shared by both adapters so neither can be
  the lenient one) degrades a malformed or wrong-shaped blob to "no records". Nothing routes
  on those records; they are a copy-this-CNAME hint, and `substrat hostnames verify` re-polls
  issuance and rewrites them.

  **And the read that was never the right shape.** "The version with this id" was spelled as
  an unpaginated `listVersions(slug)` followed by `.find()` — every version a vertical ever
  published, each carrying its stored manifest, pulled across the adapter boundary to keep
  one. That cost grows once per push and lands hardest on the paths least able to afford it:
  the deploy handler's own read-back, and the router's per-request resolution of which script
  serves a scope. New `HostAdmin.getVersion(actor, versionId, verticalSlug?)`, implemented by
  both adapters, replaces nine such call sites. The optional slug preserves what
  `.find()`-inside-one-slug's-list gave for free — a version of another vertical reads as
  absent rather than being handed back across the lineage boundary.

  The retries remain non-idempotent: a push that fails after `publishVersion` still consumes
  its version label. Left alone here because making a push resumable is a design change, not
  a fix, and it is no longer reachable by this route.

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.51.0

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

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

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.49.0

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.48.1

### Patch Changes

- f278cc6: fix(previews): route a preview to its bound version, not the prod serving script (#527)

  A preview reported success and printed a URL that then served the promoted **prod**
  build, not the version it just pushed — so a reviewer saw their change missing and
  concluded it hadn't landed. Root cause: every scope inherited the vertical's stable
  `serving_ref` at provision (#286), and routing resolves
  `COALESCE(scope.serving_ref, version.deployment_ref)`, so a preview resolved to the
  prod serving script instead of the per-version dispatch script its data was restored
  into. Preview scopes now skip that inheritance (both adapters), so routing falls through
  to the bound version's script. Reused previews created before this fix self-heal (the
  stale `serving_ref` is cleared on re-push). Defense-in-depth: `orchestratedPreview` now
  refuses to report success for a preview that would route away from its bound version.

  - @substrat-run/contracts@0.48.1
  - @substrat-run/kernel@0.48.1

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

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.47.0

### Minor Changes

- 6a7b4a8: Clean-room (source-less) previews — a vertical's FIRST environment can be a throwaway
  (issue #509 ask (b), the other half of #514).

  A preview forked prod, so a brand-new vertical with no prod scope was refused
  (`no prod scope to fork — provision one first`, 409) — exactly when a throwaway environment
  is most useful. `substrat preview create --tag … --empty` now provisions an **empty** scope
  instead of forking: the module tables are migrated (co-located at provision; a dispatch
  deployment materializes the empty DO and its `ensureMigrations` creates the schema on first
  access), the version binds, and a hostname is minted.

  - **Hostname:** with no source scope to derive a URL from, a clean-room preview follows the
    platform tenant-app convention `<vertical>-<tenant>--<tag>.<base>` — the same scheme
    provisioning mints (`callout-sesamy.global.substrat.run`).
  - **GC:** a clean-room preview is a `preview` scope with no `forkedFrom`, so the reap sweep
    and `deleteSnapshot` now key off **`kind === 'preview'` OR a fork**, not fork-ness alone —
    the one sanctioned hard-delete invariant widened from "only a fork" to "a fork or a preview".
    A primary scope is still tombstone-only (archive it). This is the one semantics change here.
  - `empty` and a `sourceScopeId` are mutually exclusive (400) — the request is refused, never
    silently guessed.

  Contract-suite coverage (both adapters): `deleteSnapshot` reaps a non-fork preview, and the GC
  sweep reaps an expired one. Control-plane API: a clean-room preview provisions an empty non-fork
  scope with the tenant-app hostname and deletes like any preview.

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

- 0e48b8f: Previews survive publication — a listed vertical's builder keeps a working non-prod path
  (#509 ask (d), issue #513, Tier 2).

  Before this, the moment a vertical was published (`listed = true`) its builder had **no**
  non-prod path at all: the `dev`/`staging` promote buttons served nothing (fixed in #512),
  prod promote is staff-gated, and previews were refused outright (`403 — private verticals
only`). Even relaxing that 403 wasn't enough, because `bindScopeVersion` hard-refuses a
  non-admitted version, and a listed vertical's push lands **pending** — so the preview could
  never bind the new code.

  The fix draws the boundary where it belongs. **Admission gates code reaching an install.**
  A preview is a fork of the builder's _own_ tenant scope at a non-canonical URL, serving no
  install — the same own-tenant blast radius a private vertical already self-admits under. So:

  - **`bindScopeVersion` admits a pending version onto a `preview` scope** (both adapters), and
    keeps the refusal for every other scope kind. A serving scope still cannot bind unadmitted
    code — the marketplace install gate is intact.
  - **The preview gate no longer refuses listed verticals.** A builder is still confined to a
    vertical it owns, and a first-party vertical (no owner tenant) still has no scope of its own
    to fork.

  The working non-prod path for a listed vertical is the CLI — `substrat preview create --tag …`
  now forks the owner's prod scope and runs the pending PR code on it. (The dashboard has no
  preview surface yet; a console affordance is future work.)

  Contract-suite coverage (runs against both adapters) asserts a preview fork binds a pending
  version while a serving scope still refuses it; the control-plane API test covers the listed
  owner end-to-end plus the first-party refusal.

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.46.0

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

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

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.44.0

### Minor Changes

- 3246681: Guard `reapScope` so a still-serving scope can never be reaped. A serving app
  always holds ≥1 bound hostname, so `reapScope` now refuses (fail closed) while
  any hostname is bound to the scope — unbind first, a visible and reversible step.

  The hole this closes: `reapScope` _assumed_ "hostnames were released at archive",
  which is true for the dashboard delete path (it unbinds) but not for a bare
  console `archiveScope` (a status flip only). An archived-but-still-bound scope
  walked straight into the irreversible wipe, taking a live app's storage with it.

  The guard is enforced in two places — the host adapter (so the contract suite
  asserts it for every adapter) and the per-scope reap route, ahead of the
  vertical's `deleteScope` where the production wipe actually happens. `HostAdmin.reapScope`
  gains an optional `{ force?: boolean }`: deliberate teardown (tenant reap §4.8,
  retention sweeps §4.4) releases every name by design and sets `force: true`; the
  interactive per-scope reap never does.

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.43.0

### Minor Changes

- d3c0b16: Registering a login as an employee grants it self-service (an employee can report their own time).

  Logging time goes through `time:report` **narrowed to the caller's own employee record** — a
  permission that lives in no role (an hr-admin holds `time:read`, never `time:report`). That grant
  was only ever issued by the demo seed, so on a real install `hr/create-employee` stored your
  `principalRef` but never granted anything: you'd land on "My work" yet every `hr/log-time` was
  denied. The tab was on, the grant was not.

  - **`adapter-cloudflare`** gains `CloudflareScopeHost.grantEntityLocal(scope, principal, permission,
entity)` — the CP-less, entity-narrowed sibling of `assignScopeRole`. Where a role reaches every
    entity in the scope, this reaches exactly one, writing the same
    `(principal:<id>, granted:<perm>, <type>:<id>)` tuple the local checker's entity walk reads, so a
    grant issued here resolves identically to one the control plane fanned out.
  - **Meridian** (`demos/meridian`, private): when `hr/create-employee` runs with a `principalRef`, the
    worker (and the SQLite dev server, via `host.admin.grant`) issues that principal the
    `EMPLOYEE_SELF` grants on the new record — only ever reached by a caller who already passed the
    operation's own `employee:manage` check, so no fresh authority is minted. The People screen adds a
    "This is me — link my login" affordance so an admin can register themselves as an employee and
    report their own time, leave and expenses.

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.42.0

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

### Patch Changes

- e9c7bd0: `deleteVertical`'s bound-scope refusal no longer counts `reaped` tombstones —
  they are terminal history, and counting them made any vertical that ever had an
  install permanently undeletable. An `archived` scope (a deleted app) still
  blocks, since unarchive can restore it, but the refusal now names the actual
  remaining step ("reap or restore them first") instead of telling the caller to
  delete an app that is already gone. Contract-tested in both adapters.
- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.40.0

### Minor Changes

- d96269e: Adapters report committed platform intents to the stub minter (#458). `getScope` accepts `ScopeStubOptions` with an `onPlatformRequests(count)` observer, fired after an invoke commits having enqueued `ctx.requestPlatform` intents — never on rollback. A vertical wires it once in its stub helper to flag responses `x-substrat-platform-request` (new kernel constant `PLATFORM_REQUEST_HEADER`), so the router kick (#381) drains provisioning in seconds without per-route hand-wiring.
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
- b82d40f: `defineScopeSweeperDO` — the timer a CP-less vertical owns (#461, closing the trigger
  half). `runPlatformSweep`'s drain and schedule phases enumerate scopes via the
  control-plane directory, which a CP-less dispatch vertical does not have — so its
  declared schedules parsed, granted, and never ran. The new singleton DO keeps a roster
  of the deployment's scopes (fed by the platform through `/internal/provision` and
  `/internal/reconcile` via `noteScope`, pruned by `/internal/delete-scope` via
  `forgetScope` — forks stay off by construction, since a snapshot target is never
  provisioned) and alarm-drives each rostered scope's `drainDue` + `runDueSchedules`
  through the deployment's own host, with the same non-overlap/never-dies loop as
  `definePlatformSweeperDO`. The alarm lapses on an empty roster and re-arms on the
  next `noteScope`, so an idle deployment costs nothing. The create-substrat template
  wires it by default: a `SWEEPER` store in `substrat.runtimeNeeds`, the three route
  calls, and the kernel-line pin moves to the release that ships the sweeper.

### Patch Changes

- 3a0eaa4: Declared schedules run on a CP-less host (#461). `provisionScopeLocal` now projects each registered module's `system:<moduleId>` schedule grants (#383) into the scope's tuples, in the same atomic projection unit as the owner grant — without them the grant-is-the-switch check reported `fired: 0` forever, indistinguishable from "nothing due". And `runDueSchedules` skips the control-plane liveness read on a CP-less host, which has no directory to ask and already trusts the router-asserted (tenant, scope). `scheduleMod` is now exported from contract-tests for adapter-level CP-less coverage.
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

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

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

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

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.37.1

### Patch Changes

- @substrat-run/contracts@0.37.1
- @substrat-run/kernel@0.37.1

## 0.37.0

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.36.1

### Patch Changes

- @substrat-run/contracts@0.36.1
- @substrat-run/kernel@0.36.1

## 0.36.0

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

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

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

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

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.32.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.31.0

### Minor Changes

- 50d9260: Platform intents, Phase B1: the drain surface (read + settle).

  Adds the read/settle half of the platform-intent queue from `docs/architecture/platform-intents.md`, so
  the platform can pull a scope's pending intents and journal their outcome. `ScopeHost` gains
  `listPlatformRequests(tenantId, scopeId)` (pending intents, mapped to the `PlatformRequest`
  contract shape) and `settlePlatformRequest(tenantId, scopeId, id, { status, result, lastError })`
  (mark `done` / `failed` / `pending`-for-retry). Both are fleet-maintenance (no actor), the same
  class as `drainDue`, implemented symmetrically in both adapters (a `pendingPlatformRequests` /
  `settlePlatformRequest` DO RPC pair on the Cloudflare scope DO; direct table reads/writes on the
  SQLite adapter).

  `result` is COALESCE'd on settle, so a value written on an earlier pass (e.g. a minted sibling
  scope id for two-phase idempotency) survives an omitted one on retry. Contract-suite coverage on
  both adapters: list-pending → settle-done → drops from pending with its result recorded, and a
  transient `pending` retry preserves the two-phase result.

  No cross-deployment execution yet — the `VerticalClient` `/internal/platform-requests` transport,
  the kind→handler drain engine, `provision-sibling`, and the sweep wiring are Phase B2 (#358). The
  key constraint driving that split: the control plane can't read a vertical's scope DO directly
  (different deployments — the reason the CP sweep runs `drainRetries: false`), so B2 drains over the
  vertical's `/internal/*` HTTP surface, exactly like Data-tab introspection.

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.30.0

### Minor Changes

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

### Patch Changes

- 91a60e2: Defer foreign keys across the restore's DROPs, not just its inserts (#348, follow-up to #339).

  #339 wrapped the INSERT phase of a scope restore in `defer_foreign_keys`, so a dump whose
  child table sorts before its parent replays cleanly. It left the opening DROP sweep outside
  the deferral.

  `DROP TABLE` performs an implicit `DELETE FROM`, so dropping a parent while a child table
  still holds rows raises `FOREIGN KEY constraint failed` before any replacement row exists.
  That bites only when the TARGET already holds data, which is why it hid behind the first
  fix: an empty scope drops cleanly, and overwriting populated data is the whole point of
  restore. In the field it made `substrat scope restore` fail against any scope already
  holding FK-related rows, with the same bare constraint error #339 was believed to have
  fixed.

  The whole drop-then-replay now runs in one transaction with `defer_foreign_keys` set before
  the first DROP, so every check lands at commit — by which point the old rows are gone and
  the new ones are in. Both adapters; they are in the same fixed version group, so both move
  together.

  The regression test creates the PARENT first and restores twice, because `sqlite_master`
  lists tables in creation order and a child-first dump drops child-first, never tripping the
  hazard. It was verified to fail with the drop-deferral removed and the insert-deferral left
  in place.

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.29.0

### Patch Changes

- c64bdf8: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0

## 0.28.0

### Patch Changes

- d696b78: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0

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

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

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

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

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

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

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

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

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

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.21.0

### Minor Changes

- 3354e26: Restores heal their own permission model: `CloudflareScopeHost.projectRolesLocal`
  re-applies a vertical's code-defined role definitions to one scope (scope-level
  tuples untouched), and `VerticalClient.restoreScope` now carries `tenantId` so a
  vertical's `/internal/restore` can invoke it after the import. A dump captured from
  a CP-full world carries tuples but an empty roles table — without the repair, every
  check denies while /me still names the role.

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.20.0

### Minor Changes

- a39a024: Backup restore / backout (§8's write half): `ScopeHost.restoreScope` loads a
  `ScopeDump` into an EXISTING scope in place (drop-then-replay, migration frontier
  included) — audited as `restoreScope`, refusing unknown scopes. Threaded end to end:
  `restoreScopeLocal` on the Cloudflare host, `/internal/restore` on the vertical
  surface (VerticalClient + the Manyfold reference worker), a staff-only
  `POST /tenants/:tenantId/scopes/:scopeId/restore` control-plane route that delegates
  to the bound version's deployment, and `substrat scope restore <scopeId> --file
<backup>` — accepting a `scope pull` .sqlite, a local adapter-sqlite scope file, or
  a .dump.json.

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.19.0

### Minor Changes

- 83aa7fd: feat: `definePlatformSweeperDO` — the Cloudflare trigger for `runPlatformSweep` (scheduler.md §3.0, the last blocker on the Scrive poll path, #96)

  A singleton Durable Object whose `alarm()` runs one platform-sweep pass and re-arms itself only
  after the pass settles — the workerd analogue of the kernel's `startPlatformSweeper`, with the
  same non-overlap guarantee (a concurrent kick joins the in-flight pass; the next alarm is a gap
  after settle, never a fixed rate; a pass that sinks whole is reported and the loop re-arms). An
  alarm rather than a cron because a hosted vertical is pushed into a Workers-for-Platforms
  dispatch namespace, where `triggers.crons` is not honoured — the alarm self-arms from code
  (`ensureArmed()`, idempotent) and needs no wrangler config; where a cron IS available, point
  `scheduled()` at `ensureArmed()` as the safety net. Exercised end to end in workerd: a real
  alarm drives the real `runPlatformSweep` against live SCOPE/CONTROL_PLANE Durable Objects.

  The Scrive connector's README now points its "schedule the poll" caveat at both shipped
  triggers (node interval / workerd alarm) and names the one remaining deployment gap: a
  control-plane-less vertical has no connection directory to enumerate, so its sweep waits on
  connections becoming reachable from the vertical's runtime.

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.18.0

### Minor Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.17.0

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

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

### Patch Changes

- b2ab362: The kernel and directory DDL now go through `splitSqlStatements` instead of a naive
  `split(';')` (#164). A `;` inside a `--` or `/* */` comment in `KERNEL_DDL` truncated the
  surrounding `CREATE TABLE` and every scope failed closed at DO construction with
  "SQL code did not contain a statement" — while passing locally on SQLite, whose `exec`
  takes the whole blob. The SQL-aware splitter already existed in the same file and was
  already used for migration blobs; the DDL paths (ScopeDO's `KERNEL_DDL`, ControlPlaneDO's
  `DIRECTORY_DDL` — the last two raw `.split(';')` on SQL in source) just didn't use it.

  Both DDL blobs now open with a comment deliberately containing a `;`, mirroring the
  contract-tests migration tripwire, so a regression to naive splitting fails every
  provisioning test immediately rather than waiting for the next unlucky DDL edit.

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

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

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

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

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.13.0

### Minor Changes

- fa0707c: **Member invites (Phase 2) — the post-setup join path.** Once a workspace is set up it's
  invite-only; this adds the flow that lets teammates in:

  - **IdentityDO** gains an `invite` directory (token _hash_ only) + `createInvite` /
    `listInvites` / `inviteExists` / `revokeInvite` / `claimInvite`. Claiming binds the
    invitee's subject to a pre-minted member principal.
  - **`CloudflareScopeHost.assignScopeRole(scopeId, principal, roleKey)`** — the member half
    of `provisionScopeLocal`'s owner grant: grant a principal a role at scope level so its
    permissions resolve from the scope's own storage (covered by two new workerd tests).
  - **Meridian**: admin-only `POST/GET /api/invites` (+ `…/revoke`) mint/list invites (role
    granted at creation, one-time accept link returned, plaintext token never stored);
    `POST /api/accept-invite` claims one while signed in; the sign-up gate also opens for a
    valid `?invite=` token. SPA: an admin **Access** tab (invite at a role, copy the link,
    revoke) and an **AcceptInvite** screen driven by `?invite=<token>`.

  Roles a teammate can be invited at are this vertical's roles (hr-admin | manager | payroll);
  employees (HR records) remain separate.

- 74c9d7b: Add `unassignRole` and `unlinkIdentity` to the `HostAdmin` surface — the inverses of `assignRole` and `linkIdentity`, so authority granted through the kernel can also be taken back.

  - `unassignRole(actor, assignment)` revokes a role assignment by tombstoning the role tuple (K-21): the checker stops resolving it, the tuple stays as audit evidence, and a later `assignRole` of the same `(principal, role, node)` reactivates it. Idempotent.
  - `unlinkIdentity(actor, tenantId, principal)` severs a principal's login from a tenant — keyed by principal (so the caller needs no external subject) and a DELETE rather than a tombstone, so `listIdentityTenants`/`resolveIdentity` stop returning it and a re-invite can re-link a fresh principal.

  Both are implemented in the SQLite and Cloudflare adapters (with a generic tenant/scope tuple revoke on the Cloudflare DOs) and add matching `adminAction` log entries. Together they unblock self-serve member removal: cut a member's access and drop the team from their surface.

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

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

- aa786b7: **Scope-local permissions, Phase 1 — the ScopeDO can evaluate permissions from its own storage (docs/architecture/scope-local-permissions.md).**

  The read side of taking the shared control-plane DO off the request hot path. Behaviour-preserving on its own: a scope's `permission_source` defaults to `control-plane`, so the existing RPC path is used unchanged — this only makes the local path _possible_, for Phase 2 to activate.

  - **`createLocalControlPlaneReader(sql)`** (`checker.ts`) — a `ControlPlaneReader` backed by two new ScopeDO tables (`_substrat_tenant_tuples`, `_substrat_roles`) instead of an RPC to the singleton directory. Returns the same rows the RPC reader does (the checker's `live()` filter still drops tombstoned/expired); an empty projection yields `[]` / `undefined`, i.e. **deny — fail closed**. A tombstoned role definition reads as absent.
  - **The checker's reader is chosen per call** — `local` once a scope is projected (or whenever there is no `CONTROL_PLANE` binding to read, for a CP-less vertical), else RPC. Reading the marker is a cheap local indexed lookup; the source can flip at runtime.
  - **Projection write primitives** on the ScopeDO — `projectRole`, `revokeProjectedRole`, `projectTenantTuple`, `setPermissionSource` — the surface the coordinator's fan-out will call in Phase 2.
  - **`CONTROL_PLANE` is now optional** on the ScopeDO env (a projected / CP-less scope needs no binding).

  Verified: the full adapter permission + scope-host contract suites pass **unchanged** (RPC parity), plus new tests proving the local reader is parity with RPC, that a tombstoned projection stops granting (K-21), and that flipping a scope to `local` with nothing projected **denies even where RPC would allow** (the load-bearing fail-closed property).

- d83f521: **Scope-local permissions, Phase 2 — projection on write (docs/architecture/scope-local-permissions.md).**

  The write side that activates Phase 1's local reader: the coordinator projects a tenant's roles + tenant-level tuples INTO its scopes, so they evaluate permissions from their own storage and the shared control-plane DO leaves the request hot path. Behind a **default-off** flag, so behaviour is unchanged until a deployment opts in.

  - **`CloudflareScopeHostOptions.scopeLocalPermissions`** (default `false`). On: every tenant-level write **fans out** the tenant's current role/tuple state into all its scopes, and a newly-provisioned scope is projected + flipped to local from the start.
  - **Fan-out is a full re-sync** (`applyProjection` replaces a scope's projected set), hooked after every tenant-level mutation — `defineRole`, tenant `assignRole`/`grant`/`grantToOrg`, `addMember`/`removeMember`. Uniform, so it cannot miss a mutation type; a scope-level assignment/grant/entity write stays a local scope tuple and needs no fan-out.
  - **`reconcileTenantProjection(tenantId)`** — the reconciliation sweep + the back-fill for scopes provisioned before the flag was on. Idempotent full replace, safe on a schedule or on demand; the backstop for any dropped fan-out (a revoke that didn't propagate).
  - **`ControlPlaneDO.dumpTenantTuples`** — reads a tenant's full tuple set (incl tombstones) for the projection.

  Consistency: scope-level grants stay synchronous + immediately consistent; only tenant-level changes are eventually consistent across a tenant's scopes (bounded by the fan-out + sweep) — the trade the RFC makes (role changes are rare, requests constant).

  Verified: the RPC permission + scope-host contract suites pass **unchanged** (flag off), plus new fan-out tests — a tenant role reaching scopes that existed _before_ it was assigned, scope-role confinement, org-membership + org-grant fan-out, a membership tombstone fanning out to deny, and `reconcileTenantProjection` repairing a deliberately-drifted scope.

- 0ae7d0f: **Scope-local permissions, Phase 3a — a control-plane-optional host (the CP-less vertical enabler).**

  The reusable capability behind an untrusted / scope-local vertical (docs/architecture/scope-local-permissions.md): a `CloudflareScopeHost` that runs with **no control plane at all**.

  - **`CloudflareScopeHostOptions.controlPlane` is now optional.** Absent, the host uses a **null-object control plane**: the hot path a served scope actually touches becomes trust-the-upstream — `validateScopeAccess` / `setMigrationState` no-op (the router already gated lifecycle + tenancy from the shared directory), `tenantHoldsEntitlement` returns `true` (the SKU was enforced on the shared plane at provision, so a scope that exists here was granted it), and audit no-ops (the shared plane owns the spine). Every other directory method throws — that surface genuinely is unavailable.
  - **`provisionScopeLocal(...)`** — the entry a CP-less vertical's `/internal/provision` calls: migrate the scope's modules, project the vertical's role definitions locally, grant the owner a role at scope level, and evaluate permissions from the scope's own storage. No tenant-level tuples, no control plane.

  Verified: the RPC + fan-out suites pass unchanged, plus new tests — a CP-less host serving an owner's permission from the scope alone (no control plane, entitlement trusted), denying a stranger (fail closed), and the admin directory surface throwing a clear "control plane unavailable".

  Phase 3b makes Callout the first vertical to run on this — dropping its `CONTROL_PLANE` bindings, trusting the router-asserted node, and deploying into the WfP dispatch namespace.

- 518ea07: **Deleting an app reclaims its slug + hostname.** A failed or deleted app used to strand
  its scope slug and hostname forever — no way to reuse the name.

  - **A deleted app is now ARCHIVED, not suspended** (`deprovisionApp`): archive is the
    terminal delete state — offline (`getScope` fails closed), record retained (audit), and
    it _releases_ the name (suspend is reversible, so it keeps it).
  - **`archiveScope` is allowed from `provisioning`** (both adapters), so a scope whose
    provisioning never completed (a failed create) can be abandoned instead of stranding
    its name.
  - **Slug + hostname uniqueness ignore `archived` scopes** — the scope-slug check excludes
    archived scopes, and `bindHostname` reclaims a hostname whose holder is archived. So
    delete → recreate with the same name works, at the same `<name>.<jur>.substrat.run`.

  Verified: adapter suites (146) + dashboard suites (11) pass, including a new assertion
  that after deleting an app, a new one takes the same slug _and_ the same clean hostname.

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

## 0.11.0

### Minor Changes

- 7e17b16: **Connector state, and idempotent dispatch — the Scrive connector no longer duplicates
  documents on retry.**

  The connector took an injected `onDispatched` callback because it had nowhere to record what
  it had done. Delivery is at-least-once, so a redelivery created a _second_ Scrive document —
  duplicate legal paperwork to real signatories.

  The obvious fix — write the dispatch record into the scope — **deadlocks**, confirmed with a
  spike: a connector runs inside the scope's post-commit dispatch, and re-entering the scope
  actor from there waits on the task that is waiting for it. So the ledger lives in the
  **directory**, which a connector reaches through `ctx.admin` without touching the scope:

  ```ts
  HostAdmin.putConnectorState(connectionId, key, value);
  HostAdmin.getConnectorState(connectionId, key);
  ```

  Arbitrary JSON, keyed by `(connection, key)`, in a new `_substrat_connector_state` directory
  table on both adapters. Not audited — high-frequency machine state, one write per dispatch, the
  same class as `recordConnectionUse`. It dies with the connection: revoke cascades.

  The connector now checks the ledger before creating a document and skips if a prior dispatch is
  recorded, then records the dispatch after `start`. `onDispatched` is gone. A narrow residual
  window remains (ledger write fails after `start` succeeds → the retry still duplicates),
  closable with provider-side dedup via the `substrat_instance` tag the connector now sets.

  `getConnectorScope` (from #108) is deliberately unused here: recording a _signature_ back into
  the scope is the poll driver's job, where it runs as a top-level operation and re-entry is
  safe. Dispatch idempotency is not a scope write and must not be one.

  Contract tests on both adapters cover the state round-trip, upsert, and revoke-cascade; the
  connector's own suite proves a recorded dispatch is skipped rather than repeated.

- e4db6ed: **`HostAdmin.listConnectorState` — the read a poll driver needs to find its own outstanding work.**

  `getConnectorState(id, key)` answers "did I already do THIS one" from a deterministic key — the
  dispatch-idempotency path. It cannot answer "what is still outstanding", because a poller does
  not know the keys up front:

  ```ts
  listConnectorState(id: ConnectionId, prefix?: string): Promise<{ key: string; value: unknown }[]>
  ```

  Returns every state row for a connection, optionally narrowed to keys under `prefix`, ordered by
  key. A connector records one row per dispatch under `<provider>:dispatch:<id>`, and a scheduled
  sweep enumerates them (`prefix = '<provider>:dispatch:'`) to reconcile each against the provider.
  Without this a sweep would have to be handed every id it might reconcile, which defeats the point
  of a sweep.

  A directory-local machine read, the same class as `getConnectorState` — not audited. Implemented
  on both adapters (sqlite in-process; Cloudflare on the control-plane DO, prefix filtered
  coordinator-side to avoid LIKE/GLOB escaping); the contract-test suite covers prefix narrowing,
  ordering, the empty-match case, and per-connection isolation, so both adapters are held to the
  same behaviour.

  This is the enumeration half of the Scrive connector's poll path (#96): `drainDue` and the new
  `sweepScriveReconciliations` both still need a _timer_ to call them, which remains a deployment
  concern (no cron/alarm exists yet).

### Patch Changes

- a277bb7: **Fix: a migration whose comment or string literal contains a semicolon no longer fails only on
  Durable Objects.**

  The two scope-host adapters applied module migrations differently, and that divergence was a
  latent trap:

  - the **SQLite** adapter hands the whole migration blob to better-sqlite3's `exec`, which parses
    comments, string literals, and multiple statements correctly;
  - the **Cloudflare** adapter ran `migration.sql.split(';')` and `exec`'d each fragment — a naive
    split that truncates a statement the moment a `;` appears inside a `--` / `/* */` comment or a
    string literal. SQLite then reports `incomplete input`.

  So a migration could be **green on every node test and CI run, then fail only on `workerd`** in
  production. (Found porting Meridian to Cloudflare: an `hr_absence_ledger` column comment read
  `-- signed decimal days; balance = SUM(delta)` and broke `CREATE TABLE`.)

  The fix replaces the naive split with `splitSqlStatements` — a small SQL-aware scanner that skips
  line and block comments, copies string literals through verbatim (including the `''` escape), and
  splits only on a top-level `;`. Comments are dropped from emitted statements, so a trailing
  comment can never become a comment-only fragment that `exec` rejects either.

  To make the class of bug unmissable and keep the adapters from diverging again, the shared
  contract-test module `testMod`'s migration now deliberately contains all the hard cases — a `;` in
  a line comment, in a block comment, and in a string-literal `DEFAULT`, plus a second statement.
  Every suite that provisions a scope therefore exercises it on **both** adapters; a naive splitter
  fails provisioning outright. `splitSqlStatements` also has direct unit coverage of each edge case.

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

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

- 3fb38da: **`registerConnector` — an executor that also gets a credential and sanctioned egress.**

  The existing `ExecutorHandler` receives only `HostAdmin`, which is right for the one executor
  that exists (a directory write) and insufficient for anything that talks to a provider: no
  per-tenant credential, and no way to make an HTTP call that the platform can police.

  ```ts
  registerConnector(id, eventType, handler, options?)

  interface ConnectorContext {
    admin; tenantId; scopeId; vertical;
    connection(provider): Promise<ConnectorConnection>;   // opened credential + bound fetch
  }
  ```

  **Tenant and vertical are ambient**, taken from the event's scope rather than passed in, so a
  connector cannot reach a credential another vertical connected even by accident.

  **`fetch` is bound to the connection, not to the context.** Health has to land on the right
  row by construction; an ambient `ctx.fetch` would make the runtime guess which connection a
  call belonged to, and it would guess wrong the first time a connector talked to two. The
  handler is _given_ its fetch rather than importing one — the same move `ctx.sql` makes for
  module code, and for the same reason: timeouts, egress policy and health become properties of
  the seam instead of conventions an author has to remember.

  Kept as a second registration rather than widening `ExecutorHandler`: a membership executor
  should not be handed the machinery to call the internet. Both ride the same hardened dispatch,
  journal and retry policy from #100.

  Hosts take an optional `fetch`, so a provider can be stood up in memory. That is the only way
  to exercise a connector end to end before vendor credentials exist, and it stays useful
  afterwards because a real provider will not return 503 on demand.

  Three new contract tests across both adapters: a connector receives its tenant's credential and
  records health on success; a provider error is recorded on the connection; and a tenant with
  the SKU but no connection fails the delivery visibly rather than silently doing nothing.

- 2becfd5: **Executor deliveries retry, back off, and dead-letter instead of escaping the operation.**

  `ExecutorHandler` is the only outbound seam in the system. That was fine while the only
  executor wrote to the local directory; it stops being fine the moment one makes an HTTP
  call, which is the most likely thing in the system to fail transiently.

  Three specific defects, all fixed:

  - **A throwing handler escaped `invoke()` after the transaction committed.** The caller
    was told their work failed when it had not. A delivery failure and an operation failure
    are different facts, and only the second belongs in the caller's result.
  - **A poison event wedged the queue permanently.** The scan is `ORDER BY o.id`, so the
    failing event was re-selected first on every drain and executor _N+1_ never ran while
    _N_ threw.
  - **Nothing retried on its own.** With no timer anywhere, a failed delivery was retried
    only if someone happened to invoke another operation on that same scope — and nothing
    reported that it hadn't.

  New surface:

  ```ts
  registerExecutor(id, eventType, handler, retry?: ExecutorRetryPolicy)
  drainDue(tenantId, scopeId): Promise<ExecutorDrainReport>
  executorDeadLetters(tenantId, scopeId): Promise<ExecutorDeadLetter[]>
  ```

  Retry policy is **per executor** rather than a host constant: the defaults suit a
  directory write, and a connector making an outbound call wants a longer tail.
  `_substrat_deliveries` gains `attempts` and `next_attempt_at`, added by `ALTER` on both
  adapters — the defaults read as "terminal", which is correct for every row already there.
  Consumer dispatch is untouched.

  Behavioural change worth noting: an operation can now report success while its external
  effect has not happened yet. That is the correct semantics for an outbox, and it is what
  the path was already doing silently — the difference is that failures are now recorded,
  retried, and readable instead of being thrown at whoever held the request.

  Prerequisite for the integrations hub ([`docs/architecture/connections.md`](../../docs/architecture/connections.md)).
  Scheduling `drainDue` from a cron trigger or Durable Object alarm is not included here.

### Patch Changes

- d881f75: **Correct the Scrive connector against the real API, and widen the connector fetch body.**

  The connector was written from Scrive's docs. Driving the full lifecycle against
  `api-testbed.scrive.com` exposed three things the docs left ambiguous and the docs-reading got
  wrong — exactly the "a mock encodes the author's reading of the docs" caveat cashing out:

  - **Auth is OAuth1 PLAINTEXT, not OAuth2 bearer.** The Scrive UI's "Client credentials" and
    "Token credentials" are two halves of one four-part signature, not two schemes. The
    connection secret shape becomes `{ clientId, clientSecret, tokenId, tokenSecret }`.
  - **`POST /documents/new` returns no top-level `status`** — only `get` does. The connector now
    parses mutation responses for their id and reads status from `get`, which is the right design
    regardless (don't trust a mutation's echo).
  - **`setfile` is `multipart/form-data`**, not a base64 body.

  The kernel change: `ConnectorRequestInit.body` accepts `Uint8Array` as well as `string`, because
  a real upload is binary and a string body corrupts the file. Web `fetch` accepts both, so the
  adapters pass it straight through.

  `ScriveMock` is updated to the real request encodings (OAuth1 header, form-encoded `update`,
  multipart `setfile`, exactly-one-author) so it fails a connector regression rather than passing
  a shape the real API rejects. A new opt-in `test/live.test.ts` drives the real lifecycle when
  testbed credentials are present and skips otherwise, so CI stays offline while a local run
  verifies against reality.

  Still incomplete: the write-back (needs `getConnectorScope`, now available on `HostAdmin`) and a
  poll driver. And `se_bankid`-to-sign is disabled on the testbed account, so the BankID
  round-trip is unverified.

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.9.0

### Minor Changes

- 27872cc: Scopes are provisioned as `provisioning` and activated on confirmation (K-31).

  `provisionScope` wrote the directory row as `active`, so the row claimed a usable
  scope before anything had built one — and only the vertical can build one, because the
  DO class bundles the modules and lives in the vertical's deployment. The `provisioning`
  state existed in the enum for exactly this and was unused.

  `HostAdmin.activateScope` moves `provisioning → active`, through the same transition
  graph the other lifecycle moves use, so it is audited and cannot revive a suspended
  scope. `getScope` refuses anything not active, so an unconfirmed row is inert rather
  than misleading.

  `ControlPlaneClient.activateScope` is the push-mode equivalent, and the control-plane
  API gains `POST /tenants/:t/scopes/:s/activate`.

  Migrations are still attempted for a `provisioning` scope before it is refused, so the
  lazy retry and its attempt counter survive — they are the only self-healing there is
  until the reconciliation sweep exists. A scope held back by a failed migration now
  reports the migration error rather than a bare "not active".

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.8.0

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

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

### Patch Changes

- ad89a9d: Fix: the router built one Durable Object stub and reused it across requests.

  A DO stub is an I/O object owned by the request that created it, so reusing one
  throws `Cannot perform I/O on behalf of a different request`. The first request after
  each cold start succeeded and every request after it returned 1101 — which is why
  nothing caught it before production: every test sent a single request.

  `createRouteResolver` now creates the stub inside the returned closure, per call, and
  the router no longer memoises the resolver. Only the namespace binding may be held
  across requests; nothing derived from one may be.

  `CloudflareScopeHost` has the same shape and is safe only because every worker
  rebuilds it per request. That requirement is now stated on the constructor.

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.6.0

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.5.0

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

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

## 0.2.1

### Patch Changes

- db77d8c: `HostAdmin` is now asynchronous

  Every `HostAdmin` method returns a `Promise` — writes (`createTenant`,
  `setTenantStatus`, the scope-lifecycle transitions, `defineRole`/`assignRole`/
  `grant`/`grantToOrg`/`addMember`, `grantEntitlement`/`revokeEntitlement`,
  `linkIdentity`) and reads (`getTenant`, `listTenants`, `listEntitlements`,
  `auditLog`, `resolveIdentity`) alike. `registerModule`/`defineOperation` stay
  synchronous (code-time bookkeeping); `getScope`/`provisionScope` were already async.

  Why: the pure adapter's synchronous admin worked only because it is in-process.
  The Cloudflare adapter (D-14) proved a durable/remote control plane — a Durable
  Object — cannot be synchronous, so the second adapter forced the interface to
  evolve. This is the two-adapter discipline doing its job. Callers now `await`
  admin calls; adapter-sqlite's methods present their synchronous SQLite work as
  Promises. Behavior, error messages, and every contract assertion are unchanged.

- ffe3be1: Cloudflare adapter: durable control plane

  The coordinator's directory is now durable. `ControlPlaneDO` grew from the two-table
  checker slice into the full directory — tenants, scopes, entitlements, the admin
  audit log, identities, roles, and tenant-level tuples all in its SQLite (DDL and
  error messages ported verbatim from the pure adapter). `CloudflareScopeHost` is now
  a thin async router: it dropped the six in-memory directory maps and the
  enqueue/drain machinery, and `await`s RPCs to the DO for every admin mutation,
  lifecycle check, and read. It keeps only code-time registration bookkeeping in
  memory and still routes scope-level tuples to the owning ScopeDO. The control plane
  now survives a coordinator restart — the prerequisite for a stateless production
  Worker. Both contract suites stay green (CF 43+1 skip, adapter-sqlite 50).

- 4ba235e: Cloudflare Durable-Object adapter — milestone 1: contract suites green in workerd

  The second adapter (D-14) now runs the **shared** contract suites against **real
  Durable Objects** in workerd. One scope = one SQLite-backed `ScopeDO`; operations
  run inside `ctx.storage.transaction(async …)` (the DO analogue of the pure
  adapter's `BEGIN IMMEDIATE … COMMIT/ROLLBACK`), with per-scope serialization,
  lazy migrations-on-wake, guards, entity links, and the outbox→consumer dispatch
  loop. `scopeHostContractSuite` + `permissionContractSuite` pass unchanged (43
  pass, 1 skip); the pure-SQLite adapter stays green.

  - **contract-tests**: handlers extracted into an importable `modules.ts` so a DO
    can bundle them (a DO cannot execute closures created in another isolate);
    assertions unchanged. New `supportsRuntimeRegistration` capability flag — the
    one dynamic-late-registration test is skipped on adapters whose module set is
    code-time (CF), since a deployed DO bundle cannot gain code at runtime.
  - **kernel**: `ulid()` is now **monotonic** within a process (ULID spec's
    monotonic factory) — two ids minted in the same millisecond sort in creation
    order, making the audit log's and outbox's "ULID order is chronological"
    invariant actually hold. Fixes a latent same-millisecond ordering flake.

  Milestone-1 limitation, deliberately scoped: `HostAdmin` is a **synchronous**
  interface, which cannot be backed by an async Durable Object — so the coordinator
  holds the directory (tenants/scopes/entitlements/audit/identities/roles) in
  memory and forwards only the cross-DO subset (roles + tenant tuples) to a
  `ControlPlaneDO`. Making the control plane durable needs an async admin surface —
  a contract evolution the second adapter surfaced (exactly what D-14 is for), and
  the next step before deploying a real vertical.

- Updated dependencies [db77d8c]
- Updated dependencies [4ba235e]
- Updated dependencies [d929987]
- Updated dependencies [f717014]
- Updated dependencies [6393a8e]
- Updated dependencies [2dd4175]
  - @substrat-run/kernel@0.2.1
  - @substrat-run/contracts@0.2.1
