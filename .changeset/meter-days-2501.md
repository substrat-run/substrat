---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

Meters 1 and 2, kept daily (#2501). `/meters` recomputes its reading on every call, so a past day's reading was gone. The platform sweep now keeps one row per (UTC day, tenant), taken by the first pass of the day: the tenant's status and whether it is billable, its scopes by effective status, the same counts split by vertical, and every grant (key, plan, expiry) with whether it was live at the snapshot's instant.

- contracts: `meterDay`, `meterDayVertical`, `meterDayGrant`, `meterDayTake` (the record of a day, with `failingSince`/`failingCount` while a run of failures lasts) and `meterDaysReading`.
- kernel: `METER_DAYS_DDL` and its statements, and the sweep's opt-in `meterSnapshot` phase. One directory transaction reads the tenants, their scopes and their grants, folds them with `foldMeterReading` and writes the day, so a kept day follows the same billable rule as `/meters`. A reaped tenant has no row. The first pass of the day takes it, and the later passes of the day do nothing. It runs after the scheduled work, just before the request rollup and the access-log drain, with a 30-second deadline. A failed attempt writes nothing and the next pass of the day tries again. A run of identical failures, across midnight too, reaches `report.errors` once, and the report's `streak` carries it on every pass until a snapshot is taken. Options that would misconfigure it are refused. Also four optional `HostAdmin` methods (`recordMeterDay`, `listMeterDays`, `listMeterDayTakes`, `pruneMeterDays`). The snapshots prune by the request rollup's horizon, `BILLING_ROLLUP_RETENTION_MONTHS`, still `null`, so nothing is pruned.
- adapter-sqlite, adapter-cloudflare: the two directory tables, created on start, and the methods. contract-tests holds both adapters to them.
- control-plane-api: the staff-only `GET /meters/days` (by default the 31 days ending today, narrowed with `tenantId`, with the record of each day) and `readMeterDays` on the staff client.
- control-plane: the scheduled pass takes the day's snapshot, and its log line names the day taken and a failing run (error, start, attempts) on every pass it lasts.

No existing retention changes.
