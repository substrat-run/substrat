---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The tenant-provisioner capability becomes a directory-backed staff grant (#444, #412).
`vertical.tenantProvisioner` is a registry flag flipped by the new audited
`setVerticalTenantProvisioner` admin action (console: Grant/Revoke provisioner, route
`POST /verticals/:slug/tenant-provisioner`, staff-only) and read by the drain's
`admitManager` at execution time — replacing the `TENANT_PROVISIONERS` env list, which
was configured nowhere and would have put customer slugs in deployment config. Never set
at registration and never touched by a re-push refresh (contract-tested): pushing code is
never how a vertical acquires or keeps platform authority. BREAKING for
`control-plane-api` consumers: `ManagedTenantDeps.provisioners` is gone — the grant
lives on the registry row.
