# @substrat-run/docs

## 0.1.34

### Patch Changes

- d0af665: Let a vertical's owning team enable or disable transactional email in the dashboard under Settings → Permissions. Check app-management access before changes and registry ownership at the control plane; retain staff overrides and keep deploys from changing the grant. Explain the dashboard action when email delivery is refused.

## 0.1.33

### Patch Changes

- c5b987f: Organize the Assistant and Notifications engine documentation into the standard overview, domain model, operations and permissions, events, and composition pages. Update the sidebar to expose all five sections while keeping the packages' unpublished status clear.
- 8bbf7e9: A preview whose data takes more than one page to copy now copies in the background, so `substrat preview create` no longer has to fit the whole copy into one request (#2450, step 2).

  - **Lease renewal.** `HostAdmin.renewScopeScriptCopy` renews every entry of a copy move's lease at once, or none. It only acts while each entry is still pending, unclaimed and inside its lease, which is exactly what a confirming bind requires, so a lease a sweep could be acting on is never revived. Both adapters run the same `COPY_MOVE_RENEW_SQL`.
  - **Resumable copy.** `transferScope` is now `beginTransfer` plus `transferStep` over a JSON `TransferState`, so a copy can stop and resume in another request or isolate. The in-request path runs the same steps to the end, unchanged. Each paged call (`exportScopePage`, `stageScopePage`, `discardStagedScope`) runs under a 60 s deadline (`PAGE_CALL_DEADLINE_MS`), and one that stalls is aborted and answered `504`.
  - **The job.** `advanceCopyJob` is one step of a background copy:

    - it renews the lease;
    - it moves pages for a bounded time;
    - a refusal fails the job, a transient fault backs off and retries, and a job past six hours fails (one whose steps stopped, its last step more than a lease old, is failed by the next call that reads it, `copyJobAt`);
    - a job that fails discards its stage, and its record keeps naming it;
    - a copy torn part way is staged again, even when it now fits one page;
    - the step, and the wait before a retry, each stay inside a quarter of the move's lease.

    `defineCopyJobDO` (adapter-cloudflare) runs those steps one per alarm and keeps a finished job for the route to read. A cancel or forget that lands during a step stops it (`CopyJobStep.stopped`: no further page, no new stage) and waits for it before it acts. Its `claim` hands a done job to one caller at a time, and `threwRetryMs` sets the wait after a step that threw. An object of the class under another name keeps a mark instead (`markNewest`: the newest order it was given while held, dropped by alarm once its hold runs out). `memoryCopyJobs` is the same, in memory, for tests.

  - **The preview route.** With the new `copyJobs` option and a caller that sends `async: true`, `POST /verticals/:slug/previews` copies the first page in the request.
    - A fork or carry that needs more answers `202` with its progress and `Retry-After`, and the same call, repeated, finishes the preview once the job is done. Only the call that claims the done job finishes it; another call answers `202` meanwhile. The preview's deadline (`ttlHours`) counts from the latest call, as every create's does: the calls during a copy keep it alive, and the finish applies it again. A carry's finish keeps the job until its bind is over, and a finish that fails, however it fails, settles the job's move and discards the stage it would have loaded. A fork, like a carry, refuses (`412`) a source that was carried to another script and wiped while it was read.
    - A refresh, a delete or a newer push stops a job still copying and settles its move. A newer push waits for a claimed job to be finished. A refresh is held to the same rule as any create: it never stops a newer push's live copy.
    - A call that follows a `202` naming its own version sends `poll: true`. A poll continues that copy and never starts one: it answers `202` while the copy runs, finishes it once it is done, answers the preview again if it already serves the poll's version, and otherwise refuses with `409` (the copy failed, a newer push or a refresh replaced it, or the preview was deleted). Only a new create starts a copy over.
    - Of two pushes to one preview, the newer is the one the registry recorded later, whatever its id. A create for an older version is refused (`409`, superseded) while a newer push's job is copying or being finished, and for 15 minutes after that push's last call, a poll included (`CopyJobs.markNewest`, kept per preview tag), so an older push never reaps or forks while a newer one replaces its copy. A newer push's job that failed, was cancelled or was left unfinished past its lease holds nothing off. After that, an older version is taken like any other create.
    - A copy's failure is answered with the status a refusal had, and with `409` naming the fault when the copy met a 5xx (its deadline, an end it could not reach, a load or a bind that failed while the job was finished): never a status a client retries as a gateway's. The fault still lands an ops-failure row.
    - A caller that does not send `async` is answered in its request as before. While a job copies, that caller gets a `409` saying the copy is in progress. On a host that runs copy jobs it is held to the same version rules as any create: a version older than a newer push's is superseded (within the hold, or while that push's copy runs), and an unknown version is refused `404`.
  - **The CLI.** `substrat preview create` sends `async: true`, prints the copy's progress while it waits (up to six hours), and sends `--refresh` on its first call only. It sends `poll: true` after a `202` naming its own version. A poll that fails as a gateway or the network fails, or with a `500` that names no reason (the platform's generic internal error, Cloudflare's redacted fault), is polled again, up to ten in a row; a refusal ends the wait with its reason.

  The hosted control plane binds the job object as `COPY_JOBS` (class `ScopeCopyJobDO`, wrangler migration `v4`). A rebind or adopt of a live scope still copies in its request.

- 7ae5d35: Add public privacy policy and terms of service pages, linked from the site footer.
- 1344288: Carry each loaded module's permission and owner-grant declarations in the deploy manifest. At publish, the control plane derives the registry's key rows from those declarations and refuses disagreements in keys, descriptions, declaring modules or holder marks (#2446, step 1). Module owner grants are checked against reserved keys too.

  The field is optional so manifests from older CLIs remain accepted without this consistency check. The declarations are supplied by the builder. A later step will verify known engine manifests; third-party modules remain author-asserted.

## 0.1.32

### Patch Changes

- 1a064a0: A scheduled pass now reports the platform requests its schedules enqueued, and a sweep that drains platform requests drains that scope again in the same pass, so a scheduled send goes out in seconds instead of waiting for the next sweep (#2431).

  - `ScheduleRunReport` gains an optional `platformRequests`, which both adapters fill. It is exactly what `onPlatformRequests` reports for each fire's invoke:

    - the `ctx.requestPlatform` calls the operation itself committed;
    - on Cloudflare, also the connector deliveries its tail routed to the platform.

    It does not count:

    - requests a consumer makes in the operation's tail;
    - requests of a fire whose invoke threw after the operation committed;
    - a purge horizon's runs.

    Whatever it does not count waits for the next drain, as before. The field is absent when the count is zero.

  - `runPlatformSweep` drains a scope once more, right after its schedules, when they report requests and `drainPlatformRequestsFn` is set. It does so once per scope, only for a scope the drain phase reached, and never fires a schedule from it. The drain before the schedules stays where it was, so a schedule still finds the scope's whole headroom under the 32-request cap.
    - In `platformRequestTotals`, a scope drained twice adds what each drain did, while `pending` and `unsettleable` are its later drain's.
    - A second drain that reaches no deployment, or throws, leaves the first drain's figures standing. It is counted in `unreachable`, or recorded in `errors`, as a first drain would be, so the drain's totals read as a floor.
    - An intent the first drain left pending is tried again by the second.
    - `ScheduleSweepReport` gains an optional `platformRequests` total.
    - No sweep in this repository reaches the second drain yet: the control plane's sweep drains platform requests, but its host runs no schedules. A self-hosted sweep that does both gets it.
  - A hosted vertical's scope sweeper has no channel to the platform's drain, so what its schedules enqueue still waits for the control plane's sweep. Its pass report now counts those requests (`schedules.platformRequests`), and the sweeper the platform supplies to a vertical logs a `scope-sweep` line with the pass's counts when there are any. A vertical gets that sweeper at its next push after the control plane carrying this release is deployed.
  - `SqliteScopeHost.getSystemScope` takes optional stub observers, as `getScope` does.
  - `@substrat-run/contract-tests` adds `schedulePlatformRequestsContractSuite`, which both adapters run.
  - The book's sweep chapter (chapter 9) describes the second drain under the schedule phase.

## 0.1.31

### Patch Changes

- 640106a: Daily digests in `@substrat-run/engine-notifications` (#118). A person can now take any topic that is not required as a daily digest instead of one mail per occasion: `notifications/set-my-preference` accepts an optional `cadence` (`'immediate'` or `'daily-digest'`; leaving it out keeps the current choice), and each topic in `notifications/my-preferences` shows its `cadence`. Everyone starts on `immediate`, so nothing changes for anyone until they choose a digest.

  - `notify` holds an occasion for a person who takes its topic as a digest. The occasion's delivery is recorded `skipped` with reason `digest`, and `notify` returns that outcome.
  - The engine declares a schedule, `notifications/send-digests`, every 15 minutes, run by its system principal under a new key, `notifications:send-digests`. The manifest declares that key `holder: 'system'`, so no person may hold it: `lint:permissions` refuses a role or entity grant shape that grants it, and a vertical's `PERMISSIONS.md` marks it reserved.
  - A person is due once their oldest held message is a day old. So nothing waits much longer than that, and a person with no more than 50 held gets one digest a day.
  - Each due person gets one mail of up to 50 held messages, oldest first, through the same send intent and delivery row as any notification. That mail is a delivery under the reserved topic `@digest` (`DIGEST_TOPIC`) and settles like any other. The occasions it carried are settled into it.
  - A pass never sends more than the scope's backlog of pending sends has room for (32, less 8 kept for mail that must not wait). Everyone else goes out on later passes, oldest first.
  - One digest carries at most 50 occasions (`DIGEST_MAX_ITEMS`), oldest first. The rest stay held and are due once the oldest of them is a day old, on the next pass if it already is.
  - Each person's digest is its own sub-transaction. One that cannot be written stays held, is reported by the new `notifications.digest-failed` event and an error line, and is retried a day later. It never stops anyone else's.
  - A held message that no longer reads is set aside rather than blocking the rest. It is marked and not sent, its delivery settles `skipped`/`quarantined`, and the new `notifications.digest-quarantined` event names it. It is read again once a day. When it reads again, for instance after a rolled-back version is rolled forward, it is released: held as before, its delivery back to `digest`, and named by the new `notifications.digest-released` event. If its person switched the topic off in the meantime, it is withdrawn instead: deleted unsent, its delivery `skipped`/`muted`, and named by the new `notifications.digest-withdrawn` event.
  - `sendDigests(ctx)` is exported. Call it after your own permission check to run one pass yourself; like the schedule, it sends only the people who are due.
  - A new event, `notifications.digest-sent`, lists the occasions each digest carried. `notifications.preference-set` gains two optional fields, `cadence` and `withdrawn`. No existing event changes its `schemaVersion`.
  - A mute still wins: switching a topic off withdraws what is held for it, and those occasions' deliveries then read `skipped`/`muted`. Composing a digest checks the mute again, so a held message whose topic is switched off is withdrawn, never mailed. A required topic refuses a digest and always goes out at once.
  - The digest adds no wording of its own. A digest of one message is that message. A digest of several uses the first message's subject with `(+N)` and puts each message under its own subject, as one document. A whole-document html template gives way to its text part there.
  - A held message is rendered mail addressed to the person, so a subject erasure deletes it along with their address.
  - Something must run the schedule, and something must drain the sends. On the hosted platform the scope sweeper runs the schedule once the scope's provision has granted the new key. An install provisioned earlier gets the key from the reconcile after a promote. The control plane's 15-minute sweep drains the sends. A self-hosted server needs `startPlatformSweeper` or `runDueSchedules`, and must drain its platform intents. Until both happen, messages are held and nothing fails; a hold that finds a person's oldest message two days old logs a warning.

  New migration `0002-digests`. It adds two tables, `notifications_cadences` and `notifications_digest_items`, and changes no existing row. The engine's manifest shape moves to `0.0.2`.

  The Handlebar demo lists the new key, holds it in no role, and binds no URL to the schedule's operation. Its dev server now starts a schedule sweeper, so the digest schedule runs there. It drains no platform intents, so a digest is written as a pending send, as every notification there is. Once 24 sends are pending, every pass defers everyone and says so.

## 0.1.30

### Patch Changes

- f614b00: Prepares the graph store driver's registration. No store driver is registered yet, so a push that declares `driver: 'graph'` is still refused with "declares driver 'graph', which is not registered".

  `assertScopeStoresRegistered`, `assertDeclaredScopeStores` and `assertSandboxContract` take the registry they judge against, `STORE_DRIVERS` when none is passed, and the control plane's deploy route and both uploads read its `storeDrivers` option.

  Once a driver is registered, a scope whose running version cannot be named, or whose manifest cannot be read, answers 503 before a backup, a full export, a snapshot, a reap, a restore, a subject erasure, the storage gauge or a sweep's wipe only where a version of its vertical has declared a store. A scope of a vertical that never declared one proceeds as it did before stores, and a vertical whose declarations cannot be read still refuses.

## 0.1.29

### Patch Changes

- 57700ea: The orphan-attachment sweep's dry-run-first rule is now held by the scope's own storage, so it holds whoever asks for a pass.

  **What is recorded.** A dry run records the ids it listed (at most 1,000, `ORPHAN_SWEEP_LICENCE_CAP`) in a new spine table, `_substrat_attachment_sweep_licence`, stamped with the host's clock. It writes only when that set differs from the one held, or the one held is older than half the window, so a scope whose orphans stay the same moves no write revision on every pass. A dry run that lists nothing clears the record. A dry run the restore fence holds lists nothing and leaves the record as it was. A destructive pass also takes every licensed id its listing no longer holds out of the record, so a record with nothing left to delete sends the scope back to a dry run instead of holding it until it expires. A destructive pass that cannot bring the record up to date afterwards still returns its report, marked `consumeFailed`; the phase counts it, and the deployment's log line names it.

  **The rule.** A destructive pass is refused with `conflict`, reason `orphan_sweep_unlicensed` (`ORPHAN_SWEEP_UNLICENSED`), unless the scope holds such a record from the last seven days (`ORPHAN_SWEEP_DRY_RUN_WINDOW_MS`). The refusal comes before anything is listed. The pass deletes only ids the record lists, and each id it deletes leaves the record, so one dry run can license several passes that work through a backlog. Every other guard of the pass still applies to each listed id.

  **Loads.** A dump never carries the record, and every restore, carry or fork drops it, so a loaded scope's next pass is a dry run.

  **The control plane's phase.** It keeps its admin-log rule, which still guards deployments pushed before this change. When a scope refuses a destructive pass for want of its own record, the phase dry-runs it in the same visit and counts it in `awaitingDryRun`. `OrphanAttachmentOutcome` gains `{ unlicensed }` for that answer. `OrphanSweepScope` gains `license`, `licensed` and `consume`.

## 0.1.28

### Patch Changes

- 98f09fe: A scope now checks, before it applies a pending migration, that the migrations its deployed code registers are the ones the platform stores for that version. The control plane derives one digest from the version's stored migrations and injects it into both uploads (the push and every serving upload) as the `SUBSTRAT_MIGRATIONS_DIGEST` binding. `migrationSetDigest` in `@substrat-run/kernel` computes it over the authored migrations, and both adapters run it over the authored steps the host registers. Kernel-derived migrations (`search/…`, `state/…`, `list/…`, named as such by `isDerivedMigrationVersion`) are left out on both sides, because whether a stored set carries them depends on the CLI that pushed it. Both sides decide by version name, so an authored migration versioned under one of those prefixes is not compared at apply either; the journal still holds it once applied. The pure host takes the same digest as its `migrationsDigest` option.

  **Behaviour change:** a mismatch means the build that is deployed registers other migrations than its push declared. The scope then applies nothing and fails closed through the existing `migration failed for <module>@<version> — scope fails closed:` record. The record names both digests and the registered migrations (up to 20, then a count). The fix is to push again from the build that is deployed.

  What is not checked: a scope with nothing pending, which never computes the digest; a version whose migrations the platform does not hold (`unheld:<id>`), which gets no binding; a script uploaded before this change, which gets the binding at its next serving upload; and a vertical on an adapter release from before this change. This is an integrity check that runs inside the deployed adapter, not an isolation boundary.

  `substrat push` now treats a module declaring `entityStates` the way it treats one declaring `searchables` or `lists`: without a resolvable `moduleMigrations` in the vertical's kernel, it carries no migrations rather than an incomplete set.

- 4501183: Refresh the ebook against weeks 39–41 and the first assistant engine implementation.
  Explain peer calls and event imports with transaction boundaries, permissions, instance
  selection, watermarks and replay; add four diagrams covering those paths, notifications
  and assistant approvals. Cover capability links, derived operations, archive/trash,
  attachment search, live reads, copy safety, supplied sweepers, Findings and module erasure.
  Keep the diagrams in the printable HTML as well as the EPUB, and correct stale limits.

  Reconcile the VitePress guides and references with the same changes and current code.
  Add a cross-vertical decision guide and a live-update diagram, reuse the engine diagrams,
  clarify delivery and execution guarantees, and document Findings, lake reads and scope-store
  transport. Correct stale realtime and catalogue claims and distinguish preview HTTP reads
  from the peer door.

- 0292dc0: A Microsoft 365 connection's certificate can be rotated before it lapses, without mail stopping (#2100).

  `@substrat-run/connector-microsoft365`: a save within 30 days of the current certificate's end, or one that sends `rotateCertificate: 'yes'`, generates a second keypair beside the current one. The current certificate keeps signing, and the connection's expiry stays its end. A later save signs in with the new certificate, and once Entra accepts it, it becomes the current one and the old key is dropped. If Entra refuses it, or cannot be reached, both stay as they were. Once the current certificate has lapsed, the new one takes its place at the next save. Sending signs with the new certificate when the current one has lapsed, or when Entra says the current one is no longer on the app registration. The probe signs in with the current certificate only and reports, through a check that is not recorded as the connection's health, whether Entra accepts the new certificate yet. A send's sign-in is recorded as one use, its deciding attempt, so the current certificate's expected refusal during a rotation does not count against the connection. A save that switches to the new certificate generates no further one. The credential summary shows both thumbprints and both ends. A caller can never supply either key. `prepareMicrosoft365(options)` builds the `prepareCandidate` hook with its sign-in.

  `@substrat-run/contracts`: `connectionCertificate` gains an optional `next` (`pem`, `thumbprint`, `notAfter`), the certificate being rotated in. The top-level fields still describe the certificate in use, so a consumer that ignores `next` shows the same thing as before.

- b190e40: A Microsoft 365 connection can read and write files in one Teams channel's folder of the tenant's SharePoint site (#2101).

  `@substrat-run/connector-microsoft365`: `bindMicrosoft365Scope` binds a scope to one folder, named by its drive path under the site's default document library and held by its item id from then on. A vertical writes by emitting `microsoft365.channel-files-requested` (`microsoft365FilesRequested`: a `directory` under the folder, up to 20 `files` by attachment id with each attachment's `size`, and a required `conflict` of `replace`, `rename` or `fail`). Files are at most 50 MB each and 100 MB per event, checked on the declared sizes before any byte is read (a declaration that is not the attachment's own size is refused once that attachment is read, since the platform hands over its bytes whole), and an attachment may be named once. The dispatch uploads the files one at a time, in one request up to 4 MB and by upload session above, and keeps a ledger keyed on the event id. A redelivery takes an existing file as its own only when this app wrote it and its size and QuickXorHash are the bytes being sent. A `rename` conflict uses a suffix derived from the event, never one Graph picks. `sweepMicrosoft365Files` follows the library's change feed a page at a time, saving where the next page starts after each landed page and stopping at a page budget per call (`SYNC_PAGES_PER_CALL`); a folder newly inside has its children read a page at a time under the same budget. A held item the feed does not account for (one a full pass never presents, or one a page shows somewhere it cannot place) is looked up in the drive on its own before anything lands for it, under its own budget (`SYNC_VERIFY_PER_CALL`). An item is deleted only on an answer about that item: its own deleted facet in the feed, or its own lookup finding nothing; never on a folder above it or a re-read's silence. A transient lookup error stops the pass with nothing deleted; a refusal that will not pass by itself (400, 403, an enclosing folder that cannot be read) keeps the item held, lets the pass finish, and is counted in `lastSync.unplaced`. It is asked again only on a later full pass or when the feed mentions it again, at most `MAX_UNPLACED_ATTEMPTS` times; after that it stays held as last seen, never deleted, until the scope is bound again, which clears the refusals and starts a full pass. A folder's own answer lands even while it still holds such items, which stay held. It lands each change in the folder through the binding's operation as the connection (`microsoft365ChannelChange`: `upsert`, `content` and `delete`), at least once and keyed by item id, with file contents uploaded as attachments on the entity the operation names. A path outside the folder is refused before Graph is called. Items outside the folder are never stored or logged. A deleted folder makes the binding refuse rather than fall back to the library root, and an unbind or re-bind during a pass is never written over. `registerMicrosoft365FilesConnector` and `declareMicrosoft365FilesConnector` register the dispatch on a host that runs it, or for routing only on one that does not.

  `@substrat-run/control-plane-api`: the connection bindings route takes a `folder` for a Microsoft 365 connection, and only for one. `@substrat-run/contracts`: the binding audit entry carries it. `@substrat-run/control-plane-client`: `ConnectionScopeBindingInput` gains an optional `folder`. `@substrat-run/cli`: `substrat connection bind` takes `--folder`.

- af096c6: The platform now runs the orphan-attachment sweep on its scheduled pass. The sweep is off until the platform turns it on, and it runs as a dry run before it deletes anything.

  **The phase.** `runPlatformSweep` takes `orphanAttachments: { mode, sweepScopeFn, batch?, rng? }`. Left unset, the phase is skipped. Each pass visits at most `batch` active primary scopes (default 25). The window starts at a random point in the id order and wraps around, so every scope is reached over enough passes. The report counts three standing conditions apart, and none of them is an error:

  - scopes the pass may not judge (`refused`);
  - deployments built before the pass existed (`unsupported`);
  - deployments that hold no attachment store for the tenant (`noStore`).

  **A delete needs a dry run of the same scope first.** In `delete` mode a scope is swept for real only when the admin log holds a dry-run row for it from the last seven days. Any other scope gets a dry run instead. Every pass that finds or deletes an orphan writes a `sweepOrphanAttachments` admin-log row (`admin.recordOrphanSweep`). The row carries the counts and every key deleted, or every key a pass would delete.

  **The control plane decides before any deployment judges.** For each scope it checks four things in its own directory: the scope is active and primary, it is bound to a vertical, its tenant is active, and every copy-ledger entry for it is `done`. Only then does it call `POST /internal/attachment-sweep` on the script the directory routes the scope to: its serving script, else its bound version's. There is no fallback to another script, and the control plane never asks its own host. The route requires `dryRun` and `copiesSettled: true`. It also requires `expectedVersionId`: the version the directory says runs on that script. A script deployed as another version refuses the pass, and so does one that carries no version identity when the pass is destructive. The route takes no instant from the body, and it answers 501 on a host built before it. A destructive pass writes its own log line in the deployment, with the scope, the counts and the deleted keys.

  **A deployment with no attachment store answers so.** A pass whose deployment holds no attachment store for the tenant now returns `bucket: 'none'`, after every refusal the scope's copy makes, instead of failing. It does so only when the scope holds no attachment row either. A scope that holds files but has no store has a missing store binding, and its pass still fails. A store that held nothing answers without the marker.

  The control plane's mode is `ORPHAN_ATTACHMENT_SWEEP`, with the values `off` (the default), `dry-run` and `delete`, and its window size is `ORPHAN_ATTACHMENT_SWEEP_BATCH`. `docs/architecture/orphan-attachment-sweep.md` has the rollout.

  The dashboard's activity view reads the new admin-log rows as "swept orphan attachments".

- 39ccfea: Attachment bytes that no row points at can now be swept, and nothing can sweep the bytes of a row that committed.

  **The sweep.** `host.sweepOrphanAttachments(tenantId, scopeId, { dryRun?, limit?, copiesSettled? })` is one pass over a scope's attachment keys (`scope/<scopeId>/att/<ulid>`). It deletes an object only when no `_substrat_attachments` row names it, its id is more than seven days old, and the scope is clear of its restore fence. Age and fence are judged against the host's own clock (`clock` on the pure adapter, `orphanSweepClock` on the hosted one, both set at construction). A pass takes no instant from its caller. The scope condemns each candidate first, in one transaction, into the new spine table `_substrat_attachment_condemned`. Only a condemned object is deleted. A dry run condemns and deletes nothing and reports the keys a pass would delete. Other scopes' keys, other features' keys and malformed keys in the same bucket are never judged. Both adapters implement it. Nothing runs it on a schedule yet: the platform's pass is a separate change.

  **An upload whose id was condemned is refused.** Both adapters' attachment insert, an upload-link redemption included, refuses a condemned id in its own transaction (`conflict`, reason `attachment_condemned`). So an upload racing a pass fails instead of committing a row without its bytes. A restore or carry whose dump would bring back a row for a condemned id is refused the same way, before anything is dropped. `pnpm lint:attachment-writers` refuses a new writer of attachment rows that skips either check.

  **A rewind or a restore now refuses when its fence cannot be written.** This is a behaviour change. Every PITR rewind and every restore of a scope first writes a fence object into the tenant's attachment bucket, and the sweep deletes nothing of that scope for 35 days after it, because a Durable Object keeps 30 days of point-in-time history. If the fence cannot be written, the rewind or restore is refused before anything is replaced: availability is traded for never losing a restorable row's bytes. The error says so, and the operation can be retried once the bucket answers. A rewind also refuses a scope that holds files and whose tenant it cannot tell. The control plane now names the tenant on `/internal/rewind`, and otherwise the scope's own provision receipt does.

  **Only the scope's own live copy judges.** Both adapters refuse a scope that is not active (archived, reaped, or under a suspended tenant) and a fork or a preview. With a directory, the hosted adapter reads the scope's record before it addresses the scope's storage, so a reaped scope is never woken. Its scope object also refuses on its own when its storage was reaped, when its delivered lifecycle is not active, when it holds nothing at all, when it is a copy a carry wiped or kept, and when its provision receipt does not name the tenant.

  **No pass while another script's copy is unsettled.** While the copy ledger holds any entry for the scope that is not `done` (pending, eligible, kept, retained, or a state added later), the pass is refused, because that copy may hold rows, uploads among them, that the serving copy lacks, or may still turn one up. `done` is the only settled state (`SETTLED_COPY_STATES`, an allowlist). A deployment with no directory cannot read the ledger, so it refuses unless its caller says it checked (`copiesSettled: true`).

  **What the sweep cannot protect.** A restore from a dump older than 35 days can bring back rows whose bytes were swept, the same exposure a removed attachment already has.

  `orphanSweepContractSuite` holds each guard on both adapters with the others out of play: a pass racing a held upload, an in-flight upload a pass leaves alone, a restore the fence protects, and a fork and a foreign tenant refused. The hosted adapter's own cases cover the receipt, the copy markers and the rewind fence. `SqliteScopeHostOptions.wrapBlobStore` lets a deployment or a test wrap the per-tenant store.

- 754fc62: A peer now holds only what the version serving the scope declares for it. Narrowing a peer's entry in `peers`, or removing the peer, used to leave every existing install holding the old permissions, because provisioning only ever adds them. Now the first call after the promote no longer has a permission the running version dropped, on every install, with no reconcile needed. The grant an earlier version wrote stays in the scope as a record but counts for nothing, and switching the peer off and on again does not bring it back. Declaring the permission again makes it held again, and a grant a tenant took away stays taken away. The per-scope peer status read (`peerGrantsStatus`, what the dashboard's peer panel shows) follows the same rule: a peer that holds no permission the running version declares reads `ungranted` rather than `on`, and a switched-off peer still reads `off`. Both adapters evaluate every check through the new kernel export `boundToPeerDeclarations`. It fails closed: if the running declaration cannot be read, a peer holds nothing. `@substrat-run/contract-tests` adds the `peerModNarrowed` and `peerModWithoutCaller` fixtures. The peers section of `PERMISSIONS.md` and the permissions guide now say that a narrowing takes effect at promote.
- c7eb5fa: A promote acknowledgement now answers one review. The review a promote shows is computed against the version prod points at when it is read, and a promote by someone else in between used to leave the acknowledgement standing for a diff that was no longer the one applied. The migrations read (`/versions/:id/migrations?base=`) now answers a `review` binding beside the diff it shows: the base version and a digest of the stored rows the review was computed from (each side's id, permission and migration digests, and every stored migration with its declared moves and discards). A promote carries it as `acknowledge.review`, and the control plane recomputes the digest from its own rows and refuses, as `precondition_failed` with reason `promote_review_stale`, when prod no longer points at that base or the digest differs. The sent digest is only compared, never read as the diff. The channel pointer now moves by compare-and-set, in one transaction with its history row: of two promotes judged against the same base, one moves the channel and the other is refused as stale and records nothing, where both used to land.

  **Behaviour change:** a migration acknowledgement without a binding is refused when the migration digest moved (`precondition_failed`, reason `promote_review_unbound`), because it is the acknowledgement that lets a migration, and any data loss it declares, reach live data. An older `substrat promote --ack-migrations` is refused that way, and the refusal says to upgrade to a CLI release whose `substrat promote` supports `--review` (this one). A permission-only acknowledgement without one is still honoured, so an older client keeps promoting where no migration changes; a binding, when sent, covers the permission diff too.

  `substrat promote` prints a `--review <token>` with every refusal that prints the diffs, and takes it back with `--review`; a stale or unbound refusal prints the diffs as they stand now, with the new token. The dashboard's promote dialog sends the binding with every promote, and when prod moved it reads the review again and asks again from scratch, saying so, with nothing ticked carried over. The console's promote dialog binds its acknowledgement to the review it read and, refused as stale, reloads the channel and shows the new review. The refusal's header line in `substrat promote` now quotes a version id that is not a plain id, as the migration listing already did.

- 439efc1: A scope rebind's migration acknowledgement now answers one review, as a promote's does. `GET /tenants/:tenantId/scopes/:scopeId/rebind-review?vertical=<target>` returns what the rebind would apply: the target vertical's serving version over the version the scope is bound to, each migration with its SQL and declared moves and discards. Beside it is a `review` binding: the scope's bound version, and a digest of both sides' stored rows that is taken under its own tag, so a promote's binding is never accepted as a rebind's, or the reverse. `POST …/rebind-vertical` takes it as `acknowledge.review`. The control plane recomputes the digest from its own rows and refuses with `precondition_failed`, reason `rebind_review_stale`, when the scope is no longer bound to that version or a promote on either vertical has moved what the review showed. The read follows exactly the rebind's own visibility. It is one shared rule: a workspace credential needs to be able to read both verticals (its own, or a listed one), and everything else answers the same 404, for the read and for the rebind. The migration SQL itself is shown only to staff and to an owner of both verticals; anyone else gets `migrations: null` and `migrationsWithheld: true`, with the digests-differ fact and the binding, so a workspace can still acknowledge and rebind onto a listed vertical.

  A rebind now moves the scope's route and its version pointer in one write. That write is conditional on the scope still being bound to the judged version and on the target still serving the judged version, on both adapters (`bindScopeVersion` gains the additive options `servingRef` and `expectedServing`). Before, these were two writes, and a promote on the target landing between them left the route on the new script and the pointer on the old vertical. A promote that lands while the data is being copied now refuses the rebind as stale; the scope keeps serving from where it was, and both copies are kept.

  **Behaviour change:** an `ackMigrations` without a binding is refused when the two migration digests differ (`precondition_failed`, reason `rebind_review_unbound`). The refusal says to upgrade to a CLI release whose `substrat scope rebind` supports `--review`, which this one does. `substrat scope rebind` prints the migrations and a `--review <token>` with every digest, stale or unbound refusal, and takes it back with `--review`. The dashboard's and the console's Move dialogs now read the review before they ask and show the migrations. They send each install's binding, and when a version changes under them they read the review again and ask again from scratch.

- 3025154: The control plane now derives a version's migration digest itself, instead of storing the digest the push sent. It derives it from the migrations the push declares in its manifest, with their declared moves and discards, and from the manifest's store classes. Those migrations are what the platform stores and what the promote review shows. The promote gate, the bind snapshot and the lineage rebind compare the derived value, so the digest they compare and the migrations the review shows are always the same set. `migrationDigestOf` in `@substrat-run/contracts` is the one implementation: `substrat push` hashes with it, and the control plane re-derives with it.

  **Behaviour change, at push:** a push that carries its migrations under a digest that is not theirs is refused before anything is uploaded (`validation_failed`, reason `migration_digest_mismatch`), on `/verticals/:slug/deploy` and on the raw version publish alike. A CLI whose push digest covers the SQL and its declarations is unaffected. One from before the SQL entered the digest is refused, and the refusal says to upgrade the CLI.

  **Behaviour change, at promote:** a version whose manifest carries no migrations has nothing to derive a digest from. That covers a version pushed before manifests carried them, one whose SQL is over what a manifest carries, and one with no manifest. It is stored as `unheld:<version id>`, which equals no other version's digest, so every promote to or over it asks for the migration acknowledgement, and the refusal says why. Before this, such a version was compared by the digest its push sent.

  Versions stored before this change keep the digest their push sent until it is derived. Each directory re-derives them: the Durable-Object directory in bounded batches on its backfill alarm, and both adapters on any read of a version the backfill has not reached yet, so no gate compares a pushed digest in the meantime. A restore of a dump taken before is derived again the same way.

- 3608db6: An upload-link redemption whose reply was lost can be retried safely. The redeemer names the request with an `Idempotency-Key` header: 16 to 255 visible ASCII characters with no space, `"` or `\`, such as a UUID. The structured-field form `"…"` is read without its quotes. The spend records the key's SHA-256 beside the link in a new nullable column, `_substrat_upload_links.redeemed_key_hash`, which both adapters add to an existing scope on its next open.

  A later request for the same link, with the same key and the same bytes (size and SHA-256) and within the link's lifetime plus 10 minutes (`UPLOAD_LINK_REPLAY_GRACE_SECONDS`), gets the stored record back with **200** instead of 201. It writes no bytes, no row and no event. The same key with other bytes is **422** (`upload_link_replay_mismatch`). Every other request for a spent link gets the same 410 as before, with the same headers and body: no key, another key, after the window, or after the file was removed or swept. A retry that races the first request has its own bytes removed and is answered as the replay.

  `ScopeHost.inspectUploadLink` takes an optional `idempotencyKey`, `UploadLinkRedeemInput` gains `idempotencyKey`, and `redeemUploadLink` answers a `RedeemedUploadLink`, which carries `replayed: true` on a replay. A malformed key is `validation_failed`. `@substrat-run/contract-tests` adds `uploadLinkReplayContractSuite`, run by both adapters.

- 9ceb545: Upload links: four tightenings after the first release's review.

  **A family no longer admits an active type.** In an `uploadLinks.contentTypes` allowlist, `image/*`, `text/*` and every other family now leave out the types a browser runs rather than shows: HTML, `text/xsl`, `multipart/x-mixed-replace`, the types a browser sniffs for HTML (`application/unknown`, `unknown/unknown`), every XML type (`text/xml`, `application/xml` and any `+xml` subtype, such as `image/svg+xml` or `application/xhtml+xml`) and every WHATWG JavaScript MIME type (`text/javascript`, `application/javascript`, `application/x-javascript`, `text/ecmascript` and the rest). An exact entry still admits one on purpose (`['image/*', 'image/svg+xml']`). An absent allowlist still admits every well-formed type, these included. The rule is `isActiveContentType` in `@substrat-run/kernel` (`ACTIVE_CONTENT_TYPES` plus every `+xml`), and `uploadContentTypeAllowed` applies it in both the route and the redemption, to the type normalized by `normalizeUploadMediaType` (parameters, whitespace and case dropped, and `image/jpg` spelled `image/jpeg`), which is also how a redemption records it, including one a host makes by calling `redeemUploadLink` directly. An allowlist entry spelled `image/jpg` therefore never matches. A type that is not exactly one `type/subtype` after that (`isMediaTypeEssence`: a comma-separated list, a comma or whitespace after the subtype, a NUL, CR or LF, a missing or extra part, or a `*` wildcard, which only an allowlist entry may be) is refused by every allowlist, an absent one included, and the route answers 415. A link minted under a family that a vertical relied on for SVG or HTML now answers 415 for those files. Name the type to keep taking them.

  **A wrong path is the same 404 whatever the link's state.** The target named in the path is judged before whether the link is pending, used, expired or revoked, so a spent link at another entity's path now answers 404 (`upload_link_wrong_target`) instead of 410. `ScopeHost.inspectUploadLink` takes an optional fourth argument, the target, and both adapters judge it in the kernel. A wrong path still spends nothing.

  **A malformed secret never reaches the scope.** The route checks the secret's shape (`isUploadLinkSecretShape` from `@substrat-run/contracts`: `sbup_` and 43 base64url characters) before it resolves the host or the scope. It answers the same 404 an unknown secret gets. The kernel holds every lookup to the same shape.

  **`mountUploadLinkRedeem` no longer takes a `path` option.** It always listens at `/api/attachment-uploads/:entityType/:entityId/:secret`, the path `mintUploadUrl` returns and the one whose secret `invocationLog` redacts. A custom mount matched no minted URL and wrote its secret to the log. `invocationLog` now also redacts any path segment that starts with `sbup_`, wherever it sits.

  `uploadLinkContractSuite` adds cases for the principal-only mint and revoke (a consumer is refused both), redemption from another scope and another tenant, the active-type rule and the target-before-state answer, all run by both adapters.

## 0.1.27

### Patch Changes

- c4a0352: An operation can mint a single-use, short-lived upload URL for one attachment on one entity, so a caller with no session (an MCP client's shell, a `curl`) uploads a file without sending base64 through a tool call. An `attachmentTargets` entry opts in with `uploadLinks: { maxBytes, contentTypes? }` (at most 25 MiB; absent, a mint is refused), and `ctx.attachments.mintUploadUrl({ entity, filename?, maxBytes?, ttlSeconds?, visibility? })` returns `{ id, secret, path, expiresAt, maxBytes, filename }`. It checks the target's `writePermission` on the entity as the caller, for a principal only, and lives ten minutes by default and an hour at most. `ctx.attachments.revokeUploadLink` and `ctx.attachments.uploadLinks` take a link back and list them, never with the secret.

  `mountUploadLinkRedeem` from `@substrat-run/vertical-host` mounts `PUT`/`POST /api/attachment-uploads/:entityType/:entityId/:secret`. It reads the body under the link's size, decides the media type (the request's, else the extension, else the bytes; PDF, PNG, JPEG and GIF must match their bytes) and hands it to `ScopeHost.redeemUploadLink`, which writes it through the ordinary attachment write: bytes first, then the row and `attachment.added` in one transaction, authored by the principal who minted the link and checked against the target's `writePermission` as them again at redemption. The link is spent in that same transaction, so any refusal leaves it unspent. Answers: 201, 404 (unknown secret, or a path naming another target), 410 (used, expired or revoked), 413, 415, 403. The answer is `no-store`, carries no `ETag` or `Location`, and drops the CORS headers an outer layer set. `invocationLog` writes the secret segment of that path as `[redacted]`.

  Only the secret's SHA-256 is stored, in the new kernel-owned `_substrat_upload_links` table, and a module that persists the secret is refused as it is for `ctx.capabilities`. A copy of a scope starts with no links. Three kernel-authored events, `attachment.upload-link-minted`, `attachment.upload-link-redeemed` (written with the `attachment.added` it caused, and naming the attachment) and `attachment.upload-link-revoked`, join the reserved set. `ScopeHost` gains `inspectUploadLink` and `redeemUploadLink`, both optional like `getCapabilityAttachments`. `lint:permissions` renders an _Upload links_ section for a vertical that declares one, and `@substrat-run/contract-tests` adds `uploadLinkContractSuite`, which both adapters run. Existing upload routes and their behaviour are unchanged.

- 58f90ca: A scope-store script's entry checks every call with `verifyScopeStoreCall` before it constructs the kind's class, and refuses unless the object's own id is the id of the signed name (#2289). The kind gets the exact body that was verified, its own bindings only (the entry's `SUBSTRAT_STORE*` bindings are stripped from its env, and the upload sets `disallow_importable_env` and `disable_ctx_exports`, so neither an imported `env` nor `ctx.exports` reaches them), one instance per object, and its alarms. `withStoreEntry({ className, script, callerPublicKeys, platformPublicKeys })` puts the entry in front of a kind bundle, and refuses the entry's reserved module, class and binding names, a key listed for both audiences, and a kind flag of `allow_importable_env` or `enable_ctx_exports`.
- 6b558f3: A Cloudflare host with no runner and no chosen transport calls a scope store through the platform hop (#2288), whether or not it has a control plane. An ambient `SUBSTRAT_STORE_*` namespace is used only when the host is given `transport: 'binding'` or a runner, and `transport: 'platform'` beside runners is refused. On the platform hop the host's local store size, export and erase refuse with `unavailable` instead of answering that there are no stores.

## 0.1.26

### Patch Changes

- 8ff761c: The control plane now refuses a vertical's own durable-object binding that takes a per-tenant or scope store's name, as the push already did. Both use `storeNamesOfBindings`. A scope store's error envelope is read only with a status from 400 to 599, and a `StoreError` carries the store's body to a client only for a 4xx whose JSON is at most 1 KiB (`STORE_BODY_MAX_BYTES`). Both adapters start and stop scope-store runners through `scopeStoreLifecycleOf`. A retried start no longer starts a runner twice. `close` waits for a start in flight, so no runner starts after it, and then calls `stop` on every runner even when one throws, reporting several failures as an `AggregateError`. An own durable-object binding is also compared with the injected per-tenant and scope runtime names, as every static binding is.
- cb957bc: A vertical can declare `scopeStores`: one platform-run object per scope, a binding plus a kind. The only kind is `graph`, and it has no default. A hosted upload carries no store binding: the vertical's calls go through the platform. A binding already used by another store is refused, and so is `ATTACHMENTS`. A kind with no registration is refused by the push and again by the control plane. No kind is registered yet, so declaring a scope store does not deploy one.
- cb957bc: A concept page for scope stores: one platform-run object per scope, declared as a binding and a kind, reached through `getScopeStore`. Hosted deploy of the store script is not available until the kind is registered.
- b4bb938: The scope-store concept page says what a vertical can use today (nothing is live until a store kind is registered) and covers the platform call path, what an invocation line records, erasure, snapshot, restore, export and backup — including that a store's tables in a backup are not sealed per subject — the storage meter, and the known limits.

## 0.1.25

### Patch Changes

- 56b0af0: A per-tenant store declared in `tenantStores` may say `kind: 'blob'`. `blobStores` stays accepted as the older spelling of the same declaration, and a binding named in both is refused, because both would be bound as `<BINDING>__<tenant>` on the serving script. A push still sends blobs in the manifest's `blobStores` and relational stores in `tenantStores`, so a control plane from before this change parses the same document it parses today.

## 0.1.24

### Patch Changes

- 2c75a0d: An entity can make its trash horizon a floor as well as a deadline: `trash: { permission, purgeAfterDays, purgeEarly: false }` (#2214). The kernel then refuses the entity's `trashed: 'purges'` operation, for every caller, on an entity that is not in the trash or was trashed less than `purgeAfterDays` ago. As with the other trash refusals, it checks the operation's declared key first, so a caller without the key gets `permission_denied` and a caller with it gets `not_found`. There is no opt-out. The platform's purge sweep works as before. The floor holds the purge operation, not the trash: an operation declared `trashed: 'admits'` that deletes the row can still remove a trashed entity at any time. A missing entity gets the same refusal as an active or a recently trashed one.

  `purgeEarly` is optional and defaults to `true`, which keeps today's behaviour: the purge operation is also the permanent delete a person uses to empty the trash at any time. `purgeEarly: false` without `purgeAfterDays` is refused when the model is emitted and when a module is registered. The emitted `model.json` carries `"purgeEarly": false` only when it is declared. A reader that does not know the key ignores it.

  `purgeCutoffOf` is no longer exported from the kernel's index. It was added after 0.144.0 for ticket0's purge handler and has not been in any release. That handler now relies on the kernel's refusal instead of comparing dates itself.

- 5554b23: **Behaviour change to a documented rule (#901): a kernel state move no longer moves an entity's version** (#2191). `ctx.archive`, `ctx.unarchive`, `ctx.trash` and `ctx.restore` change no field anyone read. They set only the kernel's own `_substrat_*_at` columns. So the version, which an operation's `If-Match` is compared against, now skips their four events. Before this, a client that read a row, moved it and then sent a guarded write got `412 precondition_failed` ("changed since you read it") although nothing had changed, and the move operations hand back no `ETag` it could have used instead. Now the tag it holds still matches. A real edit in between still refuses it.

  - Contracts exports `ENTITY_STATE_MOVE_TYPES`, the four move types, and the kernel's `entityVersionQuery` leaves them out. The query is now `ORDER BY id DESC LIMIT 1` over the existing `(entity_type, entity_id, id)` index, so it still walks the index and does not aggregate. Both adapters run the same SQL.
  - **Archive is not write-refused.** A trashed row is refused to every operation whose declared check names it except one that declares `trashed: 'admits'` or `'purges'` (a restore, a delete for good, the purge), and a guarded one of those still compares its `If-Match`. An archived row is refused to none: an edit sent with a tag read before someone archived the row is admitted, lands on the archived row, and the row stays archived.
  - Only these four. The other kernel-authored events about an entity (a link or relink, a grant top-up or retirement, a holder bound or unbound, an attachment added or removed) still move the version. Whether any of them is content is a separate decision.
  - A row whose only events are moves, such as one seeded without an event, has no version, as it had none before it was moved.
  - **At deploy:** the rule changes for a vertical when it is next pushed on a release carrying this. A client holding a tag it read from a row whose newest event was a move, or an idempotent replay recorded from such a call, gets one `412` on its next guarded write, re-reads and carries on. That is the safe direction: no write is admitted that the old rule would have refused for a content change.

  The concurrency docs (`concepts/api-design`, `concepts/scope-host`) state the rule.

- 3782c4c: `trashRefusalGapsOf` also names an operation that addresses a trashable entity by an input id under a check that is not on that entity — a scope-wide key, or another entity's — when its `concurrency: { over, idFrom }` says which entity the id names (#2161). Each gap now carries `via: 'check' | 'concurrency'`. `lint:model` prints the new kind as a warning, as it does the resolved-check kind. The host refuses neither on a trashed entity, so the handler must ask `ctx.entityState`, or the check should move onto the row.

  The ticket0 page says what the saved-reply trash does.

- fac4f0a: `EntityDef.stamps` takes the updated pair, `updatedAt` and `updatedBy`, held true by the host on every row a call emits about (#2166).

  - A derived create writes all four stamps. A derived update writes the updated pair with every write it makes; one that sends nothing still writes nothing.
  - The host holds the pair on every row an operation, a consumer or an imported-event handler emits about. The row must carry that call's `ctx.now()` and principal, or the call fails `internal` and rolls back. **An authored handler on an entity that declares the pair, and forgets to stamp a row it emits about, now fails**: set `updated_at` and `updated_by` wherever you write the row. The host reads the emits, not the writes. An emit about a stamped row counts as a write to it, so a handler that only announces the row stamps it too. A write that emits only about another entity, such as the parent, is not checked. A deleted row is not checked. Neither are kernel writes (archive, trash, restore, links, attachments, grants), which leave the pair as it was, nor an emit rolled back inside `ctx.atomic`.
  - An entity that declares no updated stamp is never read, and a scope with no such entity pays nothing.
  - `defineEntities` also refuses a stamp kind named twice, and an updated stamp on a composite primary key, which no event can name.
  - The manifest gains `updatedStamps`, derived by `manifestEntities()`. It is optional and additive, and absent when no entity declares the pair, so existing manifests are unchanged.

## 0.1.23

### Patch Changes

- e286f87: **Breaking:** `create` is now a derivable shape (#2157). After upgrading, `defineOperations` refuses at module load a create that matches it and declares neither `derive` nor `authored`, and the error names the operation and both remedies:

  - Declare `derive: 'create'` and delete the handler. `operationsFor` no longer asks for it and supplies the platform's.
  - Or keep the handler and declare `authored: '<what the derived create would get wrong here>'`.

  A create matches when it is served as `POST`, emits about the row by its id, answers with the entity's own `fields`, and every column of the row is filled by exactly one thing the model names:

  - the primary key, a minted ULID (so it must be a single string column);
  - the link column `<parent>_id`, from the id of the parent the check is narrowed to;
  - an input field, filling the column of its snake_case name, of the same type (string or number);
  - a declared stamp (below);
  - the column's default (`NULL` unless the table sets one), for a nullable column nothing else names: it is left out of the insert. An optional input the caller leaves out is written as `NULL`.

  The derived create checks the declared key first. With a parent, it answers `not_found` for a parent that does not exist and links the new row to the parent, so the parent's grants reach it. On an entity with a natural `key`, a row already holding that key is the answer, with no write and no event. Under a parent, that key must include the link column, or the create is not derivable. A replay answers on the write key alone, as a hand-written idempotent create does. An entity that declares `trash` or `archive` cannot pair a natural key with a derived create, because the replay would answer a row the kernel hides; that create is written by hand. Otherwise it inserts the row and emits the declared event once.

  **Behaviour change, derived `list`:** a derived page whose check is narrowed to a parent now answers `not_found` for a parent that does not exist, where it answered an empty page. The check still comes first, so a caller without the key is still `permission_denied`.

  What changes:

  - `@substrat-run/contracts`:
    - `EntityDef.stamps`, `{ column: 'createdAt' | 'createdBy' }`, names the columns a derived create fills from the call: `ctx.now()` or the calling principal. A derived update refuses a body field that writes a stamped column. Only the created pair exists, because a row is inserted once and the declaration stays true of it. An updated pair waits for the host to hold it on every write, authored ones included.
    - `defineEntities` refuses a stamp on a column that is not a field, on the primary key, or on a column that is not a string. Stamps add no migration.
    - `emitModel` renders `stamps` into `model.json`. `DERIVED_KINDS` gains `'create'`, and the plan types gain `DerivedParent` and `DerivedStamp`.
    - `emittedModel`, the schema a reader such as the control plane parses a pushed `model.json` with, is forward-compatible. A `derive` kind, a stamp kind or an extra key on a handler entry that a newer emitter wrote is carried rather than refused. Before, a closed list refused every model whose emitter was newer than the reader, so a vertical's push was a 400 until the control plane was redeployed. What the reader holds is typed `IngressModel`. `emitModel` and the `EmittedModel` type still allow only the kinds this release knows, and `defineOperations` still refuses an unknown kind at load.
  - `@substrat-run/kernel`: the derived create, with its stamps, and the parent-existence check on a derived list.
  - `@substrat-run/contract-tests`: `derivedHandlersContractSuite` covers both on both adapters.

  Nothing derives a hook around a handler: an operation that needs one more step than its shape stays authored.

- f6d671b: **Archive and trash operations are derived handlers (#119).** An entity that declares `archive: { permission }` or `trash: { permission }` no longer needs a hand-written handler for its moves or its bin. Declare the operation with `derive` and the platform writes it:

  - `derive: 'archive'` / `'unarchive'` / `'trash'` / `'restore'`: a `POST` whose input is the id alone, checked on that row (`permission: { key, entity, idFrom }`) under the key the entity declares for the move: its archive key for archive and unarchive, its trash key for trash and restore. It answers the new `entityStateOutput` schema (`{ id, state }`) and declares no `emits`, because the kernel announces the move. A `restore` declares `trashed: 'admits'`, and the other three must not.
  - `derive: 'trashed'`: the bin. A `GET` page (`paged.over`) of an entity that declares `trash`, answering its `fields`. It declares `narrows` checking exactly the trash key and no leading check, because `ctx.pageTrashed` checks the key on every row. Optional inputs are declared filters.
  - A derived `list` over an entity that declares `archive` may take one optional `view: z.enum(['active', 'archived'])` input, passed to `ctx.page`. Without it the page is the active rows.

  `@substrat-run/contracts` exports `entityStateOutput`, and `DERIVED_KINDS` grows to nine. `@substrat-run/kernel` writes the five new handlers through the existing verbs, adding no `ctx` surface. `@substrat-run/contract-tests`' derived-handler suite holds them on both adapters.

  **Compatibility.** `defineOperations` already refuses, at module load, an operation of a derivable shape that declares neither `derive` nor `authored` (#1773). The new shapes join that check. An operation that matches one exactly, including answering `entityStateOutput` itself, must now declare it. The error names the operation and the shapes it matches, for example `derivable from the model as \`archive\` or \`unarchive\``. Archive and unarchive declare the same shape, so the error offers both, and `derive`says which move it is. The widened`list`shape is gated the same way: a hand-written page over an entity that declares`archive`, whose only input beyond the declared filters is an optional `view: z.enum(['active', 'archived'])`, was not derivable before and is now refused as derivable as `list`.

  The one-word migration: add `derive: 'archive'` (or the move it is) to the declaration, delete its handler, and use `entityStateOutput` as its output. For such a page, add `derive: 'list'` and delete its handler. Or, to keep the handler, declare `authored: '<why>'`. An operation answering its own `{ id, state }` schema is not matched, and is unaffected.

- b508cdc: New engine, `@substrat-run/engine-notifications` (#118): an occasion a vertical names becomes email to the people it concerns. It is composed by call. A vertical calls `notify(ctx, { topic, description, dedupeKey, recipients, vars, about, template, required? })` in its own transaction, usually from its own consumer of a domain event. For each recipient, the engine:

  - applies their mutes, unless the topic is required;
  - looks up their address;
  - renders the template with every variable HTML-escaped;
  - writes a send intent with the kernel's `requestEmail`;
  - records one delivery per (dedupe key, topic, person, channel).

  Pass the triggering event's id as `dedupeKey`, and a redelivered event mails nobody twice. A template variable the caller did not pass makes `notify` throw `validation_failed`, which rolls back the caller rather than sending a blank mail. The engine settles each delivery from the `email.sent`, `email.refused` or `email.dead-lettered` event the platform writes back. A delivery that was not sent says why: `muted` or `no_address`. A topic is recorded the first time it is used, and that is what a person's preferences list.

  A person's notification address is held by the engine, never put on an event, and deleted by a subject erasure. The send intent names the person as its subject, so the same erasure cancels a send that is still held.

  Operations:

  - `notifications/my-preferences`, `notifications/set-my-address` and `notifications/set-my-preference` require `notifications:self` and act on the caller only.
  - `notifications/list-deliveries` requires `notifications:read`.

  The package is private until its first release is set up.

  The Handlebar demo composes it: its own consumer of `workorder.assigned` mails the mechanic a repair was assigned to.

## 0.1.22

### Patch Changes

- e55e06c: **Breaking:** an operation whose handler the model describes completely must say who writes that handler (#1773). After upgrading, `defineOperations` refuses at module load any operation of a derivable shape that declares neither, and the error names the operation, the shape and the remedy:

  - Declare `derive: '<shape>'` and delete the handler. `operationsFor` no longer asks for it and supplies the platform's.
  - Or keep the handler and declare `authored: '<what the derived handler would get wrong here>'`.

  The derivable shapes, each matched exactly:

  - `get` is served as `GET`, its input is the id alone, its output is the entity's own `fields`, and it emits nothing.
  - `list` is a `paged.over` page of the entity's own `fields`, served as `GET` and emitting nothing. Every input is a declared `filterable` column of the same type. A check narrowed to a parent scopes the page through the link to that parent: the `<parent>_id` column, named by an `idFrom` of `<parent>Id`.
  - `update` is a `PATCH` narrowed to the row, with `concurrency` over it, emitting about it and answering with its `fields`. Absent fields are left alone and `null` clears.
  - `delete` is a `DELETE` narrowed to the row, emitting about it and answering `{ id, deleted }`, on an entity that no other entity declares as parent.

  What changes:

  - `@substrat-run/contracts` adds `derive` and `authored` to an operation declaration. They are mutually exclusive, in the type and at load. It exports `derivationOf(declaration, entities)`, which says what shape an operation could be derived as, and the `DerivedKind` type. `defineOperations` also refuses a `derive` that does not match its shape (naming the clause that fails), a blank `authored`, and an `authored` on an operation nothing could derive. `emitModel(entities, { operations })` renders a `handlers` map into `model.json`, so a handler changing hands, or an exception and its reason, shows in the reviewed diff.
  - `@substrat-run/kernel`: `operationsFor` leaves derived operations out of the handler map it requires, and handing one a handler is a compile error. A handler that arrives for one through a cast is refused at load. A derived handler checks the declared key first, reads and writes only the entity's declared columns through `ctx.sql`, answers `not_found` for a missing row, and emits the declared event once per write. An update that sends no fields writes nothing and emits nothing.
  - `@substrat-run/contract-tests` exports `derivedHandlersContractSuite`. Both adapters run it.
  - The engines declare no derivable operation, so they are unchanged apart from passing their operations to `emitModel`. The `create-substrat` template's `AGENTS.md` documents the rule.

  A later release that learns a new derivable shape (`create` is next) will refuse operations that pass today. That is deliberate: each one gets the same choice.

- 7eb1b3c: **Breaking:** the kernel no longer exports the live-socket close codes or the socket cap (part of #1978).

  - `LIVE_CLOSE` is now defined in `@substrat-run/contracts`, and in its zero-import `./wire-headers` subpath beside `LIVE_MODE_HEADER` and `LiveRefusal`. A browser bundle can import the close codes without the rest of the package. The kernel no longer exports it; import it from `@substrat-run/contracts` instead.
  - `LIVE_SOCKETS_PER_PRINCIPAL` is the hosted adapter's own limit, and now lives in `@substrat-run/adapter-cloudflare`. The kernel no longer exports it. The limit is unchanged: 8 sockets per principal per scope.
  - ticket0's desk app reads the close code from `@substrat-run/contracts/wire-headers` instead of keeping its own copy of `4429`.

- 7eb1b3c: **Breaking:** the kernel's index no longer exports 133 values that nothing outside the kernel imported (part of #1978). They are internal plumbing, such as SQL fragments, batch sizes, budgets and decode helpers, and each one was published surface the additive-only rule had to freeze. Nine of them were dead code and are deleted: `isAttachmentTextRun`, `attributedHost`, `delegatedGrantSql`, `isListIndexName`, `listPlansByEntityType`, `splitCursor`, `searchPlansByEntityType`, `exportsOf` and `peerSwitchedOff`.

  - `ulidFloor` and `ulidCeiling` are still exported from `@substrat-run/kernel/ulid`.
  - `refusedTransitionOf` is still exported from `@substrat-run/contracts`, where it is defined.
  - The kernel's index is now pinned by a test: adding or removing a value export means updating a checked-in list in the same change.
  - The rest stay in their modules and leave only the index: `applyTableChange`, `assertAttachmentTextBounds`, `assertDirectoryTablesBuilt`, `assertEntityStateColumns`, `assertNoJournalSql`, `assertNoReservedColumnWrite`, `assertNoSpineReference`, `assertNoSpineWrite`, `assertNoStatefulDdl`, `assertQueueSafe`, `assertTablesOwned`, `assertWithinErasureReach`, `assertWithinSqlLimits`, `asyncInvocationLine`, `asyncLevelOf`, `AUDITED_OPERATIONS_BATCH`, `backfillOwnershipFromJournal`, `CANCELLED_INTENT_NOTE`, `CAPABILITY_COLUMNS`, `capabilityExchangeable`, `capabilityGrantOf`, `capabilityListQuery`, `capabilityLive`, `capabilityRecordOf`, `carriesSecret`, `changesSchema`, `combineCoverage`, `CONNECTOR_CALL_ERROR_TYPES`, `connectorCallErrorType`, `copyRestoreFenceMarginMs`, `DENIAL_COLUMNS`, `drainedEventOf`, `dumpCarriesSwitches`, `ENTITY_STATE_MOVES_TABLE`, `entityStatePlans`, `entityStateTriggerDdl`, `entityStateWhere`, `EXPORT_BREAK_REFUSAL`, `GRANT_READ_MAX_LIMIT`, `GRANT_READ_WORK_BUDGET`, `holdingsDigest`, `idempotencySubject`, `inputBoundRefusal`, `intentIdOfFailureMessage`, `isPositiveIntegerBound`, `isUnknownRoleError`, `JOB_ADMISSION_BACKOFF_BASE_MS`, `JOB_ADMISSION_BACKOFF_MAX_MS`, `JOB_DRIVE_LIMIT`, `JOB_DRIVE_SCAN_MAX`, `JOB_LEASE_ENTRY_MARGIN`, `JOB_RUN_LIST_LIMIT`, `JOB_RUN_LIST_MAX`, `JOB_RUN_REDACTION_SQL`, `JOB_STEP_REDACTION_SQL`, `JOB_STEP_REUSED`, `joinedMembershipExpiry`, `KERNEL_ACTOR`, `kernelOutboxInsertSql`, `lifecycleAfterLoad`, `LIST_INDEX_PREFIX`, `listIndexColumns`, `listIndexDdl`, `liveOrgMembership`, `mapDenialBucketRow`, `mapDenialOperationBucketRow`, `MARK_COPY_ORIGIN_SQL`, `mediaTypeOf`, `memberRemoveRequestedPayload`, `MIGRATION_DIGEST_LEGACY`, `MIGRATION_FLAG_THRESHOLD`, `migrationFleet`, `migrationSummary`, `MIN_SEARCH_TERM`, `mintCapabilitySessionToken`, `MODULE_LOG_LIMITS`, `moduleLogLine`, `moduleTableNames`, `normalizeExtractedText`, `OPERATION_SERIES_ID_SLACK_MS`, `PEER_SUBJECT_PREFIX`, `persistedText`, `PROVISION_RECONCILE_REPORTED_IDS`, `purgeCandidates`, `purgeCutoffOf`, `purgeIndexDdl`, `readCapabilities`, `REDACTED_INTENT_NOTE`, `redactedIntentPayload`, `REFUSAL_COLUMNS`, `REFUSAL_JOURNAL_PREFIX`, `REFUSALS_DDL`, `refusedTransitionOf`, `renderTemplate`, `reportKeyOf`, `rowDecoder`, `SCHEDULE_STATE_KIND_OF_OP`, `SCOPE_LIFECYCLE_KEY`, `scopeMigrationState`, `SEARCH_INDEX_PREFIX`, `searchIndexDdl`, `spineRowsInsert`, `stateColumnsOf`, `storedActor`, `subjectSwitchedOff`, `switchSubjectGrants`, `SYSTEM_SWITCH_OFF_PREDICATE`, `SYSTEM_SWITCH_OFF_RELATION`, `SYSTEM_SWITCHES_TABLE`, `TABLE_OWNERS`, `tableChangesOf`, `tablesCreatedBy`, `tableStatements`, `TELEMETRY_PRUNE_BATCH`, `TRASH_SCAN_BUDGET`, `truncateUtf8`, `ulidCeiling`, `ulidFloor`, `UNDECODED_ACTOR`, `UNDECODED_PERMISSION`, `UNDECODED_REQUESTER`, `UNDRAINED_SCAN_FACTOR`, `UNDRAINED_SKIPPED_IDS`, `WRITE_LIFECYCLE_SQL`.

- e55e06c: **Breaking:** a module registration's handlers are bound to its declared operations by a type (#1835). Migrate in two lines:

  - Replace `operationInputs: operationInputsOf(ops), operations: { … } satisfies OperationImpl<typeof ops, OperationContext>` (and any `operationConcurrency` / `operationIdempotencyOptOuts` line) with `...operationsFor(ops)({ … })`, imported from `@substrat-run/kernel`.
  - A module with no declared operations wraps its map as `...undeclaredOperations('why it has none', { … })`. Code that reads a registration's handlers reads `registration.operations?.handlers`.

  What changes:

  - `ModuleRegistration.operations` is now a `BoundOperations`, one value holding the `handlers` and the three maps derived from their declaration: `inputs`, `concurrency` and `idempotencyOptOuts`. The `operationInputs`, `operationConcurrency` and `operationIdempotencyOptOuts` fields are gone, so a registration can neither forget a map nor pair its handlers with another declaration's. Only `operationsFor` and `undeclaredOperations` produce the value. It is a class with an ES-private brand, so a hand-written `operations: { … }`, a spread of a bound value or a copy with one map swapped does not compile. Both adapters also refuse such a value at registration (`assertBoundOperations`). Apart from that new refusal, what the host parses, compares and refuses is unchanged.
  - `operationsFor(ops)(handlers)` holds the handlers exactly to the declaration. A missing, extra or mistyped handler is a compile error at that entry, and so is one whose type was erased: cast `as never` or `as any`, or typed with `any` parameters or an `any` return. From the same declaration it returns the input schemas the host parses with, the `If-Match` concurrency map and the idempotency opt-outs.
  - `@substrat-run/boundary-lint` adds **R11**, for the casts no type can see. It refuses:

    - an `as` or `<T>` on the whole map, at an `operations:` key, the shorthand `operations`, a binder's handler argument, or the initializer of the local name handed over there;
    - a cast on any entry of the handlers a binder is given;
    - a cast to `BoundOperations` or `ModuleRegistration['operations']` anywhere in module code.

    A deliberate cast goes in a `boundary-lint-allow R11` … `boundary-lint-end R11` block. **R2** also refuses module code importing a test seam: `@substrat-run/kernel/testing`, `@substrat-run/contract-tests` or `@substrat-run/engine-test-kit`.

  - `@substrat-run/contract-tests` exports `testOperations(handlers, derived?)`. With handlers only, it is the `undeclaredOperations` shorthand its fixtures use. With `derived`, it is the test seam the refusal suites use to hand the host maps that no binder made, built through the kernel's new `@substrat-run/kernel/testing` subpath.
  - The engines and the `create-substrat` template now bind through `operationsFor`. Their behaviour is unchanged.

- dfb653b: An operator can revoke a capability on a hosted scope (part of #1686). Before this, the platform's `revokeCapability` refused every scope served by a vertical's own deployment, so a leaked link share could be seen in the console but not stopped.

  - `HostAdmin.revokeCapability` on the shared control plane now reaches the deployment that serves the scope, through a new `capabilityDelegation` option on `CloudflareScopeHost`. The admin log row stays on the control plane, and the record names the operator as its revoker. With no delegation configured, a hosted scope is still refused `unavailable`.
  - `HostAdmin.revokeCapability` is audited intent-then-outcome on both adapters, as the kill switches are (kernel `auditedCapabilityRevoke`; `revokeCapability` joins `AUDITED_CHANGE_ACTIONS`). An intent row lands before anything is revoked. Then the outcome is one of:

    - `applied`, with the record as it stood;
    - `refused`, when the scope holds no such capability, or the deployment refused or predates the route;
    - nothing yet, when the answer was lost or named another capability. The scheduled settle then closes the intent as `unknown`.

    So a revoke that landed is never missing from the admin log.

  - `provesNothingChanged` now lives in `@substrat-run/contracts`. `@substrat-run/control-plane-client` re-exports it unchanged.
  - `mountPlatformSurface` mounts `POST /internal/capabilities/revoke`, behind the platform secret like the rest of `/internal/*`. It answers `{ before }`: the record as it stood, or `null` when the scope holds no such capability. That answer is never a 404, because a 404 is how a deployment built before this route says so. `VerticalScopeHost` gains `revokeCapabilityLocal`.
  - **Breaking:** `CloudflareScopeHost.revokeCapabilityLocal` now returns the record as it stood (`CapabilityRecord | null`) instead of a boolean. A check against `null` still works. A check of `=== true` does not.
  - `VerticalClient.revokeCapability` makes the call. A deployment built before the route answers 501 "redeploy the vertical", and nothing is revoked. An answer lost in transit is a 502 that says to read the capabilities before retrying.
  - The control-plane API gains `POST /tenants/:t/scopes/:s/capabilities/:id/revoke`, staff only like the capability read, with `revokeCapability` on the staff client. It answers 204, and again for a capability already revoked. It answers 404 for a capability the scope does not hold.
  - `contracts` gains `capabilityRevokeRequest` and `capabilityRevokeAnswer`.
  - The console's Capabilities card has a Revoke button, with a confirm, on every capability still acting: live ones, and used-up ones whose sessions keep acting until they expire.

## 0.1.21

### Patch Changes

- c78098a: **Breaking:** the kernel no longer exports the host-side code it deprecated in 0.136.0 (part of #1978). The code now lives in its new homes. If you still import one of these names from `@substrat-run/kernel`, import it from the package below; it is the same function.

  - **`@substrat-run/vertical-host`**: `invocationLog`, `withInvocationLog`, `invocationStampOf`, `fieldCoverageArmed`, `INVOCATION_RECORD_KEY`, `readRoutedNode`, `RouterAssertionError`, `kickFlags`, `assertPlatformCall`, `PlatformCallError`, and the types `InvocationLogContext`, `InvocationRecord`, `InvocationStamp`, `ModuleWorker`, `IncomingRequest`, `RoutedNode`, `HeaderReader` and `ReadRoutedNodeOptions`.
  - **`@substrat-run/adapter-cloudflare`**: `analyticsEngineConnectorCallRecorder`, `CONNECTOR_CALL_DATA_POINT_LAYOUT`, `connectorCallDataPoint` and `AnalyticsEngineDatasetLike`.
  - **`@substrat-run/control-plane-api`**: `isTerminalDispatchFailure`, `isTerminalProviderError`, `providerErrorStatus` and `RETRYABLE_CLIENT_STATUSES`.
  - **`@substrat-run/contracts/wire-auth`**, a new subpath: `assertPlatformCall` and `PlatformCallError`, defined here now because the control plane and the social relay check platform calls too. `@substrat-run/vertical-host` re-exports both, so a vertical's import is unchanged. The subpath also exports `secretMatches`, the constant-time compare behind both platform-call and router-assertion checks. It now compares in time independent of the presented value, with the same results as before.
  - **`@substrat-run/contracts`**: `invocationLevelOf`, `InvocationLevel`, `LIVE_MODE_HEADER`, `LiveRefusal`, `PLATFORM_SECRET_HEADER`, `PLATFORM_REQUEST_HEADER`, `EXPORTED_EVENTS_HEADER` and `CONNECTOR_ATTACHMENT_RECORD_HEADER`.

  Two deprecations are withdrawn, and these names stay in the kernel:

  - **The invocation line's shape** (`InvocationLogLine`, `OutputFieldsReport`) stays, beside `invocationLine`, because the scope host writes the consumer and schedule lines with it. `@substrat-run/vertical-host` still re-exports both types. The kernel also gains two subpaths that import nothing at run time, for code bundled in front of every vertical: `@substrat-run/kernel/invocation-line` and `@substrat-run/kernel/ulid`.
  - **`isUpgradeRequest`** stays beside the `LiveReadSurface` contract, because the hosted adapter's live-read door uses it too. `@substrat-run/vertical-host` still re-exports it.

  Nothing a deployed vertical sends, reads or logs changes. The entry module the platform uploads in front of every vertical is now built from `@substrat-run/vertical-host`, and its code is the same.

## 0.1.20

### Patch Changes

- f46de4a: The Callout demo vertical is removed. The dashboard catalog no longer offers Callout:
  its builtin row is retired the way Meridian's and Manyfold's were — installs are blocked
  and it is unlisted, while any existing app keeps serving. Locally, `pnpm dev` now runs
  the standalone control plane and the console; `pnpm dev:connected` and
  `pnpm callout-demo` are gone. The docs no longer describe Callout as a demo; its original
  concept and test-run spec are kept as historical RFCs.

## 0.1.19

### Patch Changes

- 3ed9e9d: Host-side exports start moving out of the kernel (part of #1978). Every existing import keeps working: the kernel still exports each one for this release, as the same binding, and marks it `@deprecated` with its new home.

  - **Header names** move to `@substrat-run/contracts`: `PLATFORM_SECRET_HEADER`, `PLATFORM_REQUEST_HEADER`, `EXPORTED_EVENTS_HEADER`, `CONNECTOR_ATTACHMENT_RECORD_HEADER`, `LIVE_MODE_HEADER` and the `LiveRefusal` type. They are importable from the package root and from a new `@substrat-run/contracts/wire-headers` subpath, which imports nothing.
  - **`@substrat-run/vertical-host`** now exports `invocationLog`, `withInvocationLog`, `invocationStampOf`, `INVOCATION_RECORD_KEY`, `readRoutedNode`, `RouterAssertionError`, `assertPlatformCall`, `PlatformCallError`, `kickFlags`, `isUpgradeRequest` and their types. Import them from there.
  - **`@substrat-run/adapter-cloudflare`** now exports the Analytics Engine connector-call recorder: `analyticsEngineConnectorCallRecorder`, `CONNECTOR_CALL_DATA_POINT_LAYOUT`, `connectorCallDataPoint` and `AnalyticsEngineDatasetLike`. The neutral recorder interface stays in the kernel.
  - **`@substrat-run/control-plane-api`** now exports `isTerminalDispatchFailure`, `isTerminalProviderError`, `providerErrorStatus` and `RETRYABLE_CLIENT_STATUSES`.
  - `invocationLevelOf` and `InvocationLevel` were already defined in `@substrat-run/contracts`. The kernel's copies of those exports are deprecated in favour of contracts.

  The scaffold template and the demos now import from the new homes. Nothing a deployed vertical sends, reads or logs changes.

## 0.1.18

### Patch Changes

- b9e7ac5: The SQL console and the table browse now say that they read the app's data as stored, including personal data, and that every query is recorded in the access log. The dashboard docs state the same, with the Events explorer's two known limits.

## 0.1.17

### Patch Changes

- a40eeec: The book on substrat.net has a second edition, with thirteen chapters. Three are new.
  **Seeing what happened** covers the four observability instruments: sampled router traffic,
  tenant-stamped invocation logs, opt-in traces, and the event spine read through record history,
  _Why?_, _What did it do?_ and _Same call_. It also says which question each one can answer.
  **The audit trail and the lake** separates the outbox, the denial log, the admin log and the
  access log, then follows events out of their scope into an Iceberg table in R2 that R2 SQL can
  query. It is plain about what is not built there yet: a query gateway, tenant scoping, and
  erasure. **Metering and billing** keeps apart a vertical billing its own customers with the
  metering and invoicing engines and the platform metering a tenant, and it says that storage is
  not counted yet.

  The existing chapters answer questions readers of the first edition asked. Chapter 1 now has a
  glossary (module, the spine, executor, connector, platform intent). Chapter 4 explains why plain
  SQL with no query builder is safe enough and where it is not, why timestamps are fixed-width
  text, and what a slow `await` holds: its own scope, never another. Chapter 5 explains the kick
  that runs a platform intent in seconds instead of at the fifteen-minute sweep, and what a
  vertical has to wire for it. The chapters also catch up with what has shipped since the first
  edition: the MCP surface, invocation ids on events, the lake drain phase, the dashboard's four
  tabs, and todo and ticket0 as the reference verticals. `/book.epub`, `/book.txt` and
  `/book/read.html` carry all of it.

## 0.1.16

### Patch Changes

- a5d8138: The book's diagrams are now in the EPUB. Five chapters draw a figure — the three-layer
  stack, the tenancy tree, the adapter-neutral topology, a permission's route to
  `ctx.check`, and the line an agent writes above — and `/book.epub` used to replace each
  one with a paragraph describing it. That is the right answer for a machine reading
  `llms.txt` and the wrong one for a person holding a phone, where the shape is supposed to
  arrive before the sentence.

  They are the same figures the web page draws, not redrawings of them: the components are
  rendered from source when the site builds, so a diagram cannot say one thing on
  substrat.net and another in Apple Books. `/book.txt` still carries the prose, because a
  file meant for `pandoc` and for models wants words.

## 0.1.15

### Patch Changes

- 99b974c: substrat.net now has a **book** — ten chapters meant to be read in order, front to back,
  rather than arrived at with a question. The rest of the site is a reference, and a
  reference never says how the pieces join: which thing calls which, what happens between a
  request landing and a row being written, who retries what when it fails.

  The chapters that carry genuinely new material are the ones the reference had no home for.
  **The path of one request** walks every hop from hostname to SQL and back — the router's
  trust boundary, dispatch, the lifecycle gates, lazy migration on wake, the per-scope queue,
  the transaction. **The life of one event** follows `ctx.emit` into the outbox, through the
  post-commit dispatch loop, to a consumer's own transaction — including that an in-scope
  consumer **does not retry**, where an executor does, with backoff and a dead letter. **The
  two clocks** finally puts the platform sweeper and the vertical's own scope sweeper side by
  side, names every phase of the fleet pass in order, and says plainly that nothing reaps an
  archived scope's storage unless a retention window has been configured, because Cloudflare
  never garbage-collects a Durable Object.

  It is also published in one file, three ways. `/book.epub` is a real EPUB 3 with a cover
  and a table of contents, so it opens in Apple Books on a phone and remembers where you got
  to; `/book.txt` is plain markdown for printing, `pandoc`, or handing to a model in one shot;
  `/book/read.html` is a single scrolling, printable page. All three are generated from the
  chapters at build time from the same list the nav reads, so none can fall behind the others.

- 9ddda35: The EPUB edition of the book now opens. `/book.epub` shipped with ten invalid identifiers
  in its package document — a manifest id may not begin with a digit, and ten of the eleven
  chapters are numbered — so the file failed to parse and Apple Books declined it without
  saying why. It is now clean against the EPUB 3.3 rules, and the contents page no longer
  prints every chapter number twice.
- a4ee4ca: The link to the book's printable edition works again. `/book/read.html` is written after
  VitePress has finished building, so the site's client-side router has no route for it —
  and it intercepts `.html` links rather than letting the browser fetch them, so clicking
  the link on the book's front page rendered a 404 without a request ever leaving the
  browser. Pasting the URL always worked, which is why the page itself was never at fault.

## 0.1.14

### Patch Changes

- 8d9c72b: The ticket0 support widget is on every page of substrat.net, not only `/guide/support`. The site-wide `<head>` embed is on by default and aimed at the hosted desk; `TICKET0_API` points a local build at a local desk and `TICKET0_WIDGET=0` builds without one. The per-page `<Ticket0Widget>` component is gone — it would have doubled the bubble and, on leaving the support page, unmounted the site-wide one.

## 0.1.13

### Patch Changes

- f5846ce: The landing page leads with what you can build, not with the five things Substrat fixes

  The old page opened by naming multi-tenancy, identity, permissions, audit and GDPR as
  the parts that were missing — which sells a patch for a gap rather than a way to build
  the whole application, and left the strongest evidence off the page entirely. Eight demo
  verticals exist across eight unrelated domains, and three of them run their core domain
  on the kernel alone; that set was represented by three cards near the bottom.

  So the page now opens on the claim and spends the rest of itself earning it: the eight
  demos first, with the kernel-only ones marked, then a new section inventorying the
  twenty-three things that arrive with a project — the API and its client, identity and the
  audit record, snapshots and per-PR production forks, hosting and domains — then the
  single-operation code sample, the three layers, and only then the runtime guarantees,
  which are proof rather than premise. The engine section is reframed to match: seven
  engines you don't have to write, with the star topology drawn rather than asserted.

  Two removals. The fifteen-row package table is gone — it was a reference artifact on a
  marketing page, and its seven consecutive `seed` badges said something the engines page
  takes a paragraph to say properly. The "honest half" is reduced to a link row, because
  `/guide/what-substrat-lacks` already does that job with the shipped / built-unproven /
  bet labelling the summary flattened away.

  Layer colour now runs the whole page — amber for verticals, cyan for engines, indigo for
  the kernel — instead of appearing as three hairlines and three dots.

## 0.1.12

### Patch Changes

- 04ebaff: The docs CSP names the desk a page mounts the support widget on, so the widget on
  `/guide/support` loads again. The site-wide embed is a `<script>` in the built HTML,
  which the policy was derived from; the per-page `<Ticket0Widget>` appends its script
  from JavaScript after mount, so nothing about `ticket0.substrat.net` reached the build
  and the browser blocked it on production only. The desks are now read out of the
  markdown, and the origin guard covers them too.

## 0.1.11

### Patch Changes

- e1920ec: The docs site ships a Content Security Policy, and a build that refuses to outgrow it

  `vitepress build` now writes `_headers` into the built site, so Cloudflare Pages serves
  substrat.net with a CSP plus `X-Frame-Options`, `Permissions-Policy` and HSTS. Nothing was
  framing or injecting into a static docs site with no cookies and no user input, so this is
  defence in depth rather than a closed hole — `frame-ancestors` is the one directive that
  covers something previously unguarded, and the policy is what will bound the ticket0
  support widget on the day it goes live.

  The script hashes are read back out of the HTML each build just wrote, because VitePress
  inlines three scripts per page and one of them embeds a content hash of every page — a
  checked-in hash list would be stale the first time anyone edited a page, and stale in the
  worst way, since the page still renders but unstyled and stuck in light mode.

  The build also refuses to emit a policy the site already violates: add a font from Google
  or an analytics snippet and the build fails naming the origin and the directive, instead of
  going green and dropping that resource in the browser, on production only.

## 0.1.10

### Patch Changes

- c2d5c2a: The ticket0 support widget on one docs page. `widget.js` now keeps one widget per page and exposes `window.ticket0.unmount()` for a host with a client-side router; the docs site mounts it at `/guide/support` through a `Ticket0Widget` theme component that tears it down on navigation.

## 0.1.9

### Patch Changes

- 2003d6e: The enforcement story gets its own page, and the AI-agents page gets its subject back

  `guide/ai-agents.md` had grown two arguments inside one page: what makes the platform
  _legible_ to a coding agent, and what happens when that agent gets it wrong. The second one
  was the more load-bearing of the two and the harder to find — a reader asking "what stops a
  mistake" had to assemble the answer from five non-adjacent sections, plus the layer rules in
  `reference/boundary-lint.md` and the honest caveats in `guide/what-substrat-lacks.md`.

  **New: `guide/ai-guardrails.md` — Where AI mistakes stop.** The six guards a change passes
  through, ordered as the sequence they actually fire in (compile → bound → derive → judge →
  review → rehearse) rather than as a list of virtues, so the claim the page makes — that a
  mistake surviving one guard meets the next — is carried by the structure and not just
  asserted. It expands the five that need more than a paragraph: the R1–R6 layer rules and the
  load-bearing exit code `2`, the three marks a generated file carries, the
  code-from-model/tests-from-concept oracle, the two human checkpoints, and the preview fork.
  It closes on what none of it claims, including the Durable-Object hole in the egress
  allowlist.

  **`guide/ai-agents.md` keeps the other half** — bring-your-own-model, the markdown docs
  slice and `llms.txt`, the session-start hook, self-describing manifests, the local loop —
  and hands off. Retained prose is unchanged; nothing is stated twice across the two pages.

  **Two new figures, on the existing twin machinery.** `<BlastRadius />` draws the line with
  what sits either side of it, and `<GuardPath />` draws the six stages. Both keep every string
  in a sibling `.content.mts` and register an `alt()`, so they reach `llms.txt` as markdown
  rather than as a pointer. `BlastRadius` imports `theLine` from `LayerStack.content.mts`
  instead of restating the thesis — the cosmetic/catastrophic split is already the spine of the
  three-layer diagram, and a second copy is exactly the drift the rest of the repo lints for.

## 0.1.8

### Patch Changes

- ffe59cc: The five pages that most needed a picture get one, and the engine state machines get drawn from the code.

  Five diagrams, all on the twin machinery from the previous change, so every one of them reaches
  `llms.txt` as markdown rather than as a pointer.

  **The engine state machines are now emitted, not redrawn.** Five engine pages each drew their
  machine in ASCII by hand, and two of the five had already drifted from the engine: booking's
  picture showed neither `cancel` nor `no-show`, and protocol's omitted `voided` entirely. One
  `<StateMachine engine="…" />` now derives the layout — a spine from the initial state, with
  branches falling off it — from the machine itself. For `workorder`, `booking` and `invoicing`
  that machine is read straight out of the emitted `model.json` that `lint:model --check` already
  gates, so those three cannot drift again. `absence`, `protocol` and `invites` declare no
  lifecycle yet, so theirs is transcribed in the same shape and **the page says so under the
  figure**; when those engines adopt `defineLifecycles`, the entry swaps to `fromModel` and the
  note goes away.

  Four more, each replacing prose or a chart that was fighting its own layout:

  - **`/concepts/permissions`** — the six-node mermaid `flowchart TD` becomes `<PermissionPipeline />`.
    Every node was a three-line paragraph, and dagre sizes boxes from label length, so a straight
    pipeline rendered as ragged blocks. The `lint:permissions` fork is now drawn as what it is — a
    review branch ending in a person, not a peer of `push`.
  - **`/concepts/tenancy`** — `<TenancyTree />`. Tenancy is a tree and "one scope = one database" is
    a containment claim; both are shapes prose had to walk you through.
  - **`/concepts/reads`** — `<ReadPaths />` draws the three paths as increasing distance from the
    scope boundary, because that distance _is_ the staleness. Three peer boxes would have restated
    the table above it.
  - **`/guide/environments-and-previews`** — `<InstanceResolution />`. The page's whole argument is
    that an instance is `(scope × version)` and exactly one link is mutable, so the binding is the
    only thing drawn in the accent.

  `toTwin` and the `lint:llms --check` component assertion now match components with props, since
  one component serving five pages is one component and five props.

## 0.1.7

### Patch Changes

- 8a2da00: The diagrams reach llms.txt, and three of them get redrawn.

  A theme component was flattened to `*(Diagram: LayerStack — rendered at the HTML page for
this document.)*` on the grounds that a diagram cannot be flattened honestly. True of a
  drawing, and false of ours: `LayerStack` and `RuntimeTopology` render ordinary prose out of
  ordinary arrays, so what the pointer dropped was content that already existed — and dropped
  it from the one surface agents read.

  Each component's content now lives in a sibling `*.content.mts` that exports both the data
  the component renders and an `alt()` that renders the markdown twin **from that same data**.
  Add an engine to `engines.chips` and it appears in `llms.txt`; there is no second list to
  update and no way for the picture and its text to disagree. `toTwin` calls `altFor`, and the
  pointer survives only as the fallback for a component with genuinely nothing to flatten.

  `lint:llms --check` gains a fourth assertion: a page rendering a component with no registered
  `alt()` fails, naming the file to create. Without it the failure is invisible — the page looks
  right and everything the diagram says is missing from the twin.

  Three drawings change, all in one vocabulary of hand-authored SVG on the existing `--layer-*`
  tokens, so they read the same and flip with the theme:

  - **`/guide/architecture` §Topology** — the mermaid `flowchart TB` becomes `<ScopeTopology />`.
    Mermaid sized boxes from label length and routed edges with dagre, so the fan-out the picture
    exists to show came out looking accidental.
  - **`/guide/architecture` §The hosted runtime** — an SVG now leads the six numbered steps,
    which stay. It draws the one thing a numbered list cannot: the request coming _back_. Step 6
    said the response travels up; now you can see it, and see which layer's code executes in each
    box along the way.
  - **`/connectors/` §The seam** — the ASCII block becomes `<ConnectorLoop />`, which draws the
    round trip it could only describe: the scope delegating a delivery out to the worker because
    it has no `fetch` of its own, and the result re-entering through `getConnectorScope`.

  Both figures are drawn at 700 units, not the 920 they were designed at — the docs content
  column is roughly 665px, and anything wider is either clipped or scaled until the labels are
  unreadable.

## 0.1.6

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

## 0.1.5

### Patch Changes

- 5e0a3af: The API conventions get a page, and the error model gets an RFC.

  Substrat is opinionated about API shape, and until now that opinion was distributed across
  `CLAUDE.md`, six architecture documents, and the header comments of the files that
  implement it. A builder asking "how should my list endpoint look" had nowhere to be sent.

  `/concepts/api-design` is that page. Nine defaults — the operation spine, boundary parsing,
  value types, keyset pagination, the error model, the context clock, request idempotency,
  additive evolution, and the generated OpenAPI document — each with the shape, the reason,
  and an honest status. Three of the nine are designed and unbuilt, and say so with the issue
  number rather than reading as though they work.

  Writing it turned up one claim in our own docs that was not true. `boundary-lint` does
  **not** check that an operation calls the permission it declares; its rules are star
  topology, raw data access, network, spine writes, and the extraction escape hatch. What is
  actually enforced is narrower: the _declaration_ is a compile error to omit
  (`permission` or `narrows` with a reason, never both and never neither), and the permission
  _surface_ is re-emitted by CI so a widened role appears in the diff. The handler's
  `assertAllowed` first line is convention plus review. The page says that, because a docs
  site that overstates its own mechanisms is worse than one that admits the gap.

  Companion RFC in `docs/rfc/error-model.md` (issue #113): RFC 9457 problem+json, a closed
  ten-code taxonomy with module-owned `reason` slugs, and a four-phase rollout that keeps
  `detail` byte-identical to today's messages — which is what stops the change turning the
  contract suite's thirty message assertions red. It also names the part that is genuinely
  awkward: errors crossing the ScopeDO RPC boundary are rebuilt as plain `Error`s by our own
  adapter code, which is why `instanceof PermissionDenied` is false in production today.

## 0.1.4

### Patch Changes

- 3ddbbe1: feat(console,docs): make the directory backup observable (#40)

  The mechanism landed with no way to ask whether it is working, and a backup nobody has
  looked at is a belief rather than a guarantee — a cron cannot raise an alarm about its own
  absence.

  **Console → Settings → Recovery.** Freshness of the newest copy (Current / Late / Stale
  against the daily cadence), how many are held, total size, the copies themselves, and a
  **Back up now** button for the pre-migration checkpoint. An unbound store renders as the
  alarm it is — _this control plane keeps no copy of its own directory_ — which is why the
  route answers 501 rather than an empty list: "nothing held" and "nobody is looking" must
  not read alike. An overdue copy points at the sweep rather than the backup, and says so,
  because the cadence guard catches a missed tick up on the very next pass.

  Deliberately **no Restore button.** Replacing the directory has a blast radius of every
  tenant at once — past what a type-to-confirm dialog can carry — and the disaster it answers
  is one where the directory is _gone_, so a recovery path that assumes a working console is
  not there when it is needed. Restore stays a deliberate API call from the runbook, and the
  panel links to it rather than performing it.

  **Docs:** a _Backup and recovery_ section on the control-plane page — which failure each
  instrument covers (PITR for scope data, the reap copy for teardown, snapshots for a
  non-destructive copy, and the directory backup for the map itself), RPO/RTO, the rehearsed
  restore, and the honest limits (survives losing the directory, not the account; does not
  bring back the D1 staff roster, worker secrets, or sealing keys). `concepts/snapshots.md`
  already drew the "not backup/PITR" line, so it now points onward from exactly where a
  reader arrives with the question. Self-hosters get the note that matters most to them: on
  SQLite there is no PITR underneath, so this pair is not a second line of defence but the
  only one.

  The control-plane dev server binds an in-memory directory-backup store, so the Recovery tab
  is drivable locally.

## 0.1.3

### Patch Changes

- f9db289: `substrat push` resolves its workspace from the project, never the machine: `--tenant` →
  `SUBSTRAT_TENANT` → a `"substrat": { "tenant" }` pin in the vertical's `package.json`. The
  machine-wide login default is deliberately out of the chain — the first push of a slug
  **claims** `<workspace>/<slug>` for whatever workspace resolved (builder-plane.md §5), so a
  stale global default silently pointing at the wrong workspace would claim the vertical for
  the wrong owner.

  A first interactive push with no pin lists your workspaces (whoami), auto-selects a sole
  one, and offers to write the pin into `package.json` — repo-scoped, reviewable, shared with
  every teammate and CI — so the question is answered once per project, not once per push. A
  non-TTY push with no pin refuses with an actionable error instead of guessing. The push
  line now prints the full target (`pushing acme-co/crm@0.1.0 …`) so the claiming workspace
  is always visible; service-token pushes are unchanged (the platform actor has no
  workspace). `promote`/`scope pull` keep the login-default fallback — ownership is already
  checked server-side there.

  `resolveAuth` gains `useDefaultTenant: false` and a `kind: 'session' | 'service'` field;
  `readVerticalMeta` reads the new `substrat.tenant`; new `pinTenant(dir, tenant)` writes it
  back preserving the file's indentation. Docs: CLI reference gets the full command surface
  (`whoami`, `versions`, `publish`/`unpublish`, flagless `push` defaults table, first-push
  transcript) and the deploying guide explains the per-project pin.

## 0.1.2

### Patch Changes

- e6f6f6c: ci: auto-deploy the platform apps — a changeset release deploys them to prod
  (gated on `changesets.published`), and every green push to main deploys to a
  shared test env (gated on `TEST_ENV_READY` until the test resources exist).
  Adds `[env.test]` wrangler blocks + `cf:deploy:test` scripts and makes the
  migration preflight `--env`-aware.

## 0.1.1

### Patch Changes

- 6abbce9: **Standardize the deploy script name to `cf:deploy` across all deployable workspaces.** control-plane,
  router, and docs used `deploy`, which collides with pnpm's built-in `deploy` command (`pnpm deploy` →
  `ERR_PNPM_NOTHING_TO_DEPLOY`, needing `pnpm run deploy`). They now use `cf:deploy` — matching dashboard,
  the demos, and the external-vertical example — so `pnpm cf:deploy` just works. Docs references updated.

## 0.1.0

### Minor Changes

- bb7de09: **Docs: catch the site up to the self-serve-deploy era.** The site had drifted ~40 commits behind
  — the whole CLI / deploy / platform-app / scope-local-permissions arc was undocumented, and a
  handful of pages had gone stale against the code.

  New pages:

  - **Guide → Deploying a vertical** — the `substrat` CLI (`login`, `push`), the push-lands-pending /
    admission-gates-serving model, and the laptop → console → router path. Wired into getting-started
    and running-locally.
  - **A Platform section** — the four surfaces that run the verticals: the shared **control plane**,
    the operator **console**, the environment **router**, and the tenant-facing **dashboard**.
  - **Three missing vertical pages** — **Callout** (the canonical reference vertical, previously
    undocumented), **Handlebar**, and **Kallkälla/shop** — plus links from the verticals index.
  - **`@substrat-run/oidc-rp` reference** — the shared AuthHero relying party behind the platform
    apps.

  Rewrites for landed architecture:

  - **Scope-local permissions** — `concepts/permissions.md` and the `adapter-cloudflare` reference now
    describe projection-on-write and the control-plane-optional host mode, replacing the old
    per-request-control-plane-read model. The adapter Status section drops the router / scope-local
    claims it listed as unbuilt (both shipped).
  - **Auth** — `concepts/identity.md` records that the platform apps consolidated onto AuthHero OIDC
    while demos stay Better Auth.

  Corrections: Scrive is documented as **published `0.1.0`** (was "private, unpublished");
  `protocolContentHash`'s real signature (no `ctx`); the **invites** engine added to the engines
  overview; the booking state machine's true terminal transitions and two missing in-scope functions;
  `facility` / `number` added to two documented event payloads; the `what-is-substrat` status table
  refreshed with every engine, demo, connector, the CLI, and the platform surfaces.

## 0.0.2

### Patch Changes

- d212f5d: Docs: place Substrat against the tools people already know.

  - New guide page **How Substrat compares** — frames the market as a three-way choice
    (governance without code / code without governance / both in a walled garden) and
    positions Substrat as the missing fourth corner, then walks the neighbors one by one
    (templates, prompt-to-app, BaaS, low-code, Salesforce/ServiceNow, Odoo/Frappe, Medusa,
    assemble-it-yourself) and closes with when Substrat is the _wrong_ tool. Category-level
    and evergreen, not a feature scoreboard.
  - New **"What an engine is _not_"** section on the engines overview — contrasts an engine
    against the four pictures readers arrive with: an Odoo app, a Medusa v2 module (the real
    cousin), a Rails engine/plugin, and a microservice.
  - Wire the new guide page into the sidebar after "Why runtime enforcement?".
