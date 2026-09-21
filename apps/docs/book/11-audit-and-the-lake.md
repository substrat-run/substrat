---
description: "The four audit witnesses — outbox, denials, admin log, access log — and how events drain from every scope into an Iceberg table in R2 that R2 SQL can query."
---

# 11. The audit trail and the lake

"Audit log" is one phrase for several records, kept in different places, by different code,
under different retention. Asking which one is *the* audit log is how a compliance question
gets a confident wrong answer. So this chapter names each witness, then follows the one that
leaves the scope: the event stream, drained into a table that SQL can query across the whole
fleet.

## Four witnesses, and what each one saw

| Record | Lives in | Written by | Witnesses | Kept |
|---|---|---|---|---|
| **The outbox** | each scope | the kernel, inside the operation's transaction | every *allowed* mutation, with actor, authorization chain, impersonation, operation, version, and the call it belonged to | for the life of the scope, and copied to the lake |
| **The denial log** | each scope | the kernel, after the rollback | every *enforced refusal*: actor, permission, node, operation, impersonation | for the life of the scope |
| **The admin log** | the control-plane directory | every audited `HostAdmin` verb | every *privileged change*: who provisioned, suspended, granted, admitted, rewound, reaped, with before and after | **never swept**, and it outlives a reaped tenant |
| **The access log** | the directory, then R2 | every staff or delegated read | every *look*: who read what in which tenant, with how many rows | drained to R2, pruned per retention |

The delivery journal (chapter 5) is a fifth record, but it is an operational one. It says what
happened to an event, not who did something.

Read the table by columns rather than rows, and each record covers a gap the others leave:

- The outbox cannot see a refusal, because a refused operation rolls back its own events. That
  is why denials are written separately, after the rollback.
- Neither scope-local record can see a change made *to* the scope from outside, such as a
  suspension, a role grant or a rewind. The admin log exists for that.
- None of the three records a *read*. When a staff member or the dashboard opens a tenant's
  records, the access log is the only witness. It names the method, the tenant, the scope and
  the parameters, so "who looked at this customer's data" has an answer. Nothing in the
  product shows it yet. It is answered from the directory or from the R2 copies.

## The admin log, precisely

Each row holds `actor`, `action`, `tenant_id`, `scope_id`, `vertical`, `before`, `after`,
`caused_by` and `at`. When an executor wrote the row, `caused_by` is the event that set it off
(chapter 5), so an automated change links back to the domain event behind it.

Two properties are worth knowing exactly.

**It is never swept.** Grant provenance and bookkeeping-law retention both depend on it, so it has
no TTL and no retention phase. Its growth is handled by bounding *reads*: the HTTP surface pages,
and a cursor walks the whole thing. When a tenant is reaped, its scope data and personal
directory rows are destroyed and its admin-log rows are **kept**. The record of what was done to
a tenant has to outlive the tenant.

**The row follows the mutation, in a separate write.** An audited verb commits its change and
then writes its row. A failed log write fails the verb, but the change already stands, and a
crash between the two leaves a change with no row. That window is accepted and documented rather
than hidden. Two verbs deliberately reverse the order, because for them the missing row is the
harmful half-state: a point-in-time rewind records its intent *before* it destroys anything, and
an impersonation session is logged before the session is handed back.

In the dashboard this is the **Audit** page. It is a team page rather than an app tab, because
some entries, such as role changes and entitlements, name no app at all.

## The access log: looking is an act

Every read the control plane makes into a scope on someone else's behalf writes a row. That
covers the history, facet, cause, effect and same-call reads from chapter 10 and the denial
summary. This includes the dashboard's own delegated reads. A tenant's admin opening
a record in their own app is recorded, not just staff doing it.

The access log does not stay in the directory. The platform sweep's last phase ships unshipped
rows to R2 as newline-delimited JSON, stamps them as drained, and only then prunes them from the
directory. The order is the whole design. The sink must be durable before it returns, because
everything downstream treats a returned ship as proof the evidence exists outside the directory.
A sink that buffered and returned early would turn a retention policy into data loss. The R2
copies are pruned only if a retention period has been configured.

## Tier 2: the event stream leaves the scope

Chapter 2 made a trade: every scope is its own database, so no query crosses scopes. For
operational reads that is the right trade. For history it is a real cost. "Every invoice basis
exported across all tenants last quarter" should not be ten thousand reads and a fold.

So the platform keeps three tiers of data:

1. **Operational**: each scope's own SQLite. Live, exact, one scope at a time.
2. **Exact history**: every event from every scope, in one table, queryable with SQL.
3. **Telemetry**: sampled request data (chapter 10). Cheap, approximate, never evidence.

Tier 2 is **the lake**.

### How an event gets there

```
_substrat_outbox (each scope)
  │  platform sweep, event-drain phase: read undrained → ship → stamp drained_at
  ▼
control-plane worker ── EventSink ──▶ Cloudflare Pipelines stream
                                          │  INSERT INTO sink SELECT * FROM stream
                                          ▼
                                 Iceberg table kernel.events, in R2 (Data Catalog)
```

Tracing each hop:

**The drain is a sweep phase.** It runs after the reaps, before the access-log drain, over every
active scope, up to 200 events per scope per pass. A scope with more reports itself `incomplete`
rather than looping, and the next pass continues. The control plane reads undrained rows over
the vertical's `/internal` surface, ships them, and stamps them drained.

**Read, ship, stamp is at-least-once, on purpose.** Stamping before shipping would lose events
on any crash in between. Stamping after means a crash re-ships, so the lake can hold the same
event twice. Every row carries its event id, which makes the duplicate recognisable: **dedupe on
`id` before counting anything.**

**A row that will not decode is stepped over, never shipped.** Such a row can only come from a
restored dump, since the kernel writes every outbox row. The drain leaves it undrained and ships
the events behind it. It is never sent in a guessed-at form: the lake is append-only, so a wrong
row could not be taken back. The cost is a gap: that event is missing from the lake for as long
as the row stays unreadable. The sweep reports the skipped ids on every pass, and the event is
still in the scope, where `readHistory` returns it with a `decodeError`. The platform checks
every event against the published schema once more before it ships, so an app on an older
version, which does not check its own, cannot send a malformed event into the lake either. One
read looks at no
more than ten times its batch, so a scope whose next few thousand rows are *all* unreadable
ships nothing until the dump is repaired, and the report says so.

**Draining copies, it does not move.** The outbox is never pruned after a drain. The scope still
holds its full history for `readHistory` and every chapter 10 view. The lake is a second copy,
built for cross-scope questions.

**The schema is generated.** The lake's columns are derived from the outbox DDL by a tool, and
`lint:lake-schema` fails CI when the two disagree. So an envelope field added to the kernel
cannot silently fail to reach the lake. The pipeline's SQL is `SELECT *` for the same reason: a
record whose job is completeness should pass a new field through or fail loudly, not drop it
without a word.

```
id, type, schema_version, occurred_at,
tenant_id, scope_id, actor, entity_type, entity_id, pii_class,
subject_id?, payload?, authorization?, impersonation?,
operation?, version?, caused_by?, invocation_id?,
bytes
```

`drained_at` is not shipped, since it is a fact about the scope, not the event. `bytes` is added
by the shipper and is the row's serialized size. Chapter 12 explains why that column exists.

**Files roll on size or time**: parquet with zstd, at most 100 MB or 300 seconds, whichever comes
first. At real outbox volumes the timer always wins, so history reaches the lake about five
minutes after the drain ships it. The sweep itself runs every fifteen minutes. Freshness is
Tier 1's job.

### Rebuilding it

A lake table can need recreating, for example after a schema change. Because the outbox is never
pruned, nothing is lost. **Redrain** clears the drained stamp on events stamped before a given
instant, so the next sweeps ship them again. It is a staff-only, audited admin verb, and the
script that drives it works one scope at a time in bounded batches. The same verb will also
just count a window — how many rows a redrain would reopen, reopening none of them — which is
what the script's dry run reports before anyone commits to the re-send.

Provisioning the lake is deliberately **not** automated in CI. The script that declares the
bucket, table, stream, sink and pipeline runs as the operator's own `wrangler login`, checks the
live configuration for drift, and refuses to recreate a table that holds snapshots unless the
operator names that exact table as the one whose history they are discarding.

## Querying it: R2 SQL

The table is Iceberg in R2, so R2 SQL reads it directly. Here is the query the platform uses to
measure per-tenant event volume, with duplicates removed first:

```sql
SELECT tenant_id, SUM(bytes) FROM (
  SELECT DISTINCT tenant_id, id, bytes FROM kernel.events
) GROUP BY tenant_id
```

The same shape answers audit questions that no single scope can: every event a given actor
produced across every tenant, every change made under impersonation in a month, or every call
from a version later found to be faulty.

Here is what **is not built**, stated where you would otherwise assume it was:

- **No query gateway.** Nothing in the product runs R2 SQL on anyone's behalf. A tenant cannot
  query its own lake rows, and no dashboard or console view is backed by the lake. Today the
  lake is queried by whoever holds read credentials for the bucket, which means operators.
- **No tenant scoping on reads.** Every tenant's events share one table, and the sink cannot
  partition, so a tenant-scoped read would have to be enforced by the missing gateway.
- **No erasure in the lake.** Payloads ship as they are in the outbox, with `subject_id`
  alongside. That column exists so "delete every row for this subject" can be expressed as a
  query, but nothing runs it yet. Erasure is handled in Tier 1. **Until lake erasure is built,
  an erased subject's payloads survive in Tier 2**, and a deployment that drains to a lake has
  to account for that.
- **No lake retention policy** is configured. Snapshot expiry and compaction are the catalog's
  defaults.

## Exports

A tenant's data can be exported in full: every scope's dump, plus directory rows and, in
unmasked mode, the tenant's admin-log entries. That is the portability export. It is a staff
route today, not a self-service one.

## Denials stay home

The denial log has a `drained_at` column and no drain. Denials stay in their scope. They are
readable per scope, summarized by operation in the dashboard's Flow view (chapter 10), and
listed in the console's per-scope panel, but they do not reach the lake. A fleet-wide
"what was refused" question is still a fold over scopes.

---

**Next:** [Metering and billing →](/book/12-metering-and-billing)
