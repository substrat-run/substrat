---
'@substrat-run/control-plane-api': minor
---

Identity-mirror routes (`PUT`/`DELETE /tenants/:tenantId/identities`): the seam the
Dashboard writes builder identity links through, so the shared plane's whoami/builder
auth can resolve a CLI session to its workspaces. Service/staff only — not in the
builder allowlist.
