---
status: built
layer: plan
description: Run a version against a copy of the data.
---

# RFC: preview & snapshots — run a version against a copy of the data

**Status:** **built** — per-PR previews ship (D-43); `substrat preview`. **Depends on:** [builder-plane.md](./builder/plane.md) (versions,
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
| `callout-sesamy--test.global…` | a pinned fork, rebound on every merge | whatever `main` last built |
| `callout-sesamy--pr-42-9917.global…` | a fresh clean room per CI build | version bound once, never rebound |
| `callout-sesamy--v1-archive.global…` | retained fork from the v1 era | version 1 (frozen) |

(The middle two are the environment rows: a *sticky* URL whose binding moves, and an *immutable*
per-build one whose binding never does. There is no `--staging` row — the staging channel was
retired in #515; a staging environment is a scope with data, which is to say a preview.)

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

## 9. Execution topology — where the data ops run (the control-plane ↔ vertical split)

§3–§8 describe the primitives as if one process owned both the directory and the scope's
SQLite. Production splits them, and that split decides where every data op executes.

**The invariant.** A scope's data DO lives in the **vertical's own WfP deployment**, addressed
by its **bound version's** `deploymentRef` (each `substrat push` is a separate script = its own
DO namespace). The control-plane worker holds the **directory** (the singleton `ControlPlaneDO`:
scope/version/hostname rows) plus a **module-less placeholder** ScopeDO that exists only so
`provisionScope` has something to instantiate. Two tiers:

- **Directory tier** (control plane): scope rows (incl. `kind`/`forkedFrom`/`forkedAt`/`expiresAt`),
  `bindScopeVersion` (a pointer flip), enumerate-expired. Reached via `HostAdmin`.
- **Data tier** (vertical deployment): the real SQLite, reachable only from inside that
  deployment's own `CloudflareScopeHost` (its `env.SCOPE` is the real namespace).

The platform already crosses the split for exactly two things, via the deliberately tiny
**`VerticalClient`** (`/internal/*`, `PLATFORM_SECRET`-gated): `provisionInstance` (create a scope
DO) and read-only introspection (`listScopeTables`/`readScopeTable`, routed to the scope's
**bound-version** deployment by `resolveVerticalVersion`). Its minimalism is a stated trust rule —
every other verb "would be authority the platform holds over someone else's code."

**Why §3–§4's primitives are in-process only.** `exportScope`/`importScope`/`snapshotScope`/
`deleteSnapshot` all reach the DO via `this.scopeStub` = the host's *own* `env.SCOPE`. That is
correct inside a deployment (a vertical's own; the contract tests) but from the **control plane**
resolves to the empty placeholder — so they have no production reach today. They are sound
building blocks; production needs them **routed to the vertical deployment**, exactly as
introspection is.

### The resolving observation: snapshot & GC never move data

The trust worry — the platform gaining dump/clone/wipe power over a builder's vertical — mostly
dissolves once you track **where the bytes go**. A **rollback snapshot** binds the fork to the
*source's current version*, so source DO and fork DO sit in the **same** deployment: the whole
export→import runs **inside that one vertical**, the platform only says "snapshot X → Y", and **no
scope bytes ever reach the control plane**. Same for `deleteSnapshot` ("wipe Y", run in Y's
deployment). Only the local pull (§8) and a cross-version preview move a dump out — and those are
what §6 already gates.

| op | topology | bytes leave the vertical deployment? |
|---|---|---|
| rollback snapshot (fork bound to **source's** version) | one vertical call: local export+import | **no** |
| auto-snapshot on migration-bind | same, before the pointer flip | **no** |
| `deleteSnapshot` / GC reap | one vertical call to the fork's deployment | **no** |
| **cross-version preview** (fork bound to a **new** version) | export in source's deployment → dump via control plane → import in the new version's deployment | **yes** — gated (§6) |
| `scope pull` to a laptop (§8) | export → out of the platform | **yes** — break-glass (§6) |

The first three are the safe common core: they add only "do this locally" verbs to the vertical
harness, and the platform orchestrates without seeing data. The **cross-version preview** — the
"run a NEW version against a snapshot" killer feature (§2) — genuinely needs a cross-deployment
dump move, because the fork's code must run in the new version's namespace; it inherits §6's
exfiltration gates and is a later, harder slice.

### What this makes the build

- **New vertical-harness `/internal/*` verbs** (mirroring `provisionInstance`): `snapshot
  {sourceScopeId, newScopeId}` (local export+import; returns a summary, no data) and `delete-scope
  {scopeId}` (wipe the DO). Added to `VerticalClient` and each vertical's server harness.
- **Orchestration in control-plane-api** (mirroring the introspection branch): resolve the scope's
  bound-version deployment, delegate the data op, then do the directory writes (provision the fork
  row + provenance/expiry and bind it; or delete the row + hostnames). Vertical-then-directory,
  like `provisionInstance`.
- **`bindScopeVersion`'s `opts.snapshot`** moves from an in-process `snapshotScope` to this
  orchestrated one.
- **GC** runs at the control plane: enumerate expired forks (directory), delegate each DO-wipe to
  its deployment, then delete the row. The **CF cron then belongs in the control-plane worker and
  is correct** — the placeholder-orphan hazard is gone because the wipe is routed, not local.

### The remaining trust line

Even with no data crossing the boundary, the platform gains two new lifecycle verbs over a
vertical's scopes (`snapshot`, `delete-scope`). These are **infrastructure, not domain** — they
touch the DO's storage lifecycle, never the vertical's operations — and they extend the authority
`provisionInstance` already asserts (the platform creates scope DOs; now it may also snapshot and
reap them). That is the line to ratify: the platform holds **scope-storage lifecycle** authority
over verticals, but reads/writes domain data across the boundary only through §6's gated paths.

## 10. Open questions

0. ~~Per-PR previews (composition of §2 × §9)~~ **Built + decided (2026-07-30, D-43).**
   `substrat preview create/delete/ls` + the builder-reachable `/verticals/:slug/previews`
   routes (`orchestratedPreview`) compose the primitives below into a per-PR flow: a PR
   forks the tenant's prod scope, binds the pushed PR version to the fork (a private
   vertical self-admits, so no admission relaxation — D-36), mints a non-canonical
   `<label>--pr-N.<base>` hostname, and is reaped on PR close (with `expiresAt` GC as the
   backstop). This is the §9 cross-version path (dump moves between deployments), so it
   carries §6's gates: `global`-only, audited export, non-public preview URL. **Private
   verticals only**; the listed tier waits on the same admission work as everything else.
1. ~~Retention/GC policy for preview vs. archive scopes~~ **Decided:** previews are
   ephemeral — reaped on PR close, and every preview carries an `expiresAt` (default 72h)
   that the platform sweep enforces as the backstop for an abandoned one. Archives remain
   the deliberately-kept case.
2. Masking: declarative per-vertical redaction rules, or a generic PII-column sweep?
   **Partly answered (#1034):** the sweep stays generic and name-based, but it now
   *pseudonymizes* rather than blanks — a PII cell gets a deterministic fake value of
   the right kind (`HMAC(exportSalt, value)` → a name, an email at a reserved domain, a
   phone that keeps its country code), so the same real value reads the same in its own
   row, in every event payload that quoted it, and in the timeline. That is what makes a
   masked pull usable as a preview instead of a page of `[masked]`. It is
   **pseudonymization, not anonymization** — rare combinations, amounts and dates still
   re-identify — so none of §6's gates relax. Free text and national identifiers keep
   `[masked]` (a hash cannot invent a sentence, and a generated personnummer may belong
   to a real person). Still open underneath: per-vertical declarative rules, driven by
   `erasable` on `defineEntities` rather than by a column-name regex.
3. Does a same-scope **code-only canary** (§2, top row) earn a `hostnames.vertical_version_id`
   override, or do we always fork? (Override reintroduces the "code B on data A" hazard unless
   guarded on `migration_digest` equality — leaning: always fork.)
4. ~~§9 trust line~~ **Decided (2026-07-25):** platform scope-storage-lifecycle authority
   (`snapshot`/`delete-scope` over `/internal`) is accepted as an extension of
   `provisionInstance` — infrastructure, not domain; no per-vertical opt-in.
5. Cross-version preview: the dump transits the control plane between deployments — encrypted in
   flight, never at rest? Its own residency review under §6.
6.5. ~~Should the documented workflow ship as a generated CI file?~~ **Decided: yes** (#509
   open question 3). The recipe is a *generator*, not prose — `deployWorkflowYaml` in
   `@substrat-run/contracts`, written by `substrat init --ci github` and by the dashboard's
   one-click setup, with the PR sticky-comment bodies rendered from that same module so the
   CI-written and platform-written comments are byte-identical. What forced it: the first
   hand-written workflow pushed `--version 0.1.<run number>` on every run, claiming a real
   registry coordinate each time. The version-label discipline is load-bearing and completely
   undiscoverable from `--help`, so it has to be generated rather than written up. The PR
   preview stays sticky per tag (rebound on every push); an opt-in per-build preview is a fresh
   clean room bound once, so every build is addressable at an immutable URL even though the PR
   URL moves under the reader.
6. ~~Needs a decision-log number in [master-plan.md](../master-plan.md).~~ **Done: D-43**
   (per-PR previews). The broader snapshot/fork machinery this doc describes is tracked by
   D-36/D-37 and the §9 "what this makes the build" list, most of which has shipped.
