---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

The introspection reads a vertical makes by scope id alone refuse a scope the deployment does not hold (#2544), as the size reads do (#2541). Reaped, never provisioned here, or carried away: `conflict` with the shared sentence, not an empty answer.

- adapter-cloudflare: the scope object answers each read as `…IfHeld`, the held check and the read in one call. Covers the event reads (`facetEventsLocal`, `eventEffectsLocal`, `invocationEventsLocal`, `deadLettersLocal`, `eventCauseLocal`, `entityHistoryLocal`, `lifecycleFlowLocal`, `operationSeriesLocal`), `appliedMigrationsLocal`, `migrationBookmarksLocal`, `introspectScopeTables`, `introspectScopeTable`, `introspectScopeQuery`, `undrainedEventsLocal` and `redrainCountLocal`.
- adapter-sqlite: the same `*Local` verbs, refused from the directory before any store file is opened, so a gone scope never gets one.
- contract-tests: `introspectionReadsContractSuite` (a case per read: held, reaped, never provisioned), and `TEST_LIFECYCLE`.
- kernel: `ScopeNotHeld`, and `EventDrainReport.notHeld`. An active scope its deployment does not hold is counted by the Tier-2 event drain and said in the sweep's log line; it is no longer an `errors` entry, so the failure digest does not mail it on every tick.
- control-plane-api: a scope's health answers 200 for an active scope its deployment does not hold, with `roleCount: 0` and `roleProjectionEmpty: true`, rather than refusing the route.
