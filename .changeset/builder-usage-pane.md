---
'@substrat-run/builder': patch
'@substrat-run/builder-web': patch
---

The Usage tab (#646): the studio visualizes its own token spend. A worker
route (`GET /api/usage`) rolls the metering scope's ledger up host-side
(totals, per-UTC-day, per-project), and the SPA renders it as stat tiles, a
stacked daily bar chart (input + output tokens, last 30 days, per-theme
palettes validated for CVD/contrast), and a per-project table doubling as the
chart's accessible view. Local mode serves an honest empty report — the Node
server runs no metering scope, so the pane shows its empty state rather than
a fake number.
