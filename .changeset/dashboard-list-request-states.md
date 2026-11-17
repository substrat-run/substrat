---
'@substrat-run/dashboard': patch
---

The dashboard's lists no longer show their empty state before the first answer arrives. Verticals, Team, the Create-app catalog, the Observability app picker, the Pulse apps table and Domains each show a skeleton shaped like their rows while loading, show the empty state only once the read has answered with nothing, and show a failed read as an error with a Try again button, never as an empty list. Each team list now loads on its own, so one slow read no longer holds the others back.
