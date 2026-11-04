---
'@substrat-run/control-plane-api': minor
'@substrat-run/contracts': minor
---

A team's own credential can read its lake events (`GET /tenants/:tenantId/lake/events`), with a required `since` and a window of at most 31 days ending at `until` or now, whichever is earlier; contracts adds `teamLakeEventsInput` and `LAKE_TEAM_WINDOW_DAYS`.
