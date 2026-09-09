---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/dashboard': minor
---

Release health gets its time axis (#1236, completing the issue). The
observability seam gains an optional `serviceMetricsSeries` — the same
invocations bucketed over time, with the backend choosing a bucket width from
the window and reporting it on every row — and the Cloudflare reader
implements it. Absent, the route 501s rather than answering an empty series,
because a chart would draw that as silence.

On the dashboard, a vertical's Releases panel now opens with 24 hours of
traffic with every push and go-live drawn on it, as a hand-rolled SVG (the
shape is bars plus rules; a charting dependency would be more bytes than the
drawing). The series is zero-filled worker-side so an outage stays a gap
rather than letting its neighbours join, and markers come from the registry
rather than telemetry, so a push that produced no traffic still gets its line
— the most interesting push on the chart. Every promotion draws its own line,
so a version that was rolled back and put live again shows both go-lives, not
just the later one. Where the chart cannot be drawn it says so: a plane that
serves window totals but no time axis, or a window whose traffic exceeds what
the analytics backend will answer in one page, gets "not available" instead of
a flat line — a partial answer would render as an outage that never happened.

And an app's schema history is finally readable: `_substrat_migrations.applied_at`
has been written since the table shipped and selected by nobody, since every
reader wanted only the frontier. `scopeAppliedMigrations` (both adapters, plus
the vertical's own `/internal/migrations` for a scope whose data it holds)
makes "when did my schema change" answerable, and the app's Observability tab
lists it. Deliberately a list and not chart markers: a migration applies to one
scope while traffic is measured per script, and a script serves many scopes.
