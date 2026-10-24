---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Who owned a vertical, and when (#2501). `verticals.owner_tenant` says who owns a slug now; a slug deleted and registered again left no trace of its first owner outside the admin log. The directory now keeps each registration as a period, so a past period bills the builder who owned the vertical then.

- contracts: `verticalOwnerPeriod` and `verticalOwnersReading`.
- kernel: `VERTICAL_OWNERS_DDL` (`_substrat_vertical_owners`, at most one open period per slug), `VERTICAL_OWNERS_BACKFILL` (a period from `created_at` for every vertical with none, run on each start and inside a directory restore), `openVerticalOwnerRow`, `closeVerticalOwnerRow`, `listVerticalOwnerRows`, and the optional `HostAdmin.listVerticalOwners`, access-logged.
- adapter-sqlite, adapter-cloudflare: a period opens in the transaction that inserts a `verticals` row and closes in the one that deletes it, and the backfill runs at start. contract-tests holds both adapters to it, a restore from a dump without the history included.
- control-plane-api: the staff-only `GET /verticals/:slug/owners`, served for a deleted slug too, and `readVerticalOwners` on the staff client.

The history is kept for good: it is not governed by `BILLING_ROLLUP_RETENTION_MONTHS`, and nothing prunes it. A tenant reap keeps the periods that tenant owned, as it keeps the tenant's tombstone: a period names a tenant id, never a person. A horizon for it later would be an additive change.
