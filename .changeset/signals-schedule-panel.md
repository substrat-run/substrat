---
'@substrat-run/dashboard': minor
---

Schedule health is on the app page (#1232). The Observability tab opens with a
Schedules panel: every schedule the running version declares, with its verdict
pill (on schedule / overdue / never run / no sweep data), last run with a
failure's error verbatim, next due, and the recent-runs strip. Rendered above
the telemetry guards deliberately — schedule health is the tenant's own fact,
so it shows even for an app running another team's vertical and even where
Workers Logs is absent. A sweeper-silent app says so in one line and stops
blaming schedules; an app whose version declares no schedules (or predates the
manifest field) shows no panel at all. The recent-runs strip is now a shared
component with its amber sentence parameterized: on a connection a skip means
"nothing polls this", on a schedule it means "not due yet", and one hardcoded
sentence was wrong somewhere.
