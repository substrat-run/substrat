---
'@substrat-run/dashboard': minor
---

Freshness health is on the app page (#1232, completing the view #1272's record
feeds). The Schedules panel gains a Freshness section: each declared expectation
with its verdict pill (Fresh / Stale / Never seen / No sweep data), the sentence
this feature exists to produce — "No receipt.landed 26h and counting — expected
within 24h." — and a deliberately sparse strip where each tick is a verdict
change or an hourly heartbeat, never noise. Duplicate declarations render as the
one aggregate the evaluator actually judges. The scope-liveness probe now spans
every sweep kind: a freshness-only app used to read permanently sweeper-silent
because the probe only looked for schedule rows, and any row of any kind proves
the sweep reached the scope.
