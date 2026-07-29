---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

Per-tenant relational stores as a first-class store type (#301, PR-1).

A hosted vertical whose data model is one SQL database **per tenant** (a latency-sensitive
multi-tenant auth/OIDC provider is the motivating case) can now declare a per-tenant
relational store the platform provisions and hands over — distinct from a single shared D1
(one database for every tenant) and from an own DO (one per scope). Because the platform
mints the database per tenant and injects the id, the builder supplies **no `database_id`**:
that is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md §4).

- **Vocabulary** — `tenantStoreNeed` in `runtimeNeeds.tenantStores` and a platform-minted
  `tenantStoreHandle` (`@substrat-run/contracts`). A per-tenant store is a *need* the platform
  provisions, never a `declaredBinding`, so it never rides the §4 sandbox allowlist. The CLI
  carries `tenantStores` into the deploy manifest without emitting a static wrangler binding.
- **The seam** — `provisionTenantStore` (platform mints, records in the directory, returns an
  opaque handle; idempotent) and `openTenantStore` (the vertical opens what it was handed and
  runs its own migrations) on `ScopeHost`, plus `ProvisionInstanceInput.tenantStores` so the
  K-31 pull-provision callback hands the handle over inside its fail-closed/idempotent/retry
  ready-gate. The handle's `ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
  `.sqlite` file on the pure adapter.
- **Pure adapter (real)** — `@substrat-run/adapter-sqlite` mints one separate `tstore__….sqlite`
  file per (tenant, vertical, binding), physically isolated from the scope DBs, backed by a
  new `tenant_stores` directory table (the idempotency + reap ledger). The whole path is
  exercised in dev/CI without Cloudflare.
- **Cloudflare (stubbed)** — `@substrat-run/adapter-cloudflare` throws a clear `#301` marker
  from `provisionTenantStore`/`openTenantStore`; live D1 create/bind/HTTP-query is the tracked
  follow-up (PR-2), so nothing appears provisioned while its store does not exist.

Additive and backward-compatible: `runtimeNeeds.tenantStores` and the manifest field default
to empty, a `provisionTenantStore` audit action is a new enum value, and a vertical that
predates `ProvisionInstanceInput.tenantStores` strips the unknown key.
