# @substrat-run/control-plane-client

## 0.3.4

### Patch Changes

- @substrat-run/contracts@0.153.0

## 0.3.3

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0

## 0.3.2

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
  - @substrat-run/contracts@0.151.0

## 0.3.1

### Patch Changes

- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/contracts@0.150.0

## 0.3.0

### Minor Changes

- 9ae6644: The code that backs a scope store is now called its **driver** (K-53), where it was its kind. This is a clean break with no alias. No driver has been registered yet, so no push could declare a scope store and no store script was ever uploaded. Nothing deployed depends on the old names.

  - **Declaration:** `runtimeNeeds.scopeStores: [{ binding, driver }]`. A declaration that still spells `kind` is refused with `scopeStores[].kind was renamed driver`, by the manifest parser and so by `substrat push`. A scope dump's `stores[].driver` is the same: a dump store that still spells `kind` is refused with the rename named, and a dump with no stores loads unchanged.
  - **Contracts:** `storeKindId` → `storeDriverId`, `STORE_KINDS` → `STORE_DRIVERS`, `STORE_KIND_ID` → `STORE_DRIVER_ID`, `storeKindRegistration` → `storeDriverRegistration` (its field `kind` → `driver`), `StoreKindRelease*` → `StoreDriverRelease*`, `storeKindReleaseDigest` → `storeDriverReleaseDigest`. The admin actions are `uploadStoreDriverRelease`, `rollOutStoreDriver` and `rollBackStoreDriver`. The three old names stay readable as `HISTORIC_ADMIN_ACTIONS`, so an existing log still parses, and no host writes them.
  - **Kernel and adapters:** the `HostAdmin` methods are `recordStoreDriverRelease`, `getStoreDriverRelease`, `storeDriverState`, `storeDriverDeclarations`, `holdStoreDriver`, `releaseStoreDriverHold`, `beginStoreDriverRollout` and `finishStoreDriverRollout`, and each takes `driver`. `ScopeStoreRunner.kind` is `driver`, and the host option `scopeStores.kinds` is `scopeStores.drivers`. The directory tables are `store_driver_releases`, `store_driver_rollouts`, `store_driver_current` and `store_driver_holds`, keyed by `driver`, and `vertical_scope_stores.kind` is `driver`. A directory built before the rename is moved onto these names on its next start, rows kept. A directory that ran the older code again (a rollback) holds both names: the start drops the name that holds no rows, and the one holding rows ends under the new name. When both hold rows, both are left as they are, and the start logs a line naming the tables and the remedy: restore a directory dump taken before the older code ran again, or export the `store_kind_*` rows, carry over any still wanted, and drop the `store_kind_*` tables by hand. Until then a directory dump of it is refused at restore. A directory restore maps an older dump's names the same way, leaves out an empty duplicate, and refuses a dump in which both names hold rows.
  - **Control plane:** the routes are `/store-drivers/:driver`, `/store-drivers/:driver/releases`, `/store-drivers/:driver/rollouts` and `/store-drivers/:driver/rollback`. The builder client's methods are `getStoreDriver`, `uploadStoreDriverRelease`, `rollOutStoreDriver` and `rollBackStoreDriver`.
  - **CLI:** `substrat store-kind … --kind <kind>` is now `substrat store-driver … --driver <driver>`. The old command and the old flag each exit naming the new one.
  - **Release bundles:** a release bundle's package is `driver_<name>/` instead of `kind_<name>/`. The store entry's import placeholder is `__SUBSTRAT_STORE_DRIVER__`.

  What did not change: a store script is still `substrat-store-<driver>-<vertical>`, with the driver id in the same position and the same `[a-z0-9]+` grammar, and its canary script is still `substrat-store-<driver>--canary`. Release bytes are still stored under `<driver>/<sha256>`. Both strings keep the shape they had, because the driver id is the value the kind id was. `tenantStores: [{ binding, kind: 'relational' | 'blob' }]` is a different concept, and it keeps its `kind`.

### Patch Changes

- b190e40: A Microsoft 365 connection can read and write files in one Teams channel's folder of the tenant's SharePoint site (#2101).

  `@substrat-run/connector-microsoft365`: `bindMicrosoft365Scope` binds a scope to one folder, named by its drive path under the site's default document library and held by its item id from then on. A vertical writes by emitting `microsoft365.channel-files-requested` (`microsoft365FilesRequested`: a `directory` under the folder, up to 20 `files` by attachment id with each attachment's `size`, and a required `conflict` of `replace`, `rename` or `fail`). Files are at most 50 MB each and 100 MB per event, checked on the declared sizes before any byte is read (a declaration that is not the attachment's own size is refused once that attachment is read, since the platform hands over its bytes whole), and an attachment may be named once. The dispatch uploads the files one at a time, in one request up to 4 MB and by upload session above, and keeps a ledger keyed on the event id. A redelivery takes an existing file as its own only when this app wrote it and its size and QuickXorHash are the bytes being sent. A `rename` conflict uses a suffix derived from the event, never one Graph picks. `sweepMicrosoft365Files` follows the library's change feed a page at a time, saving where the next page starts after each landed page and stopping at a page budget per call (`SYNC_PAGES_PER_CALL`); a folder newly inside has its children read a page at a time under the same budget. A held item the feed does not account for (one a full pass never presents, or one a page shows somewhere it cannot place) is looked up in the drive on its own before anything lands for it, under its own budget (`SYNC_VERIFY_PER_CALL`). An item is deleted only on an answer about that item: its own deleted facet in the feed, or its own lookup finding nothing; never on a folder above it or a re-read's silence. A transient lookup error stops the pass with nothing deleted; a refusal that will not pass by itself (400, 403, an enclosing folder that cannot be read) keeps the item held, lets the pass finish, and is counted in `lastSync.unplaced`. It is asked again only on a later full pass or when the feed mentions it again, at most `MAX_UNPLACED_ATTEMPTS` times; after that it stays held as last seen, never deleted, until the scope is bound again, which clears the refusals and starts a full pass. A folder's own answer lands even while it still holds such items, which stay held. It lands each change in the folder through the binding's operation as the connection (`microsoft365ChannelChange`: `upsert`, `content` and `delete`), at least once and keyed by item id, with file contents uploaded as attachments on the entity the operation names. A path outside the folder is refused before Graph is called. Items outside the folder are never stored or logged. A deleted folder makes the binding refuse rather than fall back to the library root, and an unbind or re-bind during a pass is never written over. `registerMicrosoft365FilesConnector` and `declareMicrosoft365FilesConnector` register the dispatch on a host that runs it, or for routing only on one that does not.

  `@substrat-run/control-plane-api`: the connection bindings route takes a `folder` for a Microsoft 365 connection, and only for one. `@substrat-run/contracts`: the binding audit entry carries it. `@substrat-run/control-plane-client`: `ConnectionScopeBindingInput` gains an optional `folder`. `@substrat-run/cli`: `substrat connection bind` takes `--folder`.

- c7eb5fa: A promote acknowledgement now answers one review. The review a promote shows is computed against the version prod points at when it is read, and a promote by someone else in between used to leave the acknowledgement standing for a diff that was no longer the one applied. The migrations read (`/versions/:id/migrations?base=`) now answers a `review` binding beside the diff it shows: the base version and a digest of the stored rows the review was computed from (each side's id, permission and migration digests, and every stored migration with its declared moves and discards). A promote carries it as `acknowledge.review`, and the control plane recomputes the digest from its own rows and refuses, as `precondition_failed` with reason `promote_review_stale`, when prod no longer points at that base or the digest differs. The sent digest is only compared, never read as the diff. The channel pointer now moves by compare-and-set, in one transaction with its history row: of two promotes judged against the same base, one moves the channel and the other is refused as stale and records nothing, where both used to land.

  **Behaviour change:** a migration acknowledgement without a binding is refused when the migration digest moved (`precondition_failed`, reason `promote_review_unbound`), because it is the acknowledgement that lets a migration, and any data loss it declares, reach live data. An older `substrat promote --ack-migrations` is refused that way, and the refusal says to upgrade to a CLI release whose `substrat promote` supports `--review` (this one). A permission-only acknowledgement without one is still honoured, so an older client keeps promoting where no migration changes; a binding, when sent, covers the permission diff too.

  `substrat promote` prints a `--review <token>` with every refusal that prints the diffs, and takes it back with `--review`; a stale or unbound refusal prints the diffs as they stand now, with the new token. The dashboard's promote dialog sends the binding with every promote, and when prod moved it reads the review again and asks again from scratch, saying so, with nothing ticked carried over. The console's promote dialog binds its acknowledgement to the review it read and, refused as stale, reloads the channel and shows the new review. The refusal's header line in `substrat promote` now quotes a version id that is not a plain id, as the migration listing already did.

- 439efc1: A scope rebind's migration acknowledgement now answers one review, as a promote's does. `GET /tenants/:tenantId/scopes/:scopeId/rebind-review?vertical=<target>` returns what the rebind would apply: the target vertical's serving version over the version the scope is bound to, each migration with its SQL and declared moves and discards. Beside it is a `review` binding: the scope's bound version, and a digest of both sides' stored rows that is taken under its own tag, so a promote's binding is never accepted as a rebind's, or the reverse. `POST …/rebind-vertical` takes it as `acknowledge.review`. The control plane recomputes the digest from its own rows and refuses with `precondition_failed`, reason `rebind_review_stale`, when the scope is no longer bound to that version or a promote on either vertical has moved what the review showed. The read follows exactly the rebind's own visibility. It is one shared rule: a workspace credential needs to be able to read both verticals (its own, or a listed one), and everything else answers the same 404, for the read and for the rebind. The migration SQL itself is shown only to staff and to an owner of both verticals; anyone else gets `migrations: null` and `migrationsWithheld: true`, with the digests-differ fact and the binding, so a workspace can still acknowledge and rebind onto a listed vertical.

  A rebind now moves the scope's route and its version pointer in one write. That write is conditional on the scope still being bound to the judged version and on the target still serving the judged version, on both adapters (`bindScopeVersion` gains the additive options `servingRef` and `expectedServing`). Before, these were two writes, and a promote on the target landing between them left the route on the new script and the pointer on the old vertical. A promote that lands while the data is being copied now refuses the rebind as stale; the scope keeps serving from where it was, and both copies are kept.

  **Behaviour change:** an `ackMigrations` without a binding is refused when the two migration digests differ (`precondition_failed`, reason `rebind_review_unbound`). The refusal says to upgrade to a CLI release whose `substrat scope rebind` supports `--review`, which this one does. `substrat scope rebind` prints the migrations and a `--review <token>` with every digest, stale or unbound refusal, and takes it back with `--review`. The dashboard's and the console's Move dialogs now read the review before they ask and show the migrations. They send each install's binding, and when a version changes under them they read the review again and ask again from scratch.

- d6ba289: Scope stores: a key revocation or a store entry fix now reaches every store script without a push (#2309).

  - **Control plane:** what the platform builds every store script from (both key lists, the entry, its verifier and the compatibility flags) is one digest, `storePlatformFingerprint`. The scheduled pass rebuilds every existing store script whose build is older than it, at the release the script already runs, and never moves a script to another release or creates one. Each pass walks a bounded number of scripts (`STORE_REBUILD_SUBREQUESTS`, default 500 subrequests, 5 a script) from a per-driver cursor and resumes there on the next pass. It runs under the shared hold a push takes, so a rollout or rollback excludes it and a paused rollout keeps its scripts where they are. A script it could not rebuild is retried on every pass and recorded as an ops failure. A finished walk is walked again a day later. A walk that finished within an hour of new lists appearing is walked again after that hour and reads as `settling` until then, because a control plane still serving the older lists during a deploy can upload a script after the walk read it. The window is `STORE_REBUILD_SETTLE_MINUTES` (60 by default), and status prints when the lists were first walked towards and when the next automatic walk is. Only a walk that began after the window proves the fleet current. `substrat store-driver rebuild --deploy-finished` lets a person attest that no control-plane deploy is rolling out, so the walk that run starts proves it once done; the attestation is audited. A re-walk at lists already proved reads `current (re-verifying)` until a script fails. A vertical whose stores cannot be named is walked by its script's name, so it counts as a failure only if its script exists and cannot be rebuilt.
  - **API and CLI:** `GET /store-drivers/:driver` adds `rebuild`: whether every script is current, and the scripts that may not be. `POST /store-drivers/:driver/rebuild` runs a pass now, for a person only (as the other release writes), audited as `rebuildStoreDriver`. `substrat store-driver rebuild --driver <driver>` calls it, and `store-driver status` prints the rebuild's state.
  - **Kernel and adapters:** a `store_driver_rebuilds` directory table and three `HostAdmin` methods (`storeDriverRebuild`, `claimStoreDriverRebuild`, `advanceStoreDriverRebuild`), plus `recordStoreDriverRebuildRun` for the audit row. The row's lease keeps two passes from walking one driver at once. A new fingerprint restarts the walk.
  - **Runbook:** `secrets/store-keys.md` says how long the rebuild takes for a fleet size. It also says that an old key counts as revoked only once `store-driver status` reads `scripts: current`.

- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [439efc1]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/contracts@0.149.0

## 0.2.0

### Minor Changes

- a8b0842: Add a staff/service API and `substrat connection bind|bindings` for existing Planima and Fortnox connections. Verify the landing permission in the serving scope before binding, reject copy or mismatched-vertical targets, and audit binding changes. Read hosted connector permissions from the serving deployment rather than the control plane's placeholder scope. This door does not grant new authority or change sweep cadence.

### Patch Changes

- a9cbb6d: A scope-store kind's release is stored, canaried and rolled out by a person (#2300). `substrat store-kind upload` stores a kind's package under its sha256, before or after its pin lands; `rollout` canaries a pinned release on the platform's own object through every reserved operation, then moves every vertical that declared the kind, holding the kind against pushes while it does; `rollback` returns to the immediately previous good release. A failure returns the verticals already moved. Each pin now names the `schema` its release migrates to, and no move lowers it.
- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0

## 0.1.12

### Patch Changes

- 7a1ab65: An app that keeps no owner of record (no `resolveOwner` hook) now receives what each new version declares on its existing installs. Until now its reconcile answered 501, so an install provisioned before a version that adds a peer, a schedule or a connection grant never received it, and a peer's calls stayed refused.

  The platform's reconcile and `substrat scope provision` now ask for the ownerless reconcile (`ownerless: 'seat'`). The vertical seats only the tuples its running version declares: schedule grants, peer permissions, and the connection grants the platform delivers. It also re-applies the switches the platform recorded off. It changes nothing else. It writes no owner, leaves roles, entitlements, identity links and sealing keys as they are, and reconciles no entity-grant shapes. It answers `owner: null`. `substrat scope provision` then says the owner was not re-sourced, and that a locked-out owner is not repaired by it. An app that keeps an owner of record but has none for the install still answers 409, and is retried until the record exists. An entitlements delivery does not ask for the ownerless reconcile and is refused as before. `adapter-cloudflare` adds `seatScopeLocal`, which only seats a scope already provisioned for that tenant.

  The console's "Re-run provisioning" says the same when no owner was re-sourced. The "What this app calls" panel now names the second reason a target can grant an app nothing: its install predates the version that declares the app as a peer.

- b854efd: `substrat scope restore` of a `.dump.json` sends the dump's scope stores back, and a full pull keeps a dump's `stores` where the host has them. A masked pull sends an empty store list, because those tables cannot be pseudonymized. A restore body that omits `stores` leaves the live stores untouched.
- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
  - @substrat-run/contracts@0.147.0

## 0.1.11

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0

## 0.1.10

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0

## 0.1.9

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
  - @substrat-run/contracts@0.144.0

## 0.1.8

### Patch Changes

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

- 88a4380: **Deprecated:** a status read from an error's sentence (part of #113). `classifyError`, and with it `mountOperations`, `mountPlatformSurface` and `problemResponse`, still answers a throw that declared no code with 403 for "permission denied", 404 for "not found" or "unknown scope", and 409 for "invalid transition" or "immutable". A later release stops reading the sentence, and such a throw will answer 400 like any other unrecognised one. Until then a match logs `vertical-host.untyped-refusal` in the vertical's own logs, naming the code that keeps the status. Each worker isolate logs a given code and first 120 characters of the sentence once (a longer sentence is logged cut to those 120, marked `… (truncated)`), and goes silent after 100 such lines; the status is unaffected either way. Declare it where you throw, with the same sentence: `substratError('not_found', …)` answers the same 404 with the same `detail`, and adds `code`.

  No status changes in this release. The scaffold's two missing-record refusals (`customer not found`, `bike not found`) now declare `not_found`. `ControlPlaneClient.assertScopeActive`'s unknown-scope refusal is still a `ControlPlaneError` with status 403, and now also declares `not_found` (new optional `ControlPlaneErrorDetail.code`, surfaced as `ControlPlaneError#code`), so a vertical rethrowing it keeps answering the 404 it answers today. Its `status` and its code disagree (403 against `not_found`) on purpose for this release, so neither reader's answer moves; the gate's other three refusals (unknown tenant, tenant or scope not active) declare no code yet.

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [dfb653b]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0

## 0.1.7

### Patch Changes

- 6a00cfc: **`ControlPlaneError#problemCode`** reads the taxonomy code the plane's problem document declared (#113), so a caller can branch on what a refusal is instead of on its sentence. It is `undefined` for a body that named no code: an `about:blank` relay, a route the plane does not have, a transport error, or an error raised on the caller's side.

  **`vertical-host`'s `/internal/query`** recognises the read-only console's refusal by its `validation_failed` code instead of the words `read-only console`. The status (400) and the sentence are unchanged.

- Updated dependencies [6a81de3]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0

## 0.1.6

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
  - @substrat-run/contracts@0.141.0

## 0.1.5

### Patch Changes

- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/contracts@0.140.0

## 0.1.4

### Patch Changes

- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [48bf765]
  - @substrat-run/contracts@0.139.0

## 0.1.3

### Patch Changes

- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/contracts@0.138.0

## 0.1.2

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0

## 0.1.1

### Patch Changes

- 33b2d44: A refused connect's `ControlPlaneError` now carries the provider `probe` its body named (#605), read off the same parse as the sentence. The field was declared and documented but never filled, so every caller had to re-read the body for it.
- 4eb961d: `npx @substrat-run/cli` installs again. `@substrat-run/control-plane-client@0.1.0` was published with a `workspace:` dependency that npm cannot resolve, so installing the CLI failed with `EUNSUPPORTEDPROTOCOL`. This release republishes the client with a resolvable manifest, and the CLI now requires that version.
- 01bf5d4: A kill switch whose answer was cut short no longer reports "Nothing was switched" (#2010).
  When a deployment that has the switch route moved the switch and then lost part of its
  answer (a truncated body, or one that failed to read), the control plane said the deployment
  predated the route and told the operator to redeploy and retry. Now only a status says a
  deployment predates a route: a 404, or a 501 where that deployment's own fallback answers one.
  A body never does. An HTML page in particular can't count, because an old deployment's app
  page and an error page from something in between look the same. Anything else is a 502 that
  says the position is unknown and to read it before retrying. The same rule covers the
  switch status reads, the preview-client calls to a team auth server, the cross-vertical event
  calls, the plain internal calls, and the carry's fenced wipe.

  The console's Schedules and Peers cards and the dashboard's app-to-app panel no longer show
  such a failure as "Refused". They read the position again, show it, and say the switch was
  not confirmed.

  `@substrat-run/control-plane-client` exports `provesNothingChanged(error)`, the one rule both apps
  use to tell a refusal (4xx, or 501) from a failure whose effect is unknown.

- Updated dependencies [fb1f624]
- Updated dependencies [4964eb8]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/contracts@0.136.0

## 0.1.0

### Minor Changes

- 04f105e: The control-plane client is its own Apache-2.0 package, and the CLI talks to the plane through it (part of #971).

  `@substrat-run/control-plane-client` holds the transport (credential selection, the problem-document reader, `ControlPlaneError`) and `ControlPlaneClient`, reaching nothing but `fetch` and `@substrat-run/contracts`. `@substrat-run/control-plane-api` re-exports it from both entries, so every existing import keeps working; the CLI depends on the client rather than on the AGPL server package. The transport gains an optional `headers` option, `ControlPlaneError` carries the raw `body`, `statusText` and response `headers` of a refusal (and the error `fetch` threw as its `cause`), a raw `request()` hands back the `Response`, and `fetch` is resolved at call time; `ControlPlaneBuilderClient` adds typed methods for the routes the CLI calls. Nothing a deployed caller sends or reads changes, and the CLI prints the same requests and the same messages as before.

### Patch Changes

- Updated dependencies [1dca2da]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/contracts@0.135.0
