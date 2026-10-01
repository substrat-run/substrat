---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
---

Record each newly applied scope migration's duration and number of SQLite data rows changed. Both adapters preserve null metrics for migrations that ran before recording began, and the control plane carries the new values to the dashboard's schema history.
