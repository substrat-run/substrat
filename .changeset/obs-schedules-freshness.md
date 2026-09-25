---
"@substrat-run/dashboard-web": minor
---

Observability's Schedules view now draws each schedule's runs as ticks at their real times on the page's time axis, with failed runs in red and a verdict in plain words: Healthy, Late, Never run, Sweeper silent, Fresh or Stale. A late schedule or a stale freshness rule is shaded from the moment it went wrong. An app's Overview gains a Schedules and freshness card that shows each schedule's recent runs as a strip and each freshness rule as a sentence, for example "No receipt.landed for 26h and counting". The card links to the full view.
