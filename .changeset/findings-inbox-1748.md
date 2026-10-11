---
'@substrat-run/dashboard': patch
---

The Findings inbox (part of #1748): Observability gains a fourth child, Findings. Open, Acked, Resolved and Suppressed tabs list the team's findings with severity, kind, a Regressed badge, occurrences and the likely cause when one is known. Acknowledge, resolve and reopen move a finding between tabs, and Suppress turns its scope (operation, error code, subject) into a rule with an expiry and a reason; the Suppressed tab lists the active rules and revokes them. People who may read findings but not change them see the list without the actions, and a refusal from the server is shown on the row instead of failing silently.
