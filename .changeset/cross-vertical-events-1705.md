---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/cli': patch
'@substrat-run/dashboard': patch
'@substrat-run/console': patch
---

A vertical can receive another vertical's events in the same tenant (#1705).

The producer declares what may leave, as `events.exports: [{ type, schemaVersion, readPermission }]`. `eventsExportedBy(ops, { type: key })` derives this from the operations' `emits`. It refuses any type that an operation classifies other than `piiClass: 'none'`, any type no operation emits, and any type emitted at two versions. The consumer declares what it takes, as `events.consumes: [{ from: '<vertical slug>', type, schemaVersion }]`. Its handlers go in a new `ModuleRegistration.imports` map (slug → type → handler), never in `consumers`. That way, a host that predates this reads the `from` entry as an inert local consume and does not wire the handler as a local consumer.

`@substrat-run/contracts` adds `consumedEventRef`, `eventExport`, and the wire schemas for an edge: `exportReadInput`, `exportedEvent`, `exportedBatch`, `withheldEvent`, `importState`, `importBatch` and `importResult`. The permission registry gains optional `exports` and `imports`, omitted when empty so no existing `digests.permission` moves. `sweepRunKind` gains `vertical-events`. The cause walk has a new terminal, `imported`, with `causeChain.imported` saying where the chain continues. `ImportedEvent` is the crossed fact: id, type, version, time, entity and payload. It never carries the producer's actor, authorization or impersonation.

`@substrat-run/kernel` adds three required members, so every implementation of `HostAdmin`/`ScopeHost` needs them:
- `HostAdmin.readExportedEvents` is the producer's release. The producer's own exports decide what leaves, the receiver's key must be held at the producer's scope, and classified, off-version, over-cap and undecodable rows are withheld.
- `HostAdmin.importState` returns the consumer's declared imports and its watermark per producer.
- `ScopeHost.deliverToPeer` is the consumer's apply. It runs under a compare-and-set on the watermark, one transaction per (event, module) with its delivery row, and moves the watermark last.

The kernel also adds `runPlatformSweep`'s opt-in `crossVertical` phase, which reports every edge (`delivered`, `idle`, `paused`, `unresolved`, `stale`, `failed`) and writes a `vertical-events` sweep-run row for each edge that moved or could not run. It adds the shared `VERTICAL_EVENTS_DDL`, which covers `_substrat_imports` (envelope only, never a payload), `_substrat_import_cursors`, and a `(type, id)` outbox index. The kernel also exports `CrossVerticalRegistry`, the planner (`planExportBatch`, `exportReadPlan`) and the hop walk. `readDeadLetters` now lists an imported event's dead letters beside local ones.

Both adapters implement all of it. `@substrat-run/contract-tests` adds `verticalEventsContractSuite` and its two fixture verticals, run on the pure host and on workerd.

`@substrat-run/cli` leaves a `from` consume out of the declared event surface, since it never lands in the consumer's own outbox. The dashboard's cause view explains an `imported` ending. The console's Sweep runs view can filter to cross-app events.
