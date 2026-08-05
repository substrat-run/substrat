---
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Dashboard: traffic lives on the app's Observability tab only, now with a version filter.

The Verticals page carried a fleet-wide Traffic panel that duplicated the per-app
Observability tab — the same `observabilityMetrics` rows at a different zoom level. It's
removed, so Verticals is purely the software you build: versions, channels, and
publishing.

Observability keeps traffic, reworked around a single filter bar above the list:

- One `[Version ▾] [Range ▾] [Refresh]` bar. **Version** defaults to *All versions* (every
  serving version of this app's vertical) and narrows the list — and, for a specific
  version, opens that version's logs below. Clicking a row is a shortcut for the same
  filter (click again to clear).
- The version dropdown that used to be buried in the logs-panel header is gone; the panel
  now shows the active version as a tag and keeps only the log-specific level and
  message-search filters.
