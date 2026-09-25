---
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
---

The Apps page now opens on a health table. It lists every app, worst first, with its health verdict, the reason behind it, and its requests, error rate and p95 over the last 24 hours. Chips above the table filter by verdict and show how many apps have each one. Apps that are still installing, or whose install failed, show that state instead of a health verdict, and a failed install can be retried from its row. The card grid is still available from the view toggle. Observability → Pulse → Health shows the same table.

The control plane's tenant metrics read accepts `grain=scope`, which returns one row per app. A p95 cannot be combined from per-surface p95s, so the per-app figure is grouped where it is read.

The table loads every app before ordering them, not just the first page. When a team has more apps with traffic than the read covers (the busiest 200), an app past that shows "—" with the reason, never 0. `TENANT_METRICS_LIMIT` exports that cap. `grain=scope` groups by the app alone, so an app moved to another vertical during the window still gets one p95.
