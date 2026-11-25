---
status: proposed
layer: plan
description: "How the platform's own data scales to 100,000 tenants. Every data set the control-plane directory holds today (69 tables, 52 transaction sites), where each goes, the numbers at 100, 10,000 and 100,000 tenants, Cloudflare's limits read from its documentation, the cost of an idle tenant, what breaks first, and a migration order in which every step ships and reverts on its own. Proposes K-68 to K-71 and D-77 to D-79. Design only."
---

# RFC: the platform's data at 100,000 tenants

**Status: proposed.** Design only. Nothing here is built, and no production data was changed to
write it. Production was read through Cloudflare's GraphQL analytics only. It proposes seven
decision records, [K-68](../decisions/K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md),
[K-69](../decisions/K-069-nothing-iterates-over-every-tenant-on-a-schedule-work-starts-from-an-event-or-the-owning-object-s-alarm.md),
[K-70](../decisions/K-070-data-that-grows-with-tenants-times-time-leaves-the-sqlite-objects-each-object-keeps-a-bounded-recent-window.md),
[K-71](../decisions/K-071-the-hosted-issuer-partitions-its-people-by-person-and-prunes-what-expires.md),
[D-77](../decisions/D-077-suspension-is-enforced-in-the-scope-projected-like-entitlements-not-at-the-edge.md),
[D-78](../decisions/D-078-a-directory-object-recovers-by-point-in-time-restore-and-an-incremental-export-not-a-daily-whole-copy.md) and
[D-79](../decisions/D-079-a-tenant-at-rest-costs-storage-only-and-every-platform-change-is-held-to-that.md),
all `proposed`. They wait for the owner. The router's edge read model, which is step 1 of the
migration order, is designed in its own pull request and record; this document cites it and does
not design it again.

## 1. The problem, measured

Everything the platform knows about its tenants lives in one Durable Object: `ControlPlaneDO`,
reached as `idFromName('control-plane')`
(`packages/adapter-cloudflare/src/control-plane-do.ts`, 7,333 lines). Measured read-only on
2026-11-24 and 2026-11-25:

| Measure | Value | Source |
|---|---:|---|
| Tables in the directory | **69**: 34 written in `DIRECTORY_DDL`, 35 more interpolated from 15 kernel-owned DDL fragments | source |
| Transaction sites | **52**: 51 `transactionSync` and one async `transaction` (`importDump`). One of them, `writeAndAudit`, is called from 47 places | source |
| Scopes in the directory | 311 on 2026-11-21, of which about 25 primary scopes in real use and 164 fork snapshots with no expiry | [#3313](https://github.com/substrat-run/substrat/issues/3313) |
| Tenants with routed traffic | 10 in 90 days; 4 to 9 on any one day | router Analytics Engine dataset |
| Directory stored bytes | **≈1.3 GB** at rest; **2.19 GB** during the daily backup copy | `durableObjectsSqlStorageGroups` |
| Directory growth | 0.54 GB on 2026-10-28 to 1.35 GB on 2026-11-23 | same |
| Requests to the directory | **419,156** on 2026-11-24; peak minute **3,149** (52/s) | `durableObjectsInvocationsAdaptiveGroups` |
| Routed requests (router) | **19,615** on 2026-11-24; peak minute **372** (6/s) | `workersInvocationsAdaptive` |
| Rows read / written by the directory | 29.7 M / 3.6 M on 2026-11-24 | `durableObjectsPeriodicGroups` |
| Directory active time | 5.6 hours on 2026-11-24 | same |
| The `*/15` pass | mean 275 s wall, 5.5 s CPU at ~311 scopes; 2 of 107 runs on 11-24 ended at 899 s (`internalError`) and 2 in `exceededMemory` | `workersInvocationsAdaptive`, `eventType: cron` |
| The control plane's own Cloudflare cost | $34.39 for 2026-11-01 to 11-20 (≈ $52 a month), 96 % of it rows written | #3316 backfill |

Three readings follow from the table.

1. **Routing is not what loads the directory.** The directory takes about 21 requests for each
   routed request. The load is the platform talking to itself: the scheduled pass, the control
   plane's API, the dashboard and the console.
2. **The scheduled pass already sits close to its limit.** A pass walks every active scope several
   times over. At 311 scopes its mean run is 31 % of the 15-minute wall limit a cron trigger has.
3. **The directory is mostly logs.** The 2026-11-18 backup copy held 1.58 M rows in 64 tables: 60 %
   staff access log, 15 % sweep runs, 10 % version migrations, 10 % ops failures, and about 90 K
   rows (5 %) for everything that is a fact about a tenant ([#3325](https://github.com/substrat-run/substrat/issues/3325)).

The object ran out of memory during the whole-directory backup (#2868, fixed by #2870) and the
scheduled pass ran out of memory in one connection's sweep (#3324, fixed by #3331). The daily
backup copy is 44 % of the directory's rows written (#3325), and the staff access log's drain
cannot keep up with its inflow (#3326). Each of these is a fix to one cause. The shape that
produces them is one object that every tenant's data and every platform job passes through. The
owner's target is 100,000 tenants.

## 2. The direction, and where the evidence pushes back

The owner agreed four rules in conversation. This document takes them as its frame and tests each
against the code and the numbers.

1. **No global object on the request path.** Routing is read from an edge read model (Workers KV
   plus the router's memory). Per-version policy (outbound, scope stores) is immutable per version
   and keyed by the version id. *Holds.* The measured split (§1) adds a point: removing the router's
   read takes about 5 % of the directory's requests away. It is necessary for the request path and
   does nothing for the rest of the load. Rules 2 to 4 are where the directory's load goes.
2. **Nothing iterates over all tenants on a schedule.** *Holds, with one correction.* "Nothing"
   has to include the cost and analytics reads: the daily cost rollup reads Cloudflare per object,
   and the stale-scopes report (#3393) reads every scope. Those are not wakes of tenant objects,
   and they read external datasets and an index, so they stay central. The rule is about waking or
   writing per-tenant state, not about reading an index.
3. **Anything that grows with tenants × time does not live in one SQLite database.** *Holds, and
   is sharper than stated.* The fixed part of the directory, one row set per tenant, is about
   25 KB per tenant, so 2.4 GB at 100,000 tenants (§5.2). That would fit under a 10 GB cap. What
   breaks the cap is the growing part: three billing rollups kept forever by default
   (`BILLING_ROLLUP_RETENTION_MONTHS = null`), the admin log (never pruned, by design), and the
   daily backup, which doubles the stored bytes while it runs, so the usable cap is about 5 GB.
4. **Fleet-wide changes are lazy or queue-driven, with visible progress.** *Holds.* The measured
   bottleneck is concrete: a listed vertical's promote reconciles at most
   `PROVISION_RECONCILE_BATCH = 50` scopes per pass (`packages/kernel/src/platform-sweep.ts:621`,
   no override in `apps/control-plane/wrangler.jsonc`). 10,000 installs take 50 hours, and
   100,000 take 21 days.

The proposed placement is also the owner's: a small global object; one directory object per
tenant; logs and meters to the lake with a recent window kept per tenant; the admin log written in
the object that makes the change and shipped onward; a small cross-tenant index for staff search;
suspension enforced as a scope-local flag projected like entitlements. Two refinements are argued
below. **The tenant's own status and name move to its directory object**, and the global object
keeps only what must be unique across tenants (§7.1). **The auth server needs the same treatment
and has its own record** (§10), because D-72 puts every managed tenant's people at one issuer.

## 3. Every data set in the directory today

Columns: **grows with** (T = per tenant, S = per scope, V = per vertical or version, T×t = tenants
times time); **read on** (the paths that read it); **transactions** (the sites in
`control-plane-do.ts` that write it, and whether any is read-decide-write, "RDW"); **goes to**
(the proposed placement: **G** the global registry object, **D** the tenant's directory object,
**L** the lake on R2, **AE** Analytics Engine, **X** the cross-tenant index, **KV** the edge
read model); and **retention** today → proposed.

### 3.1 The 34 tables in `DIRECTORY_DDL`

| Table | What | Grows | Read on | Transactions | Goes to | Retention today → proposed |
|---|---|---|---|---|---|---|
| `tenants` | id, slug, name, status, deleting stamp, provisioner | T | router (joined in `readRoute`), dashboard, console, every sweep phase | `createTenant`, `setTenantName`, `setTenantStatus`, `reapTenant` (all through `writeAndAudit`) | **G** for id and slug uniqueness; **D** authoritative for name and status; **X** projection | kept → kept; reaped tenants leave a tombstone in G |
| `scopes` | lifecycle, version, serving ref, forks, migration failure, archive | S | router, sweep (every phase), dashboard | `transitionScopeOrRefusal` (RDW: scope and tenant status), `deleteScopeDirectory` (RDW: `onlyWhile`), `markScopeProvisioned`, `moveScopeRow`, `setScopeExpiresAt`, `markScopeStoresFenced` | **D**; the routing columns to **KV** | kept → kept; reaped rows age out of D after the tenant's own reap |
| `scope_script_copies` | per-script copies of a scope (#1722) | S × moves | sweep (`sweepScopeScriptCopies`) | `backfillScopeScriptCopy`, `claimExpiredScopeScriptCopies` (RDW, **fleet-wide claim**), `settleScopeScriptCopy` | **D**, claimed by the tenant object's alarm | until drained → same |
| `hostnames` | hostname → tenant, scope, surface, region, issuance state | S (+ custom domains) | **router, every request**; reconcile sweep | `bindHostnameInDirectory` (RDW: uniqueness, scope state), `auditedHostnameUpdate`, `deleteHostname` | **G** owns uniqueness; **D** owns the binding; **KV** serves it | kept → kept |
| `tenant_stores` | per-tenant D1 database refs (#301) | T × vertical | deploy re-derive, reap | `putTenantStore` | **D**; the per-vertical binding list the uploader needs stays derivable from D | kept → kept |
| `blob_stores` | per-tenant R2 bucket refs (#473) | T × vertical | deploy, reap | `putBlobStore` | **D** | kept → kept |
| `verticals` | registry: owner, listing, capability flags, serving state | V | router (joined), promote, install, console | `insertVertical`, `updateVertical`, `deleteVertical`, `setVerticalServing` | **G**; per-version policy to **KV** keyed by version id | kept → kept |
| `vertical_versions` | every pushed version and its manifest (75 % of the old dump, #2868) | V × pushes | router (outbound, calls, scope stores joined per request), promote | `insertVersion`, `admitVersion`, `rejectVersion`, `setAdmission`, `recordMigrationsExtracted` | **G**, manifests to R2 by digest; per-version policy to **KV** | kept → manifests kept in R2, the row keeps the digest |
| `vertical_channels` | channel → version | V | promote, install, router (indirectly) | `promoteChannel` | **G** | kept → kept |
| `vertical_channel_history` | promote timeline | V × promotes | console | `promoteChannel` | **G** | kept → kept |
| `orgs` | tenant orgs | T | permission checks via tuples, dashboard | `insertOrg` | **D** | kept → kept |
| `_substrat_tenant_tuples` | tenant-level relationship tuples (K-21 tombstones) | T × people | provision projection, dashboard, peer/MCP admission | `writeTenantTuple`, `writeOrgTenantTuple`, `writeTenantSystemGrant`, `applyMembership`, `revokeAndFence` (RDW: fences) | **D** | kept (tombstones) → kept |
| `_substrat_roles` | role definitions and holders (K-55) | T | every role door | `defineRoleOrRefusal` (RDW: reserved keys), `assignTenantRole` (RDW) | **D** | kept → kept |
| `_substrat_entitlements` | plan, quota, expiry (D-41) | T | projection to scopes, gate | `grantEntitlement`, `revokeEntitlement` | **D**, projected to scopes as today | kept → kept |
| `_substrat_identity_pools` | provider topology | platform | sign-in | `registerIdentityPool` | **G** | kept → kept |
| `_substrat_connections` | connection rows | T × providers | connector sweep, dashboard, connect links | `insertConnection`, `revokeConnection` | **D** | kept (revoked kept) → kept |
| `_substrat_connection_secrets` | sealed credentials | connections | connector sweep and calls | `updateConnectionSecret` | **D**, sealed as today | replaced in place → same |
| `_substrat_connection_keys` | sealing keypairs | connections × rotations | sealing | rotation writes | **D** | retired rows kept → same |
| `_substrat_connection_grants` | grants to connections | connections × keys | provision, reconcile | `grantConnectionInDirectory`, `revokeConnectionGrantInDirectory` | **D** | tombstones → same |
| `_substrat_connector_state` | provider cursors and tokens | connections × keys | every connector sweep | `swapConnectorState` (CAS, RDW), `putConnectorStateFenced` (RDW) | **D** | replaced → same |
| `_substrat_identities` | external login → principal | T × people | sign-in resolution, dashboard `/api/me` | `linkIdentity`, `unlinkIdentity` | **D**; the cross-tenant "which tenants does this person belong to" read to **X** (§8.6) | kept → kept |
| `_substrat_access_log` | staff reads (K-24) | **T×t** (staff and sweep reads) | console | inserts on every audited read; `markAccessLogDrained`, `pruneAccessLog` | written in the object read (**D** or **G**), shipped to **L** | until drained (8 days behind, #3326) → hours |
| `_substrat_subject_keys` | per-subject DEKs for erasure (#37) | S × subjects exported | export, shred | export and shred paths | **D** (never beside the scope's own data, per the table's rule) | tombstones kept → same |
| `_substrat_admin_log` | the compliance witness of every change | **T×t** | console, dashboard Activity | `recordAdmin` inside `writeAndAudit` and the RDW sites | written in the object that changes (**D** or **G**), shipped to **L**; recent window kept in the object | never pruned → kept forever in L, a window in the object (K-70) |
| `_substrat_ops_failures` | what the platform could not do | **T×t** | console, failure digest | `recordOpsFailure` | **L** (+ recent window in **D**, platform-level rows in **G**) | 90 days → 90 days in L, 14 days in the object |
| `_substrat_issues` | grouped failure classes (#1233) | failure classes | console | `setIssueStatus`, ingest | **G** (platform operations), fed from L | 180 days → same |
| `_substrat_sweep_runs` | one row per unit outcome per pass | **T×t** (S × passes) | console Sweeps, cadence guards | `recordSweepRun` | the cadence guard's last row in **D**; history to **L** | 14 days → last outcome per unit in D, history in L |
| `_substrat_model_usage` | model calls through the platform host | **T×t** | billing, dashboard | intent drain | **D** window + **L** | 400 days → 35 days in D, 400 days in L |
| `_substrat_build_usage` | source builds | T×t (builders) | billing | build path | **D** window + **L** | 400 days → 35 days in D |
| `_substrat_markup_schedule` | markup over cost (#3316) | rows added by staff | billing | `insertMarkupRowAndAudit` | **G** for defaults; per-tenant rows in **D** | kept → kept |
| `scope_lifecycle_receipts` | what each deployment acknowledged (#1713) | S | lifecycle heal | heal writes | **D** | kept → kept |
| `scope_tenant_asks` | when the heal last asked | S | heal | heal writes | **D** | kept → kept |
| `scope_lifecycle_failures` | back-off per failing delivery (#3119) | S | heal | heal writes | **D** | until delivered → same |
| `lifecycle_revisions` | per-subject revision counters and the directory epoch | S + T | lifecycle delivery ordering | bumped in the same transaction as each change | **D** (scope and tenant counters live with what they count) | kept → kept |

### 3.2 The 35 tables in kernel-owned fragments

| Fragment (file) | Tables | Grows | Goes to | Note |
|---|---|---|---|---|
| `peer.ts` | `peer_bindings` | S × peers | **D** (a peer binding names two scopes of one tenant; a cross-tenant one is a dependency, K-64, and lives in both) | |
| `store-driver-releases.ts` | 8 tables: releases, approvals, current, holds, rebuilds, rollouts, rollout and revoke walks | drivers × releases | **G** | platform state, not tenant state; `holdStoreDriver`, `claimStoreDriverRebuild` are RDW |
| `version-migrations.ts` | `vertical_version_migrations` | V × migrations (165 K rows) | **G**, or R2 by version id | append-only, never changes once written |
| `vertical-scope-stores.ts` | 3 tables | V | **G** | declared by versions |
| `deployment-wire-auth.ts` | `vertical_wire_auth` | V | **G** | per deployment |
| `connect-links.ts` | `_substrat_connect_links` | T | **D** | `restoreConnectLink` |
| `impersonation.ts` | `_substrat_impersonations` | T×t (staff sessions) | **D** | `writeImpersonation`, `endImpersonation` |
| `system-switch-record.ts` | `_substrat_system_switches`, `_substrat_peer_switches`, `_substrat_switch_owed` | S | **D** | `writeSwitchIntent`, `restoreSwitchRecord` |
| `membership-fence.ts` | `_substrat_membership_fences` | T × people | **D** | `revokeAndFence` is RDW |
| `findings.ts` | `_substrat_findings`, `_substrat_finding_rules` | T × findings | **D** | `pruneFindings`, 180 days |
| `storage-gauge.ts` | 4 tables: scope storage, attempts, attachment storage, store storage | **S×t** | **D** window + **L** | 13 months today |
| `request-rollup.ts` | `_substrat_request_days`, `_substrat_request_day_reads` | **T×t** | **L** (+ the meter's window in **D**) | kept forever today |
| `cost-rollup.ts` | `_substrat_cost_days`, `_substrat_cost_day_reads`, `_substrat_scope_objects`, `_substrat_scope_object_reads` | **objects × dimensions × t** | **L**; the object-id map in **D** and **X** | kept forever today |
| `meter-days.ts` | `_substrat_meter_days`, `_substrat_meter_day_takes` | **T×t** (every tenant, every day) | **D** window + **L** | kept forever today |
| `vertical-owners.ts` | `_substrat_vertical_owners` | V × owner changes | **G** | |

### 3.3 Per-scope spine data (each scope's own object)

These already live where the rules want them: in the scope's Durable Object, bounded per scope.
They are listed because a placement decision for the directory must not move any of them back.

| Data | Bound | Note |
|---|---|---|
| `_substrat_outbox`, `_substrat_outbox_pruned` | 90 days after shipping to the lake (`OUTBOX_RETENTION_DAYS`) | the event log; the lake holds it for good |
| `_substrat_tuples`, `_substrat_roles`, `_substrat_entitlements`, `_substrat_tenant_tuples` | per scope | the projections D-41 and scope-local permissions read |
| `_substrat_platform_requests`, `_substrat_deliveries`, `_substrat_job_runs`, `_substrat_job_steps`, `_substrat_schedule_state` | per scope, pending work | the work a scope's alarm drains under K-69 |
| `_substrat_idempotency`, `_substrat_wire_nonces`, `_substrat_wire_nonce_count` | time-bounded | |
| `_substrat_attachments` and the attachment sweep tables | per scope | bytes in R2 |
| `_substrat_migrations`, `_substrat_migration_bookmarks` | per scope | K-33's PITR bookmark per upgrade |
| `_substrat_meter_days`, `_substrat_request_days`, `_substrat_cost_days` copies | none | the same kernel DDL is created in a scope; the directory's rows are the ones that grow |

What a scope does not have today is anything that wakes it when it has work and nobody calls it.
That is the change K-69 makes.

## 4. Who reads what, on which path

| Path | Reads today | Reads after |
|---|---|---|
| A request (router) | one `readRoute` RPC to the directory per request, uncached by K-26's deferral (`packages/adapter-cloudflare/src/route-resolver.ts`); a peer call adds `createPeerCallResolver` | the edge read model; no object |
| A request (in the scope) | the scope's own projections | the same, plus the suspension flag (D-77) |
| Dashboard and console | the directory, for everything | the tenant's directory object for a tenant's pages; the cross-tenant index for staff lists and search; the lake for history |
| The `*/15` pass | every phase walks the directory's scopes: copy claims, platform-intent drain per scope, storage gauge, reconcile, lake drain, cross-vertical delivery, orphan attachments, request and cost rollups, meter snapshot, lifecycle heal, hostname reconcile, directory backup, retention prunes, connector sweep | a sparse safety net over a due index (K-69); the cost rollup and the stale-scopes report read external datasets and the index |
| Push and promote | the directory, then 50 scopes per pass | the global registry; each scope on its next wake (K-69) |

## 5. The numbers at 100, 10,000 and 100,000 tenants

### 5.1 Assumptions

Each is stated so a reader can change it. The measured anchors are in §1.

- **1.7 scopes per tenant**: 1.5 live installs and 0.2 previews or forks, once forks expire
  (#3313). Today's 311 scopes are about 75 % forks with no expiry.
- **10 % of tenants have routed traffic on a given day**, and an active tenant sends **2,500
  routed requests a day** (today: 13,000 to 20,000 a day over 4 to 9 tenants with traffic).
- **Peak minute = 3 × the mean** at scale. Today's small fleet runs at about 27 ×, which is
  noise from a handful of tenants.
- **The directory takes 13.5 requests per scope per pass** from everything but the router
  (419,156 requests on 11-24, less the router's, over 311 scopes and 96 passes), and **60 % of a
  pass's directory traffic lands in its first 3 minutes** (#3326).
- **A pass runs 0.88 s of wall time per scope** (275 s at 311 scopes), **if it grows linearly
  with scopes.** Each phase walks the active scopes, which suggests it does. It was not measured
  across fleet sizes.
- **The access log takes 2.4 rows per scope per pass**, and its drain ships 500 per pass (#3326).
- **25 KB of fixed directory rows per tenant** (§5.2), and per tenant per day 0.55 KB of rows
  kept for good for every tenant (meter day, storage gauge) plus 3.5 KB for an active one (admin
  log, cost days, request days).

### 5.2 Fixed size per tenant, from the schema

Row sizes are estimated from the column lists, with 1.5 × for indexes. 5 people, 6 roles, 10
tenant tuples, 3 entitlements, 1.5 hostnames, 0.3 connections each with 5 state keys.

| Group | Per tenant |
|---|---:|
| tenant, scopes, hostnames, orgs, lifecycle receipts and revisions | ≈ 3.5 KB |
| roles, tuples, entitlements, identities, fences | ≈ 9 KB |
| connections, secrets, keys, grants, connector state | ≈ 4 KB |
| subject keys, impersonations, switches, peer bindings, findings | ≈ 1 KB |
| **Total with indexes** | **≈ 25 KB** |

Per vertical, not per tenant: `vertical_versions` keeps every pushed manifest, and
`vertical_version_migrations` holds 165 K rows already. Those grow with pushes and previews, not
with tenants, and move to R2 by digest.

### 5.3 Today's design, extrapolated

| | 100 tenants | 10,000 tenants | 100,000 tenants |
|---|---:|---:|---:|
| Scopes | 170 | 17,000 | 170,000 |
| Routed requests a day | 25,000 | 2.5 M | 25 M |
| Routed requests/s, mean / peak | 0.3 / 0.9 | 29 / 87 | 289 / 868 |
| …each of them one directory request today | yes | yes | yes |
| Directory requests per pass (not routing) | 2,295 | 229,500 | 2.3 M |
| Directory requests/s in a pass's first 3 minutes | 8 | **765** | **7,650** |
| Pass wall time (limit 900 s) | 150 s | 15,000 s (17 ×) | 150,000 s (167 ×) |
| Access-log rows in / shipped a day | 40 K / 48 K | 4 M / 48 K | 40 M / 48 K |
| Fixed directory rows | 2.4 MB | 244 MB | 2.4 GB |
| Rows kept for good, growth a day | 0.09 MB | 8.8 MB | 88 MB |
| Days until the usable 5 GB (10 GB less the backup copy) | never in practice | ≈ 555 | ≈ 30 |
| Daily backup copy | whole directory, in one transaction | same | same |
| Promote reconcile of a listed vertical installed by every tenant (50 a pass) | 1 pass | 50 hours | 21 days |

### 5.4 What breaks first

In order of tenant count, today's design:

1. **Already broken: the staff access log's drain.** It falls behind above about **205 scopes**
   (2.4 rows in per scope per pass, 500 out). At 311 scopes it runs eight days behind and is 60 %
   of the directory (#3326).
2. **The scheduled pass's 15-minute wall limit**, at about **1,000 scopes, roughly 600 tenants** at
   1.7 scopes each, if wall time stays linear in scopes. The mean pass is at 31 % of it now; two
   runs on 11-24 already ended at 899 s.
3. **One object's request rate**: the pass's opening burst reaches the documented soft limit of
   1,000 requests per second at about **22,000 scopes, roughly 13,000 tenants**, before any route
   read is added.
4. **One object's 10 GB**: about 18 months after 10,000 tenants, a month after 100,000, with the
   daily copy taking half.
5. **Custom hostnames**: 50,000 is the most a non-Enterprise Cloudflare for SaaS plan allows (§6).
   It caps tenants with their own domain, not tenants.

The order matters for the migration: the pass (2) breaks before the request path does, which is
why per-tenant sweeps (K-69) are worth more than the router's read model at today's size, even
though the read model is the first step.

### 5.5 After the split, at 100,000 tenants

| Object or service | Rows / bytes | Requests | Notes |
|---|---|---|---|
| Edge read model (KV + router memory) | ≈ 150 K hostname keys + one key per version, ≈ 150 MB | 289/s mean, 868/s peak, mostly from memory | KV reads are $0.50 per million if every request read KV (25 M a day ≈ $12.50 a day); the router's memory cache is what keeps that small. Designed in step 1's own record. |
| Global registry object | ≈ 100 K tenant rows, 150 K hostname rows, verticals, versions without manifests, ≈ 150 MB | writes on tenant create, hostname claim, push, promote: well under 1/s; staff reads | no request-path reads, no sweep reads |
| Tenant directory object | ≈ 25 KB fixed + a 35-day window ≈ 100–150 KB | an active tenant's dashboard and drains: far under 1/s | one per tenant, 100,000 objects |
| Cross-tenant index (D1) | 100 K rows × ≈ 0.5 KB = 50 MB | staff search, reports | eventually consistent; 10 GB cap far away |
| Lake (R2, Iceberg) | admin log, access log, ops failures, sweep runs, model and build usage, cost, request and meter days | written by shipping; read by reports | the outbox stream exists (#1334) |
| Analytics Engine | router datapoints | 25 M datapoints a day | $0.25 per million beyond 10 M a month; three months' retention |
| Alarms, connector sweeps | 30,000 connections (0.3 per tenant) | 96 a day each = 2.9 M a day (33/s), ≈ $13 a month in requests + ≈ $86 in `setAlarm` rows; with back-off on unchanged providers to 12 a day: 360 K a day, ≈ $13 a month all in | per-connection back-off (#3331, #3376) is what makes this cheap |
| Alarms, scope work | only scopes with pending work | a burst is the tenants doing things | an idle scope sets none |
| Safety net | reads the due index, not the tenants | one small query per run | §7.4 |

### 5.6 Cost per idle and per active tenant, at list price

Prices from §6, read 2026-11-25. Included allowances are left out, so these are a cost basis, not
an invoice.

**An idle tenant after the split** holds a directory object (≈ 25 KB), a home scope object at rest
(≈ 200 KB of spine, migrations and an empty app, estimated), two KV keys, a registry row, an index
row and a few issuer rows. At $0.20 per GB-month for Durable Object storage, $0.50 for KV and
$0.75 for D1: **≈ $0.00005 a month**, about **$0.0006 a year**. It sets no alarm and wakes for
nothing. Three things add to it, each a plan decision rather than a storage cost:

- **A custom domain**: $0.10 a month for each above the first 100, and at most 50,000 on a
  non-Enterprise plan.
- **A per-tenant D1 database or R2 bucket** (`tenant_stores`, `blob_stores`): free up to 100,000
  each on the account, then $0.10 a month each.
- **Logs** at rest: none for an idle tenant.

**An idle tenant today** costs about **$0.38 a month** at list price, nearly all of it rows written
in the directory: 7,300 rows per scope per day (≈ 2,000 from the pass's bookkeeping and access
log, ≈ 5,300 from the daily copy), plus about 1,400 directory requests and 96 wakes of its scope
per scope per day. That is roughly **7,600 ×** the target, and it is paid whether or not anybody
uses the tenant. At 100,000 tenants it would be about $38,000 a month, if the object survived.

**An active tenant**, measured: the four tenants with live traffic in November cost about $1.90,
$2.80, $4.10 and $44 a month at list price (preview forks excluded; those are a separate, larger
cost tracked in #3316). Modelled for 2,500 requests a day: Workers for Platforms requests ($0.30 per
million, one per dispatch chain), CPU ($0.02 per million ms, about 12 ms a request), DO requests
($0.15 per million), rows written ($1.00 per million) and duration: about **$0.35 to $0.50 a month**
before logs. The measured figures are higher because real tenants read and write more rows per
request than the model assumes. Rows written dominate both.

## 6. Cloudflare's limits, verified

Every row was read on **2026-11-25** from the page linked; "modified" is the page's own
`dateModified`. Prices are list prices on the Workers Paid plan.

| Limit | Value | Source (modified) |
|---|---|---|
| SQLite-backed DO storage per object | **10 GB**; unlimited per account and per class | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (2026-11-13) |
| DO memory | 128 MB per isolate, shared by objects in the same isolate | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (2026-11-19), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (2026-11-13) |
| DO CPU per request or alarm | 30 s default, configurable to 5 min | DO limits |
| One object's throughput | **soft limit of 1,000 requests per second**, after which it queues and then answers "overloaded" | DO limits, FAQ |
| DO classes per account | 500 | DO limits |
| DO SQL | 100 bound parameters, 100 KB statement, 8 MB row, 50-byte LIKE/GLOB pattern | DO limits |
| DO pricing | requests $0.15 per million (each RPC call and each alarm), duration $12.50 per million GB-s, rows read $0.001 per million, rows written $1.00 per million (each `setAlarm` is one row written, deletes count), storage $0.20 per GB-month | DO pricing |
| DO point-in-time recovery | **any point in the past 30 days, the whole database, in place**: `getBookmarkForTime`, `onNextSessionRestoreBookmark` then restart; the call returns a bookmark that undoes the restore. No restore into another object is documented | [SQLite storage API, PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) (2026-09-21) |
| DO alarms | one alarm per object at a time; retried with exponential back-off from 2 s, up to 6 retries; 15 min wall per alarm | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) (2026-11-18), Workers limits |
| D1 size | **10 GB per database**; 1 TB per account; 1,000,000 databases, 100,000 included then $0.10 a month each | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (2026-11-20) |
| D1 transactions | `batch()` runs its statements as one SQL transaction and rolls back on failure. No interactive transaction is documented, and the import guide says to remove `BEGIN TRANSACTION` and `COMMIT` | [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) (2026-06-22), [import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) |
| D1 read replication | read replicas only through the Sessions API, which gives sequential consistency within a session (bookmarks) | [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) (2026-08-10) |
| D1 per invocation | 1,000 queries per Worker invocation; 30 s per query; Time Travel 30 days | D1 limits |
| D1 pricing | rows as DO; storage $0.75 per GB-month after 5 GB | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (2026-10-30) |
| KV consistency | **eventually consistent**: a write is usually visible at once where it was made, and may take **60 seconds or more** elsewhere; "not ideal" where values must be read and written in one transaction | [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/) (2026-04-21) |
| KV writes | **1 write per second to the same key**; unlimited writes to different keys; 1,000 operations per invocation; 25 MiB values | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) (2026-10-30) |
| KV pricing | reads $0.50 per million, writes $5.00 per million, storage $0.50 per GB-month | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) (2026-11-24) |
| Subrequests per invocation | **10,000 by default, configurable up to 10 million**; internal services match the configured limit | Workers limits |
| Cron triggers | 1,000 per account; wall time **15 min** per run; CPU 5 min (default 30 s) for intervals under an hour, 15 min for an hour or more; a trigger change can take 15 min to propagate | Workers limits, [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (2026-11-18) |
| Queues | 5,000 messages/s per queue; 128 KB per message; 100 per batch; retention up to 14 days; 25 GB backlog per queue; 250 concurrent consumers; 15 min per consumer run; $0.40 per million operations after 1 million | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) (2026-10-30), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) (2026-10-30) |
| Analytics Engine | 20 blobs, 20 doubles, 1 index (96 bytes) per data point; 250 data points per invocation; **three months' retention**; no charge for cardinality; $0.25 per million data points after 10 million a month | [AE limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) (2026-04-23), [AE pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) (2026-04-23) |
| Workers for Platforms | unlimited scripts; no limit on DO namespaces; 8 tags per script; $25 a month with 20 M requests, 60 M CPU ms and 1,000 scripts, then $0.30 per million requests, $0.02 per million CPU ms, $0.02 per script; one request billed per dispatch chain | [WfP limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/) (2026-11-17), [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) (2026-04-21) |
| Custom hostnames | 100 included, **$0.10 each a month after**, **at most 50,000 below Enterprise** | [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) (2026-08-14) |
| GraphQL analytics | 300 queries per 5 minutes per user; per dataset (read from the API's `settings` node for the four datasets the cost rollup reads): **10,000 rows per page, 32 days per query, 90 days back** | [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/) (2026-11-23), `settings` node |
| Workflows | 50,000 concurrent instances per account; 300 creations/s per account; 1 GB state per instance; 10,000 steps default | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) (2026-11-10) |
| R2 | $0.015 per GB-month; Class A $4.50 and Class B $0.36 per million; free egress; 100,000 buckets included | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (2026-10-30) |

Two facts in the table change the design.

- **KV's one-write-per-second-per-key and 60-second visibility** mean a route key must never be a
  place where a decision is enforced. A suspension or a deleted hostname may still be served by
  the edge for a minute or more. That is why suspension is enforced in the scope (D-77), and why
  the global registry, not KV, owns hostname uniqueness.
- **D1 has no interactive transaction.** A read-decide-write (a uniqueness check, a reserved-key
  refusal, a CAS) cannot be written as "read, decide in code, write" against D1. It has to be one
  statement, or a `batch()` whose statements decide in SQL, or it lives in a Durable Object. That
  rules D1 out for the registry and for any tenant's directory, and leaves it for the index, which
  is written by projection and read by staff.

## 7. The design

### 7.1 Three kinds of object, and what each owns

**The global registry** (one Durable Object, `idFromName('registry')`). It owns only what must be
unique or must be the same for every tenant:

- tenant ids and slugs (a claim, not the tenant's record);
- hostname uniqueness (`hostname` → tenant, scope, surface; claimed, bound, released);
- verticals, versions (manifests in R2 by digest), channels, channel history, scope stores, wire
  auth, vertical owners;
- store driver releases, holds and rollouts; identity pools; markup defaults; issue groups.

It is written when a tenant is created or reaped, a hostname is claimed or released, a version is
pushed or promoted, or staff act on platform state. It is never read on the request path and never
walked by a schedule.

**One directory object per tenant** (`idFromName('tenant:' + tenantId)`). It owns everything that
is the tenant's: its status and name, scopes, the binding half of its hostnames, roles, tuples,
orgs, entitlements, identities, connections and their sealed secrets, keys, grants and connector
state, connect links, impersonations, switches, fences, findings, tenant and blob store refs,
subject keys, lifecycle receipts and revisions, and a recent window of its admin log, access log,
ops failures, sweep outcomes, usage and meters (K-70). Every read-decide-write in today's
directory that concerns one tenant stays one transaction, because it stays in one object.

**Scopes** are unchanged, and gain an alarm (K-69) and a suspension flag (D-77).

Beside them, **the edge read model** (KV and the router's memory, step 1's record), **the lake**
(R2 and Iceberg, already fed by the outbox stream), **Analytics Engine** (the router's datapoints,
already written), and **the cross-tenant index** (one D1 database, one row per tenant and one per
hostname, projected).

This is a placement of the **Cloudflare adapter's** objects. It renames none of D-75's five
concepts. The tenant's directory object is the platform's record of a tenant, not an app's scope,
and in particular not D-75's **home scope**, which is an app's scope holding what concerns a whole
tenant within that app. A home scope stays app data; the tenant directory object stays platform
data.

### 7.2 The 52 transaction sites after the split

| Group | Sites | After |
|---|---|---|
| Schema and maintenance | `armVersionMigrationsBackfill`, `applyDirectorySchema` (2), `addColumn`, `rebuildAtomically`, `ensureAdminLogTenantNullable`, `ensureSweepRunsIntentKind`, `ensureDirectoryColumns` (8) | run in every directory object, each its own schema |
| Backup and restore | `snapshotDirectory`, `importDump` (2) | retired for the whole directory; per object, D-78 |
| Store drivers | `recordStoreDriverRevokeWalk`, `storeDriverState`, `storeDriverDeclarations`, `storeDriverRolloutPending`, `storeDriverRolloutWalked`, `holdStoreDriver`, `claimStoreDriverRebuild`, `advanceStoreDriverRebuild` (8) | **G**, unchanged in shape |
| A tenant's state | `transitionScopeOrRefusal`, `defineRoleOrRefusal`, `assignTenantRole`, `deleteScopeDirectory`, `backfillScopeScriptCopy`, `claimExpiredScopeScriptCopies`, `settleScopeScriptCopy`, `applyMembership`, `revokeAndFence`, `restoreConnectLink`, `grantConnectionInDirectory`, `revokeConnectionGrantInDirectory`, `writeSwitchIntent`, `restoreSwitchRecord`, `swapConnectorState`, `putConnectorStateFenced`, `settleUnrecordedOutcome`, `pruneFindings` (18) | **D**, still one transaction each. `claimExpiredScopeScriptCopies` stops being a fleet-wide claim and becomes the tenant's own |
| Rollups and logs | `recordScopeStorage`, `recordRequestDay`, `pruneRequestDays`, `recordCostDay`, `recordCostContainers`, `pruneCostDays`, `recordScopeObject`, `recordMeterDay`, `pruneMeterDays`, `recordOpsFailure`, `recordSweepRun` (11) | a window in **D** and shipping to **L**; the cost rollup writes **L** directly |
| Hostnames | `bindHostnameInDirectory`, `auditedHostnameUpdate` (2) | **cross-object**: claim in **G**, bind in **D** (§7.3) |
| Vertical scope stores | `verticalScopeStores` (1) | **G** |
| `writeAndAudit` | 1 site, 47 callers | split by caller: 18 to **G** (versions, verticals, channels, store driver releases, identity pools, markup defaults, issues), 25 to **D** (entitlements, connections, orgs, identities, tuples, impersonation, stores, scope marks), 2 log housekeeping to **L**, and **4 cross-object**: `createTenant`, `setTenantStatus` (projection only), `reapTenant`, `deleteHostname` |

So, of every write path, six cross from one object to another: tenant create, tenant reap, tenant
status (a projection), hostname bind, hostname update and hostname delete. A provisioner tenant
creating a managed tenant (#412) is a seventh, from one tenant's object to another's.

### 7.3 Crossing two objects: the intent first

K-64's rule is that nothing crosses a Durable Object's boundary inside a transaction. It was
written for scopes and stores; K-68 applies it to the platform's own objects. Each crossing commits
its intent in the object that decides, then host code makes the second call, then the first
object records the outcome. A crash between leaves an intent that a retry or the safety net
finishes, never a half that nobody owns.

- **Hostname bind.** The tenant's object records `binding: requested` (intent and admin row, one
  transaction). Host code asks the registry to claim the hostname for (tenant, scope). The
  registry's claim is one transaction and refuses a hostname another tenant holds. The tenant's
  object records `bound` and projects to KV. A claim the tenant never confirms is released by the
  registry after a lease; a confirmed binding whose claim is missing is a safety-net finding.
- **Tenant create.** The registry claims id and slug (lease). The new tenant's object is created
  with its record, its owner seat and its admin row. The registry confirms. A managed tenant's
  provisioner records its `provision-tenant` intent first, exactly as today's platform-intent
  drain does.
- **Tenant reap.** The tenant's object drives it: scopes reaped one by one by its own alarm,
  hostnames released in the registry, then the slug. The registry keeps a tombstone so an id is
  never reused.
- **Tenant status.** Authoritative in the tenant's object, which fans out to its scopes (D-77) and
  projects to the registry and the index for lists. Neither the registry nor the index decides
  anything from it.

### 7.4 Work without a pass (K-69)

| Work | Today | After |
|---|---|---|
| Platform-intent drain | every pass walks every active scope; the router's kick is the fast path | the scope's alarm when it enqueues; the kick stays; the safety net finds a scope with an old pending row through the due index |
| Cross-vertical events, lake drain | pass phases over every scope; kick by #3388 | the producing scope kicks its own delivery and shipping on commit (#3388's pattern), and sets an alarm while anything is undelivered; Queues and Workflows stay #3367's and #3369's questions |
| Connector sweeps | every pass, every connection (back-off since #3331) | the tenant object's alarm per connection, with per-connection back-off (#3331) and one sweep per connection, not per scope (#3376) |
| Copy claims, reaps, retention prunes, lifecycle heal | pass phases | the tenant object's alarm, set by the event that makes the work due (an archive sets the reap date, a failed delivery sets its retry) |
| Storage gauge | read for every scope the drain woke | read by the scope when it is awake for other reasons, at most daily, shipped to the lake |
| Meter snapshot | one row per tenant per day in the directory, for every tenant | written by the tenant's object on its first wake of a UTC day; a day with no wake has no usage, and the meter reads that as zero |
| Request and cost rollups | read once a day centrally, written to the directory | read once a day centrally, written to the lake |
| Directory backup | daily whole copy | D-78 |
| Promote reconcile | 50 scopes a pass | each scope on its next wake; a queue warms active scopes; progress counted per (vertical, version) |

**The due index.** A table in the registry (or in D1, owner's choice) with one row per object that
has work due: object id, due time, kind. An object writes its row when it sets an alarm and clears
it when the alarm finishes its work. The safety net runs hourly, reads rows due more than an hour
ago, and kicks those objects. It costs one small query when everything is healthy, whatever the
number of tenants. It is the "sparse" in the owner's rule 2, made measurable: the safety net's work
is the number of objects whose alarm failed, not the number of tenants.

### 7.5 Fleet-wide changes, lazy (K-69)

A promote of a listed vertical already uploads the new bundle once onto the stable script (K-33),
and every scope already runs its pending migrations the first time it is called after the upload
("the first operation after a promote runs the whole pass",
`packages/adapter-cloudflare/src/scope-do.ts`, `ensureMigrations`).
What remains central is the provision-hook reconcile (#1172, #1653). Under K-69:

- The promote records the new serving version in the registry. Nothing else is written per scope.
- Each scope compares its applied version with the serving one on its next wake, and runs its
  reconcile before the request it woke for, inside the migration pass K-33 already runs.
- A queue warms scopes that were active in the last 30 days (from Analytics Engine), so they do not
  pay the reconcile on a person's request. Its consumer calls each scope once; at 5,000 messages a
  second per queue that is 100,000 scopes in under a minute of sending.
- Progress is a count per (vertical, version): each scope, after reconciling, writes one Analytics
  Engine data point. The console shows the count against the number of installs from the index.
- A fleet re-upload (a platform entry change, #1893) and a backfill go the same way: a version or
  a backfill id recorded once, applied on next wake, warmed by a queue, counted.

An idle scope that never wakes never pays for the change. That is the point. It is also the cost:
a scope may sit for months on an old version, so a version may only be retired once the count says
no scope still runs it, or once a forced warm-up has reached every scope (§12).

## 8. Questions the split creates, and their answers

### 8.1 Staff lists and search

From the **cross-tenant index**: one D1 database, one row per tenant (id, slug, name, status,
created, owner email hash, plan, counts of scopes and hostnames, last activity day) and one per
hostname. Each tenant object projects its row after a change, through an outbox in the object, so
a lost projection is re-sent. Staff search reads D1 (sequential consistency within a session, with
read replicas through the Sessions API). It is eventually consistent, and says so: every list
returns the time its rows were projected. A staff action opens the tenant's own object, which is
authoritative. At 100,000 tenants the index is about 50 MB.

### 8.2 Platform-wide sweeps and reports

Reports such as the stale-scopes report (#3313, #3393) read the index, Analytics Engine and the
lake, never the tenant objects. A structural finding that needs one tenant's detail opens that
tenant's object. The daily report becomes one query over the index plus one Analytics Engine query,
whatever the fleet size.

### 8.3 Billing and cost rollups

- **Cost** (#3316, #3329, #3342): the daily read of Cloudflare's datasets stays central, because
  that is where the data is. At 170,000 scope objects and five dimensions, a day is about 850,000
  rows, 85 pages of 10,000, inside the 300-queries-per-5-minutes quota. Its rows go to the lake, not
  to a SQLite object. Attribution needs the object id → scope map, which moves from
  `_substrat_scope_objects` in the directory to the tenant object (authoritative) and the index (for
  the join). Containers and fork-copy cost (#3342) attach the same way.
- **Meters**: the tenant object keeps its current billing period and the one before (35 days of
  day rows) and ships each closed day to the lake. An invoice is computed from the lake.
- **Markup**: defaults in the registry, per-tenant rows in the tenant object.

### 8.4 Admin log reads

The admin row is written **in the same transaction as the change, in the object that makes it**:
the tenant object for a tenant's change, the registry for a platform change. That keeps today's
`writeAndAudit` guarantee (the change and its row commit together). Each object ships its rows to
the lake through an outbox, the way scopes already ship events, and keeps a 35-day window. A
tenant's Activity page reads its own object; history beyond the window and every staff-wide query
reads the lake. A crossing change writes a row in each object it touches, linked by the intent id.

The staff access log (K-24) follows the same rule, and #3326's policy question becomes easier to
answer: an access-log row records a person reading a tenant's data, written in that tenant's
object. The platform's own bookkeeping reads, which are 95 % of today's inflow, are reads of a
tenant's directory object by the tenant's own alarm, and the proposal is to stop logging them as
staff access (an open choice in K-70).

### 8.5 Hostname uniqueness

The registry owns it (§7.3). KV serves the result and is never asked whether a hostname is free.
50,000 custom hostnames is the non-Enterprise cap; platform hostnames under the wildcard
certificate do not count against it.

### 8.6 A vertical listed to many tenants

Promote: §7.5. Install: reads the vertical from the registry, writes only the installing tenant's
objects. The verified figure today is 50 scopes per pass (`PROVISION_RECONCILE_BATCH`, default,
not overridden), which K-69 replaces.

### 8.7 People across apps (K-63)

K-63 already puts a tenant's people in one app, the master, inside that tenant. The directory's
part is the identity link (`_substrat_identities`, external login → principal), which is a
tenant's and moves to its object. One read is cross-tenant: "which tenants does this login belong
to", for the dashboard's team switcher and for a provisioner's managed tenants (D-72). It is the
index's: one row per (login, tenant), projected by the tenant object. It is the only per-person
row the index holds, and the K-46 erasure plan must reach it.

### 8.8 Connections shared across scopes

A connection is `(tenant, vertical, provider)` and spans the tenant's scopes, so it lives in the
tenant's object with its secret, keys, grants and state. Grants to scopes are projected into the
scopes, as today. #3376's sweep role per connection fits exactly: the tenant object sweeps each
connection once and lands the results in each bound scope. A connector's network part still runs
outside any object (D-73, K-62); the tenant object's alarm only decides that a sweep is due and
records its outcome.

## 9. Suspension (D-77)

KV is eventually consistent (§6), and the router reads KV. So a route can serve a suspended tenant
for a minute or more after the suspension. D-77 enforces suspension where D-41 enforces
entitlements: in each scope, from a projected flag. The tenant object sets its status, writes its
admin row, and fans the flag out to each scope (an intent per scope, delivered by its own retry, as
entitlement fan-out is). A scope with the flag answers every request with the suspension refusal,
before any operation runs. The route's KV entry is updated too, so the edge stops dispatching within
its propagation window, which saves the work but is not what enforces. A scope that has not
received the flag yet keeps serving until it does, so the fan-out's own delivery is the bound. A
suspension that must be immediate, such as a security incident, waits for every scope to
acknowledge before the console reports it done, and shows which scopes have not.

This settles K-26's "suspension latency" note and D-41's "settle once for both" in the same way:
the edge caches, the scope decides.

## 10. The auth server

**What it stores today.** `demos/auth-server` runs Better Auth in one Durable Object per issuer
(`AuthServerDO`, `idFromName` of the routed scope; `src/routes.ts`). That object holds 25 tables:
Better Auth's `user`, `session`, `account`, `verification`, `jwks`, the OAuth provider's clients,
resources, consents, refresh tokens, access tokens and client assertions, and the issuer's own
`place_app`, `place_member`, `managed_client`, `delegation_grant`, `identity_provider`,
`scim_user`, `user_activity`, `user_client_activity`, `sign_in_attempt` (pruned on write) and
configuration.

**What breaks.** D-72 lets a provisioner put its managed tenants' people at one of its own team
issuers. A provisioner with 100,000 managed tenants then has every one of their people in one
object. With 5 people each: 500,000 users, their accounts and places, every session, every refresh
and access token. The issuer's own code deletes OAuth tokens only when a client is removed; no code
in `demos/auth-server/src` prunes expired sessions or tokens, and whether Better Auth deletes them
itself was not verified. If 20 % of 500,000 people sign in on a day and each sign-in leaves a token
row of about 400 bytes kept for good, that is 14.6 GB a year: over the 10 GB cap within a year from
tokens alone, before users and places. Sign-in rate is the second limit: tens of requests a second
on average and hundreds at peak, every one in the same object, which also serves token refresh and
the account page.

**K-71.** The issuer partitions its people. A small configuration object keeps clients, resources,
keys, providers, branding and places' definitions, and is read-mostly and cacheable. People live in
a fixed set of partition objects keyed by a hash of the normalized email or subject (for example 256
partitions to start, re-split by doubling), each holding its users, accounts, sessions, tokens,
consents and memberships. A unique-email claim is a single-object transaction in the partition the
email hashes to, so uniqueness needs no global object. Each partition sets an alarm while it holds
expiring rows and deletes them when they expire. An adapter for Better Auth that routes each model's
reads and writes to the right partition is the work; whether Better Auth's queries all key on a
partitionable column is the first thing to verify.

A per-tenant issuer (one auth-server install per tenant, the default without D-72's manager) scales
already, because each tenant's people are in that tenant's issuer object. K-71 is for the shared
issuers: the platform's own sign-in and a provisioner's team issuer.

## 11. Self-host: adapter-sqlite keeps one database

The split is the Cloudflare adapter's. `adapter-sqlite` keeps one SQLite database for the
directory, one transaction for a crossing change, and its in-process scheduler; a self-host with
100 tenants has no reason to pay for objects it does not need.

What the shared contract suites must hold, so the two adapters stay one platform:

1. **Isolation of tenant reads**, as today: no `HostAdmin` call for tenant A returns B's rows.
2. **Hostname uniqueness under concurrent binds**, across tenants: two tenants binding the same
   hostname at once leave exactly one bound.
3. **The end state of every crossing change**, not its steps: after a tenant create, a hostname
   bind, a tenant reap or a suspension, the observable state is the same on both adapters. The
   Cloudflare adapter adds a fault-injection suite of its own that crashes between the two halves
   and asserts the retry or the safety net converges.
4. **An admin row for every audited change**, readable for the tenant at once, and staff-wide
   within a declared bound.
5. **Suspension refuses in the scope**, whatever the route says.
6. **Lazy fleet changes converge**: a promote reaches a scope on its next call, and the progress
   count reaches the install count once every scope has been called.

**Does `HostAdmin` change?** Mostly not. It has about 260 members and about 55 list reads; nearly
all take a tenant and keep their meaning. Two additive changes:

- **Cross-tenant reads say when they were true.** `listTenants`, `listScopes` without a tenant,
  `listHostnames` without a tenant, staff-wide `listAdminLog`, `listOpsFailures`, `listSweepRuns`,
  `listCostDays` and the identity-membership reads gain an `asOf` (and a `consistency: 'eventual'`
  marker) in their result. On SQLite `asOf` is now.
- **Fleet-wide writes return a progress handle.** A promote returns the reconcile's (vertical,
  version) and a new read returns its count. On SQLite the count is reached when the scheduler's
  pass has called every scope.

No method is removed. A `HostAdmin` caller written for one directory keeps working on the split,
with lists that may be up to the projection's lag behind.

## 12. Migration order

Each step ships alone, can be reverted alone, and leaves production working. A human checkpoint
applies wherever data moves (the migration-diff checkpoint), and every step that moves data has a
dual-write and verify phase before the cut-over.

**Step 0. Stop the bleeding (in flight or small).** These are each a separate issue and need none
of the design:
- #3326: drain the access log in more than one batch a pass, and decide whether the sweep's own
  bookkeeping reads are logged (K-70's open choice).
- #3325: stop copying the whole directory into itself every day (D-78's first half: copy
  append-only tables by reference, or exclude the logs from the copy).
- #3313: forks get an expiry, so scope count tracks tenants (#3393 reports them already).
- Bound the three billing rollups (`BILLING_ROLLUP_RETENTION_MONTHS`) once the lake holds their
  history.
*Revert:* each is a config value or a small change.

**Step 1. The router's edge read model (in progress elsewhere).** KV plus memory, per-version
policy keyed by version id, the directory dual-written into KV and compared before the router reads
it. Its own record and pull request; this RFC adds only that the projection's source will move from
the one directory to the registry and the tenant objects in step 3, so the projection writer should
be one function both can call. *Revert:* the router reads the directory again.

**Step 2. Logs and meters out.** The admin log, access log, ops failures, sweep runs, model and
build usage, cost, request and meter days ship to the lake through an outbox in the directory (the
same shipping the scope outbox uses), and the directory keeps a 35-day window. Reads beyond the
window move to the lake first, then the prune is switched on. This is where most of the directory's
bytes and most of its rows written go. *Revert:* switch the prune off; the rows are still there.
Includes D-78's export (§13) for the registry part.

**Step 3. Per-tenant directory objects (dual-write, verify, cut over).**
- 3a. Create the registry and the tenant object classes beside `ControlPlaneDO`, empty.
- 3b. **Dual-write**: every write to a tenant's rows in the directory also writes the tenant's
  object, after the directory's transaction commits, from an outbox in the directory (so a failed
  second write is retried, not lost). Registry rows the same.
- 3c. **Backfill** each tenant's rows into its object, tenant by tenant, from a snapshot cursor, and
  record per tenant that it is filled.
- 3d. **Verify**: a comparison job reads both, per tenant, and reports differences. The router's
  projection (step 1) is fed from the new objects for tenants that verify, and compared.
- 3e. **Cut over reads per tenant**, behind a per-tenant flag in the registry: a tenant's reads go
  to its object. Writes then go to the tenant object first, with the directory dual-written as the
  fallback, for a period the owner sets.
- 3f. **Cut over writes**, stop dual-writing, keep the old rows read-only for the rollback window,
  then drop them.
- Includes **#1343**: the dashboard's own `ControlPlaneDO` is retired into the same target, not into
  the old shared directory. Its brief's phases (shadow read, continuous copy, cut over with a reverse
  copy) are this step's phases applied to the dashboard's identity links, which move to the tenant
  objects directly. Doing #1343 first against the old directory would move the same data twice.
*Revert:* flip the per-tenant flag back; the directory was written all along until 3f.

**Step 4. Per-tenant and per-scope sweeps.** Each phase of the pass moves to alarms one at a time,
in the order of §5.4's breakage: the platform-intent drain and lake drain first (they wake every
scope), then the connector sweep (#3331, #3376), then reaps, copies, the lifecycle heal and the
gauge. Each phase runs in both places for a while, with the alarm path doing the work and the pass
checking that it found nothing left; then the pass's phase is replaced by the safety net's query.
*Revert:* per phase, the pass's phase is switched back on.

**Step 5. Lazy fleet-wide operations.** Promote reconcile, fleet re-upload and backfills as §7.5,
with the progress count in the console, then `PROVISION_RECONCILE_BATCH` and its phase are removed.
*Revert:* the batch phase is still there until the count has been watched through several promotes.

**Beside them: the auth server (K-71)**, its own track. Token and session pruning first (small, and
needed at any size); partitioning when a shared issuer is measured approaching either limit.

## 13. Recovery (D-78)

The daily whole-directory copy (#40, #2870) is 44 % of the directory's rows written (#3325) and
doubles its stored bytes while it runs. **Can Durable Object point-in-time recovery replace it?**
For most of what it is for, yes; for some, no.

- **Yes, for rewinding one object**: operator error, a bad migration, a bug that wrote nonsense.
  PITR restores any point in the last 30 days, the whole database, in place, and the restore can be
  undone (§6). After the split, "one object" is one tenant, which is the right grain: a rewind of
  today's directory would rewind every tenant at once. K-33 already takes a PITR bookmark before a
  scope's migration pass; the directory objects do the same before their own schema changes.
- **No, for losing the object, the namespace or the account, for anything older than 30 days, for
  reading old rows without rewinding, and for self-host and escrow.** No restore into a different
  object is documented, so inspecting yesterday's rows means rewinding the live object and undoing
  it, which is not a recovery tool.

D-78 therefore: PITR is the first recovery tool for every directory object; an **incremental export
to R2** replaces the daily whole copy. A tenant object exports itself when it has changed since its
last export, at most daily, from its alarm, and a registry export runs daily (about 150 MB at
100,000 tenants). The logs are in the lake already. Restore of one tenant is an import into a fresh
object, under a new epoch, as `importDump` does now. Until step 3, step 0's change to #3325 is the
interim.

## 14. Proposed decision records

All `proposed`. Each lists the owner's open choices.

| Record | Says | Relates to | Open choices |
|---|---|---|---|
| [K-68](../decisions/K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md) | The directory is a small global registry and one directory object per tenant; a change across them commits its intent first | applies K-64's boundary rule to the platform's objects; keeps D-75's words; K-26's router reads neither | registry holds tenant status or only a projection; due index in the registry or D1; per-tenant flag cut-over period |
| [K-69](../decisions/K-069-nothing-iterates-over-every-tenant-on-a-schedule-work-starts-from-an-event-or-the-owning-object-s-alarm.md) | Nothing iterates over every tenant on a schedule; work starts from an event or the owning object's alarm; fleet-wide changes are lazy, warmed by a queue and counted | amends K-33 (the reconcile half of a promote); builds on scheduler.md's Design B; Queues and Workflows stay #3367 and #3369's | safety-net cadence; whether a version may be retired while idle scopes still run it; Queues for warm-up now or later |
| [K-70](../decisions/K-070-data-that-grows-with-tenants-times-time-leaves-the-sqlite-objects-each-object-keeps-a-bounded-recent-window.md) | Data that grows with tenants × time leaves the SQLite objects; each keeps a bounded recent window; the admin log is written where the change is made and shipped | K-24 (access log), #1232, #2501, #3316 | window length (35 days proposed); whether the sweep's own reads write access-log rows (#3326); retention in the lake |
| [K-71](../decisions/K-071-the-hosted-issuer-partitions-its-people-by-person-and-prunes-what-expires.md) | A shared issuer partitions its people by person and prunes what expires | D-72; K-63 | partition count and key; whether D-72's manager issuer is per provisioner or per managed tenant instead |
| [D-77](../decisions/D-077-suspension-is-enforced-in-the-scope-projected-like-entitlements-not-at-the-edge.md) | Suspension is enforced in the scope, projected like entitlements, not at the edge | amends D-41 and K-26 | whether a suspended scope still answers its owner's export; the fan-out bound that is acceptable |
| [D-78](../decisions/D-078-a-directory-object-recovers-by-point-in-time-restore-and-an-incremental-export-not-a-daily-whole-copy.md) | A directory object recovers by PITR and an incremental export, not a daily whole copy | #40, #2870, #3325; K-33's bookmark | export cadence; whether the registry also keeps a daily full export; retention of exports |
| [D-79](../decisions/D-079-a-tenant-at-rest-costs-storage-only-and-every-platform-change-is-held-to-that.md) | A tenant at rest costs storage only, and every platform change is held to that | prices a free tier | whether a free tier includes a custom domain (the 50,000 cap and $0.10 each); whether Enterprise is planned before 50,000 custom hostnames |

**Relations to earlier records and to the one-model RFC.** K-26 stands: one router, verticals
reachable only through it. Its open note on suspension latency is answered by D-77, and step 1's
record answers its deferred cache. D-41 is extended to carry suspension (D-77). K-33's in-place
serving and per-scope migrations stand; only the reconcile half of a promote moves from a batched
pass to each scope's next wake (K-69). K-64's rule, nothing crosses an object's boundary inside a
transaction, is the rule §7.3 applies. D-75's words are kept: the tenant directory object is
platform data, not an app's home scope. [one-model-for-shipped-code.md](./one-model-for-shipped-code.md)
puts "storage per tenant removed" after the home scope is measured (§8, storage track); this
document is about the platform's directory, not app storage, and removes nothing there. Its phase-1
work, a sweep role per connection (#3376) and the Workflows spike (#3369), is what K-69's connector
and event delivery build on, and K-69 decides nothing about Workflows.

## 15. What gets worse

| What gets worse | Why |
|---|---|
| Staff lists are eventually consistent | The index is projected; a list may miss the last seconds of changes. |
| A crossing change has more states | Tenant create, hostname bind and reap become intents with leases, retries and a safety net, where today they are one transaction. |
| Debugging spans objects | A tenant's history is in its object, its old history in the lake, and platform state in the registry. |
| Idle scopes run old versions longer | Lazy promotes reach a scope when it wakes; retiring a version waits on a count. |
| A self-host and the hosted platform differ more | One database against three kinds of object; the contract suites hold the end state, not the steps. |
| The migration adds paths before it removes any | Dual-write, verify and per-tenant flags run for weeks. Stopping half-way leaves more than there is today. |

## 16. Not verified, not measured

- **The pass's growth with fleet size.** The 0.88 s per scope is one day's mean at one fleet size.
  That wall time grows linearly with scopes is inferred from how the phases walk, not measured.
- **The 13.5 directory requests per scope per pass** is all non-router directory traffic divided by
  scopes and passes. It includes the control plane's API, the dashboard and the console, which do not
  grow with scopes in the same way.
- **The per-pass subrequest count.** Cloudflare reported exactly 255 subrequests for every cron run
  on 2026-11-24, whatever its outcome. That looks like a reporting cap, so whether a pass is near
  the 10,000-subrequest limit is unknown.
- **Row sizes** in §5.2 are estimated from column lists, not read from the database.
- **The home scope at rest** (≈ 200 KB) is an estimate.
- **Better Auth's own deletion** of expired sessions and tokens was not checked; only the issuer's
  own code was.
- **PITR after an object is deleted** (`deleteAll`), and its behaviour in a jurisdiction, are not
  documented on the page read.
- **D1's lack of interactive transactions** is inferred from the documented `batch()` and the import
  guide; no page read says "not supported" in those words.
- **Durable Object storage billing** is documented as starting in January 2026; the page still says
  so, and whether the account is billed for it today was not checked against an invoice (billing
  reads need a token this work did not have).
- **KV read cost on the request path** depends on the router's memory cache, which is step 1's
  design and was not measured.
- **Active-tenant costs** are four tenants over 20 days. They are a range, not a distribution.
- Nothing here was run. "Today" means the code on `main` at the time of writing and the production
  analytics read on 2026-11-24 and 2026-11-25.
