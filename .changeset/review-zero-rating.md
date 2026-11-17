---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
'@substrat-run/console': patch
---

Code reviews are shown priced at zero beside what they would cost. The model-usage summary takes the scopes whose lines are zero-rated, and each row and the totals carry `zeroRatedCalls` and `zeroRatedUsd`, left out of `billedUsd`. A team's usage gains a `reviews` block (tokens, would-be cost, charged), which the dashboard's Billing page shows as "free in preview". The console's model-usage table shows the zero-rated amount.
