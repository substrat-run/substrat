# @substrat-run/kernel

## 0.122.0

### Minor Changes

- 0803833: Moving one app onto a version that stops exporting an event type another app in the same tenant imports is now refused, the same way a promote already is. Before, updating one app could stop another app's events arriving, and nobody would have agreed to that.

  A move is either of the two things that decide what code an app runs: binding it to a version, or routing it onto (or off) its vertical's serving script, which is what adopting a legacy app does before its version ever changes. Both are judged by the code the app runs before and after. An app that stays on the serving script runs the served version whatever its pointer says, so re-pointing it is never refused; the promote that replaced that script already judged every tenant. A fork, a preview, an app still provisioning, and an app's first bind are never refused either. A move to another vertical (`rebind-vertical` across lineages) is not judged, which is a known gap.

  The refusal counts what would break. Pass `acknowledge: { exportBreak: true }` to move anyway, and the admin log records it.

  - The control plane's bind (`POST /tenants/:t/scopes/:s/version`), `adopt-serving` (per app and vertical-wide) and `rebind-vertical` take `acknowledge`, ask before moving any data, and refuse with the affected apps listed. `GET /tenants/:t/scopes/:s/binding-impact?versionId=` asks the same question without moving anything.
  - A private vertical's promote passes its export-break acknowledgement on to the apps it adopts, and its impact (`promote-impact` and the promote's own refusal) names what adopting each app still on an older version would break. Without the acknowledgement such an app is left where it is, every other app still moves, and the promote says which were left.
  - `substrat scope bind`, `scope adopt-serving` and `scope rebind` take `--ack-export-break` and print the affected apps.
  - The dashboard's Update and Bind list the affected apps in a confirm and send again acknowledged. A refused Update leaves nothing on the Activity trail, and an acknowledged one says it was acknowledged.
  - A version that is not admitted is refused as that before any acknowledgement is asked for.

  `HostAdmin` gains `bindingImpact(actor, tenantId, scopeId, versionId, opts?)`, which lists the apps a move would break (`opts.servingRef` for a routing move). `bindScopeVersion` and `setScopeServingRef` gain `acknowledge` in their options. Anything that implements `HostAdmin` needs the new method. The kernel exports `bindExportBreaksOf` and the refusal helpers, and `exportBreaksOf` takes an optional `tenantId`.

- 3a3338d: A version's SQL migrations are now stored apart from its deploy manifest. Reading a version no longer moves its SQL. Admitting, promoting, binding and serving a version read only the manifest, and the promote review reads the SQL on its own.

  `substrat push` sends the same manifest as before. The control plane takes the `migrations` field out when the version is published, stores each migration as its own row, and keeps the manifest without it. As before, `substrat push` leaves off a set over the limits (2000 migrations, 512 KiB of SQL) with a warning, and the deploy endpoint refuses one before anything is uploaded. A version published any other way with such a set, or with one not shaped like migrations, still publishes without it, and the promote dialog says the SQL is not available and asks for the acknowledgement.

  Versions pushed earlier are moved over in the background, a few at a time, and read correctly while they wait. A version pushed before manifests carried migrations still reads as "SQL not available", never as "no migrations". A directory restored from a backup taken before the move is moved again.

  `HostAdmin` gains `versionMigrations(actor, verticalSlug, versionId)`, which returns one version's migrations in the order the host runs them. It returns `null` for a version with none to show. Like `versionManifest`, it refuses a version of another vertical. Anything that implements `HostAdmin` needs the new method.

### Patch Changes

- 1e326dd: Fixes the event drain on the hosted adapter. A Durable Object refuses a statement with more than 100 bound parameters, and marking a drained batch bound one parameter per event. The default batch is 200, so on a real Durable Object every default drain of more than 100 events failed and marked nothing. Reopening drained events (`redrainEvents`, up to 5000 per call) failed past 100 in the same way.

  The platform's other statements that took a list now bind it as one JSON array too. These are the fleet listing's status filter and the audit log's action filter (neither list had a length bound, because an entry may repeat), the freshness probe's event types, and the cross-vertical export read and count. The node adapter has no parameter limit on platform SQL, so these failed only on the hosted adapter. They are converted on both, so the two adapters keep running the same statements.

  Every converted statement is checked on workerd for behaviour past the limit. `contract-tests` drains, stamps and reopens 350 events in one scope, and filters the fleet and the audit log by 151-entry lists. The freshness probe and both export statements are run with 150 event types. The query plan is compared with the one-parameter-per-entry form's for three statements only: the export read, the export count and the drain-stamp count. Each uses the same index as before, on a scope with no table statistics. The other statements are checked for behaviour only. Once `ANALYZE` has run on a scope, the export read chooses a slower plan than the old form did; it returns the same rows (#1787).

- Updated dependencies [0803833]
  - @substrat-run/contracts@0.122.0

## 0.121.0

### Minor Changes

- a235648: Cross-vertical events now reach hosted verticals, and arrive in seconds rather than at the next sweep (#1705).

  `@substrat-run/vertical-host`'s platform surface gains three platform-secret-gated routes: `POST /internal/exported-events` (the producer's release after a watermark), `GET /internal/import-state` (the consumer's imports and watermarks) and `POST /internal/import-events` (a batch, applied under the watermark's compare-and-set). They call three new optional `VerticalScopeHost` members: `exportedEventsLocal`, `importStateLocal` and `importEventsLocal`. A host without them answers 501, naming the redeploy.

  `@substrat-run/adapter-cloudflare` implements the three far ends. Before answering, each proves the scope was provisioned in this deployment for this tenant, and refuses `conflict` otherwise. A CP-less deployment has no directory, and an unprovisioned Durable Object would answer with a plausible empty result. The coordinator also fires the new `ScopeStubOptions.onExportedEvents` when an invoke commits an exported type.

  `@substrat-run/control-plane-api` adds `VerticalClient.exportedEvents`, `importState` and `importEvents`. A deployment that predates the routes (a 404, or its SPA shell) is a 501 that says to redeploy, so it is never an empty answer. It also adds `hostedCrossVerticalReach`, the control plane's reach for the phase. That reach decides which scopes to call from the version registry, so a fleet with no importer makes no `/internal` call. A consumer's `imports` reach the registry only from `substrat` CLI **0.34.0** on. A version pushed by an older CLI reads as importing nothing, and its scopes are not asked until it is pushed again. A version the registry cannot answer for (an unknown version, an unparseable manifest, or a scope bound to no version) keeps its scopes as candidates. They are asked once per sweep tick, never on a kick, and it is reported.

  `@substrat-run/kernel` adds `EXPORTED_EVENTS_HEADER`, `ScopeStubOptions.onExportedEvents`, and `kickFlags(setHeader)`, which returns both kick callbacks for a worker to spread into `getScope`'s options. It also adds `runCrossVerticalFrom`, which runs one producer's outgoing edges for the router kick; `registryImportCandidates`, the registry-backed narrowing; and a `{ from }` hint on `CrossVerticalReach.candidates`. `@substrat-run/adapter-sqlite` fires `onExportedEvents` too. `@substrat-run/contracts` adds `importsOfManifestJson`, which answers `none`, `imports` or `unreadable`. The adapter-cloudflare host adds `versionImports`, the unaudited registry read the narrowing uses.

  `@substrat-run/contract-tests`: a `VerticalEventsFixture` may pass a `transport` and an `afterInstall`, which is how the suite now also runs over the hosted transport on workerd.

  The scaffold's worker wires both flags with `kickFlags`, so its responses also carry `x-substrat-exported-events`. The router passes that flag on its drain kick. The control plane then asks the producer's kick coalescer, a new `CrossVerticalKickDO`, one per producer scope, built with adapter-cloudflare's new `defineKickCoalescerDO`. The coalescer runs at most one pass per `CROSS_VERTICAL_KICK_WINDOW_MS` (5 s) per producer, plus one trailing pass per burst, fleet-wide. The control plane's wrangler config gains a `v2` migration for the class. The control plane runs the phase on its scheduled sweep, with `CROSS_VERTICAL_CONSUMERS_PER_PASS` as the per-pass cap (`0` pauses).

- 6fc9950: Cross-vertical events gain a replay lever, an edge-health view, a payload-schema rule in CI, and a promote refusal (#1705).

  **The replay lever.** `HostAdmin.moveImportCursor(actor, tenantId, scopeId, move)` moves a consumer's watermark on the edge from one producer vertical. `mode: 'replay'` re-delivers after a point (`after: null` is the whole history). It needs `acknowledge: 'rerun-handlers'`, because every importing handler runs again, and anything they send or call outside the app happens again (`REPLAY_EFFECT`). `mode: 'skip'` passes events over up to a point (`through: 'now'`). It needs `acknowledge: 'skip-events'`, and a later replay can reach back to what it skipped. A replay moves the replayed range's delivery and journal rows into the new spine table `_substrat_import_replays`, under the act's `replayId`, rather than deleting them. The producer is resolved from the directory in the consumer's tenant, never taken from the caller. `@substrat-run/control-plane-api` serves it as `POST /tenants/:t/scopes/:s/import-cursor` to staff and to the tenant's own credential, and refuses a missing acknowledgement in those words. `@substrat-run/vertical-host` adds `POST /internal/import-cursor` (optional `importCursorLocal`, 501 when absent), and `VerticalClient.importCursorMove` reaches it. On the control plane, `CloudflareScopeHostOptions.importCursorDelegation` routes the move to the deployment serving the scope.

  **Edge health.** `crossVerticalHealth(host, { actor, tenantId, crossVertical })` reads every edge of one tenant live, through the sweep's own reach: `caught-up`, `behind` (with the oldest waiting event's lag), `paused` (by the producer's grant or the consumer's door), `unresolved`, or `unavailable` when a side could not be asked. `unavailable` never renders as healthy. Each edge carries its last delivering sweep pass and the last one that did not deliver. `GET /tenants/:t/cross-vertical/edges` serves it. The dashboard shows it per app, and the console per scope, both with the lever behind a ticked acknowledgement.

  **D-22 for exported events.** `exportedEventSchemasOf(operations, eventsExportedBy(…))` derives each exported type's payload as JSON Schema, and `emitModel(…, { exports })` carries it in `model.json` (omitted when empty, so no existing model changes). `pnpm lint:export-schemas --base <ref>` compares it with the merge-base. At an unchanged schemaVersion it refuses a removed, retyped, newly required or no-longer-required field, and a schemaVersion that went down. A base the checkout lacks is exit 2, never read as a new file. CI runs it on every PR and push.

  **The promote refusal.** `promoteVersion` refuses a version that drops or re-versions an exported (type, schemaVersion) the outgoing version promised and a running consumer imports, unless acknowledged with `exportBreak` (`substrat promote --ack-export-break`). The refusal counts the break and names no tenant. `HostAdmin.promotionImpact` lists the affected apps, and the promote route returns that list with a 409: a confined caller sees its own tenant's apps and a count of the rest. `@substrat-run/contracts` adds `exportsOfManifestJson` and `exportBreak`.

- 48fea30: The schedule kill switch (#1666) is now recorded in the directory as well as in the scope,
  so a switch survives a wiped or restored scope, and the fleet can be asked what is off.

  The directory keeps one row per (tenant, scope, module) in a new `_substrat_system_switches`
  table: the position the switch was last moved to, who moved it, why, and when. `revokeFromSystem`
  writes it after the scope's switch held; `restoreToSystem` writes it before the scope moves,
  and puts it back if the move fails. Both adapters build the table from one kernel fragment,
  `SYSTEM_SWITCHES_DDL`, and backfill it once from the admin log, from the latest applied
  `revokeFromSystem` / `restoreToSystem` per module, on the run that creates it.

  `GET /system-switches` (staff and the service token only) is the fleet read: every scope with a
  module switched off, paged by `operationId`, filterable by tenant, scope, module and vertical,
  with `position=on` or `position=all` for the rest. `HostAdmin.listSystemSwitches` is the read
  underneath it.

  When the scope and the record disagree, OFF wins from either side, and the record never turns
  anything on. `HostAdmin.reassertSystemSwitches` switches every module the record holds `off` back
  off on one scope, after provisioning's seat, so the grants a wiped scope just had seated are the
  ones it tombstones and a later `restoreToSystem` gives them back. It runs after a CP-full
  `provisionScope`, after every hosted reconcile (the sweep, the repair route and the
  set-entitlements drain), and after a staff restore. For a hosted scope it reaches the deployment
  over the existing `/internal/system-switch` route, so no vertical needs redeploying. It is audited
  as a new `reassertSystemSwitch` admin action, only when something moved.

  The per-scope status read (`GET /tenants/:t/scopes/:s/system-grants`) gains `recorded` on each
  entry, the directory's position beside the scope's own, and now also lists a module the record
  holds that a wiped scope no longer reports, as `ungranted`.

  `HostAdmin.listSystemSwitches` and `HostAdmin.reassertSystemSwitches` are required members: any
  `HostAdmin` implementation outside this repository needs both.

- a6f4db1: The node adapter now enforces the SQL limits a Durable Object enforces on `ctx.sql`, so a vertical's own test suite fails where production would. Measured on a real Durable Object: **5** terms in one compound `SELECT`, **100** bound parameters and **100 000** bytes of statement. A statement over one is refused by the adapter itself, with the hosted message (`too many terms in compound SELECT`, `too many SQL variables at offset N`, `statement too long`). The fourth limit, a 50-byte `LIKE`/`GLOB` pattern, is listed in `DO_SQL_LIMITS` but is not enforced by the adapter: this repository's own node suites emulate it with a test preload (`tools/vitest/like-pattern-limit.cjs`), and a plain `SqliteScopeHost` still allows stock SQLite's 50 000. Enforcing it in the adapter would mean replacing SQLite's `like()`/`glob()` on every connection, which costs a JavaScript call per row and disables the `LIKE` prefix index optimisation for self-hosters. A multi-row `VALUES` list is not limited. The values are exported as `DO_SQL_LIMITS`, with `assertWithinSqlLimits` and `guardSqlLimits`, and documented on `ctx.sql` and in the scope-host concept page. Only module-facing SQL is judged.

  Also fixes a paged read whose set filter (`filters: { status: [...] }`) bound one parameter per member, plus the cursor and page size: past about 97 members it failed on a Durable Object and ran on node. The set is now one bound JSON array. `contract-tests` gains `sqlLimitsContractSuite`, which drives the same statements through both adapters and compares the refusals.

- 45b927e: Promoting a version now shows the migrations it would run, each with its SQL.

  `substrat push` carries every module's SQL migrations in the deploy manifest: the module, the migration's version and its SQL, in the order the host runs them. That includes the index migrations nobody writes by hand, which a module's `searchables` and `lists` declare. The kernel's new `moduleMigrations` is the one list of them in order: both hosts apply exactly it, and the push reads it from the vertical's own kernel. A vertical whose kernel predates it, and whose modules declare searchables or lists, carries no SQL rather than a short list. It is a new optional `migrations` field, so earlier CLIs and stored versions keep working. A version pushed before this field existed has no SQL to show. A set too large to carry is left out with a warning, and the push still goes through: over 2000 migrations, over 512 KiB of SQL, or a manifest that carrying them would take past 1.5 MiB. That last bound is the one that matters, because the platform stores each manifest in a single database row with a limit of about 2 MB, and JSON escaping can make SQL much larger than its own size.

  A new owner-only read, `GET /verticals/:slug/versions/:id/migrations?base=<versionId>`, returns the migrations a version adds on top of another, bounded in count and size. It also lists apart any shipped migration whose SQL was edited, since a scope that already ran it will not run it again. Only the vertical's own team can read it, because migration SQL describes a schema.

  In the dashboard's promote dialog, the schema section lists each new migration by id, with its SQL collapsed underneath. For a version that carries no SQL (pushed by an older CLI, or over the size a manifest carries), it says "SQL not available for this version" and asks for the acknowledgement, whether or not the registry refuses. `substrat promote` prints the permission diff and the new migrations' SQL when the registry refuses, so `--ack-permissions` and `--ack-migrations` answer something you have read. The permission diff is the dashboard's own, now in `@substrat-run/contracts`, and a change it does not itemise (an export or import, which module declares a key) is named rather than printed as no change.

  A change to SQL migrations alone does not yet move the migration digest the registry compares, so the registry does not require an acknowledgement for it. The dashboard asks anyway, and says that it is the one asking.

  Listing a vertical's versions no longer reads each version's whole manifest, only the two fields a version record shows, so a vertical with a long migration history lists as fast as before.

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0

## 0.120.0

### Patch Changes

- 1de077d: Require an active hostname, correctly paired active scope and active owning tenant for hostname resolution. Non-active lifecycle now returns no route (the router's existing neutral 404), preserving bindings for restoration. Active previews and embedded routes remain supported. This gates new directory lookups only; CP-less background/internal calls and existing connections remain outside this change.
  - @substrat-run/contracts@0.120.0

## 0.119.0

### Minor Changes

- bc6a6bb: A link share of a folder or a document can now deliver the files under it.

  `ScopeHost.getCapabilityAttachments(sessionToken, tenantId, scopeId)` is the attachment surface for a capability session, the counterpart of `getConnectorAttachments`. It is optional, so an adapter built before it still satisfies the interface. Both adapters implement it:

  - **Reads** (`list`, `open`) check the attachment target's `readPermission` on the file's entity, as `{ capability }`, through the same checker an invoke uses. That checks the capability's keys and its entity subtree, and re-checks that its minter can still read. The session is resolved again on every call, so a revoke or an expiry refuses the next download. A read never takes a use.
  - **Writes** (`upload`, `remove`) are refused, even when the capability carries the write key, and the refusal is recorded in the denial log against the capability. No bytes reach the blob store. The refusal is the kernel's `capabilityAttachmentWriteRefused`.
  - **A capability minted with `operations` can't read attachments.** No attachment verb is an operation it could have listed, so those reads are refused as `forbidden`.

  `@substrat-run/vertical-host` adds `mountLinkShareDownload` (`GET /api/capability/attachments/:attachmentId`) and `linkShareAttachments`. Both use `linkShareStub`'s precedence: the `sb_capability` cookie first, then the signed-in visitor. A host without `getCapabilityAttachments` refuses a request carrying the cookie instead of answering as the visitor. The download is sent `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and a `sandbox` content security policy, always as `Content-Disposition: attachment` (`attachmentDisposition`).

  `@substrat-run/contract-tests` adds `capabilityAttachmentContractSuite`, and its capability fixture now declares attachment targets on `doc` and `folder`.

- 84b5fe2: Every connector call now becomes one data point, so connection health has a trend and not only a last line.

  `@substrat-run/kernel` adds `connector-calls.ts`: the `ConnectorCallRecorder` interface, a no-op default, and `analyticsEngineConnectorCallRecorder`, which writes one Analytics Engine point per call and counts the writes it drops. The record is keyed by OpenTelemetry semantic-convention names: `substrat.tenant.id`, `substrat.vertical` (the slug), `substrat.connection.provider`, `error.type`, `http.response.status_code` and `http.client.request.duration` (in seconds). `error.type` is absent on success and otherwise one of a closed enum (`4xx`, `5xx`, `other_status`, `timeout`, `network`, `_OTHER`), so no field can carry a credential, URL, body or error message. `CONNECTOR_CALL_DATA_POINT_LAYOUT` publishes which Analytics Engine position holds each name, and only grows. `recordConnectionUse` also accepts optional `durationMs`, `status` and `timedOut`, and `settleConnectionUse` builds that settlement from a response or a thrown error.

  `@substrat-run/adapter-sqlite` and `@substrat-run/adapter-cloudflare` take an optional `connectorCalls` recorder, which defaults to the no-op. Each host records a call where it settles the health line, using the identity on the connection row. The call to the recorder is fire-and-forget: it is never awaited, and a throw is swallowed. The connection's `fetch` now times each call.

  `@substrat-run/control-plane-api` adds `GET /connections/calls?hours=&provider=`, a staff and service read of calls and errors per provider, bucketed and sampling-weighted, for up to seven days. Tenant and builder credentials are refused, and the route answers 501 until `createCfObservabilityReader` is given a `connectorCallsDataset`.

  The Scrive, Fortnox and Planima connectors time the calls they make on their own connections, so those calls carry a duration too.

- 929ec09: A vertical can receive another vertical's events in the same tenant (#1705).

  The producer declares what may leave, as `events.exports: [{ type, schemaVersion, readPermission }]`. `eventsExportedBy(ops, { type: key })` derives this from the operations' `emits`. It refuses any type that an operation classifies other than `piiClass: 'none'`, any type no operation emits, and any type emitted at two versions. The consumer declares what it takes, as `events.consumes: [{ from: '<vertical slug>', type, schemaVersion }]`. Its handlers go in a new `ModuleRegistration.imports` map (slug → type → handler), never in `consumers`. That way, a host that predates this reads the `from` entry as an inert local consume and does not wire the handler as a local consumer.

  `@substrat-run/contracts` adds `consumedEventRef`, `eventExport`, and the wire schemas for an edge: `exportReadInput`, `exportedEvent`, `exportedBatch`, `withheldEvent`, `importState`, `importBatch` and `importResult`. The permission registry gains optional `exports` and `imports`, omitted when empty so no existing `digests.permission` moves. `sweepRunKind` gains `vertical-events`. The cause walk has a new terminal, `imported`, with `causeChain.imported` saying where the chain continues. `ImportedEvent` is the crossed fact: id, type, version, time, entity and payload. It never carries the producer's actor, authorization or impersonation.

  `@substrat-run/kernel` adds three required members, so every implementation of `HostAdmin`/`ScopeHost` needs them:

  - `HostAdmin.readExportedEvents` is the producer's release. The producer's own exports decide what leaves, the receiver's key must be held at the producer's scope, and classified, off-version, over-cap and undecodable rows are withheld.
  - `HostAdmin.importState` returns the consumer's declared imports and its watermark per producer.
  - `ScopeHost.deliverToPeer` is the consumer's apply. It runs under a compare-and-set on the watermark, one transaction per (event, module) with its delivery row, and moves the watermark last.

  The kernel also adds `runPlatformSweep`'s opt-in `crossVertical` phase, which reports every edge (`delivered`, `idle`, `paused`, `unresolved`, `stale`, `failed`) and writes a `vertical-events` sweep-run row for each edge that moved or could not run. Its cost is bounded. It calls only the scopes its reach names as `candidates`: the host's own `registeredImports()` by default, a new optional `ScopeHost` member, so a deployment that imports nothing calls no scope at all. It visits at most `maxConsumers` of those per pass (default `CROSS_VERTICAL_CONSUMERS_PER_PASS`, 100) in a rotating window, and defers the rest. It adds the shared `VERTICAL_EVENTS_DDL`, which covers `_substrat_imports` (envelope only, never a payload), `_substrat_import_cursors`, and a `(type, id)` outbox index. The kernel also exports `CrossVerticalRegistry`, the planner (`planExportBatch`, `exportReadPlan`) and the hop walk. `readDeadLetters` now lists an imported event's dead letters beside local ones.

  Both adapters implement all of it. `@substrat-run/contract-tests` adds `verticalEventsContractSuite` and its two fixture verticals, run on the pure host and on workerd.

  `@substrat-run/cli` leaves a `from` consume out of the declared event surface, since it never lands in the consumer's own outbox. The dashboard's cause view explains an `imported` ending. The console's Sweep runs view can filter to cross-app events.

- a9cfc4a: The schedule kill switch (#1666) gets a status read: "is this module switched off on
  this scope?", without the scope's own SQL console.

  `GET /tenants/:t/scopes/:s/system-grants` (staff/service only) answers, per module the
  scope holds or has ever held system authority for, `on` / `off` / `ungranted` — the
  kernel's `systemScheduleState`, the SAME predicate `runDueSchedules` gates on, so the
  read and the runner cannot disagree — and, while `off`, who switched it off, when, and
  why, from the admin log's `intent` row for the `revokeFromSystem` still in force.

  `@substrat-run/kernel` adds `HostAdmin.systemGrantsStatus` (a required member — every
  `HostAdmin` implementation, in or out of tree, needs one) and exports the enumerator it
  is built from, `systemGrantsStatus`, plus its `SystemGrantsEntry` shape. `@substrat-run/contracts`
  adds the two wire schemas: `systemScheduleEntry` (the bare position, no audit join — what a
  vertical's own deployment can honestly answer for itself) and `systemGrantsStatusEntry`
  (that plus `switchedOff`, the control plane's own answer).

  For a hosted scope the read is delegated to the deployment serving it, exactly the way
  `revokeFromSystem`/`restoreToSystem` delegate the write: `SystemSwitchDelegation` gains a
  `status` method (`@substrat-run/adapter-cloudflare`), and `@substrat-run/vertical-host`'s
  `mountPlatformSurface` adds `GET /internal/system-grants` against a new OPTIONAL
  `VerticalScopeHost.systemGrantsStatusLocal` — a deployment built before this ships still
  satisfies the interface, and the route answers 501, which `@substrat-run/control-plane-api`'s
  new `VerticalClient.systemGrantsStatus` reports as "redeploy the vertical", the same
  skew handling `systemSwitch` already gives the write (a 404, an SPA shell, or a 200 of
  the wrong shape are all read as "this deployment predates the route", never a wrong `on`).

  The admin-log join (who/when/why) happens only on the control plane — a vertical's own
  deployment holds no admin log to join against, so `/internal/system-grants` and
  `systemGrantsStatusLocal` answer the bare position (`systemScheduleEntry`) only.

- 2c65b67: One vertical can now call another vertical's operations in the same tenant. The platform identifies the calling app, so it holds no token and needs no pasted API key, hostname or outbound allowlist entry (#1706, part 1: the kernel half).

  **The target declares who may call it.** A module manifest can declare `peers`: another vertical's registry slug, the operations that vertical may invoke, and the permissions it holds while doing so.

  ```ts
  peers: [
    {
      vertical: "acme/board-room",
      operations: ["customer/list"],
      permissions: ["customer:read"],
    },
  ];
  ```

  - **The keys are seated at provisioning** as `vertical:<slug>` grants, the way a schedule's `system:<module>` grants are.
  - **`lint:permissions` renders them** in a new PERMISSIONS.md section, so widening what another app may do shows up in the reviewed permission diff. It also refuses a peer key or operation that no module declares.
  - **`operations: []` declares a receive-only peer.** It holds its keys and can invoke nothing.
  - **`permissions: []` is refused.** A peer entry that grants nothing declares nothing.

  **The caller is an actor of its own.** `@substrat-run/contracts` adds `verticalActor` (`{ vertical, scope }`: the calling app and the instance that called) to the actor union, and a `{ kind: 'vertical' }` check subject. It also adds `peer.ts`, which holds `verticalCaller`, `peerSpec`, `verticalInstance`, `verticalResolution`, `peerSwitch` / `peerSwitchResult` / `peerSwitchOutcome`, `peerCoverage`, and the `VerticalSlug` type. `adminAction` gains `revokeFromPeer` / `restoreToPeer`.

  **`@substrat-run/kernel` adds the peer door and its supporting verbs:**

  - **`ScopeHost.getVerticalScope(caller, tenantId, scopeId)`**, the sixth door. Every invoke is admitted inside the scope (`admitPeer`): the caller must be a declared peer, its switch must be on, and the operation must be on its allowlist. A refusal is `forbidden`, and it is not a K-35 denial. Inside, the operation is ordinary: checks resolve the declared grants, and events and denials name `{ vertical, scope }`. No principal crosses, and a peer cannot mint a capability.
  - **`ScopeHost.peerCovers`** reports whether a peer holds each key right now, using the checker's own answer.
  - **`HostAdmin.resolveVerticalInstance(tenantId, vertical)`** finds "the instance of vertical Y in tenant T". It applies one rule, `resolveVerticalInstanceFrom`: a primary, active scope of that tenant, exactly one. Otherwise the answer is `not-installed` or `ambiguous`, never a guess.
  - **`HostAdmin.revokeFromPeer` / `restoreToPeer`** are the per-(scope, peer) kill switch. It runs the schedule switch's own statement, now generalised as `switchSubjectGrants`. OFF tombstones the peer's grants and blocks the provisioning seat, so the next call is refused and nothing a re-provision does brings the grants back.

  These are REQUIRED members of `ScopeHost` and `HostAdmin`, so every implementation in or out of tree needs them. The shared rules are exported from `peer.ts`.

  **Both adapters enforce all of it.** On the Durable-Object path, the coordinator threads the caller to the ScopeDO, which admits it in its queue on every invoke and acknowledges it. The coordinator refuses a success the DO did not acknowledge, the capability session's skew pattern.

  **What "enforced" does and does not mean on Cloudflare.** A deployment ENFORCES a peer call the platform forwards to it: the door, the declared grants, the allowlist and the switch all run there, on real Durable-Object SQLite. A hosted deployment cannot yet ORIGINATE one, because nothing on the hosted path says who is calling until the router hop lands in the next release. Locally, the broker below stands two verticals side by side today.

  **`@substrat-run/vertical-host`** adds `/internal/vertical-invoke`, which takes a strict body naming the caller and nothing that could act as a person, and `/internal/peer-switch`. Both sit behind the platform secret, like every `/internal` verb. They use two OPTIONAL `VerticalScopeHost` methods, and a deployment built before them answers 501.

  **`@substrat-run/adapter-sqlite/vertical-broker`** is the pure host's stand-in for the platform hop. It lets two verticals run side by side locally under the same model. It is a node-only subpath (the `workerd`/`worker`/`browser` conditions resolve to nothing).

  **`@substrat-run/boundary-lint` R9** refuses importing that subpath anywhere but a test, `server.ts` or `seed.ts`.

  **`@substrat-run/contract-tests`** adds `peerContractSuite`, `verticalResolutionContractSuite` and the `peerMod` fixture.

  **The console's denial log and the dashboard's history strip** name a peer as the app it is.

  Not in this release: the hosted transport (the router hop that identifies the calling deployment, and the caller's `calls` declaration), the dashboard controls for the switch, and a binding for a tenant that runs two instances of one vertical.

- 8009cd1: A deployed vertical can now call another vertical of the same tenant. The platform says which app is calling, so the caller holds no credential (#1706, part 2: the hosted transport). Part 1 built the door; this is the path to it.

  **What a vertical author writes.** The caller declares who it calls, in package.json:

  ```json
  { "substrat": { "calls": ["acme/crm"] } }
  ```

  and calls it from its harness:

  ```ts
  const result = await peerClient("acme/crm").invoke("customer/list", {
    limit: 50,
  });
  ```

  There is no address, no token and no outbound-allowlist entry. What the caller may then DO is the target's own `peers` declaration, which its permission diff reviews.

  **How the platform knows who is calling.** The call goes to one reserved address, `peer.substrat.internal`, which is in no DNS zone:

  - the **egress worker** — which every dispatched `fetch` passes through — recognises that address before its outbound policy and hands the call to the router, with the caller taken from the dispatch parameters the router set when it dispatched the caller. Nothing in the request contributes to it, and the body is strict, so it cannot carry one;
  - the **router**'s `PeerCalls` entrypoint (reachable only through a service binding, never over its public `fetch`) resolves the target in the caller's own tenant and dispatches the target's `/internal/vertical-invoke`;
  - a call made where egress cannot see it — from inside a Durable Object, which outbound workers do not intercept — **fails to resolve** instead of leaving the isolate. That is why the address is unroutable rather than real.

  **Module code reaches a peer asynchronously.** An operation, a consumer or a schedule runs inside the scope's Durable Object, where module code has no network by rule. It enqueues a `peer-invoke` platform intent instead (`ctx.requestPlatform`), and the control plane's drain delivers it with the caller taken from the scope it found the row in. At-least-once, with the intent id as the idempotency key.

  **The gates, on both legs:**

  - the caller's declared `substrat.calls` (a version pushed before the declaration carries `null` and is unenforced, exactly as a pre-#303 `outbound` is);
  - the caller is a live, primary instance of the vertical it claims — never a preview, and the refusal names the local broker as the way to test the edge;
  - the target resolves to exactly one primary, active instance **in the caller's tenant**, never guessed when a tenant runs two;
  - a synchronous chain is bounded by `PEER_CALL_DEPTH_MAX`, its own constant, deliberately not shared with #1705's event hop cap.

  **Contract additions.** `@substrat-run/contracts` adds `peer-transport.ts` (`PEER_CALL_HOST`, `PEER_CALL_URL`, `isPeerCallHost`, `PEER_CALL_DEPTH_MAX`, `peerCallRequest`, `peerCaller`, `callsDeclares` and the refusal messages) and the `peer-invoke` intent kind with its payload. The deploy manifest, `RouteTarget` and the version record each gain `calls` beside `outbound`, lifted from the stored manifest by `callsOfManifestJson`. `@substrat-run/vertical-host` exports `peerClient`; `@substrat-run/control-plane-api` adds `VerticalClient.verticalInvoke` and `peerInvokeHandler`; the Cloudflare adapter adds `createPeerCallResolver` and the directory's `peerCallTarget` read.

  **Operators:** the egress worker needs its new `PEER_CALLS` binding to the router's `PeerCalls` entrypoint, and the router now deploys from `src/index.ts` (which exports both the fetch handler and that entrypoint). Without the binding, peer calls are refused — never passed through.

  The console scope page and dashboard app page now show incoming peer access and offer cut-off/restore controls with an audited reason. Hosted switch/status calls delegate to the deployment holding the grants. The dashboard also discloses outgoing targets after installation, keeping missing targets, refused access and unreadable status distinct. `peersDeclaredBy` derives peer permissions from the model's operations. The architecture guide includes an executable local call/cut-off/restore example and operator rollout steps.

  Instance binding when a tenant runs multiple active targets remains excluded, tracked in #1720; ambiguous calls are refused.

- b080e0f: A per-PR preview of an app that signs in at one of the team's auth servers now has a login
  (#1704). A fork copies the app's data and none of its delivered config, and every push binds a
  new version whose config store starts empty. The app's `substrat:auth` holds a client secret
  the platform never stores or reads back, so it can't be copied. Instead, each `preview create`
  (and each push to the preview) gives the preview **a client of its own** at that auth server
  and delivers it as the preview's `substrat:auth`, along with the shared-issuer marker. The
  app's own client is never changed and never learns a preview's callback. Reaping the preview,
  by `preview delete`, `--refresh` or TTL expiry, deletes its client.

  `@substrat-run/contracts` adds the protocol between the control plane and the auth server
  (`preview-client.ts`): three platform-gated routes, `POST /internal/preview-client/check`,
  `POST /internal/preview-client` and `DELETE /internal/preview-client`, with their request and
  response schemas. Every redirect URI on that wire must be `https:`: loopback is refused, since
  both ends are hosted and previews don't exist in local dev. It also adds `oidcCallbackUrl` / `OIDC_CALLBACK_PATH`, and `previewAuth`, the
  `auth` field of `preview create`'s answer.

  `@substrat-run/control-plane-api` adds `VerticalClient.checkPreviewClient` /
  `mintPreviewClient` / `retirePreviewClients`. A deployment that predates the routes (a 404, the
  auth server's JSON 501 fallback, or an SPA shell) reads as "redeploy the auth server", never as
  "the app does not sign in there". It also adds `wirePreviewAuth`, `retireAllPreviewClients` and
  `retireClientsOfReapedScope`. The previews routes answer `auth` and `notes` on create, and
  `callbackUrl` on every listed row.

  `@substrat-run/demo-auth-server` implements the three routes. An install claims an app only on
  a binding **the platform** wrote there (a #1670 places row or a #1619 resource row), together
  with a live client redirecting to the app's callback. Open DCR can forge a callback match on
  its own, so a match alone is not enough. The route refuses a call for any tenant but its own.
  The client is registered through the plugin's own dynamic registration and recorded in a new
  `preview_client` table. Deletes select from that table only, so no delete can reach a client
  it did not mint for that preview.

  `@substrat-run/cli`'s `preview create` prints what happened to the login. For an app on an
  external issuer it prints the preview's callback, and it says that no login config was
  delivered. It also says that per-install Env settings are not carried over.

### Patch Changes

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0

## 0.118.0

### Minor Changes

- 56a931b: A subject erasure now reaches two more places a copy of the person could survive.

  A redacted platform intent's `result` is redacted too. It is whatever the drain's handler
  returned, and for a connector that is the provider's answer about delivering this person's
  data, so it could quote them. A non-NULL `result` now becomes the same tombstone as the
  payload, and a NULL one stays NULL. `last_failure` is nulled beside it: it attributes
  `last_error`, and once `last_error` is the redaction note, a kept `origin: 'provider'` would
  caption the platform's note as the provider's words.

  The resumable run tables, `_substrat_job_runs` and `_substrat_job_steps`, are reached for
  the first time. A run carries no subject column, so the erasure uses the link it already
  uses for intents: a copy of an event classified as the subject's, at any depth, in the
  run's payload, its cursor or a step's stored result. Each such column is replaced by the
  tombstone and the row's `last_error` by a note. A run still in progress is settled
  `failed`, so no pass is handed a tombstone as a step's answer. A pass that was mid-flight
  when the erasure landed can no longer write its cursor, its status or a fresh step result
  back over the redaction, because both writes are now a compare-and-set on the run still
  being `running`. What this does not reach is external output that names the person with
  no classified event around it. That is stated as a limit in the kernel design, and
  declaring a subject on a run is the open design that would close it.

  A failed delivery of one of the subject's redacted events has its error text replaced by a
  note, because a consumer's or executor's throw can quote the payload it failed on. A
  delivered row is left alone, since an error there would mark it dead-lettered.

  `SubjectShredReceipt` gains `jobRunsRedacted`, counted once per run however many of its
  columns and steps were rewritten, and defaulted so an older receipt still parses. On the
  hosted adapter, an erasure against a scope whose host predates this change is refused
  with a `503` before the subject key is touched, as it already was for a host that
  predates the intent redaction, so it can be re-run after a redeploy.

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0

## 0.117.0

### Minor Changes

- 6504a99: A vertical can now share by link, and the permission checker enforces the link. A capability is authority carried by a secret rather than held by a principal: "anyone with this link may read this folder until Friday". An operation mints one with `ctx.capabilities.mint({ entity, permissions, operations?, expiresAt?, maxUses? })` and gets the secret back once. Whoever exchanges that secret acts as `{ capability: <id> }`, which is a new member of the event and denial actor union.

  - **Exactly one subtree, exactly its keys.** A capability reaches its entity and everything beneath it through declared parent edges, and only the keys it carries. It holds no node-level authority, so an operation whose only check is a node-level one refuses it. An optional `operations` list narrows it further, and is enforced before the handler runs.
  - **Never more than its minter holds, on every use.** Each key is checked on the entity at mint time with the operation's own check, the same way `ctx.grant` checks. The checker also re-checks the minter every time the capability acts, so a link stops granting the moment its minter loses access. Only a principal may mint. A capability, a connection, a schedule or a consumer cannot.
  - **Directory-backed.** The capability is a row in the scope's own spine (`_substrat_capabilities`), read on every check. A revoke takes effect on the next call, including through sessions already handed out. `ctx.capabilities.revoke` is open to anyone who could have minted the capability, and `ctx.capabilities.list` reads them back.
  - **A use is an exchange, not an invocation.** `ScopeHost.exchangeCapability` trades the secret for a session token and counts one use. `maxUses` bounds how many browsers may hold a capability, not how many reads they make. A single-use capability exchanged twice at once admits one. `getCapabilityScope(sessionToken, …)` is the door, and it re-resolves the session on every invoke.
  - **On the spine.** Events a capability causes carry `{ capability }` as their actor, with K-34 authorization naming the root it was granted on. Its refusals land in the K-35 denial log. Every exchange is a `capability.exercised` spine event. A MODULE's mint and revoke (`ctx.capabilities`) are spine events too (`capability.minted`, `capability.revoked`), but the platform's `HostAdmin.mintCapability` and `HostAdmin.revokeCapability` write the admin log only. A consumer must not wait for a `capability.minted` or `capability.revoked` that a platform mint or revoke never produces.
  - **Only the secret's hash is stored.** The kernel keeps its SHA-256, and an idempotent replay of a mint returns `[capability secret withheld]`. There is also a tripwire for accidents: while the minting invocation runs, `ctx.emit`, `ctx.requestPlatform` and `ctx.sql` refuse any record that carries the secret verbatim, anywhere in it (keys, entity ids, request kinds and byte parameters included). It catches a module persisting its own secret by mistake. It is not a boundary against a module that means to leak one, which could encode it first.
  - **`@substrat-run/vertical-host`: `mountCapabilityExchange`.** The link carries the secret in its fragment (`#share=…`), which never reaches a server. The page posts it once to `/api/capability/exchange`, and the response sets the session as an HttpOnly `sb_capability` cookie, with `no-store` and `Referrer-Policy: no-referrer`. `capabilityStubOf(c, host, node)` then gives a request's stub.
  - **`become` capabilities, platform-minted.** `HostAdmin.mintCapability` mints a capability whose exchange yields a principal, the shape an owner claim link or an invite has. It requires an expiry and a use limit, and is audited. `HostAdmin.revokeCapability` revokes any capability. An exchange can name the one mode it takes, and a secret of the other mode is refused without spending its use.
  - The dashboard's history and the console's denial log name a capability actor as the link it came through.

- aabc227: A permission key is at most 41 characters now, and `ctx.check` refuses one that is not a key.

  **Breaking, for a key of 42 characters or more.** `permissionKey` gains `.max(41)`, exported as
  `PERMISSION_KEY_MAX_LENGTH`. A manifest, role or grant naming a longer key is refused when it is
  parsed, including at push. It is not an arbitrary number: the checker finds a principal's grants
  with `relation LIKE 'granted:<key>%'`, and a Durable Object's SQLite refuses a LIKE pattern over
  50 bytes. A 42-character key parsed, deployed, and then made every check of it throw on a hosted
  scope while passing every local test. The longest key declared anywhere in this repository is 29
  characters.

  **`ctx.check` parses the key it is handed.** The `PermissionKey` type is compile-time only, so a
  module that cast a string past it (`'Workorder:Read' as PermissionKey`) used to be refused as a
  denial and recorded in the denial log under a key that cannot exist. Under a system actor (a
  consumer), whose check is allowed without asking the checker, the same key was allowed, and
  `ctx.grant` wrote it into the tuple store. Both adapters now parse the key first, above the
  system-actor shortcut. A malformed key throws an `internal` error that names it. That error is not
  a denial, so no denial row is written. `ctx.grant` and `ctx.revoke` inherit the check, because they
  re-check before writing.

  It fails closed. A throw hands back no decision, so nothing can pass `assertAllowed`, and nothing is
  added to the `authorization` the operation's events carry. A caller that catches the throw and
  carries on has skipped a check. It has not been granted one.

  The new `assertPermissionKey` in `@substrat-run/kernel` is the one parse both adapters call.

- 44299a1: A subject erasure now reaches the spine's second copy of an event. `shredSubject`
  redacted `_substrat_outbox` and nothing else, but a host with no control plane cannot
  run a connector, so each connector delivery becomes a `connector:<provider>` platform
  intent whose payload is the whole event — and nothing ever deletes those rows. A name
  therefore survived the erasure in the live scope database, and in every export, backup
  and PITR window taken from it afterwards. Both tables are redacted now, in one pass.

  The intent's `payload` column is `NOT NULL`, so it is replaced by an obviously-redacted
  tombstone rather than nulled; `last_error` goes with it, being free text a provider
  wrote about this person; and a still-pending intent is settled `failed` in the same
  statement, so nothing is ever handed a tombstone to drain. The row itself stays, so the
  journal still shows that something was asked of the platform, by whom, and when. Which
  intents are selected is the outbox's own predicate — the subject, and a `piiClass` other
  than `none` — read off whatever event the payload embeds, so a copy is never judged more
  harshly than the original. `SubjectShredReceipt` gains `intentsRedacted` beside
  `eventsRedacted`, defaulted so an older receipt still parses.

  Settling a platform intent is now a compare-and-set on `status = 'pending'`. The drain
  reads pending rows, runs a handler, then settles, so a settle can land after an erasure
  has redacted the row — and settling by `id` alone wrote a provider's reply, which can
  quote the person, back into `last_error` on a row whose payload had just been emptied.
  Nothing legitimate is refused: the drain only ever reads pending rows, so every settle
  targets one that was pending when it was read. A settle that finds the row already
  terminal now does nothing.

  On the hosted adapter, an erasure against a scope still running a scope host from before
  this change is **refused** rather than half-performed. That host's redaction never reaches
  the intent journal, so going ahead would destroy the subject's key — the irreversible half
  — while leaving their payloads in place. The refusal is a `503` naming the scope, and the
  erasure can simply be re-run once the vertical is redeployed.

- 4ef164c: A promote of a listed vertical now re-runs provisioning on its installs, so what a new
  version's `onProvision` sets up reaches the installs that already existed.

  The sweep's provision reconcile (#1172) compared a scope's receipt with its bound version. A
  listed vertical's promote re-serves every install in place but moves none of their version
  pointers, which belong to each tenant and move when that tenant presses Update. So the phase
  never saw those installs: a new service principal, a site registration or a place on the
  sweeper roster never reached them. The phase now compares against the version that RUNS on
  the scope (`runningVersionOf`): for a scope on its vertical's serving script, the version
  the script serves. Tenants' version pointers are not touched, so Update is still offered.

  - **Paced.** At most `provisionReconcileBatch` scopes per pass, default 50, set on the
    control plane as `PROVISION_RECONCILE_BATCH` (`0` pauses the phase). The rest are reported
    as `deferred` and reached on later passes. Each pass starts its window at a random point
    in the behind set (`provisionReconcileRng` injects it), so installs that fail every time
    cannot keep healthy ones waiting.
  - **Forks never.** The phase keeps only primary scopes, via the now-exported
    `isPrimaryScope`: no `forkedFrom`, and not `kind: 'preview'`. A PR preview is a restored
    copy of production data.
  - **`unsupported` apart from `failed`.** A vertical with no `/internal/reconcile` answers 501. `reconcileScopeFn` may resolve `'unsupported'` for it, which is counted, reported with
    up to 50 scope ids, not marked and not listed as an error.
  - **The receipt names what ran.** A reconcile records the version of the deployment it
    actually reached (`versionReachedAt`, from the rung of the resolution ladder that chose
    it). The console's **Re-run provisioning** records that. The sweep passes
    `reconcileScopeFn` the version it will record (`expected`), and the control plane refuses
    to reconcile through a deployment that runs anything else. If the serving ref doesn't
    resolve and the ladder falls back to the bound version's deployment, the scope never looks
    repaired while the served version's hook has not run.

- 269fa7a: A reconcile no longer undoes a revoke. Re-running provisioning creates the grants it finds
  missing and leaves a revoked one revoked.

  Provisioning re-runs often. A private vertical's push, the console's **Re-run provisioning**,
  a tenant's Update and, since the last release, every listed promote each reconcile the
  installs. Each reconcile re-wrote the tuples provisioning grants with
  `INSERT OR REPLACE … revoked_at = NULL`. That created a missing grant, but it also brought
  back a revoked one. So a revoke of the owner's seat, of a connection grant, or of a module's
  `system:<module>` schedule grant (the per-scope switch that turns its schedules off) lasted
  only until the next reconcile, and nothing said so.

  Provisioning now **seats** a tuple instead, with the kernel's new `seatScopeTuple`. Both
  adapters use it: `provisionScopeLocal` on Cloudflare, and `provisionScope` on both.

  - **Missing** → created, live. A scope whose storage was recreated is still repaired (#332).
  - **Live** → its expiry follows the platform's, as before.
  - **Revoked** → left exactly as it is, including `revoked_at` and `expires_at`.

  **One exception, for the owner's seat.** If leaving the owner-of-record revoked would leave
  the scope with no effective role grant at all, a reconcile re-seats the owner. A scope nobody
  can act in is the lockout a reconcile exists to repair. So revoke the owner **after** seating a
  successor, and the revoke holds. "Effective" means what the permission check means: someone
  holding a role the vertical still defines. A grant of a role a later version removed passes no
  check, so it does not count as a holder, and it no longer keeps a scope from being repaired.
  The guard that decides whether a scope enforces its permissions locally reads the same rule.
  Two consequences of the owner exception:

  - Revoking the last role holder is undone at the next reconcile.
  - The owner it re-seats is the one `owner_of_record` names, and the first owner written there
    stays. If a successor is later revoked too, the original owner comes back.

  To lock out a compromised owner, suspend the scope. A seat revoke is not that lever.

  An explicit grant still clears a revoke: `assignScopeRole`, `grantEntityLocal`,
  `connectorGrantLocal`, and `HostAdmin`'s `assignRole`, `grant`, `grantToSystem`,
  `grantToConnection` and `grantToOrg`. Granting someone again gives them access again.

- 105a4c3: A scope's schedules now have an off switch that holds. `HostAdmin.revokeFromSystem` turns
  one module's scheduled work off on one scope, and `restoreToSystem` turns it back on. Both
  take a required `reason`. Each call writes two admin-log rows, its intent first and then
  its outcome, paired by the `operationId` the call answers with. A repeat call is logged
  too. Staff reach them over HTTP as `DELETE` and `POST` on
  `/tenants/:tenantId/scopes/:scopeId/system-grants`, with the body `{ moduleId, reason }`.

  - **Module-wide, on one scope.** Schedules share permissions, so switching off one schedule
    or one permission would either switch off its siblings too or make it fail on every pass.
  - **Nothing fires while it is off.** `runDueSchedules` reports each schedule as `skipped`,
    with `switchedOff: true` on the report. It is never `failed`, and the cadence clock is left
    alone, so a due schedule fires on the first pass after the restore.
  - **It is a kill switch, not a pause.** The module's `system:` grants on the scope are
    revoked too, so a job run acting with that authority is denied by its own check.
  - **Restore is the lever; a grant is not.** The off position is its own marker tuple. While
    it is off, `grantToSystem` for the module on that scope is refused (409 `conflict`), and a
    reconcile seats none of the module's system grants, not even one a newer version declares.
    A restore gives back exactly what the switch took. A grant revoked separately before the
    switch was pulled stays revoked.
  - **Provisioning's seat is now `seatScopeTuple`**, which replaces the `SEAT_SCOPE_TUPLE_SQL`
    constant (unreleased) because it binds the subject twice.
  - **Hosted scopes.** The switch is moved in the vertical's own deployment, over the new
    platform-secret `/internal/system-switch` route. A deployment built before that route
    answers with a 501 that says to redeploy, and nothing is switched. A transport failure or a
    5xx from the vertical is reported as a failure, because the switch may have moved.

- a8c2c64: A tenant's storage can be read on demand: the size of each of its scope databases, and their sum.

  `GET /meters/storage?tenantId=…` (staff-only) answers one page of the tenant's scopes, each
  with its database size in bytes: `SqlStorage.databaseSize` on Cloudflare and
  `page_count × page_size` on SQLite. A scope is read through `HostAdmin.scopeDatabaseSize` when it is co-located, and
  through the vertical's new `/internal/database-size` when a vertical's deployment holds it.
  The console's tenant page has a **Storage** card that reads only when the button is pressed.

  Nothing is stored and nothing sweeps. Reading a scope's size wakes its Durable Object, so a
  reading is bounded to one page of at most 200 scopes (default 50) with at most 8 reads in
  flight, and there is no fleet-wide form. A scope whose read fails is listed with its error and left out
  of the sum, and the reading says `complete: false`. Only a reading that covered every scope
  with no failure is complete. Attachment files, per-tenant D1 databases and the lake are
  not counted, and each reading names them in `excluded`.

  `HostAdmin.scopeDatabaseSize` is a new required method on the kernel's host-admin interface.
  `VerticalScopeHost.databaseSizeLocal` is optional, so a vertical built before it still
  satisfies the interface, and its route answers 501 rather than a size.

- 02c181a: The recorded sweep history no longer drops one of two entries when a recurring schedule and a freshness expectation in the same app happen to share a name.

  An app's sweep reports its outcomes in batches, one batch per pass, and each entry is filed under the thing it is about: a schedule under its operation name, a freshness expectation under its event type. Nothing keeps those two sets of names apart — `orders.placed` is an ordinary name for either — and duplicate protection judged an entry by its batch and that name alone, without asking which kind it was. So when a schedule and a freshness expectation in one app shared a name, whichever of the two arrived second in a batch was discarded as a duplicate, with no error. The history then showed a gap, and a gap is exactly what a stopped freshness check or a missed schedule run looks like there.

  Duplicate protection now takes the kind into account, so the two entries are kept side by side. A batch delivered twice is still recorded once.

  Existing platform stores are updated the next time they start, on both the self-hosted and the hosted store: the duplicate check is replaced, and every entry already recorded is kept exactly as it was. Nothing to change to adopt it.

- 2fa5147: One malformed platform-intent row no longer makes a scope's whole intent list unreadable.

  Every read of a scope's intent journal returns a list — the drain's pending queue, the
  journal history, and `ctx.platformRequests` inside an operation — and the row decode behind
  all three was strict. A single row whose JSON would not parse therefore threw for the whole
  scope: the drain could not read its own queue, and the history read, which exists so a
  failed intent explains itself afterwards, was switched off by exactly the row that failed.
  Module code cannot write such a row, but a restore replays a dump's rows verbatim, so a dump
  from another world or one edited by hand was enough.

  The reads are tolerant now, and say so. A row that does not decode is returned beside all
  the others with a new optional `decodeError` naming every column that failed, and each of
  those fields comes back empty — `null`, or a self-naming marker for the requester — rather
  than guessed at. Every value a read returns still satisfies the published `PlatformRequest`
  schema: a row whose id, kind, status, attempt count or request time is itself corrupt has no
  honest empty value to fall back to, and is still refused as it was. A row the platform wrote
  carries no `decodeError` at all, so a healthy list reads exactly as it did before. The three
  copies of the decoder are now one, in the kernel (`platformRequestOf`).

  The drain stays strict where it acts. A row carrying `decodeError` never reaches a handler:
  it is settled `failed`, attributed to the platform, with the decode failure in its
  `lastError`, and lands as a terminal ops failure like any other refusal.

- 1f223f5: One malformed event or denial row no longer hides a whole list, or stops the work queued behind it.

  A row whose JSON would not parse used to throw out of every list it appeared in. That covered an
  entity's history and timeline, the walks that explain why something happened, the denial log and
  its summary. Worse, it covered the event deliveries themselves, where one bad event halted every
  event of its type behind it on every pass. Module code cannot write such a row, but a restore
  replays a dump's rows verbatim, so a dump from another world or one edited by hand was enough.

  **The reads return it, and say so.** A history, timeline, cause-walk, invocation, denial-log or
  denial-summary row that does not decode now comes back beside all the others. It carries a new
  optional `decodeError` naming every column that failed, and those fields come back empty: the
  actor as `{ system: 'undecodable' }`, a JSON field as `null`. That is what tells an unreadable
  payload from an erased one. Every value still satisfies the published schema. A row whose own id,
  type or time is corrupt has no honest empty value and is still refused, as before.

  A denial whose permission key is malformed is listed, not refused. That row can come from a
  module that cast a bad key into a permission check, not only from a dump, and the log is where
  you go to find out why. Its permission reads as `undecodable:permission`, and `decodeError` quotes
  the key it actually checked. A healthy row carries no `decodeError` at all, so a clean list reads
  exactly as it did.

  **The work skips it, and keeps going.** An event that does not decode is dead-lettered for each
  consumer and executor it was due for, with the columns that failed as the error. Its handlers are
  never called with it, and the events behind it are delivered. An executor gives up on such an event
  on the first attempt, since decoding the same stored text again cannot succeed. The Tier-2 drain
  steps over the row too. It is never shipped in a guessed-at form, because the lake cannot take a
  row back, and it is never stamped as drained, because it never left. The events behind it still
  ship. The sweep reports the skipped event ids on every pass, and `readHistory` still returns the
  event with its `decodeError`. That event is missing from the lake until the row is repaired.

  The platform also checks every event against the published schema itself, just before it
  ships to the lake. An app deployed on an older version sends its events unchecked, so this is
  what keeps a malformed one out of the lake whichever version the app runs. An event that fails
  is treated exactly like a skipped row: not shipped, not stamped, and counted in the report.

### Patch Changes

- fb37a3e: Three more spine reads check what they return instead of casting it.

  The delivery list an event's effects carry, the scope's dead-letter list and the denial summary
  grouped by operation each read stored columns and handed them back typed as valid, without asking
  the value. A delivery whose `attempts` was `-1`, `1.5` or text reached a caller typed as a
  non-negative integer. They are decoded against their published schemas now, on the same rule as the
  history and denial reads.

  **A column with an honest empty value comes back empty, and says so.** A nullable column that
  does not decode (a delivery's error or call id, a bucket's operation) reads as `null` beside a new
  optional `decodeError` on `EventDelivery`, `DeadLetter` and `DenialOperationBucket`. A healthy row
  carries none, so a clean list reads exactly as it did.

  **A column with none is refused, naming it.** `attempts`, a time, an id or a consumer that breaks
  its schema throws with the column named, rather than being returned as though it were fine.

  Two additions to `@substrat-run/contracts`, both additive. `DeadLetter` had no schema and is now
  one (`deadLetter`); its type is unchanged. `deliveryConsumer` names what a delivery's consumer can
  be: a module id, or `executor:<id>` for an executor, with whatever id registration accepted (it takes any string). The contract used to type it as a bare module
  id, which an executor's delivery never was; `EventDelivery.consumer` accepts both now, and its
  inferred type is the same.

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0

## 0.116.0

### Minor Changes

- e22db55: A delivery now records which request attempted it, so a retry can be told apart from the call that first produced the work.

  Events already carried the identifier of the request that produced them, and a delivery could be traced back to its event. What that gave was the call that _emitted_ the work, never the call that _attempted to deliver_ it — and for anything with retries those are routinely different. The first attempt happens while the original request is still finishing; every attempt after it happens on a background sweep minutes or hours later. So a delivery that eventually gave up appeared to belong to the request that started it, and the work that actually failed was filed under a call that had long since returned successfully.

  The identifier now goes onto the delivery as each attempt is written, on both the self-hosted and the hosted store, and it moves with the row — a record always describes its most recent attempt, the way the attempt count and the timestamp already do. Nothing is invented where none was supplied: a background sweep, a scheduled run or a seeding script records none, which reads as unrecorded rather than as an attempt that belonged to nowhere. Deliveries already recorded keep that unrecorded value; nothing can decide afterwards which attempt produced them.

  Both places a delivery is read carry the new field — the view of what one event set off, and the list of deliveries that gave up. The second of those already showed a request identifier, which was the emitting call; it now shows both, and describes each for what it is.

  No application code changes to adopt it. It does take a redeploy: the identifier is minted by platform code an app bundles into its own deployment, so an app already running keeps recording nothing until it is rebuilt on this version and pushed.

- a67c59b: A refused permission check now records which request it happened during, so a denial can be looked at beside everything else that call did.

  Events already carried the identifier of the request that produced them. A denial carried none — and a denial produces no event, which is the whole point of it, so it was the one thing a request could do that nothing could tie back to the request. The record named the operation that was attempted, never which attempt, so two refusals a second apart were indistinguishable and "what else was this call doing" stopped at the parts that succeeded.

  The identifier now goes onto the denial the same way it goes onto an event: minted by the platform per request and stamped on the refusal as it is written, on both the self-hosted and the hosted store. Nothing is invented where none was supplied — a seeding script, an internal call or an attachment request records none, which reads as unrecorded rather than as a refusal that belonged to nowhere. Refusals already recorded keep that unrecorded value; nothing can decide afterwards which call they came from.

  The denial read surfaces carry the new field, so anything already reading a scope's refusals sees it without changing how it asks.

  No application code changes to adopt it. It does take a redeploy: the identifier is minted by platform code an app bundles into its own deployment, so an app already running keeps recording nothing until it is rebuilt on this version and pushed.

- 45d2f15: An app's screens can now be told when something changed, instead of asking every few seconds.

  Every screen that watches for change has had to poll, because nothing on the platform could hold a connection open and push. An app's scope keeps the one truthful record of what happened — every change it makes is written there — and it can now also hand out a subscription to it: a connection stays open, and when a change commits, whoever is watching is told.

  What is sent is a notice, not the row. A frame names what changed — the kind of thing, which one, and when — and the screen re-reads it through the same operation it already calls. So nothing arrives that has not been through the app's own declared read, with that read's permission check and its own handling of personal data, and a subscription can never become a second way to get at data that the ordinary way would have refused.

  Who is told what is decided per change, per watcher, after the change has committed. An app says which kinds of thing are watchable and which permission it takes to read one, and a change is announced only to watchers who pass that permission **on that particular record** — the same walk a read of it would make, so a record shared with one person and not another is announced the same way. A kind of thing the app has not declared watchable is announced to nobody, which is also what an app that says nothing gets: silence, exactly as before. Permission is re-checked on every frame rather than once when the connection opens, so access taken away while somebody is watching stops the notices with it.

  A watcher costs nothing while it is idle — a scope with connections open still sleeps between them — and a change that cannot be announced never affects the change itself: it has already been saved, and the screen's existing periodic refresh remains the floor underneath the notices.

  Not every connection can carry one. Where an app is reached through a customer's own domain that is itself proxied, the network in front of us does not carry these connections at all, so the platform declines the subscription rather than opening one that would never deliver — and says so in the reply, so the screen knows it is falling back to asking rather than being told. That is decided per request, from what the connection itself reports, so it follows the customer's own DNS the moment they change it.

  Self-hosted apps are unaffected and unchanged: the self-hosted store runs inside the calling process, with nothing that outlives a request to hold a connection open, so it does not offer subscriptions — and asking it for one is refused when the app is compiled, rather than hanging at runtime.

  Nothing changes for an app that says nothing: no app is watched until it declares which of its records are watchable, and one that declares none behaves exactly as it did. Taking it up is not automatic either — an app says what is watchable, opens the door on a screen, and has that screen listen — and the last two of those are not in this release. What ships here is the platform side: the subscription, the filter, and the declaration they read.

- e99332e: `redrainEvents` can now answer how many rows a window holds without reopening any of them: `countOnly: true` on its input, absent everywhere else, so the verb behaves exactly as before for every caller that does not ask. The count is UNBOUNDED where the reopen is batched at `REDRAIN_BATCH` — an aggregate materialises no rows, so it answers for the whole window in one call rather than the first batch of it.

  A count leaves an **access-log** row, because it is a `HostAdmin` read and K-24 takes all reads rather than a chosen subset — the window it named and the number it found, so "who counted this tenant's outbox" has an answer. What it writes no row in is the **admin** log: those two receipts exist because a reopen is a second egress of a tenant's payloads, and a row claiming a redrain on a scope that was only counted would be a false statement in the log that is the evidence.

  The transport keeps the two apart by PATH rather than by a flag, at both hops where the peer is deployed on its own clock: `POST /tenants/:tenantId/scopes/:scopeId/redrain-count` on the control plane and `POST /internal/redrain-count` on a vertical. A `countOnly` field on the existing routes would be stripped by an older deployment's Zod boundary, which would then reopen the window and answer with a number shaped exactly like the count that was asked for. A path it does not serve refuses instead, with the rows untouched.

  `pnpm lake:redrain --drained-before=… --dry-run` therefore prints real per-scope totals and a fleet total, in place of the paragraph saying it could not know (#1545).

- 1c55458: Long work can now stop halfway through and carry on from where it stopped, instead of starting again.

  The platform already had three ways to move work off a request, and each one assumes the work finishes. An effect that fails is retried whole. A recurring operation fires and must run to the end. A maintenance pass does its round and reports it. None of them fits an import that walks a hundred thousand records in an external system over an hour, where a deploy, an eviction or a single upstream hiccup means starting from nothing.

  There is now a fourth kind of work for exactly that. A run is a record kept with the app's own data: what it was asked to do, where it has got to, what it has counted, when it started, and — if it stopped — why. Work inside a run is done in named steps, and a step that has already succeeded is not done a second time, whether the interruption was a failure further along or the machine disappearing mid-way. Between stretches of work the run hands forward a marker of where it reached, so the next stretch resumes there rather than at the beginning.

  Asking for a run that is already in flight joins the one already happening and gives back its identity, rather than starting a rival walk over the same source. That is a decision the driver makes rather than a constraint on the record, deliberately: a run whose worker vanished is still an unfinished run and has to be restartable, which a "only ever one of these" rule would refuse.

  What may be handed to a run is ids and configuration — the things that survive being passed between machines. Bytes, dates, class instances and functions are refused when the run is started, naming the exact field, the same way an invalid request to an app is refused. A step that runs out of retries ends its own run with the error kept on the record, and never disturbs the other runs beside it.

  Both the self-hosted and the hosted store keep the same records and behave identically; the behaviour is pinned by one shared conformance suite that runs against each.

  No application code changes to adopt it, and nothing existing behaves differently. Runs only appear where a deployment registers work of this kind and starts one.

- 0b993ff: The platform sweep's gating state now records which KIND of unit each row is about, so a recurring schedule and a freshness expectation can no longer end up sharing one row.

  The sweep keeps two kinds of bookkeeping per app: when each recurring operation last ran, and when each freshness expectation's verdict was last recorded. Both lived in one table, told apart only by the spelling of their key — a freshness row's key began with `freshness:`. Nothing enforced the other half of that: an operation name is any non-empty string, so an app declaring a schedule literally named `freshness:orders.placed` wrote into the row the freshness evaluator was using for `orders.placed`. The two then overwrote each other every pass — the schedule read the evaluator's last verdict as its own last run and skipped when it was due, and the freshness view reported a verdict that came from a schedule.

  The row now says which it is, in a column, using the same two words — `schedule` and `freshness` — that the recorded sweep history already uses. Both are part of the key, so the two families cannot meet however they are named, and the writer states which kind it is writing rather than the reader guessing from the key.

  Rows already recorded are migrated in place on the store's next wake, on both the self-hosted and the hosted store: each keeps its key and its recorded time and verdict exactly, and is filed under the kind its key already implied. Nothing is re-run and nothing is re-judged by the migration — a schedule does not fire early because of it, and a freshness verdict is not recomputed.

  No application code changes to adopt it. The gating state is platform-owned and nothing user-facing reads it directly.

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0

## 0.115.0

### Minor Changes

- 1a6fe4d: `HostAdmin.listIdentityMemberships(actor, provider, externalId)`: which tenants a central-pool login is in, with each tenant row, the login's principal in it and the scope the link was made in — one directory read and one access-log row, where composing it from `listIdentityTenants` + `getTenant`/`resolveIdentity` per tenant cost 2N+ reads. Central pools only, as `listIdentityTenants` is.

  `GET /verticals` takes `ownerTenant` and `visibleTo` for a staff/service caller that wants one tenant's slice rather than the registry. Both only narrow, and both are ignored for a builder session, whose view is fixed by its auth.

  Dashboard: every `/api/*` request used to resolve its caller through a chain of directory round trips that grew with the number of teams the login is in — about three seconds for a login in ten. It is now one read, reused for 30 seconds; the idempotent self-heals (pool registration, role reconcile, catalog seed) run once per isolate instead of once per request; the deployment and app routes ask their independent reads together and no longer hydrate every version of every vertical to check that one slug is yours; and metrics reads are remembered for a minute per data centre (logs never are).

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0

## 0.114.0

### Minor Changes

- f58aa74: An app's **Flow** view now lists **deliveries that gave up**: every event a handler failed on and will not retry, newest first, with the record it was about, the handler that failed, how many times it ran and the error it threw.

  Before, you could only see a failed delivery by opening the event that caused it, so you had to already know which record to look at. A handler inside your app doesn't retry, so a single failure is final, and these are the rows that need someone. Deliveries that are still being retried aren't listed. If the list can't be read, the view says so; it doesn't show an empty list that looks like nothing went wrong.

  For platform code, `readDeadLetters` in the kernel is the read behind it: paged, with no payloads. Both hosts expose it as `deadLetters`. The vertical host serves it on `/internal/dead-letters`, and the control plane serves it on `/tenants/:t/scopes/:s/dead-letters`, where each read leaves an access-log row like the other event reads.

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0

## 0.113.0

### Minor Changes

- c146761: Any event in an app's history can now show **the rest of the request it came from**: **Same call** lists everything that request recorded, in order.

  **Why?** and **What did it do?** both follow cause, so neither can show two things one request did side by side — placing an order and reserving its stock, say, when neither caused the other. **Same call** can, and it marks which entries were raised by a handler reacting to another event in the same request.

  It shows only what the request recorded. A read, or a check that changed nothing, leaves no record, so it isn't listed, and the view says so rather than letting a short list pass for a quiet request. A request that recorded more than one read shows says that it did. Events from seeds and internal calls, and events from before requests were recorded, carry no request, and the button says why it is unavailable instead of opening onto nothing.

- c3c92e9: Events now record which request produced them, so everything one call did can be looked at together.

  The record could already say what an event was caused by and which operation raised it. What it could not say was that two events came from the same request — and that is the grouping any trace view is built on. A request that touches four records and sets off three handlers left eleven entries with no way to tell they were one piece of work.

  Each request now carries an identifier that goes onto every event it produces, including those its handlers raise while finishing up, and into the record of the request itself. So an event can be traced to the call that made it, and that call to how long it took and how it ended.

  There was no existing identifier to reuse: the one the platform stamps on logs is added after the fact and is not visible to running code, and it does not survive the hop to an installed app. Nothing is invented where an identifier was not supplied — a seeding script or an internal call records none, which reads as unrecorded rather than as a request that never happened.

  No application code changes to adopt it — an app writes nothing to opt in, and the operations it already has start carrying it. It does take a redeploy, though: the identifier is minted and forwarded by the platform code an app bundles into its own deployment, so an app already running keeps recording nothing until it is rebuilt on this version and pushed.

- 2fc7187: A dropped Tier-2 lake table can now be rebuilt without losing history.

  The drain stamps `drained_at` on every outbox row it ships, and until now the stamp was one-way. That mattered as soon as a lake table had to be dropped: a Pipelines stream cannot change its schema in place and a sink refuses to write to an existing table, so adding a column means a new table. Dropping the old one did not clear the stamps, so every event already shipped became history the drain would never offer again, and the new table started with a silent hole behind it.

  `HostAdmin.redrainEvents(actor, tenantId, scopeId, { drainedBefore })` clears the stamp on rows stamped strictly before an instant, so the ordinary drain ships them again. The instant is required and is the whole safety property: clearing every stamp would also reopen rows already shipped to the rebuilt table and write them there twice. Strictly before, because a row stamped at exactly that instant went to the new table. An instant in the future is refused outright, wherever the call comes from: it would clear the stamps on rows the drain shipped _after_ the rebuild, which is the double-write the required instant exists to prevent.

  It is delegated to the vertical's deployment like the stamp it undoes, and exposed on the control plane as a staff/service-only route. Each call reopens a bounded batch rather than the whole window at once — the outbox is never pruned, so on a long-lived scope "every stamped row before an instant" is unbounded work, and one oversized attempt would fail and keep failing, leaving the scope that most needed reopening unable to finish. The call reports how many rows it reopened, and the caller repeats until that is zero; `pnpm lake:redrain` does this per scope, and the route says whether more remain so a single request is never mistaken for a finished window.

  The audit trail is written in two parts, because the reopen and the record of it are separate writes. An **intent** row goes down before anything is reopened, naming the window: if the process dies in between, the attempt is still on the record — a retry would find the stamps already cleared, reopen nothing, and otherwise have had nothing to report. An **outcome** row follows only when rows actually moved, so re-running over a window already reopened still leaves no receipt claiming work it did not do. A second egress of a tenant's payloads is exactly what the audit log must not lose track of.

  `scripts/lake-redrain.mjs` (`pnpm lake:redrain`) walks every active scope with it and is safe to re-run.

  `scripts/lake-provision.mjs` now authenticates with its own `CF_LAKE_ADMIN_TOKEN` rather than `CF_API_TOKEN`. `CF_API_TOKEN` is pushed to the running control plane as a worker secret, so widening it would hand deletion of the audit lake to anything that compromises the plane. After creating a stream it prints the new id directly and the full rebuild sequence including the re-send, and it no longer prints "has no snapshots — nothing committed" directly below a warning that snapshots are being discarded.

- 7e6f925: Everything one request did can now be read together, and counted by request.

  Two reads already followed cause: backwards from an event to what set it off, and forwards to what it set off in turn. Both follow the chain, so both miss a sibling — and a sibling is most of what someone means by "what did this request do". An operation that raises two unrelated events leaves two records with no link between them; from either one, the other is invisible.

  Reading by request returns them together, oldest first, including anything the request's handlers raised while it finished up. It says when it is showing only part of a large one, rather than presenting a fragment as the whole.

  Requests also became something you can group by. The platform's set of ways to slice events — by type, by who, by operation, by version — could not include the request, because until recently there was nothing to group on. Now "which requests did the most" is a question with an answer.

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0

## 0.112.0

### Minor Changes

- c697b15: The access log now says what was read, on the path every real deployment takes.

  Reading a customer's data through the platform has always been recorded. But the record was only complete when the data happened to sit alongside the control plane — and in production it never does: it lives with the app that owns it. On that path the log held only the fact that a scope had been looked up, with nothing about what was then read. Opening an app's summary, paging one of its tables and reading a single record's full history all left the same entry, and the last of those carries the actual contents of events, the person they concern, and the authority the change was made under.

  Ten reads now leave the same entry either way: which read it was, what was asked for, and how many rows came back. An auditor cannot tell from the record where the data was served from, which is the point — that was never a distinction the log was meant to be making.

  Writing one of those entries is a new capability, and a deliberately small one. The kind of read is drawn from a fixed list, the person it is attributed to comes from the authenticated request and never from anything the caller sends, and neither the timestamp nor the row's identity can be supplied. If the entry cannot be written the read fails rather than returning data whose disclosure went unrecorded — which is the same trade the other path has always made.

- db6a96f: The denial summary can bucket per operation (#1456). `denialFilter` takes an optional
  `groupBy: 'actor-permission' | 'operation'`; with `operation`, `summarizeDenials` and
  `GET …/denials/summary` answer one `{ operation, count, firstAt, lastAt }` bucket per
  operation, busiest first, with the same `total` and filter-free window facts beside it.
  `operation` is nullable in that bucket: refusals that unwound no operation invocation are
  one `null`-keyed bucket, counted toward `total` rather than dropped.
  The answer echoes the grouping it carries as `groupBy`, so `DenialSummary` is now a
  discriminated union on that field — a consumer narrows on it before reading a bucket's
  fields. Absent `groupBy`, the (actor, permission) buckets are unchanged. The dashboard's
  per-operation health panel reads the aggregate instead of counting from a capped page.

### Patch Changes

- f4d12b7: `ctx.requestPlatform` refuses the platform-authored `sweep-runs` intent kind, so module code can no longer forge its own schedule and freshness verdicts. The scope sweeper's own enqueue path is unchanged.
- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0

## 0.111.0

### Minor Changes

- aaafae3: Every event in an app's history now has a **Why?** beside it, and it answers.

  Open the history of any record and follow one of its events backwards: each step names the event that produced it, back to the request or the scheduled run that set the whole thing off. "This invoice exists because that timesheet closed, because the Monday sweep ran." That chain is read from what was recorded at the time, not reconstructed afterwards and not sampled — so it is the same answer every time, for every event, however long ago.

  The last line of the answer is the part that matters most, because it says how far the trail actually goes. A chain that reached the operation which started it and a chain that ran out of recorded history look identical otherwise, and presenting the second as the first would let someone conclude that an automatic step began work it only continued. So the ending is always stated: this is where it started, or this is where the record stops, or there is more above this than one read follows, or the trail names something the app no longer holds, or — which should never happen — the trail loops back on itself, and the record needs looking at rather than reading further.

  Events recorded before the platform stored causes say exactly that. Nothing guesses at a missing link, and no chain is presented as complete unless it is.

- 1b2506c: Every event in an app's history can now be followed **forwards** as well as backwards: **What did it do?** opens what it set off.

  Each step shows which handlers the event reached, whether they finished, and what they raised in turn — expanding as far as the trail goes. Between this and the existing **Why?**, any event in an app can be opened in either direction: what led here, and what followed from here.

  Handlers are reported in three states that are deliberately not merged. One that finished, one that failed and will be tried again, and one that failed and has been given up on all look alike in the underlying record — and telling a customer something will retry when it will not is the kind of wrong that gets noticed at the worst moment. The number of attempts and the last error travel with each.

  Where an event reached nothing, that reads as "no delivery recorded", and says why it is ambiguous: either nothing handles that kind of event, or the work has not run yet. The record holds arrivals, not their absence, so the two cannot be told apart and the screen does not pretend otherwise.

  There are no timings, on purpose. The platform does not record how long an operation took, and a column of plausible-looking numbers would be worse than an honest absence.

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0

## 0.110.0

### Minor Changes

- 8758949: An event now records _why_ it exists, so the trail from a record back to whatever set it off can actually be followed.

  The audit spine already recorded a great deal about every event: who raised it, what authority they held, which invocation it came from, which deployed version was running. None of that is cause. An event raised by a consumer reacting to another event runs on behalf of no invocation at all, so the single most useful question — "this invoice exists; what started that?" — ran out of trail at the first automatic step. The answer existed only in the moment, and was never written down.

  Events raised while another is being handled now carry the id of the event being handled. Following a chain backwards is therefore reading recorded fact, not reconstruction: each step names the one before it, all the way back to the request or the scheduled run that began it.

  Two things this deliberately does not do. It records nothing where there is no cause — an event raised directly by an operation has none, and says so, rather than pointing at whatever happened most recently. And it invents nothing for events already stored: those keep an empty cause, which honestly means unrecorded, because nothing can go back and decide what a past reaction was reacting to.

  Existing apps pick the change up on their own; nothing needs redeploying for the record to start being kept.

- 0257dbd: Events now carry when they last happened, not only how many there were — and the flow map can tell a path that stopped from one that never ran.

  A count answers "did this ever work". It cannot answer "is it working now", and the difference is where the interesting failures live: a sync that fired four thousand times and went quiet two months ago looks perfectly healthy on volume alone. Every grouped event count is now accompanied by when that group last saw an event, so the question has an answer.

  On an app's flow map, an event that has been recorded but not in the last thirty days is marked and says how long it has been — visibly different from one that has never been recorded at all, which stays drawn as an outline. The two are kept apart deliberately: a path that never ran may simply not be built yet, while one that ran and stopped means something changed. The findings list makes the same distinction, and words a stopped handler as the thing feeding it having stopped rather than the handler failing, because the handler is the component behaving correctly.

  Nothing is claimed where nothing is known, and the line falls between what was seen and what was not. A type whose recency could not be read is not called stale. Where an app has more kinds of event than can be counted in one pass, nothing is reported as never recorded — a type missing from a shortened list is not evidence that it never happened — while the events that were counted are still judged on how recently they ran.

  Staleness is reported for the event type rather than for a module: the counts are grouped by type, so saying a particular module emitted all of them would be a claim the numbers do not support, and plainly wrong where two modules carry the same type. The modules are named as having declared it, which is what a deploy actually records.

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.109.0

### Minor Changes

- 7aa3ea5: The outbox can be drained (#1334, the scope-side half of Tier 2). Two new
  `HostAdmin` verbs on both adapters: `readUndrainedEvents` reads the events a
  scope has not shipped yet — `drained_at IS NULL`, the column the spine has
  carried since the outbox shipped and nothing has ever written — and
  `markEventsDrained` stamps them once a sink has accepted them.

  They are separate verbs deliberately. Marking before shipping loses events when
  the sink fails; shipping before marking can repeat them, and a repeat is
  harmless — the lake is keyed by event id and every consumer here is already
  required-idempotent. At-least-once is the only one of the two that cannot
  silently lose exact history, which is the whole point of the tier.

  A drained event carries the full envelope plus the two dimensions that live only
  on the column: the emitting `operation` and the `version` the code ran as, which
  #1250 keeps off the envelope on purpose. It also carries `subjectId`, the
  pseudonymous erasure key — shipping payloads out of the scope without the key
  that can find them again would put personal data somewhere an erasure cannot
  follow.

  Marking only ever stamps an UNDRAINED row, so a replayed batch cannot move an
  earlier drain's timestamp forward and misreport when a lake row shipped. It
  returns how many rows it actually stamped, which is what makes that idempotence
  observable — and what the receipt below is written from.

  Declaring a batch shipped is now audited. Domain payloads leaving the platform
  are an egress, and a larger one than the access log's metadata, so the admin log
  gains a `drainEvents` action recording who declared it, for which scope, and how
  many rows it covered — the same evidence `drainAccessLog` already carries one
  tier up. A retried pass that re-marks a batch it already shipped changes nothing
  and records nothing, so the log never grows a row claiming an egress that never
  happened.

  The spine gains an index on `(drained_at, id)`. The drain reads
  `WHERE drained_at IS NULL ORDER BY id`, and no existing index started with that
  column, so SQLite walked the primary key from the oldest event forward. A drain
  retains what it marks, so that prefix only grows: finding the next batch would
  have cost more as a scope aged, regardless of how far behind the drain was.

  No sink yet, and nothing is wired into a sweep: this is the half that needs no
  infrastructure.

- 1e175ce: The outbox can be faceted (#1239 stage 1, the reader). `facetEvents` narrows a
  scope's own events by type and window, groups them by one envelope column
  (`type`, `actor`, `operation`, `version`, `entityType`, `piiClass`) or one
  payload field, and counts — "which currency do the failing pushes carry",
  answered on what the spine already holds, with no new storage.

  **An erased payload is not a missing value, and this is the whole reason it is a
  helper.** A shred keeps the row and drops the content (§5.3), so
  `json_extract(payload, '$.x')` over a shredded event yields exactly the NULL an
  event that never carried `x` yields. Grouped naively, redacted history vanishes
  into a "no value" bucket and a reader sees a clean distribution with no hint
  that part of it was erased. So erased rows are counted in their own total, kept
  out of the buckets, and still counted in the denominator — the event happened,
  whatever it said. A contract test on both adapters shreds a subject mid-test and
  asserts the null bucket does not grow.

  The group-by is a fixed shape rather than interpolated SQL: an envelope grouping
  selects from a known column map, and a payload grouping binds its JSON path as a
  parameter with the field's pattern enforced by the contract.

- 4fc7db2: The event drain runs (#1334, ingest complete). `EventSink` joins `AccessLogSink`
  as a kernel-named seam the platform binds an implementation to, the sweep gains
  an event-drain phase over every active scope, and `createR2EventSink` writes the
  batches as partitioned NDJSON.

  The order is the safety property, and it is the same one the access-log drain
  already documents: read the oldest undrained events, ship them and let the sink
  confirm durability, and only then stamp `drainedAt`. Reversing the last two would
  mark events as shipped that never left — and unlike the access log nothing
  downstream would notice, because the stamp is the only record of what the lake is
  supposed to hold. A repeat is the acceptable failure; a silent hole is not.

  Absent a sink, no scope is drained — the same "absent is a supported answer"
  shape `accessLogSink` and `recordSweepRun` already have. One scope's failure is
  reported and never stamps, so its events are taken again next tick, and a scope
  whose batch fills the budget is reported rather than looped so one busy scope
  cannot starve the pass. Nothing is pruned: the outbox still serves consumers,
  replay and `readHistory`, so the stamp buys knowing what has left, not deletion.

  This establishes durable Tier 2 ingestion. It does **not** bound scope storage:
  nothing is deleted from `_substrat_outbox`, which still serves consumers, replay
  and `readHistory`, so a scope's events keep accumulating exactly as before. What
  the stamp buys is knowing what has left; a retention policy is a separate
  decision that has not been made.

  **NDJSON to R2 rather than Pipelines-to-Iceberg for v1, deliberately.** §5.3
  settles that "Iceberg is the contract, the query engine is replaceable" and
  leaves R2 SQL's fitness open pending a benchmark, so this uses a bucket the
  platform already operates without committing the ingest path to a product
  decision nobody has made. Objects are partitioned by tenant, scope and the UTC
  day each event OCCURRED — a batch spanning midnight is split, so a `day=`
  partition never contains another day's events. The drain is at-least-once by
  design, so a reader deduplicates on event id.

- 62f4e87: A team can now read the traffic and logs of an app they installed, even when the vertical
  it runs is published by somebody else.

  Observability was keyed on the deployed script, and one vertical's script serves every
  team that installed it — so those numbers belong to the vertical's builder, and an
  installed app's Observability tab could only say so. That is true and it is not an answer
  to "how is my app doing", which is a question about the installation rather than the code.

  The new tenant grain is keyed on `(tenant, scope)`: the requests the router dispatched to
  one app, and the lines that app's vertical wrote while serving them. Two teams running the
  same vertical see two different pages, with no overlap.

  Two pieces:

  - `invocationLog()` (`@substrat-run/kernel`) — a vertical mounts it as its first
    middleware, giving it the same `ROUTER_SECRET` and `ALLOW_DEV_NODE` its own routing
    uses, and it writes one structured line per invocation carrying the tenant and scope
    the router asserted. The assertion is VERIFIED, never read off the header: a stamped
    line is what the read path treats as proof that an invocation was a given tenant's, so
    an unverified one would let anyone who can reach the script put chosen text on another
    tenant's dashboard. A mount that can verify nothing writes nothing, and the gate
    refuses it. The path is recorded **without its query string**, since an
    OIDC vertical carries `code` and `state` there and an invite flow carries a single-use
    token. A line is written only when the router asserted a tenant, so there is never a
    line that could be attributed to the wrong one.
  - `tenantMetrics` / `tenantLogs` on `ObservabilityReader` — optional, like the other
    backend-dependent reads, and 501 when absent rather than returning an empty array that
    a caller would draw as "your app served nothing". `tenantId` is not a widenable filter:
    it is the narrowing, and the seam has no "all tenants" spelling.

  The Cloudflare reader takes the router's Analytics Engine dataset as `routerDataset`, with
  no default: the environments write to different datasets, and a default is the spelling
  that has one of them quietly reading the other's traffic. Naming none leaves `tenantMetrics`
  off the reader entirely, so the route says 501 instead of answering with the wrong numbers.

  An error read looks for all three shapes an error arrives in — a failed response, a crash
  that escaped the error envelope (which carries no status at all), and an error logged by a
  request that still answered 200. The last of those is found by searching error lines
  account-wide and keeping only the invocations whose stamped line names this tenant, so it
  widens what a team can find about their own app without widening what they can see.

  A vertical picks this up on its next push. Until then its app shows traffic (which comes
  from the router and needs nothing from the vertical) and no logs; the empty state says
  which of the two it is looking at.

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
  - @substrat-run/contracts@0.109.0

## 0.108.0

### Minor Changes

- 44b53e4: One record's history is readable above the scope (#1235, the read path).
  `readHistory` has been the sanctioned way to walk an entity's events since #800
  — it pages the outbox, decodes the envelope, and keeps three nullable facts
  distinct that a hand-rolled SELECT reads as missing data (an erased payload, an
  unrecorded authorization chain, nobody impersonating). It was documented in the
  scaffold template, the playbook and three changelogs, and called by nothing in
  the repo, because nothing above the scope could reach it.

  `HostAdmin.entityHistory` lands on both adapters, the vertical serves
  `/internal/history` for a scope whose data it holds, and the control plane
  delegates between them exactly as the table reads do. Cursor-paged rather than
  offset-paged, unlike the table read: the outbox pages by id, so an event
  arriving mid-walk cannot shift a page boundary and duplicate or skip an entry.
  The co-located branch lands a K-24 access-log row naming the entity and the
  count; the delegated branch leaves only the `getScopeRecord` entry the ladder
  itself writes, which is what every delegated scope read on this surface does
  today (#1357).

### Patch Changes

- 5e80e5f: The clock seam says which host honours it. `OperationContext.now()` and the `Clock`
  interface described a host-injectable clock without qualification, while
  `CloudflareScopeHostOptions` declares `clock?: never` — so the kernel, where a builder
  reads the contract, promised a seam one of the two hosts refuses. Both docblocks now
  name the pure host as the one that honours it, why the Durable-Object host cannot, and
  what that costs (expiry transitions asserted on the SQLite host only). Comments and docs
  only; no behaviour change.
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/contracts@0.108.0

## 0.107.0

### Minor Changes

- bf9490a: The monotonic floor an event id is minted above now survives the process that held it.
  It used to live only in memory, so a host that closed and reopened — or a scope's
  Durable Object evicted and revived, which happens constantly — began again from the
  clock alone. If that clock had stepped backwards since (an NTP correction is small but
  real), the next id sorted _underneath_ rows already in the outbox, and a reader paging
  `id > <last seen>` was never handed them. Both adapters now seed the floor from the
  scope's own persisted maximum when the scope is opened, so the next id clears what is
  on disk whatever the clock says. The floor is also per scope rather than per host,
  which is the scope `ORDER BY id` is defined over: a busy scope no longer drags a quiet
  one's ids forward. `@substrat-run/kernel` gains `UlidMint.seedFrom(id)` — raise a
  mint's floor to an id already stored, never lowering it, refusing anything that is not
  a ULID.

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0

## 0.106.0

### Minor Changes

- 2956182: An event's id is now minted from the operation's instant instead of the wall clock,
  so the id and the `occurredAt` beside it agree about when — barring a clock that runs
  backwards, where the id holds at the last instant it stamped rather than let a newer
  row sort underneath an older one. This matters because the outbox,
  `readTimeline`/`readHistory` and `ctx.versionOf` all page by `ORDER BY id`
  and treat the id as the cursor — the log was being ordered by a clock nothing else in
  the operation used. `@substrat-run/kernel` gains `createUlid()` (a mint with its own
  monotonic floor, which is what lets an injected clock reach an id) and `ulidTime()`,
  which reads an id's instant back and refuses anything that is not a ULID. A mint now
  also refuses an instant it cannot encode — before the epoch, past the year 10889, or
  not a whole millisecond — instead of returning a string that is not an id.
  `@substrat-run/contract-tests` exports `testMod`, the module its bare operations run
  in, so a suite outside the shared ones can stand a scope up the same way.

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.105.0

### Minor Changes

- 5201683: Release health gets its time axis (#1236, completing the issue). The
  observability seam gains an optional `serviceMetricsSeries` — the same
  invocations bucketed over time, with the backend choosing a bucket width from
  the window and reporting it on every row — and the Cloudflare reader
  implements it. Absent, the route 501s rather than answering an empty series,
  because a chart would draw that as silence.

  On the dashboard, a vertical's Releases panel now opens with 24 hours of
  traffic with every push and go-live drawn on it, as a hand-rolled SVG (the
  shape is bars plus rules; a charting dependency would be more bytes than the
  drawing). The series is zero-filled worker-side so an outage stays a gap
  rather than letting its neighbours join, and markers come from the registry
  rather than telemetry, so a push that produced no traffic still gets its line
  — the most interesting push on the chart. Every promotion draws its own line,
  so a version that was rolled back and put live again shows both go-lives, not
  just the later one. Where the chart cannot be drawn it says so: a plane that
  serves window totals but no time axis, or a window whose traffic exceeds what
  the analytics backend will answer in one page, gets "not available" instead of
  a flat line — a partial answer would render as an outage that never happened.

  And an app's schema history is finally readable: `_substrat_migrations.applied_at`
  has been written since the table shipped and selected by nobody, since every
  reader wanted only the frontier. `scopeAppliedMigrations` (both adapters, plus
  the vertical's own `/internal/migrations` for a scope whose data it holds)
  makes "when did my schema change" answerable, and the app's Observability tab
  lists it. Deliberately a list and not chart markers: a migration applies to one
  scope while traffic is measured per script, and a script serves many scopes.

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.104.0

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.103.0

### Minor Changes

- adf6bfb: A vertical can start a provider consent round for its own user (connections.md §3.5.3). The credential relay only serves a provider whose credential the tenant admin already holds; one that mints a credential at the end of a browser consent round could be connected from the dashboard alone, which is no use to a bookkeeping bureau whose staff work in the vertical, connect a client company most weeks, and have no dashboard account.

  `requestConnectUrl` (vertical-host) POSTs the new `/internal/connections/connect-url` relay behind the vertical's own `ctx.check`, and gets back a URL to redirect its user to. Consent, exchange, sealing and the upsert all stay on the platform origin that owns the provider's one registered `redirect_uri` — the vertical never sees the client credentials, the code, or the token. The connection is stamped `createdBy` the authorizing tenant principal, the vertical is re-derived from the directory rather than taken from the caller, and a `returnUrl` must be a hostname the calling scope is bound to. `signConnectState` / `verifyConnectState` (kernel) are the signed state the minting and verifying workers share.

### Patch Changes

- dcde11e: Add `@substrat-run/connector-planima` — the inbound half of Planima (Swedish planned
  facility maintenance) integration.

  Poll-only and read-only, in `connector-fortnox`'s shape: a connection is bound to a scope
  with `bindPlanimaScope` (which refuses a binding whose grant is missing), and
  `sweepPlanimaPlan` reads each bound scope's maintenance plan — facilities, buildings,
  components, and the costed actions in a year window — hashes it, and lands it through the
  consuming vertical's own operation as the connection itself. An unchanged plan lands
  nothing.

  The client throttles itself to Planima's 10-requests-per-10-seconds limit and obeys the
  `Retry-After` a 429 carries. Prices arrive as JSON floats and cross the seam as exact
  decimal money in a currency the binding declares, because Planima's API states none.

  A plan that has become empty lands one explicit CLEAR page (`facility: null`,
  `final: true`) rather than nothing, so a consumer that swaps on `final` cannot be left
  holding the previous sync's rows for ever. A 200 whose body carries no `data` array is
  refused as a response fault rather than read as an empty list. One rate-limit window is
  shared across every binding in a sweep, because Planima meters per token rather than per
  client.

  `ConnectorResponse` gains an optional `headers` — some provider instructions (`Retry-After`
  here) live only in a response header, and reading one had no sanctioned route through the
  connector seam.

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

## 0.102.0

### Minor Changes

- e7115b2: Ops-failure rows carry the error's SHAPE (#1233, first step of the Issues
  view). `opsFailureEntry` gains `origin` (who refused: `platform` / `provider` /
  `unknown`, the #841 attribution) and `code` (the taxonomy code when the refusal
  was one of ours) — both nullable, and a null is a fact: the writer predates the
  columns or could not classify, never a guess. The intent drain already computed
  exactly this attribution for the journal's `last_failure` and dropped it when
  writing the fleet row; now it rides along on both the attempt-ceiling and
  terminal paths. Every other control-plane recorder hands its caught throw to
  `recordFailure`, which attributes in one place — the same posture as the
  `reference = <id>` extraction. `GET /ops-failures` narrows by `code`, so a
  failure class is a column filter, never a message regex — which is what a
  fingerprint-grouped issues view needs to exist at all.
- 3e67ebe: Failures group into issues (#1233, the store). Every ops-failure insert now
  also bumps a row in `_substrat_issues`, keyed by `opsFailureFingerprint` —
  operation + stage + taxonomy code, deliberately never the message — with a
  count, first/last seen, the newest exemplar's message, and a lifecycle:
  `new` on first sight, `resolved`/`ignored` as staff verdicts
  (`HostAdmin.setIssueStatus`, audited with the before/after diff), and
  `regressed` written only by ingest when a fresh arrival lands on a resolved
  issue. An ignored issue stays ignored. The issue row OWNS its counters — the
  evidence beneath it self-prunes at 90 days, and a count must survive its own
  exemplars — and outlives its last occurrence by 180 days, long enough for a
  regression to be recognizable. Failure rows carry their `fingerprint` too,
  so `listOpsFailures({ fingerprint })` walks one issue's exemplars.
  `HostAdmin.listIssues` reads the groups newest-last-seen first; no cursor by
  design, because grouping IS the compression. The 577-attempt intent of #570
  would have been one issue with a rising count from attempt 2.

### Patch Changes

- 46051ee: Connecting Fortnox from the dashboard works on the hosted platform. Every consent
  round ended in "the exchange with Fortnox failed" while the same round passed
  locally: the callback handed the connector the bare global `fetch`, the connector
  calls it as a method, and the Workers runtime refuses that (`Illegal invocation`)
  before the code exchange is ever sent — Node's fetch does not, which is why nothing
  local saw it.

  The kernel now exports `globalFetch`, the runtime's fetch as a `FetchLike` — an arrow
  over the global, so the receiver is never in play, and the one place the structural
  cast lives. Every host default (`options.fetch ?? globalFetch` in both adapters) and every
  connector handoff (the control plane's probes
  and sweep, the dashboard's consent callback) uses it, and a new `lint:bound-fetch`
  gate refuses the bare global handed on in any spelling, since no suite can reproduce
  the refusal. The custom-hostname provisioner keeps its DOM-typed `FetchFn` — a real
  `fetch` is not assignable to `FetchLike` under strict TypeScript, so an injected
  DOM-typed fetch must not need a cast there — and its default is the bound global, which
  is that type with no conversion.

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.101.0

### Minor Changes

- 306b893: Declared freshness expectations (#1232): a module may declare that a scope
  should keep seeing an event — `freshness: [{ eventType: 'receipt.landed',
within: { hours: 24 } }]` — and the platform judges it where the evidence lives.
  The expectation is refused at parse when it names a type the module neither
  emits nor consumes (a typo would read as permanently stale forever), flattens
  into the deploy manifest like `schedules`, and is evaluated during the
  scope-side sweep pass — one indexed `MAX(occurred_at)` read of the scope's own
  outbox, never a control-plane read of event history. Verdicts land as a third
  sweep-run kind, `freshness`, with the judged event type as its own dimension
  (never smuggled into `operation`) and the newest evidence in a new `observedAt`
  column — so a HEALTHY row can still say "last receipt 3h ago".

  Freshness writes on verdict CHANGE plus an hourly heartbeat, deliberately unlike
  schedules: its steady state is `ok`, so per-pass rows would flood the strip with
  green while the heartbeat keeps "no rows" unambiguous (a missing hourly row is a
  stopped evaluator, at exactly the resolution a 24-hour expectation needs). The
  `skipped` outcome means never-observed — a brand-new install must not open red.
  The evaluator is deliberately NOT gated on the module's system grant (freshness
  is a read of the scope's own outbox; the grant tuple only exists for modules
  with permissioned schedules, and gating would silently disable the module shape
  that needs this most), and a freshness-only module registers through its own
  registry rather than the schedule map that would have dropped it. Duplicate
  declarations of one type collapse to the tightest window — one row per
  (scope, eventType), or the drain's dedupe index would eat one. CP-less verticals
  report through the same batched sweep-runs intent, now kind-discriminated with
  old payloads defaulting to `schedule` and meaning exactly what they meant.

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.100.0

### Minor Changes

- 0cd3055: A hosted vertical's schedule outcomes reach the platform's sweep record (#1232,
  closing the CP-less gap the last release named). The scope sweeper batches each
  pass's per-schedule outcomes — skips included, stamped with PASS time and the
  version whose code actually ran (`env.SUBSTRAT_VERSION_ID`) — into one
  `sweep-runs` platform intent per scope, which the control plane's drain lands in
  `_substrat_sweep_runs` with identity proven by the scope the intent lives in,
  never read from the payload. Telemetry gets its own low sub-cap on the journal
  and DROPS rather than throws when full: a pass must never fail, or starve a
  provision-sibling's slot, because its record could not be queued.

  The write is now idempotent on (intent id, unit) — a new nullable `request_id`
  column with a unique index and an ignore-on-conflict insert — so a replayed
  drain writes nothing twice, while the direct sweep path (no request id) dedupes
  nothing, as two real passes are two facts. `SweepRunInput` gains optional `at`
  (a drained batch keeps pass time; drain time would skew every freshness read)
  and `requestId`. The template's sweeper wires the version accessor; existing
  workers compile untouched — the accessor and the host method are optional, and
  a pass on a pre-widening deployment reports nothing, exactly as before.

- 8912fb8: Sweep passes leave a durable record (#1232, tier 1 of the signals plan). A new
  directory table, `_substrat_sweep_runs`, holds one row per unit outcome per
  pass — each connection swept, failed, or skipped ("bound but no sweeper" is now
  a stored fact, not an absence), and each schedule fired, failed, or skipped —
  dimension-stamped per #1231 and retention-bounded at 14 days, pruned on write.
  `ScheduleRunReport` gains an additive `runs` list (both adapters' drivers fill
  it) because the counters alone cannot say WHICH schedule fired.
  `HostAdmin.recordSweepRun`/`listSweepRuns` follow the ops-failures shape:
  fire-and-forget writes, access-logged reads, ULID cursor, newest-first.
  `runPlatformSweep` takes an optional `recordSweepRun` seam; unset, a pass
  records nothing, exactly as before.

  Stated plainly rather than left as a silent hole: schedule rows cover
  directory-backed sweeps (self-host, dev). A HOSTED vertical's schedules run in
  its own scope sweeper with no control plane in reach, so its schedule facts are
  not in this table yet — that is the deferred CP-less half of #1232, and until it
  lands the dashboard view reads connector health fleet-wide but schedule health
  only where the platform sweep itself runs the schedules.

- 6b3e466: Two follow-ups on the version stamp (#1242). The `SUBSTRAT_` binding namespace
  is now refused at push by name, whatever type it claims — a vertical that could
  declare `SUBSTRAT_VERSION_ID` itself would collide with the injected binding or
  forge the stamp; the unforgeability the kernel-stamped envelope fields get for
  free, a binding channel has to be given at the sandbox contract. And
  `readHistory` surfaces the outbox `version` column on `historyEntry`
  (`version: string | null`) — from the column only, never the envelope, which
  stays deliberately version-free — so joining an event to the push that produced
  it goes through the sanctioned read helper instead of a hand-rolled SELECT.

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.99.0

### Minor Changes

- 8e29866: The signals dimension vocabulary lands (#1231): `@substrat-run/contracts` gains
  `SIGNAL_DIMENSIONS` and `signalStamp` — the one set of names
  (`tenant / scope / vertical / version / operation / eventType / connection`) every
  observability-facing record is stamped with, defined once so a chart, a failure list and
  a graph node all mean the same thing by `version` and an aggregate can click through to
  its exemplars with filters intact.

  Two facts move under it immediately. Ops-failure rows (#559) now carry the `version`
  dimension — the version-registry id the failure happened under, stamped at the preview,
  provision and intent-drain write sites, filterable via `listOpsFailures` and
  `GET /ops-failures?version=…`, with an old row's NULL reading as "predates the stamp" —
  which is what lets a failure be read against the push that produced it. And the
  observability seam's `RecentLogEvent.eventType` (the Workers invocation shape:
  `fetch`/`rpc`/`scheduled`) is renamed `invocation`, because the vocabulary reserves
  `eventType` for a DOMAIN event's type and that field was the one place the two could be
  confused in a filter.

- 02793d9: An operation's emitted events now name it (#1231). The outbox envelope gains an
  optional `operation` — the exact `invoke()` string (`ticket0/answer`,
  `attachments.upload`; a scheduled emit carries the schedule's own operation) —
  stamped kernel-side on the K-34/K-42 pattern, so module code can neither forge
  nor suppress it. Both adapters store it in a new nullable `_substrat_outbox`
  column, ALTERed into existing scopes; a legacy row reads as unrecorded.

  A CONSUMER-emitted event deliberately stays unstamped: a consumer runs on behalf
  of no operation, and NULL says so — no synthesized pseudo-name pollutes the
  dimension. `readHistory` surfaces the field on `historyEntry` (`operation:
string | null`, whose null honestly carries both "consumer emit" and "predates
  the column"); the thin `timelineEntry` deliberately does not.

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0

## 0.98.1

### Patch Changes

- Updated dependencies [551d0cf]
  - @substrat-run/contracts@0.98.1

## 0.98.0

### Minor Changes

- 05de166: Role assignment is now bounded by the assigner's own authority (K-21, membership.md §5.1). A principal may assign role `R` at node `N` only if they already hold every permission `R` carries at `N` — the rule that makes "assignment invents no authority" true rather than merely plausible. Without it the checkpoint that reviews role _definitions_ protected nothing: an `admin` assigning themselves `owner` widens no role, calls no `defineRole`, and appears in no permission diff.

  Module code asks `ctx.canAssign(roleKey)`, which answers `{ covered, missing }` — the missing keys, because that is the refusal a person can act on. It is a bound and not a permission check: the operation still opens with its own `assertAllowed(await ctx.check(…))`, which answers _may you manage members at all_ where this answers _may you confer this much_. Removal takes the same bound, since a junior admin who can strip a role they could not have granted can lock an owner out of their own tenant.

  Underneath, `PermissionChecker` gains `covers(subject, required, node)` — one resolution of the subject's effective set compared against the role, rather than N walks of the same tuples for an N-permission role. It is narrowing-aware, which is the load-bearing part: only authority held at the node counts, so an entity-narrowed grant does not satisfy the bound for the unnarrowed permission — otherwise sharing one record would launder into authority over every record by way of assignment. Membership still expands, because authority held through an org is authority that can be conferred. Both adapters implement it and a contract suite holds them to the same eight answers.

- ee70af5: Permission evaluation is one implementation again. The kernel now owns the four-rule
  tuple algebra (`createTupleEvaluator`), and each adapter supplies only a
  `PermissionTupleReader` — where its tuples live and how they are read. Behaviour, proofs
  and both adapters' public surfaces are unchanged.

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
  - @substrat-run/contracts@0.98.0

## 0.97.0

### Minor Changes

- 59121f6: A paged read can narrow on a SET of values, not only on one.

  `ctx.page` filters composed `column = ?` and nothing else, so "every state but the
  terminal one" — the shape every inbox wants for its default view — could not be asked
  for at all. The alternatives were one request per state, whose pages cannot be merged
  into a single walk, or a `!=`, which would make `filterable` mean something wider than
  the indexed equality it provisions for.

  A filter value that is an array now composes `IN (…)`. It is still equality, so it still
  uses the index `filterable` provisions, and the count runs over the same `WHERE` as the
  page. An EMPTY array matches no rows rather than being dropped: a caller that narrowed to
  nothing asked for nothing, and handing back the whole table instead is a permission-shaped
  bug wherever the set is computed from what the reader may see. Both adapters are held to
  this by the `ctx.page` contract suite.

### Patch Changes

- Updated dependencies [9fcfebc]
  - @substrat-run/contracts@0.97.0

## 0.96.0

### Minor Changes

- db5a3da: A push now repairs its own installs. A scope records which version its provision hook last ran against (`provisionedVersionId`), and the platform sweep re-runs the provision for any scope serving code that hook has never seen — so a vertical that starts minting a new service principal reaches the installs that predate it, instead of failing on them forever. `HostAdmin.markScopeProvisioned` is the receipt; both adapters carry it and the contract suite holds them to the same behaviour.

### Patch Changes

- Updated dependencies [db5a3da]
  - @substrat-run/contracts@0.96.0

## 0.95.1

### Patch Changes

- Updated dependencies [d9ab34d]
  - @substrat-run/contracts@0.95.1

## 0.95.0

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [7bf77df]
  - @substrat-run/contracts@0.95.0

## 0.94.0

### Minor Changes

- 1fc01d3: `ctx.sql` now refuses to write the platform spine. "Never write `_substrat_*`" was a
  source rule only, and the source scan does not run on the hosted push path — so a
  module could forge a grant, rewrite an announced event or drop the migration journal
  through the same connection the kernel writes them with. Both adapters wrap their
  module-facing connection in the kernel's new `guardSpine`; reads of the spine,
  including the ones that feed a timeline projection, are unchanged.

### Patch Changes

- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [35147a9]
  - @substrat-run/contracts@0.94.0

## 0.93.0

### Minor Changes

- df4ffd1: Meter 3, for model usage (#1054, step 3). A vertical's model host raises each `ModelUsageLine` as a `model-usage` platform intent; the control plane's drain records it in the directory's `_substrat_model_usage` ledger, idempotent on the intent id (a replayed drain writes nothing twice) and refusing a line attributed to any tenant, scope or vertical other than the one being drained. `HostAdmin` gains `recordModelUsage`, `listModelUsage` and `summarizeModelUsage`; the fold (`foldModelUsage`) is the kernel's, so both adapters quote one number — list price summed exactly, the platform's margin (`MODEL_MARGIN_PERCENT`, default 20, applied at read time) beside it, unpriced calls counted rather than folded in as $0. `GET /model-usage` and `GET /model-usage/summary` serve it; the console's Meters view shows it beside meters 1 and 2.
- 0a536b7: `readRoutedNode` fails closed without a secret (#966). When a request carries
  `x-substrat-tenant`/`x-substrat-scope` headers and the worker has no `expectedSecret`
  configured, it now throws `RouterAssertionError` instead of trusting the unsigned
  assertion — a vertical deployed without its `ROUTER_SECRET` refuses routed requests (400)
  rather than serving whichever tenant the header named. The new `allowUnsigned` option is
  the explicit opt-out for an un-routed local instance behind a dev router; the scaffolded
  `worker.ts` sets it from `ALLOW_DEV_NODE` and from nothing else. The no-headers → `null`
  path is unchanged, so a standalone deploy and `ALLOW_DEV_NODE` keep working as before.

### Patch Changes

- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
  - @substrat-run/contracts@0.93.0

## 0.92.1

### Patch Changes

- @substrat-run/contracts@0.92.1

## 0.92.0

### Patch Changes

- Updated dependencies [7843c4f]
  - @substrat-run/contracts@0.92.0

## 0.91.1

### Patch Changes

- @substrat-run/contracts@0.91.1

## 0.91.0

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/contracts@0.91.0

## 0.90.1

### Patch Changes

- Updated dependencies [7b50231]
  - @substrat-run/contracts@0.90.1

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

## 0.89.0

### Minor Changes

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
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0

## 0.87.0

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0

## 0.86.0

### Patch Changes

- @substrat-run/contracts@0.86.0

## 0.85.0

### Patch Changes

- @substrat-run/contracts@0.85.0

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
- Updated dependencies [946dd47]
  - @substrat-run/contracts@0.84.0

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

## 0.82.0

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0

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

## 0.80.0

### Patch Changes

- Updated dependencies [83b0ca3]
  - @substrat-run/contracts@0.80.0

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

## 0.78.0

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0

## 0.77.0

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0

## 0.76.0

### Patch Changes

- @substrat-run/contracts@0.76.0

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

- @substrat-run/contracts@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0

## 0.73.0

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0

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
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.71.0

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0

## 0.70.0

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0

## 0.69.0

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0

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
  - @substrat-run/contracts@0.68.0

## 0.67.0

### Minor Changes

- ee95fd6: Consumers can be typed against the engines a vertical composes.

  Composing an engine by **calling** it is checked end to end. Composing it **by
  event** was three plain strings and an `unknown`: `consumers` keyed by `string`,
  `ConsumerHandler` handed a `DomainEvent` whose `payload` is `unknown`, and every
  consumer hand-writing the shape it was given as an all-optional cast, because it
  was guessing.

  A module may now declare the engines it composes and get three things the
  compiler enforces: **payloads typed** from the producer's own declaration, an
  event type **no declared engine emits** rejected, and — via `consumersFor` — a
  **half-handled completion group** rejected.

  ```ts
  consumers: consumersFor<[ProtocolEvents]>()({
    'protocol.signed': async (ctx, event) => { … },
    'protocol.countersigned': async (ctx, event) => { … },
  })
  ```

  Omit the second and it does not compile: _Property `"protocol.countersigned"` is
  missing_. That is the defect this exists for. Protocol events are named after the
  signature **kind**, while the fact consumers want — the thing is finished — rides
  on whoever signs **last**, so a two-party contract completes as a
  _countersignature_. A vertical handling only `protocol.signed` left every
  multi-party contract `pending` for ever while the engine held the document
  `signed`. Nothing could say so: the key was a `string`.

  `completionGroups` is what carries that. It names events that report the same
  fact by different routes, and handling one member demands the rest.

  **Additive (D-28).** The type parameter defaults to `[]`, and with no declared
  engines `consumers` is exactly what it always was — `Record<string,
ConsumerHandler>` with an `unknown` payload. Every existing engine and vertical
  compiles untouched; the full monorepo typecheck is unchanged.

  **Deliberately vertical-facing only.** An engine consuming a sibling's event must
  not reach for these types: R1 (star topology) forbids the import, and the
  defensive parse is what lets a consumer ride out #128's dual-emit window.
  `engine-invoicing` consuming `workorder.completed` through its own Zod view is
  the correct shape and stays so. The asymmetry is the point — the same event is
  typed for a vertical and parsed by an engine.

  **The types are for the compiler, not the boundary.** A consumer still validates
  with its own Zod parse. Importing a producer's validator is what turns version
  skew into a crash instead of a tolerated absence.

  Types only — no runtime change. `consumersFor` returns its argument.

  Also: `packages/kernel` gained a `tsconfig.test.json`, because its `tsconfig.json`
  includes only `src` and nothing in `test/` was typechecked at all. Turning that on
  immediately surfaced a latent strictness error in `secret-box.test.ts`, fixed
  here. The compile-time suite in `test/typed-consumers.test.ts` is the feature: a
  type-level constraint fails _permissively_, so a decorative constraint is
  indistinguishable from a working one unless something asserts it bites.

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
  - @substrat-run/contracts@0.67.0

## 0.66.0

### Minor Changes

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

### Patch Changes

- @substrat-run/contracts@0.66.0

## 0.65.0

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0

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

- @substrat-run/contracts@0.63.0

## 0.62.0

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0

## 0.61.0

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0

## 0.59.0

### Patch Changes

- @substrat-run/contracts@0.59.0

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

## 0.57.1

### Patch Changes

- @substrat-run/contracts@0.57.1

## 0.57.0

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0

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

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0

## 0.55.0

### Patch Changes

- @substrat-run/contracts@0.55.0

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

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0

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
  - @substrat-run/contracts@0.53.0

## 0.52.0

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0

## 0.51.0

### Patch Changes

- @substrat-run/contracts@0.51.0

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

## 0.49.0

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0

## 0.48.1

### Patch Changes

- @substrat-run/contracts@0.48.1

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

- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/contracts@0.47.0

## 0.46.0

### Patch Changes

- @substrat-run/contracts@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0

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

- @substrat-run/contracts@0.44.0

## 0.43.0

### Patch Changes

- @substrat-run/contracts@0.43.0

## 0.42.0

### Minor Changes

- b0355b4: `ScriveApi.getMainFile(documentId)` — pull the sealed signed PDF. The connector
  recorded the _fact_ of each signature and walked away from the _artifact_: it
  could create, set file, set parties, start, and get, but had no
  `GET /api/v2/documents/{id}/files/main`, so the signed PDF — Scrive's sealed copy
  with the signing evidence attached — lived only at Scrive, reachable only with the
  API credential. The legacy CRM this vertical replaces fetches that file on
  completion and offers "Ladda ned signerat avtal", so it is parity, not polish
  (issue #476, step 1). `ConnectorResponse` gains `arrayBuffer()` for provider
  responses that are a file rather than JSON (web `Response` already has it; the
  declaration only widens the structural surface). Fetch-on-completion into the
  blob store is step 2, which waits on #473.
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

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0

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

### Patch Changes

- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/contracts@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0

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

## 0.37.1

### Patch Changes

- @substrat-run/contracts@0.37.1

## 0.37.0

### Patch Changes

- @substrat-run/contracts@0.37.0

## 0.36.1

### Patch Changes

- @substrat-run/contracts@0.36.1

## 0.36.0

### Patch Changes

- @substrat-run/contracts@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0

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

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
  - @substrat-run/contracts@0.31.0

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

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0

## 0.29.0

### Patch Changes

- @substrat-run/contracts@0.29.0

## 0.28.0

### Patch Changes

- @substrat-run/contracts@0.28.0

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

## 0.23.0

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0

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

## 0.21.0

### Patch Changes

- @substrat-run/contracts@0.21.0

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

## 0.19.0

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0

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

## 0.17.0

### Patch Changes

- @substrat-run/contracts@0.17.0

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

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0

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

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0

## 0.13.0

### Minor Changes

- 74c9d7b: Add `unassignRole` and `unlinkIdentity` to the `HostAdmin` surface — the inverses of `assignRole` and `linkIdentity`, so authority granted through the kernel can also be taken back.

  - `unassignRole(actor, assignment)` revokes a role assignment by tombstoning the role tuple (K-21): the checker stops resolving it, the tuple stays as audit evidence, and a later `assignRole` of the same `(principal, role, node)` reactivates it. Idempotent.
  - `unlinkIdentity(actor, tenantId, principal)` severs a principal's login from a tenant — keyed by principal (so the caller needs no external subject) and a DELETE rather than a tombstone, so `listIdentityTenants`/`resolveIdentity` stop returning it and a re-invite can re-link a fresh principal.

  Both are implemented in the SQLite and Cloudflare adapters (with a generic tenant/scope tuple revoke on the Cloudflare DOs) and add matching `adminAction` log entries. Together they unblock self-serve member removal: cut a member's access and drop the team from their surface.

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/contracts@0.13.0

## 0.12.0

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

- e4db6ed: **`runPlatformSweep` / `startPlatformSweeper` — the scheduler's unit of work (#96, poll path,
  Design A).**

  `drainDue` (the executor retry driver) and the connectors' reconcile sweeps both landed with no
  caller on a timer. This is the one that calls them:

  ```ts
  const report = await runPlatformSweep(host, {
    actor,
    fetch, // sanctioned egress for sweeps
    sweepers: { scrive: sweepScriveReconciliations }, // provider → sweeper, INJECTED
  });
  ```

  One pass drains every active scope's due deliveries (`listScopes({ status: 'active' })` →
  `drainDue`) and reconciles every live connection (`listConnections` → `sweepers[provider]`).
  Provider-agnostic — it imports no connector; the deployment that owns the call site assembles the
  sweeper map. Robust by construction: bounded concurrency (`concurrency`, default 8) so one slow
  provider cannot delay the fleet, and a failure on any one scope or connection is recorded in the
  report and stepped over, never allowed to sink the pass. Revoked connections and providers with
  no sweeper are skipped and counted. `drainRetries: false` sweeps connectors only.

  `startPlatformSweeper(host, { intervalMs, … })` drives it on a self-rescheduling timer for a
  long-lived (node) runtime — non-overlapping by construction, since the next pass is scheduled only
  after the current one settles; returns a `stop()` handle. A Cloudflare runtime calls
  `runPlatformSweep` directly from `scheduled()`/an alarm instead.

  Tested with fakes (enumeration, dispatch-by-provider, error isolation, concurrency bound, timer
  overlap/stop) and end to end against the SQLite adapter with the real Scrive connector — a
  signature completes through the driver, nobody handing it the instance id.

  See [docs/architecture/scheduler.md](../../docs/architecture/scheduler.md). The remaining step is a call site in
  a deployed vertical (the control-plane worker is deliberately NOT it — its `ScopeDO` is
  module-less; the sweep must run in the vertical's own runtime).

### Patch Changes

- Updated dependencies [858912e]
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

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
  - @substrat-run/contracts@0.10.0

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

- @substrat-run/contracts@0.9.0

## 0.8.0

### Patch Changes

- @substrat-run/contracts@0.8.0

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

- 8c48c93: `assertPlatformCall` — the vertical's side of a platform-to-vertical call (K-31).

  Provisioning is control-plane-driven, because only the vertical can create a usable
  scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
  This authenticates that call, in the kernel for the same reason `readRoutedNode` is —
  five verticals each re-deriving how to trust a header is five chances to get it wrong.

  It **fails closed with no configuration at all**, which is the opposite of the router
  secret. There, an unset secret means "no router is configured", which a standalone
  deploy legitimately wants. Here it would mean "anyone may provision", which nothing
  legitimately wants — a template copied without the secret must refuse rather than mint
  tenants for strangers.

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

- Updated dependencies [c54637b]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0

## 0.6.0

### Patch Changes

- @substrat-run/contracts@0.6.0

## 0.5.0

### Patch Changes

- @substrat-run/contracts@0.5.0

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

- Updated dependencies [d929987]
- Updated dependencies [f717014]
- Updated dependencies [6393a8e]
- Updated dependencies [2dd4175]
  - @substrat-run/contracts@0.2.1

## 0.2.0

### Minor Changes

- 604883b: Manifest-declared operation guards and operation withdrawal — compliance gates a reviewer can enumerate.

  A vertical declares an unconditional gate in its manifest (`guards: [{ before, predicate, config }]`); a module contributes the named predicate (`predicates` on `ModuleRegistration`, typed `GuardPredicate`); the kernel evaluates it inside the guarded operation's own transaction, before the handler, failing closed. `withdraws` lets a vertical suppress an engine's default operation binding so the guarded wrapper is the only door — without it a gate is reviewable but bypassable. Both are optional and additive: existing manifests parse and behave unchanged.

  The protocol engine gains a `protocol/all-signed` predicate and the `requireCountersigned` in-scope function; the work-order engine exports `closeWorkOrder` as an in-scope function (its `workorder/close` operation is now the thin binding). The scope-host contract suite covers guards and withdrawal, so every adapter must implement both.

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0

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
