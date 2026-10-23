---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

Daily request rollup, kept for billing (#2501). The platform sweep now reads each closed UTC day of the router's Analytics Engine request datapoints and keeps one row per (day, tenant, vertical, scope) in the directory before the datapoints age out. Every count is an estimate (`sum(_sample_interval)`), marked `estimated: true` on every row.

- contracts: `requestDay`, `requestRollupDay`, `requestRollupReading`, a strict `utcDay`, and `ROUTER_REQUEST_POINT`, the router datapoint's published ordinals.
- kernel: `REQUEST_ROLLUP_DDL` and its statements, the sweep's `requestRollup` phase (one query per day, oldest unread first, at most seven a pass, a failed day retried after an hour, a saturated answer refused whole), four optional `HostAdmin` methods (`recordRequestDay`, `listRequestDays`, `listRequestRollupDays`, `pruneRequestDays`), and `BILLING_ROLLUP_RETENTION_MONTHS`, `null` until a billing horizon is set, so nothing is pruned.
- adapter-sqlite, adapter-cloudflare: the two directory tables, created on start, and the methods. contract-tests holds both adapters to them.
- control-plane-api: `createRouterRequestDayReader` and the staff-only `GET /meters/requests`, with `readRequestRollup` on the staff client.
- control-plane: the scheduled pass runs the rollup when the Analytics Engine credential and `ROUTER_ANALYTICS_DATASET` are set.

No existing retention changes.
