---
id: D-78
date: 2026-11-25
layer: plan
title: "A directory object recovers by point-in-time restore and an incremental export to R2, not by a daily whole copy"
status: proposed
aliases: []
amends: []
tracking: ["#3325", "#40", "#2868"]
---

# D-78 — A directory object recovers by point-in-time restore and an incremental export to R2, not by a daily whole copy

> **Proposed 2026-11-25, not ratified.** The reasoning is in
> [rfc/tenant-scale.md](../rfc/tenant-scale.md) (§13). Nothing in it is built.

**Point-in-time recovery is the first recovery tool for every directory object.** A SQLite-backed
Durable Object can be restored to any point in the past 30 days, in place, and the restore can be
undone. Each directory object takes a bookmark before its own schema changes, as a scope does before
its migration pass under [K-33](./K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md),
and a rewind is an audited, time-boxed staff action like `rewindScope`. After the split
([K-68 (directory split)](./K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md))
a rewind is one tenant's, not everyone's.

**An incremental export to R2 replaces the daily whole copy.** A tenant's directory object exports
itself from its alarm when it has changed since its last export, at most once a day. The registry
exports daily. Logs are in the lake already
([K-70 (tenants × time data leaves the objects)](./K-070-data-that-grows-with-tenants-times-time-leaves-the-sqlite-objects-each-object-keeps-a-bounded-recent-window.md)),
so no export carries them. Restoring a tenant is an import into a fresh object under a new epoch, as
`importDump` does today.

**Until the split**, the existing daily backup stops copying the whole directory into itself (#3325):
append-only tables are carried by reference to the previous copy, and the logs are left out of it once
they are shipped.

## Why

**The whole copy is the largest avoidable write.** It was 44 % of the directory's rows written in the
30 days to 2026-11-20 and doubles the directory's stored bytes while it runs (1.3 GB at rest, 2.19 GB
during the copy on 2026-11-24), which halves the usable 10 GB. It grows with the directory on its own.

**PITR covers most of what the copy is for, and not all.** It covers an operator error, a bad
migration and a bug, within 30 days. It does not cover losing the object, the namespace or the
account, anything older than 30 days, reading old rows without rewinding the live object (no restore
into another object is documented), or a self-host. The export covers those.

## Open choices for the owner

- The export cadence for a changed tenant (daily proposed) and for the registry.
- Whether the registry also keeps a periodic full export besides the incremental one.
- How long exports are kept in R2.

## Not built

All of it. Not verified: whether PITR survives an object's `deleteAll`, and its behaviour in a
jurisdiction.
