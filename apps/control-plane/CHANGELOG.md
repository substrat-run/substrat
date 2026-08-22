# @substrat-run/control-plane

## 0.13.1

### Patch Changes

- Updated dependencies [812c323]
  - @substrat-run/control-plane-api@0.85.0
  - @substrat-run/contracts@0.85.0
  - @substrat-run/kernel@0.85.0
  - @substrat-run/adapter-cloudflare@0.85.0
  - @substrat-run/connector-scrive@0.13.1

## 0.13.0

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
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [fabe51d]
- Updated dependencies [7c58211]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-cloudflare@0.84.0
  - @substrat-run/control-plane-api@0.84.0
  - @substrat-run/connector-scrive@0.13.0

## 0.12.0

### Minor Changes

- 15df906: Updating a permission on an existing connection no longer means re-typing a working credential.

  The entry above this one closed three quarters of #726 and said plainly that this quarter was
  not built. This is that quarter.

  A connection's grants could only ever be written **alongside a credential**. Both writing doors —
  the dashboard's connect flow and the tenant relay — write the secret and then loop `grants`, so
  the remedy for "a capability is missing" was "re-submit your Scrive credential", on a rotation
  path that, done wrong, replaces a working one. And the #592 reconcile did not help, though it
  looked like it should: it gathers grants that **already exist** as directory rows and delivers
  them to scopes. It repairs a dropped _delivery_; it never creates a grant that was never made.

  So `protocol:attach` sat missing on a live connection for months (#716) with no proportionate way
  to add it — and once the read-back landed, the situation was that an operator could finally _see_
  the problem and still had only the disproportionate repair.

  ## Heal first, gather second

  `reconcileConnectionGrants` runs before the gather on both the reconcile route and
  provision-instance, so no path can forget it. A key the connector declares and the connection
  does not hold is granted **tenant-wide** — materialized per scope by the existing #592 machinery,
  so it reaches installs that do not exist yet — and the lever that applies it is the one operators
  already reach for, the idempotent re-provision. A connector that declares a new grant delivers it
  on the next reconcile.

  Best-effort by contract: healing reaches the directory, and a failure there must never take down
  the reconcile it rides on. A bad pass leaves exactly the behaviour that shipped before it existed.

  ## Why this is not the button that was declined

  The distinction is the whole reason this one is legitimate, so it is worth stating rather than
  assuming.

  A grant-only write route would let a person add an arbitrary permission to a connection from a
  console: an authority decision, taken by someone, with no tenant principal behind it — precisely
  the laundering `connections.md` §3.5.1 forbids.

  This decides nothing. It materializes a requirement the **connector declared in code**, exactly
  as a module's declared schedules are projected as `system:<moduleId>` grants at provisioning. No
  one chose it, so there is no act to attribute, and the platform actor on `grantedBy` is honest
  rather than a stand-in for a person. What a connection may do still follows from a declaration
  that lands in a diff — it simply no longer needs a credential to deliver.

  ## A floor, never a ceiling

  Declared keys are granted; nothing is ever revoked. A connection may legitimately hold more than
  its connector declares — a second connector on the same provider, a key granted for a path not
  modelled here — and a reconcile that pruned to the declaration would revoke authority nobody
  asked it to touch, on every tenant at once the day a declaration shrinks. `lint:connector-grants`
  checks that same floor against the dashboard's catalog, so the two cannot drift apart in the
  direction that matters.

  The trade that buys, stated rather than hidden: a key that stops being declared is not cleaned
  up. `protocol:read` — needed by nothing since the per-dispatch capability — stays on connections
  already granted it. Harmless, visible in the read-back, and deliberate.

  ## Verified against a real host, not a mock directory

  The load-bearing assertion is that the healed grant is **enforced**, so it is made through the
  scope's own read-back rather than the directory's list: a row nobody delivers is the #592 failure
  mode in reverse, and asserting on the list would have passed for it. Around that: the grant
  reaches a later install, a second pass changes nothing, a key the declaration does not name
  survives, a working scope-targeted grant is not shadowed by a tenant-wide twin, nothing outside
  the declaration's (tenant, vertical, provider) is touched, and a host that declares no connectors
  behaves exactly as before. The route-level test drives the whole path and checks the credential
  comes out untouched.

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

- Updated dependencies [15df906]
- Updated dependencies [ca3377d]
  - @substrat-run/control-plane-api@0.83.0
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-cloudflare@0.83.0
  - @substrat-run/connector-scrive@0.12.0

## 0.11.18

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
- Updated dependencies [75925a2]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/control-plane-api@0.82.0
  - @substrat-run/adapter-cloudflare@0.82.0
  - @substrat-run/connector-scrive@0.11.9
  - @substrat-run/kernel@0.82.0

## 0.11.17

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-cloudflare@0.81.0
  - @substrat-run/connector-scrive@0.11.8
  - @substrat-run/control-plane-api@0.81.0

## 0.11.16

### Patch Changes

- Updated dependencies [4dc28f4]
- Updated dependencies [83b0ca3]
  - @substrat-run/control-plane-api@0.80.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/connector-scrive@0.11.7
  - @substrat-run/adapter-cloudflare@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.11.15

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
- Updated dependencies [87ec6f2]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/adapter-cloudflare@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/control-plane-api@0.79.0
  - @substrat-run/oidc-rp@0.5.1
  - @substrat-run/connector-scrive@0.11.6

## 0.11.14

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/connector-scrive@0.11.5
  - @substrat-run/adapter-cloudflare@0.78.0
  - @substrat-run/control-plane-api@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.11.13

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/connector-scrive@0.11.4
  - @substrat-run/adapter-cloudflare@0.77.0
  - @substrat-run/control-plane-api@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.11.12

### Patch Changes

- @substrat-run/control-plane-api@0.76.0
- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-cloudflare@0.76.0
- @substrat-run/connector-scrive@0.11.3

## 0.11.11

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-cloudflare@0.75.0
  - @substrat-run/connector-scrive@0.11.2
  - @substrat-run/control-plane-api@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.11.10

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/connector-scrive@0.11.1
  - @substrat-run/adapter-cloudflare@0.74.0
  - @substrat-run/control-plane-api@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.11.9

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/connector-scrive@0.11.0
  - @substrat-run/adapter-cloudflare@0.73.0
  - @substrat-run/control-plane-api@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.11.8

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
  - @substrat-run/control-plane-api@0.72.0
  - @substrat-run/connector-scrive@0.10.0

## 0.11.7

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/connector-scrive@0.9.3
  - @substrat-run/adapter-cloudflare@0.71.0
  - @substrat-run/control-plane-api@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.11.6

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/connector-scrive@0.9.2
  - @substrat-run/adapter-cloudflare@0.70.0
  - @substrat-run/control-plane-api@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.11.5

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/connector-scrive@0.9.1
  - @substrat-run/adapter-cloudflare@0.69.0
  - @substrat-run/control-plane-api@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.11.4

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-cloudflare@0.68.0
  - @substrat-run/control-plane-api@0.68.0
  - @substrat-run/connector-scrive@0.9.0

## 0.11.3

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [c8f665c]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/connector-scrive@0.8.2
  - @substrat-run/kernel@0.67.0
  - @substrat-run/adapter-cloudflare@0.67.0
  - @substrat-run/control-plane-api@0.67.0

## 0.11.2

### Patch Changes

- Updated dependencies [954668b]
- Updated dependencies [2d0a2d0]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/connector-scrive@0.8.1
  - @substrat-run/control-plane-api@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.11.1

### Patch Changes

- Updated dependencies [edd764c]
  - @substrat-run/connector-scrive@0.8.0

## 0.11.0

### Minor Changes

- f151676: feat: the `builder` entitlement gates the studio + the console Members view

  Granting someone the builder studio no longer means granting them the control
  plane — and access follows the team, not an email list. The studio's gate is
  now: platform staff OR membership in a tenant holding the `builder`
  entitlement (granted per tenant in the console like any SKU; expiry applied at
  read, so a lapsed trial closes the studio). The CP's identity-tenants lookup
  returns each membership flagged with the entitlement; the studio resolves
  teams once per request, dispatches only into usable ones, and serves a proper
  HTML denied page for browsers (JSON for API callers) with a federated
  switch-account link. The studio-wide `/api/usage` rollup becomes staff-only
  (it is cross-team until metering is per-team) and the SPA hides the Usage tab
  for non-staff via a new `staff` flag on `/api/me`.

  The console's "Members" nav item graduates from Planned to a real view: the
  staff roster with grant/revoke/re-grant over new staff-gated `/api/members*`
  routes on the CP worker. Grants record the acting staff member (`added_by`,
  CP migration 0003); a re-granted staff member keeps their actor so admin-log
  history stays attributed; revoking the last active staff member is refused.
  Design record: builder-studio.md §15.

## 0.10.0

### Minor Changes

- 2d8568f: feat(builder): team-scoped studio — slug URLs, team picker, per-team DOs

  The hosted studio partitions by team (= tenant, dashboard-teams.md). The URL's
  first segment is the team slug (`builder.substrat.net/<team-slug>`, the
  dashboard's scheme verbatim); every API call names its team via
  `x-substrat-tenant`; and each team gets its own BuilderAgent DO
  (`idFromName(tenantId)`), so projects, history, and names partition by tenant.
  Membership is resolved from the shared control plane's identity directory via a
  new service-token-gated `POST /internal/builder/identity-tenants` over a
  service binding. The staff roster remains as an AND-gate until the builder
  entitlement flag exists on plans; the pre-teams shared `'studio'` instance is
  deliberately abandoned, not migrated. Design record: builder-studio.md §14.

## 0.9.3

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/connector-scrive@0.7.1
  - @substrat-run/adapter-cloudflare@0.65.0
  - @substrat-run/control-plane-api@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.9.2

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [6ac51d1]
- Updated dependencies [6ac51d1]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-cloudflare@0.64.0
  - @substrat-run/control-plane-api@0.64.0
  - @substrat-run/connector-scrive@0.7.0
  - @substrat-run/oidc-rp@0.5.0

## 0.9.1

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-cloudflare@0.63.0
  - @substrat-run/control-plane-api@0.63.0
  - @substrat-run/connector-scrive@0.6.1
  - @substrat-run/contracts@0.63.0

## 0.9.0

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

- f136a6d: fix: the deployed control plane was talking to Scrive's TESTBED — set `SCRIVE_BASE_URL` explicitly in both environments

  `SCRIVE_BASE_URL` was set nowhere: not in `wrangler.jsonc`, not in the platform secrets. So the
  connector fell back to its own default, `https://api-testbed.scrive.com`, in production. A tenant
  connecting a real Scrive credential got a 401 from the testbed — and a 401 is exactly what a
  mistyped key looks like, so the failure pointed at the customer instead of at the config.

  Both environments now state it: production `https://scrive.com` (the API lives under `/api/v2` on
  the main host — `api.scrive.com`, which an old comment in `worker.ts` recommended, has no DNS
  record at all), TEST `https://api-testbed.scrive.com`. Stated rather than defaulted, because an
  unset var here does not mean "unconfigured", it means "silently pointed at the wrong provider".

  Requires a control-plane deploy to take effect.

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/connector-scrive@0.6.0
  - @substrat-run/control-plane-api@0.62.0
  - @substrat-run/adapter-cloudflare@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.8.0

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
  - @substrat-run/connector-scrive@0.5.0
  - @substrat-run/control-plane-api@0.61.0
  - @substrat-run/adapter-cloudflare@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.7.0

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
  - @substrat-run/connector-scrive@0.4.0
  - @substrat-run/control-plane-api@0.60.0
  - @substrat-run/adapter-cloudflare@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.6.1

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

- Updated dependencies [1fab6f7]
- Updated dependencies [eda5d01]
  - @substrat-run/control-plane-api@0.59.0
  - @substrat-run/contracts@0.59.0
  - @substrat-run/kernel@0.59.0
  - @substrat-run/adapter-cloudflare@0.59.0
  - @substrat-run/connector-scrive@0.3.3

## 0.6.0

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

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-cloudflare@0.58.0
  - @substrat-run/control-plane-api@0.58.0
  - @substrat-run/connector-scrive@0.3.2

## 0.5.32

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/connector-scrive@0.3.1
  - @substrat-run/adapter-cloudflare@0.57.0
  - @substrat-run/control-plane-api@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.5.31

### Patch Changes

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

- e6bc94d: feat: the Scrive webhook ingress terminates on the platform (#574 phase 2, #96)

  For a CP-less dispatch vertical the callback capability URL has nowhere to land:
  the dispatch ledger the token verifies against lives in the control plane's
  directory, out of any pushed script's reach — PR #573 deliberately stopped short
  of mounting the ingress there. Phase 2 puts the door where the ledger is:

  - The CP worker mounts `SCRIVE_CALLBACK_ROUTE`
    (`/hooks/scrive/:connectionId/:instanceId/:token`). Unauthenticated by design —
    Scrive signs nothing, so the per-dispatch minted token is the entire
    authentication, compared in constant time against the ControlPlaneDO-held
    ledger row.
  - On a match the same `reconcileScriveDispatch` the sweep runs re-reads the
    provider's truth (the callback body is never read, let alone trusted) and
    records it back through the vertical's `/internal/connector-*` surface — the
    phase-1 write-back seam. Push collapses the poll floor's latency; it never
    replaces it.
  - Every rejection is one uniform 404 with the reason only logged, so the
    response is no oracle for probing which instances exist, and nothing short of
    a verified token causes provider egress. A post-verification failure answers
    500 so Scrive retries.

  Phase 3 (outbound dispatch via platform-requests) closes #574.

- Updated dependencies [4eb90ca]
- Updated dependencies [1fa4bd0]
- Updated dependencies [b8bdb9d]
- Updated dependencies [336352b]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-cloudflare@0.56.0
  - @substrat-run/control-plane-api@0.56.0
  - @substrat-run/connector-scrive@0.3.0

## 0.5.30

### Patch Changes

- Updated dependencies [8cd5039]
- Updated dependencies [512822b]
  - @substrat-run/control-plane-api@0.55.0
  - @substrat-run/contracts@0.55.0
  - @substrat-run/kernel@0.55.0
  - @substrat-run/adapter-cloudflare@0.55.0

## 0.5.29

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
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-cloudflare@0.54.0
  - @substrat-run/control-plane-api@0.54.0

## 0.5.28

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/control-plane-api@0.53.0
  - @substrat-run/adapter-cloudflare@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.5.27

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/adapter-cloudflare@0.52.0
  - @substrat-run/control-plane-api@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.5.26

### Patch Changes

- Updated dependencies [9f28da1]
  - @substrat-run/control-plane-api@0.51.0
  - @substrat-run/contracts@0.51.0
  - @substrat-run/kernel@0.51.0
  - @substrat-run/adapter-cloudflare@0.51.0

## 0.5.25

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/control-plane-api@0.50.0
  - @substrat-run/adapter-cloudflare@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.5.24

### Patch Changes

- Updated dependencies [5ad59c5]
- Updated dependencies [a13c8fb]
- Updated dependencies [00ff102]
- Updated dependencies [f11a961]
- Updated dependencies [9c7987b]
  - @substrat-run/control-plane-api@0.49.0
  - @substrat-run/contracts@0.49.0
  - @substrat-run/adapter-cloudflare@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.5.23

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-cloudflare@0.48.0
  - @substrat-run/control-plane-api@0.48.0

## 0.5.22

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-cloudflare@0.47.0
  - @substrat-run/control-plane-api@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/adapter-email@0.2.0

## 0.5.21

### Patch Changes

- Updated dependencies [b94f735]
  - @substrat-run/control-plane-api@0.46.0
  - @substrat-run/contracts@0.46.0
  - @substrat-run/kernel@0.46.0
  - @substrat-run/adapter-cloudflare@0.46.0

## 0.5.20

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-cloudflare@0.45.0
  - @substrat-run/control-plane-api@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.5.19

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-cloudflare@0.44.0
  - @substrat-run/control-plane-api@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.5.18

### Patch Changes

- 0d802b7: The test control plane never drained platform-intents. Wrangler does not carry
  the top-level `triggers` into a named environment, so `substrat-control-plane-test`
  (deployed by CI on every green push to main) shipped with NO cron — its scheduled
  pass, and with it the platform-intent drain, never ran. A `provision-tenant` intent
  enqueued against a test-hosted scope sat `pending, attempts=0` forever (#444). Add the
  same `*/15` `triggers` block to `env.test` that prod already carries. Separately, the
  scheduled pass now logs `platformRequests` totals whenever there is drain activity
  (drained/failed/still-pending), so a drain that silently never converges leaves a trace
  in the tail instead of being invisible.

## 0.5.17

### Patch Changes

- Updated dependencies [d3c0b16]
  - @substrat-run/adapter-cloudflare@0.43.0
  - @substrat-run/contracts@0.43.0
  - @substrat-run/kernel@0.43.0
  - @substrat-run/control-plane-api@0.43.0

## 0.5.16

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-cloudflare@0.42.0
  - @substrat-run/control-plane-api@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.5.15

### Patch Changes

- Updated dependencies [653a592]
- Updated dependencies [e9c7bd0]
- Updated dependencies [e3cd3cd]
- Updated dependencies [1f51134]
- Updated dependencies [d222905]
  - @substrat-run/control-plane-api@0.41.0
  - @substrat-run/adapter-cloudflare@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.5.14

### Patch Changes

- Updated dependencies [3a0eaa4]
- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
- Updated dependencies [b82d40f]
  - @substrat-run/adapter-cloudflare@0.40.0
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/control-plane-api@0.40.0

## 0.5.13

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-cloudflare@0.39.0
  - @substrat-run/control-plane-api@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.5.12

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-cloudflare@0.38.0
  - @substrat-run/control-plane-api@0.38.0

## 0.5.11

### Patch Changes

- Updated dependencies [705b806]
- Updated dependencies [8869413]
  - @substrat-run/control-plane-api@0.37.0
  - @substrat-run/contracts@0.37.0
  - @substrat-run/kernel@0.37.0
  - @substrat-run/adapter-cloudflare@0.37.0

## 0.5.10

### Patch Changes

- Updated dependencies [20343bb]
- Updated dependencies [c8c0624]
  - @substrat-run/control-plane-api@0.36.0
  - @substrat-run/contracts@0.36.0
  - @substrat-run/kernel@0.36.0
  - @substrat-run/adapter-cloudflare@0.36.0

## 0.5.9

### Patch Changes

- Updated dependencies [c200778]
- Updated dependencies [17eec41]
  - @substrat-run/control-plane-api@0.35.0
  - @substrat-run/contracts@0.35.0
  - @substrat-run/adapter-cloudflare@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.5.8

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-cloudflare@0.34.0
  - @substrat-run/control-plane-api@0.34.0

## 0.5.7

### Patch Changes

- Updated dependencies [0b9220e]
- Updated dependencies [6d3429e]
  - @substrat-run/control-plane-api@0.33.0
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-cloudflare@0.33.0

## 0.5.6

### Patch Changes

- Updated dependencies [c0b3464]
- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/control-plane-api@0.32.0
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-cloudflare@0.32.0

## 0.5.5

### Patch Changes

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

- fa8feb9: Router kick: drain a scope's platform-intents in seconds, not at the next sweep.

  The last piece of the platform-intents latency story. A vertical enqueues an intent and
  flags it on the response with `x-substrat-platform-request`; the router — the one hop that
  already knows the resolved `(tenant, scope)` — pings the control plane to drain that scope
  immediately, collapsing the ~2-min periodic-sweep delay to seconds.

  - **control-plane:** the per-scope drain the sweep ran inline is extracted to a module-level
    `drainOneScope(env, tenant, scope)` (serving-ref → bound-version → prod ladder, the same
    `provision-sibling` + `archive-scope` handlers). A new platform-secret-gated
    `POST /internal/drain-scope` runs it on demand. Identity stays inherent: the body only
    _names_ which scope to drain; the tenant/vertical are re-derived from this directory's own
    record, so a caller with the global secret can at most accelerate a scope's own pending
    work. An unconfigured secret **refuses** (fails closed), never bypasses.
  - **router:** after dispatch, when the response carries `x-substrat-platform-request`, the
    router `ctx.waitUntil`s a best-effort kick to `/internal/drain-scope` over a new
    `CONTROL_PLANE_KICK` service binding (prod → `substrat-control-plane`, test → its `-test`
    peer), presenting the global `PLATFORM_SECRET`. Out of band and best-effort by design: the
    user's response is returned untouched, and a missing/failed/unconfigured kick simply falls
    back to the durable sweep — latency, never correctness.

  The sweep remains the reliability backstop; the kick is pure latency. Tested: the router
  kicks the _resolved_ node (not caller-supplied) with the secret when flagged, does not kick
  otherwise, and never throws when unconfigured; the control-plane endpoint fails closed when
  no secret is bound. Refs #358.

- 0e9eba7: Platform intents, Phase C (periodic trigger): drain intents on the platform sweep.

  `runPlatformSweep` gains an injected `drainPlatformRequestsFn` option (mirroring `reapScopeFn`):
  when supplied, a new phase enumerates active scopes and drains each one's pending platform intents,
  summing per-scope counts into a new `platformRequestTotals` report field (and recording per-scope
  failures under a new `'platform-request'` error kind — one failure never sinks the pass). Unset ⇒
  the phase is skipped. It is injected because the kernel can't reach a vertical's scope DO (it lives
  in the vertical's own deployment); the control plane supplies the fn.

  The control-plane worker's scheduled sweep now wires it: for each active scope it resolves the
  serving `VerticalClient` (the same serving-script → bound-version → prod ladder the API uses) and
  runs Phase B2's `drainScopePlatformRequests` with the `provision-sibling` handler. So a Manyfold
  site request enqueued via `ctx.requestPlatform` is picked up and provisioned within a sweep cycle.

  This is the PERIODIC trigger (~2-min cadence, the reliability backstop). The low-latency router
  kick and the vertical's `/internal/platform-requests` endpoints (which expose the drain to the
  platform) land in Phase D alongside the Manyfold end-to-end. Refs #358.

- Updated dependencies [fbf0704]
- Updated dependencies [0d79662]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/control-plane-api@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0

## 0.5.4

### Patch Changes

- 3aa9cde: Default custom-hostname DCV to HTTP (single-CNAME issuance).

  Cloudflare-for-SaaS certificate validation now defaults to the `http` method instead of
  `txt`. A tenant binding a custom domain publishes a **single** record — the routing CNAME —
  and Cloudflare serves the validation token at its edge once the CNAME is live, so issuance is
  hands-off (nothing for the platform to serve). The method is overridable per environment via
  `CF_SAAS_SSL_METHOD` on the control-plane worker; set it to `txt` for the previous two-record
  flow that can validate before the CNAME resolves. The dashboard's Domains preview mock is
  refreshed to the single-record shape and the `cname.substrat.run` routing target.

- Updated dependencies [49db0a1]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [866c46d]
- Updated dependencies [91a60e2]
  - @substrat-run/control-plane-api@0.30.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0

## 0.5.3

### Patch Changes

- Updated dependencies [a650d52]
- Updated dependencies [c64bdf8]
  - @substrat-run/control-plane-api@0.29.0
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0

## 0.5.2

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/control-plane-api@0.28.0
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0

## 0.5.1

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0
  - @substrat-run/control-plane-api@0.27.0

## 0.5.0

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
- Updated dependencies [03839ec]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/control-plane-api@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0

## 0.4.0

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

- Updated dependencies [487db9a]
- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/control-plane-api@0.25.0
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0

## 0.3.8

### Patch Changes

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
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/control-plane-api@0.24.0

## 0.3.7

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/control-plane-api@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.3.6

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/control-plane-api@0.22.0

## 0.3.5

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/control-plane-api@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0

## 0.3.4

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0
  - @substrat-run/control-plane-api@0.20.0

## 0.3.3

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/control-plane-api@0.19.0

## 0.3.2

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0
  - @substrat-run/control-plane-api@0.18.0

## 0.3.1

### Patch Changes

- Updated dependencies [983c06d]
  - @substrat-run/control-plane-api@0.17.0
  - @substrat-run/contracts@0.17.0
  - @substrat-run/kernel@0.17.0
  - @substrat-run/adapter-cloudflare@0.17.0

## 0.3.0

### Minor Changes

- 0caa0a9: Account switching actually works: force past the IdP SSO cookie and the browser session.

  Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
  cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
  authorize round-trip silently re-authenticated the old user — no typed email could win.
  The CLI broker added a second layer: `substrat login` reused any live browser session
  without ever showing a login screen.

  **oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
  (`login` | `select_account`) so the IdP re-prompts past its SSO session, and
  `/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
  (RP-initiated logout, discovery-driven; local-only remains the default so other apps
  on the shared IdP session keep theirs).

  **control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
  session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
  returnTo so the post-login bounce uses the new session instead of looping.

  **cli**: `substrat login --fresh` requests exactly that flow, and
  `substrat workspaces` lists your workspaces (an alias of `whoami`).

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [0caa0a9]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/control-plane-api@0.16.0
  - @substrat-run/oidc-rp@0.4.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [7ed3015]
- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/control-plane-api@0.15.0
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/oidc-rp@0.3.0
  - @substrat-run/kernel@0.15.0

## 0.1.2

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.
- Updated dependencies [f4ad677]
- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [a1c7649]
  - @substrat-run/control-plane-api@0.14.0
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.1.1

### Patch Changes

- 6abbce9: **Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
  router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
  `ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
  the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.
- Updated dependencies [2add91f]
- Updated dependencies [b1af840]
- Updated dependencies [fa0707c]
- Updated dependencies [74c9d7b]
  - @substrat-run/oidc-rp@0.2.0
  - @substrat-run/adapter-cloudflare@0.13.0
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/control-plane-api@0.13.0

## 0.1.0

### Minor Changes

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

- cc5f2ca: **`substrat login` — a real browser login for the CLI (loopback OAuth, no AuthHero change).**

  `substrat login` now pops the browser and authenticates you as yourself — the `wrangler login` / `gh auth login` experience — instead of pasting a shared token. The CLI never touches AuthHero: it logs in **through the control plane**, which already brokers AuthHero for the console, and gets back the same signed session it issues to a browser.

  - **The flow (PKCE, CLI ↔ control plane):** the CLI starts a localhost server, opens `…/api/auth/cli?port&state&challenge`; the broker signs the user in (bouncing through the existing `/api/auth/login` if there's no session yet, via a new same-origin `returnTo`) and redirects to `127.0.0.1:PORT/callback?code`; the CLI exchanges `code + verifier` for the session token. The token never transits a URL — only the PKCE-bound `code` does — and the exchange fails without the matching verifier.
  - **`@substrat-run/oidc-rp`**: exports `mintSession` (refactored out of `completeLogin`), `signEphemeral`/`verifyEphemeral`, `pkceS256`, and `safePath`; `mountOidcRoutes` honours a validated same-origin `returnTo`.
  - **`apps/control-plane`**: `oidcStaffBearerReader` accepts the session as `Authorization: Bearer` (the same `verifySession`, the **same staff roster** gate as the cookie); `cli-auth.ts` mounts the broker routes. Pushes are attributed to the **human**, not a shared actor. **No AuthHero client or redirect URI is added** — AuthHero still only ever redirects to the console.
  - **`@substrat-run/cli`**: the loopback `login` flow (default); `login --token` / `SUBSTRAT_SERVICE_TOKEN` still stores a service credential for CI. `push` sends whichever the config resolves — a bearer session (per-human) or `x-service-token` (service actor).

  Verified: oidc-rp, control-plane, dashboard and cli typecheck; a new workerd test drives the whole broker end-to-end — the PKCE round-trip issues a bearer the deploy surface accepts, a wrong verifier is refused (400), and a valid session for a non-rostered user is refused (401, fail closed).

- b4420fb: **Console/control-plane staff sign-in moves from per-app Better Auth to OIDC (AuthHero).**

  Second app in the platform's auth consolidation (the Dashboard was the pilot). The
  OIDC relying party is now a shared package — `@substrat-run/oidc-rp` — so the
  security-critical verifier (Authorization-Code + PKCE, ID-token/JWKS verification,
  signed session cookie; jose + Web Crypto, no `node:*`) is written once and mounted
  identically by both apps via `mountOidcRoutes`.

  - **control-plane worker**: `/api/auth/login → /callback → /logout` (+ `/session`
    for the console) replace the Better Auth handler. Staff authentication is now an
    OIDC session reduced to the provider-agnostic `StaffSessionReader` — exactly the
    seam the old code predicted. The **staff roster stays** the authorization gate
    (`staff_actor` in D1); OIDC only proves the email, so an AuthHero user who isn't
    rostered still gets nothing (fails closed). Dropped `nodejs_compat` and the
    Better Auth D1 _schema_ (the roster D1 remains). All OIDC config is secrets —
    nothing environment-specific is checked in.
  - **console SPA**: sign-in is a redirect into the OIDC flow (no password field);
    `getSession` polls `/api/auth/session`; sign-out redirects to `/api/auth/logout`.
  - The `#47` public-signup-gated-by-roster test is removed — under OIDC the control
    plane has no signup surface at all, so the hole cannot exist; a guard test asserts
    no sign-up endpoint is exposed.

  The dev harness (`control-plane-api/dev/server.mts`) keeps Better Auth for the
  optional real-auth-in-dev toggle; the primary local path is the dev actor, which is
  unaffected.

- 0de890b: **The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

  A pushed vertical needs the platform's shared secrets to _verify_ inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

  - **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, _after_ the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
  - **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

  Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.

### Patch Changes

- 847b506: **The Dashboard provisions REAL, reachable apps — the tenant-narrowed authority seam (dashboard.md §4/§6).**

  M0 ran apps inside the Dashboard's own deployment and bound hostnames in its own directory, so nothing it created was reachable through the router. This wires the production path: the Dashboard provisions on the SHARED control plane the router reads, narrowed to the caller's own tenant.

  - **The §4 seam** (`apps/dashboard/src/authority.ts`, new) — `TenantNarrowedControlPlane`: the control-plane API over an injected `fetch` (a service binding to `substrat-control-plane`), with `tenantId` **pinned at construction** from the caller's dashboard node. The tenant is not a parameter of any method, so operation code cannot name another — cross-tenant is impossible by construction (the #97 move). Machine auth is a shared `SERVICE_TOKEN` → the control plane's service actor. Unit-tested: pins the tenant on every route, tolerates idempotent conflicts, surfaces real failures.
  - **`createApp` gains a connected mode** (`provision.ts`): when a control-plane seam is present it mirrors the operator console's proven create-instance sequence — `provisionScope` (directory row) → `provisionInstance` (the vertical creates the scope + grants entitlements + assigns the owner) → `activateScope` → bind `<slug>.global.substrat.run` — so the app is a real vertical instance the router resolves. Absent the seam it keeps the M0 embedded path (tests, standalone). The permission check ("can they?") runs the same in both, first.
  - **The worker** builds the seam from a new `CONTROL_PLANE_SVC` service binding + `CP_SERVICE_TOKEN` secret, pinned to the caller's tenant; falls back to embedded when unbound.
  - **Reaching a vertical**: the control plane + router resolve verticals **dynamically** through the WfP dispatch namespace (`resolveVertical`/`verticalFor` → `env.DISPATCH.get(deploymentRef)`); the dashboard's connected `createApp` pins the scope to the prod version (`bindScopeVersion`) so dispatch is dynamic — no per-vertical service binding, no redeploy. `demos/callout`'s `CONTROL_PLANE_URL` is neutralized (calls go over the service binding; only the `/api` path is used).

  Steps 3–4 (router, `*.global.substrat.run` DNS + ACM cert) were already live; this is step 5 — the tenant-narrowed provisioning seam. Requires a deploy of the control plane + dashboard (`CP_SERVICE_TOKEN` = the control plane's `SERVICE_TOKEN`). A vertical is instantiable once it's pushed + promoted into the dispatch namespace; making Callout the first genuinely isolated, CP-less vertical is tracked in `docs/architecture/scope-local-permissions.md`. Verified in code (10/10 dashboard tests, typecheck, boundary-lint, wrangler dry-runs).

- Updated dependencies [05291fa]
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [cc5f2ca]
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
  - @substrat-run/oidc-rp@0.1.0
  - @substrat-run/kernel@0.12.0

## 0.0.7

### Patch Changes

- Updated dependencies [a277bb7]
- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/adapter-cloudflare@0.11.0
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/control-plane-api@0.11.0

## 0.0.6

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-cloudflare@0.10.0
  - @substrat-run/control-plane-api@0.10.0

## 0.0.5

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-cloudflare@0.9.0
  - @substrat-run/control-plane-api@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- Updated dependencies [c9fe555]
  - @substrat-run/control-plane-api@0.8.0
  - @substrat-run/contracts@0.8.0
  - @substrat-run/kernel@0.8.0
  - @substrat-run/adapter-cloudflare@0.8.0

## 0.0.3

### Patch Changes

- Updated dependencies [017bb83]
- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
- Updated dependencies [ad89a9d]
  - @substrat-run/control-plane-api@0.7.0
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-cloudflare@0.7.0

## 0.0.2

### Patch Changes

- Updated dependencies [ea3c5de]
  - @substrat-run/control-plane-api@0.6.0
  - @substrat-run/contracts@0.6.0
  - @substrat-run/kernel@0.6.0
  - @substrat-run/adapter-cloudflare@0.6.0

## 0.0.1

### Patch Changes

- Updated dependencies [54c6583]
  - @substrat-run/control-plane-api@0.5.0
  - @substrat-run/contracts@0.5.0
  - @substrat-run/kernel@0.5.0
  - @substrat-run/adapter-cloudflare@0.5.0
