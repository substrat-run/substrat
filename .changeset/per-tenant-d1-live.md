---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

Per-tenant relational stores go live on Cloudflare (#301 PR-2). `provisionTenantStore`
now mints a real D1 per (tenant, vertical, binding) (`createD1TenantStores`, on the
platform credential), records it in the directory's `tenant_stores` ledger, and the
provision endpoint hands the K-31 callback the declared handles automatically — the
worker reaches its tenant's store through a real `d1` binding named
`tenantStoreBindingName(binding, tenantId)` (new in contracts), attached at provision
via the WfP settings PATCH (`createWfpBindingsPatcher`) and re-derived from the ledger
on every in-place serving upload so a re-deploy can never drop it. `openTenantStore`
on the Cloudflare host is the out-of-band D1 HTTP-query reach;
`d1TenantRelationalStore` wraps the worker-side binding in the substrate store shape.
Contract change: `TenantRelationalStore.query/exec` are now async — D1 has no sync
path, and PR-1's sync shape was satisfiable only by SQLite. New read:
`HostAdmin.listTenantStores` (both adapters).
