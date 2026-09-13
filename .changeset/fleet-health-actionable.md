---
'@substrat-run/dashboard': patch
---

The "Needs attention" panel on the Apps page only lists what someone can act on.

Two of its states failed that test. An app absent from a truncated sweep read —
the broad read that every pass of every unit lands in, which one 5-minute
schedule alone fills past its cap in a day — read `unknown`, with a sentence
about the read rather than the app, and clicking it opened an overview with no
trace of why. And an app that declares no schedules or freshness expectations
read `silent` for ever: the sweeper is right to never write a row for it, so
there was nothing to do and no way off the list.

Now a truncated read is repaired one app at a time — a read narrowed to the one
scope reaches the end of its window with a single row, bounded by the apps the
broad read missed and taken only when the cap was actually hit — so `unknown`
survives only a read that failed, and that renders as a footnote about the
panel's coverage, never as a verdict on an app. An app whose running version
declares nothing to sweep reads `ok` with that reason, and `silent` keeps its
meaning for the case it was written for: something declared, and no sweep
reaching it. The declaration is resolved per distinct vertical and version, not
per app, so thirty clients on one vertical cost three reads. A row now opens the
app's Observability tab, where the sweep record it was read from lives.
