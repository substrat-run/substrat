---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

The introspection reads a vertical makes by scope id alone refuse a scope the deployment does not hold (#2544), as the size reads do (#2541). Reaped, never provisioned here, or carried away: `conflict` with the shared sentence, not an empty answer.

- adapter-cloudflare: the scope object answers each read as `…IfHeld`, the held check and the read in one call. Covers the event reads (`facetEventsLocal`, `eventEffectsLocal`, `invocationEventsLocal`, `deadLettersLocal`, `eventCauseLocal`, `entityHistoryLocal`, `lifecycleFlowLocal`, `operationSeriesLocal`), `appliedMigrationsLocal`, `migrationBookmarksLocal`, `introspectScopeTables`, `undrainedEventsLocal` and `redrainCountLocal`.
- adapter-sqlite: the same `*Local` verbs, refused from the directory before any store file is opened, so a gone scope never gets one. `queryScope` and `readScopeTable` share their bodies with these verbs and record exactly what they did.
- contract-tests: `introspectionReadsContractSuite` (a case per read: held, reaped, never provisioned), and `TEST_LIFECYCLE`.
- kernel: `ScopeNotHeld`, and `EventDrainReport.notHeld`. An active scope its deployment does not hold is counted by the Tier-2 event drain and said in the sweep's log line; it is no longer an `errors` entry, so the failure digest does not mail it on every tick. It is filed as one staff ops-failure (no tenant), and again only after a week without one. A scope reaped or archived since the listing, or re-pointed by a carry under the read, is nothing to ship rather than a fault (`notHeldIsBenign`). This differs from the storage gauge (#2549), which records an active scope its deployment does not hold as that scope's error: a failed size read is that day's reading, while a drain that cannot read is a standing condition with nothing to retry.
- control-plane-api: a scope's health answers 200 for an active scope its deployment does not hold, with `roleCount: 0` and `roleProjectionEmpty: true`, rather than refusing the route.
