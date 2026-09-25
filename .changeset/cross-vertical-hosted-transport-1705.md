---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'create-substrat': patch
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
---

Cross-vertical events now reach hosted verticals, and arrive in seconds rather than at the next sweep (#1705).

`@substrat-run/vertical-host`'s platform surface gains three platform-secret-gated routes: `POST /internal/exported-events` (the producer's release after a watermark), `GET /internal/import-state` (the consumer's imports and watermarks) and `POST /internal/import-events` (a batch, applied under the watermark's compare-and-set). They call three new optional `VerticalScopeHost` members: `exportedEventsLocal`, `importStateLocal` and `importEventsLocal`. A host without them answers 501, naming the redeploy.

`@substrat-run/adapter-cloudflare` implements the three far ends. Before answering, each proves the scope was provisioned in this deployment for this tenant, and refuses `conflict` otherwise. A CP-less deployment has no directory, and an unprovisioned Durable Object would answer with a plausible empty result. The coordinator also fires the new `ScopeStubOptions.onExportedEvents` when an invoke commits an exported type.

`@substrat-run/control-plane-api` adds `VerticalClient.exportedEvents`, `importState` and `importEvents`. A deployment that predates the routes (a 404, or its SPA shell) is a 501 that says to redeploy, so it is never an empty answer. It also adds `hostedCrossVerticalReach`, the control plane's reach for the phase. That reach decides which scopes to call from the version registry, so a fleet with no importer makes no `/internal` call. A consumer's `imports` reach the registry only from `substrat` CLI **0.34.0** on. A version pushed by an older CLI reads as importing nothing, and its scopes are not asked until it is pushed again. A manifest the registry cannot parse keeps its scopes as candidates, and is reported.

`@substrat-run/kernel` adds `EXPORTED_EVENTS_HEADER`, `ScopeStubOptions.onExportedEvents`, and `kickFlags(setHeader)`, which returns both kick callbacks for a worker to spread into `getScope`'s options. It also adds `runCrossVerticalFrom`, which runs one producer's outgoing edges for the router kick; `registryImportCandidates`, the registry-backed narrowing; and a `{ from }` hint on `CrossVerticalReach.candidates`. `@substrat-run/adapter-sqlite` fires `onExportedEvents` too. `@substrat-run/contracts` adds `importsOfManifestJson`, which answers `none`, `imports` or `unreadable`. The adapter-cloudflare host adds `versionImports`, the unaudited registry read the narrowing uses.

`@substrat-run/contract-tests`: a `VerticalEventsFixture` may pass a `transport` and an `afterInstall`, which is how the suite now also runs over the hosted transport on workerd.

The scaffold's worker wires both flags with `kickFlags`, so its responses also carry `x-substrat-exported-events`. The router passes that flag on its drain kick, and the control plane runs the producer's edges when it sees it. The control plane runs the phase on its scheduled sweep, with `CROSS_VERTICAL_CONSUMERS_PER_PASS` as the per-pass cap (`0` pauses).
