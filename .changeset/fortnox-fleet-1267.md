---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

An app can hold many Fortnox companies, and the dashboard now shows all of them (#1267 follow-up). A bookkeeping bureau connects one company per client to the same app, and each consent adds a connection instead of rotating the last one.

- **Settings → Integrations** lists every connected company for a provider that keys connections on the account, each with its own status, health line, Details and Disconnect. **Connect another company** opens the consent dialog again. Its copy says that each link connects one company, so the bureau mints a link per client.
- **Disconnect** names the company and revokes only that company's connection. The un-addressed route still refuses when several companies are connected.
- **The account Integrations page** has **Connect another** for such a provider, and its app picker no longer says a new company rotates the existing connection.
- **Routes:** `GET /api/apps/:scopeId/integrations` returns `connections` (every live row, newest first) and `multiAccount` beside the unchanged `connection`. `DELETE …/integrations/:provider/connections/:connectionId`, `POST …/connections/:connectionId/verify` and `GET …/connections/:connectionId/activity` address one connection. The id must be one of this app's live connections for that provider, or the route answers 404.
