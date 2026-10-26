---
"@substrat-run/kernel": minor
---

A connector sweep's row no longer carries the provider's text. When a sweep fails, its row (the one a tenant reads in Health › Connections and `GET /sweep-runs`) now says what happened in the platform's own words, with counts and one platform reference: `1 of 3 bindings did not land`, `1 declared landing could not be granted or bound`, or `the sweep did not complete`. The failure's own text (the provider's answer, a landing refusal, the throw) goes on a staff-only ops-failure row with no tenant, filed under the same reference through the new `recordFailure` option of `runPlatformSweep`. A pass with no `recordFailure` keeps that text in the report's `errors`, as before.
