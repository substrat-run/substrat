---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Backup restore / backout (§8's write half): `ScopeHost.restoreScope` loads a
`ScopeDump` into an EXISTING scope in place (drop-then-replay, migration frontier
included) — audited as `restoreScope`, refusing unknown scopes. Threaded end to end:
`restoreScopeLocal` on the Cloudflare host, `/internal/restore` on the vertical
surface (VerticalClient + the Manyfold reference worker), a staff-only
`POST /tenants/:tenantId/scopes/:scopeId/restore` control-plane route that delegates
to the bound version's deployment, and `substrat scope restore <scopeId> --file
<backup>` — accepting a `scope pull` .sqlite, a local adapter-sqlite scope file, or
a .dump.json.
