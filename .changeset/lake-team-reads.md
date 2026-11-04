---
'@substrat-run/control-plane-api': minor
---

A team's own credential can read its lake events (`GET /tenants/:tenantId/lake/events`), with a required `since` and a window of at most 31 days.
