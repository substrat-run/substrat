# @substrat-run/dashboard

## 0.28.5

### Patch Changes

- Updated dependencies [73710de]
- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/engine-workorder@0.9.0
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0
  - @substrat-run/demo-callout@0.3.6
  - @substrat-run/demo-manyfold@0.7.5
  - @substrat-run/demo-meridian@0.7.1
  - @substrat-run/adapter-cloudflare@0.89.0
  - @substrat-run/engine-absence@0.5.1
  - @substrat-run/engine-invites@0.4.9
  - @substrat-run/engine-invoicing@0.9.5
  - @substrat-run/engine-protocol@0.11.5

## 0.28.4

### Patch Changes

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [537ad93]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/demo-callout@0.3.5
  - @substrat-run/demo-meridian@0.7.0
  - @substrat-run/kernel@0.88.0
  - @substrat-run/adapter-cloudflare@0.88.0
  - @substrat-run/engine-absence@0.5.0
  - @substrat-run/engine-protocol@0.11.4
  - @substrat-run/demo-manyfold@0.7.4
  - @substrat-run/engine-invites@0.4.8
  - @substrat-run/engine-invoicing@0.9.4
  - @substrat-run/engine-workorder@0.8.4

## 0.28.3

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/demo-callout@0.3.4
  - @substrat-run/demo-manyfold@0.7.3
  - @substrat-run/demo-meridian@0.6.3
  - @substrat-run/engine-absence@0.4.7
  - @substrat-run/engine-invites@0.4.7
  - @substrat-run/engine-invoicing@0.9.3
  - @substrat-run/engine-protocol@0.11.3
  - @substrat-run/engine-workorder@0.8.3
  - @substrat-run/adapter-cloudflare@0.87.0
  - @substrat-run/kernel@0.87.0

## 0.28.2

### Patch Changes

- @substrat-run/demo-callout@0.3.3
- @substrat-run/demo-manyfold@0.7.2
- @substrat-run/demo-meridian@0.6.2
- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0
- @substrat-run/adapter-cloudflare@0.86.0
- @substrat-run/engine-absence@0.4.6
- @substrat-run/engine-invites@0.4.6
- @substrat-run/engine-invoicing@0.9.2
- @substrat-run/engine-protocol@0.11.2
- @substrat-run/engine-workorder@0.8.2

## 0.28.1

### Patch Changes

- @substrat-run/demo-callout@0.3.2
- @substrat-run/demo-meridian@0.6.1
- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0
- @substrat-run/adapter-cloudflare@0.85.0
- @substrat-run/demo-manyfold@0.7.1
- @substrat-run/engine-absence@0.4.5
- @substrat-run/engine-invites@0.4.5
- @substrat-run/engine-invoicing@0.9.1
- @substrat-run/engine-protocol@0.11.1
- @substrat-run/engine-workorder@0.8.1

## 0.28.0

### Minor Changes

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
- Updated dependencies [dc2c726]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [7548dde]
- Updated dependencies [fabe51d]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/engine-workorder@0.8.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-cloudflare@0.84.0
  - @substrat-run/engine-invoicing@0.9.0
  - @substrat-run/engine-protocol@0.11.0
  - @substrat-run/demo-callout@0.3.1
  - @substrat-run/engine-absence@0.4.4
  - @substrat-run/engine-invites@0.4.4
  - @substrat-run/demo-manyfold@0.7.0
  - @substrat-run/demo-meridian@0.6.0

## 0.27.0

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
- Updated dependencies [4f65106]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-cloudflare@0.83.0
  - @substrat-run/demo-callout@0.3.0
  - @substrat-run/demo-meridian@0.5.19
  - @substrat-run/demo-manyfold@0.6.38
  - @substrat-run/engine-absence@0.4.3
  - @substrat-run/engine-invites@0.4.3
  - @substrat-run/engine-invoicing@0.8.3
  - @substrat-run/engine-protocol@0.10.3
  - @substrat-run/engine-workorder@0.7.3

## 0.26.19

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
- Updated dependencies [75925a2]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/adapter-cloudflare@0.82.0
  - @substrat-run/demo-callout@0.2.37
  - @substrat-run/demo-manyfold@0.6.37
  - @substrat-run/demo-meridian@0.5.18
  - @substrat-run/engine-absence@0.4.2
  - @substrat-run/engine-invites@0.4.2
  - @substrat-run/engine-invoicing@0.8.2
  - @substrat-run/engine-protocol@0.10.2
  - @substrat-run/engine-workorder@0.7.2
  - @substrat-run/kernel@0.82.0

## 0.26.18

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-cloudflare@0.81.0
  - @substrat-run/demo-callout@0.2.36
  - @substrat-run/demo-manyfold@0.6.36
  - @substrat-run/demo-meridian@0.5.17
  - @substrat-run/engine-absence@0.4.1
  - @substrat-run/engine-invites@0.4.1
  - @substrat-run/engine-invoicing@0.8.1
  - @substrat-run/engine-protocol@0.10.1
  - @substrat-run/engine-workorder@0.7.1

## 0.26.17

### Patch Changes

- Updated dependencies [f6174fb]
- Updated dependencies [83b0ca3]
  - @substrat-run/engine-absence@0.4.0
  - @substrat-run/engine-invites@0.4.0
  - @substrat-run/engine-invoicing@0.8.0
  - @substrat-run/engine-protocol@0.10.0
  - @substrat-run/engine-workorder@0.7.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/demo-callout@0.2.35
  - @substrat-run/demo-meridian@0.5.16
  - @substrat-run/demo-manyfold@0.6.35
  - @substrat-run/adapter-cloudflare@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.26.16

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
- Updated dependencies [87ec6f2]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/adapter-cloudflare@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/oidc-rp@0.5.1
  - @substrat-run/demo-callout@0.2.34
  - @substrat-run/demo-manyfold@0.6.34
  - @substrat-run/demo-meridian@0.5.15
  - @substrat-run/engine-absence@0.3.6
  - @substrat-run/engine-invites@0.3.6
  - @substrat-run/engine-invoicing@0.7.6
  - @substrat-run/engine-protocol@0.9.6
  - @substrat-run/engine-workorder@0.6.6

## 0.26.15

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/demo-callout@0.2.33
  - @substrat-run/demo-manyfold@0.6.33
  - @substrat-run/demo-meridian@0.5.14
  - @substrat-run/engine-absence@0.3.5
  - @substrat-run/engine-invites@0.3.5
  - @substrat-run/engine-invoicing@0.7.5
  - @substrat-run/engine-protocol@0.9.5
  - @substrat-run/engine-workorder@0.6.5
  - @substrat-run/adapter-cloudflare@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.26.14

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/demo-callout@0.2.32
  - @substrat-run/demo-manyfold@0.6.32
  - @substrat-run/demo-meridian@0.5.13
  - @substrat-run/engine-absence@0.3.4
  - @substrat-run/engine-invites@0.3.4
  - @substrat-run/engine-invoicing@0.7.4
  - @substrat-run/engine-protocol@0.9.4
  - @substrat-run/engine-workorder@0.6.4
  - @substrat-run/adapter-cloudflare@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.26.13

### Patch Changes

- @substrat-run/demo-callout@0.2.31
- @substrat-run/demo-manyfold@0.6.31
- @substrat-run/demo-meridian@0.5.12
- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-cloudflare@0.76.0
- @substrat-run/engine-absence@0.3.3
- @substrat-run/engine-invites@0.3.3
- @substrat-run/engine-invoicing@0.7.3
- @substrat-run/engine-protocol@0.9.3
- @substrat-run/engine-workorder@0.6.3

## 0.26.12

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-cloudflare@0.75.0
  - @substrat-run/demo-callout@0.2.30
  - @substrat-run/demo-manyfold@0.6.30
  - @substrat-run/demo-meridian@0.5.11
  - @substrat-run/engine-absence@0.3.2
  - @substrat-run/engine-invites@0.3.2
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/engine-protocol@0.9.2
  - @substrat-run/engine-workorder@0.6.2
  - @substrat-run/contracts@0.75.0

## 0.26.11

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/demo-callout@0.2.29
  - @substrat-run/demo-manyfold@0.6.29
  - @substrat-run/demo-meridian@0.5.10
  - @substrat-run/engine-absence@0.3.1
  - @substrat-run/engine-invites@0.3.1
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/engine-protocol@0.9.1
  - @substrat-run/engine-workorder@0.6.1
  - @substrat-run/adapter-cloudflare@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.26.10

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-protocol@0.9.0
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-absence@0.3.0
  - @substrat-run/engine-invites@0.3.0
  - @substrat-run/engine-workorder@0.6.0
  - @substrat-run/adapter-cloudflare@0.73.0
  - @substrat-run/demo-callout@0.2.28
  - @substrat-run/demo-meridian@0.5.9
  - @substrat-run/demo-manyfold@0.6.28
  - @substrat-run/kernel@0.73.0

## 0.26.9

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-cloudflare@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/engine-workorder@0.5.0
  - @substrat-run/engine-protocol@0.8.0
  - @substrat-run/demo-callout@0.2.27
  - @substrat-run/demo-manyfold@0.6.27
  - @substrat-run/demo-meridian@0.5.8
  - @substrat-run/engine-absence@0.2.3
  - @substrat-run/engine-invites@0.2.3
  - @substrat-run/engine-invoicing@0.6.3

## 0.26.8

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/demo-callout@0.2.26
  - @substrat-run/demo-manyfold@0.6.26
  - @substrat-run/demo-meridian@0.5.7
  - @substrat-run/engine-absence@0.2.2
  - @substrat-run/engine-invites@0.2.2
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/engine-protocol@0.7.3
  - @substrat-run/engine-workorder@0.4.3
  - @substrat-run/adapter-cloudflare@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.26.7

### Patch Changes

- d5656cd: fix: the dashboard's Scrive catalog could not grant `protocol:read`, so no rotation could repair a connection

  **Permission diff.** A Scrive connection written through the dashboard is now granted
  `protocol:read` alongside `protocol:record-signature` and `protocol:attach`.

  `connector-scrive` 0.9.0 (#711) made `protocol:read` load-bearing: the connector opens the
  document the vertical bound to the instance and sends those bytes, and a bound-but-unreadable
  document is a deliberate hard failure — the dispatch dead-letters rather than quietly posting the
  attestation sheet instead. The dashboard's `PROVIDERS` catalog was not updated with it, so the
  dashboard door could not grant the permission to any tenant, and a rotation — the only repair a
  connection has — could not add it either.

  This is the same class as the `protocol:attach` gap #716 found on the demo connection: a
  connector's requirement and the catalog that grants it are two lists with nothing checking that
  they agree. #726 tracks the shape that would make this mechanical — deriving the granted list from
  the connecting vertical's declared `requires:` rather than restating it per provider — plus the
  prior question of whether a per-dispatch read should be a standing scope-wide grant at all. This
  change is the stopgap that unblocks the door in the meantime, and it widens every Scrive
  connection written through the dashboard, not only the verticals that bind documents.

- Updated dependencies [ef4a747]
- Updated dependencies [9bb7975]
  - @substrat-run/demo-meridian@0.5.6
  - @substrat-run/demo-manyfold@0.6.25
  - @substrat-run/contracts@0.70.0
  - @substrat-run/demo-callout@0.2.25
  - @substrat-run/engine-absence@0.2.1
  - @substrat-run/engine-invites@0.2.1
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/engine-protocol@0.7.2
  - @substrat-run/engine-workorder@0.4.2
  - @substrat-run/adapter-cloudflare@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.26.6

### Patch Changes

- Updated dependencies [17a82ec]
- Updated dependencies [eddd3c5]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/engine-absence@0.2.0
  - @substrat-run/engine-invites@0.2.0
  - @substrat-run/demo-callout@0.2.24
  - @substrat-run/demo-manyfold@0.6.24
  - @substrat-run/demo-meridian@0.5.5
  - @substrat-run/engine-protocol@0.7.1
  - @substrat-run/engine-workorder@0.4.1
  - @substrat-run/adapter-cloudflare@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.26.5

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
  - @substrat-run/adapter-cloudflare@0.68.0
  - @substrat-run/demo-callout@0.2.23
  - @substrat-run/demo-manyfold@0.6.23
  - @substrat-run/demo-meridian@0.5.4
  - @substrat-run/engine-absence@0.1.3
  - @substrat-run/engine-invites@0.1.13
  - @substrat-run/engine-invoicing@0.5.24

## 0.26.4

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/demo-callout@0.2.22
  - @substrat-run/demo-manyfold@0.6.22
  - @substrat-run/demo-meridian@0.5.3
  - @substrat-run/engine-absence@0.1.2
  - @substrat-run/engine-invites@0.1.12
  - @substrat-run/engine-invoicing@0.5.23
  - @substrat-run/engine-protocol@0.6.3
  - @substrat-run/engine-workorder@0.3.65
  - @substrat-run/adapter-cloudflare@0.67.0

## 0.26.3

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/demo-callout@0.2.21
  - @substrat-run/demo-manyfold@0.6.21
  - @substrat-run/demo-meridian@0.5.2
  - @substrat-run/engine-absence@0.1.1
  - @substrat-run/engine-invites@0.1.11
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/engine-protocol@0.6.2
  - @substrat-run/engine-workorder@0.3.64
  - @substrat-run/contracts@0.66.0

## 0.26.2

### Patch Changes

- Updated dependencies [49e8ede]
  - @substrat-run/engine-absence@0.1.0
  - @substrat-run/demo-meridian@0.5.0

## 0.26.1

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/demo-callout@0.2.20
  - @substrat-run/demo-manyfold@0.6.20
  - @substrat-run/demo-meridian@0.4.20
  - @substrat-run/engine-invites@0.1.10
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/engine-protocol@0.6.1
  - @substrat-run/engine-workorder@0.3.63
  - @substrat-run/adapter-cloudflare@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.26.0

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
- Updated dependencies [6ac51d1]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0
  - @substrat-run/engine-invites@0.1.9
  - @substrat-run/oidc-rp@0.5.0
  - @substrat-run/engine-protocol@0.6.0
  - @substrat-run/demo-callout@0.2.19
  - @substrat-run/demo-manyfold@0.6.19
  - @substrat-run/demo-meridian@0.4.19
  - @substrat-run/engine-invoicing@0.5.20
  - @substrat-run/engine-workorder@0.3.62

## 0.25.0

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

- b4910dc: fix: Test connection no longer reports success next to the error it just cleared

  Clicking Test connection on a connection whose last dispatch had failed produced a screen that
  contradicted itself: an **Error** pill and "Last error 10m ago: HTTP 401 from scrive" directly
  above **Credential accepted** and the verified account.

  Nothing was wrong with the stored state. A successful use clears `last_error` and lifts the row
  out of `error` (contract-tested for both adapters), and the probe rides the sanctioned `fetch`, so
  it had already repaired the row. The screen was pairing a fresh probe result with the connection
  row captured when the _list page_ loaded, minutes earlier.

  Both inspection routes now answer with the row as read in that same request — `…/activity` on
  open, and `…/verify` re-read **after** the probe — and the detail view renders that rather than
  the prop it was opened with. Closing the drawer refreshes the card behind it, so a repair made
  inside is visible outside. The dev-mock path updates through the same state, so the preview cannot
  diverge from the live one.

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/demo-callout@0.2.18
  - @substrat-run/demo-manyfold@0.6.18
  - @substrat-run/demo-meridian@0.4.18
  - @substrat-run/engine-invites@0.1.8
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/engine-protocol@0.5.21
  - @substrat-run/engine-workorder@0.3.61
  - @substrat-run/contracts@0.63.0

## 0.24.0

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
  - @substrat-run/demo-callout@0.2.17
  - @substrat-run/demo-manyfold@0.6.17
  - @substrat-run/demo-meridian@0.4.17
  - @substrat-run/engine-invites@0.1.7
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/engine-protocol@0.5.20
  - @substrat-run/engine-workorder@0.3.60
  - @substrat-run/adapter-cloudflare@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.23.0

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
  - @substrat-run/demo-callout@0.2.16
  - @substrat-run/demo-manyfold@0.6.16
  - @substrat-run/demo-meridian@0.4.16
  - @substrat-run/engine-invites@0.1.6
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/engine-protocol@0.5.19
  - @substrat-run/engine-workorder@0.3.59
  - @substrat-run/adapter-cloudflare@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.22.0

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
  - @substrat-run/adapter-cloudflare@0.60.0
  - @substrat-run/demo-callout@0.2.15
  - @substrat-run/demo-manyfold@0.6.15
  - @substrat-run/demo-meridian@0.4.15
  - @substrat-run/engine-invites@0.1.5
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/engine-protocol@0.5.18
  - @substrat-run/engine-workorder@0.3.58
  - @substrat-run/kernel@0.60.0

## 0.21.0

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

- Updated dependencies [eda5d01]
  - @substrat-run/demo-meridian@0.4.14
  - @substrat-run/demo-callout@0.2.14
  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0
  - @substrat-run/adapter-cloudflare@0.59.0
  - @substrat-run/demo-manyfold@0.6.14
  - @substrat-run/engine-invites@0.1.4
  - @substrat-run/engine-invoicing@0.5.15
  - @substrat-run/engine-protocol@0.5.17
  - @substrat-run/engine-workorder@0.3.57

## 0.20.0

### Minor Changes

- 9f1078c: feat(dashboard): the team lives in the URL — every route is `/<team-slug>/…`

  Dashboard paths are now scoped to a team by their first segment
  (`app.substrat.net/acme-x1y2z3/overview`), built on the globally-unique slugs the
  worker already mints (name + ULID tail, so a slug can never shadow a section name).
  The client router pins the active slug once the session resolves and prefixes it
  onto every `navigate()` call and sidebar href — call sites keep writing `/apps/<id>`.
  Legacy slug-less paths (old bookmarks) redirect onto the pinned team; a deep link
  naming ANOTHER team you belong to switches the session before any data loads, so
  a shared `/other-team/apps/…` link opens scoped to that team with no wrong-team
  flash; an unknown slug is swapped for the pinned team's. The switcher navigates
  onto the new team's URL, and creating a team lands on `/` so the fresh load picks
  up the new slug. `/invite/…` links stay team-less by design.

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0
  - @substrat-run/demo-callout@0.2.13
  - @substrat-run/demo-manyfold@0.6.13
  - @substrat-run/demo-meridian@0.4.13
  - @substrat-run/engine-invites@0.1.3
  - @substrat-run/engine-invoicing@0.5.14
  - @substrat-run/engine-protocol@0.5.16
  - @substrat-run/engine-workorder@0.3.56

## 0.19.0

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

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/demo-callout@0.2.12
  - @substrat-run/demo-manyfold@0.6.12
  - @substrat-run/demo-meridian@0.4.12
  - @substrat-run/engine-invites@0.1.2
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/engine-protocol@0.5.15
  - @substrat-run/engine-workorder@0.3.55
  - @substrat-run/adapter-cloudflare@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.18.1

### Patch Changes

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

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0
  - @substrat-run/demo-callout@0.2.11
  - @substrat-run/demo-manyfold@0.6.11
  - @substrat-run/demo-meridian@0.4.11
  - @substrat-run/engine-invites@0.1.1
  - @substrat-run/engine-invoicing@0.5.12
  - @substrat-run/engine-protocol@0.5.14
  - @substrat-run/engine-workorder@0.3.54

## 0.18.0

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

- Updated dependencies [ed7a940]
  - @substrat-run/engine-invites@0.1.0
  - @substrat-run/demo-callout@0.2.10
  - @substrat-run/demo-meridian@0.4.10
  - @substrat-run/contracts@0.55.0
  - @substrat-run/kernel@0.55.0
  - @substrat-run/adapter-cloudflare@0.55.0
  - @substrat-run/demo-manyfold@0.6.10
  - @substrat-run/engine-invoicing@0.5.11
  - @substrat-run/engine-protocol@0.5.13
  - @substrat-run/engine-workorder@0.3.53

## 0.17.7

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0
  - @substrat-run/demo-callout@0.2.9
  - @substrat-run/demo-manyfold@0.6.9
  - @substrat-run/demo-meridian@0.4.9
  - @substrat-run/engine-invites@0.0.51
  - @substrat-run/engine-invoicing@0.5.10
  - @substrat-run/engine-protocol@0.5.12
  - @substrat-run/engine-workorder@0.3.52

## 0.17.6

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/demo-callout@0.2.8
  - @substrat-run/demo-meridian@0.4.8
  - @substrat-run/demo-manyfold@0.6.8
  - @substrat-run/engine-protocol@0.5.11
  - @substrat-run/engine-invites@0.0.50
  - @substrat-run/engine-invoicing@0.5.9
  - @substrat-run/engine-workorder@0.3.51

## 0.17.5

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/demo-callout@0.2.7
  - @substrat-run/demo-manyfold@0.6.7
  - @substrat-run/demo-meridian@0.4.7
  - @substrat-run/engine-invites@0.0.49
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/engine-protocol@0.5.10
  - @substrat-run/engine-workorder@0.3.50
  - @substrat-run/adapter-cloudflare@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.17.4

### Patch Changes

- @substrat-run/demo-callout@0.2.6
- @substrat-run/demo-meridian@0.4.6
- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-cloudflare@0.51.0
- @substrat-run/demo-manyfold@0.6.6
- @substrat-run/engine-invites@0.0.48
- @substrat-run/engine-invoicing@0.5.7
- @substrat-run/engine-protocol@0.5.9
- @substrat-run/engine-workorder@0.3.49

## 0.17.3

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/demo-callout@0.2.5
  - @substrat-run/demo-meridian@0.4.5
  - @substrat-run/demo-manyfold@0.6.5
  - @substrat-run/engine-protocol@0.5.8
  - @substrat-run/engine-invites@0.0.47
  - @substrat-run/engine-invoicing@0.5.6
  - @substrat-run/engine-workorder@0.3.48

## 0.17.2

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/demo-callout@0.2.4
  - @substrat-run/demo-meridian@0.4.4
  - @substrat-run/demo-manyfold@0.6.4
  - @substrat-run/engine-invites@0.0.46
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/engine-protocol@0.5.7
  - @substrat-run/engine-workorder@0.3.47
  - @substrat-run/adapter-cloudflare@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.17.1

### Patch Changes

- 13f2818: Dashboard: traffic lives on the app's Observability tab only, now with a version filter.

  The Verticals page carried a fleet-wide Traffic panel that duplicated the per-app
  Observability tab — the same `observabilityMetrics` rows at a different zoom level. It's
  removed, so Verticals is purely the software you build: versions, channels, and
  publishing.

  Observability keeps traffic, reworked around a single filter bar above the list:

  - One `[Version ▾] [Range ▾] [Refresh]` bar. **Version** defaults to _All versions_ (every
    serving version of this app's vertical) and narrows the list — and, for a specific
    version, opens that version's logs below. Clicking a row is a shortcut for the same
    filter (click again to clear).
  - The version dropdown that used to be buried in the logs-panel header is gone; the panel
    now shows the active version as a tag and keeps only the log-specific level and
    message-search filters.

## 0.17.0

### Minor Changes

- 43ce1d5: Dashboard: real path routing (`/verticals`) instead of hash fragments (`/#/verticals`).

  The SPA ran on a hash router, so every route lived under `/#/…` and the per-vertical
  detail view was only reachable by hand-editing the fragment. The client now runs on the
  History API, so `app.substrat.net/verticals` and `…/verticals/<slug>` are first-class
  URLs — bookmarkable, refresh-safe, and shareable — and a vertical's detail view is a
  proper page instead of everything piling onto one screen.

  - New `lib/router.ts` `navigate()` helper: `history.pushState` + a synthetic `popstate`,
    so programmatic navigation and Back/Forward share one path. `App` re-parses
    `window.location.pathname` from a single `popstate` handler (`parsePath`, replacing
    `parseHash`). Sidebar and inline links keep a real `href` and `preventDefault()` the
    left-click, so middle-click / open-in-new-tab still work.
  - No worker changes were needed for deep links: the Workers Assets binding's
    `single-page-application` not-found handling already serves `index.html` for any
    non-`/api` path, and OIDC `returnTo` is already guarded to same-origin paths. The one
    server touch is the GitHub-connect redirect, now `/apps/new` (was `/#/apps/new`).
  - A vertical slug carrying a `/` (`acme/helpdesk`) is URI-encoded into a single path
    segment (`%2F`), which the browser and edge preserve, so it never splits across route
    parts. The legacy `/deployments` alias still resolves to Verticals.

  Verified end-to-end against the built bundle in a headless browser: `/verticals`,
  `/team`, and the encoded-slug detail link `/verticals/acme%2Fhelpdesk` each boot straight
  onto the correct page via the SPA fallback.

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0
  - @substrat-run/demo-callout@0.2.3
  - @substrat-run/demo-manyfold@0.6.3
  - @substrat-run/demo-meridian@0.4.3
  - @substrat-run/engine-invites@0.0.45
  - @substrat-run/engine-invoicing@0.5.4
  - @substrat-run/engine-protocol@0.5.6
  - @substrat-run/engine-workorder@0.3.46

## 0.16.0

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

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/adapter-email@0.2.0
  - @substrat-run/demo-callout@0.2.2
  - @substrat-run/demo-manyfold@0.6.2
  - @substrat-run/demo-meridian@0.4.2
  - @substrat-run/engine-invites@0.0.44
  - @substrat-run/engine-invoicing@0.5.3
  - @substrat-run/engine-protocol@0.5.5
  - @substrat-run/engine-workorder@0.3.45

## 0.15.0

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

- @substrat-run/demo-callout@0.2.1
- @substrat-run/demo-meridian@0.4.1
- @substrat-run/demo-manyfold@0.6.1
- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
- @substrat-run/adapter-cloudflare@0.46.0
- @substrat-run/engine-invites@0.0.43
- @substrat-run/engine-invoicing@0.5.2
- @substrat-run/engine-protocol@0.5.4
- @substrat-run/engine-workorder@0.3.44

## 0.14.4

### Patch Changes

- Updated dependencies [e3f86b0]
- Updated dependencies [846af24]
  - @substrat-run/demo-meridian@0.4.0
  - @substrat-run/demo-manyfold@0.6.0
  - @substrat-run/demo-callout@0.2.0
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0
  - @substrat-run/engine-invites@0.0.42
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/engine-protocol@0.5.3
  - @substrat-run/engine-workorder@0.3.43
  - @substrat-run/kernel@0.45.0

## 0.14.3

### Patch Changes

- 10733c4: The Verticals page had no per-vertical detail view — the only entry point into a
  vertical's history was the "All N versions" link, which merely expanded the collapsed
  list in place. A vertical is a first-class thing (its pushed versions, admission state,
  channels, and prod go-live history), so it now has a page of its own.

  Add a `#/verticals/<slug>` route rendering a new `VerticalDetail` page: the full version
  list (not just the newest three), the same self-serve channel promotion, and the prod
  go-live / rollback history that used to be an inline expand on the card. The slug carries
  a slash (`acme/helpdesk`), so it's URI-encoded into a single hash segment and decoded on
  the way back. Breadcrumbs read `Verticals › <name>`, and a deep link to an unknown slug
  shows a not-found (a loading state while the deployments list is still in flight, so it
  never flashes 404).

  The summary card keeps its newest-three preview; the title and the version-count link now
  navigate to the detail page (`View all N versions →` / `View details →`) instead of
  toggling local state.

- de11d64: The app Observability tab collapsed any logs-fetch failure into a single blanket
  "Logs are unavailable right now." — indistinguishable from a real outage, a
  misconfiguration, or a permission gap. It now surfaces the plane's status: `501`
  reads as "Log streaming is not configured on this platform.", any other error as
  "Logs are unavailable (`<status>`): `<message>`" (the plane returns sanitized bodies,
  so the message is safe to show). This is what made a `CF_API_TOKEN` missing
  `Workers Observability: Read` — the telemetry query 403 the plane maps to a 500 —
  undiagnosable from the UI alone.

  Also softens the traffic-panel caption from "sampled, approximate" to "approximate,
  sampled at high volume": adaptive sampling only kicks in at volume, so at a few
  hundred requests the numbers are exact and the old blanket "sampled" read as wrong.

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/demo-callout@0.1.32
  - @substrat-run/demo-manyfold@0.5.7
  - @substrat-run/demo-meridian@0.3.7
  - @substrat-run/engine-invites@0.0.41
  - @substrat-run/engine-protocol@0.5.2
  - @substrat-run/engine-workorder@0.3.42
  - @substrat-run/contracts@0.44.0

## 0.14.2

### Patch Changes

- 602aba0: The dashboard's global error handler flattened every non-`HTTPException` throw to a
  `400`, so an internal control-plane failure surfaced to the browser as a misleading
  `400: internal error` — a server/upstream fault dressed up as the caller's mistake. The
  concrete casualty was the app Observability tab: when the CF token behind the plane's
  observability reader lacks `Workers Observability: Read`, the telemetry query 403s, the
  plane maps it to a genuine `500 internal error`, and the dashboard client wraps that as a
  `ControlPlaneError(500)` — which then collapsed to `400` at `onError`. The `/observability/logs`
  route answered `400` while metrics (a different, working CF API) rendered fine.

  Honor `ControlPlaneError.status` in `onError` instead: a `500` stays a `500`, a `501`
  (observability not configured) stays a `501`, and an unreachable plane (`status 0`)
  becomes a `502`. Plain-`Error` refusals still default to `400` with the existing
  `permission denied` → `403` / `not one of your deployments` → `404` re-maps intact.

## 0.14.1

### Patch Changes

- 8b0b2d8: The generated PR-preview workflow turned every preview job red on a shell-quoting bug,
  and hid the deploy failure underneath it. The comment step built its body with a
  single-quoted `printf` whose prose read `Runs this PR's code` — the apostrophe closed the
  quote and bash died with `syntax error near unexpected token '('`. Reword to drop the
  apostrophe.

  Underneath that, the preview never actually deployed: `preview create` returned
  `400: invalid request` and exited non-zero, but `... | tee preview.out` (no `pipefail`)
  swallowed the exit code, and `grep 'https://…'` then grabbed the wrangler _deploy-endpoint_
  URL as if it were the preview URL — so the job carried on to the (broken) comment step.
  Add `set -euo pipefail` so a failed push fails the step, and take the URL only from the
  CLI's `✓ preview … →` success line.

  Finally, the CLI's HTTP helper threw away the control-plane's Zod `issues` array (reading
  only `.error`), which is exactly why a preview `400` surfaced as a bare, undiagnosable
  `invalid request`. It now appends the failing field paths so the operator can see what was
  rejected.

## 0.14.0

### Minor Changes

- 3d53411: Dashboard: per-scope Audit tab (#479). Each app gains an Audit tab that renders its
  scope's slice of the control-plane admin log — every privileged action against the
  scope, newest first, with cursor pagination and a read-only before/after detail. A pure
  consumer of the audit spine the platform already captures: the tenant-narrowed control
  plane pins `tenantId`, so the viewer can only ever read the caller's own tenant.

### Patch Changes

- 477d472: Observability attributes traffic to the stable serving script, so the per-app
  and team-wide traffic panels stop reading empty. Since #286 a vertical's real
  traffic flows through one stable serving script (`<slug>`, addressed by
  `scope.servingRef`) — not the per-version archive scripts (`<slug>-<ulid>`),
  which only admit and probe a push. Cloudflare records invocations under the
  serving name, but the builder owner-narrowing (`ownedServiceRefs`) only mapped
  the archive refs, so `filter(r => owned.has(r.service))` dropped every
  real-traffic row and the tab showed "No traffic recorded yet" even under live
  load. The map now includes each scope's `servingRef`, stamped with the version
  the scope is bound to (exact for the common single-scope app), and the panel
  copy reads "serving version" rather than "deployed version" to match. Ownership
  is unchanged: serving refs come from this tenant's own `listScopes`, and rows
  outside the map are still filtered out.
- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/demo-callout@0.1.31
  - @substrat-run/demo-manyfold@0.5.6
  - @substrat-run/demo-meridian@0.3.6
  - @substrat-run/contracts@0.43.0
  - @substrat-run/kernel@0.43.0
  - @substrat-run/engine-invites@0.0.40
  - @substrat-run/engine-invoicing@0.4.3
  - @substrat-run/engine-protocol@0.5.1
  - @substrat-run/engine-workorder@0.3.41

## 0.13.1

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/engine-protocol@0.5.0
  - @substrat-run/demo-meridian@0.3.5
  - @substrat-run/demo-callout@0.1.30
  - @substrat-run/demo-manyfold@0.5.5
  - @substrat-run/engine-invites@0.0.39
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/engine-workorder@0.3.40
  - @substrat-run/contracts@0.42.0

## 0.13.0

### Minor Changes

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
- 652657e: Per-PR previews get a platform half: the GitHub App now listens to `pull_request`
  webhooks (`POST /api/github/webhook`, HMAC-gated). The one-click CI setup records a
  durable repo → tenant-app link in a per-repo `GithubRepoLinkDO`; on a PR push the DO
  watches the control plane until CI's `substrat preview create` lands, then posts the
  sticky preview-URL comment itself (same `<!-- substrat-preview -->` marker as the CI
  step, so the two writers upsert one comment); on PR close it reaps the preview fork
  and flips the comment — even when the repo's workflow is stale or CI is red. Builds
  stay in the repo's own Actions: the platform only ever comments and reaps. Needs the
  App's webhook configured (`GITHUB_APP_WEBHOOK_SECRET`) and the `pull_requests: write`
  permission; repos wired before this link existed pick it up on their next setup re-run.

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/demo-callout@0.1.29
  - @substrat-run/demo-meridian@0.3.4
  - @substrat-run/demo-manyfold@0.5.4
  - @substrat-run/engine-protocol@0.4.33
  - @substrat-run/engine-invites@0.0.38
  - @substrat-run/engine-invoicing@0.4.1
  - @substrat-run/engine-workorder@0.3.39

## 0.12.0

### Minor Changes

- 46c7ba2: The Verticals page can remove a pushed vertical, and each card collapses to its
  newest 3 versions. Remove renders only while the vertical is PRIVATE (retiring a
  published one stays a staff decision, mirroring the prod-promotion split) and is
  owned-slug-checked like promote; below the seam the registry refuses while any
  scope still runs the vertical, so a removal can never strand an install —
  deployed dispatch scripts become orphans for cleanup (#248). "All N versions"
  expands the version list in place.

### Patch Changes

- 523448e: Drop the hardcoded sidebar counts (Apps 4 / Domains 3 / Team 4) — design leftovers
  that were never wired to data. With keyset pagination the loaded page length isn't a
  true total either, so the honest sidebar shows no counts at all.
- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0
  - @substrat-run/demo-callout@0.1.28
  - @substrat-run/demo-manyfold@0.5.3
  - @substrat-run/demo-meridian@0.3.3
  - @substrat-run/engine-invites@0.0.37
  - @substrat-run/engine-protocol@0.4.32
  - @substrat-run/engine-workorder@0.3.38

## 0.11.4

### Patch Changes

- 5a2e4b1: Install derives the vertical's own entitlement key when none are declared (#443): a pushed
  vertical whose registry row carries no `entitlements` used to resolve to `[]`, which
  defeated every `?? [slug]` fallback — the installing tenant held zero entitlements and the
  vertical's projected gate failed closed on its very first gated operation. The install spec
  (create, retry, resume) and both provision paths now grant the first non-empty declared set
  or `[slug]` (the `entitlementKey` convention), before the scope provisions, so the
  entitlement delivery that rides provisioning already carries it.
- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0
  - @substrat-run/demo-callout@0.1.27
  - @substrat-run/demo-manyfold@0.5.2
  - @substrat-run/demo-meridian@0.3.2
  - @substrat-run/engine-invites@0.0.36
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/engine-protocol@0.4.31
  - @substrat-run/engine-workorder@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.11.3

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0
  - @substrat-run/demo-callout@0.1.26
  - @substrat-run/demo-manyfold@0.5.1
  - @substrat-run/demo-meridian@0.3.1
  - @substrat-run/engine-invites@0.0.35
  - @substrat-run/engine-invoicing@0.3.36
  - @substrat-run/engine-protocol@0.4.30
  - @substrat-run/engine-workorder@0.3.36

## 0.11.2

### Patch Changes

- deed365: Retire the builtin `manyfold`/`meridian` catalog entries (#389): the tenant-owned
  `substrat-9yjbbn/*` lineages are pushed, staff-listed, and every active builtin install is
  rebound onto them — the marketplace now shows exactly one of each. The builtin registry
  rows persist (installsBlocked) for their archived scopes; the modules stay bundled so
  embedded worlds keep serving existing scopes. Meridian's project pin
  (`substrat.tenant`) is recorded so future pushes land on the tenant lineage.

## 0.11.1

### Patch Changes

- da937c0: Fix a crash on load (React #310): the `oidcProviderSlugs` useMemo introduced in #431 sat below the session-mode early returns, so the hook count changed once the session resolved. Hoisted above the early returns with the other hooks.

## 0.11.0

### Minor Changes

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

- bb7c651: The dashboard's app row heals its vertical lineage on read (#389). A staff
  `rebind-vertical` moves a scope onto a different lineage (builtin `manyfold` →
  tenant-owned `substrat-9yjbbn/manyfold`) and the directory's scope record is the
  source of truth — but the row's `vertical_slug` still named the old lineage, which
  misrouted the per-app Update path (prod channels resolve by slug) and the Apps
  view's version display. The `GET /api/apps` reconcile (the same read that heals a
  stranded `provisioning` row, #424 case 4) now also compares the directory's
  `vertical` against the row's slug and, when they differ, updates the row via a new
  `dashboard/reconcile-app-vertical` operation — same authority as provisioning,
  idempotent, with the move recorded on the Activity trail (`rebound old → new`).
  Best-effort like the mark-active heal: a viewer session lacks the permission and
  the row heals on an owner's next visit. No migration — the column already exists.
- Updated dependencies [1057d15]
- Updated dependencies [a957516]
  - @substrat-run/demo-manyfold@0.5.0
  - @substrat-run/demo-meridian@0.3.0
  - @substrat-run/demo-callout@0.1.25
  - @substrat-run/contracts@0.37.0
  - @substrat-run/kernel@0.37.0
  - @substrat-run/adapter-cloudflare@0.37.0
  - @substrat-run/engine-invites@0.0.34
  - @substrat-run/engine-invoicing@0.3.35
  - @substrat-run/engine-protocol@0.4.29
  - @substrat-run/engine-workorder@0.3.35

## 0.10.6

### Patch Changes

- @substrat-run/demo-callout@0.1.24
- @substrat-run/demo-meridian@0.2.21
- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-cloudflare@0.36.0
- @substrat-run/demo-manyfold@0.4.4
- @substrat-run/engine-invites@0.0.33
- @substrat-run/engine-invoicing@0.3.34
- @substrat-run/engine-protocol@0.4.28
- @substrat-run/engine-workorder@0.3.34

## 0.10.5

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/demo-callout@0.1.23
  - @substrat-run/demo-meridian@0.2.20
  - @substrat-run/demo-manyfold@0.4.3
  - @substrat-run/engine-invites@0.0.32
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/engine-protocol@0.4.27
  - @substrat-run/engine-workorder@0.3.33
  - @substrat-run/adapter-cloudflare@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.10.4

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0
  - @substrat-run/demo-callout@0.1.22
  - @substrat-run/demo-manyfold@0.4.2
  - @substrat-run/demo-meridian@0.2.19
  - @substrat-run/engine-invites@0.0.31
  - @substrat-run/engine-invoicing@0.3.32
  - @substrat-run/engine-protocol@0.4.26
  - @substrat-run/engine-workorder@0.3.32

## 0.10.3

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0
  - @substrat-run/demo-callout@0.1.21
  - @substrat-run/demo-meridian@0.2.18
  - @substrat-run/demo-manyfold@0.4.1
  - @substrat-run/engine-invites@0.0.30
  - @substrat-run/engine-invoicing@0.3.31
  - @substrat-run/engine-protocol@0.4.25
  - @substrat-run/engine-workorder@0.3.31

## 0.10.2

### Patch Changes

- 3cfa709: Env tab: a saved setting reports its delivery honestly instead of a silent no-op

  Saving a deployment setting already delivered it live to the running app
  (`configureInstance` → the vertical's `/internal/configure`), but the Env-tab PUT
  swallowed every delivery failure in an empty `catch {}` and returned `delivered: false`
  with no explanation — while the UI claimed the value "applies on the app's next deploy."
  A save to a vertical with no `/internal/configure` route (its 501), or with no bound
  version, was indistinguishable from success — the "no error anywhere, on either side" of
  issue #374.

  Now the PUT mirrors the sibling auth save: on a delivery failure it returns a readable
  `note` (the 501 case names what to fix — add `/internal/configure` support, bind a
  version), and the Env tab surfaces `delivered`/`note` so a save that could not reach the
  app says so rather than pretending it applied. The banner is corrected too: delivery is
  live per-scope config read at runtime, not a next-deploy binding — env-spec `default:`
  values ride as worker bindings shared across every install, so a per-install override can
  only reach the app through the per-scope channel.

- 5d29ff0: Domains tab: the surface field is always a picker, and Manyfold declares its surface

  Binding a hostname needs a surface, but the picker only rendered as a dropdown when the
  vertical DECLARED its surfaces (package.json `substrat.surfaces` → the registry). A vertical
  that declared none — Manyfold among them — fell back to a bare free-text box with no hint of
  what to type.

  Two changes, one per layer:

  - **Manyfold declares its surface** (`substrat.surfaces: [{ name: 'app', label: 'App' }]`) —
    the canonical source of truth. Manyfold serves one routed surface, `app`; the delivery view
    is a preview inside it, not a separately-routed surface. Reaches the dashboard picker on the
    next push to the tenant.
  - **The dashboard picker is always a dropdown.** Options are the declared surfaces when the
    vertical names them, else the surfaces already bound ∪ the conventional `app`, so an
    undeclared vertical still gets a usable menu instead of a blank box. An "Other…" option
    reveals the free-text field, keeping an undeclared surface valid — declaration is UX, not
    contract (routing.ts).

- Updated dependencies [6801089]
- Updated dependencies [99af6b6]
- Updated dependencies [5d29ff0]
- Updated dependencies [070f4dc]
  - @substrat-run/demo-manyfold@0.4.0
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0
  - @substrat-run/demo-callout@0.1.20
  - @substrat-run/demo-meridian@0.2.17
  - @substrat-run/engine-invites@0.0.29
  - @substrat-run/engine-invoicing@0.3.30
  - @substrat-run/engine-protocol@0.4.24
  - @substrat-run/engine-workorder@0.3.30

## 0.10.1

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [77760b8]
- Updated dependencies [0d79662]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/demo-manyfold@0.3.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0
  - @substrat-run/demo-callout@0.1.19
  - @substrat-run/demo-meridian@0.2.16
  - @substrat-run/engine-invites@0.0.28
  - @substrat-run/engine-invoicing@0.3.29
  - @substrat-run/engine-protocol@0.4.23
  - @substrat-run/engine-workorder@0.3.29

## 0.10.0

### Minor Changes

- d94d0be: Multi-scope M4: a scope switcher on the app Data tab.

  The Data tab browsed only the single app scope, so a multi-scope vertical (Manyfold: one site
  per scope) showed nothing of its other scopes. It now lists the app's scopes and lets you pick
  which one's database to browse. New `GET /api/apps/:scopeId/scopes` returns the tenant's scopes
  for the app's vertical (tenant-narrowed via `TenantNarrowedControlPlane.listScopes` in connected
  mode, `host.admin.listScopes` embedded), and `DataBrowser` renders a scope `<select>` above the
  table list — shown only when an app spans more than one scope, so single-scope apps are
  unchanged. The existing table/row/query reads are keyed off the chosen scope; permissions and
  audit are untouched (they were already per-scope). Listing is a control-plane directory read —
  no vertical cooperation — while each scope's data still goes through the existing per-scope
  introspection.

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

- Updated dependencies [ad4ccbf]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/demo-manyfold@0.2.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0
  - @substrat-run/demo-meridian@0.2.15
  - @substrat-run/demo-callout@0.1.18
  - @substrat-run/engine-invites@0.0.27
  - @substrat-run/engine-invoicing@0.3.28
  - @substrat-run/engine-protocol@0.4.22
  - @substrat-run/engine-workorder@0.3.28

## 0.9.3

### Patch Changes

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

- Updated dependencies [c64bdf8]
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/demo-callout@0.1.17
  - @substrat-run/demo-meridian@0.2.14
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0
  - @substrat-run/demo-manyfold@0.1.15
  - @substrat-run/engine-invites@0.0.26
  - @substrat-run/engine-invoicing@0.3.27
  - @substrat-run/engine-protocol@0.4.21
  - @substrat-run/engine-workorder@0.3.27

## 0.9.2

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/demo-callout@0.1.16
  - @substrat-run/demo-meridian@0.2.13
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0
  - @substrat-run/demo-manyfold@0.1.14
  - @substrat-run/engine-invites@0.0.25
  - @substrat-run/engine-invoicing@0.3.26
  - @substrat-run/engine-protocol@0.4.20
  - @substrat-run/engine-workorder@0.3.26

## 0.9.1

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0
  - @substrat-run/demo-callout@0.1.15
  - @substrat-run/demo-manyfold@0.1.13
  - @substrat-run/demo-meridian@0.2.12
  - @substrat-run/engine-invites@0.0.24
  - @substrat-run/engine-invoicing@0.3.25
  - @substrat-run/engine-protocol@0.4.19
  - @substrat-run/engine-workorder@0.3.25

## 0.9.0

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
  - @substrat-run/adapter-cloudflare@0.26.0
  - @substrat-run/demo-callout@0.1.14
  - @substrat-run/demo-manyfold@0.1.12
  - @substrat-run/demo-meridian@0.2.11
  - @substrat-run/engine-invites@0.0.23
  - @substrat-run/engine-invoicing@0.3.24
  - @substrat-run/engine-protocol@0.4.18
  - @substrat-run/engine-workorder@0.3.24

## 0.8.1

### Patch Changes

- df5fb6e: The app Identity settings no longer refuse a save (or hide the callback URL) when the
  dashboard's own hostname bookkeeping is empty for a fully-reachable app (#294). The
  Settings → Identity card derived the OIDC callback URL solely from the `dashboard_apps.hostname`
  column, so an app that the router serves — and that redirects to OIDC correctly — but whose
  column is null would answer the save with _"this app has no hostname yet"_ and show the card
  as builtin. That column can be null even for a live app.

  - **The dashboard now reads the hostname from the authoritative source when its own copy is
    empty.** A new `resolveDefaultHostname` prefers the stored column but falls back to the app's
    live router bindings (the same control-plane read the Domains tab already uses), picking the
    canonical, active one. Both `/api/apps/:scope/auth` routes use it, so the callback URL forms —
    and the save succeeds — whenever the app genuinely has a hostname bound, regardless of whether
    the dashboard happened to record it.

  - **Provisioning stops discarding a hostname it successfully bound.** In both the connected and
    embedded paths the primary `bindHostname` and its follow-up `setHostnameStatus`/secondary-surface
    binds shared one `try` whose `catch` swallowed everything and returned null — so a transient
    activation error after a successful bind stranded the dashboard's record (a null column) while
    the app ran fine. Once the primary bind succeeds the hostname is now returned regardless of any
    best-effort step failing after it.

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0
  - @substrat-run/demo-callout@0.1.13
  - @substrat-run/demo-meridian@0.2.10
  - @substrat-run/demo-manyfold@0.1.11
  - @substrat-run/engine-invites@0.0.22
  - @substrat-run/engine-invoicing@0.3.23
  - @substrat-run/engine-protocol@0.4.17
  - @substrat-run/engine-workorder@0.3.23

## 0.8.0

### Minor Changes

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

- 5fda01e: The app Overview now lists every surface's public URL, not just the default one. A
  vertical that fronts more than one surface (K-26 — the Egeryds EKA shape) had its second
  surface's hostname reachable only from Settings → Domains; the Overview's Production card
  and the header's Visit button both hardcoded the app row's single default hostname
  (surface `app`), so the second URL was invisible on the page the dashboard links to.

  Overview reads the app's full hostname bindings (the same source the Domains tab uses)
  and renders one URL row per surface — each surface's canonical active binding, the
  default surface first, then the vertical's declared surface order — tagged with the
  surface name and label. The OpenAPI / API-docs row stays single: the API is one per app,
  surfaces are UI skins of the same vertical. The header's Visit button becomes a dropdown
  of surfaces when there is more than one, a plain button otherwise. Single-surface apps
  are unchanged, and when the hostnames endpoint isn't backed (embedded/dev) the render
  falls back to the single default hostname.

- d1022d0: Export & import moved from the Previews tab to the Data tab. It operates on the app's
  data wholesale, so Data is where a user looks for it; its only tie to Previews — the
  safety preview an import forks first — is now named in the success message ("… in the
  Previews tab") instead of relying on the list being on the same screen. The Previews
  tab refetches on open, so the explicit refresh callback is gone.
- Updated dependencies [72b1128]
- Updated dependencies [92d1aa1]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [d4bf108]
- Updated dependencies [f610140]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/demo-callout@0.1.12
  - @substrat-run/demo-meridian@0.2.9
  - @substrat-run/demo-manyfold@0.1.10
  - @substrat-run/engine-invites@0.0.21
  - @substrat-run/engine-invoicing@0.3.22
  - @substrat-run/engine-protocol@0.4.16
  - @substrat-run/engine-workorder@0.3.22

## 0.7.0

### Minor Changes

- 22b1f97: Export & import from the dashboard (preview-and-snapshots.md §8's dashboard half):
  the Snapshots tab grows an Export & import card. Export downloads the app's data as
  a `.dump.json` the CLI's `scope restore` also accepts — in connected mode it arrives
  PII-masked from the control plane's governed export route (the full-fidelity
  break-glass stays a CLI/staff affordance); embedded mode returns the full read
  (`masked: false`), since the host's files already sit on the operator's own disk.
  Import replaces the app's data wholesale with an uploaded dump (a pulled export or a
  locally built world), always forking a TTL'd safety copy first so the pre-restore
  state survives as a snapshot to back out to. Both halves gate on
  `dashboard:provision-app` in the caller's own scope and land on the app's activity
  trail as `data-exported` / `data-restored` (migration 0008 widens the event CHECK,
  rebuild-and-copy like 0005/0007). New tenant-narrowed CP wrappers `exportScope` /
  `restoreScope` reach the existing staff routes over the service binding.

### Patch Changes

- 6a22014: The app Deployments tab no longer dead-ends a builder on their own vertical. The
  per-app deployments read now says whether the app's vertical is one the tenant
  pushed (`owned`, with the real `listed` flag alongside), and the tab words itself
  accordingly: for an owned private vertical the banner says promotion is self-serve
  and links to the Verticals page instead of claiming prod is a staff action (true
  only for listed/foreign verticals). When the newest admitted version isn't what
  prod points at — the exact state where no "Update to latest" can be offered — the
  Running card now explains why and links to the promote button (or names the staff
  handoff, for the non-owned case) rather than showing nothing.
- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/demo-callout@0.1.11
  - @substrat-run/demo-manyfold@0.1.9
  - @substrat-run/demo-meridian@0.2.8
  - @substrat-run/engine-invites@0.0.20
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/engine-protocol@0.4.15
  - @substrat-run/engine-workorder@0.3.21
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.6.0

### Minor Changes

- a7d30b2: The app's Identity choice is visible and editable after install, and identity failures
  read as instructions. Install now AUTHORS the delivered `substrat:auth` config in the
  dashboard's own store (new `dashboard/set-app-auth` / `dashboard/get-app-auth` ops on the
  reserved `substrat:*` key namespace, hidden from the Env tab), so a Settings-tab Identity
  card can show the wired issuer and client id — clientSecret write-only, blank keeps the
  stored one — and switch issuers via `PUT /api/apps/:scopeId/auth`, which reports honestly
  whether the running app received the change (`delivered: false` + a readable note when the
  deployment answers 501, instead of an error or a silent fake success). A failed identity
  step at install now records an ACTIONABLE reason on the Activity trail — a 501 from the
  app's deployment (no live-config support, the sesamy-crm incident) says to retry with
  Builtin identity or add `/internal/configure` to the vertical, rather than relaying the
  deployment's bare status line.

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/demo-meridian@0.2.7
  - @substrat-run/demo-manyfold@0.1.8
  - @substrat-run/demo-callout@0.1.10
  - @substrat-run/engine-invites@0.0.19
  - @substrat-run/engine-invoicing@0.3.20
  - @substrat-run/engine-protocol@0.4.14
  - @substrat-run/engine-workorder@0.3.20

## 0.5.5

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/demo-callout@0.1.9
  - @substrat-run/demo-manyfold@0.1.7
  - @substrat-run/demo-meridian@0.2.6
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/engine-invites@0.0.18
  - @substrat-run/engine-invoicing@0.3.19
  - @substrat-run/engine-protocol@0.4.13
  - @substrat-run/engine-workorder@0.3.19

## 0.5.4

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/demo-callout@0.1.8
  - @substrat-run/demo-manyfold@0.1.6
  - @substrat-run/demo-meridian@0.2.5
  - @substrat-run/engine-invites@0.0.17
  - @substrat-run/engine-invoicing@0.3.18
  - @substrat-run/engine-protocol@0.4.12
  - @substrat-run/engine-workorder@0.3.18

## 0.5.3

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/demo-callout@0.1.7
  - @substrat-run/demo-manyfold@0.1.5
  - @substrat-run/demo-meridian@0.2.4
  - @substrat-run/kernel@0.19.0
  - @substrat-run/engine-invites@0.0.16
  - @substrat-run/engine-invoicing@0.3.17
  - @substrat-run/engine-protocol@0.4.11
  - @substrat-run/engine-workorder@0.3.17

## 0.5.2

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/demo-callout@0.1.6
  - @substrat-run/demo-manyfold@0.1.4
  - @substrat-run/demo-meridian@0.2.3
  - @substrat-run/engine-invites@0.0.15
  - @substrat-run/engine-invoicing@0.3.16
  - @substrat-run/engine-protocol@0.4.10
  - @substrat-run/engine-workorder@0.3.16

## 0.5.1

### Patch Changes

- @substrat-run/demo-callout@0.1.5
- @substrat-run/demo-meridian@0.2.2
- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0
- @substrat-run/demo-manyfold@0.1.3
- @substrat-run/engine-invites@0.0.14
- @substrat-run/engine-invoicing@0.3.15
- @substrat-run/engine-protocol@0.4.9
- @substrat-run/engine-workorder@0.3.15

## 0.5.0

### Minor Changes

- 0caa0a9: No more local sign-in screens: a signed-out visit hands straight off to the IdP.

  Both platform apps rendered their own branded sign-in card before redirecting to
  AuthHero — an extra screen that authenticated nothing. Now the SPA redirects to
  `/api/auth/login` as soon as the session check comes back empty, preserving the
  intended destination via `returnTo`. The local card survives only as the
  `?error=auth` retry screen (auto-redirecting after a failed round-trip would loop).

  Sign-out is now always federated (`/api/auth/logout?federated`): with signed-out
  visits auto-redirecting to the IdP, a logout that left the IdP's SSO cookie alive
  would silently sign the user right back in. This also fixes the invite-mismatch
  "sign out & continue as the invited email" path, which could previously re-login
  as the wrong account.

  Deploy note: each app's origin (`https://app.substrat.net/…`,
  `https://console.substrat.net/…`) must be registered as an allowed logout URL on
  its AuthHero client — the invite flow uses dynamic `/invite/<token>` return paths,
  so a path wildcard is needed.

### Patch Changes

- 0a7e1a7: The generated GitHub deploy workflow installs dependencies before pushing.

  One-click deploy setup committed a workflow that ran `substrat push` on a bare
  checkout — wrangler's custom build (the repo's own `tsc`) then failed on missing
  devDependencies, the first push never landed, and the vertical silently never
  appeared (registration happens on first successful push). The workflow now
  installs from the repo's lockfile (pnpm/yarn via corepack, `npm ci`, `npm install`
  fallback) and runs on Node 22 — corepack floats to latest pnpm for repos without a
  `packageManager` pin, and pnpm 11 needs Node ≥ 22.13. The generator moved to
  `github.ts` so the committed file, the manual copy-paste path, and the tests all
  share one source.

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [0caa0a9]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/oidc-rp@0.4.0
  - @substrat-run/demo-callout@0.1.4
  - @substrat-run/demo-manyfold@0.1.2
  - @substrat-run/demo-meridian@0.2.1
  - @substrat-run/engine-invites@0.0.13
  - @substrat-run/engine-invoicing@0.3.14
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/engine-workorder@0.3.14

## 0.4.0

### Minor Changes

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

### Patch Changes

- e83ba3c: The Apps overview no longer flashes the wrong screen while the first `listApps()` is in
  flight: the list shows a skeleton (same geometry as the loaded page — title row, toolbar,
  3-column card grid — so nothing jumps when data lands) instead of "Create your first
  app", and a deep link to an app shows the skeleton instead of a flashed "app could not
  be found". In the dev preview, `?loading=1` pins the skeleton (like `?onboarding=1`).
- 15853bf: Create-app URL preview now shows the tenant-suffixed hostname. The page promised
  `<app>.global.substrat.run` while provisioning actually binds
  `<app>-<team>.global.substrat.run` (the tenant-suffix scheme in `bindDefaultHostname`).
  The preview now mirrors the worker — same `slugify` on the current team's name,
  falling back to the unsuffixed form for teamless sessions.
- ea8fed4: Self-heal pre-roster teams: teams provisioned before #191 have an empty
  `dashboard_members` table (no owner row), so every roster-gated move — delete
  the organization, the Members tab, invites — refused its own owner with a 403.
  `resolveAccount` now seeds the resolving caller as the owner row (plus the
  invites entitlement and org) for pre-epoch tenants, gated by ULID timestamp and
  memoized per isolate so post-fix teams never pay a read.
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

- Updated dependencies [cd32011]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/oidc-rp@0.3.0
  - @substrat-run/demo-meridian@0.2.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/demo-callout@0.1.3
  - @substrat-run/demo-manyfold@0.1.1
  - @substrat-run/engine-protocol@0.4.7
  - @substrat-run/engine-invites@0.0.12
  - @substrat-run/engine-invoicing@0.3.13
  - @substrat-run/engine-workorder@0.3.13

## 0.3.1

### Patch Changes

- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1
  - @substrat-run/adapter-cloudflare@0.14.1
  - @substrat-run/engine-invites@0.0.11
  - @substrat-run/engine-invoicing@0.3.12
  - @substrat-run/engine-protocol@0.4.6
  - @substrat-run/engine-workorder@0.3.12

## 0.3.0

### Minor Changes

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

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.
- a1c7649: **Real running version on the app Overview.** The Overview tab hardcoded `v0.0.1` (and "Last
  deploy just now"); it now reads the app's actual running version — the version its scope is
  bound to (what the router serves) — from the same source as the Deployments tab. Shows an
  "update available" hint (linking to Deployments) when prod has moved past what the app runs.
- 21ebd1e: **Manyfold — a multi-scope headless CMS demo vertical.** A sandbox-clean, deployable vertical
  where **site = scope**: one install, many sites. The vertical owns the editorial lifecycle
  (draft→in_review→approved→published state machine that can't skip, append-only revisions,
  freeze-on-publish with a content hash, a delivery surface that resolves references — a
  draft/archived target comes back explicitly unresolved). **Content types are data**, authored
  in a model builder (`save-type`/`list-types`), each compiling to a reviewable migration
  (never a live ALTER); bodies persist as JSON so adding a field is free.

  Ships the full app: content editor + workflow, the model builder (models, field editor,
  relationship map, migration preview), and Members & roles — all URL-routed so a refresh
  restores the view. Auth is the tenant's own `IdentityDO` (Better Auth): first sign-in claims
  the owner seat (→ admin), then **member invites** (mint a principal, grant a role at scope
  level, share an accept link) open the post-setup join path. The deployable worker is
  sandbox-clean (own `ScopeDO` + `IdentityDO`, SPA inlined, no privileged bindings).

  Also fixes permission-denial status on the Cloudflare DO adapter: an op's error crosses the
  `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof PermissionDenied`
  was false and denials degraded to 400 — now matched by message too, so denials are 403 on
  the worker as in node.

  Registers Manyfold in the dashboard catalog (`connected`) and bundles its module in the
  dashboard worker.

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

- Updated dependencies [6a7768a]
- Updated dependencies [21ebd1e]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/demo-manyfold@0.1.0
  - @substrat-run/demo-meridian@0.1.1
  - @substrat-run/demo-callout@0.1.2
  - @substrat-run/engine-invites@0.0.10
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/engine-workorder@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.2.0

### Minor Changes

- f9561dd: **Real per-app audit trail on the app overview.** The Activity panel showed demo data; it now
  renders real lifecycle events — `created` / `active` / `failed` / `deleted` — recorded per app.
  Crucially, a failed provision now records its **reason** (e.g. "no deployment is bound for vertical
  'meridian'") to the trail instead of only flashing a toast, so you can see _why_ an install failed
  on the app's own page.

  - New `dashboard_app_events` table (migration `0004`) + a `dashboard/app-events` read op (gated by
    the existing `dashboard:read`). The lifecycle ops append events; `mark-app-failed` takes the
    reason, threaded through from `createApp`'s failure path.
  - Worker `GET /api/apps/:scopeId/events`; web `api.appEvents`; `AppDetail`'s Activity panel wired to
    it (with a `danger` timeline dot for failures, loading + empty states).

  Contains a **migration** (`dashboard` `0004-app-events`) for the checkpoint review.

- 7941c4c: **Real per-app Deployments tab.** The app overview's Deployments tab showed demo data; it now reads
  the app's vertical version registry live — every pushed version, its admission state, which channels
  point at it, and (prominently) **which version the app runs** (the `prod` channel). So "am I on
  0.0.9?" is answerable: if you pushed 0.0.10 but only 0.0.9 is promoted to prod, the tab shows prod =
  0.0.9 and 0.0.10 sitting admitted-but-unpromoted.

  - `verticalDeploymentFromCp` / `verticalDeploymentFromHost` (by slug, so it works for a PLATFORM
    vertical the tenant doesn't "own" — unlike the tenant-level Deployments list).
  - Worker `GET /api/apps/:scopeId/deployments`; web `api.appDeployments`; `AppDetail`'s Deployments
    tab wired to it (running-version banner + a real version/admission/channels table).
  - Read-only: promotion for a platform vertical stays a staff action; this just surfaces the truth.

  No new permission (reuses `dashboard:read`) and no migration.

- e8325e6: **Update an installed app to a newer version — and show the version it _actually_ runs.**

  Promoting a vertical's `prod` channel moves the channel pointer; it does **not** rebind
  scopes already installed — the router dispatches on each scope's _pinned_ version, set at
  install time. So an app installed when prod was 0.0.9 keeps serving 0.0.9 after prod moves
  to 0.0.12, with no way to move it. This closes that gap:

  - **Truthful "Running"** — the Deployments tab now reads the scope's actual bound version
    (`Scope.verticalVersionId`) and marks it, instead of assuming the prod channel is what
    runs. "Am I on 0.0.9?" is now answered by what the router serves, not what prod points at.
  - **"Update to latest"** — a per-app action (`POST /api/apps/:scopeId/update` → `updateApp`)
    that rebinds the scope to the vertical's current prod version and records an `updated`
    event on the Activity trail. Idempotent (a no-op when already current); authorized
    in-scope on the caller's `dashboard:provision-app` grant.

  Adds migration `0005-app-updated-event` (widens the app-events `kind` CHECK to include
  `updated`; table rebuild, 0004 untouched). No new permission key (reuses `provision-app`).

- 2add91f: Fix the invite → sign-in → accept flow so an invited person lands in the team, not on "create a team".

  - **Carry the invite through auth.** An unauthenticated invite click now round-trips through OIDC using the RP's existing `returnTo` (the callback returns to `/invite/<token>`), instead of stashing the token in `localStorage`. The accept always runs with a session in hand, so a first-time invitee joins the team rather than falling through to onboarding.
  - **Prefill + sign-up hint.** `@substrat-run/oidc-rp` `beginLogin` / `/api/auth/login` now forward `login_hint` (prefill the invited email) and an allowlisted `screen_hint` (default `signup` for invite links). Both are IdP-standard and backward-compatible for the console.
  - **Preview endpoint.** New unauthenticated `GET /api/invites/preview?token=` (backed by a no-permission `dashboard/preview-invite` op — the signed token is the authority, like accept) returns the team name + invited email for the prefill and the accept screen. It reveals only that invite's own address; access still requires the verified-email hash at accept.
  - **Graceful mismatch.** Following an invite while signed in as a different verified email now shows a clear "this invite is for X" screen with sign-out, instead of the confusing onboarding dead-end.

- b346b6c: Send team-invitation emails from the Dashboard via a new notification-transport adapter.

  - **`@substrat-run/adapter-email`** — a new host-plane adapter (D-18: a notification transport is infra the host consumes, not a tenant connector). One `EmailTransport` port with swappable implementations: `CloudflareEmailTransport` (the `send_email` Workers binding — default) and `MockEmailTransport` (dev/CI). The port owns the deliverability invariants (both html + text, a subject, a valid recipient) so no implementation can drop them.
  - **Dashboard** — `POST /api/members/invite` now emails the invitee their accept link. The send happens in the request path, where the raw address is in hand: the invites engine hashes the identifier and `invites.sent` carries only the hash, so no outbox executor could recover an address to send to. Delivery is best-effort — a committed invite is never rolled back on a send failure (`emailDelivered: false` is reported and the `acceptUrl` is still returned for a manual resend). Adds the `send_email` binding + `EMAIL_FROM` config.

- 421348f: Add a **Resend** action for pending team invites.

  - **Module** — new `dashboard/resend-invite` in-scope operation. It re-mails an outstanding invitation using the address kept in the readable roster (the invites engine stores only a hash), re-checks `manage-members` **and** the §5.1 role bound, and re-composes the engine's `sendInvite` — idempotent for a still-open invitation (same id) and a fresh one if it lapsed — re-pointing the projection at the live invitation. Returns `null` when there is no such pending invite.
  - **Worker** — new `POST /api/members/resend-invite`. The initial invite and the resend now share one `mailInvite` helper that mints a fresh accept link and sends the message best-effort. That helper counts a recipient as delivered when Cloudflare Email Service returns it in either `delivered` **or** `queued` (the service is asynchronous, so a successful send is `queued`, not `delivered`).
  - **Dashboard UI** — a Resend button beside Revoke on invited rows, with success/failure toasts (a failed send points the admin to the shareable link).

### Patch Changes

- 90e94c3: **The marketplace only offers verticals the running mode can actually provision — so it stops advertising an install that always fails.**

  Adding Meridian to the catalog made it appear installable everywhere, but the hosted
  dashboard runs in **connected mode**, where the shared control plane provisions via a
  static `VERTICAL_<slug>` binding or a promoted dispatch-namespace version — and Meridian
  has neither yet, so every install 501s ("no deployment is bound for vertical 'meridian'").
  The user was offered something that couldn't be installed.

  - Catalog entries now carry a `connected` flag; `GET /api/catalog` hides `connected: false`
    entries when a shared control plane is bound, and lists everything in embedded/standalone
    (which bundles each module in-process). Meridian is flagged `connected: false` until it is
    deployed + promoted to prod.
  - The create-app marketplace tiles are filtered to slugs the live catalog actually offers, so
    a hidden vertical can't be picked — previously `resolveSlug` would have silently substituted
    a different vertical for a tile whose slug wasn't advertised.
  - The catalog map + availability rule move to a Cloudflare-free `catalog.ts` so the gating is
    unit-tested (embedded lists Meridian; connected hides it; unknown slugs never appear).

- b1af840: Verify an invite is for the signed-in email before accepting it. An existing member — typically the team owner — who opened an invite meant for someone else was silently switched into the team by the server's "already a member" shortcut, never learning the invite wasn't theirs. The accept flow now fetches the invite preview and compares the invited email to the signed-in email first; on a mismatch it shows the "this invite is for X" screen instead of accepting or switching. That screen's "sign out" carries a `returnTo` back to the invite link (`@substrat-run/oidc-rp` `/api/auth/logout` gains same-origin `returnTo`), so after signing out the user re-enters the invite unauthenticated and gets the sign-up screen prefilled with the invited email.
- 2ccfc74: **Offer Meridian in the hosted marketplace.** Meridian is deployed to the `substrat-verticals`
  dispatch namespace and promoted to prod, so its catalog `connected` flag flips to `true` — the
  `/apps/new` marketplace now lists it and installs provision a real instance. (It was `connected:
false` while it wasn't yet deployable, which is why the tile was hidden even though the CLI showed
  the version admitted.) Requires redeploying the dashboard.
- 90e94c3: **Wire the "Retry" action on a failed app — it re-provisions for real instead of a placeholder toast.**

  The Retry link on a `failed` app card was a stub (`setToast({ title: 'Retry not wired yet' })`).
  It now calls a new `POST /api/apps/:scopeId/retry`, which best-effort tears down the failed
  attempt and re-provisions fresh under a new scope with the same vertical + name, via the proven
  `createApp` path. A retry that still can't come up re-marks the row `failed` and surfaces the
  **real** provisioning error, so the button re-tries for real and stops hiding why an install
  failed. The re-provision logic is a testable `retryApp` in `provision.ts` (composing
  `deprovisionApp` + `createApp`); a regression test drives failed-install → retry → a fresh live
  scope. Only a `failed` app is retryable, and only the caller's own (list-apps is tenant-scoped).

  Note: this fixes the _recovery_ path, not the reason a Meridian install fails in connected mode —
  the shared control plane provisions via the `substrat-verticals` Workers-for-Platforms dispatch
  namespace, and Meridian has not been deployed there / promoted to a prod version yet. Until it is,
  Retry will surface that provisioning error rather than succeed.

- 9087052: Move the Dashboard toast from top-right to bottom-right so it no longer overlays the "new app" button.
- e78c86e: **Fix "scope slug 'x' already taken" when installing an app in connected mode.** The shared-plane
  provisioning used `slugify(name)` as the scope slug, which must be unique within a tenant — so a
  second app with the same name, or a fresh attempt after a failed one left an orphaned scope (a
  failed provision marks the row failed but doesn't release its shared-plane scope), collided. The
  scope slug now includes the scope-id tail (`meridian-abc123`); the bound hostname still prefers the
  clean name (`meridian.global.substrat.run`), falling back to the unique slug only on a global collision.
- b1af840: **Meridian is installable from the dashboard marketplace, and usable from an empty install.**

  Meridian (the HR vertical) can now be provisioned as an app from the tenant dashboard,
  the same embedded-catalog seam Callout uses, and a freshly-installed (empty) instance
  is set up from zero through a new in-app Admin surface.

  - **Marketplace wiring.** `@substrat-run/demo-meridian` gains a worker-safe `./module`
    export (its domain module + perms only, never the node/better-auth seed), mirroring
    Callout. The dashboard worker bundles `meridianModule` into its `ScopeDO` and adds a
    `meridian` catalog entry — SKU `['meridian', 'protocol']`, owner granted the `hr-admin`
    permission set so the installer can run the app from day one. Meridian is added to the
    frontend marketplace list, vertical metadata, and dev-mock catalog. A new dashboard
    scenario test provisions a real Meridian app and drives `hr/define-leave-type` +
    `hr/create-employee` on the empty scope — the first-run path, proven end to end.

  - **First-run onboarding (the Admin section).** An installed instance starts empty (no
    leave types, people or projects). The app gains an hr-admin-only **Admin** section — a
    first-run setup checklist plus screens to define leave types (with SE/ES statutory
    presets, spec §6), add employees, create projects, and generate the per-period
    **payroll export** (the §7 boundary). Every screen carries proper empty/loading/error
    states and accessible form labels; permission is still checked in the kernel on every
    op, so a non-admin reaching these calls is refused (verified: a manager defining a
    leave type gets `403 permission denied: absence:configure`).

  GDPR employee erasure (spec §8) remains a deliberate follow-up: crypto-shredding is keyed
  off event `piiClass`/`subjectId` at the kernel/lake level, and there is no vertical-callable
  erase primitive yet — a table-only version would look structural without being so, so it is
  left unbuilt rather than faked.

- Updated dependencies [6721e1b]
- Updated dependencies [32abe73]
- Updated dependencies [2add91f]
- Updated dependencies [b1af840]
- Updated dependencies [b346b6c]
- Updated dependencies [12acc59]
- Updated dependencies [57b1cfe]
- Updated dependencies [b1af840]
- Updated dependencies [fa0707c]
- Updated dependencies [e774c01]
- Updated dependencies [cfbcc6c]
- Updated dependencies [74c9d7b]
- Updated dependencies [6a0e253]
  - @substrat-run/adapter-email@0.1.0
  - @substrat-run/demo-meridian@0.1.0
  - @substrat-run/demo-callout@0.1.1
  - @substrat-run/oidc-rp@0.2.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invites@0.0.9
  - @substrat-run/engine-invoicing@0.3.10
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/engine-workorder@0.3.10

## 0.1.0

### Minor Changes

- 949cbb3: **Deployments view — the builder-facing mirror of the console (builder-plane.md Phase 4).**
  A customer now sees the verticals they pushed, right in their dashboard: each version's
  admission state and which channel points where, and can self-serve `dev`/`staging`
  promotion. Production stays a staff decision (model B) — shown, not actionable.

  - **`GET /api/deployments`** — the tenant's own verticals (`ownerTenant === tenant`), each
    with its versions + channels. Connected mode reads the shared control plane
    (tenant-filtered); embedded reads the local host. The tenant is the caller's own, from
    their session — never a request argument.
  - **`POST /api/deployments/:slug/promote`** — points a NON-prod channel at a version.
    `prod` is refused (403 — "promoted by the Substrat team"), and the slug is verified to be
    one of the caller's **own** deployments first (a slug you don't own reads as 404), so the
    dashboard's staff-level service token can't be used to touch another tenant's vertical.
  - **The view** (`Deployments.tsx`, a new sidebar entry) — per vertical, a version table with
    admission pills, the channels each version holds, and `→ dev` / `→ staging` buttons
    (enabled only for an admitted version). The `<tenantSlug>/` prefix is stripped for
    display; a builder sees the bare name they pushed.

  The CP client (`TenantNarrowedControlPlane`) gains `listVerticals` (tenant-filtered),
  `listVersions`, and `promote`; the assembly + ownership check live in a testable
  `deployments.ts`.

  Verified: dashboard suite (14) incl. new assertions — a tenant sees only its own verticals
  (not platform, not another tenant's), shaped with channels and newest-first versions, and a
  slug it doesn't own is not promotable; `pnpm -r typecheck` and the web build both pass.

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/architecture/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- 6678b4d: **Delete app — real deprovisioning, replacing the front-end stub.**

  "Delete app" navigated away and toasted success while doing nothing — no API call, no route, no deprovision. Now it deprovisions for real, tenant-narrowed, the mirror of create.

  - **`dashboard/delete-app` operation** (migration `0002` adds a nullable `deleted_at` — soft delete, so the account's record/audit history is retained; `list-apps` hides deleted rows). Same authority as creating an app (`dashboard:provision-app`) — no new permission key.
  - **`deprovisionApp`** (provision.ts): authorize + soft-delete in the caller's dashboard scope, then take the app scope **offline** — `suspendScope` (reversible, fails `getScope` closed) + the hostname → `failed` so the router stops resolving it. Connected mode goes through the tenant-narrowed control-plane seam (new `suspendScope`); embedded through the local host.
  - **`DELETE /api/apps/:id`** resolves the app from the caller's _own_ apps only, then deprovisions. Client `api.deleteApp(id)`; the UI awaits it and toasts success only on success (failure shows the error).

  **Migration checkpoint:** `dashboard_apps` gains `deleted_at` (append-only ALTER; no enum/table rebuild).

  Verified: dashboard suites pass (11), including a new scenario test — deleting an app drops it from the list and suspends its scope (`getScope` then fails closed).

- 7a64c3b: **The Dashboard — M0 of the tenant-facing self-service surface (docs/architecture/dashboard.md).**

  "Vercel, but for Substrat," built AS a Substrat vertical. M0 is the core self-service loop, proven
  end to end:

  - **The vertical** (`module.ts`): `dashboard:provision-app` / `dashboard:read`, a `dashboard_apps`
    table, and the ops. It owns the account's own record + permissions; it does not provision.
  - **The authority seam** (`provision.ts`): `provisionDashboard` (sign-up bootstrap) and `createApp`
    — authorizes in-scope (`dashboard/provision-app` asserts the key), then effects `provisionScope`
    into the caller's OWN tenant, read from their dashboard node, never a request argument.
    Cross-tenant is impossible by construction (the #97 move). A finding baked in: `provisionScope`
    is a `ScopeHost` action, not `HostAdmin`, so the effect lives in app-level code holding a
    `ScopeHost` — no kernel change.
  - **The worker** (`worker.ts`): Better Auth on D1; **first login bootstraps the customer's own
    tenant + dashboard scope + owner** (self-service sign-up); `GET /api/me`, `GET /api/apps`, and
    `POST /api/apps` (create an app in your tenant, from the session). A stub catalog.

  Verified: the authority unit test (owner provisions a live app in their tenant; unauthorized
  refused; cross-tenant refused even by forging the node), and the full HTTP flow on real `workerd`
  (sign up → account bootstrapped → create a running app → list), including isolation — a second
  customer gets their own tenant and sees none of the first's apps. In the permission checkpoint.

  **M0.3 — a registry-backed catalog** (`GET /api/catalog` from `listVerticals`; `ensureCatalog` seeds `registerVertical` — the same registry the operator console will use) **and a clickable SPA** (a dependency-free page: sign in → pick a vertical → create → see your apps), verified on workerd.

  **Remaining (beyond M0):** members, custom domains, connections; and the production topology — each app a separate vertical deployment provisioned via the control plane (M0 runs them in one deployment).

- 4430841: **A failed create is loud, not a silent `provisioning`.** When provisioning didn't
  complete (the vertical refused, a hostname wouldn't bind, the shared plane was
  unreachable), the app row was left at `provisioning` forever — indistinguishable from
  "still coming up".

  - **`dashboard/mark-app-failed`** op — `createApp` marks the row `failed` when the effect
    throws (guarded to only move a `provisioning` row), then re-throws the original error.
  - **The dashboard surfaces it** — `createApp` in the UI now catches, reloads (so the
    `failed` row shows), and shows an error toast with the reason instead of an unhandled
    rejection.

  Verified: dashboard suites pass (12), including a new test that a create whose effect
  throws leaves the row `failed`, not `provisioning`.

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

- b4420fb: **Fix the AuthHero OIDC login path end to end.**

  Three faults surfaced bringing the Dashboard's OIDC sign-in live on `app.substrat.net`:

  - **The callback swallowed every failure** (`@substrat-run/oidc-rp`): a bare `catch`
    redirected to `/?error=auth` with no trace, so a failing login was undiagnosable in
    prod. It now logs a structured `oidc.callback.failed` with the reason — and, on a
    non-2xx token exchange, the authority's own error body (the error path only, never
    the token response, so nothing secret leaks) — and `observability` is enabled on the
    dashboard worker so the log actually lands. Console/control-plane inherit the
    non-swallowing behaviour through the shared package.
  - **The slug rejected OIDC subjects** (`worker.ts`): `slugFor` fed the raw subject
    (`auth0|46906645…`) into a tenant slug that forbids `|`, so every first login 400'd at
    `createTenant` during JIT bootstrap. The subject is now stripped to its slug-safe tail
    (never hit under Better Auth, whose ids were plain alphanumeric).
  - **A dead identity-pool registration** (`provision.ts`): `provisionDashboard` still
    registered a `better-auth` pool — removed, now that the provider is `authhero`.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f5933ec]
- Updated dependencies [9a34950]
- Updated dependencies [cc5f2ca]
- Updated dependencies [847b506]
- Updated dependencies [f2428a9]
- Updated dependencies [66e752b]
- Updated dependencies [aa786b7]
- Updated dependencies [d83f521]
- Updated dependencies [0ae7d0f]
- Updated dependencies [518ea07]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-cloudflare@0.12.0
  - @substrat-run/demo-callout@0.1.0
  - @substrat-run/oidc-rp@0.1.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9
