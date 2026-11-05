---
"@substrat-run/builder": minor
"@substrat-run/control-plane-api": minor
---

A builder turn now counts against the team it ran for: each turn files one line in the platform's model usage ledger, so it shows on the team's usage page and the console's meters. `POST /model-usage` is the staff-only door, idempotent on the caller's `requestId`.
