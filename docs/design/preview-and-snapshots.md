# RFC: preview & snapshots — run a version against a copy of the data

**Status:** proposed · **Depends on:** [builder-plane.md](./builder-plane.md) (versions,
channels, promote), [control-plane.md](./control-plane.md) §4.7 (the router, hostname
bindings), [kernel-design.md](./kernel-design.md) (the scope-host contract, both adapters).

## 1. Problem

We can ship a new version of a vertical, but the only way to see it run is to promote it onto
a live tenant scope — against that tenant's real, forward-only data. There's no "run version
B against a copy of prod and see what happens," which is exactly what you want before a
promotion whose **migrations** changed. Neon/PlanetScale/Vercel all offer a shape of this;
none of them run *your* code against the branch. We can, because the scope-host contract
already runs identical module code on two adapters.

## 2. The model: an instance = (scope) × (version)

Two independent things meet at every reachable URL:

- **Scope = data + a migration frontier.** One `ScopeDO`, its SQLite migrated to some point.
- **Version = code + migration expectations.** An immutable admitted build (`vertical_versions`:
  `deployment_ref`, `permission_digest`, `migration_digest`).

`bindScopeVersion(scope, version)` pairs them; the router resolves `hostname → scope → its
bound version → deployment_ref`. So "keep version X available against a snapshot of prod
data" is just: **a forked scope, bound to version X, with a hostname pointing at the pair.**

Everything reachable is one point in a 2-D grid:

| | prod code | preview/new version | old version |
|---|---|---|---|
| **live prod data** | the app URL | only if migration-compatible (code-only canary) | only if migration-compatible |
| **forked snapshot** | — | preview-on-real-data | frozen "v2 as it was" |
| **empty/seed data** | — | clean-room preview | demo of an old build |

## 3. The one primitive: `exportScope`, two sinks

One read op — call it `exportScope(scopeId) → portable dump` — with the destination varying:

| sink | result |
|---|---|
| a new `ScopeDO` | server-side preview scope + a preview URL |
| a local `${tenantId}__${scopeId}.sqlite` | a laptop dev environment (adapter-sqlite already stores scopes exactly this way) |

Two adapter implementations behind one interface, mirroring the whole platform:

- **adapter-sqlite** (dev / CI / self-host): the scope *is* a file, so a fork is `VACUUM INTO`
  or the online backup API — one consistent, cheap operation.
- **adapter-cloudflare** (prod): no file handle — Cloudflare seals the DO's SQLite behind the
  storage engine — so the export is a **logical** copy (stream the tables out through
  `ctx.storage.sql`). Tractable because a scope is single-tenant-small, and *clean* because
  the DO is single-threaded: you read a consistent snapshot with no concurrent writer.

Once a cloud export lands in a local file it's a real SQLite again — `cp`, `VACUUM INTO`,
Datasette, a step debugger all return. **Pull once (logical, governed); branch freely after.**

## 4. The governing law: migrations are forward-only

Append-only `SqlMigration[]`, never edited. That is what makes the snapshot model necessary
*and* what bounds it:

- **Snapshot-from-an-era + that era's version (or later) → always valid.** Fork prod today
  (frontier = version N), bind version N+, migrations roll forward on the copy. This is the
  killer case: rehearse a new version's migrations against real-shaped data, throw the fork
  away if they break — prod never saw it.
- **Old version + *today's* prod data → generally invalid.** You cannot un-run migrations, so
  you **cannot live-downgrade** prod across a schema change.

Consequence: you keep an old version runnable by **snapshotting the data from when that
version was live**, not by pointing old code at current prod data. Rollback strategy becomes
**fork-before-you-promote**: snapshot right before binding version N, so a bad N leaves a live
v(N-1) instance at its correct frontier to fall back to. `migration_digest` is already the
tracked quantity — `promoteVersion` refuses a migration change unless acknowledged — so the
system already knows when a pairing crosses a migration boundary.

## 5. URLs & cardinality

Routing is whole-string lookup, so each URL is a `hostnames` row → `(tenant, scope, surface)`;
you add rows, not resolver logic. Extending the `app-tenant` naming with a reserved `--`
separator (so a preview tag can't be confused with a tenant handle):

| URL | scope | version |
|---|---|---|
| `callout-sesamy.global.substrat.run` | prod scope | prod-channel version |
| `callout-sesamy--v3.global…` | fork of prod (snapshot @ fork time) | version 3 |
| `callout-sesamy--staging.global…` | fork / dedicated staging scope | staging-channel version |
| `callout-sesamy--v1-archive.global…` | retained fork from the v1 era | version 1 (frozen) |

The four cardinalities are independent:

- **Vertical** (code) — one deployed `ScopeDO` *class* per version. Shared.
- **Scope** (instance) — one DO + one SQLite each; the isolation boundary (D-30). Many per
  vertical: one per tenant, plus previews/archives.
- **DO + database** — 1:1 with scope, always.
- **URL** — many per scope (surfaces, custom domains, preview/archive URLs).

"Many DOs" ≠ many deployments: each scope is a **named instance** (`idFromName(scopeId)`) of
one class, lazily created and **hibernating when idle** → ~zero cost at rest. Code shared,
data per-scope, addresses free. A new scope is a hibernating instance + a directory row — not
a server, not a deployment, not a schema change. That is what makes the fan-out affordable.

`scope.kind` already exists (the kernel never branches on it); `prod` / `preview` / `archive`
slots straight in, alongside `forked_from`, `forked_at`, and a read-only flag for archives.

## 6. Guardrails

- **A fork is a dead end.** The export copies the `_substrat_*` spine too, so nothing
  downstream — connectors, cron, billing — may consume from a preview/archive scope. Enforced
  by leaving the fork's outbound side unwired.
- **The local sink crosses the trust boundary.** Server-side forks stay in the governed
  environment; pulling to a laptop does not, and that is a different risk class:
  - **Residency.** Jurisdiction pins *execution*, not just storage (K-7/K-32) — the reason
    `eu`/`us` are gated until Regional Services. A prod export to a laptop is data executing
    wherever that laptop is; a residency violation for anything but a `global` scope.
  - **PII.** Real customer data (the dashboard roster even holds plaintext invitee emails).
  - So the local sink is **permission-gated, audited** (an `exportScope` is an admin-log
    event), and **masked/subsetted by default**; a full-fidelity pull is **break-glass**,
    logged, `global`-only unless residency explicitly permits.
- **Preview URLs are not public** — they run unadmitted code against real-shaped data, so they
  are gated to builder/tenant/staff and marked non-canonical.

## 7. Recovery: PITR complements the fork

Durable-Object SQLite has built-in **point-in-time recovery, ~30 days**, via the storage
bookmark API (`getCurrentBookmark()`, a bookmark-for-a-time, `onNextSessionRestoreBookmark()`).
It's a platform freebie — nothing is wired to it yet — and it is the *opposite* lever to §3:

- **Fork / `exportScope`** — non-destructive copy; prod keeps running. Preview & rehearsal.
- **PITR** — destructive **in-place** rewind of the same DO; prod loses everything since T.
  Disaster recovery. There is no native "restore a bookmark into a *new* DO" — a read-only past
  view still goes through the export path, not PITR.

Two production sharp edges:

1. **Data and version binding live in different DOs.** A rewind restores the scope's SQLite —
   including its `_substrat_migrations` applied-state — but `scopes.vertical_version_id` lives in
   the control-plane DO, a *separate* PITR timeline. No atomic cross-DO rewind. So: rewinding
   data while the binding stays at version N means N's code re-runs its migrations forward on the
   rewound data on next open (self-heals schema forward — right for recovering *data content*).
   Rewinding to *before* a bad migration requires **also** rebinding the version to N-1 in the
   control-plane — two coordinated rewinds, no atomicity between them.
2. **Rewind scope is per-DO.** One tenant's scope is a clean, self-contained rewind (blast radius
   = exactly that tenant's app — another win of DO-per-scope). The control-plane is a singleton,
   so rewinding *it* to recover one tenant clobbers every other tenant's directory changes since
   T. Control-plane PITR is environment DR, never the tenant-scoped tool.

## 8. CLI

The surface already exists (`packages/cli`: `login`, `versions`, `push`, `--tenant`):

```
substrat scope pull <scopeId>   # → ./.substrat/<tenant>__<scope>.sqlite  (gated · audited · masked)
substrat dev --scope ./.substrat/<tenant>__<scope>.sqlite
```

Mirrors `vercel env pull` / `wrangler d1 export` / `planetscale connect`.

## 9. Open questions

1. Retention/GC policy for preview vs. archive scopes (ephemeral-on-merge vs. deliberately kept).
2. Masking: declarative per-vertical redaction rules, or a generic PII-column sweep?
3. Does a same-scope **code-only canary** (§2, top row) earn a `hostnames.vertical_version_id`
   override, or do we always fork? (Override reintroduces the "code B on data A" hazard unless
   guarded on `migration_digest` equality — leaning: always fork.)
4. Needs a decision-log number in [master-plan.md](../master-plan.md).
