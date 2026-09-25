---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
'@substrat-run/console': patch
---

Cross-vertical events gain a replay lever, an edge-health view, a payload-schema rule in CI, and a promote refusal (#1705).

**The replay lever.** `HostAdmin.moveImportCursor(actor, tenantId, scopeId, move)` moves a consumer's watermark on the edge from one producer vertical. `mode: 'replay'` re-delivers after a point (`after: null` is the whole history). It needs `acknowledge: 'rerun-handlers'`, because every importing handler runs again, and anything they send or call outside the app happens again (`REPLAY_EFFECT`). `mode: 'skip'` passes events over up to a point (`through: 'now'`). It needs `acknowledge: 'skip-events'`, and a later replay can reach back to what it skipped. A replay moves the replayed range's delivery and journal rows into the new spine table `_substrat_import_replays`, under the act's `replayId`, rather than deleting them. The producer is resolved from the directory in the consumer's tenant, never taken from the caller. `@substrat-run/control-plane-api` serves it as `POST /tenants/:t/scopes/:s/import-cursor` to staff and to the tenant's own credential, and refuses a missing acknowledgement in those words. `@substrat-run/vertical-host` adds `POST /internal/import-cursor` (optional `importCursorLocal`, 501 when absent), and `VerticalClient.importCursorMove` reaches it. On the control plane, `CloudflareScopeHostOptions.importCursorDelegation` routes the move to the deployment serving the scope.

**Edge health.** `crossVerticalHealth(host, { actor, tenantId, crossVertical })` reads every edge of one tenant live, through the sweep's own reach: `caught-up`, `behind` (with the oldest waiting event's lag), `paused` (by the producer's grant or the consumer's door), `unresolved`, or `unavailable` when a side could not be asked. `unavailable` never renders as healthy. Each edge carries its last delivering sweep pass and the last one that did not deliver. `GET /tenants/:t/cross-vertical/edges` serves it. The dashboard shows it per app, and the console per scope, both with the lever behind a ticked acknowledgement.

**D-22 for exported events.** `exportedEventSchemasOf(operations, eventsExportedBy(…))` derives each exported type's payload as JSON Schema, and `emitModel(…, { exports })` carries it in `model.json` (omitted when empty, so no existing model changes). `pnpm lint:export-schemas --base <ref>` compares it with the merge-base. At an unchanged schemaVersion it refuses a removed, retyped, newly required or no-longer-required field, and a schemaVersion that went down. A base the checkout lacks is exit 2, never read as a new file. CI runs it on every PR and push.

**The promote refusal.** `promoteVersion` refuses a version that drops or re-versions an exported (type, schemaVersion) the outgoing version promised and a running consumer imports, unless acknowledged with `exportBreak` (`substrat promote --ack-export-break`). The refusal counts the break and names no tenant. `HostAdmin.promotionImpact` lists the affected apps, and the promote route returns that list with a 409: a confined caller sees its own tenant's apps and a count of the rest. `@substrat-run/contracts` adds `exportsOfManifestJson` and `exportBreak`.
