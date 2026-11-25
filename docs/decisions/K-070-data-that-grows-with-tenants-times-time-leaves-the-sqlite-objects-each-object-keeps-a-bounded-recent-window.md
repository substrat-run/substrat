---
id: K-70
date: 2026-11-25
layer: kernel
title: "Data that grows with tenants times time leaves the SQLite objects: each object keeps a bounded recent window, and the admin log is written where the change is made and shipped onward"
status: proposed
aliases: []
amends: []
tracking: ["#3326", "#3325", "#3316", "#2501", "#1232"]
---

# K-70 — Data that grows with tenants times time leaves the SQLite objects: each object keeps a bounded recent window, and the admin log is written where the change is made and shipped onward

> **Proposed 2026-11-25, not ratified.** The inventory and the numbers are in
> [rfc/tenant-scale.md](../rfc/tenant-scale.md) (§3, §5, §8.3, §8.4). Nothing in it is built.

**No Durable Object or D1 database holds data that grows with tenants times time without a bound.**
Each such data set is either bounded per object, with a retention, or kept where size is unbounded
by design: the lake on R2 (Iceberg, fed today by the outbox stream), Analytics Engine, or R2 objects.

| Data | In the object | Kept for good in |
|---|---|---|
| Admin log | 35 days | the lake |
| Staff access log (K-24) | until shipped, hours | the lake |
| Ops failures | 14 days | the lake, 90 days |
| Sweep outcomes | the last outcome per unit | the lake, history |
| Model and build usage | 35 days | the lake, 400 days |
| Meter days | the current and previous billing period | the lake |
| Request and cost days | none | the lake |
| Storage gauge | the latest reading | the lake |
| Version manifests and migrations | the digest | R2, by digest |

**The admin log is written in the same transaction as the change, in the object that makes it**: a
tenant's directory object for a tenant's change, the registry for a platform change
([K-68 (directory split)](./K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md)).
The object ships its rows through an outbox, as a scope ships its events, in batches at most five
minutes apart (the freshness bound of
[D-77 (five-minute bound)](./D-077-routing-changes-and-suspension-take-effect-within-five-minutes-through-the-edge-read-model.md)),
and prunes only rows the lake has acknowledged. A change across two objects writes a row in each, linked by its intent id. A
tenant's Activity page reads its own window; anything older, and every staff-wide query, reads the
lake.

**An access-log row records a person reading a tenant's data**, written in that tenant's object. The
platform's own bookkeeping reads of a directory object by that object's own alarm are not staff
access and write no row, unless the owner decides otherwise (below).

**A staff read that visits no tenant object is recorded too.** Staff lists and search over the
cross-tenant index, staff queries over the lake and staff reads of the registry are `HostAdmin` reads
under [K-24](./K-024-staff-reads-are-audited-into-a-separate-access-log-that-drai.md). Each writes one
access-log row with K-24's fields (actor, method, the tenant or scope where one is named, a parameter
summary and the result count) in the registry, which ships it to the lake. Where staff-wide rows are
stored is an open choice; that they are written is not. This record changes where K-24's rows are
written, not which reads K-24 records, with one exception the owner may take: the bookkeeping reads
above. If that exception is taken, this record amends K-24 explicitly.

**The billing rollups stop being kept forever in the directory.** `BILLING_ROLLUP_RETENTION_MONTHS`
(today `null`, keep all) becomes the window above once the lake holds the history.

## Why

**The directory is mostly logs.** The 2026-11-18 copy held 1.58 M rows: 60 % access log, 15 % sweep
runs, 10 % version migrations, 10 % ops failures, 5 % everything that is a fact about a tenant
(#3325). The access log's drain ships 500 rows a pass against about 720 arriving, so it has run eight
days behind since it was measured (#3326), and it breaks above about 205 scopes.

**The fixed part fits; the growing part does not.** About 25 KB per tenant is 2.4 GB at 100,000
tenants. Rows kept for good grow by about 88 MB a day at 100,000 tenants, and reach the usable 5 GB
(10 GB less the daily copy) in about a month (rfc §5.3).

**Writing the admin row where the change is made keeps today's guarantee and widens it.** Today the
guarantee holds for the directory-only writes that run through `writeAndAudit`, which commits the
change and its row together. Many `HostAdmin` mutations write their admin row in a separate
`recordAdmin` call after the change returns (`packages/adapter-cloudflare/src/host.ts`), the window
#1292 recorded. Writing every admin row in the deciding object's own transaction closes that window
for every write; a row shipped from an outbox afterwards cannot be lost.

## Open choices for the owner

- The window length (35 days proposed, to cover a billing period and a dispute).
- **#3326's policy question:** whether the platform's own reads of a tenant's directory record write
  access-log rows. They are about 95 % of today's inflow. K-24 is about who looked at tenant data.
- The lake's retention per data set, and whether the admin log in the lake is kept forever.

## Not built

All of it. The outbox stream to the lake exists for scope events (#1334); the directory's own
outbox does not.
