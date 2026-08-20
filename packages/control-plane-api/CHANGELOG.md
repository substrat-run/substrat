# @substrat-run/control-plane-api

## 0.79.0

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
- Updated dependencies [87ec6f2]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/psl@0.2.2

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
- Updated dependencies [6ac51d1]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/psl@0.2.1

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

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

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

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

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

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.59.0

### Minor Changes

- eda5d01: feat: the dashboard Integrations page becomes real — tenant-scoped connection routes on the control plane, a Scrive connect flow in the app's Settings, and manifest `requires:` driving the "enabled but missing its settings" state

  The control plane grows a tenant-scoped connection surface (`GET/POST /tenants/:t/connections`,
  `DELETE /tenants/:t/connections/:id`) — the POST reuses the §3.5.2 relay's upsert semantics
  (create, or rotate the one live row in place so its grant tuples survive), behind platform-actor
  auth. This is the door the dashboard needed: its own directory holds its GitHub connections, but
  a provider credential a platform-run connector consumes (Scrive) must land in the shared plane's
  store — the one `connector:<provider>` dispatch actually opens.

  The dashboard's Settings → Integrations tab and the account-level Integrations page drop their
  demo fixtures: a vertical declares a provider in its manifest `requires:` (Meridian now declares
  `scrive`), the tab renders it connect-or-"required, not connected", and the connect dialog
  collects the provider's server-declared credential fields (Scrive's OAuth1 four-part), write-only.
  Authorization is the in-scope `dashboard/begin-connection` act (`dashboard:manage-integrations`);
  the credential rides one call to the store that seals it. A declared-but-unconnected provider
  never gates the app — a dispatch with no live connection settles pending and delivers once
  connected. Scrive connections are granted `protocol:record-signature` + `protocol:attach`, so
  both the signature write-back and the sealed-PDF landing work.

### Patch Changes

- 1fab6f7: fix: serve-in-place recovers missing asset bytes from the archive script — promoting an asset-carrying version works (closes #578)

  The byteless re-serve at promote bet on the runtime's asset store being deduped
  namespace-wide; it dedupes PER SCRIPT, so the stable serving script's upload
  session reported every hash missing that the push had just uploaded to the
  version's archive script — and every promote of an asset-carrying version 502'd
  at the "no bytes" guard, with a remedy (re-push) that could never reach the
  stable script's store. A vertical that adopted #340 native assets could never
  promote again.

  The fix is #578's option 1, symmetric with #286 module recovery: the archive
  script is the bundle store for assets exactly as for modules.

  - `uploadAssets` (wfp.ts) takes an optional `recoverContent` hook: when a bucket
    wants a hash the upload carries no bytes for, the bytes are fetched back on
    demand and verified against the manifest's content-address before uploading
    under it (D-44: what is trusted is the bytes; what is verified is the key) —
    the fetch is only paid when per-script dedupe actually misses.
  - `createControlPlaneApi` gains the host-injected `fetchVerticalAsset` seam (the
    asset twin of `fetchVerticalModules`); `serveVersionInPlace` binds it to the
    promoted version's archive ref.
  - The control-plane worker implements the seam over the `DISPATCH` binding —
    assets are served by the runtime's edge without invoking the worker, so a
    plain dispatch fetch of the path returns the bytes (redirects from
    `html_handling` followed by hand, against the same script).
  - The "no bytes" refusal now says what recovery attempted and keeps the re-push
    remedy only because it is now real: a fresh push mints a fresh archive script
    the next promote recovers from.
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

- 526dc1a: fix(control-plane-api): reap and fork-delete strand storage on a script that never implemented delete-scope, instead of pinning the row forever

  A scope bound to a script that answers 501 for `POST /internal/delete-scope`
  (the standalone-app shape — the retired auth-server lineage is the canonical
  case) could never be reaped: the vertical hop aborted every attempt, the scope
  sat `archived` forever, and the lineage's delete stayed refused. Those bytes
  are unreachable through every platform verb — export and delete alike — so
  once the backup contract has resolved (a copy landed, or `backup: false` was
  the explicit consent), the reap now strands them on the script (they die with
  it at orphan cleanup, #248 — the same stranded-not-deleted posture as rebind's
  `abandonData`) and tombstones the directory row, reporting
  `storageStranded: true`. A real failure from an implemented wipe (5xx, timeout)
  still aborts — 501 is the only shrug.

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

- b8bdb9d: fix(control-plane-api): drained provisioning targets the serving script, and a stuck intent gives up honestly (#570)

  The acme provision-tenant intent retried every sweep for six days (577 attempts)
  because the handler's two halves aimed at two different scripts: the tenant-store
  D1 binding was patched onto the vertical's stable SERVING script, while the
  provision call dispatched through the scope's pinned version to the per-version
  script — which has no store bindings, so the vertical refused "no tenant store
  attached" forever. A still-provisioning scope that lacks its serving pointer while
  its vertical serves in place is now stamped onto the serving script (serving ref +
  version pointer) before the client resolves, on both the provision-tenant and
  provision-sibling paths — safe exactly because such a scope has never activated,
  so there is no data to hop. The stranded acme scope converges on its next drain
  pass with no manual adopt-serving.

  And a structurally-stuck intent no longer pretends to be transient forever: at
  `MAX_PLATFORM_REQUEST_ATTEMPTS` (100 passes ≈ a day at sweep cadence) the drain
  settles it `failed` carrying its last real error — what the proposer's read
  actually surfaces — and lands a durable ops-failure row (#559) for the operator,
  instead of burning an attempt every 15 minutes visible only to someone reading
  `_substrat_platform_requests` by hand.

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.55.0

### Minor Changes

- 8cd5039: feat(dashboard,control-plane-api): builders see their own vertical's failure history (#559)

  `GET /ops-failures` opens to builders, tenant-narrowed by the forced-filter
  pattern (`GET /scopes` precedent): a builder reads only its own tenant's rows,
  platform-level rows (null tenant) stay staff-only, and staff keep the fleet
  view. The dashboard grows the pipe — a tenant-pinned `listOpsFailures` on the
  authority seam, `GET /api/deployments/:slug/failures` (owned-slug-checked, with
  an embedded-host fallback) — and a "Recent failures" panel on the vertical
  detail: when, operation · stage, status, message, and the upstream
  `reference = <id>` with a copy affordance. A red CI run is now explainable from
  the dashboard without staff involvement; a `reference` row says "platform
  fault, here is the Cloudflare support handle", not "your code broke".

### Patch Changes

- 512822b: fix(control-plane-api): the platform's own export→restore calls ride out a transient blip (#559)

  When the control plane talks to a vertical deployment on the caller's behalf —
  the preview fork's restore, the snapshot copy, a backup restore, adopt/rebind
  onto the serving script — a one-shot downstream 5xx (a DO storage blip) now
  heals on the same bounded backoff the install path already uses, instead of
  failing the request. Cheap at exactly these call sites: the dump is already in
  memory and the far end is drop-then-replay idempotent — unlike CI's blind
  retry, which burns a freshly pushed version per attempt. Honest refusals (4xx,
  and 501 = not implemented) still surface immediately, and a persistent fault
  still exhausts, answers honestly, and lands its ops-failure row.

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

### Minor Changes

- 9f28da1: feat(console): links into Cloudflare — find the right DO, database and bucket

  The console rendered every identifier an operator needs and never said where any of them
  resolves, so "which Durable Object is this scope?" ended in the dashboard's search box. Two
  reads close that:

  - `GET /platform/runtime` — the account and dispatch namespace the refs resolve in, injected
    by the host (`platformRuntime`) exactly like the observability reader. It carries **no
    credential**: it is the account the deployment already advertises in every dispatch URL.
    Unconfigured answers `null`, not 501 — a self-host control plane is a normal deployment,
    and the console degrades to plain identifiers rather than an error.
  - `GET /tenants/:t/stores` — the #301 and #473 ledgers as inventory. `listTenantStores` was
    documented as the console's read from the start and no route exposed it; on Cloudflare the
    `ref` IS the D1 database id and the R2 bucket name, so it is directly addressable.
  - `GET /platform/do-namespaces?script=…` — a scope's Durable Object namespace, by the id the
    dashboard addresses it with. Nothing in the platform record carries that id, so it is
    resolved through a host-injected reader (`createCfDoNamespaceReader`, TTL-cached, bounded
    page walk) and narrowed to the asked-for script server-side — an account-wide listing has
    no business crossing to a browser. 501 when unconfigured, because "I cannot look" and "that
    script defines none" are different answers.

  All staff-only (absent from `BUILDER_ROUTES`, so a builder 403s), read-only, and additive.

  Console side: tenant detail gains a **Stores** card and scope detail a **Cloudflare** card
  (serving script, Durable Object, the tenant stores for that scope's vertical). Link
  construction is one module with one rule — a link is built only from coordinates we actually
  hold, and anything missing renders as the plain id rather than a URL that lands somewhere
  arbitrary. The URL shapes are pinned in one table, verified against the dashboard, and
  covered by a test, so a Cloudflare reshuffle is a one-line fix.

  A Durable Object shows its NAME (the scope id verbatim — `SCOPE.idFromName(scopeId)`, the
  only handle a human can carry, since the hex object id is a hash) and links to the _namespace_
  it lives in, falling back to the namespace list when the lookup is unavailable. There is still
  no per-object page in the dashboard; this is as close as the provider allows.

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

- 0061325: chore(deps): one better-sqlite3, and it is 13.0.3

  The workspace had drifted onto three copies — `^13.0.3` in adapter-sqlite, `^13.0.2` in
  manyfold, `^12.0.0` in ten other packages — which is how `pnpm install` started failing.

  v13 changed its packaging: it **dropped its install script** and now ships prebuilt binaries
  for all eight platform targets inside the tarball, declaring `"gypfile": false`. It still
  ships a `binding.gyp`, and pnpm applies npm's legacy rule — _binding.gyp present + no install
  script ⇒ `node-gyp rebuild`_ — ignoring that opt-out. With `better-sqlite3` on the
  `onlyBuiltDependencies` allowlist, pnpm ran that phantom build and died wherever `node-gyp`
  isn't installed. CI images ship one, which is why it only bit locally.

  So the allowlist entry is now the bug rather than the fix: nothing in the tree needs
  compiling. Dropping `better-sqlite3` from `onlyBuiltDependencies` is the whole repair — the
  prebuilt binary is already on disk and `lib/binding.js` finds it.

  Two things had to move for that to be true everywhere:

  - **`overrides: { "better-sqlite3": "13.0.3" }`** — better-auth declares a `^12.0.0` peer, so
    pnpm was quietly resolving a _second_, duplicate v12 copy alongside ours. That copy needs a
    real build, and once better-sqlite3 left the allowlist it would have arrived with no binary
    at all on a fresh clone. The override collapses the tree to one version; a matching
    `peerDependencyRules.allowedVersions` records that v13 is deliberate, not unnoticed. All six
    better-auth packages pass on it.
  - **`create-substrat`** no longer scaffolds `onlyBuiltDependencies: ['better-sqlite3']`, which
    would have handed every new project the same failure.

  `@types/better-sqlite3` goes `^7.6.x` → `^9.6.0` to match. Requires Node >= 22, which CI
  (22 and 24) already satisfies.

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

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.49.0

### Minor Changes

- 00ff102: feat(observability): one merged log stream across a vertical's versions

  The log read seam narrows to a **set** of services (`services: string[]`) instead of one:
  a builder's unit of interest is a vertical, which serves from several deployed units at
  once (the stable serving script plus per-version archives). `GET /observability/logs`
  accepts a repeated `service` param (capped at 20 — one backend query each) and answers the
  services' events merged newest-first, capped at `limit` overall. A single `service` param
  behaves exactly as before, and no `service` at all is still the fleet view.

  Consumer-side: the dashboard's per-app Observability tab now shows logs under "All
  versions" — every version that served, merged, with a version chip per line — where it
  previously showed nothing until one version was picked. Unowned refs are still dropped by
  the tenant narrowing before the plane is asked, so a mixed set is a request, never a claim.

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

### Patch Changes

- 5ad59c5: fix(previews): mint clean-room preview hostnames under the jurisdiction base

  A clean-room (empty, source-less) preview — the shape behind a long-lived test
  environment — derived its `--<tag>` URL from `platformBaseDomains[0]`, which in
  production is the bare apex `substrat.run`. The wildcard DNS/cert lives on
  `*.global.substrat.run`, so the minted hostname
  (`crm-eff-<tenant>--test.substrat.run`) resolved to NXDOMAIN and the environment was
  unreachable. Mint under `<label>.<jurisdiction>.<baseDomain>` instead — exactly as
  provisioning does — so the URL lands on the wildcard. The regression was masked by a
  test configured with a single, already-jurisdiction-qualified base; the test now uses
  the production shape (bare apex first) and asserts the `.global.` segment is present.

- 9c7987b: fix(previews): a retried `preview create` re-forks, instead of adopting the empty leftover

  A preview only holds data once its two-phase create finished: the directory row lands first
  as `provisioning` (K-31), the fork's export→restore runs against the PR version's
  deployment, and `activateScope` is the **last** step. A create that died in the data copy
  therefore leaves a `provisioning` row over an empty DO.

  `orchestratedPreview` matched an existing preview on `(kind, slug)` alone, so the next
  create adopted that row and took the **reuse** branch — which rebinds the version, renews
  the TTL and binds the hostname, but never copies data. The preview came back
  `reused: true`, CI printed `✓ preview '<tag>' updated … against a fork of prod`, and the
  reviewer got a URL onto an empty database. The generated CI workflow retries
  `preview create` on a transient, so this was the _common_ path, not a corner: attempt 1
  forks and dies, attempt 2 adopts its corpse and goes green.

  Reuse now requires `status === 'active'`. A half-built leftover is reaped (DO bytes in its
  own deployment, then the directory row and its `--<tag>` hostname) and the create falls
  through to a fresh fork — which is what the retry was asking for. `refresh: true` takes the
  same path, fixing a second bug on the way: its fresh scope used to collide with the old
  row's still-bound hostname (`hostname '…' is already bound to another scope`).

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

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.46.0

### Minor Changes

- b94f735: feat(observability): richer per-app log detail — carry trigger/eventType/entrypoint/requestId/timing through the neutral seam, plus an expandable raw event

  The observability read seam (`RecentLogEvent`) now carries `trigger`, `eventType`,
  `entrypoint`, `requestId`, and CPU/wall timing alongside `message`/`level`, mapped from the
  Cloudflare backend in neutral vocabulary (no provider field names leak past the seam). The
  dashboard's per-app and per-vertical log panels render these inline — the trigger leads
  (e.g. `default.importDump`), with the message, `eventType · entrypoint`, outcome, CPU time,
  and request id — and a row expands to the full JSON event, the drill-down Cloudflare's own
  console gives.

  The tenant-narrowing wrapper now passes the backend `raw` event through for an **owned**
  service: the ownership gate already proved the service is this tenant's, so the event is its
  own telemetry, and that gate — not a trimmed field set — remains the boundary.

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

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.41.0

### Minor Changes

- e3cd3cd: Hostnames die with their scope. Deleting an app archived its scope but left
  every hostname row behind — the default mint lingered on the Domains page
  (App column showing a raw scope ULID), and the #423 heal pass would flip it
  back to `active` forever. Two-sided fix: the dashboard's `deprovisionApp` now
  unbinds ALL of the scope's hostnames (default mint, per-surface mints, custom
  domains — the CP DELETE releases a custom domain's Cloudflare object), and
  `reconcilePendingHostnames` opens with an orphan pass that unbinds any row —
  whatever its status — whose scope is `archiving`/`archived`/`reaped`, so
  existing orphans clear on the next sweep instead of needing a manual click.
  `HostnameReconcileAdmin` grows `listScopes` + `unbindHostname` (both already
  on `HostAdmin`), and the reconcile result reports `orphaned`.
- 1f51134: Per-app Observability tab (#471): the app detail page gains logs + metrics for
  the app's vertical, per deployed version, with level / message-search filters
  and a 1h/24h/72h window. The `ObservabilityReader` contract grows an optional
  `search` term (neutral substring-on-message capability — each backend maps it
  to its own query language; Cloudflare's reader files it as a telemetry-query
  filter), threaded through the plane's `/observability/logs` route. Isolation is
  unchanged in kind and now tested wider: "filtered by app" narrows the ownership
  map server-side (an unowned slug answers `[]` without the staff-wide query ever
  issuing), and builder log responses are projected to the neutral field set — a
  backend's `raw` payload never passes through the seam.
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

- 653a592: The bound-scope delete refusal reaches the caller. `deleteVertical` refuses
  while any scope is still bound, naming the count and the way out ("still backs
  N scope(s) — delete or rebind them first"), but `mapError` had no pattern for
  the message, so the console showed the generic 500 "internal error" instead —
  exactly the masking the route's own comment claimed could not happen. The
  message now maps to a 409 like the registry's other state conflicts.
- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.40.0

### Minor Changes

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

### Patch Changes

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

- 7781cc2: Cross-lineage rebind learns `abandonData` (#389): a directory-only flip for a scope whose
  source script predates the `/internal/export` surface (#236) and so cannot be dumped at
  all. No bytes are carried — the source script's copy stays intact as the backout, and the
  scope is re-provisioned on the target via the idempotent `/verticals/:slug/instances`.
  CLI: `substrat scope rebind --abandon-data`. Also: a vertical answering an `/internal/*`
  call with non-JSON (an old script's SPA fallback) now surfaces as an actionable 502
  instead of an unhandled parse error → opaque 500.
  - @substrat-run/contracts@0.37.1
  - @substrat-run/kernel@0.37.1

## 0.37.0

### Minor Changes

- 705b806: A scope can be rebound onto a DIFFERENT vertical lineage's serving script, data
  carried (#389) — the update-rebind behind retiring a platform-owned lineage in
  favour of a tenant-owned one (`manyfold` → `substrat-9yjbbn/manyfold`). Staff-only
  `POST /tenants/:t/scopes/:s/rebind-vertical` (a builder is 403'd by the allowlist's
  default-deny: a lineage crossing re-homes data under a different registry owner) and
  `substrat scope rebind <scopeId> --to <vertical>`. The same data-first shape as
  adopt-serving — export from the script that holds the data today, restore into the
  target's serving script, only then flip routing and cross the version pointer (which
  rewrites the scope's `vertical` in the same audited act). The one new gate: the two
  lineages' migration histories are independent, so the crossing is refused unless the
  scope's bound version and the target's serving version carry the same migration
  digest — or the operator passes `--ack-migrations` after reading both diffs. The
  source script's copy is never deleted; it is the backout.
- 8869413: The install is now a durable, inspectable operation (#424, the remaining half). The
  dashboard records each stage of an install — directory → provision → activate →
  hostname → identity — as a per-step row in the platform-request shape
  (status/attempts/last_error), written live as the install runs. The Apps view renders
  the step list on a provisioning card (polling while it runs) and, on a failed one, shows
  the step that died with the downstream error VERBATIM; Resume re-enters the same rows,
  bumping attempts, so a healed install reads `provision ✓ (2 attempts) → activate ✓`. A
  `provisioning` row whose directory scope is already `active` is reconciled on read
  (case 4's eternal spinner heals on the next page load). CLI parity: `substrat installs
<slug>` lists a workspace's installs with directory status + served hostname, and
  `substrat scope status <scopeId>` prints one scope's directory truth (status, bound
  version, serving script, role health) — backed by tenant-narrowed builder access to the
  directory read routes (`GET /scopes` forces the caller's tenant; per-scope reads hide a
  foreign tenant as 404).

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.36.1

### Patch Changes

- 3e939b9: Install failures now say what the vertical said (#424 cases 1+2). A non-JSON refusal
  body — the shape a foreign vertical or a runtime error page answers with — surfaces
  verbatim (truncated at 500 chars) instead of collapsing to "vertical refused
  provisioning: 503 Service Unavailable"; JSON `{error}` bodies pass through bare as
  before. And the install endpoint rides out transient 5xx answers from the vertical on a
  short backoff (the binding-attach → script-settings propagation race) instead of
  surfacing a one-shot failure — honest refusals (4xx, 501) still fail immediately.
  `provisionRetryDelaysMs` overrides the backoff for tests.
  - @substrat-run/contracts@0.36.1
  - @substrat-run/kernel@0.36.1

## 0.36.0

### Minor Changes

- 20343bb: One (bare slug, tenant context) → registry id resolution for every route that addresses
  a vertical (#417). Registry rows for pushed verticals are keyed `<tenantSlug>/<slug>`;
  a builder got the prefix from auth, but a staff/service caller — the CLI over a service
  token, the dashboard's tenant-narrowed seam — queried the bare slug and missed, so
  `substrat versions <slug> --tenant <t>` came back empty and the dashboard refused to
  install a workspace's own just-pushed private vertical.

  The control plane now reads the workspace a staff caller acts for from the same
  `x-substrat-tenant` header a builder session uses (exported as `TENANT_HEADER`), and
  `versions`/`channels`/`history`/`promote`/`publish-request`/`adopt-serving`/previews
  resolve the prefix exactly as a pinned push forms it — existence-guarded, so a pin never
  redirects to a lineage that is not there: a bare slug the workspace owns and a
  platform-owned bare slug stay addressable as themselves, and an unknown pin is a no-op.
  Config delivery's `verticalForScope` retries the prefixed id on its miss path too, so a
  scope bound to a bare spelling of a prefixed lineage still resolves.

  The CLI sends the tenant header with every auth kind (it was browser-session-only): a
  service token keeps its staff reach, and `--tenant` / `SUBSTRAT_TENANT` / the stored
  default now name the workspace for slug resolution.

### Patch Changes

- c8c0624: A dispatch/transport rejection on the vertical's `/internal/*` surface (a cold-starting
  script, a DO reset, a missing dispatch entry) now surfaces as a `ControlPlaneError` 502
  naming the verb and the runtime's own message — "vertical unreachable during configure:
  …" — instead of propagating raw and collapsing to the API boundary's generic 500
  "internal error" (#391). A non-ok response is unchanged: still the vertical's own
  status and message. Callers can treat the 502 as the transient it usually is; the
  dashboard's install step 3 now retries exactly this window.
  - @substrat-run/contracts@0.36.0
  - @substrat-run/kernel@0.36.0

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

### Patch Changes

- c200778: Custom-hostname failures now say what actually broke, and heal themselves. A 401/403
  from Cloudflare's custom-hostname API is a platform misconfiguration (the API token
  missing 'SSL and Certificates: Edit' on the SaaS zone), not the tenant's DNS — the
  provisioner's error now names the token so the note stored on the binding sends the
  operator to the right place instead of the tenant to their DNS provider. The reconcile
  sweep additionally retries `failed` rows that have no Cloudflare hostname id — a create
  that never landed (bad credential, transient error) now self-heals on the next pass
  once the cause is fixed, while `failed` rows _with_ an id (a real validation verdict)
  stay terminal for the sweep. Dashboard side (unpublished): the per-app Domains tab now
  renders the failure note, the DNS records to publish, and a per-row "Check again",
  and the add flows surface an immediately-failed issuance instead of a bare pill.
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

- 0b9220e: Refuse the silent lineage fork (#388). A first push of a registry id that doesn't exist yet, whose product name matches an existing lineage the push could confuse itself with (platform-owned, marketplace-listed, or the acting workspace's own), is now refused with the fix named — package.json `substrat.slug`/`substrat.tenant` decide where a push lands — instead of quietly creating a second same-named vertical whose pushes the existing installs never see. `substrat push --allow-fork` makes a deliberate second lineage explicit. Same-name-under-another-tenant stays allowed (each tenant's namespace is its own), and a builder is never told about a foreign private slug. The CLI also prints a pin-it hint while the slug is derived from the package name (a rename would fork the lineage, #399), and surfaces the control plane's refusal text directly instead of raw JSON.
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

### Patch Changes

- c0b3464: Make the lineage fork behind a silent config-delivery 501 self-diagnosing

  A `substrat push` publishes versions under the slug it derives from the project
  (`package.json` `name`, unless `substrat.slug` pins it), while installs/hostnames — and so
  a scope's `vertical` — carry the slug the app was installed under. When those diverge,
  `resolveVerticalVersion` filters a scope's bound version by the scope's slug and never
  finds it, so per-instance config delivery 501s and `substrat versions <slug>` returns
  nothing even though installs are serving. Diagnosing that took hours because nothing named
  the split.

  - **Control plane:** the config-delivery and reconcile 501s now return an actionable body
    that names the bound slug + version and the likely cause — a lineage fork (versions under
    a different slug), no pushed versions, or none promoted — instead of the bare
    "no deployment is bound". Computed only on the miss path.
  - **CLI:** `substrat versions <slug>` cross-checks installs (a slug with bound hostnames but
    zero versions prints a fork warning pointing at `package.json` `name` vs `substrat.slug`)
    and distinguishes "unknown slug" from "no versions". `substrat hostnames <slug>` prints the
    reverse warning when a slug has hostnames but no pushed versions.

  Diagnostics only — preventing the fork (consistent push/install identity) is tracked
  separately.

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

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

- 0d79662: Multi-scope Manyfold, D2: the platform can drain Manyfold's site-creation intents end-to-end.

  Wires the platform drain (Phases B2/C) to the vertical over its `/internal` surface, completing the
  loop from D1's `request-site` producer:

  - **Manyfold worker** exposes `GET /internal/platform-requests` and
    `POST /internal/platform-requests/settle` (platform-secret gated), backed by the CP-less
    `host.listPlatformRequests` / `settlePlatformRequest` (B1) — the scope's DO lives in the vertical's
    own deployment, so the platform pulls its intents from here. Plus `POST /api/sites`, which runs
    `manyfold/request-site` as the caller (its own `content:manage-sites` gate) and returns `202` + the
    request id, tagging the response with `x-substrat-platform-request` for the router kick (Phase D3).
  - **`VerticalClient.listPlatformRequests` / `settlePlatformRequest` now take `tenantId`** (the CP-less
    vertical host reads by `(tenantId, scopeId)`); `drainScopePlatformRequests` passes it from the
    drained scope's context. A small signature change to the just-added B2 methods, contained to the
    drain path.

  So a `request-site` intent is now picked up by the periodic sweep (C) and provisioned via
  `provision-sibling` (B2), appearing in the M2 site registry within a sweep cycle. The low-latency
  router kick and the "New site" UI are Phase D3. Refs #358.

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

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.30.0

### Minor Changes

- 49db0a1: Self-serve multi-scope, M1: add a sibling scope to an app the tenant already runs.

  New builder-reachable, tenant-narrowed `POST /tenants/:tenantId/scopes` route on the control
  plane. It authorizes by `parentScopeId` — the existing app scope must belong to the caller's
  tenant, which proves the entitlement — and the new scope INHERITS that app's vertical and
  jurisdiction, so a caller can never name a vertical it does not already run. It then runs the
  same provision → materialize-instance (K-31) → activate sequence `createApp` runs for an app's
  first scope. A builder is confined to its own tenant (foreign tenants read as 404, K-3
  existence-hiding); staff may target any tenant. No site-count quota is enforced yet — an open
  product question tracked in the design doc. The dashboard's `TenantNarrowedControlPlane` gains
  an `addSiblingScope` method over the new route.

  Also pins a regression (#355): `provisionScopeLocal` applies a scope's module migrations at
  provision time — own tables created and journaled before any first `getScope` — so a
  freshly-provisioned scope is never born content-less.

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

- 866c46d: Per-PR preview instances for private verticals (preview-and-snapshots.md §2/§9, D-43).

  Open a PR → a preview instance running the PR's pushed code against a **fork of the
  tenant's prod data**, on its own `<label>--pr-N.<base>` URL; close the PR → it's reaped
  (with a per-preview `expiresAt` as the GC backstop). Also drivable by hand from the CLI.

  - **control-plane-api**: `orchestratedPreview` + three builder-reachable routes —
    `POST/GET/DELETE /verticals/:slug/previews`. Create forks the source prod scope (the
    §9 cross-version path: export from where prod data lives → import into the PR version's
    deployment), binds the pushed version to the fork, and mints a non-canonical preview
    hostname; delete delegates to the existing fork-reap. Gated `global`-jurisdiction only
    (K-32) with the canonical audited export path. Private verticals only — a private
    push self-admits (D-36), so no admission relaxation is needed.
  - **cli**: `substrat preview create|delete|ls`. `create` pushes the working tree, then
    forks + binds; re-running the same `--tag` rebinds onto the same fork so a PR's
    successive pushes roll migrations forward on one copy (`--refresh` re-forks). Uses the
    existing tenant-scoped push token — no new credential.
  - **dashboard**: the generated `substrat-deploy.yml` gains `pull_request` jobs —
    create/update the preview on open/synchronize (and comment the URL back), reap it on
    close — alongside the existing push-to-branch prod deploy.

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.29.0

### Minor Changes

- a650d52: Dashboard permissions view + version-to-version admission diff (#336, D-39).

  The permission registry a vertical declares has shipped inside the deploy manifest
  since #299 (`manifest.registry`: keys+descriptions, role templates, entity-grant
  shapes), but nothing consumed it — a tenant installing or updating an app could not
  see what permissions and roles it declares. This adds the tenant-facing view #299 left
  as a follow-up, with no new backend plumbing beyond a read path.

  - **control-plane-api**: a new owner-narrowed `GET /verticals/:slug/versions/:id/registry`
    reads one version's declared permission surface out of its retained manifest (null for a
    pre-#286 version, or one that declares no surface). Owner-narrowed exactly like the
    versions list — a builder reading a vertical it does not own gets a 404. Read-only: the
    promotion permission-diff checkpoint stays the human gate.

  - **dashboard**: `GET /api/apps/:scopeId/permissions` resolves the registry of the version
    the app actually runs (its pinned version, the router's truth) plus the prod-head update
    target's, through the tenant-narrowed control plane (connected) or the retained manifest
    (embedded). A new **Permissions** tab renders the declared surface — keys grouped by
    declaring engine (key → description → the roles that hold it), role templates, and
    entity-grant **shapes** (the per-principal grants themselves stay a runtime concern) —
    and, when an update is available, a version-to-version diff flagging new/removed/
    re-described keys and **widened roles**. Absent-registry (D-28 optional), no-roles, and
    no-running-version cases render explicitly rather than crashing.

  This is the tenant-facing rendering of the permission-diff human checkpoint: the tab
  displays, but approving a widened role stays a human decision made when updating on the
  Deployments tab.

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

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.28.0

### Minor Changes

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

### Patch Changes

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

- 03839ec: Unmapped 5xx from the control plane are now logged server-side, so a `substrat push` that
  fails with a bare `500 {"error":"internal error"}` is diagnosable without reproducing it.

  `mapError` deliberately returns a GENERIC body for any throw whose message it does not
  recognise (an unreviewed message on a cross-tenant surface must disclose nothing). Until now
  nothing recorded WHAT threw either, so an unmapped failure was opaque from both sides. The
  concrete case that surfaced this: a single registry row with malformed `env_spec`/`install_spec`
  JSON makes `mapVertical`'s `JSON.parse` throw a `SyntaxError` (not a `ZodError`, so it skips the
  400 branch) — and because `ownerOf` → `listVerticals` maps every row on the pre-upload owner
  check, that one bad row 500s _every_ builder deploy with no detail.

  `onError` now emits `control-plane.unhandled { method, path, detail, stack }` for any 5xx before
  returning the generic body. The client response is unchanged (still generic — nothing is
  disclosed); the worker tail now names the cause. Mapped 4xx are honest refusals and stay unlogged.

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/psl@0.2.0

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

- 487db9a: Deploy-failure reporting is honest end-to-end (#307). A `substrat push` of a vertical that
  throws at module import time (e.g. an "api catalog drift" self-check) builds, dry-runs clean,
  uploads, and is then refused by Workers-for-Platforms with CF 10021 — and the failure that
  came back was undiagnosable in two ways.

  - **The upstream error was truncated mid-token.** The WfP error body was clipped with a bare
    `body.slice(0, 400)`, so it ended `…eka/set-budg` — no marker, no closing brace, the rest of
    the list invisible, and no way to tell a real operation name from a severed string. A new
    `clip(body, max = 2000)` helper carries the body through whole up to a generous cap and, when
    it must clip, appends an explicit `… [truncated, N chars omitted]` instead of cutting silently.

  - **A bad bundle read as a platform outage.** Every upload failure collapsed to a `502`, even a
    Cloudflare `4xx` that is the builder's own script being refused — sending the reader hunting
    for a platform problem first. The uploader now throws `DeployUploadError` carrying the upstream
    status (part of the deploy seam, `upstreamStatusOf`), and the deploy endpoint answers a runtime
    `4xx` as `422 deploy rejected` (well-formed HTTP, semantically refused — the builder's fault),
    keeping `5xx`/unknown as `502 deploy upload failed`.

  Also clarified: a version **label is consumed only on a successful upload**. The endpoint records
  the pending version _after_ the upload returns, so a push that fails at the upload step never
  registers the label and the same `--version` is reusable on retry (documented in
  self-serve-deploy.md §5). Booting the isolate at build time to catch import-time throws locally
  (the issue's third ask) is intentionally not done here — it would add a Workers runtime dependency
  to the CLI; the honest remote error is the mitigation.

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

- d4bf108: The workspace pin travels with a push and is honored, never silently reinterpreted. The
  CLI sends the project's pinned workspace (`substrat.tenant`) as a form field alongside
  the bundle; the deploy route resolves who the push is FOR before anything reaches the
  namespace. For a builder the pin must match the authenticated workspace — a mismatch is
  a 403 naming both sides, instead of a push that lands somewhere the project didn't say.
  For staff the pin is what was previously dropped on the floor: a pinned staff push now
  claims `<tenantSlug>/<slug>` owned by that tenant — prefixed, dashboard-visible, and
  self-admitting, exactly as the equivalent builder push — closing the dual-hat footgun
  where a staff-roster account (which can never authenticate as a builder, staff being the
  superset tried first) pushed verticals its own workspace could neither see nor
  self-serve. A bare slug already owned by the pinned tenant stays addressable as itself;
  unpinned staff pushes keep the platform-owned behavior; old CLIs that send no pin are
  unaffected on every path. `effectiveSlug` is now idempotent so a builder may address its
  own vertical by the full registry id a deploy response returns, and the CLI's same-run
  `--promote` uses exactly that id (with the version bump computed across both the
  prefixed and legacy-bare lineages).
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

### Patch Changes

- b06730e: Fix the in-place serve failing with "held no modules" on promote (#308). The WfP content
  reader (`createWfpModulesFetcher`) read the bundle back from a version's archive script and
  kept only parts where `value instanceof File`, with no `else`. But Cloudflare's `GET /content`
  is not an echo of the upload: a multipart module part whose `Content-Disposition` carries no
  `filename=` is exposed by the web-standard `FormData` parser (workerd and undici alike) as a
  **string**, not a `File`. Every such part was silently dropped, `modules` came back empty, and
  promote failed the in-place serve — the version was admitted but never served, leaving scopes
  pinned to the previous code.

  The reader now accepts both shapes: a string part becomes a module (`TextEncoder`-encoded),
  a `metadata` part (if present) is skipped, and the "held no modules" error reports the
  content-type and received part names so a future read-back that yields nothing is diagnosable
  from one log line. Regression test added with a hand-built multipart body that omits
  `filename=` — the shape the prior fixture, which passed filenames explicitly, could never
  reproduce. Introduced by the in-place deploy path (#286 / #287).

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

### Minor Changes

- 983c06d: Identity-mirror routes (`PUT`/`DELETE /tenants/:tenantId/identities`): the seam the
  Dashboard writes builder identity links through, so the shared plane's whoami/builder
  auth can resolve a CLI session to its workspaces. Service/staff only — not in the
  builder allowlist.

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

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.15.0

### Minor Changes

- 297e057: Observability, views 1–3 of design/observability.md — piggyback Cloudflare, stamp
  what only we know:

  - **Seam + Cloudflare reader** (`control-plane-api`): a provider-neutral
    `ObservabilityReader` contract (service/namespace vocabulary, never
    script/dispatch-namespace) with `createCfObservabilityReader` as the injected
    Cloudflare implementation (GraphQL invocation analytics + the Workers
    Observability telemetry query API) — the `DeployVerticalFn`/`wfp.ts` pattern, so
    an APM/OTel backend can slot in behind identical routes later. Two staff-only
    proxy routes: `GET /observability/metrics` and `GET /observability/logs`
    (501 when no backend is configured; deliberately not in `BUILDER_ROUTES`).
  - **Router**: one Analytics Engine datapoint per resolved request — index
    `tenantId`, blobs `(vertical, scope, surface, statusClass, rayId)`, doubles
    `(durationMs, status)` — plus a structured JSON log line with the same fields.
    The router is the only place that knows which tenant a request belonged to;
    written now so tenant-keyed history accrues before any tenant-facing read path
    exists. Metering never fails a request, and error paths are counted.
  - **WfP uploads**: pushed verticals get `observability: { enabled: true }`, so
    builder logs exist to query.
  - **Console**: an Observability fleet view — per-service invocations, error
    rates, CPU quantiles, and a row-click recent-logs panel.
  - **Dashboard**: a Traffic panel on the Verticals view showing the team's own
    deployed versions (requests/errors/CPU + recent logs). Owner-narrowing lives in
    `TenantNarrowedControlPlane`: metrics rows are filtered to owned deployment
    refs and mapped back to (vertical, version); a logs query for an unowned ref
    answers `[]` without ever reaching the plane.

  Deploy notes: the control plane's `CF_API_TOKEN` additionally needs **Account
  Analytics: Read** and **Workers Observability: Read**; the router redeploy picks
  up the `substrat_router` AE dataset binding (auto-created on first write).

- d93e690: Detachable vertical auth (docs/architecture/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

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

- 7ed3015: The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

  **auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
  `GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
  database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
  Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
  password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
  issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
  such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
  counts stay readable.

  **control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
  (status + message) instead of collapsing it into the generic 500 "internal error". A
  vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
  dashboard as itself; routes that already hand-caught it are unchanged.

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

### Patch Changes

- f4ad677: **Data view: read a scope's BOUND version, not the prod channel.** The connected-mode
  `/tenants/:t/scopes/:s/tables` introspection route delegated to the vertical resolved by
  the vertical's `prod` channel. But each `substrat push` is a separate Workers-for-
  Platforms script with its own Durable Object namespace, so a scope's data DO lives in the
  deployment of the version it was **bound** to (`scope.verticalVersionId`) — the same one
  the router serves it from. Once an installed app lagged prod, introspection resolved to
  the prod deployment and read an empty DO.

  Adds an optional `resolveVerticalVersion(slug, versionId, actor)` to `ControlPlaneApiOptions`;
  the route now prefers it (keyed by the scope's bound version), falling back to the
  prod-channel `resolveVertical` for a scope with no bound version, then to the host's own
  scope DB. Behaviour is unchanged for a freshly-installed app (bound == prod). Closes #220.

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.12.0

### Minor Changes

- 05291fa: **Builder authz on the control-plane API (builder-plane.md Phase 2).** A second principal
  kind — a _tenant user_ — joins staff/service on the same surface, confined to the
  vertical-management routes and to the verticals their tenant **owns** (the `owner_tenant`
  column from Phase 1b). The mechanism ships tested against a stub; the real builder-session
  reader (session → user → selected tenant) and CLI wiring land with Phase 3.

  - **`authenticateBuilder?: BuilderAuth`** — a new, optional `createControlPlaneApi` option
    resolving a request to a `{ actor, tenantId }` builder principal. Tried only after
    `authenticate` (staff/service) declines, so staff auth is **unchanged** and remains a
    superset. Absent ⇒ the surface is staff/service-only exactly as before.
  - **Fail-closed confinement** — a builder reaches only an explicit allowlist of
    vertical-management routes (`GET`/`POST /verticals`, `…/versions`, `…/channels`, promote,
    deploy). Everything else — tenants, scopes, hostnames, admin-log, instance provisioning,
    and `versions/:id/{admit,reject}` — is `403` for a builder. Default-deny by design: a
    route not on the allowlist denies builders (a missing feature), never escalates.
  - **Ownership checks** — register/deploy **claim** an unregistered slug for the caller's
    tenant or require they already own it (`403` otherwise); publish/promote require ownership;
    `GET` of an unowned vertical is `404` (indistinguishable from absent, K-3's reflex). The
    owner is stamped from the principal, never trusted from the body. Staff pushes preserve the
    existing owner rather than clobbering it.
  - **Model B, staff keep the prod gate** — a builder self-serves `dev`/`staging` promotion;
    **`prod` promotion and admission stay staff-only**, the trust boundary self-serve-deploy.md
    §3 draws.
  - **`GET /verticals`** is filtered to the caller's owned verticals for a builder; staff see
    the whole registry.

  Internally the auth middleware now sets both `actor` (the audited subject, unchanged for
  every HostAdmin call) and a new `principal` (the authz distinction) — existing routes are
  untouched. `errors.ts` maps the Phase-1b claim conflict (`is owned by …`) to 409.

  Verified: control-plane-api suite (71) incl. a new builder-authz matrix — claim, cross-tenant
  refusal, list filtering, non-prod self-serve, staff-only prod/admit, deploy-path claim — and
  the control-plane worker suite (13) both pass; `pnpm -r typecheck` clean.

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

- 7070588: **Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

  A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

  - **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
  - **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

  Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.

- 66e752b: **Add the deploy seam: `POST /verticals/:slug/deploy` (self-serve-deploy.md foundation).**

  A `substrat push` uploads a _built_ worker bundle to this endpoint, which validates the
  **sandbox contract**, forwards the bundle to an injected uploader (the host holds the
  Cloudflare credential — the builder never does, D-34), and records a **pending** version.
  A push is not a deploy; admission still gates serving.

  - New `deployVertical?: DeployVerticalFn` option — injected so the package holds no
    Cloudflare SDK and is unit-testable with a fake. Absent ⇒ the route 501s.
  - `assertSandboxContract` (self-serve-deploy.md §4): refuses an upload whose declared
    bindings would reach platform infrastructure — a `CONTROL_PLANE` binding, a cross-script
    DO binding, or a service binding to a platform worker → `403`. Structural refusal, not
    code inspection, is the primary defence against untrusted bundles.
  - `deploymentRef` is `<slug>-<versionId>` (a lowercased ULID) — a valid Cloudflare Worker
    script name, unlike the `@version` label the RFC sketched (`@`/`.` are illegal in script
    names). The human label stays on the version record.
  - Exports `assertSandboxContract`, `deployManifest`, `deploymentRefFor`, and the
    `DeployVerticalFn` / `VerticalBundle` types for hosts to implement the real uploader.
  - `createWfpUploader({ accountId, namespace, apiToken })` — a `DeployVerticalFn` that
    uploads the bundle into a Workers-for-Platforms dispatch namespace (pure `fetch` +
    `FormData`, so it runs in a Worker or node). Wired into `apps/control-plane` (behind the
    `CF_API_TOKEN`/`CF_ACCOUNT_ID` env) and the dev server. The `tools/substrat-push.mjs` CLI
    builds a vertical and pushes it to `/verticals/:slug/deploy`.
  - New `resolveVertical?: (slug, actor) => Promise<VerticalClient | undefined>` option — the
    provisioning dispatch swap (orchestration.md §5.4), tried after the static `verticals` map.
    `apps/control-plane` resolves a pushed vertical's `prod` version → `env.DISPATCH.get(ref)`,
    so `POST /verticals/:slug/instances` reaches a pushed vertical with no redeploy.

- cedaf1a: **Deploy path forwards a vertical's own D1 bindings (self-serve-deploy.md §4).**

  A `substrat push` now carries a vertical's `d1_databases` through to the Workers-for-Platforms upload, so a pushed vertical actually has its own data stores — not just its `ScopeDO`. This is what a CP-less vertical like Callout needs for its Better-Auth `AUTH_DB` to exist on the deployed worker.

  - **`DeclaredBinding` / `deployManifest`** gain an optional `id` — a `d1` binding's `database_id`, which previously would have been stripped at manifest parse.
  - **`tools/substrat-push.mjs`** maps `wrangler.jsonc`'s `d1_databases` to `{ type: 'd1', name: <binding>, id: <database_id> }` bindings alongside the DO bindings; `createWfpUploader` already forwards the binding set verbatim into the script metadata, which is the shape Cloudflare expects for a D1 binding.
  - **`assertSandboxContract`** still refuses only the platform's infrastructure (`CONTROL_PLANE`, service bindings, cross-script / foreign DO classes); a vertical's own `d1` store falls through and is allowed, matching §4 ("no `AUTH_DB` it did not create" — its own is fine). Documented open question: this check doesn't yet prove the vertical _owns_ the declared `database_id` rather than pointing at another tenant's DB — under model B that gap is closed by human admission, and by per-vertical store provisioning when self-serve opens wider.

  Not covered here (a separate mechanism, tracked next): **static assets.** A pushed vertical's SPA is not a binding — Cloudflare uploads it via a blake3-hashed assets-upload-session, which needs a server-side implementation in the uploader. Callout still needs that before it serves its UI from the dispatch namespace.

  Verified: control-plane-api suites pass, including a new deploy test that a `d1` binding (with its `database_id`) is accepted by the sandbox contract and forwarded to the uploader.

- 0de890b: **The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

  A pushed vertical needs the platform's shared secrets to _verify_ inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

  - **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, _after_ the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
  - **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

  Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.

- d5a7d5e: **Expose the vertical + version registry over the control-plane HTTP API (orchestration.md Phase 1a).**

  The registry data model — verticals, versions, channels, admission, and the digest-diff
  promotion gate — was already built at the `HostAdmin` + adapter layer but had no HTTP
  surface. This adds thin pass-through routes so a staff caller (and the console) can drive it:

  - `GET/POST /verticals` — list, register
  - `GET/POST /verticals/:slug/versions` — list, publish (lands **pending**; body slug must
    match the path, K-3-style cross-check)
  - `POST /verticals/:slug/versions/:id/{admit,reject}` — the admission checkpoint
  - `GET /verticals/:slug/channels` + `POST /verticals/:slug/channels/:channel/promote` — the
    promotion checkpoint, which refuses a changed permission/migration digest unless
    acknowledged
  - `POST /tenants/:tenantId/scopes/:scopeId/version` — bind a scope to an admitted version

  `errors.ts` gains status mappings so registry refusals surface as `404`/`409` rather than
  `500`. No `deploy` route (the worker uploader) — that is Phase 2. The actor is still stamped
  from the authenticated request, never the body.

### Patch Changes

- 097a3aa: **`deploymentRefFor` is prefix-safe** — builder plane Phase 1 groundwork.

  A builder-owned vertical's slug will be `<tenant>/<name>` (builder-plane.md). The
  dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`), so `deploymentRefFor`
  now flattens the `/` (and any other stray char) to `-`. A bare platform slug is
  unaffected (`callout-<id>`), so it's fully backward-compatible.

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

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.10.0

### Patch Changes

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

### Minor Changes

- c9fe555: `VerticalClient` and `POST /verticals/:slug/instances` — the platform's side of K-31.

  Provisioning is control-plane-driven because only the vertical can create a usable
  scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
  This is the mirror of `ControlPlaneClient`, pointing the other way — that one is a
  vertical talking up to the platform, this is the platform telling a vertical to act.

  Deliberately tiny. Provisioning is the only thing the platform asks a vertical to do,
  and every additional verb would be authority the platform holds over someone else's
  code.

  `createControlPlaneApi` takes an optional `verticals` map. A slug with no binding gets
  a **501** rather than a silent success: a control plane that does nothing while
  reporting success is worse than one that says it cannot. The vertical's own status is
  propagated rather than flattened to 500, because a 403 means the platform secrets do
  not match — a deployment error someone must act on.

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.7.0

### Minor Changes

- 017bb83: The hostname map is on the audited HTTP surface: `GET /hostnames`,
  `POST /hostnames`, `PATCH /hostnames/:hostname/status`.

  `resolveHostname` is deliberately **not** here. It is the router's per-request machine
  path, unaudited by design (K-24), and the router reads the directory directly. Putting
  it on the staff surface would either flood the admin log or quietly add an unaudited
  route to a surface whose whole claim is that it is audited.

  `ControlPlaneClient` is unchanged: that is the _vertical's_ client, and a vertical
  assigning itself a domain is not a thing we want to be possible.

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.6.0

### Minor Changes

- ea3c5de: Service auth for connected verticals, and a workerd fetch fix.

  - `serviceTokenAuth` + `SERVICE_TOKEN_HEADER` — a shared-token credential a
    vertical presents to register into the control plane (a service, not staff),
    and `firstPlatformActorAuth` to compose it with session/dev auth.
  - `ControlPlaneClient` gains a `serviceToken` option (sent as `x-service-token`).
  - **Fix:** `ControlPlaneClient` bound `globalThis.fetch` incorrectly, throwing
    "Illegal invocation" on workerd. It is now bound to the global scope, so the
    client works inside a Worker (over a service binding or plain fetch).

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.5.0

### Minor Changes

- 54c6583: Add the vertical-side connect seam and swappable staff auth.

  - `ControlPlaneClient` — a typed HTTP client that registers a tenant, entitlements,
    and scope into a separately-run control plane, plus `assertScopeActive`, a gate
    that fails closed on the directory's authoritative lifecycle (tenant-level
    cascade included). `fetch` is injectable.
  - `sessionPlatformAuth(readSession, resolveActor)` + `staffAllowlist` — the real
    `PlatformActorAuth` for platform staff, split so the auth provider and the staff
    roster are independent. Swapping the provider (e.g. to AuthHero) changes only the
    session reader.

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
