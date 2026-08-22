# Tenants & scopes

Substrat tenancy is **two levels, tree-shaped**: the tenant is the business that pays you
(a property-management firm, a retail chain, a publisher); beneath it are **scopes** —
the housing associations it manages, its branch offices, its client companies, its
brands. Users belong to the tenant, to a scope, or to several scopes with different
roles.

This shape recurs in essentially every vertical B2B product, and it is nearly impossible
to retrofit — which is why it's kernel-owned and first-class rather than a convention.

## The entities

```ts
import { tenant, scope } from '@substrat-run/contracts';

type Tenant = {
  id: TenantId;          // branded ULID
  slug: string;          // stable, URL-safe, unique
  name: string;
  status: 'active' | 'suspended' | 'deleting' | 'reaped'; // 'reaped' = terminal, bytes gone
  deletingAt: Instant | null; // set when it entered 'deleting'; null otherwise. The reap
                              // sweep ages a tenant off this to decide the grace window.
  createdAt: Instant;
};

type Scope = {
  id: ScopeId;           // branded ULID — globally unique, not per-tenant
  tenantId: TenantId;
  parentScopeId: ScopeId | null; // v1: always null; the column exists so deeper
                                 // trees are additive, not a migration
  slug: string;          // unique within the tenant
  kind: string;          // YOUR vocabulary: 'brf', 'branch', 'brand', 'clinic'…
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'archiving' | 'archived' | 'reaped';
                         // 'reaped' = terminal past 'archived'; DO storage gone, no restore
  storageShape: 'A' | 'B';
  jurisdiction: 'eu' | 'us' | 'global';  // fixed at provisioning; 'global' is unconstrained
  vertical: string | null;          // which vertical's deployment executes this scope
  verticalVersionId: string | null; // the registered version it runs (null if pre-registry)
  schemaVersion: string; // COUNT of applied (module, version) pairs, as a string.
                         // '0' = provisioned, nothing applied yet. Compared against the
                         // host's registered migration total to answer "which are behind".
  // Non-null when the scope's last migration attempt FAILED. The scope fails
  // closed and serves nothing; this is what stops it rendering as healthy.
  migrationFailure: {
    version: string;        // the `module@version` that threw
    error: string;
    attempts: number;       // consecutive failures
    lastAttemptAt: Instant;
  } | null;
  forkedFrom: ScopeId | null; // fork provenance: the scope this was copied FROM (importScope),
  forkedAt: Instant | null;   // and when — both null for a normally-provisioned scope
  expiresAt: Instant | null;  // when a fork stops being retained (GC); null = no expiry
  servingRef?: string | null; // the dispatch script this scope's data DO lives in (#286)
  archivedAt: Instant | null; // when it last entered 'archived'; null if never / on unarchive
  createdAt: Instant;
};
```

Design decisions worth knowing:

- **`kind` is vertical vocabulary, not a kernel enum.** The kernel never branches on it.
  Call your scopes whatever your domain calls them.
- **Scope IDs are globally unique**, so an event or an opaque ref never needs the tenant
  for disambiguation — but every kernel API still requires the pair
  `(tenantId, scopeId)` and cross-checks it. A confused-deputy bug in calling code
  **fails closed** instead of resolving to another tenant's scope.
- **`jurisdiction` is fixed at provisioning, forever.** Data residency is decided when
  the scope is created, not toggled later.

<TenancyTree />

## One scope = one database = one consistency domain

Each scope is an isolation domain with its own SQLite database and a strictly serialized
executor: one operation at a time, run to completion. This gives module code
single-writer simplicity — a read-modify-write inside an operation cannot interleave
with another operation on the same scope — and it bounds the blast radius of any
problem to one scope, not one customer.

Serialization is **per scope, not per system**: a thousand scopes run a thousand
operations at once, and only two operations *on the same scope* ever queue. What that
means for throughput, and where reads go when a scope gets busy, is
[Reads & scaling](/concepts/reads).

The granularity rule: **the scope maps to the consistency domain, not the tenant.** A
tenant with 300 housing associations is 300 scope databases plus a lightweight tenant
root, not one 300-times-hotter database.

## Provisioning

```ts
// A scope belongs to a tenant, so the tenant record must exist first.
host.admin.createTenant(actor, { id: tenantId, slug, name });

await host.provisionScope(actor, {
  tenantId,
  scopeId,
  storageShape: 'A',        // optional
  jurisdiction: 'global',   // optional (defaults to 'global'); immutable once set.
                            // 'eu'/'us' are gated until Regional Services is in place.
});
```

Both take a platform `actor` (the control-plane staff subject) and are audited.
Provisioning is **idempotent and journaled** — safe to re-run, safe to drive from a
reconciliation sweep — and **requires an existing active tenant**, so a scope can never be
orphaned. The host maintains a **directory** (a separate database) as the authoritative
inventory of tenants and scopes; it's what `getScope` validates addressing against, and the
input to migration sweeps and ops tooling.

Provisioning is one step of a longer lifecycle — `active → suspended ⇄ active → archiving →
archived` — which, along with entitlements, custom domains, and the rest of what sits *below*
a vertical, is [The platform layer](/concepts/platform).

## Storage shapes

`storageShape` records how a scope's data is physically hosted in production:

- **Shape A** — the scope's execution domain *is* the database (embedded SQLite as
  primary store). Right for small, document-centric, realtime-friendly scopes.
- **Shape B** — the execution domain is a control plane (hot state: ACLs, entitlements,
  counters, locks) fronting a separate per-tenant database for bulk storage, read
  replicas, and export tooling.

The choice is per-scope, fixed at provisioning, and invisible to module code — the
scope-host contract is identical either way. On the pure-SQLite adapter both shapes are
one SQLite file per scope.

`storageShape` is not the only store a vertical can hold. Orthogonal to shape A/B, a
vertical's manifest can declare stores the platform mints for it, one per *tenant*:

- **`tenantStores`** — an independent SQL database (D1 on Cloudflare, a separate `.sqlite`
  file on the pure adapter), minted by `provisionTenantStore` and opened through
  `openTenantStore`. An own-store concept — an auth DB, say.
- **`blobStores`** — object storage (an R2 bucket) behind the kernel's attachment surface,
  for the documents and images a scope's rows point at rather than contain.

Both follow the same ownership rule, and it is the load-bearing part: **the builder supplies
no id.** The vertical declares a *need*; the platform mints the database or bucket, holds the
cloud credential, and attaches a binding to the serving script, re-derived from the ledger on
every upload. A vertical is *handed* a store — it never names one, so it can never name
someone else's.

## Addressing is capability-shaped

```ts
const stub = await host.getScope(principal, tenantId, scopeId);
await stub.invoke('workorder/create', input);
```

`getScope` mints a **capability stub** bound to one principal and one scope. From then
on, tenancy is ambient: operations receive `ctx.tenantId` / `ctx.scopeId` /
`ctx.principal` from the stub's context, and your business logic never passes IDs
around. There is no parameter to get wrong, and nothing to forget to check — the scope
re-validates every call against its own state anyway.
