---
'@substrat-run/dashboard': minor
---

The schedule-health view model (#1232). `GET /api/apps/:scopeId/schedules`
joins the RUNNING version's declared schedules against the sweep record and
answers a render-ready verdict per schedule — last firing, next due, and one of
`healthy / overdue / never-run / sweeper-silent`. The derivation is a pure,
table-tested function: the grace is ADDITIVE (cadence + one 15-minute sweep
window, derived from the same numbers the scheduler uses — a 2× multiplier
would tell a daily schedule's owner a full day late and false-alarm a
five-minute one), and a scope no sweep has reached in two windows reads
`sweeper-silent` on every row rather than blaming schedules for a stopped loop.
The strip reads filter to ok+failed (a CP-less pass writes a `skipped` row per
schedule every couple of minutes — an unfiltered walk cannot reach last week's
real run), while one unfiltered read answers what the skips exist for: whether
the sweep still reaches the scope at all. The panel itself mounts next; a
version predating the manifest field answers null and the UI will hide rather
than nag.
