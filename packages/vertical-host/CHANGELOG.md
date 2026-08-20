# @substrat-run/vertical-host

## 0.79.0

### Minor Changes

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

### Patch Changes

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

### Minor Changes

- e3c3e2b: `mountOperations` answers a refused permission with 403, and hands the vertical
  the seam it was missing.

  Every failure the derived mount could produce came back as `500 Internal Server
Error`. A permission denial — the most common non-success outcome in a
  permissioned system, and one the kernel raises as a typed `PermissionDenied` —
  was indistinguishable from a crash, and so was an input that failed to parse
  (#791). Only the success case was right.

  The failure is worse than a wrong number: a client that reads `ok` off every
  reply cannot find it on a raw result at 200 either, so it falls back to
  `res.ok` — true — and renders empty screens successfully, on every endpoint, with
  no error anywhere.

  **The kernel's own vocabulary is now mapped, and nothing else is.** A refused
  permission is 403, a `ZodError` is 400, a body that is not JSON is 400, an
  `HTTPException` keeps the status it already chose (so `resolveStub` refusing an
  anonymous call is still 401), and a Durable Object / runtime fault is 502 (#559).
  Anything else is **re-thrown untouched**, so a vertical's own `app.onError` still
  receives its own domain errors exactly as before and keeps mapping them.

  What is mapped is re-thrown as an `HTTPException`, not answered directly: this
  decides the _status_, and an app that owns an error envelope goes on owning the
  _body_. `mountPlatformSurface`'s handler already reads the status and wraps the
  message, so a worker mounting both surfaces gets one envelope at the right code.

  **Two new options for a vertical that wants the shape too.** `respond(c, result,
operation)` decides the success response — the mount had already decided that
  much while leaving failures to the vertical, so an adopting vertical's envelope
  ended up defined in two places in two vocabularies. It is also the honest home
  for per-request work between the invoke and the response (stripping a field the
  caller may not see, relaying a credential, sending mail); the alternative
  verticals were reaching for is a `resolveStub` whose `invoke` returns an envelope
  instead of the operation's result, which makes `ScopeStub` a lie. `onError(c,
error, operation)` decides the failure response, and may return `undefined` to
  fall through to the mapping above.

  Both are optional and both default to today's behaviour, so the only change to an
  existing mount is that statuses stopped lying.

  The classification itself moved into one module shared with
  `mountPlatformSurface`, which has answered the same question since #510 — two
  surfaces on the same worker disagreeing about the same kernel errors was one
  vocabulary too many. It is exported as `classifyError` for a vertical that wants
  to reuse it in a handler of its own.

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.75.0

### Minor Changes

- 20818ce: `mountOperations` types the values a URL carries, and refuses a route that can
  never be reached.

  Two things a hand-written route table did for free, found by a vertical with 195
  declared routes that could not switch to the derived mount without them (#785).

  **A query string carries no types.** `?limit=100` arrived as the string `'100'`,
  so an operation declaring `limit: z.number().int().optional()` rejected its own
  endpoint with "expected number, received string". That is the most common read
  shape there is — 29 of that vertical's 81 reads carry a paging `limit` — and the
  mount, not the model, is where the fix belongs. Declaring `z.coerce.number()`
  instead would make the transport's problem true everywhere else too: for the
  JSON body, for a direct `stub.invoke`, and for every test. `input` is the same
  Zod object the handler parses, and it has to stay transport-agnostic to be worth
  anything.

  So the mount reads the declared shape and coerces the fields whose declared type
  cannot be a string — `number`, `boolean`, `bigint`, looked through `optional`,
  `nullable`, `default`, `catch` and a pipe's input side. Path parameters get the
  same treatment, since `/pages/{page}` had the identical problem. Chosen over
  coercing by JSON grammar, which cannot tell `?q=123` the search term from
  `?q=123` the number without an encoding convention every caller has to honour.
  A value the declared type cannot accept passes through unchanged, so the error
  still names what the caller actually sent rather than "received nan".

  **Registration order decided routing by operation name.** Hono dispatches in
  registration order, and this registered in alphabetical order of the operation
  name — a name with no relationship to routing precedence. `support/get` sorts
  before `support/list-mine`, so a live `GET /support/issues/mine` disappeared
  behind `GET /support/issues/{id}`: no error, no warning, just an endpoint that
  silently belonged to its neighbour.

  Routes are now ordered by path specificity, segment by segment, static before
  parameter. That is not a house rule — it is the precedence OpenAPI already
  writes down for exactly this case, and it keeps a reserved word in an id slot
  working without renaming a live URL.

  What ordering cannot resolve now fails loudly: two operations that dispatch
  identically (same method, same path shape, different parameter names) throw at
  mount naming both, because there is no reading under which both are live.

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

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

### Patch Changes

- a16a3d4: fix(vertical-host,control-plane): a platform fault answers 502, and the control plane keeps its own logs (#559)

  The `/internal/*` error envelope defaulted every unrecognized throw to 400 — so a
  Cloudflare DO SQLite storage fault (`internal error; reference = <id>`) crossed the
  control plane's verbatim passthrough and reached CI dressed as "you sent a bad
  request", unresolvable by anyone but Cloudflare support and invisible to every
  retry convention that (correctly) refuses to retry a 4xx. The envelope now
  recognizes infrastructure-fault shapes — workerd's `retryable`/`overloaded` flags,
  the redacted DO SQLite message, DO resets — answers 502 with the message intact,
  and logs `vertical-host.platform-fault` structured so the vertical's observability
  keeps stage + reference queryable. App errors that merely mention "internal error"
  mid-sentence stay 400; explicit HTTPException statuses stay authoritative.

  The control-plane worker also gains `observability: enabled` (prod and env.test):
  its own `deploy.upload.failed` / `control-plane.unhandled` diagnostics previously
  existed only in a live `wrangler tail`.

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.53.0

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

- @substrat-run/contracts@0.48.1
- @substrat-run/kernel@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.47.0

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.46.0

### Minor Changes

- 54d3d0e: Add `@substrat-run/vertical-host` — the platform's `/internal/*` management contract
  (provision, reconcile, introspection, the read-only SQL console, platform-request drain,
  snapshot/delete/export/restore, bookmarks/rewind, configure) plus the guaranteed `{ error }`
  response envelope, authored once and mounted with `mountPlatformSurface(app, deps)`.

  Verticals no longer hand-copy these routes and a Hono `onError` into their own `worker.ts` —
  copies that had already drifted (route sets disagreed; some workers shipped without the error
  handler, so a failing `/internal/restore` reached the control plane as the runtime's bare
  `Internal Server Error` with no diagnosis, issue #510). Meridian, Manyfold and the
  `create-substrat` template now mount the shared surface; a repo-wide `hono` override pins a
  single version so the mounted `Hono` app type matches its consumers.

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
