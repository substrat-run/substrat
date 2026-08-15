---
"@substrat-run/builder-web": patch
"@substrat-run/builder-generator": minor
---

Builder provider retry (harness RFC row 2): transient provider failures mid-turn (429, 5xx incl. 529 overloaded, network resets, timeouts) are retried with jittered exponential backoff (2s base → 30s cap, 5 attempts) honouring `retry-after`/`retry-after-ms` capped at 60s, resuming from the captured step transcript so a 30-step build and its cache investment survive one bad request. Context overflow is classified separately and never retried (the same request would overflow again — the future condensation path); client errors surface immediately through the provider-specific explainError. A new `retry` BuildEvent renders the wait as patience, not a hang.
