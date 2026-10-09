---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
'@substrat-run/console': patch
---

A tenant's storage is now a stored gauge: `GET /meters` carries a storage figure per tenant and for the fleet, and serving it wakes no scope.

The scheduled pass samples scope database sizes in a new storage phase, configured with
`storageGauge: { read }` on `runPlatformSweep`. It measures every scope that holds a store
(active, suspended, archiving, archived; never provisioning or reaped). An active scope is read
only when an earlier phase of the same pass already reached it (the platform-intent drain, or
the executor drain on a host without one), so the serving fleet gains no wake. A non-serving
scope, which no drain reaches, is read anyway, once a day. A scope is due once a day, at most 100 per pass,
never-tried first and then the longest since a try. A failed read keeps the last stored value
and is retried a day later, not on every pass. A vertical deployed before
`/internal/database-size` is a standing condition: its scopes show as failing on `/meters`,
with the reason, but stay out of the failure digest.

Samples are kept in the directory's new `_substrat_scope_storage` table, one row per scope per
UTC day (a later same-day reading replaces an earlier one), for thirteen months, and each
scope's latest try in `_substrat_scope_storage_attempts`. A reaped scope's rows are deleted
at reap. The meter's `storage` field (`storageGauge`) says what it
sums (scope databases only, with attachments, per-tenant D1 databases and the lake named as
excluded), how many scopes it covers (`sampled` of `total`) and the `oldestReadAt` it is as
of, plus how many scopes' last read FAILED (`failing`, `lastFailedAt`), so a scope that keeps
failing is named rather than silently missing. The console shows it on the Meters view and the
tenant page, and calls it a total only when every scope is sampled, none is failing and no
sample is older than two days.

`HostAdmin.recordScopeStorage`, `listScopeStorage`, `listScopeStorageAttempts` and `pruneScopeStorage` are new OPTIONAL
methods, and the phase is skipped on a host without them, so an adapter built before this
still satisfies the interface. The meter's `storage` fields are optional for the same reason:
a host that keeps no gauge reports none, rather than a zero.
