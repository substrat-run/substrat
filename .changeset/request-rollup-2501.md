---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

Daily request rollup, kept for billing (#2501). The platform sweep now reads each closed UTC day of the router's Analytics Engine request datapoints and keeps one row per (day, tenant, vertical, scope) in the directory before the datapoints age out: the total routed, and its split by status class and 429s. Every count is an estimate (`sum(_sample_interval)`), marked `estimated: true` on every row.

- contracts: `requestDay` (the total and its split, with the split held inside the total), `requestRollupDay` (with `saturated`, and `failingSince`/`failingCount` while a run of failures lasts), `requestRollupReading`, a strict `utcDay`, and `ROUTER_REQUEST_POINT`, the router datapoint's published ordinals.
- kernel: `REQUEST_ROLLUP_DDL` and its statements, `RequestRollupSaturated`, and the sweep's `requestRollup` phase. It runs after the scheduled work, just before the access-log drain, and reads one closed day per query, oldest unread first, at most seven a pass, up to 88 days back. Each read has a 30-second deadline. A failed read writes nothing, is retried after an hour, and ends the pass's reads. A run of identical failures reaches `report.errors` once, and the report's `streak` carries it on every pass. A saturated day (more groups than one read answers) is recorded `saturated` and not read again, and the days after it go on. Options that would corrupt the history are refused. Also four optional `HostAdmin` methods (`recordRequestDay`, `listRequestDays`, `listRequestRollupDays`, `pruneRequestDays`), and `BILLING_ROLLUP_RETENTION_MONTHS`, `null` until a billing horizon is set, so nothing is pruned.
- adapter-sqlite, adapter-cloudflare: the two directory tables, created on start, and the methods. contract-tests holds both adapters to them.
- control-plane-api: `createRouterRequestDayReader` (asks one row past the 50,000-group ceiling, refuses only above it), the staff-only `GET /meters/requests` (by default the 31 days ending today), and `readRequestRollup` on the staff client.
- control-plane: the scheduled pass runs the rollup when the Analytics Engine credential and `ROUTER_ANALYTICS_DATASET` are set, and its log line names days read, a failing run (error, start, attempts) on every pass it lasts, and saturated days.

No existing retention changes.
