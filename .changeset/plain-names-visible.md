---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

`HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
slug, which registry ids key on, never moves). The dashboard's identity mirror uses
it to keep the shared directory's tenant names in step with team names, so the CLI's
workspace picker shows the organization, not a placeholder; the CLI now lists
workspaces name-first.
