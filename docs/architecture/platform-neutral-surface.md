---
status: built
layer: plan
description: What Substrat exposes, minus Cloudflare.
---

# The platform-neutral surface — what Substrat exposes, minus Cloudflare

This document draws one picture: **what a module/vertical declares, and what the platform
exposes**, stated in substrate vocabulary with the Cloudflare implementation held at arm's
length. It exists to answer two questions that are hard to see from inside the running
system — *what do we actually expose, versus what is a Cloudflare detail?* and *could this
map onto another substrate, e.g. Kubernetes?*

It does not introduce anything new. Portability is already a first-class pillar
([master-plan.md §5.7](../master-plan.md), "Cloudflare is the deployment target, not a
dependency") and the adapter matrix already lists a pure-SQLite twin for every contract
([kernel-design.md §8](kernel-design.md)). What was missing was a single place that names
the whole exposed surface and maps it, concept by concept, to a non-Cloudflare substrate.
The verdict up front: **the kernel, `contracts`, the OpenAPI builder and the routing
contract carry no Cloudflare types.** Cloudflare lives in three well-fenced places —
`packages/adapter-cloudflare`, each vertical's `worker.ts`, and behind named injected
callbacks in `control-plane-api`. The clean seam is `ScopeHost.getScope()`, not the
database driver.

---

## 1. Two vocabularies

Everything below sorts into one of two vocabularies, and the whole design is an effort to
keep them apart:

- **Substrate vocabulary** — what a module *is*: permissions, events, migrations,
  operations, roles, entitlements, "one durable store per scope", "one relational DB per
  tenant". Neutral. This is what a builder writes and what the kernel enforces.
- **Deployment vocabulary** — how a module is *shipped* on a specific substrate: Durable
  Object classes, `new_sqlite_classes` migration tags, wrangler bindings, Workers-for-
  Platforms dispatch, custom hostnames. Cloudflare today.

```
  builder writes            CLI / control plane           substrate runs
  ───────────────           (the translating seam)         ──────────────
  ModuleManifest       ┐                              ┌  Durable Object per scope
  RuntimeNeeds         ├──►  derive DeployManifest  ──┤  D1 per tenant
  operations/consumers ┘     admit + upload            └  WfP dispatch script
   (substrate vocab)          (deploy vocab)             (Cloudflare primitives)
```

The seam is deliberate: a vertical authored with `substrat.runtimeNeeds` writes **no**
deploy config for any specific substrate — the CLI derives it at push time (decision
D-38: builders keep the substrate vocabulary; the Cloudflare mapping lives behind the
platform). Swap the substrate and you swap only the right-hand column and the derivation
step. The left-hand column does not move.

---

## 2. What a module/vertical declares — the manifest

There are four declaration layers. The first three are neutral; the fourth is the
Cloudflare-shaped boundary object the platform *derives* from them.

### 2.1 `ModuleManifest` — the domain contract (neutral)

`packages/contracts/src/manifest.ts` (`moduleManifest`, line 84). Self-describing, names
domain concepts, not infrastructure:

- `id`, `version`, `kernelContract` (semver range of the kernel API it targets)
- `permissions: PermissionDeclaration[]` — `{ key, description }`
- `events: { emits, consumes }` — star topology; consumes event *types*, never sibling
  modules (`{ type, schemaVersion }`)
- `migrations: { journalDir, compatibleFrom }` — Drizzle journal location + skew window
- `attachmentTargets`, `entityRelations` (declared parent edges the permission evaluator
  flows along), `guards` (unconditional operation pre-conditions), `withdraws`
- `entitlementKey` — the SKU flag that gates loading
- `envSpec: EnvVarSpec[]` — declared config, self-describing so a host renders a settings
  form; `secret: true` means write-only, delivered as a secret (line 35)
- `provides` / `requires` — named capabilities (e.g. `oidc-issuer`) wired tenant-side
  through the connection store, never bundled into a consumer
- `api` (path to the emitted OpenAPI spec), `ui`, `searchables`

Nothing here binds to a substrate. `resolveEnvSpec(spec, raw)` (line 72) resolves the
`envSpec` against *any* raw environment — a Worker `env`, `process.env`, a Kubernetes
container env — reading only the declared keys.

### 2.2 `ModuleRegistration` — the manifest paired with code (neutral)

`packages/kernel/src/scope-host.ts:385`. The runtime pairing of the declared manifest
with actual handler closures:

```ts
interface ModuleRegistration {
  manifest: ModuleManifest;
  migrations?: SqlMigration[];
  operations?: Record<string, OperationHandler<never, unknown>>;
  consumers?: Record<string, ConsumerHandler>;   // eventType → handler
  predicates?: Record<string, GuardPredicate>;   // code half of manifest.guards
}
```

Pure kernel/contracts types — no substrate leakage.

### 2.3 `RuntimeNeeds` — what the workload needs (neutral, the K8s-mappable one)

`packages/contracts/src/deploy.ts:84`, from a vertical's `package.json`
`substrat.runtimeNeeds`. This is the declaration that maps most directly onto another
substrate, because it states *needs*, not *bindings*:

```ts
interface RuntimeNeeds {
  entry: string;                 // the worker entry module
  needsNodeCompat: boolean;      // needs Node built-ins at runtime
  build?: string;                // pre-bundle command (SPA build, asset gen)
  stores: StoreNeed[];           // the vertical's OWN durable state classes — one DO per scope
  tenantStores: TenantStoreNeed[]; // one relational DB PER TENANT, platform-minted
}
```

- `StoreNeed` (`{ binding, class }`, line 28) — a named durable-state backing store. This
  is the substrate-vocabulary side of "a `durable_object_namespace` binding + a
  `doClasses` entry"; the doc comment says so explicitly.
- `TenantStoreNeed` (`{ binding, kind: 'relational' }`, line 53) — one relational DB
  **per tenant**, platform-minted. The load-bearing detail: the builder supplies **no
  database id**. The platform mints it per tenant and injects it (`TenantStoreHandle`,
  line 68, carries an opaque `ref` the vertical never parses — a D1 `database_id` on
  Cloudflare, a `.sqlite` path token on the pure adapter).

### 2.4 `DeployManifest` — the Cloudflare-shaped boundary object (deployment vocab)

`packages/contracts/src/deploy.ts:188`. The JSON `substrat push` sends alongside the
module files; the CLI *derives* it from `RuntimeNeeds`, and both ends parse the same
schema. **This is where the deployment vocabulary begins** — everything from here down is
substrate-specific:

- `doClasses: string[]` → Cloudflare `new_sqlite_classes`
- `bindings: DeclaredBinding[]` — `{ type, name, class_name?, script_name?, id? }`
  (line 137), the wrangler binding shape
- `ADMISSIBLE_BINDING_TYPES` (line 121) — the §4 sandbox positive allowlist, explicitly
  Cloudflare: `durable_object_namespace`, `d1`, `kv_namespace`, `queue`, `r2_bucket`,
  `analytics_engine`, `secret_text`, `plain_text`. `service` and `dispatch_namespace` are
  *named refusals* — a hosted vertical is one serving script that reaches the platform
  only through the router (K-27), never a sibling binding.
- `registry: PermissionRegistry` (neutral — the machine-readable twin of PERMISSIONS.md)
  and `digests` (manifest/permission/migration content hashes, the promotion checkpoint)

### 2.5 The `Scope` model, and two honest leaks

`packages/contracts/src/tenancy.ts` (`scope`, line 185) is the neutral tenancy/execution
unit: `id` (globally unique, not per-tenant), `tenantId`, `parentScopeId`, `slug`, `kind`
(vertical vocabulary — the kernel never branches on it), `status`, `vertical`,
`schemaVersion`, lifecycle timestamps. `ScopeStatus` is a neutral lifecycle
(`provisioning | active | suspended | archiving | archived | reaped`).

Two fields are honest leaks of the Cloudflare storage model into the neutral schema, worth
naming rather than hiding:

- `storageShape: 'A' | 'B'` (line 83) — Shape A is DO-embedded SQLite (the primary),
  Shape B is a DO control plane in front of per-tenant D1. On another substrate only Shape
  A's semantics matter; B is a Cloudflare storage tactic.
- `jurisdiction: 'eu' | 'us' | 'global'` (line 98) — the vocabulary is neutral, but the
  *enforcement* (a Cloudflare DO jurisdiction subnamespace, Regional Services, D1 location
  hints) is substrate-specific. Only `global` is provisionable today.

---

## 3. The four API surfaces the platform exposes

### 3.1 `ScopeHost` — the adapter contract

`packages/kernel/src/scope-host.ts:1354`. The interface every adapter implements; the
whole runtime contract in one place. The core interaction is `getScope → ScopeStub.invoke`:

```ts
interface ScopeStub {                        // the ONLY way code outside a scope reaches in
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  invoke<O, I>(operation: string, input?: I): Promise<O>;
}
```

Beyond `getScope`/`getConnectorScope`, `ScopeHost` exposes scope lifecycle
(`provisionScope`, `importScope`, `restoreScope`, `snapshotScope`), the per-tenant store
seam (`provisionTenantStore`/`openTenantStore`), module wiring
(`registerModule`/`registerExecutor`/`registerConnector`), the retry driver (`drainDue`),
migration control (`migrationFrontier`/`migrateScope`), and `admin: HostAdmin`.

**Neutrality: clean.** The kernel imports no substrate typings — `FetchLike` and friends
are declared structurally so DOM lib and workers-types both satisfy them without either
being required. **This is the primary interface a Kubernetes port re-implements**, and the
conformance gate already exists: `scopeHostContractSuite`
(`packages/contract-tests/src/scope-host-suite.ts`) runs against every adapter unchanged,
forever (D-14). `adapter-sqlite` is a fully neutral second implementation and the best
reference for what a non-DO backing looks like.

### 3.2 `HostAdmin` + the control-plane HTTP transport

`packages/kernel/src/scope-host.ts:422`. The enforcement-input / control-plane surface.
Every mutation takes a `PlatformActorId` (staff subject, typed distinctly from a tenant
`PrincipalId`) and writes an append-only audit row. The whole surface is **async on
purpose** (line 414): a durable/remote control plane cannot be backed synchronously — the
second adapter surfaced this (D-14). It covers roles/grants, membership/orgs, the
vertical+version registry, hostnames/routing, tenants, scopes, entitlements, connections,
identity, and audit.

Its HTTP transport is `createControlPlaneApi` (`packages/control-plane-api/src/api.ts`), a
**Hono app** — "a transport; it does not invent semantics on top of HostAdmin". It runs
anywhere Hono runs (there's a `@hono/node-server` path). Cloudflare is pushed entirely
behind injected callbacks in `ControlPlaneApiOptions` — `deployVertical` (WfP upload),
`resolveVertical*` (dispatch resolution), `observability`, `provisionHostname`. Each is
optional; absent ⇒ the route 501s. A Kubernetes deployment supplies its own
implementations of these function types; **the HTTP surface itself does not change.**

### 3.3 `OperationContext` — what module code sees

`packages/kernel/src/scope-host.ts:91`. The capabilities the runtime hands a module
handler. Tenancy is **ambient** — handlers never pass tenant/scope/principal around:

```ts
interface OperationContext {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  readonly principal: PrincipalId;
  readonly sql: ScopedSql;                                  // scope-local DB, synchronous
  emit(event: DomainEventInput): void;                      // event spine; envelope stamped kernel-side
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  entitlement(key: string): Promise<EntitlementView | null>;
  entitlements(): Promise<EntitlementView[]>;
  link(child: EntityRef, parent: EntityRef): void;          // relation tuple for the permission evaluator
}

interface ScopedSql {                                       // note: SYNCHRONOUS
  query<T>(sql: string, params?: readonly SqlValue[]): T[];
  exec(sql: string, params?: readonly SqlValue[]): { changes: number };
}
```

**Neutrality: clean.** But `ScopedSql` being **synchronous** is the one hard runtime
property any substrate must reproduce: the scope's database must be reachable
synchronously *inside* the handler's serialization domain. Cloudflare gets this for free
because the SQLite lives in the same Durable Object as the compute. Anywhere else it means
a per-scope single-writer store co-located with (or leased to) the executing process.
Effects on the outside world are deliberately *not* here — they go through `emit` +
registered executors/connectors, so module code holds no `fetch` (boundary-lint R3).

### 3.4 The vertical's own HTTP surface

Each vertical ships its own thin HTTP server, but the *conventions* are shared and neutral:

- **Operations catalog + `/openapi.json`** — `packages/contracts/src/openapi.ts`. A
  vertical exports an `ApiCatalog` (operation name → `{ summary, input?: ZodType, output? }`),
  and the **same Zod schema** is both the runtime validator and the documented contract
  (no drift). `buildOpenApiDocument` renders OpenAPI 3.1 with one path per operation under
  `POST /api/op/{operationName}`.
- **Routing contract** — `packages/kernel/src/routed-node.ts`. `readRoutedNode(headers, opts)`
  returns `{ tenantId, scopeId, surface, verticalSlug }` by reading the `x-substrat-*`
  headers a front router stamps (signed by `x-substrat-router` against `expectedSecret`).
  `HeaderReader` is just `{ get(name): string | null }`, which a real `Headers` or a plain
  test object both satisfy. This is the seam a Kubernetes ingress would populate.

The per-vertical `worker.ts` is where the substrate binding actually lives (it imports
`CloudflareScopeHost`, declares DO namespaces, guards `/internal/*` platform-RPC routes
with `assertPlatformCall`). The dev server (`server.ts`) is the parallel node/SQLite
implementation of the same routes. A Kubernetes deployment writes a third sibling that
keeps the neutral routes and swaps the host adapter.

---

## 4. What a Durable Object actually does — five separable jobs

The Durable Object is the one place people reach for when they say "this is Cloudflare-
specific", so it's worth pulling apart. A DO is doing **five separable jobs**, and the
K8s question is really "what replaces each one":

1. **Durable storage** — the SQLite that *is* the scope database (Shape A;
   `scope-do.ts`, `this.sql = ctx.storage.sql`).
2. **Compute isolation** — the operation handler runs *inside* the scope's execution
   domain; the vertical *is* the DO (D-34).
3. **Single-threaded coordination** — strict per-scope serialization, one operation at a
   time to completion, transactions spanning `await` (`serialization.ts`, `OperationQueue`).
   This is the **load-bearing, hardest-to-replicate** property.
4. **Alarms / timers** — a self-rearming background scheduler (`platform-sweeper-do.ts`
   singleton `alarm()` runs the sweep and re-arms).
5. **Named singletons / directory** — `idFromName` gives a deterministic global instance
   (the control plane, the sweeper), and a per-tenant `IdentityDO` holds each tenant's
   auth secret, minted in `blockConcurrencyWhile` so it never leaves the DO.

The two invariants that must survive any port are #1+#3 together: **strict per-scope
serialization** and a **structured-clone RPC boundary** on the stub. Both are pinned as
*contract, not adapter behaviour* (kernel-design §5.1, K-6), and both are already honoured
by the pure `adapter-sqlite` — which is the proof that a non-DO backing works.

---

## 5. Cloudflare → Kubernetes: the conceptual mapping

This extends the existing adapter matrix ([kernel-design.md §8](kernel-design.md)) with a
third column for a Kubernetes substrate. It is a *conceptual* mapping — reasoning about
feasibility, not a build plan.

| Substrat concept | Cloudflare today | Kubernetes equivalent |
|---|---|---|
| Scope (unit of isolation + storage) | one ScopeDO instance | a per-scope shard: leader-leased process + one PV-backed SQLite |
| `ScopeHost.getScope()` seam | `scopeNs.get(idFromName(scopeId))` | resolve scope → shard, return an RPC stub to it |
| DO durable storage (Shape A) | DO-embedded SQLite | PersistentVolume + SQLite per scope |
| DO compute isolation | the vertical runs in the DO | pod/process per scope (or a sharded worker keyed by scopeId) |
| DO single-thread serialization | DO input gate + `OperationQueue` | per-scope leader lease + single-consumer queue |
| DO alarms / timers | `alarm()` self-rearm | CronJob, or a poll-loop Deployment calling `drainDue` / `migrateScope` |
| Named singleton (control plane) | `idFromName('control-plane')` | StatefulSet with stable identity, or a leader-elected singleton |
| per-tenant IdentityDO + secret | DO + `blockConcurrencyWhile` | per-tenant `Secret` + a small stateful service |
| `tenantStores` (per-tenant relational DB) | platform-minted D1 | operator-provisioned per-tenant DB (PVC-backed SQLite or managed Postgres) |
| `StoreNeed` / `doClasses` | wrangler DO binding + `new_sqlite_classes` | the shard's state class set + its volume claims |
| `envSpec` / secrets | `secret_text` / `plain_text` bindings | `ConfigMap` + `Secret` (+ the rendered settings form) |
| Router (hostname → node) + WfP dispatch | router Worker + `env.DISPATCH.get(ref)` | Ingress/Gateway → per-vertical `Service`; `deploymentRef` → Deployment selector |
| Jurisdiction (region-pinned) | DO id encodes region; can't relocate | topology / node-affinity constraints per scope |
| Deploy upload (`wfp.ts` multipart PUT) | WfP dispatch-namespace script PUT | build an image + `kubectl apply` / operator reconcile |
| Control-plane transport | Hono on a Worker | the **same** Hono app on `@hono/node-server` |
| Escrow / single-node exit | pure `adapter-sqlite` host | the **same** pure host, in any container |

The last two rows are the point: the transport and the pure host are already substrate-
neutral and move unchanged. The hard rows are all one problem — **reproducing per-scope
single-writer semantics** — and a per-scope leader lease + a single-consumer queue +
SQLite-on-a-PV satisfies it.

---

## 6. The port surface, restated

A Kubernetes deployment is a bounded, well-fenced piece of work because the seam is drawn
at exactly one interface:

- **Re-implement:** a `ScopeHost` + `HostAdmin` adapter that passes
  `scopeHostContractSuite`. This is the whole runtime contract. `adapter-sqlite` is the
  reference.
- **Reuse unchanged:** the kernel (`OperationContext`, the event spine, executors/
  connectors, the permission model, `readRoutedNode`), the `contracts` package, the
  OpenAPI builder, and the Hono control-plane transport — injecting Kubernetes
  implementations of `deployVertical` / `resolve*` / `observability` / `provisionHostname`
  in place of the Cloudflare ones.
- **Provide new plumbing:** a front router that resolves hostname → node and stamps the
  `x-substrat-*` headers (replacing the CF router + WfP dispatch); a per-scope
  single-writer store honouring the synchronous `ScopedSql` contract (the DO's job today);
  a per-vertical server file sibling to `worker.ts` / `server.ts`; and a scheduler to call
  `drainDue` / `migrateScope` / the sweep (replacing DO alarms + cron triggers).

**No engine or module code changes** — which is the entire reason the boundary exists.
