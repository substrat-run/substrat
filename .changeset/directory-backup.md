---
"@substrat-run/control-plane-api": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
---

feat(platform): the directory backs itself up, and the restore is rehearsed (#40)

Every database the platform holds was protected except the one whose loss is
unrecoverable. A scope has ~30-day Durable Object point-in-time recovery — continuous,
per-scope, and strictly better than any daily copy, which is why scheduled per-scope
backups are deliberately *not* built here. The **directory** is the case PITR cannot
answer: it is a single DO, so a bug that deletes it outright leaves nothing to rewind, and
no scope knows its own tenancy, hostname or bound version well enough to rebuild the map
from below. `control-plane.md` had already named the stake — *losing it is losing the
platform, not losing a cache* — without resolving it.

New pair on `HostAdmin`, implemented by **both** adapters: `exportDirectory` (a
full-fidelity row-dump of tenants, scopes, hostnames, verticals, entitlements, identities
*and the audit spine* — a directory restored without its history cannot say what the
platform did before the restore) and `restoreDirectory`. The export is audited in the K-24
access log with no tenant, because its subject is every tenant at once; the restore is a
new `restoreDirectory` admin action, written *after* the replace so the entry survives it
— the first row after a restored history is the restore.

`DirectoryBackupStore` is a sibling seam to `ScopeBackupStore` rather than a widening of
it: a scope copy is taken at a moment and addressed by its scope, a directory copy is taken
on a schedule and pruned to a window. `createR2DirectoryBackupStore` keys under
`directory/`, so it can share the scope bucket or have its own. Bound as
`DIRECTORY_BACKUPS` on the control-plane worker.

`backupDirectoryIfDue` runs **last** in the platform sweep, after the phases that mutate
the directory, so a copy is of a settled directory. The cadence is enforced by reading the
newest stored copy rather than by a second trigger: the quarter-hourly cron takes **one
copy a day**, a missed tick is caught up on the next pass (late, never never), and the
schedule needs no durable state of its own. **Retention is 30**, matching the PITR horizon
so the two defences expire together — and pruned only *after* a successful capture, so a
failed backup can never be the thing that deletes the last good copy.

Routes (staff-only, none per-tenant): `GET/POST /directory/backups`,
`GET /directory/backups/:capturedAt`, `POST /directory/restore`. All four answer `501`
where no store is bound rather than an empty list — "nothing held" and "nobody is looking"
must not read alike. A restore **replaces**, so it refuses a directory that still holds
tenants unless the body says `overwrite: true`: the dangerous case is not a slip of the
fingers but a replayed restore against a control plane that already recovered.

`#40` asked for a *rehearsed* restore, so the round trip runs in the contract suite against
both adapters — capture, diverge, restore, then open a scope and invoke through the
directory it just rewrote. `control-plane.md` §4.9 records RPO ≤ 24h / RTO ≤ 1h, the
runbook, and the honest limit: the bucket lives in the platform's own Cloudflare account,
so this survives losing the *directory*, not losing the *account*. The seam is
provider-neutral so an off-account target is a drop-in when that is worth paying for.
